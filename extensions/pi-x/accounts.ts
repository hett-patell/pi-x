import type { Account, Config } from "./config.ts";
import { XError } from "./errors.ts";

/** Find an account by its pi-x name, or by its X @handle. Names win over handles. */
export function findAccount(cfg: Config, name: string): Account | undefined {
	const n = (name ?? "").trim().replace(/^@/, "").toLowerCase();
	if (!n) return undefined;
	return cfg.accounts.find((a) => a.name.toLowerCase() === n) ?? cfg.accounts.find((a) => a.handle?.toLowerCase() === n);
}

/** "default (@alice), work (not connected)" — for error fixes. */
export function accountList(cfg: Config): string {
	return cfg.accounts.map((a) => `${a.name} (${a.handle ? `@${a.handle}` : "not connected"})`).join(", ") || "none";
}

/** Candidate order for a tool call: explicit account; else active first, then least-recently-used. */
export function orderAccounts(cfg: Config, requested?: string): Account[] {
	if (requested) {
		const a = findAccount(cfg, requested);
		if (!a) throw new XError("invalid_input", `Unknown X account "${requested}"`, `Your accounts: ${accountList(cfg)}. Add one with /x add <name>`);
		return [a];
	}
	const enabled = cfg.accounts.filter((a) => a.enabled);
	if (!enabled.length) throw new XError("not_logged_in", "All X accounts are disabled", "Enable one with /x enable <account>");
	return [...enabled].sort((a, b) => {
		if (a.name === cfg.active) return -1;
		if (b.name === cfg.active) return 1;
		return (a.lastUsed ?? 0) - (b.lastUsed ?? 0);
	});
}

export function maskProxy(url: string | undefined): string | undefined {
	if (!url) return url;
	try {
		const u = new URL(url);
		if (u.username) u.username = "***";
		if (u.password) u.password = "***";
		return u.toString().replace(/\/$/, "");
	} catch {
		return url.replace(/\/\/[^@/]*@/, "//***:***@");
	}
}

export function scrubSecrets(text: string, cfg: Config): string {
	let out = text;
	for (const a of cfg.accounts) {
		const masked = maskProxy(a.proxy);
		if (a.proxy && masked && masked !== a.proxy) out = out.split(a.proxy).join(masked);
	}
	return out.replace(/\b(auth_token|ct0)=([^;\s"&]+)/g, "$1=***");
}
