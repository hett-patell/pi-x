import { toXError, XError } from "../errors.ts";
import { fitToBudget, formatTweet } from "../format.ts";
import { parseConversation, parseTimeline, splitConversation, type Tweet, tweetFromSyndication } from "../normalize.ts";
import { scoreAll, sortTweets } from "../score.ts";
import { clamp } from "../util.ts";
import { type Progress, type ToolDeps, type ToolOutput, withAccount } from "./context.ts";

export function parseTweetId(input: string): string {
	const s = (input ?? "").trim();
	if (/^\d{1,25}$/.test(s)) return s;
	const m = s.match(/(?:x|twitter)\.com\/(?:[^/]+|i\/web)\/status(?:es)?\/(\d+)/i);
	if (m) return m[1];
	if (/t\.co\//.test(s)) throw new XError("invalid_input", "t.co short links must be opened first to get the real x.com URL");
	throw new XError("invalid_input", `Could not find a post ID in "${s}" — pass an ID or an x.com/<user>/status/<id> URL`);
}

/** Token the embed widget computes; the endpoint wants one present. */
export function syndicationToken(id: string): string {
	return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

export async function fetchSyndication(fetchFn: typeof fetch, id: string, signal?: AbortSignal): Promise<Tweet | null> {
	const timeout = AbortSignal.timeout(20_000);
	const res = await fetchFn(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}`, {
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new XError("network", `syndication feed HTTP ${res.status}`);
	const text = await res.text();
	return text ? tweetFromSyndication(JSON.parse(text)) : null;
}

const DETAIL_VARS = {
	with_rux_injections: false,
	includePromotedContent: false,
	withCommunity: true,
	withQuickPromoteEligibilityTweetFields: false,
	withBirdwatchNotes: true,
	withVoice: true,
	rankingMode: "Relevance",
};

export async function runTweet(
	deps: ToolDeps,
	p: { id_or_url: string; replies?: number; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
): Promise<ToolOutput> {
	const id = parseTweetId(p.id_or_url);
	const want = clamp(p.replies ?? 0, 0, 100);
	if (want === 0) {
		try {
			const t = await fetchSyndication(deps.fetchFn, id, signal);
			if (t) {
				scoreAll([t]);
				return { text: `X post (via free syndication feed, no login):\n\n${formatTweet(t)}`, details: { id, source: "syndication", tweet: t } };
			}
		} catch (e) {
			if (toXError(e).code === "aborted") throw e;
			progress?.("syndication feed unavailable — using the logged-in API");
		}
	}
	const { value, account } = await withAccount(deps, p.account, signal, async (a) => {
		const first = parseConversation(await deps.engine.graphql(a, "TweetDetail", { focalTweetId: id, ...DETAIL_VARS }, { signal }), id);
		if (!first.focal) throw new XError("not_found", `Post ${id} not found (deleted, protected, or suspended)`);
		const focal = first.focal;
		const seen = new Map([...first.replies, ...first.thread].map((t) => [t.id, t]));
		let cursor = first.cursor;
		for (let page = 1; seen.size < want && cursor && page < 6; page++) {
			await deps.sleep(1500 + deps.random() * 1000, signal);
			progress?.(`replies: ${seen.size}`);
			const more = parseTimeline(await deps.engine.graphql(a, "TweetDetail", { focalTweetId: id, cursor, referrer: "tweet", ...DETAIL_VARS }, { signal }));
			for (const t of more.tweets) if (t.id !== id && !seen.has(t.id)) seen.set(t.id, t);
			cursor = more.cursor === cursor ? null : more.cursor;
		}
		const split = splitConversation(focal, [...first.ancestors, ...seen.values()]);
		return { focal, ancestors: split.ancestors, thread: split.thread, replies: split.replies };
	});
	scoreAll([value.focal, ...value.thread, ...value.replies, ...value.ancestors]);
	const replies = sortTweets(value.replies, "engagement").slice(0, want);
	const thread = sortTweets(value.thread, "recent").reverse();
	const sections = [
		...value.ancestors.map((t) => `(earlier in conversation)\n${formatTweet(t)}`),
		`FOCAL POST\n${formatTweet(value.focal)}`,
		...(thread.length ? [`Author's thread (${thread.length}):\n${thread.map((t, i) => formatTweet(t, i + 1)).join("\n\n")}`] : []),
		...(replies.length ? [`Top replies (${replies.length}, by engagement):`] : []),
		...replies.map((t, i) => formatTweet(t, i + 1)),
	];
	const body = fitToBudget(`X post ${id} via account "${account.name}"`, sections);
	return { text: body.text, details: { id, source: "api", account: account.name, tweet: value.focal, ancestors: value.ancestors, thread, replies } };
}
