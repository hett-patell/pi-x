import { unique } from "./util.ts";

export interface XUser {
	id: string;
	handle: string;
	name: string;
	verified: boolean;
	followers?: number;
	following?: number;
	posts?: number;
	bio?: string;
	location?: string;
	url?: string;
	created_at?: string;
	protected?: boolean;
}

export interface Tweet {
	id: string;
	url: string;
	text: string;
	created_at: string | null;
	lang: string | null;
	author: { handle: string; name: string; verified: boolean; followers?: number };
	metrics: { likes: number; retweets: number; replies: number; quotes: number; bookmarks: number; views: number | null };
	hashtags: string[];
	mentions: string[];
	urls: string[];
	media: string[];
	conversation_id?: string;
	reply_to?: string | null;
	quoted?: Tweet;
	retweeted_by?: string;
	score?: number;
}

export interface Trend {
	rank: number;
	name: string;
	category?: string;
	context?: string;
	volume?: number;
	age?: string;
	query: string;
	is_news: boolean;
	promoted: boolean;
	new?: boolean;
}

export interface Place {
	name: string;
	woeid: number;
	country?: string;
	countryCode?: string | null;
	placeType?: { code: number; name: string };
}

export interface TimelinePage {
	tweets: Tweet[];
	cursor: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: X payloads are untyped JSON
type J = any;

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);

/** "96K posts" → 96000, "1,234 Likes" → 1234, "1.234 Gefällt mir" → 1234, "12,5 K" → 12500. */
export function parseCompact(input: string | null | undefined): number | undefined {
	if (!input) return undefined;
	const m = /(\d+(?:[.,\s\u00a0\u202f]\d+)*)\s*([KkMmBb])?(?![A-Za-z])/.exec(input);
	if (!m) return undefined;
	const digits = m[1].replace(/[\s\u00a0\u202f]/g, "");
	const suffix = m[2]?.toUpperCase();
	const mult = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1;
	const seps = digits.match(/[.,]/g) ?? [];
	if (!seps.length) return Number(digits) * mult;
	const last = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
	const tail = digits.length - last - 1;
	if (suffix && seps.length === 1 && tail <= 2) return Math.round(Number(digits.replace(",", ".")) * mult);
	if (tail === 3) return Number(digits.replace(/[.,]/g, "")) * mult;
	return Math.round(Number(`${digits.slice(0, last).replace(/[.,]/g, "")}.${digits.slice(last + 1)}`) * mult);
}

const HASHTAG_RE = /(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;
const MENTION_RE = /(?:^|[^\w@])@(\w{1,15})/g;

export function extractTags(text: string): { hashtags: string[]; mentions: string[] } {
	return {
		hashtags: unique([...text.matchAll(HASHTAG_RE)].map((m) => m[1])),
		mentions: unique([...text.matchAll(MENTION_RE)].map((m) => m[1])),
	};
}

export function toIso(s: unknown): string | null {
	if (typeof s !== "string" || !s) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const stripMediaLink = (s: string) => s.replace(/\s*https:\/\/t\.co\/\w+\s*$/, "").trim();

const STOP = new Set(["about", "after", "amid", "their", "there", "these", "those", "where", "which", "while", "would", "could", "should", "says", "said", "from", "with", "over", "into"]);

/** Search terms for a news headline (news items have no search deep link). */
export function keywordQuery(title: string): string {
	const words = title.replace(/[^\p{L}\p{N}#@\s'-]/gu, " ").split(/\s+/).filter((w) => w.length >= 5 && !STOP.has(w.toLowerCase()));
	const keep = new Set([...words].sort((a, b) => b.length - a.length).slice(0, 5));
	return words.filter((w) => keep.has(w)).join(" ") || title;
}

export function userFromResult(u: J): XUser | null {
	if (!u || u.__typename === "UserUnavailable") return null;
	const core = u.core ?? {};
	const legacy = u.legacy ?? {};
	const handle: string | undefined = core.screen_name ?? legacy.screen_name;
	if (!handle) return null;
	const loc = typeof u.location === "object" ? u.location?.location : u.location;
	return {
		id: String(u.rest_id ?? ""),
		handle,
		name: core.name ?? legacy.name ?? handle,
		verified: Boolean(u.is_blue_verified || u.verification?.verified || legacy.verified),
		followers: u.relationship_counts?.followers ?? legacy.followers_count,
		following: u.relationship_counts?.following ?? legacy.friends_count,
		posts: u.tweet_counts?.tweets ?? legacy.statuses_count,
		bio: u.profile_bio?.description ?? legacy.description,
		location: loc || legacy.location || undefined,
		url: u.profile_bio?.entities?.url?.urls?.[0]?.expanded_url ?? legacy.entities?.url?.urls?.[0]?.expanded_url ?? u.website?.url ?? legacy.url ?? undefined,
		created_at: toIso(core.created_at ?? legacy.created_at) ?? undefined,
		protected: Boolean(u.privacy?.protected ?? legacy.protected),
	};
}

function unwrap(r: J): J | null {
	if (!r) return null;
	if (r.__typename === "TweetWithVisibilityResults") return r.tweet ?? null;
	return r.legacy ? r : null;
}

export function tweetFromResult(raw: J): Tweet | null {
	const t = unwrap(raw);
	if (!t) return null;
	const L = t.legacy;
	const user = userFromResult(t.core?.user_results?.result);
	const handle = user?.handle ?? "i";
	const id = String(t.rest_id ?? L.id_str);
	const note = t.note_tweet?.note_tweet_results?.result;
	const text = stripMediaLink(String(note?.text ?? L.full_text ?? ""));
	const tags = extractTags(text);
	const out: Tweet = {
		id,
		url: `https://x.com/${handle}/status/${id}`,
		text,
		created_at: toIso(L.created_at),
		lang: L.lang ?? null,
		author: { handle, name: user?.name ?? handle, verified: user?.verified ?? false, followers: user?.followers },
		metrics: {
			likes: num(L.favorite_count),
			retweets: num(L.retweet_count),
			replies: num(L.reply_count),
			quotes: num(L.quote_count),
			bookmarks: num(L.bookmark_count),
			views: t.views?.count != null ? num(t.views.count) : null,
		},
		hashtags: unique([...(L.entities?.hashtags ?? []).map((h: J) => h.text), ...tags.hashtags]),
		mentions: unique([...(L.entities?.user_mentions ?? []).map((m: J) => m.screen_name), ...tags.mentions]),
		urls: unique([...(L.entities?.urls ?? []), ...(note?.entity_set?.urls ?? [])].map((u: J) => u.expanded_url ?? u.url)),
		media: unique((L.extended_entities?.media ?? L.entities?.media ?? []).map((m: J) => m.media_url_https ?? m.url)),
		conversation_id: L.conversation_id_str,
		reply_to: L.in_reply_to_status_id_str ?? null,
	};
	const quoted = tweetFromResult(t.quoted_status_result?.result);
	if (quoted) out.quoted = quoted;
	const original = tweetFromResult(L.retweeted_status_result?.result);
	if (original) {
		original.retweeted_by = handle;
		return original;
	}
	return out;
}

export function tweetFromSyndication(d: J): Tweet | null {
	if (!d?.id_str) return null;
	const text = stripMediaLink(String(d.text ?? ""));
	const handle: string = d.user?.screen_name ?? "i";
	const tags = extractTags(text);
	const out: Tweet = {
		id: d.id_str,
		url: `https://x.com/${handle}/status/${d.id_str}`,
		text,
		created_at: toIso(d.created_at),
		lang: d.lang ?? null,
		author: { handle, name: d.user?.name ?? handle, verified: Boolean(d.user?.is_blue_verified || d.user?.verified) },
		metrics: { likes: num(d.favorite_count), retweets: num(d.retweet_count), replies: num(d.conversation_count ?? d.reply_count), quotes: num(d.quote_count), bookmarks: 0, views: null },
		hashtags: unique([...(d.entities?.hashtags ?? []).map((h: J) => h.text), ...tags.hashtags]),
		mentions: unique([...(d.entities?.user_mentions ?? []).map((m: J) => m.screen_name), ...tags.mentions]),
		urls: unique((d.entities?.urls ?? []).map((u: J) => u.expanded_url)),
		media: unique((d.mediaDetails ?? []).map((m: J) => m.media_url_https)),
		conversation_id: d.conversation_id_str,
		reply_to: d.in_reply_to_status_id_str ?? null,
	};
	const q = tweetFromSyndication(d.quoted_tweet);
	if (q) out.quoted = q;
	return out;
}

function walk(o: unknown, visit: (o: J) => boolean): void {
	if (Array.isArray(o)) {
		for (const v of o) walk(v, visit);
		return;
	}
	if (o && typeof o === "object") {
		if (!visit(o)) return;
		for (const v of Object.values(o)) walk(v, visit);
	}
}

/** Collect tweets (in payload order, deduped, promoted removed) + the Bottom cursor from any timeline payload. */
export function parseTimeline(json: unknown): TimelinePage {
	const tweets: Tweet[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	walk(json, (o) => {
		if (o.tweet_results && typeof o.tweet_results === "object") {
			if (!o.promotedMetadata) {
				const t = tweetFromResult(o.tweet_results.result);
				if (t && !seen.has(t.id)) {
					seen.add(t.id);
					tweets.push(t);
				}
			}
			return false;
		}
		if (o.cursorType === "Bottom" && typeof o.value === "string") cursor = o.value;
		return true;
	});
	return { tweets, cursor };
}


/** Compare X numeric id strings (snowflakes) by value; plain string comparison breaks across lengths. */
export function compareIds(a: string, b: string): number {
	if (a.length !== b.length) return a.length - b.length;
	return a < b ? -1 : a > b ? 1 : 0;
}
const older = (a: string, b: string) => compareIds(a, b) < 0;

export function splitConversation(focal: Tweet, tweets: Tweet[]): { ancestors: Tweet[]; thread: Tweet[]; replies: Tweet[] } {
	const ancestors: Tweet[] = [];
	const thread: Tweet[] = [];
	const replies: Tweet[] = [];
	for (const t of tweets) {
		if (t.id === focal.id) continue;
		if (older(t.id, focal.id)) ancestors.push(t);
		else if (t.author.handle === focal.author.handle && t.conversation_id === focal.conversation_id) thread.push(t);
		else replies.push(t);
	}
	return { ancestors, thread, replies };
}

export function parseConversation(json: unknown, focalId: string) {
	const { tweets, cursor } = parseTimeline(json);
	const focal = tweets.find((t) => t.id === focalId) ?? null;
	if (!focal) return { focal: null, ancestors: [] as Tweet[], thread: [] as Tweet[], replies: [] as Tweet[], cursor };
	return { focal, ...splitConversation(focal, tweets), cursor };
}

export function parseUser(json: unknown): XUser | null {
	return userFromResult((json as J)?.data?.user?.result);
}

export interface DmConversation {
	id: string;
	handle: string;
	name: string;
	last_text: string | null;
	/** "you" or the other participant's handle. */
	last_sender: string | null;
	/** ISO timestamp of the last message. */
	last_at: string | null;
	unread: boolean;
}

function dmTime(s: unknown): string | null {
	if (typeof s !== "string" || !s) return null;
	if (/^\d+$/.test(s)) {
		const d = new Date(Number(s));
		return Number.isNaN(d.getTime()) ? s : d.toISOString();
	}
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Flatten X's `inbox_initial_state.json` into recent 1:1 conversations (skips group DMs). */
export function parseDmInbox(json: unknown, selfId: string): DmConversation[] {
	const inbox = (json as J)?.inbox_initial_state;
	if (!inbox) return [];
	const conversations = (inbox.conversations ?? {}) as Record<string, J>;
	const entries = (inbox.entries ?? []) as J[];
	const users = (inbox.users ?? {}) as Record<string, J>;
	const self = String(selfId ?? "");

	const lastByConv = new Map<string, { eventId: string; text: string; senderId: string; time: string | null }>();
	for (const e of entries) {
		const msg = e?.message ?? {};
		const cid = String(msg.conversation_id ?? "");
		if (!cid) continue;
		const md = msg.message_data ?? {};
		const eventId = String(msg.id ?? md.id ?? "");
		const cur = lastByConv.get(cid);
		if (cur && compareIds(cur.eventId, eventId) >= 0) continue;
		lastByConv.set(cid, {
			eventId,
			text: typeof md.text === "string" ? md.text : "",
			senderId: String(md.sender_id ?? ""),
			time: dmTime(md.time),
		});
	}

	const out: DmConversation[] = [];
	for (const [cid, conv] of Object.entries(conversations)) {
		if (String(conv?.type ?? "") === "GROUP_DM") continue;
		const participants = (conv?.participants ?? []) as J[];
		const other = participants.find((p) => String(p?.user_id ?? "") !== self);
		if (!other) continue;
		const otherId = String(other.user_id ?? "");
		const u = users[otherId] ?? {};
		const last = lastByConv.get(cid);
		const lastRead = conv?.last_read_event_id != null ? String(conv.last_read_event_id) : null;
		const unread = Boolean(last && last.senderId !== self && lastRead != null && compareIds(last.eventId, lastRead) > 0);
		out.push({
			id: cid,
			handle: String(u.screen_name ?? other.screen_name ?? otherId),
			name: String(u.name ?? ""),
			last_text: last?.text ?? null,
			last_sender: last ? (last.senderId === self ? "you" : String(users[last.senderId]?.screen_name ?? last.senderId)) : null,
			last_at: last?.time ?? null,
			unread,
		});
	}
	return out.sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
}

function trendFromItem(o: J): Trend {
	const ctx: string | undefined = o.social_context?.text ?? undefined;
	const parts = ctx ? ctx.split("·").map((s: string) => s.trim()) : [];
	const deep: string = o.trend_metadata?.url?.url ?? o.trend_url?.url ?? "";
	const qm = /[?&]query=([^&]+)/.exec(deep);
	const metaDesc: string | undefined = o.trend_metadata?.meta_description ?? undefined;
	const isNews = Boolean(o.is_ai_trend) || deep.startsWith("twitter://trending/");
	const volumeText = parts.find((p: string) => /\d/.test(p) && /post|tweet/i.test(p)) ?? (metaDesc && /\d/.test(metaDesc) ? metaDesc : undefined);
	return {
		rank: 0,
		name: String(o.name),
		category: o.trend_metadata?.domain_context ?? (parts.length >= 3 ? parts[1] : undefined),
		context: ctx,
		volume: parseCompact(volumeText),
		age: parts.length >= 3 ? parts[0] : undefined,
		query: qm ? decodeURIComponent(qm[1].replace(/\+/g, " ")) : isNews ? keywordQuery(String(o.name)) : String(o.name),
		is_news: isNews,
		promoted: Boolean(o.promoted_metadata) || /^promoted\b/i.test(metaDesc ?? "") || /src=promoted/.test(deep),
	};
}

export function parseTrendTimeline(json: unknown): Trend[] {
	const out: Trend[] = [];
	walk(json, (o) => {
		if (o.__typename === "TimelineTrend" || o.itemType === "TimelineTrend") {
			if (o.name) out.push(trendFromItem(o));
			return false;
		}
		return true;
	});
	let rank = 0;
	for (const t of out) if (!t.promoted) t.rank = ++rank;
	return out;
}

/** Explore tab id → timeline id, e.g. { trending: "VGlt…", news: "…" }. */
export function parseExploreTabs(json: unknown): Record<string, string> {
	const tabs: Record<string, string> = {};
	for (const t of ((json as J)?.data?.explore_page?.body?.timelines ?? []) as J[]) {
		if (t?.id && t?.timeline?.id) tabs[t.id] = t.timeline.id;
	}
	return tabs;
}

export function parsePlaceTrends(json: unknown): { location: string; as_of?: string; trends: Trend[] } {
	const first = Array.isArray(json) ? (json[0] as J) : null;
	let rank = 0;
	const trends: Trend[] = ((first?.trends ?? []) as J[]).map((t) => {
		const promoted = Boolean(t.promoted_content);
		return {
			rank: promoted ? 0 : ++rank,
			name: String(t.name),
			volume: typeof t.tweet_volume === "number" ? t.tweet_volume : undefined,
			query: t.query ? decodeURIComponent(String(t.query).replace(/\+/g, " ")) : String(t.name),
			is_news: false,
			promoted,
		};
	});
	return { location: first?.locations?.[0]?.name ?? "?", as_of: first?.as_of, trends };
}

const ALIASES: Record<string, string> = {
	world: "worldwide", global: "worldwide", us: "united states", usa: "united states", america: "united states",
	uk: "united kingdom", britain: "united kingdom",
};
const typeRank = (p: Place) => (p.placeType?.code === 19 ? 0 : p.placeType?.code === 12 ? 1 : 2);

export function matchLocation(places: Place[], input: string): Place | null {
	const q0 = input.trim().toLowerCase();
	const q = ALIASES[q0] ?? q0;
	if (/^\d+$/.test(q)) return places.find((p) => p.woeid === Number(q)) ?? { name: `WOEID ${q}`, woeid: Number(q) };
	const exact = places.filter((p) => p.name.toLowerCase() === q);
	if (exact.length) return [...exact].sort((a, b) => typeRank(a) - typeRank(b))[0];
	if (q.length === 2) {
		const c = places.find((p) => p.countryCode?.toLowerCase() === q && p.placeType?.code === 12);
		if (c) return c;
	}
	const starts = places.filter((p) => p.name.toLowerCase().startsWith(q));
	return [...starts].sort((a, b) => typeRank(a) - typeRank(b))[0] ?? null;
}

export function suggestLocations(places: Place[], input: string, n = 5): string[] {
	const q = input.trim().toLowerCase();
	return places
		.filter((p) => p.name.toLowerCase().includes(q) || (p.country ?? "").toLowerCase().includes(q))
		.slice(0, n)
		.map((p) => p.name);
}
