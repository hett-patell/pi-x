/**
 * TUI X Feed Sidebar — persistent side-panel showing your X home feed.
 *
 * /x feed          → toggle sidebar on/off
 * /x feed refresh  → force refresh now
 *
 * Controls (when focused):
 *   ↑↓    scroll through tweets
 *   Enter open tweet URL (copy to clipboard)
 *   r     refresh feed
 *   Esc   close sidebar
 *   Tab   cycle focus back to editor
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	allocateImageId,
	getCapabilities,
	getPngDimensions,
	hyperlink,
	type ImageDimensions,
	matchesKey,
	renderImage,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Tweet } from "../normalize.ts";

// ─── Types ───────────────────────────────────────────────────────────

/** Minimal TUI handle. */
export interface FeedTUI {
	requestRender(): void;
}

/** Callbacks to load feed data. */
export interface FeedActions {
	loadFeed(): Promise<{ tweets: Tweet[]; accountLabel: string }>;
}

export interface FeedSidebarOptions {
	/** Auto-refresh interval in ms (default: 5 minutes). 0 = no auto-refresh. */
	refreshIntervalMs?: number;
	/** Fetch a media thumbnail as base64 PNG. Defaults to fetching from pbs.twimg.com. */
	loadImage?: (url: string) => Promise<string | null>;
	/** Terminal height in rows (defaults to process.stdout.rows). */
	rows?: () => number;
	/** Max image height in terminal rows (default 8). */
	imageRows?: number;
}

interface CachedImage {
	state: "loading" | "ready" | "failed";
	data?: string;
	dims?: ImageDimensions;
	id: number;
	/** Last encoded placement, reused so the terminal gets placement-only redraws. */
	rendered?: { key: string; sequence: string; rows: number };
}

/** X media URL → small PNG thumbnail URL (Kitty only accepts PNG). */
export function thumbUrl(url: string): string {
	const u = url.split("?")[0]!.replace(/\.(jpe?g|png|webp|gif)$/i, "");
	return `${u}?format=png&name=240x240`;
}

async function defaultLoadImage(url: string): Promise<string | null> {
	const res = await fetch(thumbUrl(url), { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) return null;
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > 2_000_000) return null;
	return buf.toString("base64");
}

const MAX_CACHED_IMAGES = 80;

// ─── Helpers ─────────────────────────────────────────────────────────

function relTime(iso: string | null): string {
	if (!iso) return "";
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 0) return "now";
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	const days = Math.floor(hrs / 24);
	return `${days}d`;
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

// ─── Component ───────────────────────────────────────────────────────

export class FeedSidebarComponent {
	focused = false;

	private theme: Theme;
	private tui: FeedTUI;
	private done: (result: undefined) => void;
	private actions: FeedActions;

	// Feed state
	private tweets: Tweet[] = [];
	private accountLabel = "";
	private selectedIndex = 0;
	private scrollOffset = 0; // first visible tweet index
	private loading = true;
	private error: string | null = null;
	private lastRefresh: Date | null = null;

	// Auto-refresh
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private refreshIntervalMs: number;

	// Render cache
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	// Media
	private images = new Map<string, CachedImage>();
	private showMedia = true;
	private loadImage: (url: string) => Promise<string | null>;
	private rows: () => number;
	private imageRows: number;
	private disposed = false;

	constructor(
		tui: FeedTUI,
		theme: Theme,
		done: (result: undefined) => void,
		actions: FeedActions,
		options?: FeedSidebarOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.refreshIntervalMs = options?.refreshIntervalMs ?? 5 * 60_000;
		this.loadImage = options?.loadImage ?? defaultLoadImage;
		this.rows = options?.rows ?? (() => process.stdout.rows || 40);
		this.imageRows = options?.imageRows ?? 8;
		void this.refresh();
		this.startAutoRefresh();
	}

	// ─── Data loading ────────────────────────────────────────────────

	private async refresh(): Promise<void> {
		this.loading = true;
		this.error = null;
		this.invalidate();
		this.tui.requestRender();
		try {
			const r = await this.actions.loadFeed();
			this.tweets = r.tweets;
			this.accountLabel = r.accountLabel;
			this.lastRefresh = new Date();
			this.loading = false;
			// Keep selection in bounds
			if (this.selectedIndex >= this.tweets.length) {
				this.selectedIndex = Math.max(0, this.tweets.length - 1);
			}
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
			this.loading = false;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private startAutoRefresh(): void {
		if (this.refreshIntervalMs <= 0) return;
		this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	// ─── Input handling ──────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.dispose();
			this.done(undefined);
			return;
		}

		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureVisible();
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.tweets.length - 1, this.selectedIndex + 1);
			this.ensureVisible();
		} else if (matchesKey(data, "ctrl+u")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 5);
			this.ensureVisible();
		} else if (matchesKey(data, "ctrl+d")) {
			this.selectedIndex = Math.min(this.tweets.length - 1, this.selectedIndex + 5);
			this.ensureVisible();
		} else if (data === "m" || data === "M") {
			this.showMedia = !this.showMedia;
		} else if (data === "r" || data === "R") {
			void this.refresh();
			return;
		} else {
			return;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private ensureVisible(): void {
		// Each tweet card takes ~4 lines; we'll adjust in render based on actual height
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		}
		// Upper bound adjusted during render
	}

	// ─── Rendering ───────────────────────────────────────────────────

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;

		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const pad = (s: string) => truncateToWidth(s, innerW, "…", true);
		const border = (c: string) => th.fg("border", c);
		const lines: string[] = [];

		// ── Header ──
		const refreshInfo = this.lastRefresh
			? th.fg("dim", ` · ${relTime(this.lastRefresh.toISOString())} ago`)
			: "";
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(
			border("│") +
				pad(` ${th.fg("accent", "𝕏 Feed")} ${th.fg("dim", `@${this.accountLabel}`)}${refreshInfo} `) +
				border("│"),
		);
		lines.push(border(`├${"─".repeat(innerW)}┤`));

		// ── Loading / Error state ──
		if (this.loading && this.tweets.length === 0) {
			lines.push(border("│") + pad(th.fg("dim", " ⏳ Loading feed…")) + border("│"));
			lines.push(border(`╰${"─".repeat(innerW)}╯`));
			this.cachedLines = lines;
			return lines;
		}
		if (this.error && this.tweets.length === 0) {
			lines.push(border("│") + pad(th.fg("error", ` ✗ ${this.error}`)) + border("│"));
			lines.push(border("│") + pad(th.fg("dim", " Press r to retry")) + border("│"));
			lines.push(border(`╰${"─".repeat(innerW)}╯`));
			this.cachedLines = lines;
			return lines;
		}

		if (this.tweets.length === 0) {
			lines.push(border("│") + pad(th.fg("dim", " No posts in feed")) + border("│"));
			lines.push(border(`╰${"─".repeat(innerW)}╯`));
			this.cachedLines = lines;
			return lines;
		}

		// ── Tweet cards ──
		// Each card is 3-4 lines. Figure out how many fit.
		// Reserve 2 lines for footer + bottom border
		// Overlay maxHeight is 90% of the terminal; leave room for header/footer/borders.
		const maxBodyLines = Math.max(8, Math.floor(this.rows() * 0.9) - 7);
		const cardLines: string[][] = [];

		for (let i = 0; i < this.tweets.length; i++) {
			const t = this.tweets[i]!;
			const isSelected = i === this.selectedIndex;
			const card = this.renderTweetCard(t, isSelected, innerW);
			cardLines.push(card);
		}

		// Adjust scrollOffset so selectedIndex is visible
		let usedLines = 0;
		let firstVisible = this.scrollOffset;

		// Count lines from scrollOffset to selectedIndex
		let linesBeforeSelected = 0;
		for (let i = firstVisible; i < this.selectedIndex; i++) {
			linesBeforeSelected += (cardLines[i]?.length ?? 0) + 1; // +1 for separator
		}
		if (linesBeforeSelected + (cardLines[this.selectedIndex]?.length ?? 0) > maxBodyLines) {
			// Selected card doesn't fit, scroll down
			firstVisible = this.selectedIndex;
		}
		if (this.selectedIndex < firstVisible) {
			firstVisible = this.selectedIndex;
		}
		this.scrollOffset = firstVisible;

		// Render visible cards
		for (let i = firstVisible; i < cardLines.length && usedLines < maxBodyLines; i++) {
			const card = cardLines[i]!;
			if (usedLines + card.length > maxBodyLines) break;
			if (i > firstVisible) {
				// Thin separator between cards
				lines.push(border("│") + pad(th.fg("dim", " " + "·".repeat(Math.min(innerW - 2, 20)))) + border("│"));
				usedLines++;
			}
			for (const cl of card) {
				lines.push(border("│") + pad(cl) + border("│"));
				usedLines++;
			}
		}

		// ── Footer ──
		if (this.loading) {
			lines.push(border("│") + pad(th.fg("dim", " ⏳ Refreshing…")) + border("│"));
		}
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(
			border("│") +
				pad(
					th.fg("dim", ` ${this.selectedIndex + 1}/${this.tweets.length} · ↑↓ · m media · r refresh · Esc`),
				) +
				border("│"),
		);
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		this.cachedLines = lines;
		return lines;
	}

	private renderTweetCard(t: Tweet, isSelected: boolean, innerW: number): string[] {
		const th = this.theme;
		const contentW = innerW - 2; // 1 char indent on each side
		const lines: string[] = [];

		// Line 1: indicator + author + time
		const indicator = isSelected ? th.fg("accent", "▸ ") : "  ";
		const author = isSelected
			? th.fg("accent", `@${t.author.handle}`)
			: `@${t.author.handle}`;
		const verified = t.author.verified ? th.fg("success", " ✓") : "";
		const time = th.fg("dim", ` · ${relTime(t.created_at)}`);
		const retweetTag = t.retweeted_by ? th.fg("dim", ` ⟲ @${t.retweeted_by}`) : "";
		lines.push(` ${indicator}${author}${verified}${time}${retweetTag}`);

		// Line 2: tweet text (truncated to 2 lines)
		const cleanText = t.text.replace(/\n+/g, " ").trim();
		if (cleanText) {
			const maxTextLen = contentW * 2; // allow ~2 visual lines
			const truncated = cleanText.length > maxTextLen
				? cleanText.slice(0, maxTextLen - 1) + "…"
				: cleanText;
			// Split into at most 2 lines
			const firstLine = truncated.slice(0, contentW);
			const secondLine = truncated.length > contentW ? truncated.slice(contentW, contentW * 2) : "";
			lines.push(`    ${isSelected ? th.fg("accent", firstLine) : firstLine}`);
			if (secondLine) {
				lines.push(`    ${isSelected ? th.fg("accent", secondLine) : secondLine}`);
			}
		}

		// Line 3: metrics
		const m = t.metrics;
		const metrics = [
			`♥ ${compact(m.likes)}`,
			`⟲ ${compact(m.retweets)}`,
			`↩ ${compact(m.replies)}`,
			...(m.views != null ? [`${compact(m.views)} views`] : []),
		].join("  ");
		lines.push(`    ${th.fg("dim", metrics)}`);

		// Media
		const media = t.media.length ? t.media : (t.quoted?.media ?? []);
		if (media.length) lines.push(...this.renderMedia(media, contentW));

		// Quoted tweet (compact)
		if (t.quoted) {
			const qText = t.quoted.text.replace(/\n+/g, " ").trim();
			const qTrunc = qText.length > contentW - 10 ? qText.slice(0, contentW - 13) + "…" : qText;
			lines.push(`    ${th.fg("dim", `↪ @${t.quoted.author.handle}: ${qTrunc}`)}`);
		}

		return lines;
	}

	// ─── Media ───────────────────────────────────────────────────────

	private renderMedia(media: string[], contentW: number): string[] {
		const th = this.theme;
		const url = media[0]!;
		const more = media.length > 1 ? ` +${media.length - 1}` : "";
		const label = th.fg("dim", `    🖼 ${hyperlink(media.length > 1 ? `${media.length} media` : "media", url)}`);
		if (!this.showMedia || !getCapabilities().images) return [label];

		const img = this.image(url);
		if (img.state === "loading") return [th.fg("dim", `    🖼 loading…${more}`)];
		if (img.state === "failed" || !img.data || !img.dims) return [label];

		const maxW = Math.max(4, contentW - 4);
		const key = `${maxW}x${this.imageRows}`;
		if (img.rendered?.key !== key) {
			const r = renderImage(img.data, img.dims, { maxWidthCells: maxW, maxHeightCells: this.imageRows, imageId: img.id, moveCursor: false });
			img.rendered = r ? { key, sequence: r.sequence, rows: r.rows } : undefined;
		}
		const r = img.rendered;
		if (!r) return [label];
		// Image escape anchored after the indent; following rows stay blank so the picture covers them.
		const out = [`    ${r.sequence}`];
		for (let i = 1; i < r.rows; i++) out.push("");
		if (more) out.push(th.fg("dim", `    ${more} more`));
		return out;
	}

	private image(url: string): CachedImage {
		let img = this.images.get(url);
		if (img) return img;
		img = { state: "loading", id: allocateImageId() };
		this.images.set(url, img);
		if (this.images.size > MAX_CACHED_IMAGES) {
			const oldest = this.images.keys().next().value;
			if (oldest !== undefined && oldest !== url) this.images.delete(oldest);
		}
		const entry = img;
		this.loadImage(url)
			.then((data) => {
				const dims = data ? getPngDimensions(data) : null;
				if (data && dims) Object.assign(entry, { state: "ready", data, dims });
				else entry.state = "failed";
			})
			.catch(() => {
				entry.state = "failed";
			})
			.finally(() => {
				if (this.disposed) return;
				this.invalidate();
				this.tui.requestRender();
			});
		return img;
	}
}
