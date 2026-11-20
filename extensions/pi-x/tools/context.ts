import { accountList, findAccount, orderAccounts } from "../accounts.ts";
import type { AccountLocks, BinarySpec, Runner, Sessions } from "../browser.ts";
import { type Account, type Config, loadConfig, type Paths, updateAccount } from "../config.ts";
import { toXError, XError } from "../errors.ts";
import type { Place, TimelinePage, Tweet } from "../normalize.ts";
import type { Engine } from "../xapi.ts";

export type EngineLike = Pick<Engine, "graphql" | "rest" | "dom" | "discover" | "viewer" | "dm" | "dmInbox" | "dmConversation" | "rate">;
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

/** Ask the human to choose one option (ctx.ui.select). Absent when there is no interactive UI. */
export type PickAccount = (title: string, options: string[]) => Promise<string | undefined>;

/** Per-session account the user chose for personal tools (cleared by /x use). */
const chosen = new WeakMap<ToolDeps, string>();

export function forgetAccountChoice(deps: ToolDeps): void {
	chosen.delete(deps);
}

export function rememberedAccount(deps: ToolDeps): string | undefined {
	return chosen.get(deps);
}

/**
 * The account for personal data and actions — DMs, home feed, bookmarks, posting, likes.
 * Never rotated and never guessed: an explicit account (name or @handle); else the only connected
 * account; else the /x use pin; else the account chosen earlier this session; else ask the user.
 * Without a UI to ask, it fails and lists the accounts so the caller can pass one.
 */
/** Connected (enabled + logged-in) accounts, in config order. */
export function connectedAccounts(deps: ToolDeps): Account[] {
	return readConfig(deps).accounts.filter((a) => a.enabled && a.handle);
}

/** The connected account after `current` (wraps around), for in-overlay switching. */
export function nextAccount(deps: ToolDeps, current: string | undefined): Account | undefined {
	const list = connectedAccounts(deps);
	if (list.length < 2) return undefined;
	const i = list.findIndex((a) => a.name === current);
	return list[(i + 1) % list.length];
}

/**
 * opts.ask: interactive commands (/x feed, /x dm) ask again instead of silently reusing the
 * session's earlier choice, so the user can pick a different account each time.
 */
export async function personalAccount(
	deps: ToolDeps,
	requested: string | undefined,
	pick?: PickAccount,
	opts: { ask?: boolean } = {},
): Promise<Account> {
	const cfg = readConfig(deps);
	if (requested) {
		const a = findAccount(cfg, requested);
		if (!a) throw new XError("invalid_input", `Unknown X account "${requested}"`, `Your accounts: ${accountList(cfg)}`);
		if (!a.handle) throw new XError("not_logged_in", `Account "${a.name}" isn't connected`, `Run /x login ${a.name}`);
		return a;
	}
	const connected = cfg.accounts.filter((a) => a.enabled && a.handle);
	if (!connected.length) throw new XError("not_logged_in", "No connected X account", "Run /x login");
	if (connected.length === 1) return connected[0];
	const pinned = connected.find((a) => a.name === cfg.active);
	if (pinned) return pinned;
	const remembered = connected.find((a) => a.name === chosen.get(deps));
	if (remembered && !(opts.ask && pick)) return remembered;
	if (!pick) {
		throw new XError(
			"invalid_input",
			`${connected.length} X accounts are connected — which one?`,
			`Pass account: ${connected.map((a) => `"${a.name}" (@${a.handle})`).join(" or ")}, or pin one with /x use <account>`,
		);
	}
	const labels = connected.map((a) => `@${a.handle} (${a.name})`);
	const choice = await pick("Which X account? (remembered this session · /x use <account> to pin)", labels);
	const a = choice ? connected[labels.indexOf(choice)] : undefined;
	if (!a) throw new XError("aborted", "No X account chosen");
	chosen.set(deps, a.name);
	return a;
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
