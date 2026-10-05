import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { XError } from "./errors.ts";

export interface Account {
	name: string;
	/** Absolute profile dir, or a Chrome profile name such as "Default". Omitted → managed dir. */
	profile?: string;
	enabled: boolean;
	proxy?: string;
	/** X handle confirmed at login / doctor time. */
	handle?: string;
	lastUsed?: number;
}

export interface Config {
	version: 1;
	accounts: Account[];
	active?: string;
	trendsLocation?: string;
}

export interface Paths {
	dataDir: string;
	configFile: string;
	profilesDir: string;
	stateDir: string;
}

export interface LoadResult {
	config: Config;
	warnings: string[];
	migrated: boolean;
}

export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED = new Set(["all", "auto", "help", "off", "status"]);

export function paths(agentDir: string): Paths {
	const dataDir = join(agentDir, "pi-x");
	return {
		dataDir,
		configFile: join(dataDir, "config.json"),
		profilesDir: join(dataDir, "profiles"),
		stateDir: join(dataDir, "state"),
	};
}

export function defaultConfig(): Config {
	return { version: 1, accounts: [{ name: "default", enabled: true }] };
}

export function validateAccountName(name: string, existing: Account[] = []): string | null {
	if (!NAME_RE.test(name)) return "Account names use letters, numbers, _ or - (max 32 characters)";
	if (RESERVED.has(name.toLowerCase())) return `"${name}" is reserved`;
	if (existing.some((a) => a.name.toLowerCase() === name.toLowerCase())) return `Account "${name}" already exists`;
	return null;
}

export function validateConfig(raw: unknown): Config {
	const bad = (why: string) => new XError("invalid_input", `Invalid pi-x config: ${why}`);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("not an object");
	const r = raw as Record<string, unknown>;
	if (!Array.isArray(r.accounts)) throw bad("accounts must be an array");
	const accounts: Account[] = [];
	const seen = new Set<string>();
	for (const item of r.accounts as unknown[]) {
		const o = (item ?? {}) as Record<string, unknown>;
		if (typeof o.name !== "string" || !NAME_RE.test(o.name)) throw bad("account with invalid name");
		const key = o.name.toLowerCase();
		if (seen.has(key)) throw bad(`duplicate account "${o.name}"`);
		seen.add(key);
		const a: Account = { name: o.name, enabled: o.enabled !== false };
		if (typeof o.profile === "string" && o.profile) a.profile = o.profile;
		if (typeof o.proxy === "string" && o.proxy) a.proxy = o.proxy;
		if (typeof o.handle === "string" && o.handle) a.handle = o.handle;
		if (typeof o.lastUsed === "number" && Number.isFinite(o.lastUsed)) a.lastUsed = o.lastUsed;
		accounts.push(a);
	}
	if (!accounts.length) accounts.push({ name: "default", enabled: true });
	const cfg: Config = { version: 1, accounts };
	if (typeof r.active === "string" && accounts.some((a) => a.name === r.active)) cfg.active = r.active;
	if (typeof r.trendsLocation === "string" && r.trendsLocation.trim()) cfg.trendsLocation = r.trendsLocation.trim();
	return cfg;
}

function tryChmod(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Windows / not the owner: best effort
	}
}

export function ensureDirs(p: Paths): void {
	for (const d of [p.dataDir, p.profilesDir, p.stateDir]) {
		mkdirSync(d, { recursive: true, mode: 0o700 });
		tryChmod(d, 0o700);
	}
}

export function saveConfig(p: Paths, cfg: Config): void {
	ensureDirs(p);
	const tmp = `${p.configFile}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
	tryChmod(tmp, 0o600);
	renameSync(tmp, p.configFile);
}

export function loadConfig(p: Paths, legacyHome?: string): LoadResult {
	const warnings: string[] = [];
	if (!existsSync(p.configFile)) {
		const migrated = legacyHome ? migrateLegacy(p, legacyHome, warnings) : null;
		const config = migrated ?? defaultConfig();
		saveConfig(p, config);
		return { config, warnings, migrated: migrated != null };
	}
	try {
		return { config: validateConfig(JSON.parse(readFileSync(p.configFile, "utf8"))), warnings, migrated: false };
	} catch (e) {
		const backup = `${p.configFile}.bak-${Date.now()}`;
		renameSync(p.configFile, backup);
		warnings.push(`pi-x config was unreadable (${(e as Error).message}); moved it to ${backup} and started fresh`);
		const config = defaultConfig();
		saveConfig(p, config);
		return { config, warnings, migrated: false };
	}
}

/** Read-modify-write helper. */
export function updateConfig(p: Paths, fn: (c: Config) => void): Config {
	const c = loadConfig(p).config;
	fn(c);
	const valid = validateConfig(c);
	saveConfig(p, valid);
	return valid;
}

export function updateAccount(p: Paths, name: string, patch: Partial<Account>): Config {
	return updateConfig(p, (c) => {
		const a = c.accounts.find((x) => x.name.toLowerCase() === name.toLowerCase());
		if (!a) throw new XError("invalid_input", `Unknown X account "${name}"`);
		Object.assign(a, patch);
		for (const k of Object.keys(patch) as (keyof Account)[]) if (patch[k] === undefined) delete a[k];
	});
}

export function profileFor(p: Paths, a: Account): string {
	return a.profile ?? join(p.profilesDir, a.name);
}

/** True when `p` is a direct child of `base` (never `base` itself, a sibling, or a deeper path). */
function isDirectChild(base: string, p: string): boolean {
	const r = relative(base, p);
	return !!r && !r.startsWith("..") && !isAbsolute(r) && !r.includes(sep);
}

/** True when pi-x owns the profile dir (safe to delete on logout). */
export function isManagedProfile(p: Paths, a: Account, legacyHome?: string): boolean {
	const dir = profileFor(p, a);
	if (!isAbsolute(dir)) return false;
	const abs = resolve(dir);
	return isDirectChild(resolve(p.profilesDir), abs) || (!!legacyHome && isDirectChild(resolve(legacyHome, ".pi", "x-insights", "profiles"), abs));
}

export function statePath(p: Paths, name: string): string {
	return join(p.stateDir, `${name}.json`);
}

/** One-time import of the pre-1.0 config (~/.pi/x-insights.json). Profiles are referenced in place. */
export function migrateLegacy(p: Paths, legacyHome: string, warnings: string[]): Config | null {
	const legacyFile = join(legacyHome, ".pi", "x-insights.json");
	const legacyDir = join(legacyHome, ".pi", "x-insights");
	if (!existsSync(legacyFile)) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(legacyFile, "utf8"));
	} catch {
		warnings.push(`Ignored unreadable legacy config ${legacyFile}`);
		return null;
	}
	const list = (Array.isArray(raw.accounts) && raw.accounts.length ? raw.accounts : [{ name: "default" }]) as Record<string, unknown>[];
	const accounts: Account[] = [];
	for (const o of list) {
		const name = o.name;
		if (typeof name !== "string" || !NAME_RE.test(name)) continue;
		if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue;
		const a: Account = { name, enabled: o.enabled !== false };
		const legacyProfile = typeof o.profile === "string" && o.profile ? o.profile : join(legacyDir, "profiles", name);
		if (!isAbsolute(legacyProfile)) a.profile = legacyProfile;
		else if (existsSync(legacyProfile)) {
			a.profile = legacyProfile;
			tryChmod(legacyProfile, 0o700);
		}
		if (typeof o.proxy === "string" && o.proxy) a.proxy = o.proxy;
		accounts.push(a);
	}
	const cfg = validateConfig({ accounts, active: raw.active });
	ensureDirs(p);
	const legacyState = join(legacyDir, "state");
	if (existsSync(legacyState)) {
		for (const f of readdirSync(legacyState)) {
			if (!f.endsWith(".json")) continue;
			const src = join(legacyState, f);
			tryChmod(src, 0o600);
			const dst = join(p.stateDir, f);
			if (!existsSync(dst)) {
				copyFileSync(src, dst);
				tryChmod(dst, 0o600);
			}
		}
	}
	if (raw.socialdataApiKey) {
		warnings.push("SocialData support was removed in pi-x 1.0 — the key in ~/.pi/x-insights.json is no longer used and can be deleted");
	}
	warnings.push(`Migrated ${cfg.accounts.length} X account(s) from ${legacyFile}`);
	return cfg;
}
