import { XError } from "../errors.ts";
import { parseDmInbox, parseDmThread, parseUser } from "../normalize.ts";
import { personalAccount, type PickAccount, readConfig, type Progress, type ToolDeps, type ToolOutput, withAccount } from "./context.ts";
import { parseUsername } from "./user.ts";

const MAX_TEXT = 10_000;

/** First string value under `conversation_id`/`conversationId`, walking nested objects/arrays (cycle-safe). */
function conversationIdFrom(data: unknown): string | null {
	const keys = ["conversation_id", "conversationId"];
	const seen = new Set<unknown>();
	const walk = (o: unknown): string | null => {
		if (o == null || typeof o !== "object" || seen.has(o)) return null;
		seen.add(o);
		if (Array.isArray(o)) {
			for (const item of o) {
				const v = walk(item);
				if (v != null) return v;
			}
			return null;
		}
		for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
			if (keys.includes(k) && typeof v === "string") return v;
			const nested = walk(v);
			if (nested != null) return nested;
		}
		return null;
	};
	return walk(data);
}

/** Asks the human to approve one send. Absent when there is no interactive UI. */
export type ConfirmSend = (title: string, message: string) => Promise<boolean>;

function requireDmAccess(deps: ToolDeps): void {
	if (!readConfig(deps).write) {
		throw new XError("write_disabled", "DM access is off (pi-x is read-only by default). Run /x write on to enable it.");
	}
}

/**
 * Send one DM. Writes are deliberately different from reads:
 * - exactly one account (see personalAccount: named, only, pinned, chosen, or asked) — never rotated;
 * - the send runs once — no re-run after a failed page script, no rate-limit retry (no duplicates);
 * - every send is confirmed by the user, unless `/x write on --no-confirm` was set.
 */
export async function runDm(
	deps: ToolDeps,
	p: { to: string; text: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	confirm?: ConfirmSend,
	pick?: PickAccount,
): Promise<ToolOutput> {
	const handle = parseUsername(p.to);
	const text = (p.text ?? "").trim();
	if (!text) throw new XError("invalid_input", "Message text is empty");
	if (text.length > MAX_TEXT) throw new XError("invalid_input", `Message is ${text.length} characters; max ${MAX_TEXT}`);
	requireDmAccess(deps);
	const cfg = readConfig(deps);
	if (!confirm && !cfg.writeNoConfirm) {
		throw new XError(
			"write_disabled",
			"Sending a DM needs your confirmation, and there is no interactive UI here",
			"Send it from the Pi TUI, or allow unconfirmed sends with /x write on --no-confirm",
		);
	}

	const a = await personalAccount(deps, p.account, pick);
	const from = `@${a.handle ?? a.name}`;
	const result = await deps.locks.run(a.name, async () => {
		progress?.("resolving recipient…");
		const user = parseUser(await deps.engine.graphql(a, "UserByScreenName", { screen_name: handle }, { signal }));
		if (!user) throw new XError("not_found", `@${handle} not found (suspended, renamed, or never existed)`);
		if (!/^\d+$/.test(user.id)) throw new XError("api_changed", `@${handle} resolved but no numeric id (got "${user.id}") — X may have changed the user shape`);

		if (confirm && !cfg.writeNoConfirm) {
			const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
			const ok = await confirm(`Send DM from ${from} to @${user.handle}?`, preview);
			if (!ok) return null;
		}

		progress?.(`sending DM to @${user.handle}…`);
		const data = await deps.engine.dm(a, user.id, text, { signal });
		return { handle: user.handle, conversationId: conversationIdFrom(data) };
	});

	if (!result) {
		return { text: `✗ Not sent — you declined the DM to @${handle}.`, details: { account: a.name, to: handle, sent: false } };
	}
	return {
		text: `✓ DM sent to @${result.handle} from ${from}.`,
		details: { account: a.name, to: result.handle, sent: true, conversationId: result.conversationId, text },
	};
}

function relTime(iso: string | null): string {
	if (!iso) return "";
	const ms = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(ms)) return "";
	const m = Math.round(ms / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

export async function runDmInbox(
	deps: ToolDeps,
	p: { account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	pick?: PickAccount,
): Promise<ToolOutput> {
	requireDmAccess(deps);
	const pinned = await personalAccount(deps, p.account, pick);
	const { value, account } = await withAccount(deps, pinned.name, signal, async (a) => {
		progress?.("loading inbox…");
		const viewer = await deps.engine.viewer(a, { signal });
		const data = await deps.engine.dmInbox(a, { signal });
		return { conversations: parseDmInbox(data, viewer?.id ?? "") };
	});
	const convs = value.conversations;
	const unread = convs.filter((c) => c.unread).length;
	const lines = [`DM inbox — @${account.handle ?? account.name}`, `${convs.length} conversations · ${unread} unread`, ""];
	for (const c of convs) {
		const who = c.last_sender === "you" ? "you" : `@${c.last_sender ?? c.handle}`;
		const snippet = c.last_text ? (c.last_text.length > 80 ? `${c.last_text.slice(0, 80)}…` : c.last_text) : "(no messages)";
		lines.push(`${c.unread ? "●" : "○"} @${c.handle}${c.unread ? " — unread" : ""}`);
		if (c.last_text) lines.push(`   ${who}: "${snippet}"${c.last_at ? ` · ${relTime(c.last_at)}` : ""}`);
	}
	if (!convs.length) lines.push("(no DM conversations)");
	return { text: lines.join("\n"), details: { account: account.name, conversations: convs } };
}

/** Read the full message thread for a 1:1 DM conversation. */
export async function runDmThread(
	deps: ToolDeps,
	p: { with: string; limit?: number; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	pick?: PickAccount,
): Promise<ToolOutput> {
	requireDmAccess(deps);
	const handle = parseUsername(p.with);
	const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
	const pinned = await personalAccount(deps, p.account, pick);

	const { value, account } = await withAccount(deps, pinned.name, signal, async (a) => {
		// 1. Get viewer id
		progress?.("loading viewer…");
		const viewer = await deps.engine.viewer(a, { signal });
		const selfId = viewer?.id ?? "";

		// 2. Find conversation id from inbox
		progress?.("finding conversation…");
		const user = parseUser(await deps.engine.graphql(a, "UserByScreenName", { screen_name: handle }, { signal }));
		if (!user) throw new XError("not_found", `@${handle} not found`);

		const inboxData = await deps.engine.dmInbox(a, { signal });
		const convs = parseDmInbox(inboxData, selfId);
		// Match by user id in conversation id (format: "smallerId-largerId")
		let convId: string | null = null;
		for (const c of convs) {
			if (c.handle.toLowerCase() === handle.toLowerCase()) {
				convId = c.id;
				break;
			}
		}
		if (!convId) {
			// Try constructing it from user ids
			const ids = [selfId, user.id].sort((a, b) => Number(BigInt(a) - BigInt(b)) || a.localeCompare(b));
			convId = `${ids[0]}-${ids[1]}`;
		}

		// 3. Fetch conversation messages
		progress?.("loading messages…");
		const data = await deps.engine.dmConversation(a, convId, { signal });
		const { messages, users } = parseDmThread(data);

		return { messages: messages.slice(-limit), users, selfId, otherHandle: user.handle };
	});

	const msgs = value.messages;
	const from = `@${account.handle ?? account.name}`;
	const lines = [`DM thread with @${value.otherHandle} — ${from}`, `${msgs.length} messages${msgs.length >= limit ? " (showing latest)" : ""}`, ""];
	for (const m of msgs) {
		const who = m.sender_id === value.selfId ? "you" : `@${m.sender_handle}`;
		const time = m.created_at ? m.created_at.slice(0, 16).replace("T", " ") : "?";
		lines.push(`[${time}] ${who}: ${m.text}`);
		for (const url of m.media_urls) lines.push(`   📎 ${url}`);
	}
	if (!msgs.length) lines.push("(no messages found)");
	return { text: lines.join("\n"), details: { account: account.name, with: value.otherHandle, messages: msgs } };
}
