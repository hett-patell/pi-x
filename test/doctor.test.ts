import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConfig } from "../extensions/pi-x/config.ts";
import { XError } from "../extensions/pi-x/errors.ts";
import { REQUIRED_OPS, runDoctor } from "../extensions/pi-x/tools/doctor.ts";
import type { DiscoverInfo } from "../extensions/pi-x/page.ts";
import { fakeDeps } from "./helpers.ts";

const synd = readFileSync(new URL("./fixtures/syndication-20.json", import.meta.url), "utf8");

test("doctor: healthy setup reports api engine, saves handle, masks proxy", async () => {
	const deps = fakeDeps({ fetch: () => ({ status: 200, body: synd }), viewer: (n) => (n === "a" ? { id: "1", handle: "alice" } : null) }, {
		version: 1,
		accounts: [{ name: "a", enabled: true, proxy: "http://u:secret@h:1" }, { name: "b", enabled: true }, { name: "c", enabled: false }],
	});
	deps.runner = async (args) => ({ ok: true, code: 0, stdout: args[0] === "--version" ? "agent-browser 0.33.2" : "", stderr: "", timedOut: false, aborted: false });
	const out = await runDoctor(deps);
	const r = out.details as { engine: string; accounts: { name: string; logged_in: boolean | null; proxy?: string }[]; api: { ok: boolean } };
	assert.equal(r.engine, "api");
	assert.deepEqual(r.accounts.map((a) => [a.name, a.logged_in]), [["a", true], ["b", false], ["c", null]]);
	assert.equal(r.accounts[0].proxy, "http://***:***@h:1");
	assert.ok(!out.text.includes("secret"));
	assert.match(out.text, /✓ agent-browser 0\.33\.2/);
	assert.match(out.text, /✗ b — not logged in → \/x login b/);
	assert.equal(loadConfig(deps.paths).config.accounts[0].handle, "alice");
});

test("doctor: missing binary and no logged-in accounts", async () => {
	const deps = fakeDeps({ fetch: () => ({ status: 200, body: synd }), viewer: () => { throw new XError("browser_missing", "agent-browser CLI not found on PATH"); } });
	deps.binary = null;
	const out = await runDoctor(deps);
	assert.equal((out.details as { engine: string }).engine, "none");
	assert.match(out.text, /✗ agent-browser not found/);
	assert.match(out.text, /npm i -g agent-browser/);
});

test("doctor: logged in but discover returns undefined (guard against page script failure)", async () => {
	const deps = fakeDeps({ fetch: () => ({ status: 200, body: synd }), viewer: (n) => (n === "a" ? { id: "1", handle: "alice" } : null) }, {
		version: 1,
		accounts: [{ name: "a", enabled: true }],
	});
	deps.engine.discover = async () => undefined as unknown as DiscoverInfo;
	const out = await runDoctor(deps);
	const r = out.details as { engine: string; api: { ok: boolean; ops_found: number; missing: string[]; bearer: boolean } | null };
	assert.equal(r.engine, "dom");
	assert.deepEqual(r.api, { ok: false, ops_found: 0, missing: REQUIRED_OPS, bearer: false });
});
