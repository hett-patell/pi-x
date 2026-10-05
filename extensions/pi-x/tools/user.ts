import { XError } from "../errors.ts";
import { fitToBudget, formatStats, formatTweet, formatUser } from "../format.ts";
import { parseTimeline, parseUser } from "../normalize.ts";
import { collapseDuplicates, computeStats, scoreAll, sortTweets } from "../score.ts";
import { clamp } from "../util.ts";
import { type Progress, paginate, type ToolDeps, type ToolOutput, withAccount } from "./context.ts";

export function parseUsername(input: string): string {
	const s = (input ?? "").trim().replace(/^@/, "");
	const m = s.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
	if (m) return m[1];
	if (/^[A-Za-z0-9_]{1,15}$/.test(s)) return s;
	throw new XError("invalid_input", `Could not read an X username from "${input}"`);
}

export async function runUser(
	deps: ToolDeps,
	p: { username: string; posts?: number; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
): Promise<ToolOutput> {
	const handle = parseUsername(p.username);
	const want = clamp(p.posts ?? 0, 0, 100);
	const { value, account } = await withAccount(deps, p.account, signal, async (a) => {
		const user = parseUser(await deps.engine.graphql(a, "UserByScreenName", { screen_name: handle }, { signal }));
		if (!user) throw new XError("not_found", `@${handle} not found (suspended, renamed, or never existed)`);
		if (!want) return { user, tweets: [] };
		const r = await paginate(
			async (cursor) =>
				parseTimeline(
					await deps.engine.graphql(
						a,
						"UserTweets",
						{ userId: user.id, count: 20, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: true, ...(cursor ? { cursor } : {}) },
						{ signal },
					),
				),
			want,
			{ signal, progress, sleep: deps.sleep, random: deps.random, label: `@${handle} posts` },
		);
		return { user, tweets: r.tweets };
	});
	if (!want) return { text: formatUser(value.user), details: { account: account.name, user: value.user } };
	const { kept, duplicates } = collapseDuplicates(scoreAll(value.tweets));
	const posts = sortTweets(kept, "recent");
	const stats = computeStats(posts, duplicates);
	const body = fitToBudget(`${formatUser(value.user)}\n\nRecent posts\n${formatStats(stats)}`, posts.map((t, i) => formatTweet(t, i + 1)));
	return { text: body.text, details: { account: account.name, user: value.user, stats: { ...stats, top: stats.top.map((t) => t.id), earliest_notable: stats.earliest_notable?.id ?? null }, posts } };
}
