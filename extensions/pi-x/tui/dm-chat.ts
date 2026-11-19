/**
 * TUI DM Chat — interactive overlay for reading and sending direct messages.
 *
 * /x dm        → inbox list (conversations with unread markers)
 * /x dm <user> → open thread with that user directly
 *
 * Inbox view: ↑↓ navigate, Enter open thread, Esc/q close
 * Thread view: type to compose, Enter send, Esc back to inbox, ↑↓ scroll history
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DmConversation, DmMessage } from "../normalize.ts";

// ─── Types ───────────────────────────────────────────────────────────

/** Minimal TUI handle — only requestRender() is needed by this component. */
export interface DmTUI {
	requestRender(): void;
}

/** Minimal interface so the overlay can call back to load data / send DMs. */
export interface DmChatActions {
	loadInbox(): Promise<{ conversations: DmConversation[]; selfId: string; accountLabel: string }>;
	loadThread(handle: string): Promise<{ messages: DmMessage[]; selfId: string; otherHandle: string }>;
	sendMessage(handle: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

// ─── Component ───────────────────────────────────────────────────────

type View = "inbox" | "thread";

export class DmChatComponent {
	readonly width = 80;
	focused = false;

	private view: View = "inbox";
	private theme: Theme;
	private tui: DmTUI;
	private done: (result: undefined) => void;
	private actions: DmChatActions;

	// Inbox state
	private conversations: DmConversation[] = [];
	private selfId = "";
	private accountLabel = "";
	private inboxIndex = 0;
	private inboxLoading = true;
	private inboxError: string | null = null;

	// Thread state
	private threadHandle = "";
	private messages: DmMessage[] = [];
	private threadSelfId = "";
	private threadLoading = false;
	private threadError: string | null = null;
	private threadScroll = 0; // scroll offset from bottom (0 = latest)

	// Compose state
	private composeText = "";
	private composeCursor = 0;
	private sending = false;
	private sendError: string | null = null;

	// Initial user to open directly
	private initialUser: string | null;

	constructor(
		tui: DmTUI,
		theme: Theme,
		done: (result: undefined) => void,
		actions: DmChatActions,
		initialUser?: string,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.initialUser = initialUser ?? null;
		void this.loadInbox();
	}

	// ─── Data loading ────────────────────────────────────────────────

	private async loadInbox(): Promise<void> {
		this.inboxLoading = true;
		this.inboxError = null;
		this.tui.requestRender();
		try {
			const r = await this.actions.loadInbox();
			this.conversations = r.conversations;
			this.selfId = r.selfId;
			this.accountLabel = r.accountLabel;
			this.inboxIndex = 0;
			this.inboxLoading = false;
			// If initial user was given, jump straight to their thread
			if (this.initialUser) {
				const user = this.initialUser;
				this.initialUser = null;
				void this.openThread(user);
				return;
			}
		} catch (e) {
			this.inboxError = e instanceof Error ? e.message : String(e);
			this.inboxLoading = false;
		}
		this.tui.requestRender();
	}

	private async openThread(handle: string): Promise<void> {
		this.view = "thread";
		this.threadHandle = handle;
		this.threadLoading = true;
		this.threadError = null;
		this.messages = [];
		this.threadScroll = 0;
		this.composeText = "";
		this.composeCursor = 0;
		this.sendError = null;
		this.tui.requestRender();
		try {
			const r = await this.actions.loadThread(handle);
			this.messages = r.messages;
			this.threadSelfId = r.selfId;
			this.threadHandle = r.otherHandle;
			this.threadLoading = false;
		} catch (e) {
			this.threadError = e instanceof Error ? e.message : String(e);
			this.threadLoading = false;
		}
		this.tui.requestRender();
	}

	private async send(): Promise<void> {
		const text = this.composeText.trim();
		if (!text || this.sending) return;
		this.sending = true;
		this.sendError = null;
		this.tui.requestRender();
		try {
			const r = await this.actions.sendMessage(this.threadHandle, text);
			if (!r.ok) {
				this.sendError = r.error ?? "Send failed";
			} else {
				this.composeText = "";
				this.composeCursor = 0;
				this.threadScroll = 0;
				// Reload thread to show new message
				await this.openThread(this.threadHandle);
				return;
			}
		} catch (e) {
			this.sendError = e instanceof Error ? e.message : String(e);
		}
		this.sending = false;
		this.tui.requestRender();
	}

	// ─── Input handling ──────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.view === "inbox") {
			this.handleInboxInput(data);
		} else {
			this.handleThreadInput(data);
		}
	}

	private handleInboxInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up")) {
			this.inboxIndex = Math.max(0, this.inboxIndex - 1);
		} else if (matchesKey(data, "down")) {
			this.inboxIndex = Math.min(this.conversations.length - 1, this.inboxIndex + 1);
		} else if (matchesKey(data, "return")) {
			const c = this.conversations[this.inboxIndex];
			if (c) void this.openThread(c.handle);
			return;
		} else if (data === "r" || data === "R") {
			void this.loadInbox();
			return;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private handleThreadInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.view = "inbox";
			this.tui.requestRender();
			return;
		}

		// Scroll through messages with Ctrl+U/D
		if (matchesKey(data, "ctrl+u")) {
			this.threadScroll = Math.min(this.threadScroll + 5, Math.max(0, this.messages.length - 1));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			this.threadScroll = Math.max(0, this.threadScroll - 5);
			this.tui.requestRender();
			return;
		}

		// Up/down scroll one message
		if (matchesKey(data, "up")) {
			this.threadScroll = Math.min(this.threadScroll + 1, Math.max(0, this.messages.length - 1));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.threadScroll = Math.max(0, this.threadScroll - 1);
			this.tui.requestRender();
			return;
		}

		// Enter sends the message
		if (matchesKey(data, "return")) {
			if (this.composeText.trim()) {
				void this.send();
			}
			return;
		}

		// Text editing for compose
		if (matchesKey(data, "backspace")) {
			if (this.composeCursor > 0) {
				this.composeText = this.composeText.slice(0, this.composeCursor - 1) + this.composeText.slice(this.composeCursor);
				this.composeCursor--;
			}
		} else if (matchesKey(data, "delete")) {
			if (this.composeCursor < this.composeText.length) {
				this.composeText = this.composeText.slice(0, this.composeCursor) + this.composeText.slice(this.composeCursor + 1);
			}
		} else if (matchesKey(data, "left")) {
			this.composeCursor = Math.max(0, this.composeCursor - 1);
		} else if (matchesKey(data, "right")) {
			this.composeCursor = Math.min(this.composeText.length, this.composeCursor + 1);
		} else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			this.composeCursor = 0;
		} else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			this.composeCursor = this.composeText.length;
		} else if (matchesKey(data, "ctrl+k")) {
			this.composeText = this.composeText.slice(0, this.composeCursor);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.composeText = this.composeText.slice(0, this.composeCursor) + data + this.composeText.slice(this.composeCursor);
			this.composeCursor++;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	// ─── Rendering ───────────────────────────────────────────────────

	render(width: number): string[] {
		return this.view === "inbox" ? this.renderInbox(width) : this.renderThread(width);
	}

	private renderInbox(width: number): string[] {
		const w = Math.min(width, this.width);
		const inner = w - 2;
		const th = this.theme;
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) => th.fg("border", "│") + pad(content, inner) + th.fg("border", "│");
		const hline = (l: string, m: string, r: string) => th.fg("border", `${l}${m.repeat(inner)}${r}`);

		// Header
		lines.push(hline("╭", "─", "╮"));
		const title = this.accountLabel ? `✉ DM — @${this.accountLabel}` : "✉ Direct Messages";
		lines.push(row(` ${th.fg("accent", th.bold(title))}`));
		lines.push(row(th.fg("border", ` ${"─".repeat(Math.max(0, inner - 2))}`)));

		if (this.inboxLoading) {
			lines.push(row(` ${th.fg("dim", "Loading inbox…")}`));
		} else if (this.inboxError) {
			lines.push(row(` ${th.fg("error", `✗ ${this.inboxError}`)}`));
		} else if (!this.conversations.length) {
			lines.push(row(` ${th.fg("dim", "No DM conversations found")}`));
		} else {
			const unread = this.conversations.filter(c => c.unread).length;
			lines.push(row(` ${th.fg("dim", `${this.conversations.length} conversations · ${unread} unread`)}`));
			lines.push(row(""));

			// Show visible window of conversations
			const maxVisible = 15;
			const start = Math.max(0, this.inboxIndex - Math.floor(maxVisible / 2));
			const end = Math.min(this.conversations.length, start + maxVisible);

			for (let i = start; i < end; i++) {
				const c = this.conversations[i];
				const selected = i === this.inboxIndex;
				const prefix = selected ? " ▶ " : "   ";
				const unreadDot = c.unread ? "●" : "○";
				const handle = `@${c.handle}`;
				const unreadLabel = c.unread ? " — unread" : "";

				const handleStr = selected ? th.fg("accent", handle) : handle;
				lines.push(row(`${prefix}${c.unread ? th.fg("warning", unreadDot) : th.fg("dim", unreadDot)} ${handleStr}${th.fg("dim", unreadLabel)}`));

				if (c.last_text) {
					const who = c.last_sender === "you" ? "you" : `@${c.last_sender ?? c.handle}`;
					const snippet = c.last_text.length > 50 ? `${c.last_text.slice(0, 50)}…` : c.last_text;
					const time = c.last_at ? ` · ${relTime(c.last_at)}` : "";
					lines.push(row(`      ${th.fg("dim", `${who}: "${snippet}"${time}`)}`));
				}
			}

			if (this.conversations.length > maxVisible) {
				lines.push(row(""));
				lines.push(row(` ${th.fg("dim", `${start > 0 ? "↑ " : ""}${end < this.conversations.length ? "↓ " : ""}scroll for more`)}`));
			}
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "↑↓ navigate · Enter open · r refresh · Esc close")}`));
		lines.push(hline("╰", "─", "╯"));

		return lines.map(l => truncateToWidth(l, width));
	}

	private renderThread(width: number): string[] {
		const w = Math.min(width, this.width);
		const inner = w - 2;
		const th = this.theme;
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) => th.fg("border", "│") + pad(content, inner) + th.fg("border", "│");
		const hline = (l: string, m: string, r: string) => th.fg("border", `${l}${m.repeat(inner)}${r}`);

		// Header
		lines.push(hline("╭", "─", "╮"));
		lines.push(row(` ${th.fg("accent", th.bold(`💬 @${this.threadHandle}`))}`));
		lines.push(row(th.fg("border", ` ${"─".repeat(Math.max(0, inner - 2))}`)));

		if (this.threadLoading) {
			lines.push(row(` ${th.fg("dim", "Loading messages…")}`));
			for (let i = 0; i < 5; i++) lines.push(row(""));
		} else if (this.threadError) {
			lines.push(row(` ${th.fg("error", `✗ ${this.threadError}`)}`));
			for (let i = 0; i < 5; i++) lines.push(row(""));
		} else {
			// Show messages (scrollable window)
			const maxVisible = 12;
			const total = this.messages.length;
			const endIdx = total - this.threadScroll;
			const startIdx = Math.max(0, endIdx - maxVisible);
			const visible = this.messages.slice(startIdx, endIdx);

			if (this.threadScroll > 0 && endIdx < total) {
				lines.push(row(` ${th.fg("dim", `  ↑ ${total - endIdx} older messages`)}`));
			}

			if (!total) {
				lines.push(row(` ${th.fg("dim", "(no messages yet — say hi!)")}`));
			}

			for (const m of visible) {
				const isYou = m.sender_id === this.threadSelfId;
				const time = m.created_at ? m.created_at.slice(11, 16) : "?";
				const who = isYou ? th.fg("accent", "you") : th.fg("success", `@${m.sender_handle}`);
				const timeStr = th.fg("dim", `[${time}]`);

				// Wrap long messages
				const maxMsgWidth = inner - 20;
				const msgText = m.text;
				if (visibleWidth(msgText) > maxMsgWidth && maxMsgWidth > 10) {
					// Simple word wrap
					const words = msgText.split(" ");
					let line = "";
					let first = true;
					for (const word of words) {
						if (line.length + word.length + 1 > maxMsgWidth && line) {
							if (first) {
								lines.push(row(` ${timeStr} ${who}: ${line}`));
								first = false;
							} else {
								lines.push(row(`              ${th.fg("dim", "…")} ${line}`));
							}
							line = word;
						} else {
							line = line ? `${line} ${word}` : word;
						}
					}
					if (line) {
						if (first) {
							lines.push(row(` ${timeStr} ${who}: ${line}`));
						} else {
							lines.push(row(`              ${th.fg("dim", "…")} ${line}`));
						}
					}
				} else {
					lines.push(row(` ${timeStr} ${who}: ${msgText}`));
				}

				for (const url of m.media_urls) {
					lines.push(row(`              ${th.fg("dim", `📎 ${url}`)}`));
				}
			}

			if (this.threadScroll > 0) {
				lines.push(row(` ${th.fg("dim", `  ↓ ${this.threadScroll} newer messages`)}`));
			}

			// Pad to consistent height
			const contentLines = lines.length - 3; // minus header lines
			for (let i = contentLines; i < maxVisible; i++) lines.push(row(""));
		}

		// Separator
		lines.push(row(th.fg("border", ` ${"─".repeat(Math.max(0, inner - 2))}`)));

		// Send error
		if (this.sendError) {
			lines.push(row(` ${th.fg("error", `✗ ${this.sendError}`)}`));
		}

		// Compose area
		const composePrefix = this.sending ? " ⏳ " : " ✎  ";
		let composeDisplay = this.composeText;
		if (this.focused && !this.sending) {
			const before = composeDisplay.slice(0, this.composeCursor);
			const cursorChar = this.composeCursor < composeDisplay.length ? composeDisplay[this.composeCursor]! : " ";
			const after = composeDisplay.slice(this.composeCursor + 1);
			composeDisplay = `${before}${CURSOR_MARKER}${renderFakeCursor(cursorChar)}${after}`;
		}
		if (!this.composeText && !this.sending && !this.focused) {
			composeDisplay = th.fg("dim", "Type a message…");
		} else if (!this.composeText && !this.sending && this.focused) {
			composeDisplay = `${CURSOR_MARKER}${renderFakeCursor(" ")}`;
		}
		lines.push(row(`${th.fg("accent", composePrefix)}${composeDisplay}`));

		// Footer
		lines.push(row(` ${th.fg("dim", "Enter send · ↑↓ scroll · Esc back")}`));
		lines.push(hline("╰", "─", "╯"));

		return lines.map(l => truncateToWidth(l, width));
	}

	invalidate(): void {
		// No-op — we re-render everything each time
	}

	dispose(): void {
		// No cleanup needed
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────

function relTime(iso: string | null): string {
	if (!iso) return "";
	const ms = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(ms)) return "";
	const m = Math.round(ms / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}
