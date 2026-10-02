import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConfig } from "../extensions/pi-x/config.ts";
import { OUTPUT_BUDGET } from "../extensions/pi-x/format.ts";
import { XError } from "../extensions/pi-x/errors.ts";
import { paginate, withAccount } from "../extensions/pi-x/tools/context.ts";
import { runSearch } from "../extensions/pi-x/tools/search.ts";
import { fakeDeps } from "./helpers.ts";

const search = JSON.parse(readFileSync(new URL("./fixtures/graphql-search.json", import.meta.url), "utf8"));
const twoAccounts = { version: 1 as const, accounts: [{ name: "a", enabled: true }, { name: "b", enabled: true }] };

test("withAccount rotates on rotatable errors, records lastUsed, throws others", async () => {
	const deps = fakeDeps({}, twoAccounts);
	const r = await withAccount(deps, undefined, undefined, async (a) => {
		if (a.name === "a") throw new XError("not_logged_in", "wall");
		return a.name;
	});
	assert.deepEqual([r.value, r.account.name, r.skipped], ["b", "b", ["a: not_logged_in"]]);
	assert.equal(loadConfig(deps.paths).config.accounts[1].lastUsed, 1_000_000);
	await assert.rejects(withAccount(deps, undefined, undefined, async () => { throw new XError("not_found", "x"); }), /x/);
	await assert.rejects(withAccount(deps, "a", undefined, async () => { throw new XError("rate_limited", "x"); }), (e: XError) => e.code === "rate_limited");
	await assert.rejects(withAccount(deps, undefined, undefined, async () => { throw new XError("rate_limited", "x"); }), /No X account could complete/);
});

test("paginate stops at limit, missing cursor, or 3 empty pages", async () => {
	let n = 0;
	const page = (ids: string[], cursor: string | null) => ({ tweets: ids.map((id) => ({ id }) as never), cursor });
	const r = await paginate(async () => (n++ < 5 ? page([`t${n}`], `c${n}`) : page([], null)), 3, { sleep: async () => {}, random: () => 0, label: "x" });
	assert.equal(r.tweets.length, 3);
	n = 0;
	const r2 = await paginate(async () => (n++ === 0 ? page(["a"], "c1") : page(["a"], `c${n}`)), 50, { sleep: async () => {}, random: () => 0, label: "x" });
	assert.equal(r2.tweets.length, 1);
	assert.equal(n, 4);
});

test("x_search: builds query, paginates via POST SearchTimeline, returns stats + details", async () => {
	const vars: Record<string, unknown>[] = [];
	const deps = fakeDeps({
		graphql: (op, v) => {
			assert.equal(op, "SearchTimeline");
			vars.push(v);
			return vars.length === 1 ? search : { data: {} };
		},
	});
	const out = await runSearch(deps, { query: "ai agents", min_likes: 50, type: "Top", limit: 40, sort: "engagement" });
	assert.equal(vars[0].rawQuery, "ai agents min_faves:50");
	assert.equal(vars[0].product, "Top");
	assert.equal(vars[0].querySource, "typed_query");
	assert.equal(vars[1].cursor !== undefined, true);
	assert.match(out.text, /^X search: "ai agents min_faves:50" \(Top\) — 5 posts via account "default"/);
	assert.match(out.text, /Stats: 5 posts/);
	assert.match(out.text, /\[1\] @amisha_explains/);
	assert.equal(out.details.count, 5);
	assert.equal(out.details.engine, "api");
	assert.ok(!JSON.stringify(out.details).includes('"raw"'));
});

test("x_search falls back to DOM when the API changed", async () => {
	const deps = fakeDeps({
		graphql: () => { throw new XError("api_changed", "404"); },
		dom: (fn) => (fn === "classify" ? { wall: false, loggedIn: true } : fn === "count" ? 1 : [{ id: "9", handle: "z", text: "hi", lang: null, time: null, verified: false, labels: { reply: "", retweet: "", like: "3 Likes", bookmark: "", views: "" }, media: [] }]),
	});
	const out = await runSearch(deps, { query: "x", limit: 5 });
	assert.equal(out.details.engine, "dom");
	assert.match(out.text, /@z/);
});

test("x_search validates input", async () => {
	const deps = fakeDeps({});
	await assert.rejects(runSearch(deps, { query: " " }), (e: XError) => e.code === "invalid_input");
	await assert.rejects(runSearch(deps, { query: "a", since: "yesterday" }), /YYYY-MM-DD/);
});

test("x_search: the next-cursor line counts toward OUTPUT_BUDGET", async () => {
	const cursor = `DAAC${"q".repeat(3000)}`;
	const entry = (i: number) => ({
		tweet_results: {
			result: {
				__typename: "Tweet",
				rest_id: String(1000 + i),
				core: { user_results: { result: { __typename: "User", core: { screen_name: `u${i}`, name: "U" }, rest_id: String(i) } } },
				legacy: { id_str: String(1000 + i), full_text: `post ${i} ${"w".repeat(700)}`, created_at: "Wed Oct 01 00:00:00 +0000 2026", favorite_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0, bookmark_count: 0 },
			},
		},
	});
	const page = { data: { entries: [...Array.from({ length: 100 }, (_, i) => entry(i)), { cursorType: "Bottom", value: cursor }] } };
	const deps = fakeDeps({ graphql: () => page });
	const out = await runSearch(deps, { query: "x", limit: 100 });
	assert.ok(Buffer.byteLength(out.text) <= OUTPUT_BUDGET, `text was ${Buffer.byteLength(out.text)} bytes`);
	assert.ok(out.text.includes(`cursor "${cursor}"`));
	assert.match(out.text, /more omitted/);
});
