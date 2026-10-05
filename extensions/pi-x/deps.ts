import { homedir } from "node:os";
import { AccountLocks, createLazyRunner, Sessions } from "./browser.ts";
import { paths } from "./config.ts";
import type { ToolDeps } from "./tools/context.ts";
import { abortableSleep } from "./util.ts";
import { Engine } from "./xapi.ts";

export function createDeps(agentDir: string, legacyHome: string = homedir()): ToolDeps {
	const p = paths(agentDir);
	const { runner, binary } = createLazyRunner();
	const sessions = new Sessions(runner, p);
	return {
		paths: p,
		legacyHome,
		engine: new Engine({ sessions }),
		sessions,
		locks: new AccountLocks(),
		runner,
		get binary() {
			return binary();
		},
		fetchFn: fetch,
		sleep: abortableSleep,
		random: Math.random,
		now: Date.now,
		trendMemory: new Map(),
		placeCache: {},
	};
}
