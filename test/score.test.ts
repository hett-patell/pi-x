import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tweet } from "../extensions/pi-x/normalize.ts";
import { buildQuery, collapseDuplicates, computeStats, engagementScore, scoreAll, sortTweets, validateFilters } from "../extensions/pi-x/score.ts";

function tw(id: string, over: Partial<Tweet> & { m?: Partial<Tweet["metrics"]>; h?: string } = {}): Tweet {
	return {
		id, url: `https://x.com/${over.h ?? "a"}/status/${id}`, text: over.text ?? `post ${id}`, created_at: over.created_at ?? "2026-10-01T10:00:00.000Z",
		lang: "en", author: { handle: over.h ?? "a", name: "A", verified: over.author?.verified ?? false },
		metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: 0, views: null, ...over.m },
		hashtags: over.hashtags ?? [], mentions: [], urls: over.urls ?? [], media: [],
	};
}

test("engagementScore", () => {
	assert.equal(engagementScore(tw("1", { m: { likes: 10, retweets: 2, quotes: 1, replies: 3, bookmarks: 1, views: 1000 } })), 31.5);
	assert.equal(engagementScore(tw("2")), 0);
});

test("sort + duplicates + stats", () => {
	const ts = scoreAll([
		tw("100", { h: "a", m: { likes: 5 }, created_at: "2026-10-01T10:00:00.000Z", hashtags: ["AI"], urls: ["https://www.example.com/x"] }),
		tw("101", { h: "b", m: { likes: 50, views: 900 }, created_at: "2026-10-01T12:00:00.000Z", hashtags: ["ai", "News"], author: { handle: "b", name: "B", verified: true } }),
		tw("102", { h: "c", m: { likes: 1 }, created_at: "2026-10-01T11:00:00.000Z", text: "Copy pasta text that is long enough https://t.co/x" }),
		tw("103", { h: "d", m: { likes: 2 }, created_at: "2026-10-01T11:30:00.000Z", text: "copy  pasta TEXT that is long enough!! https://t.co/y" }),
	]);
	assert.deepEqual(sortTweets(ts, "engagement").map((t) => t.id), ["101", "100", "103", "102"]);
	assert.deepEqual(sortTweets(ts, "recent").map((t) => t.id), ["101", "103", "102", "100"]);
	const { kept, duplicates } = collapseDuplicates(ts);
	assert.equal(duplicates, 1);
	assert.deepEqual(kept.map((t) => t.id).sort(), ["100", "101", "103"]);
	const s = computeStats(kept, duplicates);
	assert.equal(s.count, 3);
	assert.equal(s.from, "2026-10-01T10:00:00.000Z");
	assert.equal(s.to, "2026-10-01T12:00:00.000Z");
	assert.equal(s.hours, 2);
	assert.equal(s.per_hour, 1.5);
	assert.deepEqual(s.likes, { total: 57, median: 5 });
	assert.deepEqual(s.views, { total: 900, median: 900 });
	assert.equal(s.verified_share, 0.33);
	assert.equal(s.top_authors[0].handle, "b");
	assert.deepEqual(s.top_hashtags[0], { tag: "#ai", count: 2 });
	assert.deepEqual(s.top_domains, [{ domain: "example.com", count: 1 }]);
	assert.equal(s.top[0].id, "101");
	assert.equal(s.earliest_notable?.id, "100");
	assert.equal(computeStats([]).count, 0);
});

test("buildQuery compiles filters to X operators", () => {
	assert.equal(
		buildQuery("ai agents", { from: "@openai", since: "2026-09-01", lang: "en", min_likes: 100, has: ["video"], exclude: ["replies", "retweets"], verified_only: true }),
		"ai agents from:openai since:2026-09-01 lang:en min_faves:100 filter:videos -filter:replies -filter:retweets filter:blue_verified",
	);
	assert.equal(buildQuery("", { to: "jack", mentions: "@x", near: "Mumbai", within: "15km", min_replies: 3 }), 'to:jack @x min_replies:3 near:"Mumbai" within:15km');
});

test("validateFilters", () => {
	assert.equal(validateFilters({ since: "2026-09-01", within: "10mi", from: "a_b" }), null);
	assert.match(validateFilters({ since: "09/01/2026" }) ?? "", /YYYY-MM-DD/);
	assert.match(validateFilters({ within: "far" }) ?? "", /within/);
	assert.match(validateFilters({ from: "not a handle" }) ?? "", /handle/);
	assert.match(validateFilters({ lang: "english" }) ?? "", /lang/);
});
