import type { Account } from "../config.ts";
import { domSearch } from "../dom.ts";
import { toXError, XError } from "../errors.ts";
import { fitToBudget, formatStats, formatTweet } from "../format.ts";
import { parseTimeline, type Tweet } from "../normalize.ts";
import { buildQuery, collapseDuplicates, computeStats, scoreAll, type SearchFilters, sortTweets, validateFilters } from "../score.ts";
import { clamp } from "../util.ts";
import { type Progress, paginate, type ToolDeps, type ToolOutput, withAccount } from "./context.ts";

export interface SearchParams extends SearchFilters {
	query: string;
	type?: "Latest" | "Top" | "Media";
	limit?: number;
	sort?: "recent" | "engagement";
	account?: string;
	cursor?: string;
}

export async function searchTweets(
	deps: ToolDeps,
	a: Account,
	rawQuery: string,
	opts: { product: "Latest" | "Top" | "Media"; limit: number; querySource?: string; signal?: AbortSignal; progress?: Progress; cursor?: string },
): Promise<{ tweets: Tweet[]; cursor: string | null; engine: "api" | "dom" }> {
	try {
		const r = await paginate(
			async (cursor) =>
				parseTimeline(
					await deps.engine.graphql(
						a,
						"SearchTimeline",
						{ rawQuery, count: 20, querySource: opts.querySource ?? "typed_query", product: opts.product, ...(cursor ? { cursor } : {}) },
						{ method: "POST", signal: opts.signal },
					),
				),
			opts.limit,
			{ signal: opts.signal, progress: opts.progress, sleep: deps.sleep, random: deps.random, label: "search", cursor: opts.cursor },
		);
		return { ...r, engine: "api" };
	} catch (e) {
		if (toXError(e).code !== "api_changed") throw e;
		opts.progress?.("X API changed — falling back to page scraping");
		const tweets = await domSearch(deps, a, rawQuery, opts.product, opts.limit, opts.signal, opts.progress);
		return { tweets, cursor: null, engine: "dom" };
	}
}

export async function runSearch(deps: ToolDeps, p: SearchParams, signal?: AbortSignal, progress?: Progress): Promise<ToolOutput> {
	const query = (p.query ?? "").trim();
	if (!query && !p.from && !p.to && !p.mentions) throw new XError("invalid_input", "query is required (or one of from / to / mentions)");
	const bad = validateFilters(p);
	if (bad) throw new XError("invalid_input", bad);
	const rawQuery = buildQuery(query, p);
	const product = p.type ?? "Latest";
	const limit = clamp(p.limit ?? 40, 1, 300);

	const { value, account, skipped } = await withAccount(deps, p.account, signal, (a) =>
		searchTweets(deps, a, rawQuery, { product, limit, signal, progress, cursor: p.cursor }),
	);
	const { kept, duplicates } = collapseDuplicates(scoreAll(value.tweets));
	const tweets = sortTweets(kept, p.sort ?? "recent");
	const stats = computeStats(tweets, duplicates);
	const head =
		`X search: "${rawQuery}" (${product}) — ${tweets.length} posts via account "${account.name}"` +
		`${value.engine === "dom" ? " [page-scrape fallback]" : ""}${skipped.length ? ` (skipped ${skipped.join(", ")})` : ""}` +
		`\n\n${formatStats(stats)}`;
	const body = fitToBudget(head, tweets.map((t, i) => formatTweet(t, i + 1)));
	return {
		text: body.text + (value.cursor ? `\n\nMore available: call x_search again with cursor "${value.cursor}".` : ""),
		details: {
			query: rawQuery,
			product,
			account: account.name,
			engine: value.engine,
			count: tweets.length,
			next_cursor: value.cursor,
			skipped,
			stats: { ...stats, top: stats.top.map((t) => t.id), earliest_notable: stats.earliest_notable?.id ?? null },
			tweets,
		},
	};
}
