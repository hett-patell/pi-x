import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PAGE_RUNTIME, pageScript } from "../extensions/pi-x/page.ts";

const BEARER_ENC = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk";
const MAIN_JS =
	'x={queryId:"Q1",operationName:"SearchTimeline",operationType:"query",metadata:{featureSwitches:["f_a","f_b"],fieldToggles:["t_a"]}};' +
	'y={queryId:"Q2",operationName:"Viewer",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}};' +
	`z="${BEARER_ENC}";`;

type Reply = { status: number; body: string; headers?: Record<string, string> };
let calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
const savedFetch = globalThis.fetch;

function install(replies: Reply[], cookie = "ct0=CSRF; twid=u%3D1", mainJs = MAIN_JS) {
	calls = [];
	const g = globalThis as Record<string, unknown>;
	g.window = globalThis;
	delete g.__pix;
	g.document = {
		scripts: [{ src: "https://abs.twimg.com/responsive-web/client-web/vendor.1a.js" }, { src: "https://abs.twimg.com/responsive-web/client-web/main.abc123a.js" }],
		cookie,
		documentElement: { lang: "en" },
		querySelector: () => null,
		querySelectorAll: () => [],
	};
	g.location = { href: "https://x.com/home", origin: "https://x.com", pathname: "/home" };
	g.fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
		calls.push({ url, init });
		const resp = (status: number, body: string, headers?: Record<string, string>) => ({
			ok: status < 400,
			status,
			text: async () => body,
			headers: { get: (k: string) => headers?.[k] ?? null },
		});
		if (url.includes("main.")) return resp(200, mainJs);
		if (/\.js(?:[?#]|$)/.test(url)) return resp(200, ""); // other bundles carry no queryId entries
		const r: Reply = replies.shift() ?? { status: 500, body: "no reply" };
		return resp(r.status, r.body, r.headers);
	};
}

afterEach(() => {
	const g = globalThis as Record<string, unknown>;
	for (const k of ["window", "document", "location", "__pix"]) delete g[k];
	g.fetch = savedFetch;
});

// biome-ignore lint: indirect eval is the point — we run the exact string the browser gets
const run = (req: unknown) => (0, eval)(`(${PAGE_RUNTIME})`)(req) as Promise<Record<string, any>>;

test("runtime string is safe to embed", () => {
	assert.ok(!PAGE_RUNTIME.includes("${"));
	assert.ok(!PAGE_RUNTIME.includes("`"));
	assert.equal(pageScript({ kind: "discover" }), `(${PAGE_RUNTIME})({"kind":"discover"})`);
});

test("discover finds ops, bearer, ct0", async () => {
	install([]);
	const r = await run({ kind: "discover" });
	assert.equal(r.ok, true);
	assert.deepEqual(r.data, { ops: ["SearchTimeline", "Viewer"], bearer: true, ct0: true, error: null });
});

test("graphql GET sends features=true, toggles=false, csrf + bearer headers", async () => {
	install([{ status: 200, body: '{"data":{"ok":1}}', headers: { "x-rate-limit-remaining": "49", "x-rate-limit-limit": "50", "x-rate-limit-reset": "123" } }]);
	const r = await run({ kind: "graphql", op: "SearchTimeline", vars: { rawQuery: "ai" } });
	assert.deepEqual(r.data, { data: { ok: 1 } });
	assert.deepEqual(r.rateLimit, { limit: 50, remaining: 49, reset: 123 });
	const c = calls.find((x) => x.url.includes("/i/api/graphql/"))!;
	const u = new URL(c.url, "https://x.com");
	assert.equal(u.pathname, "/i/api/graphql/Q1/SearchTimeline");
	assert.deepEqual(JSON.parse(u.searchParams.get("features")!), { f_a: true, f_b: true });
	assert.deepEqual(JSON.parse(u.searchParams.get("fieldToggles")!), { t_a: false });
	assert.equal(c.init?.headers?.["x-csrf-token"], "CSRF");
	assert.equal(c.init?.headers?.authorization, `Bearer ${decodeURIComponent(BEARER_ENC)}`);
});

test("graphql POST puts everything in the body", async () => {
	install([{ status: 200, body: "{}" }]);
	await run({ kind: "graphql", op: "SearchTimeline", vars: { rawQuery: "ai" }, method: "POST" });
	const c = calls.find((x) => x.url.includes("/i/api/graphql/"))!;
	assert.equal(c.init?.method, "POST");
	assert.deepEqual(JSON.parse(c.init!.body!), { variables: { rawQuery: "ai" }, features: { f_a: true, f_b: true }, fieldToggles: { t_a: false }, queryId: "Q1" });
});

test("404 re-discovers once and retries", async () => {
	install([{ status: 404, body: "" }, { status: 200, body: '{"data":{}}' }]);
	const r = await run({ kind: "graphql", op: "Viewer", vars: {} });
	assert.equal(r.status, 200);
	assert.equal(calls.filter((c) => c.url.includes("main.")).length, 2);
});

test("missing op and missing ct0 produce coded errors", async () => {
	install([]);
	assert.match((await run({ kind: "graphql", op: "Nope", vars: {} })).error, /^api_changed:/);
	install([], "twid=u%3D1");
	const r = await run({ kind: "graphql", op: "Viewer", vars: {} });
	assert.equal(r.ok, false);
	assert.match(r.error, /^not_logged_in:/);
});

test("dm sends to a new conversation via recipient_ids", async () => {
	install([
		{ status: 200, body: '{"inbox_initial_state":{"conversations":{}}}' },
		{ status: 200, body: '{"conversation_id":"11-22"}' },
	]);
	const r = await run({ kind: "dm", recipientId: "999", text: "Hey" });
	assert.equal(r.ok, true);
	assert.equal(r.data.conversation_id, "11-22");
	const c = calls.find((x) => x.url.includes("/dm/new2.json"))!;
	assert.equal(c.init?.method, "POST");
	assert.deepEqual(JSON.parse(c.init!.body!), {
		text: "Hey",
		cards_platform: "Web-12",
		include_cards: 1,
		include_quote_count: true,
		dm_users: false,
		recipient_ids: "999",
	});
});

test("dm reuses an existing conversation id", async () => {
	install([
		{ status: 200, body: '{"inbox_initial_state":{"conversations":{"11-22":{"participants":[{"user_id":"999"}]}}}}' },
		{ status: 200, body: '{"ok":true}' },
	]);
	await run({ kind: "dm", recipientId: "999", text: "Hi" });
	const c = calls.find((x) => x.url.includes("/dm/new2.json"))!;
	assert.equal(JSON.parse(c.init!.body!).conversation_id, "11-22");
	assert.equal(JSON.parse(c.init!.body!).recipient_ids, false);
	assert.equal(JSON.parse(c.init!.body!).text, "Hi");
});

test("dom classify reports login state from cookies + path", async () => {
	install([]);
	const r = await run({ kind: "dom", fn: "classify" });
	assert.deepEqual(r.data, { url: "https://x.com/home", wall: false, locked: false, app: false, loggedIn: true });
});
