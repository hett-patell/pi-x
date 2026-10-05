import type { Account } from "./config.ts";
import { XError } from "./errors.ts";
import { extractTags, parseCompact, type Trend, type Tweet } from "./normalize.ts";
import type { Classify, DomFn } from "./page.ts";

export interface DomTweet {
	id: string;
	handle: string;
	text: string;
	lang: string | null;
	time: string | null;
	verified: boolean;
	labels: { reply: string; retweet: string; like: string; bookmark: string; views: string };
	media: string[];
}

export interface DomDeps {
	engine: { dom<T>(a: Account, fn: DomFn, opts?: { signal?: AbortSignal }): Promise<T> };
	sessions: {
		open(a: Account, url: string, signal?: AbortSignal): Promise<void>;
		scroll(a: Account, px: number, signal?: AbortSignal): Promise<void>;
	};
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function tweetFromDom(d: DomTweet): Tweet {
	const tags = extractTags(d.text);
	return {
		id: d.id,
		url: `https://x.com/${d.handle}/status/${d.id}`,
		text: d.text.trim(),
		created_at: d.time,
		lang: d.lang,
		author: { handle: d.handle, name: d.handle, verified: d.verified },
		metrics: {
			likes: parseCompact(d.labels.like) ?? 0,
			retweets: parseCompact(d.labels.retweet) ?? 0,
			replies: parseCompact(d.labels.reply) ?? 0,
			quotes: 0,
			bookmarks: parseCompact(d.labels.bookmark) ?? 0,
			views: parseCompact(d.labels.views) ?? null,
		},
		hashtags: tags.hashtags,
		mentions: tags.mentions.filter((m) => m.toLowerCase() !== d.handle.toLowerCase()),
		urls: [],
		media: d.media,
	};
}

/** Parse `[data-testid="trend"]` cell lines. English "Promoted" detection is acceptable for this fallback. */
export function trendsFromDom(cells: string[][], isNews = false): Trend[] {
	let rank = 0;
	const out: Trend[] = [];
	for (const lines of cells) {
		const promoted = lines.some((l) => /^promoted\b/i.test(l));
		const clean = lines.filter((l) => l !== "·" && !/^\d+$/.test(l));
		const volLine = clean.find((l) => /\d/.test(l) && /post|tweet/i.test(l));
		const meta = clean.find((l) => l !== volLine && (l.includes("·") || /trending/i.test(l)));
		const name = clean.find((l) => l !== meta && l !== volLine && !/^promoted\b/i.test(l)) ?? "";
		if (!name) continue;
		// Extract volume: find the number right before "posts" or "tweets"
		let volume: number | undefined;
		if (volLine) {
			const volMatch = volLine.match(/(\d[\d.,]*\s*[KMB]?)\s*(?:posts?|tweets?)/i);
			volume = volMatch ? parseCompact(volMatch[1]) : undefined;
		}
		out.push({ rank: promoted ? 0 : ++rank, name, category: meta, volume, query: name, is_news: isNews, promoted });
	}
	return out;
}

async function waitForTweets(deps: DomDeps, a: Account, signal?: AbortSignal, ms = 10_000): Promise<void> {
	for (let waited = 0; waited < ms; waited += 700) {
		if ((await deps.engine.dom<number>(a, "count", { signal })) > 0) return;
		await deps.sleep(700, signal);
	}
}

export async function domSearch(
	deps: DomDeps,
	a: Account,
	rawQuery: string,
	product: "Latest" | "Top" | "Media",
	limit: number,
	signal?: AbortSignal,
	progress?: (msg: string) => void,
): Promise<Tweet[]> {
	const f = product === "Top" ? "top" : product === "Media" ? "media" : "live";
	await deps.sessions.open(a, `https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=${f}`, signal);
	await waitForTweets(deps, a, signal);
	const cls = await deps.engine.dom<Classify>(a, "classify", { signal });
	if (cls.wall || !cls.loggedIn) throw new XError("not_logged_in", `Account "${a.name}" hit X's login wall`);
	const seen = new Map<string, Tweet>();
	let stale = 0;
	for (let pass = 0; pass < 12 && seen.size < limit && stale < 2; pass++) {
		if (pass) {
			await deps.sessions.scroll(a, 2500, signal);
			await deps.sleep(1200, signal);
		}
		const before = seen.size;
		for (const d of await deps.engine.dom<DomTweet[]>(a, "tweets", { signal })) if (!seen.has(d.id)) seen.set(d.id, tweetFromDom(d));
		stale = seen.size === before ? stale + 1 : 0;
		progress?.(`page scrape: ${seen.size} posts`);
	}
	return [...seen.values()].slice(0, limit);
}

export async function domTrends(deps: DomDeps, a: Account, tab: string, signal?: AbortSignal): Promise<Trend[]> {
	await deps.sessions.open(a, `https://x.com/explore/tabs/${tab === "trending" ? "trending" : tab}`, signal);
	for (let waited = 0; waited < 10_000; waited += 800) {
		const cells = await deps.engine.dom<string[][]>(a, "trends", { signal });
		if (cells.length) return trendsFromDom(cells, tab === "news");
		await deps.sleep(800, signal);
	}
	throw new XError("dom_changed", `No trend cells found on /explore/tabs/${tab}`);
}
