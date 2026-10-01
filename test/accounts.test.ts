import assert from "node:assert/strict";
import { test } from "node:test";
import { findAccount, maskProxy, orderAccounts, scrubSecrets } from "../extensions/pi-x/accounts.ts";
import type { Config } from "../extensions/pi-x/config.ts";

const cfg = (over: Partial<Config> = {}): Config => ({
	version: 1,
	accounts: [
		{ name: "a", enabled: true, lastUsed: 30 },
		{ name: "b", enabled: true, lastUsed: 10 },
		{ name: "c", enabled: false },
		{ name: "d", enabled: true },
	],
	...over,
});

test("orderAccounts: active first, then least-recently-used, disabled skipped", () => {
	assert.deepEqual(orderAccounts(cfg()).map((a) => a.name), ["d", "b", "a"]);
	assert.deepEqual(orderAccounts(cfg({ active: "a" })).map((a) => a.name), ["a", "d", "b"]);
	assert.deepEqual(orderAccounts(cfg(), "C").map((a) => a.name), ["c"]);
	assert.throws(() => orderAccounts(cfg(), "zzz"), /Unknown X account/);
	assert.throws(() => orderAccounts({ version: 1, accounts: [{ name: "a", enabled: false }] }), /disabled/);
	assert.equal(findAccount(cfg(), "B")?.name, "b");
});

test("maskProxy hides credentials", () => {
	assert.equal(maskProxy("http://user:pass@1.2.3.4:8080"), "http://***:***@1.2.3.4:8080");
	assert.equal(maskProxy("socks5://1.2.3.4:1080"), "socks5://1.2.3.4:1080");
	assert.equal(maskProxy(undefined), undefined);
});

test("scrubSecrets removes proxy creds and cookie values", () => {
	const c: Config = { version: 1, accounts: [{ name: "a", enabled: true, proxy: "http://user:pass@h:1" }] };
	const out = scrubSecrets("via http://user:pass@h:1 with auth_token=abc123; ct0=zzz", c);
	assert.equal(out, "via http://***:***@h:1 with auth_token=***; ct0=***");
});
