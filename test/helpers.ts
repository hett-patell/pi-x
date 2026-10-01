import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountLocks, type CliResult } from "../extensions/pi-x/browser.ts";
import { paths, saveConfig, type Config } from "../extensions/pi-x/config.ts";
import type { ToolDeps } from "../extensions/pi-x/tools/context.ts";

export interface FakeHandlers {
	graphql?: (op: string, vars: Record<string, unknown>, account: string) => unknown;
	rest?: (path: string) => unknown;
	dom?: (fn: string) => unknown;
	viewer?: (account: string) => { id: string; handle: string } | null;
	fetch?: (url: string) => { status: number; body: string };
}

export function fakeDeps(h: FakeHandlers = {}, cfg?: Config): ToolDeps & { calls: string[] } {
	const p = paths(mkdtempSync(join(tmpdir(), "pix-")));
	saveConfig(p, cfg ?? { version: 1, accounts: [{ name: "default", enabled: true }] });
	const calls: string[] = [];
	const ok: CliResult = { ok: true, code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
	const deps: ToolDeps & { calls: string[] } = {
		calls,
		paths: p,
		engine: {
			rate: new Map(),
			graphql: async (a, op, vars) => { calls.push(`${a.name}:graphql:${op}`); return h.graphql!(op, vars, a.name); },
			rest: async (a, path) => { calls.push(`${a.name}:rest:${path}`); return h.rest!(path); },
			dom: async <T>(a: { name: string }, fn: string) => { calls.push(`${a.name}:dom:${fn}`); return h.dom!(fn) as T; },
			discover: async () => ({ ops: ["SearchTimeline", "TweetDetail", "UserByScreenName", "UserTweets", "ExplorePage", "GenericTimelineById", "Viewer"], bearer: true, ct0: true, error: null }),
			viewer: async (a) => (h.viewer ? h.viewer(a.name) : { id: "1", handle: "tester" }),
		},
		sessions: {
			ensure: async () => {}, open: async (_a, url) => { calls.push(`open:${url}`); }, scroll: async () => {}, launch: async () => {},
			close: async (a) => { calls.push(`close:${a.name}`); }, closeAll: async () => { calls.push("closeAll"); }, closeByName: async () => {},
			list: async () => [], saveState: async () => {}, loadState: async () => {},
		},
		locks: new AccountLocks(),
		runner: async () => ok,
		binary: { file: "/bin/agent-browser", prefixArgs: [] },
		fetchFn: (async (url: string) => {
			const r = h.fetch ? h.fetch(String(url)) : { status: 500, body: "" };
			return new Response(r.body, { status: r.status });
		}) as typeof fetch,
		sleep: async () => {},
		random: () => 0,
		now: () => 1_000_000,
		trendMemory: new Map(),
		placeCache: {},
	};
	return deps;
}
