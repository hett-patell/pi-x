export type XErrorCode =
	| "browser_missing"
	| "chrome_missing"
	| "profile_busy"
	| "not_logged_in"
	| "account_locked"
	| "rate_limited"
	| "timeout"
	| "aborted"
	| "not_found"
	| "api_changed"
	| "dom_changed"
	| "invalid_input"
	| "network";

export const FIXES: Record<XErrorCode, string> = {
	browser_missing: "Install agent-browser: npm i -g agent-browser && agent-browser install",
	chrome_missing: "Install the browser: agent-browser install  (Linux: agent-browser install --with-deps)",
	profile_busy: "The account's browser profile is open in another Chrome window. Close it (or run /x close) and retry",
	not_logged_in: "Log in with /x login <account>",
	account_locked: "Open x.com for this account in a normal browser, complete X's unlock challenge, then /x login <account>",
	rate_limited: "Wait a few minutes, lower `limit`, or add another account (/x add <name>, then /x login <name>)",
	timeout: "Retry; if it keeps happening run /x doctor (slow network or proxy?)",
	aborted: "Cancelled.",
	not_found: "Check the ID/handle — the post or account may be deleted, protected, or suspended",
	api_changed: "X changed its internal API. Run x_doctor; tools fall back to page scraping where possible",
	dom_changed: "X changed its page layout. Run x_doctor, update pi-x (pi update), or report it at https://github.com/hett-patell/pi-x/issues",
	invalid_input: "Fix the parameters and retry",
	network: "Check your connection/proxy and retry",
};

const ROTATABLE: ReadonlySet<XErrorCode> = new Set<XErrorCode>([
	"not_logged_in",
	"account_locked",
	"rate_limited",
	"timeout",
	"profile_busy",
]);

export class XError extends Error {
	readonly code: XErrorCode;
	readonly fix: string;

	constructor(code: XErrorCode, message: string, fix?: string) {
		super(message);
		this.name = "XError";
		this.code = code;
		this.fix = fix ?? FIXES[code];
	}

	/** Errors tied to one account: the caller may retry with the next account. */
	get rotatable(): boolean {
		return ROTATABLE.has(this.code);
	}

	toJSON(): { code: XErrorCode; message: string; fix: string } {
		return { code: this.code, message: this.message, fix: this.fix };
	}
}

export function toXError(e: unknown): XError {
	if (e instanceof XError) return e;
	const err = e as { name?: string; code?: string; message?: string } | null;
	if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return new XError("aborted", "Operation cancelled");
	if (err?.name === "TimeoutError") return new XError("timeout", err.message ?? "Timed out");
	return new XError("network", err?.message ?? String(e));
}
