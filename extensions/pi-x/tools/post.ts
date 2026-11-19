import { XError } from "../errors.ts";
import { personalAccount, type PickAccount, readConfig, type Progress, type ToolDeps, type ToolOutput } from "./context.ts";
import type { ConfirmSend } from "./dm.ts";
import { parseTweetId } from "./tweet.ts";

const MAX_TEXT = 25_000;

function requireWriteAccess(deps: ToolDeps): void {
	if (!readConfig(deps).write) {
		throw new XError("write_disabled", "Posting is off (pi-x is read-only by default). Run /x write on to enable it.");
	}
}

/**
 * Post a tweet, reply, or quote-tweet. Same safety rules as x_dm:
 * - exactly one account (see personalAccount) — never rotated;
 * - the post runs once — no re-run after a failed page script, no rate-limit retry;
 * - every post is confirmed by the user, unless `/x write on --no-confirm` was set.
 */
export async function runPost(
	deps: ToolDeps,
	p: { text: string; reply_to?: string; quote?: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	confirm?: ConfirmSend,
	pick?: PickAccount,
): Promise<ToolOutput> {
	const text = (p.text ?? "").trim();
	if (!text) throw new XError("invalid_input", "Post text is empty");
	if (text.length > MAX_TEXT) throw new XError("invalid_input", `Post is ${text.length} characters; max ${MAX_TEXT}`);
	requireWriteAccess(deps);
	const cfg = readConfig(deps);
	if (!confirm && !cfg.writeNoConfirm) {
		throw new XError(
			"write_disabled",
			"Posting needs your confirmation, and there is no interactive UI here",
			"Post from the Pi TUI, or allow unconfirmed posts with /x write on --no-confirm",
		);
	}

	const replyTo = p.reply_to ? parseTweetId(p.reply_to) : null;
	const quoteUrl = p.quote ? `https://x.com/i/status/${parseTweetId(p.quote)}` : null;

	const a = await personalAccount(deps, p.account, pick);
	const from = `@${a.handle ?? a.name}`;
	const result = await deps.locks.run(a.name, async () => {
		if (confirm && !cfg.writeNoConfirm) {
			const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
			const kind = replyTo ? `reply to ${replyTo}` : quoteUrl ? "quote tweet" : "post";
			const ok = await confirm(`${kind} from ${from}?`, preview);
			if (!ok) return null;
		}

		progress?.("posting…");
		const vars: Record<string, unknown> = {
			tweet_text: text,
			dark_request: false,
			media: { media_entities: [], possibly_sensitive: false },
			semantic_annotation_ids: [],
		};
		if (replyTo) {
			vars.reply = { in_reply_to_tweet_id: replyTo, exclude_reply_user_ids: [] };
		}
		if (quoteUrl) {
			vars.attachment_url = quoteUrl;
		}
		const data = await deps.engine.graphql(a, "CreateTweet", vars, { signal, method: "POST", once: true });
		return data;
	});

	if (!result) {
		return { text: `✗ Not posted — you declined.`, details: { account: a.name, sent: false } };
	}

	// Try to extract the new tweet id
	const tweetResult = (result as any)?.data?.create_tweet?.tweet_results?.result;
	const newId = tweetResult?.rest_id ?? null;
	const url = newId ? `https://x.com/${a.handle ?? a.name}/status/${newId}` : null;

	return {
		text: `✓ Posted from ${from}.${url ? ` ${url}` : ""}`,
		details: { account: a.name, sent: true, id: newId, url, reply_to: replyTo, quote: quoteUrl },
	};
}

/**
 * Like a tweet. Same safety rules: write-gated, single account, once, confirmed.
 */
export async function runLike(
	deps: ToolDeps,
	p: { id_or_url: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	confirm?: ConfirmSend,
	pick?: PickAccount,
): Promise<ToolOutput> {
	requireWriteAccess(deps);
	const cfg = readConfig(deps);
	const id = parseTweetId(p.id_or_url);
	const a = await personalAccount(deps, p.account, pick);
	const from = `@${a.handle ?? a.name}`;

	if (confirm && !cfg.writeNoConfirm) {
		const ok = await confirm(`Like post ${id} from ${from}?`, `https://x.com/i/status/${id}`);
		if (!ok) return { text: `✗ Not liked — you declined.`, details: { account: a.name, liked: false } };
	}

	progress?.("liking…");
	await deps.locks.run(a.name, () =>
		deps.engine.graphql(a, "FavoriteTweet", { tweet_id: id }, { signal, method: "POST", once: true }),
	);
	return { text: `✓ Liked post ${id} from ${from}.`, details: { account: a.name, liked: true, id } };
}

/**
 * Retweet a tweet. Same safety rules.
 */
export async function runRetweet(
	deps: ToolDeps,
	p: { id_or_url: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	confirm?: ConfirmSend,
	pick?: PickAccount,
): Promise<ToolOutput> {
	requireWriteAccess(deps);
	const cfg = readConfig(deps);
	const id = parseTweetId(p.id_or_url);
	const a = await personalAccount(deps, p.account, pick);
	const from = `@${a.handle ?? a.name}`;

	if (confirm && !cfg.writeNoConfirm) {
		const ok = await confirm(`Retweet post ${id} from ${from}?`, `https://x.com/i/status/${id}`);
		if (!ok) return { text: `✗ Not retweeted — you declined.`, details: { account: a.name, retweeted: false } };
	}

	progress?.("retweeting…");
	await deps.locks.run(a.name, () =>
		deps.engine.graphql(a, "CreateRetweet", { tweet_id: id }, { signal, method: "POST", once: true }),
	);
	return { text: `✓ Retweeted post ${id} from ${from}.`, details: { account: a.name, retweeted: true, id } };
}

/**
 * Bookmark a tweet. Same safety rules.
 */
export async function runBookmarkAdd(
	deps: ToolDeps,
	p: { id_or_url: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	confirm?: ConfirmSend,
	pick?: PickAccount,
): Promise<ToolOutput> {
	requireWriteAccess(deps);
	const cfg = readConfig(deps);
	const id = parseTweetId(p.id_or_url);
	const a = await personalAccount(deps, p.account, pick);
	const from = `@${a.handle ?? a.name}`;

	if (confirm && !cfg.writeNoConfirm) {
		const ok = await confirm(`Bookmark post ${id} from ${from}?`, `https://x.com/i/status/${id}`);
		if (!ok) return { text: `✗ Not bookmarked — you declined.`, details: { account: a.name, bookmarked: false } };
	}

	progress?.("bookmarking…");
	await deps.locks.run(a.name, () =>
		deps.engine.graphql(a, "CreateBookmark", { tweet_id: id }, { signal, method: "POST", once: true }),
	);
	return { text: `✓ Bookmarked post ${id} from ${from}.`, details: { account: a.name, bookmarked: true, id } };
}
