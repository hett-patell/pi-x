import assert from "node:assert/strict";
import { test } from "node:test";
import { XError } from "../extensions/pi-x/errors.ts";
import type { PageResponse } from "../extensions/pi-x/page.ts";
import { classifyResponse, Engine } from "../extensions/pi-x/xapi.ts";

const acct = { name: "a", enabled: true };

function fakeSessions(replies: (PageResponse | Error)[]) {
	const log: string[] = [];
	return {
		log,
		ensure: async () => { log.push("ensure"); },
		invalidate: () => { log.push("invalidate"); },
		eval: async <T>(_a: unknown, script: string): Promise<T> => {
			log.push(script.slice(-60));
			const r = replies.shift();
			if (r instanceof Error) throw r;
			return r as T;
		},
	};
}

test("classifyResponse maps statuses and X error codes", () => {
	assert.equal(classifyResponse({ ok: true, status: 200, data: { data: {} } }), null);
	assert.equal(classifyResponse({ ok: false, status: 429 })?.code, "rate_limited");
	assert.equal(classifyResponse({ ok: false, status: 401 })?.code, "not_logged_in");
	assert.equal(classifyResponse({ ok: false, status: 404 })?.code, "api_changed");
	assert.equal(classifyResponse({ ok: false, status: 422, error: "must be defined" })?.code, "api_changed");
	assert.equal(classifyResponse({ ok: false, status: 0, error: "not_logged_in: no ct0 cookie" })?.code, "not_logged_in");
	assert.equal(classifyResponse({ ok: true, status: 200, data: { errors: [{ code: 88, message: "Rate limit exceeded" }] } })?.code, "rate_limited");
	assert.equal(classifyResponse({ ok: false, status: 403, data: { errors: [{ code: 326, message: "locked" }] } })?.code, "account_locked");
	assert.equal(classifyResponse({ ok: true, status: 200, data: { errors: [{ code: 50, message: "User not found." }] } })?.code, "not_found");
	assert.equal(classifyResponse({ ok: true, status: 200, data: { data: { x: 1 }, errors: [{ code: 37 }] } }), null);
});

test("Engine retries rate limits with backoff then succeeds; records rate headers", async () => {
	const s = fakeSessions([
		{ ok: false, status: 429 },
		{ ok: true, status: 200, data: { data: { v: 1 } }, rateLimit: { limit: 50, remaining: 3, reset: 99 } },
	]);
	const slept: number[] = [];
	const e = new Engine({ sessions: s, sleep: async (ms) => { slept.push(ms); }, random: () => 0.5 });
	assert.deepEqual(await e.graphql(acct, "SearchTimeline", {}), { data: { v: 1 } });
	assert.deepEqual(slept, [6000]);
	assert.deepEqual(e.rate.get("a:SearchTimeline"), { limit: 50, remaining: 3, reset: 99 });
});

test("Engine gives up after maxRetries", async () => {
	const s = fakeSessions([{ ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }]);
	const e = new Engine({ sessions: s, sleep: async () => {}, random: () => 0 });
	await assert.rejects(e.graphql(acct, "X", {}), (x: XError) => x.code === "rate_limited");
});

test("Engine relaunches once when the page script fails", async () => {
	const s = fakeSessions([new XError("network", "session closed"), { ok: true, status: 200, data: { data: 1 } }]);
	const e = new Engine({ sessions: s, sleep: async () => {} });
	assert.deepEqual(await e.rest(acct, "/i/api/1.1/x.json"), { data: 1 });
	assert.ok(s.log.includes("invalidate"));
});

test("viewer: null when page says logged out, handle when logged in", async () => {
	const out = new Engine({ sessions: fakeSessions([{ ok: true, status: 200, data: { url: "", wall: true, locked: false, app: true, loggedIn: false } }]) });
	assert.equal(await out.viewer(acct), null);
	const inn = new Engine({
		sessions: fakeSessions([
			{ ok: true, status: 200, data: { url: "", wall: false, locked: false, app: true, loggedIn: true } },
			{ ok: true, status: 200, data: { data: { viewer: { user_results: { result: { rest_id: "42", core: { screen_name: "me" } } } } } } },
		]),
	});
	assert.deepEqual(await inn.viewer(acct), { id: "42", handle: "me" });
});
