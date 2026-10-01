import { homedir } from "node:os";
import { AccountLocks, createRunner, missingRunner, resolveBinary, Sessions } from "./browser.ts";
import { paths } from "./config.ts";
import type { ToolDeps } from "./tools/context.ts";
import { abortableSleep } from "./util.ts";
import { Engine } from "./xapi.ts";

export function createDeps(agentDir: string, legacyHome: string = homedir()): ToolDeps & { sessionsImpl: Sessions } {
	const p = paths(agentDir);
	const binary = resolveBinary();
	const runner = binary ? createRunner(binary) : missingRunner;
	const sessions = new Sessions(runner, p);
	return {
		paths: p,
		legacyHome,
		engine: new Engine({ sessions }),
		sessions,
		sessionsImpl: sessions,
		locks: new AccountLocks(),
		runner,
		binary,
		fetchFn: fetch,
		sleep: abortableSleep,
		random: Math.random,
		now: Date.now,
		trendMemory: new Map(),
		placeCache: {},
	};
}
