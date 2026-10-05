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

export async function runDm(
	deps: ToolDeps,
	p: { to: string; text: string; account?: string },
	signal?: AbortSignal,
	progress?: Progress,
): Promise<ToolOutput> {
	const handle = parseUsername(p.to);
	const text = (p.text ?? "").trim();
	if (!text) throw new XError("invalid_input", "Message text is empty");
	if (text.length > MAX_TEXT) throw new XError("invalid_input", `Message is ${text.length} characters; max ${MAX_TEXT}`);
	if (!readConfig(deps).write) {
		throw new XError("write_disabled", "Direct messages are disabled (pi-x is read-only by default). Run /x write on to enable.");
	}

	const { value, account } = await withAccount(deps, p.account, signal, async (a) => {
		progress?.("resolving recipient…");
		const user = parseUser(await deps.engine.graphql(a, "UserByScreenName", { screen_name: handle }, { signal }));
		if (!user) throw new XError("not_found", `@${handle} not found (suspended, renamed, or never existed)`);
		if (!/^\d+$/.test(user.id)) throw new XError("api_changed", `@${handle} resolved but no numeric id (got "${user.id}") — X may have changed the user shape`);

		progress?.(`sending DM to @${handle}…`);
		const data = await deps.engine.dm(a, user.id, text, { signal });
		return { handle, conversationId: conversationIdFrom(data) };
	});

	return {
		text: `✓ DM sent to @${handle} from @${account.handle ?? account.name}.`,
		details: { account: account.name, to: handle, conversationId: value.conversationId, text },
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
