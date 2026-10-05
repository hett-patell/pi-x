import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXES, XError, toXError } from "../extensions/pi-x/errors.ts";
import { abortableSleep, clamp, unique } from "../extensions/pi-x/util.ts";

test("XError carries code, default fix, rotatable flag", () => {
	const e = new XError("rate_limited", "slow down");
	assert.equal(e.code, "rate_limited");
	assert.equal(e.fix, FIXES.rate_limited);
	assert.equal(e.rotatable, true);
	assert.deepEqual(e.toJSON(), { code: "rate_limited", message: "slow down", fix: FIXES.rate_limited });
	assert.equal(new XError("not_found", "x").rotatable, false);
	assert.equal(new XError("invalid_input", "x", "custom").fix, "custom");
});

test("toXError maps AbortError and unknown errors", () => {
	const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
	assert.equal(toXError(abort).code, "aborted");
	assert.equal(toXError(new Error("boom")).code, "network");
	const x = new XError("timeout", "t");
	assert.equal(toXError(x), x);
});

test("utils", async () => {
	assert.equal(clamp(500, 1, 300), 300);
	assert.equal(clamp(-1, 1, 300), 1);
	assert.equal(clamp(Number.NaN, 1, 300), 1);
	assert.deepEqual(unique(["a", "b", "a", ""]), ["a", "b"]);
	const ctrl = new AbortController();
	const p = abortableSleep(10_000, ctrl.signal);
	ctrl.abort();
	await assert.rejects(p, (e: unknown) => (e as XError).code === "aborted");
	await abortableSleep(1);
});
