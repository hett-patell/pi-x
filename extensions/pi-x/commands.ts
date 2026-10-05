import { chmodSync, rmSync } from "node:fs";
import { findAccount, maskProxy } from "./accounts.ts";
import { sessionName } from "./browser.ts";
import { type Config, isManagedProfile, profileFor, statePath, updateAccount, updateConfig, validateAccountName } from "./config.ts";
import { toXError, XError } from "./errors.ts";
import { readConfig, type ToolDeps } from "./tools/context.ts";
import { runDoctor } from "./tools/doctor.ts";

export interface CommandUI {
	hasUI: boolean;
	say(text: string, level?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	setStatus(text: string | undefined): void;
}

interface Sub {
	name: string;
	usage: string;
	help: string;
	takesAccount?: boolean;
}

export const SUBCOMMANDS: Sub[] = [
	{ name: "status", usage: "/x status", help: "Accounts, login state, rotation, trends location" },
	{ name: "login", usage: "/x login [account]", help: "Connect an X account (opens a browser window)", takesAccount: true },
	{ name: "logout", usage: "/x logout [account]", help: "Disconnect and delete the account's browser profile", takesAccount: true },
	{ name: "add", usage: "/x add <name>", help: "Add another X account slot" },
	{ name: "remove", usage: "/x remove <account>", help: "Remove an account (browser profile kept on disk)", takesAccount: true },
	{ name: "use", usage: "/x use <account|auto>", help: "Pin the account tools use (auto = rotate)", takesAccount: true },
	{ name: "enable", usage: "/x enable <account>", help: "Include an account in rotation", takesAccount: true },
	{ name: "disable", usage: "/x disable <account>", help: "Exclude an account from rotation", takesAccount: true },
	{ name: "proxy", usage: "/x proxy <account> [url|off]", help: "Set or clear an account's proxy", takesAccount: true },
	{ name: "import-chrome", usage: "/x import-chrome <account>", help: "Reuse your desktop Chrome login for an account", takesAccount: true },
	{ name: "location", usage: "/x location [place|default]", help: "Default region for x_trending" },
	{ name: "doctor", usage: "/x doctor", help: "Full health check with fixes" },
	{ name: "backup", usage: "/x backup [account]", help: "Save the account's login state to a file (0600)", takesAccount: true },
	{ name: "restore", usage: "/x restore [account]", help: "Restore a saved login state", takesAccount: true },
	{ name: "close", usage: "/x close", help: "Close all pi-x browser windows" },
	{ name: "help", usage: "/x help", help: "Show all commands" },
];

const POPULAR_PLACES = ["default", "worldwide", "United States", "India", "United Kingdom", "Japan", "Canada", "Germany", "France", "Brazil", "Australia"];
const LOGIN_METHOD_WORDS = new Set(["manual", "password", "google", "apple"]);

const LEGACY: [RegExp, (m: RegExpMatchArray) => string][] = [
	[/^accounts?(?: list)?$/i, () => "status"],
	[/^account add (\S+)$/i, (m) => `add ${m[1]}`],
	[/^account (?:remove|rm) (\S+)$/i, (m) => `remove ${m[1]}`],
	[/^account active (\S+)$/i, (m) => `use ${m[1]}`],
	[/^account chrome (\S+)$/i, (m) => `import-chrome ${m[1]}`],
	[/^account proxy (\S+) (\S+)$/i, (m) => `proxy ${m[1]} ${m[2]}`],
	[/^account noproxy (\S+)$/i, (m) => `proxy ${m[1]} off`],
	[/^login check(?: \S+)?$/i, () => "doctor"],
	[/^login clear$/i, () => "status"],
	[/^state (save|restore)(?: (\S+))?$/i, (m) => `${m[1].toLowerCase() === "save" ? "backup" : "restore"}${m[2] ? ` ${m[2]}` : ""}`],
	[/^keepalive(?: \S+)?$/i, () => "status"],
];

export function parseCommand(input: string): { name: string; args: string[]; legacyFrom?: string } {
	const raw = (input ?? "").trim().replace(/\s+/g, " ");
	if (!raw) return { name: "status", args: [] };
	for (const [re, to] of LEGACY) {
		const m = raw.match(re);
		if (m) return { ...parseCommand(to(m)), legacyFrom: raw };
	}
	const [name, ...args] = raw.split(" ");
	return { name: name.toLowerCase(), args };
}

export function completeArgs(prefix: string, accounts: string[]): { value: string; label: string; description?: string }[] | null {
	const parts = prefix.replace(/^\s+/, "").split(" ");
	if (parts.length <= 1) {
		const p = (parts[0] ?? "").toLowerCase();
		const items = SUBCOMMANDS.filter((s) => s.name.startsWith(p)).map((s) => ({ value: s.name, label: s.name, description: s.help }));
		return items.length ? items : null;
	}
	const sub = SUBCOMMANDS.find((s) => s.name === parts[0].toLowerCase());
	if (!sub || parts.length !== 2) return null;
	const p = parts[1].toLowerCase();
	const pool = sub.name === "location" ? POPULAR_PLACES : sub.takesAccount ? [...accounts, ...(sub.name === "use" ? ["auto"] : [])] : [];
	const items = pool.filter((x) => x.toLowerCase().startsWith(p)).map((x) => ({ value: `${sub.name} ${x}`, label: x }));
	return items.length ? items : null;
}

export function footerText(cfg: Config): string {
	const enabled = cfg.accounts.filter((a) => a.enabled);
	const connected = enabled.filter((a) => a.handle).length;
	return connected ? `𝕏 ${connected}/${enabled.length}` : "𝕏 ⚠ /x login";
}

const ago = (ms: number) => {
	const m = Math.round(ms / 60_000);
	return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function statusText(deps: ToolDeps, running: string[]): string {
	const cfg = readConfig(deps);
	const width = Math.max(...cfg.accounts.map((a) => a.name.length), 8);
	const rows = cfg.accounts.map((a) => {
		const bits = [
			a.handle ? `@${a.handle}` : "not connected",
			...(a.enabled ? [] : ["[disabled]"]),
			...(running.includes(sessionName(a)) ? ["● browser open"] : []),
			...(a.proxy ? [`proxy ${maskProxy(a.proxy)}`] : []),
			...(a.lastUsed ? [`used ${ago(deps.now() - a.lastUsed)}`] : []),
		];
		return `  ${cfg.active === a.name ? "★" : " "} ${a.name.padEnd(width)}  ${bits.join(" · ")}`;
	});
	const connected = cfg.accounts.some((a) => a.enabled && a.handle);
	return [
		"𝕏 pi-x status",
		"",
		"Accounts:",
		...rows,
		"",
		`Rotation:        ${cfg.active ? `pinned to "${cfg.active}" (/x use auto to rotate)` : "auto — least-recently-used first"}`,
		`Trends location: ${cfg.trendsLocation ?? "account default (personalized Explore)"}`,
		`agent-browser:   ${deps.binary ? deps.binary.file : "NOT FOUND → npm i -g agent-browser && agent-browser install"}`,
		"",
		connected ? 'Try asking: "What\'s trending on X right now, and why?"  ·  /x doctor re-checks everything live' : "Next: /x login  — connect an X account (Google / Apple / password all work)",
	].join("\n");
}

async function pickAccount(deps: ToolDeps, ui: CommandUI, arg: string | undefined, verb: string): Promise<string | undefined> {
	const cfg = readConfig(deps);
	if (arg) {
		const a = findAccount(cfg, arg);
		if (!a) throw new XError("invalid_input", `No account named "${arg}"`, `Add it with /x add ${arg}, or see /x status`);
		return a.name;
	}
	if (cfg.accounts.length === 1) return cfg.accounts[0].name;
	if (!ui.hasUI) throw new XError("invalid_input", `Which account? Usage: /x ${verb} <account>`);
	return ui.select(`${verb[0].toUpperCase()}${verb.slice(1)} which X account?`, cfg.accounts.map((a) => a.name));
}

/** One login watcher per account (per deps): a new /x login cancels the previous one. */
const loginWatchers = new WeakMap<ToolDeps, Map<string, AbortController>>();

function cancelLoginWatch(deps: ToolDeps, name: string): void {
	loginWatchers.get(deps)?.get(name.toLowerCase())?.abort();
}

function watchLogin(deps: ToolDeps, ui: CommandUI, name: string): Promise<void> {
	const a = findAccount(readConfig(deps), name);
	if (!a) return Promise.resolve();
	const byName = loginWatchers.get(deps) ?? new Map<string, AbortController>();
	loginWatchers.set(deps, byName);
	const key = a.name.toLowerCase();
	byName.get(key)?.abort();
	const ctl = new AbortController();
	byName.set(key, ctl);
	const { signal } = ctl;
	/** One poll under the account lock: never relaunches a browser the user closed. */
	const poll = async (): Promise<{ closed?: true; handle?: string } | null> => {
		if (signal.aborted) return null;
		if (!(await deps.sessions.list(signal).catch(() => [] as string[])).includes(sessionName(a))) return { closed: true };
		const v = await deps.engine.viewer(a, { signal }).catch(() => null);
		if (!v || signal.aborted) return null;
		updateAccount(deps.paths, a.name, { handle: v.handle });
		await deps.sessions.close(a);
		return { handle: v.handle };
	};
	return (async () => {
		const deadline = deps.now() + 5 * 60_000;
		for (let first = true; first || deps.now() < deadline; first = false) {
			await deps.sleep(3000, signal).catch(() => undefined);
			if (signal.aborted) return;
			const r = await deps.locks.run(a.name, poll);
			if (r?.handle) {
				ui.say(`✓ "${a.name}" connected as @${r.handle}. Closed the login window — tools will reuse this session in the background.`);
				ui.setStatus(footerText(readConfig(deps)));
				return;
			}
			if (signal.aborted) return;
			if (r?.closed) {
				ui.say(`Login window closed — run /x login ${a.name} to retry.`);
				return;
			}
		}
		ui.say(`✗ Login for "${a.name}" not detected within 5 minutes. Run /x login ${a.name} to try again.`, "warning");
	})()
		.catch((e) => ui.say(`✗ Login watcher failed: ${toXError(e).message}`, "error"))
		.finally(() => {
			if (byName.get(key) === ctl) byName.delete(key);
		});
}

export async function runCommand(input: string, deps: ToolDeps, ui: CommandUI): Promise<void> {
	const cmd = parseCommand(input);
	const [arg0, arg1] = cmd.args;
	try {
		if (cmd.legacyFrom) ui.say(`(“/x ${cmd.legacyFrom}” is now “/x ${[cmd.name, ...cmd.args].join(" ")}”)`);
		switch (cmd.name) {
			case "status": {
				const running = deps.binary ? await deps.sessions.list().catch(() => [] as string[]) : [];
				ui.say(statusText(deps, running));
				break;
			}
			case "help":
				ui.say(["𝕏 pi-x commands", ...SUBCOMMANDS.map((s) => `  ${s.usage.padEnd(30)} ${s.help}`)].join("\n"));
				break;
			case "setkey":
			case "clearkey":
				ui.say("SocialData support was removed in pi-x 1.0 — search and profiles now use your logged-in X session for free. Run /x status.", "warning");
				break;
			case "add": {
				const err = validateAccountName(arg0 ?? "", readConfig(deps).accounts);
				if (err) throw new XError("invalid_input", arg0 ? err : "Usage: /x add <name>");
				updateConfig(deps.paths, (c) => {
					c.accounts.push({ name: arg0, enabled: true });
				});
				ui.say(`✓ Added "${arg0}". Next: /x login ${arg0}`);
				break;
			}
			case "remove": {
				const name = await pickAccount(deps, ui, arg0, "remove");
				if (!name) return;
				if (ui.hasUI && !(await ui.confirm(`Remove "${name}"?`, "Its browser profile stays on disk (use /x logout to delete it)."))) return;
				const a = findAccount(readConfig(deps), name);
				if (a) await deps.sessions.close(a);
				updateConfig(deps.paths, (c) => {
					c.accounts = c.accounts.filter((x) => x.name !== name);
					if (!c.accounts.length) c.accounts.push({ name: "default", enabled: true });
					if (c.active === name) delete c.active;
				});
				ui.say(`✓ Removed "${name}"`);
				break;
			}
			case "use": {
				if (arg0?.toLowerCase() === "auto") {
					updateConfig(deps.paths, (c) => {
						delete c.active;
					});
					ui.say("✓ Rotation: auto (least-recently-used account first)");
					break;
				}
				const name = await pickAccount(deps, ui, arg0, "use");
				if (!name) return;
				updateConfig(deps.paths, (c) => {
					c.active = name;
				});
				ui.say(`✓ Tools now use "${name}" (rotate again with /x use auto)`);
				break;
			}
			case "enable":
			case "disable": {
				const name = await pickAccount(deps, ui, arg0, cmd.name);
				if (!name) return;
				updateAccount(deps.paths, name, { enabled: cmd.name === "enable" });
				ui.say(`✓ "${name}" ${cmd.name === "enable" ? "included in" : "excluded from"} rotation`);
				break;
			}
			case "proxy": {
				const name = await pickAccount(deps, ui, arg0, "proxy");
				if (!name) return;
				const a = findAccount(readConfig(deps), name)!;
				if (!arg1) {
					ui.say(a.proxy ? `"${name}" proxy: ${maskProxy(a.proxy)}` : `"${name}" has no proxy. Set one: /x proxy ${name} http://host:port`);
					break;
				}
				if (arg1.toLowerCase() === "off") {
					updateAccount(deps.paths, name, { proxy: undefined });
					await deps.sessions.close(a);
					ui.say(`✓ Cleared proxy for "${name}"`);
					break;
				}
				let ok = false;
				try {
					ok = ["http:", "https:", "socks4:", "socks5:"].includes(new URL(arg1).protocol);
				} catch {
					ok = false;
				}
				if (!ok) throw new XError("invalid_input", "Proxy must be a URL using http, https, socks4 or socks5 (e.g. http://user:pass@host:8080)");
				updateAccount(deps.paths, name, { proxy: arg1 });
				await deps.sessions.close(a);
				ui.say(`✓ "${name}" will use proxy ${maskProxy(arg1)} (applies on next launch)`);
				break;
			}
			case "import-chrome": {
				const name = await pickAccount(deps, ui, arg0, "import-chrome");
				if (!name) return;
				updateAccount(deps.paths, name, { profile: "Default", handle: undefined });
				await deps.sessions.close(findAccount(readConfig(deps), name)!);
				ui.say(`✓ "${name}" now uses your desktop Chrome profile. Close Chrome before using pi-x (Chrome locks its profile), then run /x doctor.`);
				break;
			}
			case "location": {
				let place = cmd.args.join(" ");
				if (!place && ui.hasUI) place = (await ui.select("Default trends location", POPULAR_PLACES)) ?? "";
				if (!place) {
					ui.say(`Trends location: ${readConfig(deps).trendsLocation ?? "account default"}. Set: /x location <place|default>`);
					break;
				}
				updateConfig(deps.paths, (c) => {
					if (/^default$/i.test(place)) delete c.trendsLocation;
					else c.trendsLocation = place;
				});
				ui.say(/^default$/i.test(place) ? "✓ Trends use each account's personalized Explore" : `✓ Trends default to "${place}" (checked on first use)`);
				break;
			}
			case "login": {
				const name = await pickAccount(deps, ui, cmd.args.find((x) => !LOGIN_METHOD_WORDS.has(x.toLowerCase())), "login");
				if (!name) return;
				const a = findAccount(readConfig(deps), name)!;
				cancelLoginWatch(deps, a.name);
				await deps.locks.run(a.name, async () => {
					await deps.sessions.close(a);
					await deps.sessions.launch(a, { headed: true, url: "https://x.com/i/flow/login" });
				});
				ui.say(`Opening X login for "${a.name}" — finish signing in in the browser window (Google, Apple, or password + 2FA). I'll confirm here automatically.`);
				void watchLogin(deps, ui, a.name);
				break;
			}
			case "logout": {
				const name = await pickAccount(deps, ui, arg0, "logout");
				if (!name) return;
				if (!ui.hasUI) {
					ui.say("Logout needs interactive confirmation — run it in the Pi TUI", "warning");
					return;
				}
				const a = findAccount(readConfig(deps), name)!;
				const managed = isManagedProfile(deps.paths, a, deps.legacyHome);
				const msg = managed ? `This deletes ${profileFor(deps.paths, a)} (cookies, login).` : "The profile isn't managed by pi-x, so only the connection is cleared.";
				if (!(await ui.confirm(`Log out "${name}"?`, msg))) return;
				await deps.sessions.close(a);
				if (managed) rmSync(profileFor(deps.paths, a), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
				updateAccount(deps.paths, name, { handle: undefined });
				ui.say(`✓ Logged out "${name}"`);
				break;
			}
			case "doctor": {
				const out = await runDoctor(deps);
				ui.say(out.text, out.isError ? "error" : "info");
				break;
			}
			case "backup":
			case "restore": {
				const name = await pickAccount(deps, ui, arg0, cmd.name);
				if (!name) return;
				const a = findAccount(readConfig(deps), name)!;
				const file = statePath(deps.paths, a.name);
				await deps.locks.run(a.name, async () => {
					await deps.sessions.ensure(a);
					if (cmd.name === "backup") await deps.sessions.saveState(a, file);
					else await deps.sessions.loadState(a, file);
				});
				if (cmd.name === "backup") {
					try {
						chmodSync(file, 0o600);
					} catch {
						// best effort on Windows
					}
				}
				ui.say(cmd.name === "backup" ? `✓ Saved login state → ${file} (keep it private)` : `✓ Restored login state for "${name}" — check with /x doctor`);
				break;
			}
			case "close":
				await deps.sessions.closeAll();
				ui.say("✓ Closed all pi-x browser windows");
				break;
			default:
				ui.say(`Unknown command "/x ${cmd.name}". Try /x help`, "warning");
		}
	} catch (e) {
		const x = toXError(e);
		ui.say(`✗ ${x.message}\n→ ${x.fix}`, "error");
	} finally {
		ui.setStatus(footerText(readConfig(deps)));
	}
}
