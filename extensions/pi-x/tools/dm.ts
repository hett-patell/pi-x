import { orderAccounts } from "../accounts.ts";
import { XError } from "../errors.ts";
import { parseDmInbox, parseUser } from "../normalize.ts";
import { readConfig, type Progress, type ToolDeps, type ToolOutput, withAccount } from "./context.ts";
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
 * - exactly one account (named, else active, else first enabled) — never rotated to another account;
 * - the send runs once — no re-run after a failed page script, no rate-limit retry (no duplicates);
 * - every send is confirmed by the user, unless `/x write on --no-confirm` was set.
 */
export async function runDm(
	deps: ToolDeps,
	p: { to: string; text: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
	confirm?: ConfirmSend,
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

	const a = orderAccounts(cfg, p.account)[0];
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
): Promise<ToolOutput> {
	requireDmAccess(deps);
	const { value, account } = await withAccount(deps, p.account, signal, async (a) => {
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
