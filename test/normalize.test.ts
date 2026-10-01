import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	keywordQuery, matchLocation, parseCompact, parseConversation, parseExploreTabs, parsePlaceTrends, parseTimeline,
	parseTrendTimeline, parseUser, tweetFromResult, tweetFromSyndication, type Place,
} from "../extensions/pi-x/normalize.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));

test("parseCompact is locale-tolerant", () => {
	const cases: [string, number | undefined][] = [
		["96K posts", 96_000], ["1.9M posts", 1_900_000], ["983 posts", 983], ["4K", 4000],
		["1,234 Likes. Like", 1234], ["1.234 Gefällt mir", 1234], ["12 345 J’aime", 12345], ["12,5 K", 12500],
		["132937 views", 132937], ["Like", undefined], ["", undefined],
	];
	for (const [s, n] of cases) assert.equal(parseCompact(s), n, s);
});

test("search timeline → tweets + bottom cursor (note_tweet text, views, no promoted)", () => {
	const { tweets, cursor } = parseTimeline(fx("graphql-search"));
	assert.equal(tweets.length, 5);
	const t = tweets[0];
	assert.equal(t.id, "2105624247498662382");
	assert.equal(t.author.handle, "kucchi09");
	assert.deepEqual(t.metrics, { likes: 72, retweets: 6, replies: 12, quotes: t.metrics.quotes, bookmarks: t.metrics.bookmarks, views: 2316 });
	assert.match(t.text, /^hi we are hiring/);
	assert.equal(t.url, "https://x.com/kucchi09/status/2105624247498662382");
	assert.match(t.created_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
	assert.ok(cursor?.startsWith("DAACCgACHTjI87fAJxAK"));
	assert.equal(tweets[3].author.handle, "OpenAI");
});

test("conversation splits focal / thread / replies", () => {
	const c = parseConversation(fx("graphql-detail"), "20");
	assert.equal(c.focal?.author.handle, "jack");
	assert.equal(c.focal?.text, "just setting up my twttr");
	assert.equal(c.focal?.metrics.likes, 309010);
	assert.equal(c.focal?.metrics.views, null);
	assert.equal(c.thread.length, 0);
	assert.equal(c.ancestors.length, 0);
	assert.equal(c.replies.length, 6);
	assert.equal(c.replies[0].author.handle, "lexfridman");
	assert.ok(c.cursor);
});

test("user timeline", () => {
	const { tweets, cursor } = parseTimeline(fx("graphql-userTweets"));
	assert.equal(tweets.length, 9);
	assert.ok(tweets.every((t) => t.author.handle === "OpenAI"));
	assert.ok(cursor);
});

test("user profile from new-style payload (core/relationship_counts)", () => {
	const u = parseUser(fx("graphql-user"));
	assert.deepEqual(
		{ id: u?.id, handle: u?.handle, verified: u?.verified, followers: u?.followers, following: u?.following, posts: u?.posts, url: u?.url },
		{ id: "4398626122", handle: "OpenAI", verified: true, followers: 5410550, following: 4, posts: 2162, url: "https://openai.com" },
	);
	assert.match(u?.bio ?? "", /mission/);
	assert.equal(parseUser({ data: { user: {} } }), null);
});

test("TweetResultByRestId + syndication", () => {
	const t = tweetFromResult(fx("graphql-tweet-by-id").data.tweetResult.result);
	assert.equal(t?.text, "just setting up my twttr");
	const s = tweetFromSyndication(fx("syndication-20"));
	assert.equal(s?.id, "20");
	assert.equal(s?.author.handle, "jack");
	assert.equal(s?.metrics.likes, 309010);
	assert.equal(s?.metrics.replies, 18065);
	assert.equal(s?.created_at, "2006-03-21T20:50:14.000Z");
	assert.equal(tweetFromSyndication({}), null);
});

test("trending tab: promoted flagged and unranked, queries from deep links", () => {
	const t = parseTrendTimeline(fx("graphql-trending"));
	assert.equal(t.length, 7);
	assert.equal(t[0].promoted, true);
	assert.equal(t[0].rank, 0);
	assert.deepEqual([t[1].rank, t[1].name, t[1].category, t[1].query], [1, "#HunkkaarTheRoar", "Trending in India", "#HunkkaarTheRoar"]);
	assert.equal(t[6].query, '"Punjab Congress"');
	assert.equal(t[6].is_news, false);
});

test("news tab: AI stories with age, category, volume", () => {
	const n = parseTrendTimeline(fx("graphql-news"));
	const g = n[0];
	assert.deepEqual([g.name, g.is_news, g.age, g.category, g.volume], ["Google DeepMind Unveils Gemini 4 Argon for Real-World AI Tasks", true, "17 hours ago", "News", 96000]);
	assert.equal(n[1].volume, 1_900_000);
	assert.equal(n[5].name, "Mossad");
	assert.equal(n[5].is_news, false);
	assert.equal(keywordQuery(g.name), "Google DeepMind Unveils Gemini Real-World");
});

test("explore tabs + v1.1 place trends", () => {
	const tabs = parseExploreTabs(fx("graphql-explore"));
	assert.equal(tabs.trending, "VGltZWxpbmU6DAC2CwABAAAACHRyZW5kaW5nAAA=");
	assert.equal(tabs.news, "VGltZWxpbmU6DAC2CwABAAAABG5ld3MAAA==");
	const p = parsePlaceTrends(fx("v11-trends-place"));
	assert.equal(p.location, "Worldwide");
	assert.deepEqual([p.trends[0].rank, p.trends[0].name, p.trends[0].query], [1, "エマちゃん", "エマちゃん"]);
	assert.equal(p.trends[2].query, "#STARスター");
});

test("matchLocation", () => {
	const places = fx("v11-trends-available") as Place[];
	const w = (q: string) => matchLocation(places, q)?.woeid;
	assert.equal(w("worldwide"), 1);
	assert.equal(w("global"), 1);
	assert.equal(w("India"), 23424848);
	assert.equal(w("us"), 23424977);
	assert.equal(w("GB"), 23424975);
	assert.equal(w("lon"), 44418);
	assert.equal(w("2295411"), 2295411);
	assert.equal(matchLocation(places, "atlantis"), null);
});
