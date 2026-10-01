import type { Account } from "../config.ts";
import { domTrends } from "../dom.ts";
import { toXError, XError } from "../errors.ts";
import { formatStats, formatTrends, formatTweet } from "../format.ts";
import { matchLocation, parseExploreTabs, parsePlaceTrends, parseTrendTimeline, type Place, suggestLocations, type Trend } from "../normalize.ts";
import { collapseDuplicates, computeStats, scoreAll, type Stats } from "../score.ts";
import { clamp } from "../util.ts";
import { type Progress, readConfig, type ToolDeps, type ToolOutput, withAccount } from "./context.ts";
import { searchTweets } from "./search.ts";

export interface TrendingParams {
	location?: string;
	tab?: "trending" | "news" | "sports" | "entertainment";
	include_news?: boolean;
	limit?: number;
	drilldown?: number;
	account?: string;
}

interface Drill {
	trend: string;
	query: string;
	stats: Stats;
}

export function isPersonalized(loc?: string): boolean {
	return !loc || /^(default|personali[sz]ed|for ?you|account|explore)$/i.test(loc.trim());
}

/** Mark trends not present in the previous call for the same view. First call → `new` stays undefined. */
export function markNew(memory: Map<string, Set<string>>, key: string, trends: Trend[]): void {
	const prev = memory.get(key);
	if (prev) for (const t of trends) t.new = !prev.has(t.name);
	memory.set(key, new Set(trends.map((t) => t.name)));
}

async function places(deps: ToolDeps, a: Account, signal?: AbortSignal): Promise<Place[]> {
	if (!deps.placeCache.places) deps.placeCache.places = (await deps.engine.rest(a, "/i/api/1.1/trends/available.json", { signal })) as Place[];
	return deps.placeCache.places;
}

async function timeline(deps: ToolDeps, a: Account, id: string, signal?: AbortSignal): Promise<Trend[]> {
	return parseTrendTimeline(await deps.engine.graphql(a, "GenericTimelineById", { timelineId: id, count: 40, withQuickPromoteEligibilityTweetFields: false }, { signal }));
}

export async function runTrending(deps: ToolDeps, p: TrendingParams, signal?: AbortSignal, progress?: Progress): Promise<ToolOutput> {
	const cfg = readConfig(deps);
	const loc = (p.location ?? cfg.trendsLocation ?? "").trim();
	const personalized = isPersonalized(p.location ?? cfg.trendsLocation);
	const tab = p.tab ?? "trending";
	const limit = clamp(p.limit ?? 20, 1, 50);
	const wantNews = (p.include_news ?? true) && tab === "trending";
	const drillN = clamp(p.drilldown ?? 0, 0, 5);

	const { value, account, skipped } = await withAccount(deps, p.account, signal, async (a) => {
		let trends: Trend[];
		let news: Trend[] = [];
		let where: string;
		let engine: "api" | "dom" = "api";
		if (!personalized) {
			const list = await places(deps, a, signal);
			const place = matchLocation(list, loc);
			if (!place) {
				const near = suggestLocations(list, loc);
				throw new XError("invalid_input", `Unknown trends location "${loc}"`, `Try: ${near.length ? near.join(", ") : "worldwide, United States, India, United Kingdom, Japan"}`);
			}
			const pt = parsePlaceTrends(await deps.engine.rest(a, `/i/api/1.1/trends/place.json?id=${place.woeid}`, { signal }));
			trends = pt.trends;
			where = pt.location;
		} else {
			where = `account "${a.name}"${a.handle ? ` (@${a.handle})` : ""} Explore`;
			try {
				const tabs = parseExploreTabs(await deps.engine.graphql(a, "ExplorePage", { cursor: "" }, { signal }));
				if (!tabs[tab]) throw new XError("api_changed", `Explore tab "${tab}" not found (have: ${Object.keys(tabs).join(", ")})`);
				trends = await timeline(deps, a, tabs[tab], signal);
				if (tab === "news") for (const t of trends) t.is_news ||= true;
				if (wantNews && tabs.news) news = await timeline(deps, a, tabs.news, signal);
			} catch (e) {
				if (toXError(e).code !== "api_changed") throw e;
				engine = "dom";
				progress?.("X API changed — reading the Explore page instead");
				trends = await domTrends(deps, a, tab, signal);
				if (wantNews) news = await domTrends(deps, a, "news", signal).catch(() => []);
			}
		}
		trends = trends.filter((t) => !t.promoted).slice(0, limit);
		news = news.filter((t) => !t.promoted && t.is_news).slice(0, Math.min(limit, 15));

		const drill: Drill[] = [];
		for (const t of trends.slice(0, drillN)) {
			progress?.(`why is "${t.name}" trending? sampling top posts…`);
			const r = await searchTweets(deps, a, t.query, { product: "Top", limit: 20, querySource: "trend_click", signal });
			const { kept, duplicates } = collapseDuplicates(scoreAll(r.tweets));
			drill.push({ trend: t.name, query: t.query, stats: computeStats(kept, duplicates) });
		}
		return { trends, news, where, engine, drill };
	});

	markNew(deps.trendMemory, `${value.where}|${tab}`, value.trends);
	const title = `${tab === "trending" ? "Trending" : tab[0].toUpperCase() + tab.slice(1)} — ${value.where}${value.engine === "dom" ? " [page-scrape fallback]" : ""}${skipped.length ? ` (skipped ${skipped.join(", ")})` : ""}`;
	const parts = [formatTrends(title, value.trends)];
	if (value.news.length) parts.push(formatTrends("News & stories", value.news));
	if (value.drill.length) {
		parts.push(
			`Why it's trending (top posts per trend):\n\n${value.drill
				.map((d) => [`▸ ${d.trend} — ${d.stats.count} posts sampled`, formatStats(d.stats), ...d.stats.top.slice(0, 3).map((t, i) => formatTweet(t, i + 1))].join("\n"))
				.join("\n\n")}`,
		);
	} else if (value.trends.length) {
		parts.push('Tip: pass drilldown: 3 to sample top posts for the top trends, or call x_search with a trend\'s query (type: "Top").');
	}
	return {
		text: parts.join("\n\n"),
		details: {
			account: account.name,
			where: value.where,
			tab,
			engine: value.engine,
			trends: value.trends,
			news: value.news,
			drilldown: value.drill.map((d) => ({ ...d, stats: { ...d.stats, top: d.stats.top, earliest_notable: d.stats.earliest_notable } })),
		},
	};
}
