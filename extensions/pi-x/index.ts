/**
 * pi-x — X (Twitter) for Pi agents.
 * Trending topics & news (with "why it's trending" drill-down), search, threads, profiles —
 * via your own logged-in browser session (no API keys). See README.md.
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { scrubSecrets } from "./accounts.ts";
import { type CommandUI, completeArgs, footerText, runCommand } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { createDeps } from "./deps.ts";
import { FIXES } from "./errors.ts";
import { errorOutput, type Progress, readConfig, type ToolOutput } from "./tools/context.ts";
import { runDm, runDmInbox } from "./tools/dm.ts";
import { runDoctor } from "./tools/doctor.ts";
import { runSearch } from "./tools/search.ts";
import { runTrending } from "./tools/trending.ts";
import { runTweet } from "./tools/tweet.ts";
import { runUser } from "./tools/user.ts";

const Account = Type.Optional(Type.String({ description: "Pin a specific pi-x account (see /x status). Omit to auto-pick/rotate." }));

const TrendingParams = Type.Object({
	location: Type.Optional(Type.String({ description: "Place name or WOEID: 'worldwide', 'United States', 'India', 'London', '23424977'. Omit to use the /x location default (personalized Explore if none is saved); 'default' forces personalized Explore." })),
	tab: Type.Optional(StringEnum(["trending", "news", "sports", "entertainment"] as const, { description: "Explore tab (personalized mode only). Default 'trending'." })),
	include_news: Type.Optional(Type.Boolean({ description: "Also list X News stories (default true). Personalized Explore only — place trends have no news." })),
	limit: Type.Optional(Type.Number({ description: "Max trends (default 20, max 50).", minimum: 1, maximum: 50 })),
	drilldown: Type.Optional(Type.Number({ description: "Sample top posts for the top N trends to explain WHY they trend (0–5, default 0). Slower.", minimum: 0, maximum: 5 })),
	account: Account,
});

const SearchParams = Type.Object({
	query: Type.String({ description: "Keywords and/or X operators, e.g. 'AI agents (launch OR release)'. May be empty if from/to/mentions is set." }),
	type: Type.Optional(StringEnum(["Latest", "Top", "Media"] as const, { description: "Latest (default) = recency, Top = relevance." })),
	limit: Type.Optional(Type.Number({ description: "Max posts (default 40, max 300). Paginates.", minimum: 1, maximum: 300 })),
	sort: Type.Optional(StringEnum(["recent", "engagement"] as const, { description: "Output order (default recent)." })),
	from: Type.Optional(Type.String({ description: "Only posts by this handle." })),
	to: Type.Optional(Type.String({ description: "Only replies to this handle." })),
	mentions: Type.Optional(Type.String({ description: "Only posts mentioning this handle." })),
	since: Type.Optional(Type.String({ description: "YYYY-MM-DD (inclusive)." })),
	until: Type.Optional(Type.String({ description: "YYYY-MM-DD (exclusive)." })),
	lang: Type.Optional(Type.String({ description: "ISO language code, e.g. en, hi, ja." })),
	min_likes: Type.Optional(Type.Number({ minimum: 0 })),
	min_retweets: Type.Optional(Type.Number({ minimum: 0 })),
	min_replies: Type.Optional(Type.Number({ minimum: 0 })),
	has: Type.Optional(Type.Array(StringEnum(["media", "links", "images", "video"] as const))),
	exclude: Type.Optional(Type.Array(StringEnum(["replies", "retweets"] as const))),
	verified_only: Type.Optional(Type.Boolean()),
	near: Type.Optional(Type.String({ description: "Place name for geo search, e.g. 'Mumbai'." })),
	within: Type.Optional(Type.String({ description: "Radius with near, e.g. '15km'." })),
	cursor: Type.Optional(Type.String({ description: "next_cursor from a previous x_search to continue." })),
	account: Account,
});

const TweetParams = Type.Object({
	id_or_url: Type.String({ description: "Post ID or x.com/<user>/status/<id> URL." }),
	replies: Type.Optional(Type.Number({ description: "Also fetch top replies + the author's thread (0–100, default 0). 0 needs no login.", minimum: 0, maximum: 100 })),
	account: Account,
});

const UserParams = Type.Object({
	username: Type.String({ description: "Handle, @handle, or x.com/<user> URL." }),
	posts: Type.Optional(Type.Number({ description: "Also fetch their recent posts with stats (0–100, default 0).", minimum: 0, maximum: 100 })),
	account: Account,
});

const DmParams = Type.Object({
	to: Type.String({ description: "Recipient handle, @handle, or x.com/<user> URL." }),
	text: Type.String({ description: "Direct message text to send (max 10,000 characters)." }),
	account: Account,
});

const DmInboxParams = Type.Object({
	account: Account,
});

/**
 * Last-resort tool result when formatting the real result/error itself fails (e.g. config
 * unreadable). Built with no I/O and no dependency on `deps`, so it cannot throw — tools must
 * never reject to Pi.
 */
export function internalErrorFallback(e: unknown): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
	const message = e instanceof Error ? e.message : String(e);
	return {
		content: [{ type: "text", text: `✗ pi-x internal error: ${message}` }],
		details: { error: { code: "network", message, fix: FIXES.network } },
		isError: true,
	};
}

export default function piX(pi: ExtensionAPI) {
	const deps = createDeps(getAgentDir());

	const finish = (out: ToolOutput) => {
		const cfg = readConfig(deps);
		const tr = truncateHead(scrubSecrets(out.text, cfg), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		const text = tr.truncated ? `${tr.content}\n\n[output truncated — narrow with limit/filters; full data is in details]` : tr.content;
		return {
			content: [{ type: "text" as const, text }],
			details: JSON.parse(scrubSecrets(JSON.stringify(out.details), cfg)) as Record<string, unknown>,
			...(out.isError ? { isError: true } : {}),
		};
	};

	function tool<P>(run: (params: P, signal: AbortSignal | undefined, progress: Progress) => Promise<ToolOutput>) {
		return async (_id: string, params: P, signal: AbortSignal | undefined, onUpdate?: (r: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void) => {
			const progress: Progress = (msg) => {
				if (!onUpdate) return;
				try {
					const text = scrubSecrets(msg, readConfig(deps));
					onUpdate({ content: [{ type: "text", text }], details: { progress: text } });
				} catch {
					// config unreadable — drop this progress update rather than risk sending an unscrubbed message
				}
			};
			try {
				return finish(await run(params, signal, progress));
			} catch (e) {
				try {
					return finish(errorOutput(e));
				} catch (e2) {
					return internalErrorFallback(e2);
				}
			}
		};
	}

	pi.registerTool({
		name: "x_trending",
		label: "X: Trending",
		description:
			"What's trending on X right now: ranked trends (promoted removed) plus X News stories with post volume and age. " +
			"Personalized Explore by default, or any location. Set drilldown to sample top posts and explain WHY topics trend. Marks trends that are NEW since the last call.",
		promptSnippet: "x_trending(location?, tab?, drilldown?) — what's hot on X now (+ news, + why).",
		promptGuidelines: [
			"Follow the pi-x skill for routing and reporting. Without `location`, the /x location default applies; personalized Explore (with news and tabs) only when none is saved or location is \"default\". State the scope shown in the header.",
		],
		parameters: TrendingParams,
		execute: tool((p, s, prog) => runTrending(deps, p, s, prog)),
	});

	pi.registerTool({
		name: "x_search",
		label: "X: Search",
		description:
			"Search X posts with filters (from/to/mentions, since/until, lang, min_likes, media/links, exclude replies/retweets, verified, near). " +
			"Paginates up to 300 posts and returns computed stats: volume & posts/hour, engagement totals and medians, top voices, hashtags, linked sites, top posts, earliest notable post.",
		promptSnippet: "x_search(query, type?, limit?, filters…) — search X posts with stats.",
		promptGuidelines: ["Follow the pi-x skill for routing and for how to report results (stats describe the returned sample)."],
		parameters: SearchParams,
		execute: tool((p, s, prog) => runSearch(deps, p, s, prog)),
	});

	pi.registerTool({
		name: "x_tweet",
		label: "X: Post",
		description: "Read one X post by ID/URL with full engagement and quoted post. With replies > 0, also returns the author's thread and top replies ranked by engagement.",
		promptSnippet: "x_tweet(id_or_url, replies?) — read a post (+ thread & top replies).",
		promptGuidelines: ["Use x_tweet whenever the user shares an x.com or twitter.com status URL; replies: 0 needs no login."],
		parameters: TweetParams,
		execute: tool((p, s, prog) => runTweet(deps, p, s, prog)),
	});

	pi.registerTool({
		name: "x_user",
		label: "X: Profile",
		description: "X profile (bio, followers, following, posts, joined, verified, link). With posts > 0, also their recent posts with stats.",
		promptSnippet: "x_user(username, posts?) — profile (+ recent posts).",
		promptGuidelines: ["Use x_user for credibility/context on an account before quoting it."],
		parameters: UserParams,
		execute: tool((p, s, prog) => runUser(deps, p, s, prog)),
	});

	pi.registerTool({
		name: "x_dm",
		label: "X: Send DM",
		description:
			"Send a direct message to an X account via your logged-in session. Requires write mode (opt-in): run /x write on first. " +
			"Resolves the recipient, then creates/reuses the 1:1 conversation and sends the message through X's internal API.",
		promptSnippet: "x_dm(to, text, account?) — send a direct message.",
		promptGuidelines: [
			"Only send a DM when the user explicitly asks for it. Write mode (/x write on) must be enabled first; otherwise the tool errors with write_disabled.",
		],
		parameters: DmParams,
		execute: tool((p, s, prog) => runDm(deps, p, s, prog)),
	});

	pi.registerTool({
		name: "x_dm_inbox",
		label: "X: DM Inbox",
		description:
			"List your recent X direct-message conversations (1:1) with the other participant, the last message, and unread status. Read-only — does not send anything.",
		promptSnippet: "x_dm_inbox(account?) — list recent DMs and unread.",
		promptGuidelines: ["Use x_dm_inbox when the user asks about their DMs, unread/pending messages, or who last messaged them."],
		parameters: DmInboxParams,
		execute: tool((p, s, prog) => runDmInbox(deps, p, s, prog)),
	});

	pi.registerTool({
		name: "x_doctor",
		label: "X: Doctor",
		description: "Health check for pi-x: agent-browser install, each account's login (live), X internal API discovery, active engine, and exact fixes.",
		promptSnippet: "x_doctor() — diagnose pi-x and get fixes.",
		promptGuidelines: ["Run x_doctor when a pi-x tool fails unexpectedly or the user asks if X access works."],
		parameters: Type.Object({}),
		execute: tool((_p, s, prog) => runDoctor(deps, s, prog)),
	});

	pi.registerCommand("x", {
		description: "pi-x: /x status · login · add · use · proxy · location · doctor · help",
		getArgumentCompletions: (prefix) => completeArgs(prefix, readConfig(deps).accounts.map((a) => a.name)),
		handler: async (args, ctx) => {
			const ui: CommandUI = {
				hasUI: ctx.hasUI,
				say: (text, level = "info") => {
					if (ctx.hasUI) ctx.ui.notify(text, level);
					else (level === "error" ? process.stderr : process.stdout).write(`${text}\n`);
				},
				select: (title, options) => (ctx.hasUI ? ctx.ui.select(title, options) : Promise.resolve(undefined)),
				confirm: (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
				setStatus: (text) => {
					if (ctx.hasUI) ctx.ui.setStatus("pi-x", text);
				},
			};
			await runCommand(args, deps, ui);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const { config, warnings, migrated } = loadConfig(deps.paths, deps.legacyHome);
		if (ctx.hasUI) {
			for (const w of warnings) ctx.ui.notify(`pi-x: ${w}`, "info");
			ctx.ui.setStatus("pi-x", footerText(config));
		}
		if (migrated && deps.binary) {
			// pre-1.0 sessions were named after accounts and hold the profile lock
			for (const a of config.accounts) await deps.sessions.closeByName(a.name).catch(() => undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		await deps.sessions.closeAll().catch(() => undefined);
	});
}
