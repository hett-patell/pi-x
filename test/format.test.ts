import assert from "node:assert/strict";
import { test } from "node:test";
import { compact, fitToBudget, formatStats, formatTrends, formatTweet, formatUser, oneLine } from "../extensions/pi-x/format.ts";
import type { Tweet } from "../extensions/pi-x/normalize.ts";
import { computeStats, scoreAll } from "../extensions/pi-x/score.ts";

const t: Tweet = {
	id: "1", url: "https://x.com/a/status/1", text: "hello\n\nworld", created_at: "2026-10-01T10:05:00.000Z", lang: "en",
	author: { handle: "a", name: "A", verified: true }, metrics: { likes: 1234, retweets: 5, replies: 2, quotes: 0, bookmarks: 0, views: 120000 },
	hashtags: [], mentions: [], urls: [], media: [], score: 1253,
	quoted: { id: "2", url: "u", text: "inner", created_at: null, lang: null, author: { handle: "b", name: "B", verified: false }, metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: 0, views: null }, hashtags: [], mentions: [], urls: [], media: [] },
};

test("compact + oneLine", () => {
	assert.deepEqual([compact(999), compact(1234), compact(12_345), compact(1_900_000), compact(null)], ["999", "1.2K", "12K", "1.9M", "–"]);
	assert.equal(oneLine("a\n\n b   c"), "a b c");
	assert.equal(oneLine("abcdef", 4), "abc…");
});

test("formatTweet", () => {
	assert.equal(
		formatTweet(t, 1),
		"[1] @a ✓ · 2026-10-01 10:05 · ♥ 1.2K ⟲ 5 ↩ 2 · 120K views · score 1.3K\n    hello world\n    ↪ quoting @b: inner\n    https://x.com/a/status/1",
	);
});

test("fitToBudget drops items from the end and says so", () => {
	const items = Array.from({ length: 50 }, (_, i) => `item ${i} ${"x".repeat(100)}`);
	const r = fitToBudget("HEAD", items, 1000);
	assert.ok(Buffer.byteLength(r.text) <= 1000);
	assert.equal(r.shown + r.omitted, 50);
	assert.ok(r.omitted > 0);
	assert.match(r.text, /more omitted/);
	assert.equal(fitToBudget("H", ["a"], 1000).omitted, 0);
});

test("formatStats / formatTrends / formatUser", () => {
	const s = formatStats(computeStats(scoreAll([t])));
	assert.match(s, /1 posts/);
	assert.match(s, /likes 1.2K/);
	const tr = formatTrends("Trending", [{ rank: 1, name: "#AI", category: "Tech · Trending", volume: 96000, query: "#AI", is_news: false, promoted: false, new: true }]);
	assert.equal(tr, "Trending\n 1. #AI — Tech · Trending · 96K posts · NEW");
	assert.match(formatUser({ id: "1", handle: "OpenAI", name: "OpenAI", verified: true, followers: 5410550, following: 4, posts: 2162, bio: "mission" }), /@OpenAI ✓ — OpenAI\nfollowers 5.4M · following 4 · posts 2.2K/);
});
