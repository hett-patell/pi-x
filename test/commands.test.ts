import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import { type CommandUI, completeArgs, footerText, parseCommand, runCommand } from "../extensions/pi-x/commands.ts";
import { loadConfig, profileFor } from "../extensions/pi-x/config.ts";
import { fakeDeps } from "./helpers.ts";

function ui(answers: { select?: string; confirm?: boolean; hasUI?: boolean } = {}) {
	const said: string[] = [];
	const levels: (string | undefined)[] = [];
	const u: CommandUI & { said: string[]; levels: (string | undefined)[]; status?: string } = {
		said, levels, hasUI: answers.hasUI ?? true,
		say: (t, level) => { said.push(t); levels.push(level); },
		select: async () => answers.select,
		confirm: async () => answers.confirm ?? true,
		setStatus: (t) => { u.status = t; },
	};
	return u;
}

test("parseCommand: verbs, empty → status, legacy aliases", () => {
	assert.deepEqual(parseCommand(""), { name: "status", args: [] });
	assert.deepEqual(parseCommand("  Login   het "), { name: "login", args: ["het"] });
	assert.deepEqual(parseCommand("account add burner"), { name: "add", args: ["burner"], legacyFrom: "account add burner" });
	assert.deepEqual(parseCommand("account noproxy het"), { name: "proxy", args: ["het", "off"], legacyFrom: "account noproxy het" });
	assert.deepEqual(parseCommand("state save het"), { name: "backup", args: ["het"], legacyFrom: "state save het" });
	assert.equal(parseCommand("setkey abc").name, "setkey");
});

test("completeArgs: subcommands, then account names", () => {
	assert.deepEqual(completeArgs("lo", ["default"])?.map((i) => i.value), ["login", "logout", "location"]);
	assert.deepEqual(completeArgs("login d", ["default", "het"]), [{ value: "login default", label: "default" }]);
	assert.deepEqual(completeArgs("use a", ["default"])?.map((i) => i.value), ["use auto"]);
	assert.ok(completeArgs("location ind", [])?.some((i) => i.value === "location India"));
	assert.equal(completeArgs("zzz", []), null);
});

test("add / use / disable / proxy / location / remove", async () => {
	const deps = fakeDeps();
	const u = ui();
	await runCommand("add burner", deps, u);
	assert.match(u.said.at(-1)!, /Added "burner".*\/x login burner/s);
	await runCommand("add Burner", deps, u);
	assert.match(u.said.at(-1)!, /already exists/);
	await runCommand("use burner", deps, u);
	assert.equal(loadConfig(deps.paths).config.active, "burner");
	await runCommand("use auto", deps, u);
	assert.equal(loadConfig(deps.paths).config.active, undefined);
	await runCommand("disable burner", deps, u);
	assert.equal(loadConfig(deps.paths).config.accounts[1].enabled, false);
	await runCommand("proxy burner http://u:pw@h:8080", deps, u);
	assert.match(u.said.at(-1)!, /http:\/\/\*\*\*:\*\*\*@h:8080/);
	assert.ok(!u.said.join("").includes("pw"));
	await runCommand("proxy burner ftp://x", deps, u);
	assert.match(u.said.at(-1)!, /http, https, socks4 or socks5/);
	await runCommand("location India", deps, u);
	assert.equal(loadConfig(deps.paths).config.trendsLocation, "India");
	await runCommand("location default", deps, u);
	assert.equal(loadConfig(deps.paths).config.trendsLocation, undefined);
	await runCommand("remove burner", deps, u);
	assert.deepEqual(loadConfig(deps.paths).config.accounts.map((a) => a.name), ["default"]);
	assert.ok(deps.calls.includes("close:burner"));
});

test("status shows accounts, hints, footer", async () => {
	const deps = fakeDeps({}, { version: 1, accounts: [{ name: "default", enabled: true, handle: "me" }, { name: "b", enabled: true }], active: "default" });
	const u = ui();
	await runCommand("status", deps, u);
	assert.match(u.said[0], /★ default\s+@me/);
	assert.match(u.said[0], /b\s+not connected/);
	assert.equal(u.status, "𝕏 1/2");
	assert.equal(footerText({ version: 1, accounts: [{ name: "a", enabled: true }] }), "𝕏 ⚠ /x login");
});

test("logout deletes only managed profiles after confirmation", async () => {
	const deps = fakeDeps({}, { version: 1, accounts: [{ name: "default", enabled: true, handle: "me" }] });
	const dir = profileFor(deps.paths, { name: "default", enabled: true });
	mkdirSync(dir, { recursive: true });
	await runCommand("logout default", deps, ui({ confirm: false }));
	assert.ok(existsSync(dir));
	await runCommand("logout default", deps, ui({ confirm: true }));
	assert.ok(!existsSync(dir));
	assert.equal(loadConfig(deps.paths).config.accounts[0].handle, undefined);
});

test("logout without a UI explains instead of returning silently", async () => {
	const deps = fakeDeps({}, { version: 1, accounts: [{ name: "default", enabled: true, handle: "me" }] });
	const dir = profileFor(deps.paths, { name: "default", enabled: true });
	mkdirSync(dir, { recursive: true });
	const u = ui({ hasUI: false });
	await runCommand("logout default", deps, u);
	assert.ok(existsSync(dir));
	assert.match(u.said.at(-1)!, /Logout needs interactive confirmation — run it in the Pi TUI/);
	assert.equal(u.levels.at(-1), "warning");
	assert.equal(loadConfig(deps.paths).config.accounts[0].handle, "me");
});

const tick = () => new Promise((r) => setTimeout(r, 10));

test("login opens headed browser and confirms the handle in the background", async () => {
	const deps = fakeDeps({ viewer: () => ({ id: "1", handle: "fresh" }), sessions: () => ["pix-default"] });
	const u = ui();
	await runCommand("login", deps, u);
	await new Promise((r) => setTimeout(r, 10));
	assert.match(u.said.join("\n"), /Opening X login for "default"/);
	assert.match(u.said.join("\n"), /✓ "default" connected as @fresh/);
	assert.equal(loadConfig(deps.paths).config.accounts[0].handle, "fresh");
});

test("removed SocialData commands explain themselves", async () => {
	const u = ui();
	await runCommand("setkey abc", fakeDeps(), u);
	assert.match(u.said[0], /SocialData support was removed/);
});

test("a second /x login cancels the first login watcher", async () => {
	let viewerCalls = 0;
	const deps = fakeDeps({ viewer: () => (viewerCalls++, { id: "1", handle: "fresh" }), sessions: () => ["pix-default"] });
	const wake: (() => void)[] = [];
	deps.sleep = () => new Promise<void>((r) => { wake.push(r); });
	const u = ui();
	await runCommand("login", deps, u);
	await runCommand("login", deps, u);
	await tick();
	for (const r of wake.splice(0)) r();
	await tick();
	assert.equal(viewerCalls, 1);
	assert.equal(u.said.filter((t) => /connected as @fresh/.test(t)).length, 1);
});

test("login watcher stops quietly when the login window was closed", async () => {
	let viewerCalls = 0;
	const deps = fakeDeps({ viewer: () => (viewerCalls++, null), sessions: () => [] });
	const u = ui();
	await runCommand("login", deps, u);
	await tick();
	assert.equal(viewerCalls, 0);
	assert.match(u.said.at(-1)!, /login window closed — run \/x login default to retry/i);
	assert.ok(!deps.calls.some((c) => c.startsWith("close:")) || deps.calls.filter((c) => c === "close:default").length === 1);
});

test("login watcher gives up after 5 minutes with a warning", async () => {
	let t = 0;
	let polls = 0;
	const deps = fakeDeps({ viewer: () => (polls++, null), sessions: () => ["pix-default"] });
	deps.now = () => (t += 60_000);
	const u = ui();
	await runCommand("login", deps, u);
	await tick();
	assert.ok(polls >= 1 && polls < 10, `polled ${polls} times`);
	assert.match(u.said.at(-1)!, /not detected within 5 minutes/);
	assert.equal(u.levels.at(-1), "warning");
});
