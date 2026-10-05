import assert from "node:assert/strict";
import { test } from "node:test";
import { saveConfig, type Config } from "../extensions/pi-x/config.ts";
import { XError } from "../extensions/pi-x/errors.ts";
import { compareIds, parseDmInbox } from "../extensions/pi-x/normalize.ts";
import type { PageResponse } from "../extensions/pi-x/page.ts";
import { runDm, runDmInbox } from "../extensions/pi-x/tools/dm.ts";
import { Engine } from "../extensions/pi-x/xapi.ts";
import { fakeDeps } from "./helpers.ts";

const user = (id: string, handle: string) => ({ data: { user: { result: { rest_id: id, core: { screen_name: handle, name: handle } } } } });
const twoAccounts = (over: Partial<Config> = {}): Config => ({
	version: 1,
	accounts: [{ name: "a", enabled: true, handle: "alice" }, { name: "b", enabled: true, handle: "bob" }],
	write: true,
	...over,
});

test("x_dm and x_dm_inbox refuse while DM access is off", async () => {
	const deps = fakeDeps({}, { version: 1, accounts: [{ name: "a", enabled: true }] });
	await assert.rejects(runDm(deps, { to: "x", text: "hi" }, undefined, undefined, async () => true), (e: XError) => e.code === "write_disabled");
	await assert.rejects(runDmInbox(deps, {}), (e: XError) => e.code === "write_disabled");
	assert.deepEqual(deps.calls, []);
});

test("x_dm asks for confirmation; declining sends nothing", async () => {
	const deps = fakeDeps({ graphql: () => user("42", "target"), dm: () => ({ conversation_id: "1-42" }) }, twoAccounts());
	const asked: string[] = [];
	const out = await runDm(deps, { to: "@target", text: "hello" }, undefined, undefined, async (title, msg) => {
		asked.push(`${title} | ${msg}`);
		return false;
	});
	assert.deepEqual(asked, ["Send DM from @alice to @target? | hello"]);
	assert.equal(out.details.sent, false);
	assert.ok(!deps.calls.some((c) => c.includes(":dm:")));
});

test("x_dm sends once after approval and reports the conversation", async () => {
	const deps = fakeDeps({ graphql: () => user("42", "target"), dm: () => ({ conversation_id: "1-42" }) }, twoAccounts());
	const out = await runDm(deps, { to: "target", text: "hello" }, undefined, undefined, async () => true);
	assert.equal(out.details.sent, true);
	assert.equal(out.details.conversationId, "1-42");
	assert.deepEqual(deps.calls.filter((c) => c.includes(":dm:")), ["a:dm:42"]);
});

test("x_dm without a UI refuses unless --no-confirm was set", async () => {
	const deps = fakeDeps({ graphql: () => user("42", "target"), dm: () => ({}) }, twoAccounts());
	await assert.rejects(runDm(deps, { to: "target", text: "hi" }), (e: XError) => e.code === "write_disabled" && /confirmation/.test(e.message));
	assert.ok(!deps.calls.some((c) => c.includes(":dm:")));
	saveConfig(deps.paths, twoAccounts({ writeNoConfirm: true }));
	const out = await runDm(deps, { to: "target", text: "hi" });
	assert.equal(out.details.sent, true);
});

test("x_dm never rotates to another account when the send fails", async () => {
	const deps = fakeDeps(
		{
			graphql: () => user("42", "target"),
			dm: () => {
				throw new XError("rate_limited", "slow down");
			},
		},
		twoAccounts({ active: "b" }),
	);
	await assert.rejects(runDm(deps, { to: "target", text: "hi" }, undefined, undefined, async () => true), (e: XError) => e.code === "rate_limited");
	assert.deepEqual(deps.calls.filter((c) => c.includes(":dm:")), ["b:dm:42"]);
});

test("engine runs a DM exactly once: no re-run after a script failure, no rate-limit retry", async () => {
	const evals: string[] = [];
	const mk = (replies: (PageResponse | Error)[]) => ({
		ensure: async () => {},
		invalidate: () => {},
		eval: async <T>(_a: unknown, script: string): Promise<T> => {
			evals.push(script.includes('"kind":"dm"') ? "dm" : "other");
			const r = replies.shift();
			if (r instanceof Error) throw r;
			return r as T;
		},
	});
	const acct = { name: "a", enabled: true };
	const timedOut = new Engine({ sessions: mk([new XError("timeout", "page script timed out"), { ok: true, status: 200, data: {} }]), sleep: async () => {} });
	await assert.rejects(timedOut.dm(acct, "42", "hi"), (e: XError) => e.code === "timeout");
	assert.deepEqual(evals, ["dm"]);
	evals.length = 0;
	const limited = new Engine({ sessions: mk([{ ok: false, status: 429 }, { ok: true, status: 200, data: {} }]), sleep: async () => {} });
	await assert.rejects(limited.dm(acct, "42", "hi"), (e: XError) => e.code === "rate_limited");
	assert.deepEqual(evals, ["dm"]);
});

test("compareIds orders snowflakes by value across lengths", () => {
	assert.ok(compareIds("999", "1000") < 0);
	assert.ok(compareIds("1000", "999") > 0);
	assert.equal(compareIds("123", "123"), 0);
	assert.ok(compareIds("1801", "1900") < 0);
});

test("parseDmInbox uses numeric order for latest message and unread", () => {
	const inbox = {
		inbox_initial_state: {
			users: { "7": { screen_name: "friend", name: "Friend" } },
			conversations: { "1-7": { type: "ONE_TO_ONE", participants: [{ user_id: "1" }, { user_id: "7" }], last_read_event_id: "999" } },
			entries: [
				{ message: { id: "1000", conversation_id: "1-7", message_data: { text: "newer", sender_id: "7", time: "1700000000000" } } },
				{ message: { id: "999", conversation_id: "1-7", message_data: { text: "older", sender_id: "7", time: "1690000000000" } } },
			],
		},
	};
	const [c] = parseDmInbox(inbox, "1");
	assert.equal(c.last_text, "newer");
	assert.equal(c.unread, true);
});
