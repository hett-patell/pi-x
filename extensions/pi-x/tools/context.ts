import { orderAccounts } from "../accounts.ts";
import type { AccountLocks, BinarySpec, Runner, Sessions } from "../browser.ts";
import { type Account, type Config, loadConfig, type Paths, updateAccount } from "../config.ts";
import { toXError, XError } from "../errors.ts";
import type { Place, TimelinePage, Tweet } from "../normalize.ts";
import type { Engine } from "../xapi.ts";

export type EngineLike = Pick<Engine, "graphql" | "rest" | "dom" | "discover" | "viewer" | "rate">;
export type SessionsLike = Pick<Sessions, "ensure" | "open" | "scroll" | "launch" | "close" | "closeAll" | "closeByName" | "list" | "saveState" | "loadState">;

export interface ToolDeps {
	paths: Paths;
	legacyHome?: string;
	engine: EngineLike;
	sessions: SessionsLike;
	locks: AccountLocks;
	runner: Runner;
	binary: BinarySpec | null;
	fetchFn: typeof fetch;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	random: () => number;
	now: () => number;
	trendMemory: Map<string, Set<string>>;
	placeCache: { places?: Place[] };
}

export interface ToolOutput {
	text: string;
	details: Record<string, unknown>;
	isError?: boolean;
}

export type Progress = (msg: string) => void;

export function readConfig(deps: ToolDeps): Config {
	return loadConfig(deps.paths, deps.legacyHome).config;
}

/** Run fn on the best account; rotate to the next one on account-level failures. */
export async function withAccount<T>(
	deps: ToolDeps,
	requested: string | undefined,
	signal: AbortSignal | undefined,
	fn: (a: Account) => Promise<T>,
): Promise<{ value: T; account: Account; skipped: string[] }> {
	const order = orderAccounts(readConfig(deps), requested);
	const skipped: string[] = [];
	let last: XError | null = null;
	for (const a of order) {
		if (signal?.aborted) throw new XError("aborted", "Cancelled");
		try {
			const value = await deps.locks.run(a.name, () => fn(a));
			updateAccount(deps.paths, a.name, { lastUsed: deps.now() });
			return { value, account: a, skipped };
		} catch (e) {
			const x = toXError(e);
			if (requested || !x.rotatable) throw x;
			skipped.push(`${a.name}: ${x.code}`);
			last = x;
		}
	}
	throw new XError(last?.code ?? "not_logged_in", `No X account could complete the request (${skipped.join("; ")})`, last?.fix);
}

export async function paginate(
	fetchPage: (cursor: string | null) => Promise<TimelinePage>,
	limit: number,
	opts: { signal?: AbortSignal; progress?: Progress; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; random: () => number; label: string; cursor?: string | null },
): Promise<{ tweets: Tweet[]; cursor: string | null }> {
	const out: Tweet[] = [];
	const seen = new Set<string>();
	let cursor: string | null = opts.cursor ?? null;
	let empty = 0;
	for (let page = 1; out.length < limit; page++) {
		if (opts.signal?.aborted) throw new XError("aborted", "Cancelled");
		const res = await fetchPage(cursor);
		let added = 0;
		for (const t of res.tweets) {
			if (!seen.has(t.id)) {
				seen.add(t.id);
				out.push(t);
				added++;
			}
		}
		opts.progress?.(`${opts.label}: page ${page}, ${out.length} posts`);
		if (!res.cursor || res.cursor === cursor) {
			cursor = null;
			break;
		}
		cursor = res.cursor;
		empty = added ? 0 : empty + 1;
		if (empty >= 3) break;
		if (out.length < limit) await opts.sleep(1500 + opts.random() * 1000, opts.signal);
	}
	return { tweets: out.slice(0, limit), cursor };
}

export function errorOutput(e: unknown): ToolOutput {
	const x = toXError(e);
	return { text: `✗ ${x.code}: ${x.message}\n→ ${x.fix}`, details: { error: x.toJSON() }, isError: true };
}
