import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FIXES } from "../extensions/pi-x/errors.ts";
import piX, { internalErrorFallback } from "../extensions/pi-x/index.ts";

test("internalErrorFallback: Error input never throws, shape is well-formed", () => {
	const r = internalErrorFallback(new Error("config dir unreadable"));
	assert.deepEqual(r.content, [{ type: "text", text: "✗ pi-x internal error: config dir unreadable" }]);
	assert.equal(r.isError, true);
	assert.deepEqual(r.details, { error: { code: "network", message: "config dir unreadable", fix: FIXES.network } });
});

test("internalErrorFallback: non-Error input is stringified, never throws", () => {
	assert.equal(internalErrorFallback("boom").content[0].text, "✗ pi-x internal error: boom");
	assert.equal(internalErrorFallback(42).content[0].text, "✗ pi-x internal error: 42");
	assert.equal(internalErrorFallback(undefined).content[0].text, "✗ pi-x internal error: undefined");
	assert.equal(internalErrorFallback({ weird: true }).content[0].text, "✗ pi-x internal error: [object Object]");
});

test("internalErrorFallback: output is JSON-safe (no functions/undefined leaking into details)", () => {
	const r = internalErrorFallback(new Error("x"));
	assert.doesNotThrow(() => JSON.stringify(r));
});

test("piX registers the 7 tools, the x command, and session lifecycle handlers", () => {
	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const registeredEvents: string[] = [];
	// Minimal fake ExtensionAPI: piX() only calls registerTool/registerCommand/on during
	// registration (none of the registered closures run here), so this never touches the
	// filesystem or performs any I/O. Cast via unknown since this stub only covers the
	// handful of methods piX() actually calls, not the full ExtensionAPI surface.
	const fakePi = {
		registerTool: (def: { name: string }) => {
			registeredTools.push(def.name);
		},
		registerCommand: (name: string) => {
			registeredCommands.push(name);
		},
		on: (event: string) => {
			registeredEvents.push(event);
			return () => {};
		},
	} as unknown as ExtensionAPI;

	piX(fakePi);

	assert.deepEqual(registeredTools.sort(), ["x_dm", "x_dm_inbox", "x_doctor", "x_search", "x_trending", "x_tweet", "x_user"]);
	assert.deepEqual(registeredCommands, ["x"]);
	assert.ok(registeredEvents.includes("session_start"));
	assert.ok(registeredEvents.includes("session_shutdown"));
});
