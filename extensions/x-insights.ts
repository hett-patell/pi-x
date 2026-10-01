/**
 * X (Twitter) Insights Extension for Pi
 * =====================================
 *
 * Lets the agent fetch public X/Twitter data AND scrape topics from X, with
 * multi-account browser sessions for rotation.
 *
 * FREE-TIER REALITY (verified):
 * - Official X API: NO free search tier (free = posting only).
 * - Single-tweet fetch is free & no-auth via the syndication feed:
 *   https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<any> (token
 *   must be present but is NOT validated).
 *
 * CAPABILITIES
 * - x_tweet(id_or_url)            : fetch one tweet. FREE, no key.
 * - x_search(query, max?, type?)  : keyword search via SocialData.tools (freemium).
 * - x_user(username)              : profile lookup via SocialData.tools (freemium).
 * - x_scrape_topic(query, max?, account?, type?)
 *     : SCRAPE a topic from x.com directly using Pi's browser, rotating across
 *       multiple authenticated X accounts (persistent profiles). Returns
 *       structured posts the agent then turns into insights. Free (no API key),
 *       but each account must be logged in once via /x login.
 *
 * MULTI-ACCOUNT
 * - Each account = a persistent Chrome profile dir (~/.pi/x-insights/profiles/<name>)
 *   so cookies survive restarts (explicit --session names do NOT persist auth).
 * - Scrapes pick the least-recently-used account (or the one you pass), so heavy
 *   jobs rotate and avoid per-account walls.
 *
 * LOGIN (user-completed; X has no OAuth-for-scraping)
 * - /x login [account] [manual|password|google|apple]
 *     Opens X's login page in a HEADED browser for that account's profile; you
 *     complete sign-in (Google / Apple / email + 2FA). Cookies persist in that
 *     profile, so later x_scrape_topic calls in that account are authenticated.
 * - /x login check [account]  : verify the account is logged in.
 * - /x login clear            : drop stored login-method preference.
 *
 * CONFIG: ~/.pi/x-insights.json (mode 0600). SOCIALDATA_API_KEY env overrides.
 */

import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "x-insights.json");
const PROFILES_DIR = join(homedir(), ".pi", "x-insights", "profiles");

type LoginMethod = "manual" | "password" | "google" | "apple";
const LOGIN_METHODS: LoginMethod[] = ["manual", "password", "google", "apple"];

const LOGIN_TIPS: Record<LoginMethod, string> = {
	manual: "Complete sign-in using any method X offers (email/phone, Google, or Apple).",
	password:
		"Enter your email/username/phone → Next → enter password → Log in. Handle 2FA if prompted.",
	google: "Click 'Sign in with Google' → choose your account → complete any 2FA in the popup.",
	apple: "Click 'Sign in with Apple' → sign in with your Apple ID / Face ID / passcode.",
};

interface XAccount {
	name: string;
	profile?: string;
	enabled?: boolean;
}

interface XConfig {
	socialdataApiKey?: string;
	loginMethod?: LoginMethod;
	accounts?: XAccount[];
	active?: string;
}

function loadConfig(): XConfig {
	let cfg: XConfig = {};
	try {
		if (existsSync(CONFIG_PATH)) {
			cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8") as XConfig);
		}
	} catch {
		// ignore malformed config
	}
	const fromEnv = process.env.SOCIALDATA_API_KEY?.trim();
	if (fromEnv) cfg.socialdataApiKey = fromEnv;
	return cfg;
}

function saveConfig(cfg: XConfig): void {
	mkdirSync(join(homedir(), ".pi"), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
	try {
		chmodSync(CONFIG_PATH, 0o600);
	} catch {
		// best effort
	}
}

function apiKey(): string | undefined {
	return loadConfig().socialdataApiKey?.trim();
}

function defaultProfile(name: string): string {
	return join(PROFILES_DIR, name);
}

function getAccounts(cfg: XConfig): XAccount[] {
	if (cfg.accounts && cfg.accounts.length) {
		return cfg.accounts.map((a) => ({ ...a, profile: a.profile ?? defaultProfile(a.name) }));
	}
	return [{ name: "default", profile: defaultProfile("default") }];
}

function ensureProfileDir(acct: XAccount): string {
	const dir = acct.profile ?? defaultProfile(acct.name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const STATE_DIR = join(homedir(), ".pi", "x-insights", "state");

function statePath(name: string): string {
	return join(STATE_DIR, `${name}.json`);
}

/** True if a browser session for this account is already running. */
async function isSessionActive(acctName: string): Promise<boolean> {
	const r = await runAgentBrowser(["session", "list"], 8_000);
	return r.ok && r.stdout.toLowerCase().includes(acctName.toLowerCase());
}

/** Open x.com/home to refresh short-lived tokens (Cloudflare/guest) + keep the session alive. */
async function touchSession(acct: XAccount): Promise<CliResult> {
	ensureProfileDir(acct);
	return runAgentBrowser([...launchArgs(acct), ...ANTI_DETECT_ARGS, "open", "https://x.com/home"], 40_000);
}

/** Launch flags: pin a fresh/relaunched browser to this account's persistent profile + session. */
function launchArgs(acct: XAccount): string[] {
	return ["--session", acct.name, "--profile", acct.profile ?? defaultProfile(acct.name)];
}

/** Reuse flags: target the already-running session.
 *  Do NOT pass --profile here — on a non-launch command it forces a fresh about:blank context
 *  instead of reusing the running tab (verified: --profile on eval yields origin=about:blank, n=0). */
function sessionArgs(acct: XAccount): string[] {
	return ["--session", acct.name];
}

/** Launch args to make headless sessions look less automated (X bot-detection mitigation). */
const ANTI_DETECT_ARGS = ["--args", "--disable-blink-features=AutomationControlled"];

// LRU state for account rotation (in-process).
const lastUsed = new Map<string, number>();

/** Pick an account by name, else the active one, else the least-recently-used. */
function pickAccount(cfg: XConfig, name?: string): XAccount {
	const accts = getAccounts(cfg);
	if (name) {
		const a = accts.find((x) => x.name.toLowerCase() === name.toLowerCase());
		if (!a) {
			throw new Error(`Unknown X account "${name}". Add it first: /x account add ${name}`);
		}
		return a;
	}
	const active = cfg.active ? accts.find((x) => x.name === cfg.active) : undefined;
	if (active) return active;
	let best = accts[0];
	let bestT = Infinity;
	for (const a of accts) {
		const t = lastUsed.get(a.name) ?? 0;
		if (t < bestT) {
			bestT = t;
			best = a;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// agent-browser CLI helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function findAgentBrowser(): string | null {
	const isWin = process.platform === "win32";
	const pathEnv = process.env.PATH ?? "";
	const sep = isWin ? ";" : ":";
	const exts = isWin ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
	for (const dir of pathEnv.split(sep)) {
		if (!dir) continue;
		for (const ext of exts) {
			const cand = join(dir, "agent-browser" + ext);
			if (existsSync(cand)) return cand;
		}
	}
	const nvmBin = join(homedir(), ".nvm", "versions", "node", process.version, "bin", "agent-browser");
	if (existsSync(nvmBin)) return nvmBin;
	return null;
}

interface CliResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

async function runAgentBrowser(args: string[], timeoutMs = 30_000): Promise<CliResult> {
	const bin = findAgentBrowser();
	if (!bin) {
		return { ok: false, stdout: "", stderr: "", error: "agent-browser CLI not found on PATH" };
	}
	try {
		const { stdout, stderr } = await execFileAsync(bin, args, {
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			env: process.env,
		});
		return { ok: true, stdout: stdout.toString().trim(), stderr: stderr.toString().trim() };
	} catch (e: any) {
		return {
			ok: false,
			stdout: (e.stdout?.toString() ?? "").trim(),
			stderr: (e.stderr?.toString() ?? "").trim(),
			error: e?.message ?? String(e),
		};
	}
}

function findSqlite3(): string | null {
	const isWin = process.platform === "win32";
	for (const dir of (process.env.PATH ?? "").split(isWin ? ";" : ":")) {
		if (!dir) continue;
		const cand = join(dir, "sqlite3" + (isWin ? ".exe" : ""));
		if (existsSync(cand)) return cand;
	}
	return null;
}

const SQLITE3 = findSqlite3();

/**
 * Check an account's profile cookie DB for an x.com auth_token (non-intrusive; no
 * browser launch). true=logged in, false=not, true(assume yes) if undecidable
 * so a guess never blocks a scrape.
 */
async function isLoggedIn(acct: XAccount): Promise<boolean> {
	if (!SQLITE3) return true;
	const db = join(acct.profile ?? defaultProfile(acct.name), "Default", "Cookies");
	if (!existsSync(db)) return false;
	const tmpDir = join(homedir(), ".pi", "x-insights", ".tmp");
	mkdirSync(tmpDir, { recursive: true });
	const tmp = join(tmpDir, `cookies-${acct.name}.db`);
	try {
		copyFileSync(db, tmp);
		for (const ext of ["-wal", "-shm"]) if (existsSync(db + ext)) copyFileSync(db + ext, tmp + ext);
		const { stdout } = await execFileAsync(
			SQLITE3,
			[tmp, "SELECT count(*) FROM cookies WHERE name='auth_token' AND host_key LIKE '%x.com';"],
			{ timeout: 5_000 },
		);
		return parseInt(stdout.trim(), 10) > 0;
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// Tweet ID / username parsing
// ---------------------------------------------------------------------------

function parseTweetId(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("No tweet ID or URL provided.");
	if (/^\d+$/.test(trimmed)) return trimmed;
	const m = trimmed.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/);
	if (m) return m[1];
	if (/t\.co\//.test(trimmed)) {
		throw new Error("t.co short links can't be resolved without following a redirect. Open it first.");
	}
	throw new Error(`Could not extract a tweet ID from "${trimmed}". Provide an ID or x.com/<user>/status/<id> URL.`);
}

function parseUsername(input: string): string {
	const trimmed = input.trim().replace(/^@/, "");
	const m = trimmed.match(/(?:twitter\.com|x\.com)\/([^/?#]+)/i);
	if (m) return m[1];
	if (/^[A-Za-z0-9_]{1,15}$/.test(trimmed)) return trimmed;
	throw new Error(`Could not extract a username from "${input}".`);
}

// ---------------------------------------------------------------------------
// Tweet normalization (handles syndication + socialdata + scraped shapes)
// ---------------------------------------------------------------------------

interface NormalizedTweet {
	id: string;
	url: string;
	text: string;
	created_at: string;
	lang: string | null;
	user: { screen_name: string; name: string; verified: boolean; followers?: number };
	metrics: {
		likes: number;
		retweets: number;
		replies: number;
		quotes: number;
		bookmarks: number;
		views: string | null;
	};
	hashtags: string[];
	mentions: string[];
	urls: string[];
	media: string[];
	is_quote: boolean;
	quoted?: Partial<NormalizedTweet>;
	reply_to?: string | null;
	raw: unknown;
}

function num(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
	return 0;
}

function normalizeTweet(raw: any): NormalizedTweet {
	const id: string = String(raw?.id_str ?? raw?.id ?? raw?.tweet?.id_str ?? "");
	const user = raw?.user ?? raw?.core?.user_results?.result?.legacy ?? {};
	const entities = raw?.entities ?? raw?.extended_entities ?? {};
	const views = raw?.views?.count ?? raw?.views ?? raw?.view_count ?? null;
	const screenName = String(user?.screen_name ?? user?.legacy?.screen_name ?? "");

	const strArr = (xs: any[], k: (x: any) => string) =>
		(xs ?? []).map((x: any) => (typeof x === "string" ? x : k(x) ?? "")).filter(Boolean);

	const out: NormalizedTweet = {
		id,
		url: id ? `https://x.com/${screenName || "i"}/status/${id}` : "",
		text: String(raw?.full_text ?? raw?.text ?? raw?.tweet?.text ?? "")
			.replace(/https?:\/\/t\.co\/\S*$/g, "")
			.trim(),
		created_at: String(raw?.created_at ?? ""),
		lang: raw?.lang ?? null,
		user: {
			screen_name: screenName,
			name: String(user?.name ?? user?.legacy?.name ?? ""),
			verified: Boolean(user?.is_blue_verified ?? user?.verified ?? user?.legacy?.verified ?? false),
			followers: typeof user?.followers_count === "number" ? user.followers_count : undefined,
		},
		metrics: {
			likes: num(raw?.favorite_count),
			retweets: num(raw?.retweet_count),
			replies: num(raw?.reply_count),
			quotes: num(raw?.quote_count),
			bookmarks: num(raw?.bookmark_count),
			views: views != null ? String(views) : null,
		},
		hashtags: strArr(entities?.hashtags, (h) => h?.text ?? h?.name),
		mentions: strArr(entities?.user_mentions, (m) => m?.screen_name ?? m?.username),
		urls: strArr(entities?.urls, (u) => u?.expanded_url ?? u?.url),
		media: strArr(entities?.media ?? raw?.extended_entities?.media, (m) => m?.media_url_https ?? m?.url),
		is_quote: Boolean(raw?.quoted_tweet ?? raw?.quoted_status_result?.result),
		reply_to: raw?.in_reply_to_status_id_str ?? raw?.in_reply_to_screen_name ?? null,
		raw,
	};
	const quoted = raw?.quoted_tweet ?? raw?.quoted_status_result?.result ?? null;
	if (quoted) out.quoted = normalizeTweet(quoted);
	return out;
}

function tweetToText(t: NormalizedTweet): string {
	const lines: string[] = [];
	lines.push(`@${t.user.screen_name}${t.user.verified ? " ✓" : ""} — ${t.user.name}`);
	lines.push(t.text);
	const m = t.metrics;
	lines.push(
		`❤ ${m.likes}  🔁 ${m.retweets}  ↩ ${m.replies}  ❝ ${m.quotes}  🔖 ${m.bookmarks}` +
			(m.views ? `  👁 ${m.views}` : ""),
	);
	lines.push(`⏱ ${t.created_at}${t.lang ? `  lang=${t.lang}` : ""}`);
	if (t.hashtags.length) lines.push(`#${t.hashtags.join(" #")}`);
	if (t.mentions.length) lines.push(`↪ @${t.mentions.join(" @")}`);
	if (t.urls.length) lines.push(`🔗 ${t.urls.join(" ")}`);
	if (t.media.length) lines.push(`🖼 ${t.media.length} media`);
	if (t.is_quote && t.quoted) {
		lines.push("", `↪ Quoting @${t.quoted.user?.screen_name}:`);
		lines.push(tweetToText(t.quoted as NormalizedTweet));
	}
	lines.push(`🔗 ${t.url}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP helpers (syndication + socialdata)
// ---------------------------------------------------------------------------

async function fetchJson(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 25_000);
	const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
	try {
		const res = await fetch(url, { ...init, signal: combined, redirect: "follow" });
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}`);
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
		}
	} finally {
		clearTimeout(t);
	}
}

const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";
const SOCIALDATA_BASE = "https://api.socialdata.tools";

async function fetchTweetSyndication(id: string, signal?: AbortSignal): Promise<NormalizedTweet | null> {
	const data = await fetchJson(`${SYNDICATION_URL}?id=${encodeURIComponent(id)}&token=0`, {}, signal);
	if (!data || typeof data !== "object" || !data.id_str) return null;
	return normalizeTweet(data);
}

async function socialdataGet(path: string, query: Record<string, string>, signal?: AbortSignal) {
	const key = apiKey();
	if (!key) throw new Error("NO_SOCIALDATA_KEY");
	const qs = new URLSearchParams(query).toString();
	const url = `${SOCIALDATA_BASE}${path}${qs ? `?${qs}` : ""}`;
	return fetchJson(
		url,
		{ headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Browser topic scraper (in-page extraction via agent-browser eval)
// ---------------------------------------------------------------------------

/**
 * Runs inside the x.com search page. Reads article[data-testid="tweet"] nodes
 * and returns an array shaped for normalizeTweet(). Deliberately uses no
 * backslash escapes so it embeds cleanly as a single CLI argument.
 */
const EXTRACT_TWEETS_JS = `(function(){
  var arts = document.querySelectorAll('article[data-testid="tweet"]');
  var out = [];
  function num(a, tid){
    var el = a.querySelector('[data-testid="' + tid + '"]');
    if(!el) return 0;
    var label = el.getAttribute('aria-label') || el.innerText || '';
    if(label.toLowerCase().indexOf('no ') === 0) return 0;
    var m = label.match(/[0-9.,]+[KMBkmb]?/);
    if(!m) return 0;
    var s = m[0].replace(/,/g,'');
    var last = s.charAt(s.length-1);
    var mult = 1;
    if(last==='K'||last==='k'){mult=1000;s=s.slice(0,-1);}
    else if(last==='M'||last==='m'){mult=1000000;s=s.slice(0,-1);}
    else if(last==='B'||last==='b'){mult=1000000000;s=s.slice(0,-1);}
    var n = parseFloat(s);
    return isNaN(n) ? 0 : Math.round(n*mult);
  }
  arts.forEach(function(a){
    try{
      var statusLink = a.querySelector('a[href*="/status/"]');
      var href = statusLink ? statusLink.getAttribute('href') : '';
      var id = '';
      var idx = href.indexOf('/status/');
      if(idx >= 0){
        var rest = href.slice(idx + 8);
        var q = rest.indexOf('?');
        if(q >= 0) rest = rest.slice(0, q);
        if(/^[0-9]+$/.test(rest)) id = rest;
      }
      var handle = '';
      var spans = a.querySelectorAll('span');
      for(var i=0;i<spans.length;i++){
        var st = spans[i].textContent.trim();
        if(/^@[A-Za-z0-9_]+$/.test(st)){ handle = st.slice(1); break; }
      }
      var textEl = a.querySelector('[data-testid="tweetText"]');
      var text = textEl ? textEl.innerText : '';
      var timeEl = a.querySelector('time');
      var dt = timeEl ? timeEl.getAttribute('datetime') : '';
      var verified = !!a.querySelector('[data-testid="icon-verified"]');
      var hashtags = (text.match(/#[A-Za-z0-9_]+/g) || []).map(function(h){ return {text: h.slice(1)}; });
      var mentions = (text.match(/@[A-Za-z0-9_]+/g) || [])
        .filter(function(x){ return x !== '@' + handle; })
        .map(function(x){ return {screen_name: x.slice(1)}; });
      var media = [];
      a.querySelectorAll('img').forEach(function(img){
        var src = img.getAttribute('src') || '';
        if(src.indexOf('/media/') >= 0) media.push(src);
      });
      out.push({
        id_str: id, text: text, created_at: dt, lang: null,
        user: { screen_name: handle, name: handle, is_blue_verified: verified },
        favorite_count: num(a,'like'),
        retweet_count: num(a,'retweet'),
        reply_count: num(a,'reply'),
        bookmark_count: num(a,'bookmark'),
        quote_count: 0, views: null,
        entities: { hashtags: hashtags, user_mentions: mentions, urls: [], media: media }
      });
    }catch(e){}
  });
  return out.filter(function(t){ return t.id_str; });
})()`;

/** Parse the --json eval envelope {data:{result}} (falls back to raw array). */
function parseEvalArray(er: CliResult): any[] {
	if (!er.ok || !er.stdout) return [];
	const s = er.stdout;
	try {
		const env = JSON.parse(s);
		const r = env?.data?.result ?? env?.result ?? env;
		return Array.isArray(r) ? r : [];
	} catch {
		try {
			const r = JSON.parse(s);
			return Array.isArray(r) ? r : [];
		} catch {
			return [];
		}
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a numeric result from a --json eval envelope. */
function parseEvalNumber(er: CliResult): number {
	if (!er.ok || !er.stdout) return 0;
	try {
		const env = JSON.parse(er.stdout);
		const r = env?.data?.result ?? env?.result ?? env;
		return typeof r === "number" ? r : Number(r) || 0;
	} catch {
		return 0;
	}
}

/** Poll until tweet articles are present (X renders the list asynchronously). */
async function waitForArticles(sess: string[], timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const er = await runAgentBrowser(
			[...sess, "--json", "eval", "document.querySelectorAll('[data-testid=tweet]').length"],
			15_000,
		);
		if (parseEvalNumber(er) > 0) return true;
		await sleep(700);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const TweetParams = Type.Object({
	id_or_url: Type.String({
		description: "A tweet ID (e.g. 20) or a full https://x.com/<user>/status/<id> URL.",
	}),
});

const SearchParams = Type.Object({
	query: Type.String({
		description:
			"X/Twitter search query with operators (from:elonmusk, since:, until:, #tag, -filter:replies, OR).",
	}),
	max_results: Type.Optional(
		Type.Number({ description: "Max tweets (default 25, max 100).", minimum: 1, maximum: 100 }),
	),
	type: Type.Optional(
		StringEnum(["Latest", "Top"] as const, {
			description: "Result ordering: 'Latest' or 'Top'. Default 'Latest'.",
		}),
	),
});

const UserParams = Type.Object({
	username: Type.String({ description: "X handle, with or without @, or an x.com/<user> URL." }),
});

const ScrapeParams = Type.Object({
	query: Type.String({
		description:
			"Topic / keyword to scrape from X. Same operators as x_search work on x.com search. " +
				"Example: 'AI agents (launch OR release) -filter:retweets'.",
	}),
	max: Type.Optional(
		Type.Number({ description: "Max posts to collect (default 20, max 100).", minimum: 1, maximum: 100 }),
	),
	account: Type.Optional(
		Type.String({
			description:
				"Specific X account (browser profile) to scrape with. Omit to auto-pick the " +
					"least-recently-used account (rotation). List accounts with /x accounts.",
		}),
	),
	type: Type.Optional(
		StringEnum(["Latest", "Top"] as const, {
			description: "'Latest' (recency) or 'Top' (relevance). Default 'Latest'.",
		}),
	),
});

// ===========================================================================
// Extension factory
// ===========================================================================

export default function xInsightsExtension(pi: ExtensionAPI) {
	// ---- x_tweet: FREE, no auth, single tweet by ID/URL ----------------------
	pi.registerTool({
		name: "x_tweet",
		label: "X: Fetch Tweet",
		description:
			"Fetch a single public X/Twitter post by ID or URL — text, author, engagement, hashtags, " +
				"mentions, media, and quoted post. FREE: no API key, no auth.",
		promptSnippet: "x_tweet(id_or_url) — fetch one tweet by ID/URL. Free, no key.",
		promptGuidelines: [
			"Use x_tweet whenever the user references a specific tweet URL or ID.",
			"Report the structured engagement metrics (likes/retweets/replies/quotes/views).",
		],
		parameters: TweetParams,
		async execute(_id, params, signal) {
			let tid: string;
			try {
				tid = parseTweetId(params.id_or_url);
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `❌ ${e.message}` }],
					isError: true,
					details: { error: e.message },
				};
			}
			let tweet: NormalizedTweet | null = null;
			let used = "syndication (free, no auth)";
			try {
				tweet = await fetchTweetSyndication(tid, signal);
			} catch {
				if (apiKey()) {
					try {
						const data = await socialdataGet(`/twitter/tweet/${tid}`, {}, signal);
						if (data && (data.id_str || data.id)) {
							tweet = normalizeTweet(data);
							used = "socialdata.tools";
						}
					} catch {
						/* fall through */
					}
				}
			}
			if (!tweet) {
				return {
					content: [
						{ type: "text", text: `No public tweet found for ID ${tid}. It may be deleted/protected.` },
					],
					isError: true,
					details: { id: tid },
				};
			}
			return {
				content: [{ type: "text", text: `Fetched via ${used}:\n\n${tweetToText(tweet)}` }],
				details: { id: tid, source: used, tweet },
			};
		},
	});

	// ---- x_search: keyword search via SocialData (freemium) ------------------
	pi.registerTool({
		name: "x_search",
		label: "X: Search Posts (API)",
		description:
			"Keyword search across X via SocialData.tools (freemium). Returns structured posts with " +
				"engagement. Prefer this over x_scrape_topic when a SocialData key is set (reliable JSON). " +
				"For scraping without a key, use x_scrape_topic.",
		promptSnippet: "x_search(query, max_results?, type?) — keyword search via SocialData. Needs key.",
		promptGuidelines: [
			"Use x_search for keyword/topic queries when a SocialData key is configured.",
			"Craft queries with operators (from:user, since:, until:, #tag, -filter:retweets, OR).",
			"After fetching, SYNTHESIZE insights: volume/hype, sentiment split, recurring themes, top voices by engagement, notable quotes (with URLs), timeline/spread.",
			"If x_search reports NO_SOCIALDATA_KEY, switch to x_scrape_topic (free browser scraping) — but ensure accounts are logged in (/x login).",
		],
		parameters: SearchParams,
		async execute(_id, params, signal) {
			const query = (params.query ?? "").trim();
			if (!query) return { content: [{ type: "text", text: "❌ query is required." }], isError: true };
			const type = (params.type as "Latest" | "Top") || "Latest";
			const max = Math.min(Math.max(params.max_results ?? 25, 1), 100);

			if (!apiKey()) {
				return {
					content: [
						{
							type: "text",
							text:
								`🔒 No SocialData key configured. For keyword search, use the FREE browser scraper instead:\n` +
								`  → call x_scrape_topic with the same query (ensure accounts are logged in via /x login).\n` +
								`Or set a freemium key: /x setkey <key>  (free credits at https://socialdata.tools/signup)\n` +
								`(The official X API has no free search tier.)`,
						},
					],
					details: { no_key: true, query, type },
				};
			}
			try {
				const data = await socialdataGet(
					"/twitter/search",
					{ query, type, max_results: String(max) },
					signal,
				);
				const rawTweets: any[] = data?.tweets ?? data?.statuses ?? data?.data ?? [];
				const tweets = rawTweets.map(normalizeTweet).filter((t: NormalizedTweet) => t.id);
				const next = data?.next_cursor ?? data?.next_cursor_str ?? null;
				const summary =
					`Found ${tweets.length} post(s) for: "${query}" (type=${type}).\n` +
					`────────────────────────────────────────\n\n` +
					tweets.map((t: NormalizedTweet, i: number) => `── #${i + 1} ──\n${tweetToText(t)}`).join("\n\n") +
					(next ? `\n\nMore results available (next_cursor: ${next}).` : "");
				return {
					content: [{ type: "text", text: summary }],
					details: { query, type, count: tweets.length, next_cursor: next, tweets },
				};
			} catch (e: any) {
				const msg = e?.message ?? String(e);
				if (msg.includes("401") || msg.includes("403")) {
					return {
						content: [
							{ type: "text", text: `🔑 SocialData key rejected (${msg}). Run /x setkey <key>.` },
						],
						isError: true,
						details: { query, error: msg },
					};
				}
				return { content: [{ type: "text", text: `❌ Search failed: ${msg}` }], isError: true, details: { query, error: msg } };
			}
		},
	});

	// ---- x_user: profile lookup via SocialData ------------------------------
	pi.registerTool({
		name: "x_user",
		label: "X: User Profile",
		description:
			"Fetch a public X/Twitter user profile (bio, follower/following counts, join date, " +
				"verified status). Requires a SocialData.tools API key (freemium).",
		promptSnippet: "x_user(username) — fetch an X profile. Needs SOCIALDATA_API_KEY.",
		promptGuidelines: [
			"Use x_user for author/audience context before analyzing their posts.",
			"Surface follower count, verification, bio, and join date as credibility signals.",
		],
		parameters: UserParams,
		async execute(_id, params, signal) {
			let uname: string;
			try {
				uname = parseUsername(params.username);
			} catch (e: any) {
				return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
			}
			if (!apiKey()) {
				return {
					content: [
						{
							type: "text",
							text:
								`🔒 Profile lookup needs a SocialData key (freemium). None configured.\n` +
								`Get one at https://socialdata.tools/signup, then: /x setkey <key>\n` +
								`(Or use agent_browser to open https://x.com/${uname} while logged in.)`,
						},
					],
					details: { no_key: true, username: uname },
				};
			}
			try {
				const u = await socialdataGet(`/twitter/user/${encodeURIComponent(uname)}`, {}, signal);
				const screen = u?.screen_name ?? uname;
				const lines = [
					`@${screen}${u?.verified ? " ✓" : ""} — ${u?.name ?? ""}`,
					`────────────────────────────────────────`,
					u?.description ? `📝 ${u.description}` : `📝 (no bio)`,
					`👥 followers: ${u?.followers_count ?? "?"}  following: ${u?.friends_count ?? "?"}  listed: ${u?.listed_count ?? "?"}`,
					`✏ posts: ${u?.statuses_count ?? "?"}  likes: ${u?.favourites_count ?? "?"}`,
					`📍 ${u?.location || "(no location)"}`,
					u?.url ? `🔗 ${u.url}` : ``,
					`🗓 joined: ${u?.created_at ?? "?"}`,
					`🔗 https://x.com/${screen}`,
				].filter(Boolean);
				return { content: [{ type: "text", text: lines.join("\n") }], details: { username: uname, user: u } };
			} catch (e: any) {
				const msg = e?.message ?? String(e);
				return {
					content: [{ type: "text", text: `❌ Profile fetch failed: ${msg}` }],
					isError: true,
					details: { username: uname, error: msg },
				};
			}
		},
	});

	// ---- x_scrape_topic: browser-based topic scraper (multi-account) --------
	pi.registerTool({
		name: "x_scrape_topic",
		label: "X: Scrape Topic",
		description:
			"Scrape posts for a topic/query directly from x.com using Pi's browser, rotating across " +
				"multiple authenticated X accounts. FREE (no API key). Each account must be logged in " +
				"once via /x login. Returns structured posts (text, author, engagement, time, URL) that " +
				"the agent synthesizes into insights. Detects login walls and tells you which account " +
				"needs /x login.",
		promptSnippet:
			"x_scrape_topic(query, max?, account?, type?) — scrape a topic from x.com (free, multi-account).",
		promptGuidelines: [
			"Use x_scrape_topic to find posts by topic/keyword when no SocialData key is set (it's the free path).",
			"Ensure at least one account is logged in first (/x login <account> <method>). If a scrape returns a login-wall error for account X, tell the user to run /x login <account>.",
			"For large jobs, let it rotate accounts (omit `account`) to spread load; pass a specific account only to pin one.",
			"After scraping, SYNTHESIZE insights: volume/hype, sentiment split, recurring themes, top voices by engagement, notable quotes (with URLs), timeline/spread. Don't just dump the list.",
			"x.com may still throttle or bot-detect headless sessions; if a scrape yields few results, retry with a different account or reduce max.",
		],
		parameters: ScrapeParams,
		async execute(_id, params, signal) {
			const query = (params.query ?? "").trim();
			if (!query) return { content: [{ type: "text", text: "❌ query is required." }], isError: true };
			const max = Math.min(Math.max(params.max ?? 20, 1), 100);
			const type = (params.type as "Latest" | "Top") || "Latest";
			const cfg = loadConfig();

			// Account rotation: a pinned account is tried as-is; otherwise try accounts
			// ordered logged-in-first then least-recently-used, falling back to the next
			// on a login wall / block. This is what makes multi-account actually work.
			let order: XAccount[];
			if (params.account) {
				try {
					order = [pickAccount(cfg, params.account)];
				} catch (e: any) {
					return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true, details: { error: e.message } };
				}
			} else {
				const accts = getAccounts(cfg);
				const tagged = await Promise.all(
					accts.map(async (a) => ({ a, li: await isLoggedIn(a), t: lastUsed.get(a.name) ?? 0 })),
				);
				tagged.sort((x, y) => (x.li === y.li ? x.t - y.t : x.li ? -1 : 1));
				order = tagged.map((x) => x.a);
			}

			const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${
				type === "Top" ? "top" : "live"
			}`;
			const tried: string[] = [];

			for (const acct of order) {
				ensureProfileDir(acct);
				const launch = launchArgs(acct);
				const sess = sessionArgs(acct);

				// 1) open the search page in this account's authenticated profile (--profile is launch-only)
				const openRes = await runAgentBrowser([...launch, ...ANTI_DETECT_ARGS, "open", searchUrl], 45_000);
				if (!openRes.ok) {
					tried.push(`${acct.name}: not logged in / blocked`);
					continue; // fall back to the next account
				}

				// 2) wait for tweets to render (X loads the list async after the shell), then extract + scroll
				await waitForArticles(sess, 10_000);
				const collected: any[] = [];
				const seen = new Set<string>();
				for (let i = 0; i < 5 && collected.length < max; i++) {
					if (i > 0) {
						await runAgentBrowser([...sess, "scroll", "down", "3000"], 12_000);
						await waitForArticles(sess, 5_000); // new batch rendered
					}
					const er = await runAgentBrowser([...sess, "--json", "eval", EXTRACT_TWEETS_JS], 30_000);
					const arr = parseEvalArray(er);
					if (!arr.length) break; // nothing more (or wall)
					let added = 0;
					for (const t of arr) {
						if (t.id_str && !seen.has(t.id_str)) {
							collected.push(t);
							seen.add(t.id_str);
							added++;
						}
					}
					if (added === 0) break; // no new tweets → end of results
				}

				// 3) login-wall / no-result → fall back to the next account
				if (collected.length === 0) {
					const ur = await runAgentBrowser([...sess, "get", "url"], 10_000);
					const cur = ur.ok ? ur.stdout : "";
					const wall = /\/(login|i\/flow\/login|account\/access)/i.test(cur);
					tried.push(`${acct.name}: ${wall ? "not logged in" : "no results / throttled"}`);
					continue;
				}

				lastUsed.set(acct.name, Date.now());
				const tweets = collected.slice(0, max).map(normalizeTweet);
				const via = order.length > 1 && tried.length ? ` (fell back from: ${tried.join("; ")})` : "";
				const summary =
					`Scraped ${tweets.length} post(s) for "${query}" via account "${acct.name}" (browser, free)${via}:\n` +
					`────────────────────────────────────────\n\n` +
					tweets.map((t: NormalizedTweet, i: number) => `── #${i + 1} ──\n${tweetToText(t)}`).join("\n\n");
				return {
					content: [{ type: "text", text: summary }],
					details: { query, account: acct.name, count: tweets.length, tweets, tried },
				};
			}

			// all accounts failed
			return {
				content: [
					{
						type: "text",
						text:
							`❌ No logged-in account could scrape "${query}". Tried: ${tried.join("; ")}.\n` +
							`Check status with /x accounts, or log one in: /x login <account> ${cfg.loginMethod ?? "google"}`,
					},
				],
				isError: true,
				details: { query, tried },
			};
		},
	});

	// ===========================================================================
	// /x command: status, SocialData key, multi-account + login
	// ===========================================================================
	pi.registerCommand("x", {
		description:
			"X Insights: status, SocialData key, multi-account, login + auth persistence. " +
			"Usage: /x | /x setkey <key> | /x clearkey | /x account add|remove|list|active <name> | " +
			"/x login [account] [manual|password|google|apple] | /x login check [account] | /x login clear | " +
			"/x state save|restore|list [account] | /x keepalive [account]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const cfg0 = loadConfig();

			// /x setkey <key>
			if (arg.startsWith("setkey ")) {
				const key = arg.slice("setkey ".length).trim();
				if (!key) {
					ctx.ui.notify("Usage: /x setkey <your_socialdata_key>", "warning");
					return;
				}
				const cfg = loadConfig();
				cfg.socialdataApiKey = key;
				saveConfig(cfg);
				ctx.ui.notify("✓ SocialData API key saved to ~/.pi/x-insights.json", "success");
				return;
			}
			if (arg === "clearkey") {
				const cfg = loadConfig();
				delete cfg.socialdataApiKey;
				saveConfig(cfg);
				ctx.ui.notify("✓ SocialData API key cleared", "info");
				return;
			}

			// /x account add|remove|list|active <name>
			if (arg === "accounts" || arg === "account list" || arg.startsWith("account ")) {
				const rest = arg.startsWith("account ") ? arg.slice(8).trim() : "";
				if (!rest || rest === "list" || arg === "accounts") {
					const accts = getAccounts(cfg0);
					const lines = [
						"X accounts (browser profiles)",
						"──────────────────────────────────────",
						...(await Promise.all(
							accts.map(async (a) => {
								const li = await isLoggedIn(a);
								return (
									`  ${a.name === cfg0.active ? "★ " : "  "}${a.name}   ` +
									`${li ? "✓ logged in" : "✗ not logged in"}   ${a.profile ?? defaultProfile(a.name)}` +
									(a.enabled === false ? "  [disabled]" : "")
								);
							}),
						)),
						"",
						`active: ${cfg0.active ?? accts[0]?.name ?? "(none)"}`,
						"Commands: /x account add <name> | /x account remove <name> | /x account active <name> | /x login <name> <method>",
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				const [sub, ...restArgs] = rest.split(/\s+/);
				const name = restArgs[0];
				if (sub === "add") {
					if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
						ctx.ui.notify("Usage: /x account add <name> (letters, numbers, _, -)", "warning");
						return;
					}
					const cfg = loadConfig();
					const accts = getAccounts(cfg).map(({ enabled, ...a }) => a);
					if (accts.some((a) => a.name === name)) {
						ctx.ui.notify(`Account "${name}" already exists`, "warning");
						return;
					}
					accts.push({ name });
					cfg.accounts = accts;
					if (!cfg.active) cfg.active = name;
					saveConfig(cfg);
					ensureProfileDir({ name, profile: defaultProfile(name) });
					ctx.ui.notify(`✓ Account "${name}" added (profile at ${defaultProfile(name)})`, "success");
					return;
				}
				if (sub === "remove" || sub === "rm") {
					if (!name) {
						ctx.ui.notify("Usage: /x account remove <name>", "warning");
						return;
					}
					const cfg = loadConfig();
					const accts = getAccounts(cfg)
						.filter((a) => a.name !== name)
						.map(({ enabled, ...a }) => a);
					if (accts.length === 0) accts.push({ name: "default" });
					cfg.accounts = accts;
					if (cfg.active === name) cfg.active = accts[0].name;
					saveConfig(cfg);
					ctx.ui.notify(`✓ Removed account "${name}" (profile dir kept on disk)`, "info");
					return;
				}
				if (sub === "active") {
					if (!name) {
						ctx.ui.notify("Usage: /x account active <name>", "warning");
						return;
					}
					const cfg = loadConfig();
					if (!getAccounts(cfg).some((a) => a.name === name)) {
						ctx.ui.notify(`No account named "${name}". Add it: /x account add ${name}`, "warning");
						return;
					}
					cfg.active = name;
					saveConfig(cfg);
					ctx.ui.notify(`✓ Active account set to "${name}"`, "success");
					return;
				}
				ctx.ui.notify(
					"Usage: /x account add <name> | /x account remove <name> | /x account active <name> | /x account list",
					"warning",
				);
				return;
			}

			// /x login [account] [method] | /x login check [account] | /x login clear
			if (arg === "login" || arg.startsWith("login ")) {
				const parts = arg === "login" ? [] : arg.slice(6).trim().split(/\s+/).filter(Boolean);
				let doCheck = false;
				let doClear = false;
				let accountName: string | undefined;
				let method: LoginMethod | undefined;
				for (const p of parts) {
					const pl = p.toLowerCase();
					if (pl === "check") doCheck = true;
					else if (pl === "clear") doClear = true;
					else if ((LOGIN_METHODS as string[]).includes(pl)) method = pl as LoginMethod;
					else if (getAccounts(cfg0).some((a) => a.name.toLowerCase() === pl)) accountName = pl;
					else {
						ctx.ui.notify(`Unknown token "${p}". Expected: account name, ${LOGIN_METHODS.join("/")}, check, clear`, "warning");
						return;
					}
				}
				const cfg = loadConfig();
				let acct: XAccount;
				try {
					acct = pickAccount(cfg, accountName);
				} catch (e: any) {
					ctx.ui.notify(`❌ ${e.message}`, "warning");
					return;
				}
				ensureProfileDir(acct);
				const launch = launchArgs(acct);
				const sess = sessionArgs(acct);

				if (doClear) {
					const c = loadConfig();
					delete c.loginMethod;
					saveConfig(c);
					ctx.ui.notify("✓ Cleared stored X login-method preference", "info");
					return;
				}

				// /x login check [account]
				if (doCheck) {
					ctx.ui.notify(`Checking X login for account "${acct.name}"…`, "info");
					const openRes = await runAgentBrowser([...launch, ...ANTI_DETECT_ARGS, "open", "https://x.com/home"], 40_000);
					if (!openRes.ok) {
						ctx.ui.notify(
							`⚠ Could not drive browser: ${openRes.error}\nAsk the agent to check https://x.com/home via agent_browser.`,
							"warning",
						);
						return;
					}
					const urlRes = await runAgentBrowser([...sess, "get", "url"], 10_000);
					const txtRes = await runAgentBrowser([...sess, "get", "text", "body"], 10_000);
					const cur = urlRes.stdout || "(unknown)";
					const body = txtRes.stdout.toLowerCase();
					const needsLogin =
						/\/(login|i\/flow\/login|account\/access)/i.test(cur) ||
						/sign in to x|log in to x|sign in with google|sign in with apple/i.test(body);
					ctx.ui.notify(
						needsLogin
							? `✗ Account "${acct.name}" not logged in (page: ${cur}). Run: /x login ${acct.name}`
							: `✓ Account "${acct.name}" looks logged in (page: ${cur}).`,
						needsLogin ? "warning" : "success",
					);
					return;
				}

				// /x login [account] [method] — open login page (headed) for this account's profile
				const chosenMethod: LoginMethod = method ?? cfg.loginMethod ?? "manual";
				if (method) {
					const c = loadConfig();
					c.loginMethod = chosenMethod;
					saveConfig(c);
				}
				if (!findAgentBrowser()) {
					ctx.ui.notify(
						"agent-browser CLI not found. Ask the agent:\n" +
							`"Use agent_browser with --headed --session ${acct.name} --profile ${acct.profile} to open https://x.com/i/flow/login so I can log in."`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(
					`Opening X login in Pi browser (headed) for account "${acct.name}"… complete login in the window.`,
					"info",
				);
				const res = await runAgentBrowser([...launch, ...ANTI_DETECT_ARGS, "--headed", "open", "https://x.com/i/flow/login"], 30_000);
				const msg =
					(res.ok
						? `✓ X login page opened for account "${acct.name}".`
						: `⚠ Browser open returned: ${res.error || res.stderr.slice(0, 200)}`) +
					`\n\nLogin method: ${chosenMethod}\n${LOGIN_TIPS[chosenMethod]}\n\n` +
					`When done, verify with: /x login check ${acct.name}\n` +
					`Cookies persist in this account's profile, so x_scrape_topic with this account is authenticated.`;
				ctx.ui.notify(msg, res.ok ? "success" : "warning");
				return;
			}

			// /x state save|restore|list [account] — explicit auth backup (cookies + localStorage + sessionStorage)
			if (arg.startsWith("state ")) {
				const rest = arg.slice(6).trim();
				const [sub, ...restArgs] = rest.split(/\s+/);
				let acct: XAccount;
				try {
					acct = pickAccount(cfg0, restArgs[0]);
				} catch (e: any) {
					ctx.ui.notify(`❌ ${e.message}`, "warning");
					return;
				}
				ensureProfileDir(acct);
				mkdirSync(STATE_DIR, { recursive: true });
				const sp = statePath(acct.name);
				const sess = sessionArgs(acct);
				if (sub === "save") {
					ctx.ui.notify(`Saving X state for account "${acct.name}"…`, "info");
					const t = await touchSession(acct);
					if (!t.ok) { ctx.ui.notify(`⚠ ${t.error || t.stderr.slice(0, 200)}`, "warning"); return; }
					await runAgentBrowser([...sess, "wait", "1500"], 8_000);
					const sr = await runAgentBrowser([...sess, "state", "save", sp], 15_000);
					ctx.ui.notify(sr.ok ? `✓ State saved → ${sp}` : `⚠ save failed: ${sr.error || sr.stderr.slice(0, 200)}`, sr.ok ? "success" : "warning");
					return;
				}
				if (sub === "restore") {
					if (!existsSync(sp)) { ctx.ui.notify(`No saved state at ${sp}. Run: /x state save ${acct.name}`, "warning"); return; }
					ctx.ui.notify(`Restoring X state for account "${acct.name}"…`, "info");
					const lr = await touchSession(acct);
					if (!lr.ok) { ctx.ui.notify(`⚠ ${lr.error || lr.stderr.slice(0, 200)}`, "warning"); return; }
					const sr = await runAgentBrowser([...sess, "state", "load", sp], 15_000);
					const v = await runAgentBrowser([...sess, "get", "url"], 8_000);
					ctx.ui.notify(sr.ok ? `✓ State restored (page: ${v.stdout || "?"})` : `⚠ restore failed: ${sr.error || sr.stderr.slice(0, 200)}`, sr.ok ? "success" : "warning");
					return;
				}
				if (sub === "list") {
					const r = await runAgentBrowser(["state", "list"], 10_000);
					ctx.ui.notify(r.ok ? r.stdout || "(none)" : `⚠ ${r.error}`, "info");
					return;
				}
				ctx.ui.notify("Usage: /x state save|restore|list [account]", "warning");
				return;
			}

			// /x keepalive [account] — refresh the session (prevents idle timeout, refreshes short-lived tokens)
			if (arg === "keepalive" || arg.startsWith("keepalive ")) {
				const rest = arg === "keepalive" ? "" : arg.slice("keepalive ".length).trim();
				let acct: XAccount;
				try {
					acct = pickAccount(cfg0, rest || undefined);
				} catch (e: any) {
					ctx.ui.notify(`❌ ${e.message}`, "warning");
					return;
				}
				ctx.ui.notify(`Refreshing X session for account "${acct.name}"…`, "info");
				const t = await touchSession(acct);
				if (!t.ok) { ctx.ui.notify(`⚠ ${t.error || t.stderr.slice(0, 200)}`, "warning"); return; }
				await runAgentBrowser([...sessionArgs(acct), "wait", "1500"], 8_000);
				const ur = await runAgentBrowser([...sessionArgs(acct), "get", "url"], 8_000);
				const tr = await runAgentBrowser([...sessionArgs(acct), "get", "text", "body"], 8_000);
				const cur = ur.stdout || "(unknown)";
				const needsLogin =
					/\/(login|i\/flow\/login|account\/access)/i.test(cur) ||
					/sign in to x|log in to x/i.test(tr.stdout.toLowerCase());
				ctx.ui.notify(
					needsLogin
						? `✗ "${acct.name}" not logged in (page: ${cur}). Run: /x login ${acct.name}`
						: `✓ "${acct.name}" session refreshed (page: ${cur})`,
					needsLogin ? "warning" : "success",
				);
				return;
			}

			// /x [status]
			if (arg && arg !== "status") {
				ctx.ui.notify(
					"Usage: /x | /x setkey <key> | /x clearkey | /x account add|remove|list|active <name> | " +
						"/x login [account] [manual|password|google|apple] | /x login check [account] | /x login clear | " +
						"/x state save|restore|list [account] | /x keepalive [account]",
					"warning",
				);
				return;
			}

			const key = cfg0.socialdataApiKey?.trim();
			const masked = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : "(none)";
			const accts = getAccounts(cfg0);
			const ab = findAgentBrowser() ? "found" : "NOT found";
			const lines = [
				"X (Twitter) Insights — status",
				"──────────────────────────────────────",
				`SocialData API key: ${masked}`,
				`Login method pref : ${cfg0.loginMethod ?? "manual"}`,
				`agent-browser CLI: ${ab}`,
				`Active account   : ${cfg0.active ?? accts[0]?.name ?? "(none)"}`,
				`Accounts         : ${accts.map((a) => a.name).join(", ")}`,
				"",
				"Auth persistence:",
				"  • cookies in profile (~1yr auth_token) + /x state save for backup",
				"  • /x keepalive refreshes short-lived tokens (Cloudflare/guest)",
				"",
				"Tools:",
				"  • x_tweet         — fetch a tweet by ID/URL     [FREE, no key]",
				"  • x_search        — keyword search (SocialData) [" + (key ? "key set" : "needs key → use x_scrape_topic") + "]",
				"  • x_user          — profile lookup (SocialData)[" + (key ? "key set" : "needs key") + "]",
				"  • x_scrape_topic  — scrape a topic from x.com   [FREE, multi-account browser]",
				"",
				"Commands: /x account add <name> | /x login <account> <method> | /x login check <account> | /x state save|restore <account> | /x keepalive <account> | /x setkey <key>",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
