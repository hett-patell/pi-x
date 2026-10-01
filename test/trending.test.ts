import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { saveConfig } from "../extensions/pi-x/config.ts";
import { XError } from "../extensions/pi-x/errors.ts";
import { runTrending } from "../extensions/pi-x/tools/trending.ts";
import { fakeDeps } from "./helpers.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const tabs = fx("graphql-explore");
const timelines: Record<string, unknown> = {
	"VGltZWxpbmU6DAC2CwABAAAACHRyZW5kaW5nAAA=": fx("graphql-trending"),
	"VGltZWxpbmU6DAC2CwABAAAABG5ld3MAAA==": fx("graphql-news"),
};
const gql = (op: string, v: Record<string, unknown>) => {
	if (op === "ExplorePage") return tabs;
	if (op === "GenericTimelineById") return timelines[v.timelineId as string];
	if (op === "SearchTimeline") return fx("graphql-search");
	throw new Error(op);
};

test("personalized trends + news, promoted removed, NEW marking across calls", async () => {
	const deps = fakeDeps({ graphql: gql });
	const out = await runTrending(deps, {});
	assert.match(out.text, /Trending — account "default" Explore/);
	assert.match(out.text, / 1\. #HunkkaarTheRoar — Trending in India/);
	assert.ok(!out.text.includes("UpstoxHaiTohBetterHai"));
	assert.match(out.text, /News & stories/);
	assert.match(out.text, /Google DeepMind Unveils Gemini 4 Argon/);
	const d = out.details as { trends: { name: string; new?: boolean }[]; news: { name: string }[] };
	assert.equal(d.trends.length, 6);
	assert.equal(d.trends[0].new, undefined);
	const again = await runTrending(deps, {});
	assert.equal((again.details as typeof d).trends[0].new, false);
});

test("location via v1.1 place trends", async () => {
	const deps = fakeDeps({ rest: (path) => (path.includes("available") ? fx("v11-trends-available") : (assert.match(path, /id=23424848$/), fx("v11-trends-place"))) });
	const out = await runTrending(deps, { location: "India" });
	assert.match(out.text, /Trending — Worldwide/);
	assert.match(out.text, / 1\. エマちゃん/);
	await assert.rejects(runTrending(deps, { location: "Atlantis" }), (e: XError) => e.code === "invalid_input" && /Unknown trends location/.test(e.message));
});

test("configured default location is used; 'default' forces personalized", async () => {
	const deps = fakeDeps({ graphql: gql, rest: (path) => (path.includes("available") ? fx("v11-trends-available") : fx("v11-trends-place")) });
	saveConfig(deps.paths, { version: 1, accounts: [{ name: "default", enabled: true }], trendsLocation: "worldwide" });
	assert.match((await runTrending(deps, {})).text, /Trending — Worldwide/);
	assert.match((await runTrending(deps, { location: "default" })).text, /Explore/);
});

test("drilldown searches top trends with trend_click and summarizes", async () => {
	const seen: Record<string, unknown>[] = [];
	const deps = fakeDeps({ graphql: (op, v) => { if (op === "SearchTimeline") seen.push(v); return gql(op, v); } });
	const out = await runTrending(deps, { drilldown: 2, include_news: false });
	assert.equal(seen.filter((v) => !v.cursor).length, 2);
	assert.equal(seen[0].querySource, "trend_click");
	assert.equal(seen[0].product, "Top");
	assert.equal(seen[0].rawQuery, "#HunkkaarTheRoar");
	assert.match(out.text, /Why it's trending/);
	assert.match(out.text, /#HunkkaarTheRoar — 5 posts sampled/);
	assert.equal((out.details.drilldown as unknown[]).length, 2);
});

test("tab=news returns stories as the main list", async () => {
	const deps = fakeDeps({ graphql: gql });
	const out = await runTrending(deps, { tab: "news" });
	assert.match(out.text, /News — account "default" Explore/);
	assert.match(out.text, / 1\. Google DeepMind/);
});
