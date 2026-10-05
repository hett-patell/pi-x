import type { Account } from "./config.ts";
import { XError, type XErrorCode } from "./errors.ts";
import { pageScript, type Classify, type DiscoverInfo, type DomFn, type PageRequest, type PageResponse, type RateLimit } from "./page.ts";
import { abortableSleep } from "./util.ts";

export interface CallOptions {
	signal?: AbortSignal;
	method?: "GET" | "POST";
	timeoutMs?: number;
}

interface SessionsLike {
	ensure(a: Account, signal?: AbortSignal): Promise<void>;
	eval<T>(a: Account, script: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
	invalidate(a: Account): void;
}

export interface EngineDeps {
	sessions: SessionsLike;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
	maxRetries?: number;
}

type XApiError = { code?: number; message?: string };
const PREFIXED: ReadonlySet<string> = new Set(["not_logged_in", "api_changed", "network", "invalid_input"]);

function fromCodes(errs: XApiError[], status: number): XError | null {
	const codes = errs.map((e) => e.code);
	const msg = errs.map((e) => e.message).filter(Boolean).join("; ");
	if (codes.includes(88)) return new XError("rate_limited", `X rate limit (code 88): ${msg}`);
	if (codes.includes(326)) return new XError("account_locked", `X locked this account (code 326): ${msg}`);
	if (codes.some((c) => c === 32 || c === 89 || c === 239)) return new XError("not_logged_in", `X auth failed: ${msg}`);
	if (codes.some((c) => c === 34 || c === 50 || c === 63 || c === 144) || /not found|does not exist/i.test(msg)) {
		return new XError("not_found", msg || "Not found");
	}
	if (status === 200) return new XError("api_changed", `X API error: ${msg || "unknown"}`);
	return null;
}

export function classifyResponse(res: PageResponse): XError | null {
	const body = (res.data ?? null) as { errors?: XApiError[]; data?: unknown } | null;
	if (res.ok) {
		if (body?.errors?.length && body.data == null) return fromCodes(body.errors, res.status);
		return null;
	}
	const prefix = /^(\w+):/.exec(res.error ?? "")?.[1];
	if (prefix && PREFIXED.has(prefix)) return new XError(prefix as XErrorCode, (res.error ?? "").slice(prefix.length + 1).trim());
	if (body?.errors?.length) {
		const e = fromCodes(body.errors, res.status);
		if (e) return e;
	}
	const detail = (res.error ?? "").slice(0, 160);
	if (res.status === 429) return new XError("rate_limited", "X rate limit hit (HTTP 429)");
	if (res.status === 401 || res.status === 403) return new XError("not_logged_in", `X rejected the session (HTTP ${res.status})`);
	if (res.status === 404) return new XError("api_changed", "X API endpoint returned 404 (operation changed?)");
	if (res.status === 400 || res.status === 422) return new XError("api_changed", `X API rejected the request (HTTP ${res.status}): ${detail}`);
	return new XError("network", `X API HTTP ${res.status}: ${detail}`);
}

export class Engine {
	/** Last seen rate-limit headers, keyed `${account}:${op}`. */
	readonly rate = new Map<string, RateLimit>();
	private sessions: SessionsLike;
	private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private random: () => number;
	private maxRetries: number;

	constructor(deps: EngineDeps) {
		this.sessions = deps.sessions;
		this.sleep = deps.sleep ?? abortableSleep;
		this.random = deps.random ?? Math.random;
		this.maxRetries = deps.maxRetries ?? 2;
	}

	private async raw(a: Account, req: PageRequest, opts: CallOptions): Promise<PageResponse> {
		const evalOnce = async () => {
			await this.sessions.ensure(a, opts.signal);
			return this.sessions.eval<PageResponse>(a, pageScript(req), { signal: opts.signal, timeoutMs: opts.timeoutMs });
		};
		try {
			return await evalOnce();
		} catch (e) {
			const x = e as XError;
			if (x.code === "aborted" || x.code === "browser_missing" || x.code === "chrome_missing" || x.code === "profile_busy") throw x;
			this.sessions.invalidate(a);
			return evalOnce();
		}
	}

	async request(a: Account, req: PageRequest, opts: CallOptions = {}): Promise<unknown> {
		for (let attempt = 0; ; attempt++) {
			const res = await this.raw(a, req, opts);
			if (res.rateLimit) this.rate.set(`${a.name}:${req.kind === "graphql" ? req.op : req.kind}`, res.rateLimit);
			const err = classifyResponse(res);
			if (!err) return res.data;
			if (err.code === "rate_limited" && attempt < this.maxRetries) {
				await this.sleep((5 * 2 ** attempt + this.random() * 2) * 1000, opts.signal);
				continue;
			}
			throw err;
		}
	}

	graphql(a: Account, op: string, vars: Record<string, unknown>, opts: CallOptions = {}): Promise<unknown> {
		return this.request(a, { kind: "graphql", op, vars, method: opts.method }, opts);
	}

	rest(a: Account, path: string, opts: CallOptions = {}): Promise<unknown> {
		return this.request(a, { kind: "rest", path }, opts);
	}

	/** Send a direct message via X's internal REST endpoint (create/reuse conversation, then send). */
	async dm(a: Account, recipientId: string, text: string, opts: CallOptions = {}): Promise<unknown> {
		return this.request(a, { kind: "dm", recipientId, text }, opts);
	}

	/** Raw DM inbox state (conversations, entries, users) from X's REST endpoint. */
	async dmInbox(a: Account, opts: CallOptions = {}): Promise<unknown> {
		return this.request(a, { kind: "dmInbox" }, opts);
	}

	async dom<T>(a: Account, fn: DomFn, opts: CallOptions = {}): Promise<T> {
		const res = await this.raw(a, { kind: "dom", fn }, opts);
		if (!res.ok) throw new XError("dom_changed", res.error ?? `DOM ${fn} failed`);
		return res.data as T;
	}

	async discover(a: Account, opts: CallOptions = {}): Promise<DiscoverInfo> {
		const res = await this.raw(a, { kind: "discover", refresh: true }, opts);
		return res.data as DiscoverInfo;
	}

	/** Logged-in handle via the page's own session, or null when logged out. Never uses English page text. */
	async viewer(a: Account, opts: CallOptions = {}): Promise<{ id: string; handle: string } | null> {
		const cls = await this.dom<Classify>(a, "classify", opts);
		if (cls.wall || !cls.loggedIn) return null;
		const data = (await this.graphql(a, "Viewer", { withCommunitiesMemberships: false }, opts)) as {
			data?: { viewer?: { user_results?: { result?: { rest_id?: string; core?: { screen_name?: string }; legacy?: { screen_name?: string } } } } };
		};
		const u = data?.data?.viewer?.user_results?.result;
		const handle = u?.core?.screen_name ?? u?.legacy?.screen_name;
		return handle ? { id: String(u?.rest_id ?? ""), handle } : null;
	}
}
