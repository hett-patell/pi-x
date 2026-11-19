import { XError } from "../errors.ts";
import { fitToBudget, formatStats, formatTweet, OUTPUT_BUDGET } from "../format.ts";
import { parseTimeline, type Tweet } from "../normalize.ts";
import { collapseDuplicates, computeStats, scoreAll, sortTweets } from "../score.ts";
import { clamp } from "../util.ts";
import { type Progress, paginate, type ToolDeps, type ToolOutput, withAccount, personalAccount, type PickAccount } from "./context.ts";

export async function runHome(
	deps: ToolDeps,
	p: { limit?: number; sort?: "recent" | "engagement"; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	pick?: PickAccount,
): Promise<ToolOutput> {
	const limit = clamp(p.limit ?? 40, 1, 200);

	const pinned = await personalAccount(deps, p.account, pick);
	const { value, account } = await withAccount(deps, pinned.name, signal, async (a) => {
		const r = await paginate(
			async (cursor) =>
				parseTimeline(
					await deps.engine.graphql(
						a,
						"HomeLatestTimeline",
						{ count: 20, includePromotedContent: false, latestControlAvailable: true, ...(cursor ? { cursor } : {}) },
						{ signal },
					),
				),
			limit,
			{ signal, progress, sleep: deps.sleep, random: deps.random, label: "home" },
		);
		return r;
	});

	const { kept, duplicates } = collapseDuplicates(scoreAll(value.tweets));
	const tweets = sortTweets(kept, p.sort ?? "recent");
	const stats = computeStats(tweets, duplicates);
	const head = `Home feed — @${account.handle ?? account.name} · ${tweets.length} posts\n\n${formatStats(stats)}`;
	const body = fitToBudget(head, tweets.map((t, i) => formatTweet(t, i + 1)), OUTPUT_BUDGET);
	return {
		text: body.text,
		details: { account: account.name, count: tweets.length, stats: { ...stats, top: stats.top.map((t) => t.id), earliest_notable: stats.earliest_notable?.id ?? null }, tweets },
	};
}
