import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { XError } from "../extensions/pi-x/errors.ts";
import { parseTweetId, runTweet } from "../extensions/pi-x/tools/tweet.ts";
import { parseUsername, runUser } from "../extensions/pi-x/tools/user.ts";
import { fakeDeps } from "./helpers.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");

test("parseTweetId / parseUsername", () => {
	assert.equal(parseTweetId("20"), "20");
	assert.equal(parseTweetId("https://x.com/jack/status/20?s=1"), "20");
	assert.equal(parseTweetId("https://twitter.com/i/web/status/20"), "20");
	assert.throws(() => parseTweetId("https://t.co/abc"), (e: XError) => e.code === "invalid_input");
	assert.equal(parseUsername("@OpenAI"), "OpenAI");
	assert.equal(parseUsername("https://x.com/OpenAI/with_replies"), "OpenAI");
	assert.throws(() => parseUsername("not a handle!"), /username/);
});

test("x_tweet without replies uses syndication and needs no account", async () => {
	const deps = fakeDeps({ fetch: (url) => { assert.match(url, /cdn\.syndication\.twimg\.com\/tweet-result\?id=20&token=/); return { status: 200, body: fx("syndication-20") }; } });
	const out = await runTweet(deps, { id_or_url: "https://x.com/jack/status/20" });
	assert.match(out.text, /@jack/);
	assert.match(out.text, /just setting up my twttr/);
	assert.equal(out.details.source, "syndication");
	assert.equal(deps.calls.length, 0);
});

test("x_tweet with replies uses TweetDetail, sorts replies by score", async () => {
	const deps = fakeDeps({ graphql: (op, v) => { assert.equal(op, "TweetDetail"); assert.equal(v.focalTweetId, "20"); return JSON.parse(fx("graphql-detail")); } });
	const out = await runTweet(deps, { id_or_url: "20", replies: 3 });
	const d = out.details as { replies: { author: { handle: string } }[]; thread: unknown[] };
	assert.equal(d.replies.length, 3);
	assert.equal(d.replies[0].author.handle, "lexfridman");
	assert.match(out.text, /Top replies/);
});

test("x_tweet falls back to the API when syndication fails, and reports not_found", async () => {
	const deps = fakeDeps({ fetch: () => ({ status: 404, body: "" }), graphql: () => ({ data: { threaded_conversation_with_injections_v2: { instructions: [] } } }) });
	await assert.rejects(runTweet(deps, { id_or_url: "123" }), (e: XError) => e.code === "not_found");
});

test("x_user returns profile and optional posts with stats", async () => {
	const deps = fakeDeps({ graphql: (op, v) => (op === "UserByScreenName" ? (assert.equal(v.screen_name, "OpenAI"), JSON.parse(fx("graphql-user"))) : (assert.equal(v.userId, "4398626122"), JSON.parse(fx("graphql-userTweets")))) });
	const out = await runUser(deps, { username: "@OpenAI", posts: 5 });
	assert.match(out.text, /^@OpenAI ✓ — OpenAI\nfollowers 5.4M/);
	assert.match(out.text, /Stats: 5 posts/);
	assert.equal((out.details.posts as unknown[]).length, 5);
	const none = fakeDeps({ graphql: () => ({ data: { user: {} } }) });
	await assert.rejects(runUser(none, { username: "ghost" }), (e: XError) => e.code === "not_found");
});
