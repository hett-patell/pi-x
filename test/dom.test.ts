import assert from "node:assert/strict";
import { test } from "node:test";
import { domSearch, trendsFromDom, tweetFromDom, type DomTweet } from "../extensions/pi-x/dom.ts";

const d: DomTweet = {
	id: "5", handle: "alice", text: "Big news #AI @bob", lang: "en", time: "2026-10-01T10:00:00.000Z", verified: true,
	labels: { reply: "12 Antworten. Antworten", retweet: "1.234 Reposts", like: "12,5K Likes", bookmark: "Bookmark", views: "98.765 Mal angezeigt" },
	media: ["https://pbs.twimg.com/media/x.jpg"],
};

test("tweetFromDom parses locale-formatted counts", () => {
	const t = tweetFromDom(d);
	assert.deepEqual(t.metrics, { likes: 12500, retweets: 1234, replies: 12, quotes: 0, bookmarks: 0, views: 98765 });
	assert.deepEqual([t.url, t.hashtags, t.mentions, t.author.verified], ["https://x.com/alice/status/5", ["AI"], ["bob"], true]);
});

test("trendsFromDom", () => {
	const t = trendsFromDom([
		["UpstoxHaiTohBetterHai", "Upstox, helping traders get better", "Promoted by Upstox"],
		["1", "·", "Careers · Trending", "#XViralwithSahil"],
		["Politics · Trending", "#SHS2026", "12.3K posts"],
	]);
	assert.deepEqual(t.map((x) => [x.rank, x.name, x.promoted, x.volume]), [[0, "UpstoxHaiTohBetterHai", true, undefined], [1, "#XViralwithSahil", false, undefined], [2, "#SHS2026", false, 12300]]);
	const n = trendsFromDom([["Google DeepMind Unveils Gemini 4", "17 hours ago · News · 95K posts"]], true);
	assert.deepEqual([n[0].name, n[0].volume, n[0].is_news], ["Google DeepMind Unveils Gemini 4", 95000, true]);
});

test("domSearch scrolls until no new posts, then stops", async () => {
	const pages: DomTweet[][] = [[d], [d, { ...d, id: "6" }], [d, { ...d, id: "6" }], [d, { ...d, id: "6" }]];
	let opened = "";
	const deps = {
		engine: {
			dom: async <T>(_a: unknown, fn: string): Promise<T> => {
				if (fn === "classify") return { url: "", wall: false, locked: false, app: true, loggedIn: true } as T;
				if (fn === "count") return 1 as T;
				return (pages.shift() ?? []) as T;
			},
		},
		sessions: { open: async (_a: unknown, url: string) => { opened = url; }, scroll: async () => {} },
		sleep: async () => {},
	};
	const out = await domSearch(deps, { name: "a", enabled: true }, "ai agents", "Top", 50);
	assert.deepEqual(out.map((t) => t.id), ["5", "6"]);
	assert.equal(opened, "https://x.com/search?q=ai%20agents&src=typed_query&f=top");
});
