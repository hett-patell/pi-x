import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Account, Paths } from "./config.ts";
import { profileFor } from "./config.ts";
import { XError } from "./errors.ts";

export interface BinarySpec {
	file: string;
	prefixArgs: string[];
}

export interface CliResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export interface RunOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string>;
}

export type Runner = (args: string[], opts?: RunOptions) => Promise<CliResult>;

/**
 * Locate agent-browser without ever needing a shell. On Windows, npm installs a `.cmd` shim that
 * execFile cannot run; we run the native exe (or the JS launcher via node) that sits behind it.
 */
export function resolveBinary(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (p: string) => boolean = existsSync,
	execPath: string = process.execPath,
): BinarySpec | null {
	if (env.PI_X_AGENT_BROWSER && exists(env.PI_X_AGENT_BROWSER)) return { file: env.PI_X_AGENT_BROWSER, prefixArgs: [] };
	const win = platform === "win32";
	for (const dir of (env.PATH ?? env.Path ?? "").split(win ? ";" : ":")) {
		if (!dir) continue;
		if (!win) {
			const c = join(dir, "agent-browser");
			if (exists(c)) return { file: c, prefixArgs: [] };
			continue;
		}
		const exe = join(dir, "agent-browser.exe");
		if (exists(exe)) return { file: exe, prefixArgs: [] };
		if (exists(join(dir, "agent-browser.cmd"))) {
			const bin = join(dir, "node_modules", "agent-browser", "bin");
			const native = join(bin, "agent-browser-win32-x64.exe");
			if (exists(native)) return { file: native, prefixArgs: [] };
			const js = join(bin, "agent-browser.js");
			if (exists(js)) return { file: execPath, prefixArgs: [js] };
		}
	}
	return null;
}

export function createRunner(spec: BinarySpec): Runner {
	return (args, opts = {}) =>
		new Promise((resolve) => {
			execFile(
				spec.file,
				[...spec.prefixArgs, ...args],
				{
					timeout: opts.timeoutMs ?? 30_000,
					maxBuffer: 32 * 1024 * 1024,
					signal: opts.signal,
					env: { ...process.env, ...opts.env },
					windowsHide: true,
				},
				(err, stdout, stderr) => {
					const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
					const aborted = Boolean(opts.signal?.aborted);
					resolve({
						ok: !e,
						code: e ? (typeof e.code === "number" ? e.code : null) : 0,
						stdout: String(stdout ?? "").trim(),
						stderr: String(stderr ?? "").trim(),
						timedOut: Boolean(e?.killed) && !aborted,
						aborted,
					});
				},
			);
		});
}

export const missingRunner: Runner = async () => ({
	ok: false,
	code: null,
	stdout: "",
	stderr: "agent-browser CLI not found on PATH",
	timedOut: false,
	aborted: false,
});

/**
 * Runner that keeps looking for agent-browser until it is installed (no Pi restart needed),
 * then caches the binary. `binary()` reports the current state.
 */
export function createLazyRunner(
	resolve: () => BinarySpec | null = resolveBinary,
	make: (spec: BinarySpec) => Runner = createRunner,
): { runner: Runner; binary: () => BinarySpec | null } {
	let spec: BinarySpec | null = null;
	let inner: Runner = missingRunner;
	const binary = () => {
		if (!spec) {
			spec = resolve();
			if (spec) inner = make(spec);
		}
		return spec;
	};
	const runner: Runner = (args, opts) => (binary() ? inner(args, opts) : missingRunner(args, opts));
	return { runner, binary };
}

export function classifyCliError(msg: string): XError {
	if (/agent-browser CLI not found/i.test(msg)) return new XError("browser_missing", msg);
	if (/ProcessSingleton|SingletonLock|profile (is )?(already )?in use|user data directory is already in use/i.test(msg)) {
		return new XError("profile_busy", msg);
	}
	if (/executable doesn't exist|browser.*not (found|installed)|chrom(e|ium).*not (found|installed)|run .*agent-browser install/i.test(msg)) {
		return new XError("chrome_missing", msg);
	}
	if (/timed? ?out/i.test(msg)) return new XError("timeout", msg);
	return new XError("network", msg);
}

export function check(r: CliResult, what: string): void {
	if (r.ok) return;
	if (r.aborted) throw new XError("aborted", `Cancelled while trying to ${what}`);
	if (r.timedOut) throw new XError("timeout", `Timed out trying to ${what}`);
	throw classifyCliError(r.stderr || r.stdout || `agent-browser exited with code ${r.code} while trying to ${what}`);
}

/** In-process mutex per account: concurrent tool calls on one browser session queue up. */
export class AccountLocks {
	private tails = new Map<string, Promise<unknown>>();

	run<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const key = name.toLowerCase();
		const prev = this.tails.get(key) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(fn);
		this.tails.set(key, next);
		const cleanup = () => {
			if (this.tails.get(key) === next) this.tails.delete(key);
		};
		next.then(cleanup, cleanup);
		return next;
	}
}

export const SESSION_PREFIX = "pix-";
const ANTI_DETECT = ["--args", "--disable-blink-features=AutomationControlled"];

export function sessionName(a: Account): string {
	return SESSION_PREFIX + a.name.toLowerCase();
}

export class Sessions {
	private runner: Runner;
	private paths: Paths;
	private ready = new Set<string>();

	constructor(runner: Runner, p: Paths) {
		this.runner = runner;
		this.paths = p;
	}

	async list(signal?: AbortSignal): Promise<string[]> {
		const r = await this.runner(["session", "list", "--json"], { timeoutMs: 10_000, signal });
		if (!r.ok) check(r, "list browser sessions");
		try {
			const j = JSON.parse(r.stdout) as { data?: { sessions?: unknown } };
			return Array.isArray(j.data?.sessions) ? (j.data.sessions as string[]) : [];
		} catch {
			return [];
		}
	}

	async launch(a: Account, opts: { headed?: boolean; url?: string; signal?: AbortSignal } = {}): Promise<void> {
		const s = sessionName(a);
		const args = ["--session", s, "--profile", profileFor(this.paths, a), ...ANTI_DETECT];
		if (opts.headed) args.push("--headed");
		args.push("open", opts.url ?? "https://x.com/home");
		const r = await this.runner(args, {
			timeoutMs: 60_000,
			signal: opts.signal,
			env: a.proxy ? { AGENT_BROWSER_PROXY: a.proxy } : undefined,
		});
		check(r, "launch the browser");
		this.ready.add(s);
	}

	/** Make sure the account's session is running and on x.com. Cheap after the first call. */
	async ensure(a: Account, signal?: AbortSignal): Promise<void> {
		const s = sessionName(a);
		if (this.ready.has(s)) return;
		if ((await this.list(signal)).includes(s)) {
			const url = await this.currentUrl(a, signal);
			if (!/^https:\/\/(x|twitter)\.com\//.test(url)) await this.open(a, "https://x.com/home", signal);
			this.ready.add(s);
			return;
		}
		await this.launch(a, { signal });
	}

	async open(a: Account, url: string, signal?: AbortSignal): Promise<void> {
		check(await this.runner(["--session", sessionName(a), "open", url], { timeoutMs: 45_000, signal }), "open a page");
	}

	async currentUrl(a: Account, signal?: AbortSignal): Promise<string> {
		const r = await this.runner(["--session", sessionName(a), "get", "url"], { timeoutMs: 10_000, signal });
		return r.ok ? r.stdout : "";
	}

	async eval<T>(a: Account, script: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
		const r = await this.runner(["--session", sessionName(a), "--json", "eval", script], {
			timeoutMs: opts.timeoutMs ?? 45_000,
			signal: opts.signal,
		});
		if (!r.ok && !r.stdout) check(r, "run a page script");
		let env: { success?: boolean; data?: { result?: unknown } | null; error?: string | null };
		try {
			env = JSON.parse(r.stdout);
		} catch {
			check(r, "run a page script");
			throw new XError("dom_changed", `agent-browser returned non-JSON output: ${r.stdout.slice(0, 200)}`);
		}
		if (!env.success) throw classifyCliError(env.error ?? "page script failed");
		return env.data?.result as T;
	}

	async scroll(a: Account, px: number, signal?: AbortSignal): Promise<void> {
		await this.runner(["--session", sessionName(a), "scroll", "down", String(px)], { timeoutMs: 15_000, signal });
	}

	async saveState(a: Account, file: string, signal?: AbortSignal): Promise<void> {
		check(await this.runner(["--session", sessionName(a), "state", "save", file], { timeoutMs: 20_000, signal }), "save login state");
	}

	async loadState(a: Account, file: string, signal?: AbortSignal): Promise<void> {
		check(await this.runner(["--session", sessionName(a), "state", "load", file], { timeoutMs: 20_000, signal }), "restore login state");
	}

	invalidate(a: Account): void {
		this.ready.delete(sessionName(a));
	}

	async close(a: Account): Promise<void> {
		await this.closeByName(sessionName(a));
	}

	async closeByName(name: string): Promise<void> {
		this.ready.delete(name);
		await this.runner(["--session", name, "close"], { timeoutMs: 15_000 });
	}

	async closeAll(): Promise<void> {
		for (const s of await this.list().catch(() => [] as string[])) if (s.startsWith(SESSION_PREFIX)) await this.closeByName(s);
		this.ready.clear();
	}
}
