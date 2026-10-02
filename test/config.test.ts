import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	defaultConfig, isManagedProfile, loadConfig, paths, profileFor, saveConfig, updateAccount, validateAccountName, validateConfig,
} from "../extensions/pi-x/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pix-"));

test("paths live under <agentDir>/pi-x", () => {
	const p = paths("/a");
	assert.equal(p.dataDir, join("/a", "pi-x"));
	assert.equal(p.configFile, join("/a", "pi-x", "config.json"));
	assert.equal(p.profilesDir, join("/a", "pi-x", "profiles"));
	assert.equal(p.stateDir, join("/a", "pi-x", "state"));
});

test("fresh load writes default config with 0600", () => {
	const p = paths(tmp());
	const r = loadConfig(p);
	assert.deepEqual(r.config, defaultConfig());
	assert.equal(r.migrated, false);
	assert.ok(existsSync(p.configFile));
	if (process.platform !== "win32") {
		assert.equal(statSync(p.configFile).mode & 0o777, 0o600);
		assert.equal(statSync(p.dataDir).mode & 0o777, 0o700);
	}
});

test("validateConfig drops junk, keeps valid fields, defaults enabled", () => {
	const c = validateConfig({
		accounts: [{ name: "a", proxy: "http://h:1", handle: "x", lastUsed: 5, junk: 1 }, { name: "b", enabled: false }],
		active: "b", trendsLocation: "India", socialdataApiKey: "zzz",
	});
	assert.deepEqual(c, {
		version: 1,
		accounts: [{ name: "a", enabled: true, proxy: "http://h:1", handle: "x", lastUsed: 5 }, { name: "b", enabled: false }],
		active: "b", trendsLocation: "India",
	});
	assert.throws(() => validateConfig({ accounts: [{ name: "a" }, { name: "A" }] }), /duplicate/);
	assert.throws(() => validateConfig({ accounts: [{ name: "bad name" }] }), /invalid name/);
	assert.deepEqual(validateConfig({ accounts: [] }).accounts, [{ name: "default", enabled: true }]);
	assert.equal(validateConfig({ accounts: [{ name: "a" }], active: "zzz" }).active, undefined);
});

test("corrupt config is backed up, not silently wiped", () => {
	const p = paths(tmp());
	mkdirSync(p.dataDir, { recursive: true });
	writeFileSync(p.configFile, "{not json");
	const r = loadConfig(p);
	assert.deepEqual(r.config, defaultConfig());
	assert.equal(r.warnings.length, 1);
	assert.ok(readdirSync(p.dataDir).some((f) => f.startsWith("config.json.bak-")));
});

test("legacy ~/.pi/x-insights.json is migrated once; key dropped; state copied 0600", () => {
	const home = tmp();
	const legacyDir = join(home, ".pi", "x-insights");
	mkdirSync(join(legacyDir, "profiles", "default"), { recursive: true });
	mkdirSync(join(legacyDir, "state"), { recursive: true });
	writeFileSync(join(legacyDir, "state", "default.json"), "{}", { mode: 0o664 });
	writeFileSync(join(home, ".pi", "x-insights.json"), JSON.stringify({
		socialdataApiKey: "secret", active: "default", loginMethod: "google",
		accounts: [{ name: "default", profile: join(legacyDir, "profiles", "default") }, { name: "het" }, { name: "chrome", profile: "Default", proxy: "http://u:p@h:1" }],
	}));
	const p = paths(tmp());
	const r = loadConfig(p, home);
	assert.equal(r.migrated, true);
	assert.deepEqual(r.config.accounts.map((a) => [a.name, a.profile]), [
		["default", join(legacyDir, "profiles", "default")],
		["het", undefined],
		["chrome", "Default"],
	]);
	assert.equal(r.config.active, "default");
	assert.ok(!readFileSync(p.configFile, "utf8").includes("secret"));
	assert.ok(r.warnings.some((w) => /SocialData/.test(w)));
	assert.ok(existsSync(join(p.stateDir, "default.json")));
	if (process.platform !== "win32") assert.equal(statSync(join(p.stateDir, "default.json")).mode & 0o777, 0o600);
	assert.equal(loadConfig(p, home).migrated, false);
});

test("env vars are never persisted", () => {
	const p = paths(tmp());
	process.env.SOCIALDATA_API_KEY = "envsecret";
	try {
		loadConfig(p);
		updateAccount(p, "default", { handle: "me" });
		assert.ok(!readFileSync(p.configFile, "utf8").includes("envsecret"));
	} finally {
		delete process.env.SOCIALDATA_API_KEY;
	}
});

test("updateAccount patches and persists; profileFor defaults to managed dir", () => {
	const p = paths(tmp());
	saveConfig(p, defaultConfig());
	const c = updateAccount(p, "DEFAULT", { handle: "me", lastUsed: 9 });
	assert.equal(c.accounts[0].handle, "me");
	assert.equal(loadConfig(p).config.accounts[0].lastUsed, 9);
	assert.equal(profileFor(p, { name: "x", enabled: true }), join(p.profilesDir, "x"));
	assert.equal(profileFor(p, { name: "x", enabled: true, profile: "Default" }), "Default");
});

test("validateAccountName", () => {
	assert.equal(validateAccountName("burner_1"), null);
	assert.match(validateAccountName("bad name") ?? "", /letters/);
	assert.match(validateAccountName("help") ?? "", /reserved/);
	assert.match(validateAccountName("Het", [{ name: "het", enabled: true }]) ?? "", /exists/);
});

test("isManagedProfile: only direct children of a managed profiles root", () => {
	const home = tmp();
	const p = paths(tmp());
	const at = (profile: string) => ({ name: "x", enabled: true, profile });
	const legacyRoot = join(home, ".pi", "x-insights", "profiles");
	assert.equal(isManagedProfile(p, { name: "x", enabled: true }), true);
	assert.equal(isManagedProfile(p, at(p.profilesDir)), false);
	assert.equal(isManagedProfile(p, at(join(p.profilesDir, "..", "profiles-old", "x"))), false);
	assert.equal(isManagedProfile(p, at(`${p.profilesDir}-old`)), false);
	assert.equal(isManagedProfile(p, at(join(p.profilesDir, "a"))), true);
	assert.equal(isManagedProfile(p, at(join(p.profilesDir, "a", "b"))), false);
	assert.equal(isManagedProfile(p, at("Default")), false);
	assert.equal(isManagedProfile(p, at(join(legacyRoot, "het")), home), true);
	assert.equal(isManagedProfile(p, at(join(legacyRoot, "het"))), false);
	assert.equal(isManagedProfile(p, at(legacyRoot), home), false);
	assert.equal(isManagedProfile(p, at(join("/elsewhere", ".pi", "x-insights", "profiles", "het")), home), false);
});
