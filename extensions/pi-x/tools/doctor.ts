import { maskProxy } from "../accounts.ts";
import { sessionName } from "../browser.ts";
import { updateAccount } from "../config.ts";
import { FIXES, toXError } from "../errors.ts";
import { type Progress, readConfig, type ToolDeps, type ToolOutput } from "./context.ts";
import { fetchSyndication } from "./tweet.ts";

export const REQUIRED_OPS = ["SearchTimeline", "TweetDetail", "UserByScreenName", "UserTweets", "ExplorePage", "GenericTimelineById", "Viewer"];

export interface DoctorReport {
	checked_at: string;
	agent_browser: { ok: boolean; path?: string; version?: string };
	syndication: { ok: boolean; message: string };
	accounts: {
		name: string;
		enabled: boolean;
		active: boolean;
		running: boolean;
		logged_in: boolean | null;
		handle?: string;
		proxy?: string;
		error?: { code: string; message: string; fix: string };
	}[];
	api: { ok: boolean; ops_found: number; missing: string[]; bearer: boolean } | null;
	engine: "api" | "dom" | "none";
	hints: string[];
}

export async function runDoctor(deps: ToolDeps, signal?: AbortSignal, progress?: Progress): Promise<ToolOutput> {
	const cfg = readConfig(deps);
	const report: DoctorReport = {
		checked_at: new Date(deps.now()).toISOString(),
		agent_browser: { ok: false },
		syndication: { ok: false, message: "" },
		accounts: [],
		api: null,
		engine: "none",
		hints: [],
	};

	if (deps.binary) {
		const v = await deps.runner(["--version"], { timeoutMs: 10_000, signal });
		report.agent_browser = { ok: v.ok, path: deps.binary.file, version: v.stdout.replace(/^agent-browser\s*/i, "") || undefined };
	}

	try {
		const t = await fetchSyndication(deps.fetchFn, "20", signal);
		report.syndication = t ? { ok: true, message: "free single-post fetch works (x_tweet, no login)" } : { ok: false, message: "feed returned nothing for post 20" };
	} catch (e) {
		report.syndication = { ok: false, message: toXError(e).message };
	}

	const running = deps.binary ? await deps.sessions.list(signal).catch(() => [] as string[]) : [];
	for (const a of cfg.accounts) {
		const row: DoctorReport["accounts"][number] = {
			name: a.name,
			enabled: a.enabled,
			active: cfg.active === a.name,
			running: running.includes(sessionName(a)),
			logged_in: null,
			handle: a.handle,
			proxy: maskProxy(a.proxy),
		};
		report.accounts.push(row);
		if (!a.enabled) continue;
		progress?.(`checking account ${a.name}…`);
		try {
			const v = await deps.locks.run(a.name, () => deps.engine.viewer(a, { signal, timeoutMs: 60_000 }));
			row.logged_in = Boolean(v);
			if (v) {
				row.handle = v.handle;
				updateAccount(deps.paths, a.name, { handle: v.handle });
				if (!report.api) {
					const d = await deps.locks.run(a.name, () => deps.engine.discover(a, { signal }));
					if (!d) {
						report.api = { ok: false, ops_found: 0, missing: [...REQUIRED_OPS], bearer: false };
					} else {
						const missing = REQUIRED_OPS.filter((op) => !d.ops.includes(op));
						report.api = { ok: d.bearer && d.ct0 && !missing.length, ops_found: d.ops.length, missing, bearer: d.bearer };
					}
				}
			}
		} catch (e) {
			const x = toXError(e);
			row.logged_in = false;
			row.error = x.toJSON();
		}
	}

	const loggedIn = report.accounts.some((a) => a.logged_in);
	report.engine = !loggedIn ? "none" : report.api?.ok ? "api" : "dom";
	if (!report.agent_browser.ok) report.hints.push(FIXES.browser_missing);
	if (!loggedIn) report.hints.push("Log an account in: /x login");
	if (report.api && !report.api.ok) report.hints.push(`X API ops missing (${report.api.missing.join(", ")}) — tools will use page scraping; patch extensions/pi-x if this persists`);

	const mark = (ok: boolean | null) => (ok ? "✓" : ok === null ? "–" : "✗");
	const lines = [
		`pi-x doctor (${report.checked_at})`,
		report.agent_browser.ok ? `✓ agent-browser ${report.agent_browser.version ?? ""} (${report.agent_browser.path})` : `✗ agent-browser not found → ${FIXES.browser_missing}`,
		`${mark(report.syndication.ok)} syndication feed: ${report.syndication.message}`,
		"",
		"Accounts:",
		...report.accounts.map((a) => {
			const head = `${mark(a.logged_in)} ${a.name}`;
			if (!a.enabled) return `${head} — disabled`;
			if (a.error && a.error.code !== "not_logged_in") return `${head} — ${a.error.code}: ${a.error.message} → ${a.error.fix}`;
			if (!a.logged_in) return `${head} — not logged in → /x login ${a.name}`;
			return `${head} — @${a.handle}${a.active ? " ★ active" : ""}${a.running ? " · browser open" : ""}${a.proxy ? ` · proxy ${a.proxy}` : ""}`;
		}),
		"",
		report.api ? `${mark(report.api.ok)} X internal API: ${report.api.ops_found} operations discovered${report.api.missing.length ? `, missing ${report.api.missing.join(", ")}` : ""}` : "– X internal API: not checked (no logged-in account)",
		`Engine: ${report.engine}`,
		...(report.hints.length ? ["", "Next steps:", ...report.hints.map((h) => `  → ${h}`)] : []),
	];
	return { text: lines.join("\n"), details: report as unknown as Record<string, unknown> };
}
