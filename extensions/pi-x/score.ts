import type { Tweet } from "./normalize.ts";

export interface Agg {
	total: number;
	median: number;
}

export interface Stats {
	count: number;
	from: string | null;
	to: string | null;
	hours: number | null;
	per_hour: number | null;
	likes: Agg;
	retweets: Agg;
	replies: Agg;
	views: Agg | null;
	verified_share: number;
	duplicates: number;
	top_authors: { handle: string; posts: number; score: number }[];
	top_hashtags: { tag: string; count: number }[];
	top_domains: { domain: string; count: number }[];
	top: Tweet[];
	earliest_notable: Tweet | null;
}

export interface SearchFilters {
	from?: string;
	to?: string;
	mentions?: string;
	since?: string;
	until?: string;
	lang?: string;
	min_likes?: number;
	min_retweets?: number;
	min_replies?: number;
	has?: ("media" | "links" | "images" | "video")[];
	exclude?: ("replies" | "retweets")[];
	verified_only?: boolean;
	near?: string;
	within?: string;
}

/** twitter-cli's weighting, with quotes counted like retweets. */
export function engagementScore(t: Tweet): number {
	const m = t.metrics;
	return m.likes + 3 * (m.retweets + m.quotes) + 2 * m.replies + 5 * m.bookmarks + 0.5 * Math.log10(Math.max(1, m.views ?? 0));
}

export function scoreAll(ts: Tweet[]): Tweet[] {
	for (const t of ts) t.score = Math.round(engagementScore(t));
	return ts;
}

const time = (t: Tweet) => (t.created_at ? Date.parse(t.created_at) : 0);

export function sortTweets(ts: Tweet[], sort: "recent" | "engagement"): Tweet[] {
	return [...ts].sort(sort === "engagement" ? (a, b) => (b.score ?? 0) - (a.score ?? 0) || time(b) - time(a) : (a, b) => time(b) - time(a));
}

export function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const dupKey = (text: string) =>
	text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[@#]\w+/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Collapse copy-pasta: same normalized text (≥ 20 chars) keeps only the highest-scoring post. */
export function collapseDuplicates(ts: Tweet[]): { kept: Tweet[]; duplicates: number } {
	const best = new Map<string, Tweet>();
	const kept: Tweet[] = [];
	for (const t of ts) {
		const k = dupKey(t.text);
		if (k.length < 20) {
			kept.push(t);
			continue;
		}
		const prev = best.get(k);
		if (!prev || (t.score ?? 0) > (prev.score ?? 0)) best.set(k, t);
	}
	const winners = new Set(best.values());
	for (const t of ts) if (winners.has(t)) kept.push(t);
	return { kept: ts.filter((t) => kept.includes(t)), duplicates: ts.length - kept.length };
}

const agg = (xs: number[]): Agg => ({ total: xs.reduce((a, b) => a + b, 0), median: median(xs) });

function topCounts(items: string[], n: number): { key: string; count: number }[] {
	const m = new Map<string, number>();
	for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
	return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([key, count]) => ({ key, count }));
}

function domainOf(u: string): string | null {
	try {
		const h = new URL(u).hostname.replace(/^www\./, "");
		return /^(x\.com|twitter\.com|t\.co)$/.test(h) ? null : h;
	} catch {
		return null;
	}
}

export function computeStats(ts: Tweet[], duplicates = 0): Stats {
	const times = ts.map(time).filter((x) => x > 0).sort((a, b) => a - b);
	const from = times.length ? new Date(times[0]).toISOString() : null;
	const to = times.length ? new Date(times[times.length - 1]).toISOString() : null;
	const hours = times.length > 1 ? Math.round(((times[times.length - 1] - times[0]) / 3_600_000) * 10) / 10 : null;
	const views = ts.map((t) => t.metrics.views).filter((v): v is number => v != null);
	const authors = new Map<string, { posts: number; score: number }>();
	for (const t of ts) {
		const a = authors.get(t.author.handle) ?? { posts: 0, score: 0 };
		a.posts++;
		a.score += t.score ?? 0;
		authors.set(t.author.handle, a);
	}
	const scores = ts.map((t) => t.score ?? 0);
	const med = median(scores);
	const notable = ts.filter((t) => (t.score ?? 0) > 0 && (t.score ?? 0) >= med && time(t) > 0).sort((a, b) => time(a) - time(b));
	return {
		count: ts.length,
		from,
		to,
		hours,
		per_hour: hours ? Math.round((ts.length / hours) * 10) / 10 : null,
		likes: agg(ts.map((t) => t.metrics.likes)),
		retweets: agg(ts.map((t) => t.metrics.retweets)),
		replies: agg(ts.map((t) => t.metrics.replies)),
		views: views.length ? agg(views) : null,
		verified_share: ts.length ? Math.round((ts.filter((t) => t.author.verified).length / ts.length) * 100) / 100 : 0,
		duplicates,
		top_authors: [...authors.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5).map(([handle, v]) => ({ handle, ...v })),
		top_hashtags: topCounts(ts.flatMap((t) => t.hashtags.map((h) => `#${h.toLowerCase()}`)), 8).map((x) => ({ tag: x.key, count: x.count })),
		top_domains: topCounts(ts.flatMap((t) => t.urls.map(domainOf).filter((d): d is string => !!d)), 5).map((x) => ({ domain: x.key, count: x.count })),
		top: sortTweets(ts, "engagement").slice(0, 5),
		earliest_notable: notable[0] ?? null,
	};
}

const handle = (h: string) => h.replace(/^@/, "");

export function buildQuery(query: string, f: SearchFilters): string {
	const parts = [query.trim()];
	if (f.from) parts.push(`from:${handle(f.from)}`);
	if (f.to) parts.push(`to:${handle(f.to)}`);
	if (f.mentions) parts.push(`@${handle(f.mentions)}`);
	if (f.since) parts.push(`since:${f.since}`);
	if (f.until) parts.push(`until:${f.until}`);
	if (f.lang) parts.push(`lang:${f.lang}`);
	if (f.min_likes) parts.push(`min_faves:${f.min_likes}`);
	if (f.min_retweets) parts.push(`min_retweets:${f.min_retweets}`);
	if (f.min_replies) parts.push(`min_replies:${f.min_replies}`);
	for (const h of f.has ?? []) parts.push(`filter:${h === "video" ? "videos" : h}`);
	for (const x of f.exclude ?? []) parts.push(`-filter:${x}`);
	if (f.verified_only) parts.push("filter:blue_verified");
	if (f.near) parts.push(`near:"${f.near.replace(/"/g, "")}"`);
	if (f.near && f.within) parts.push(`within:${f.within}`);
	return parts.filter(Boolean).join(" ");
}

export function validateFilters(f: SearchFilters): string | null {
	for (const k of ["since", "until"] as const) {
		if (f[k] && !/^\d{4}-\d{2}-\d{2}$/.test(f[k])) return `${k} must be YYYY-MM-DD`;
	}
	for (const k of ["from", "to", "mentions"] as const) {
		if (f[k] && !/^@?\w{1,15}$/.test(f[k])) return `${k} must be an X handle`;
	}
	if (f.lang && !/^[a-z]{2,3}$/.test(f.lang)) return "lang must be an ISO code like en, hi, ja";
	if (f.within && !/^\d+(mi|km)$/.test(f.within)) return "within must look like 15km or 10mi";
	return null;
}
