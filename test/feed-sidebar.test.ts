import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedSidebarComponent, type FeedActions } from "../extensions/pi-x/tui/feed-sidebar.ts";
import type { Tweet } from "../extensions/pi-x/normalize.ts";
import { setCapabilities, getCapabilities } from "@earendil-works/pi-tui";
import { thumbUrl } from "../extensions/pi-x/tui/feed-sidebar.ts";

// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function mockTheme(): any {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		style: (text: string) => text,
		colors: {},
		appearance: "dark",
	};
}

function makeTweet(id: string, handle: string, text: string, likes = 0): Tweet {
	return {
		id,
		url: `https://x.com/${handle}/status/${id}`,
		text,
		created_at: new Date().toISOString(),
		lang: "en",
		author: { handle, name: handle, verified: false },
		metrics: { likes, retweets: 0, replies: 0, quotes: 0, bookmarks: 0, views: null },
		hashtags: [],
		mentions: [],
		urls: [],
		media: [],
	};
}

describe("FeedSidebarComponent", () => {
	it("renders loading state initially", () => {
		let rendered = false;
		const tui = { requestRender: () => { rendered = true; } };
		const actions: FeedActions = {
			loadFeed: () => new Promise(() => {}), // never resolves
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, actions, { refreshIntervalMs: 0 });
		const lines = component.render(50);
		assert.ok(lines.length > 0, "should render lines");
		assert.ok(lines.some((l) => l.includes("Loading")), "should show loading indicator");
		component.dispose();
	});

	it("renders tweets after load", async () => {
		let renderCount = 0;
		const tui = { requestRender: () => { renderCount++; } };
		const tweets = [
			makeTweet("1", "alice", "Hello world!", 42),
			makeTweet("2", "bob", "Testing feed sidebar", 10),
		];
		const actions: FeedActions = {
			loadFeed: async () => ({ tweets, accountLabel: "testuser" }),
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, actions, { refreshIntervalMs: 0 });
		// Wait for load
		await new Promise((r) => setTimeout(r, 50));
		const lines = component.render(50);
		assert.ok(lines.some((l) => l.includes("alice")), "should show first tweet author");
		assert.ok(lines.some((l) => l.includes("bob")), "should show second tweet author");
		assert.ok(lines.some((l) => l.includes("Feed")), "should show Feed header");
		assert.ok(lines.some((l) => l.includes("testuser")), "should show account label");
		component.dispose();
	});

	it("renders error state", async () => {
		const tui = { requestRender: () => {} };
		const actions: FeedActions = {
			loadFeed: async () => { throw new Error("Network fail"); },
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, actions, { refreshIntervalMs: 0 });
		await new Promise((r) => setTimeout(r, 50));
		const lines = component.render(50);
		assert.ok(lines.some((l) => l.includes("Network fail")), "should show error message");
		assert.ok(lines.some((l) => l.includes("retry")), "should show retry hint");
		component.dispose();
	});

	it("handles keyboard navigation", async () => {
		const tui = { requestRender: () => {} };
		const tweets = Array.from({ length: 10 }, (_, i) =>
			makeTweet(String(i + 1), `user${i}`, `Tweet ${i}`, i * 5),
		);
		const actions: FeedActions = {
			loadFeed: async () => ({ tweets, accountLabel: "nav_test" }),
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, actions, { refreshIntervalMs: 0 });
		await new Promise((r) => setTimeout(r, 50));

		// Navigate down
		component.handleInput("\x1b[B"); // down arrow
		component.handleInput("\x1b[B"); // down arrow
		const lines = component.render(50);
		// Should show 3/10 position indicator
		assert.ok(lines.some((l) => l.includes("3/10")), "should show position after navigation");
		component.dispose();
	});

	it("calls done on escape", async () => {
		let closed = false;
		const tui = { requestRender: () => {} };
		const actions: FeedActions = {
			loadFeed: async () => ({ tweets: [], accountLabel: "test" }),
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => { closed = true; }, actions, { refreshIntervalMs: 0 });
		await new Promise((r) => setTimeout(r, 50));
		component.handleInput("\x1b"); // escape
		assert.ok(closed, "should call done on escape");
	});

	it("renders empty state", async () => {
		const tui = { requestRender: () => {} };
		const actions: FeedActions = {
			loadFeed: async () => ({ tweets: [], accountLabel: "empty" }),
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, actions, { refreshIntervalMs: 0 });
		await new Promise((r) => setTimeout(r, 50));
		const lines = component.render(50);
		assert.ok(lines.some((l) => l.includes("No posts")), "should show empty state");
		component.dispose();
	});

	it("shows quoted tweets", async () => {
		const tui = { requestRender: () => {} };
		const quoted = makeTweet("99", "quoteduser", "Original post");
		const tweet: Tweet = { ...makeTweet("100", "quoter", "Check this out"), quoted };
		const actions: FeedActions = {
			loadFeed: async () => ({ tweets: [tweet], accountLabel: "qt" }),
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, actions, { refreshIntervalMs: 0 });
		await new Promise((r) => setTimeout(r, 50));
		const lines = component.render(60);
		assert.ok(lines.some((l) => l.includes("quoteduser")), "should show quoted tweet author");
		component.dispose();
	});

	it("shows retweet indicator", async () => {
		const tui = { requestRender: () => {} };
		const tweet: Tweet = { ...makeTweet("200", "original", "Some tweet"), retweeted_by: "retweeter" };
		const actions: FeedActions = {
			loadFeed: async () => ({ tweets: [tweet], accountLabel: "rt" }),
		};
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, actions, { refreshIntervalMs: 0 });
		await new Promise((r) => setTimeout(r, 50));
		const lines = component.render(60);
		assert.ok(lines.some((l) => l.includes("retweeter")), "should show retweeted_by user");
		component.dispose();
	});

	it("renders media as a kitty image once loaded", async () => {
		const prev = getCapabilities();
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const tui = { requestRender: () => {} };
			const tweet: Tweet = { ...makeTweet("300", "pics", "look"), media: ["https://pbs.twimg.com/media/ABC.jpg"] };
			const loaded: string[] = [];
			const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, {
				loadFeed: async () => ({ tweets: [tweet], accountLabel: "m" }),
			}, { refreshIntervalMs: 0, loadImage: async (u) => { loaded.push(u); return PNG; }, rows: () => 50 });
			await new Promise((r) => setTimeout(r, 20));
			component.render(60); // triggers image load
			await new Promise((r) => setTimeout(r, 20));
			const lines = component.render(60);
			assert.deepEqual(loaded, ["https://pbs.twimg.com/media/ABC.jpg"]);
			assert.ok(lines.some((l) => l.includes("\x1b_G")), "should emit a kitty graphics sequence");
			component.handleInput("m");
			assert.ok(!component.render(60).some((l) => l.includes("\x1b_G")), "m hides media");
			component.dispose();
		} finally {
			setCapabilities(prev);
		}
	});

	it("falls back to a media link without image support", async () => {
		const prev = getCapabilities();
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const tui = { requestRender: () => {} };
			const tweet: Tweet = { ...makeTweet("301", "pics", "look"), media: ["https://pbs.twimg.com/media/A.jpg", "https://pbs.twimg.com/media/B.jpg"] };
			const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, {
				loadFeed: async () => ({ tweets: [tweet], accountLabel: "m" }),
			}, { refreshIntervalMs: 0, loadImage: async () => { throw new Error("should not load"); } });
			await new Promise((r) => setTimeout(r, 20));
			const lines = component.render(60);
			assert.ok(lines.some((l) => l.includes("2 media")));
			component.dispose();
		} finally {
			setCapabilities(prev);
		}
	});

	it("thumbUrl requests a small PNG", () => {
		assert.equal(thumbUrl("https://pbs.twimg.com/media/HXj_xgSbwAEQG_1.jpg"), "https://pbs.twimg.com/media/HXj_xgSbwAEQG_1?format=png&name=240x240");
		assert.equal(thumbUrl("https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg?foo=1"), "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x?format=png&name=240x240");
	});

	it("a switches account and reloads", async () => {
		const tui = { requestRender: () => {} };
		let acct = "one";
		const component = new FeedSidebarComponent(tui, mockTheme(), () => {}, {
			loadFeed: async () => ({ tweets: [makeTweet("1", acct + "_poster", "hi")], accountLabel: acct }),
			switchAccount: () => { acct = "two"; return true; },
		}, { refreshIntervalMs: 0 });
		await new Promise((r) => setTimeout(r, 20));
		assert.ok(component.render(60).some((l) => l.includes("@one")));
		component.handleInput("a");
		await new Promise((r) => setTimeout(r, 20));
		const lines = component.render(60);
		assert.ok(lines.some((l) => l.includes("@two")), "header shows new account");
		assert.ok(lines.some((l) => l.includes("two_poster")), "feed reloaded for new account");
		component.dispose();
	});
});
