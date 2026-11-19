import { orderAccounts } from "../accounts.ts";
import { XError } from "../errors.ts";
import { readConfig, type Progress, type ToolDeps, type ToolOutput } from "./context.ts";
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
 * - exactly one account (named, else active, else first enabled) — never rotated;
 * - the post runs once — no re-run after a failed page script, no rate-limit retry;
 * - every post is confirmed by the user, unless `/x write on --no-confirm` was set.
 */
export async function runPost(
	deps: ToolDeps,
	p: { text: string; reply_to?: string; quote?: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	confirm?: ConfirmSend,
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

	const a = orderAccounts(cfg, p.account)[0];
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
