import { XError } from "../errors.ts";
import { compact, fitToBudget, formatStats, formatTweet, formatUser } from "../format.ts";
import { parseTimeline, parseUser, parseUserList, type XUser } from "../normalize.ts";
import type { Account } from "../config.ts";
import { collapseDuplicates, computeStats, scoreAll, sortTweets } from "../score.ts";
import { clamp } from "../util.ts";
import { type Progress, paginate, type ToolDeps, type ToolOutput, withAccount } from "./context.ts";

export function parseUsername(input: string): string {
	const s = (input ?? "").trim().replace(/^@/, "");
	const m = s.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
	if (m) return m[1];
	if (/^[A-Za-z0-9_]{1,15}$/.test(s)) return s;
	throw new XError("invalid_input", `Could not read an X username from "${input}"`);
}

export async function runUser(
	deps: ToolDeps,
	p: { username: string; posts?: number; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
): Promise<ToolOutput> {
	const handle = parseUsername(p.username);
	const want = clamp(p.posts ?? 0, 0, 100);
	const { value, account } = await withAccount(deps, p.account, signal, async (a) => {
		const user = parseUser(await deps.engine.graphql(a, "UserByScreenName", { screen_name: handle }, { signal }));
		if (!user) throw new XError("not_found", `@${handle} not found (suspended, renamed, or never existed)`);
		if (!want) return { user, tweets: [] };
		const r = await paginate(
			async (cursor) =>
				parseTimeline(
					await deps.engine.graphql(
						a,
						"UserTweets",
						{ userId: user.id, count: 20, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: true, ...(cursor ? { cursor } : {}) },
						{ signal },
					),
				),
			want,
			{ signal, progress, sleep: deps.sleep, random: deps.random, label: `@${handle} posts` },
		);
		return { user, tweets: r.tweets };
	});
	if (!want) return { text: formatUser(value.user), details: { account: account.name, user: value.user } };
	const { kept, duplicates } = collapseDuplicates(scoreAll(value.tweets));
	const posts = sortTweets(kept, "recent");
	const stats = computeStats(posts, duplicates);
	const body = fitToBudget(`${formatUser(value.user)}\n\nRecent posts\n${formatStats(stats)}`, posts.map((t, i) => formatTweet(t, i + 1)));
	return { text: body.text, details: { account: account.name, user: value.user, stats: { ...stats, top: stats.top.map((t) => t.id), earliest_notable: stats.earliest_notable?.id ?? null }, posts } };
}

/** Paginate a Followers or Following GraphQL timeline. */
async function paginateUsers(
	deps: ToolDeps,
	a: Account,
	op: "Followers" | "Following",
	userId: string,
	limit: number,
	opts: { signal?: AbortSignal; progress?: Progress; label: string },
): Promise<XUser[]> {
	const out: XUser[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	let empty = 0;
	for (let page = 1; out.length < limit; page++) {
		if (opts.signal?.aborted) throw new XError("aborted", "Cancelled");
		const vars: Record<string, unknown> = { userId, count: 20, includePromotedContent: false };
		if (cursor) vars.cursor = cursor;
		const data = await deps.engine.graphql(a, op, vars, { signal: opts.signal });
		const res = parseUserList(data);
		let added = 0;
		for (const u of res.users) {
			if (!seen.has(u.id)) {
				seen.add(u.id);
				out.push(u);
				added++;
			}
		}
		opts.progress?.(`${opts.label}: page ${page}, ${out.length} users`);
		if (!res.cursor || res.cursor === cursor) break;
		cursor = res.cursor;
		empty = added ? 0 : empty + 1;
		if (empty >= 3) break;
		if (out.length < limit) await deps.sleep(1500 + deps.random() * 1000, opts.signal);
	}
	return out.slice(0, limit);
}

export async function runFollowers(
	deps: ToolDeps,
	p: { username: string; limit?: number; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
): Promise<ToolOutput> {
	const handle = parseUsername(p.username);
	const limit = clamp(p.limit ?? 20, 1, 200);
	const { value, account } = await withAccount(deps, p.account, signal, async (a) => {
		progress?.("resolving user…");
		const user = parseUser(await deps.engine.graphql(a, "UserByScreenName", { screen_name: handle }, { signal }));
		if (!user) throw new XError("not_found", `@${handle} not found`);
		const users = await paginateUsers(deps, a, "Followers", user.id, limit, { signal, progress, label: `@${handle} followers` });
		return { user, users };
	});
	const lines = [`@${value.user.handle} — followers (${value.users.length})`, ""];
	for (const u of value.users) {
		lines.push(`  @${u.handle}${u.verified ? " ✓" : ""} — ${u.name} · ${compact(u.followers)} followers`);
	}
	return { text: lines.join("\n"), details: { account: account.name, user: value.user.handle, followers: value.users } };
}

export async function runFollowing(
	deps: ToolDeps,
	p: { username: string; limit?: number; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
): Promise<ToolOutput> {
	const handle = parseUsername(p.username);
	const limit = clamp(p.limit ?? 20, 1, 200);
	const { value, account } = await withAccount(deps, p.account, signal, async (a) => {
		progress?.("resolving user…");
		const user = parseUser(await deps.engine.graphql(a, "UserByScreenName", { screen_name: handle }, { signal }));
		if (!user) throw new XError("not_found", `@${handle} not found`);
		const users = await paginateUsers(deps, a, "Following", user.id, limit, { signal, progress, label: `@${handle} following` });
		return { user, users };
	});
	const lines = [`@${value.user.handle} — following (${value.users.length})`, ""];
	for (const u of value.users) {
		lines.push(`  @${u.handle}${u.verified ? " ✓" : ""} — ${u.name} · ${compact(u.followers)} followers`);
	}
	return { text: lines.join("\n"), details: { account: account.name, user: value.user.handle, following: value.users } };
}
