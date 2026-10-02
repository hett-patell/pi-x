import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountLocks, type BinarySpec, classifyCliError, createLazyRunner, resolveBinary, Sessions, sessionName, type CliResult, type RunOptions } from "../extensions/pi-x/browser.ts";
import { paths } from "../extensions/pi-x/config.ts";
import { createDeps } from "../extensions/pi-x/deps.ts";

const ok = (stdout = ""): CliResult => ({ ok: true, code: 0, stdout, stderr: "", timedOut: false, aborted: false });

function fakeRunner(reply: (args: string[]) => CliResult) {
	const calls: { args: string[]; opts?: RunOptions }[] = [];
	const run = async (args: string[], opts?: RunOptions) => {
		calls.push({ args, opts });
		return reply(args);
	};
	return { run, calls };
}

test("resolveBinary: unix PATH lookup and override", () => {
	const has = (set: string[]) => (p: string) => set.includes(p);
	assert.deepEqual(resolveBinary({ PATH: "/a:/b" }, "linux", has([join("/b", "agent-browser")])), { file: join("/b", "agent-browser"), prefixArgs: [] });
	assert.equal(resolveBinary({ PATH: "/a" }, "linux", has([])), null);
	assert.deepEqual(resolveBinary({ PATH: "/a", PI_X_AGENT_BROWSER: "/opt/ab" }, "linux", has(["/opt/ab"])), { file: "/opt/ab", prefixArgs: [] });
});

test("resolveBinary: windows prefers native exe behind the npm .cmd shim", () => {
	const dir = "C:\\npm";
	const native = join(dir, "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe");
	const files = [join(dir, "agent-browser.cmd"), native];
	assert.deepEqual(resolveBinary({ PATH: dir }, "win32", (p) => files.includes(p)), { file: native, prefixArgs: [] });
	const js = join(dir, "node_modules", "agent-browser", "bin", "agent-browser.js");
	assert.deepEqual(
		resolveBinary({ PATH: dir }, "win32", (p) => [join(dir, "agent-browser.cmd"), js].includes(p), "C:\\node.exe"),
		{ file: "C:\\node.exe", prefixArgs: [js] },
	);
});

test("AccountLocks serialize per account, parallel across accounts", async () => {
	const locks = new AccountLocks();
	const log: string[] = [];
	const job = (tag: string, ms: number) => async () => {
		log.push(`start ${tag}`);
		await new Promise((r) => setTimeout(r, ms));
		log.push(`end ${tag}`);
		return tag;
	};
	const results = await Promise.all([locks.run("a", job("a1", 20)), locks.run("A", job("a2", 1)), locks.run("b", job("b1", 1))]);
	assert.deepEqual(results, ["a1", "a2", "b1"]);
	assert.ok(log.indexOf("end a1") < log.indexOf("start a2"));
	assert.ok(log.indexOf("start b1") < log.indexOf("end a1"));
	await assert.rejects(locks.run("a", async () => { throw new Error("x"); }));
	assert.equal(await locks.run("a", async () => 1), 1);
});

test("Sessions.launch passes profile, anti-detect args, headed, proxy via env", async () => {
	const p = paths("/agent");
	const f = fakeRunner(() => ok());
	const s = new Sessions(f.run, p);
	await s.launch({ name: "Burner", enabled: true, proxy: "http://u:pw@h:1" }, { headed: true, url: "https://x.com/i/flow/login" });
	const c = f.calls[0];
	assert.deepEqual(c.args, ["--session", "pix-burner", "--profile", join(p.profilesDir, "Burner"), "--args", "--disable-blink-features=AutomationControlled", "--headed", "open", "https://x.com/i/flow/login"]);
	assert.deepEqual(c.opts?.env, { AGENT_BROWSER_PROXY: "http://u:pw@h:1" });
	assert.ok(!c.args.join(" ").includes("pw"));
	assert.equal(sessionName({ name: "Burner", enabled: true }), "pix-burner");
});

test("Sessions.ensure reuses a running session, navigating to x.com if needed", async () => {
	const f = fakeRunner((args) => {
		if (args[0] === "session") return ok(JSON.stringify({ success: true, data: { sessions: ["pix-a"] } }));
		if (args.includes("get")) return ok("about:blank");
		return ok();
	});
	const s = new Sessions(f.run, paths("/agent"));
	const a = { name: "a", enabled: true };
	await s.ensure(a);
	await s.ensure(a);
	assert.deepEqual(f.calls.map((c) => c.args.join(" ")), ["session list --json", "--session pix-a get url", "--session pix-a open https://x.com/home"]);
});

test("Sessions.eval parses the --json envelope and maps failures", async () => {
	const s1 = new Sessions(async () => ok(JSON.stringify({ success: true, data: { result: { n: 1 } }, error: null })), paths("/a"));
	assert.deepEqual(await s1.eval({ name: "a", enabled: true }, "1"), { n: 1 });
	const s2 = new Sessions(async () => ok(JSON.stringify({ success: false, data: null, error: "Executable doesn't exist at /x/chrome" })), paths("/a"));
	await assert.rejects(s2.eval({ name: "a", enabled: true }, "1"), (e: { code: string }) => e.code === "chrome_missing");
	const s3 = new Sessions(async () => ({ ok: false, code: null, stdout: "", stderr: "", timedOut: true, aborted: false }), paths("/a"));
	await assert.rejects(s3.eval({ name: "a", enabled: true }, "1"), (e: { code: string }) => e.code === "timeout");
});

test("classifyCliError", () => {
	assert.equal(classifyCliError("agent-browser CLI not found on PATH").code, "browser_missing");
	assert.equal(classifyCliError("Failed to create a ProcessSingleton for your profile directory").code, "profile_busy");
	assert.equal(classifyCliError("something else").code, "network");
});

test("closeAll only closes pix-* sessions", async () => {
	const f = fakeRunner((args) => (args[0] === "session" ? ok(JSON.stringify({ success: true, data: { sessions: ["pix-a", "work", "pix-b"] } })) : ok()));
	await new Sessions(f.run, paths("/a")).closeAll();
	assert.deepEqual(f.calls.slice(1).map((c) => c.args.join(" ")), ["--session pix-a close", "--session pix-b close"]);
});

test("createLazyRunner re-resolves agent-browser until found, then caches it", async () => {
	let spec: BinarySpec | null = null;
	let resolves = 0;
	const made: string[] = [];
	const lazy = createLazyRunner(
		() => { resolves++; return spec; },
		(s) => { made.push(s.file); return async (args) => ok(`${s.file} ${args.join(" ")}`); },
	);
	assert.equal(lazy.binary(), null);
	const missing = await lazy.runner(["--version"]);
	assert.equal(missing.ok, false);
	assert.match(missing.stderr, /agent-browser CLI not found/);
	spec = { file: "/new/agent-browser", prefixArgs: [] };
	const r = await lazy.runner(["--version"]);
	assert.deepEqual([r.ok, r.stdout], [true, "/new/agent-browser --version"]);
	assert.deepEqual(lazy.binary(), spec);
	const before = resolves;
	await lazy.runner(["x"]);
	assert.equal(resolves, before);
	assert.deepEqual(made, ["/new/agent-browser"]);
});

test("createDeps: deps.binary reflects an agent-browser installed after load", () => {
	const dir = mkdtempSync(join(tmpdir(), "pix-"));
	const saved = { PATH: process.env.PATH, PI_X_AGENT_BROWSER: process.env.PI_X_AGENT_BROWSER };
	try {
		process.env.PATH = "";
		delete process.env.PI_X_AGENT_BROWSER;
		const deps = createDeps(dir, dir);
		const current = () => deps.binary;
		assert.equal(current(), null);
		const bin = join(dir, "agent-browser");
		writeFileSync(bin, "");
		process.env.PI_X_AGENT_BROWSER = bin;
		assert.equal(current()?.file, bin);
	} finally {
		process.env.PATH = saved.PATH;
		if (saved.PI_X_AGENT_BROWSER === undefined) delete process.env.PI_X_AGENT_BROWSER;
		else process.env.PI_X_AGENT_BROWSER = saved.PI_X_AGENT_BROWSER;
	}
});
