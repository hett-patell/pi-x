/**
 * Live end-to-end check against real X using your logged-in pi-x account(s). No LLM involved.
 * Usage: npm run smoke   (needs agent-browser on PATH and `/x login` done once)
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createDeps } from "../extensions/pi-x/deps.ts";
import { errorOutput, type ToolOutput } from "../extensions/pi-x/tools/context.ts";
import { runDoctor } from "../extensions/pi-x/tools/doctor.ts";
import { runSearch } from "../extensions/pi-x/tools/search.ts";
import { runTrending } from "../extensions/pi-x/tools/trending.ts";
import { runTweet } from "../extensions/pi-x/tools/tweet.ts";
import { runUser } from "../extensions/pi-x/tools/user.ts";

const deps = createDeps(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
const progress = (m: string) => process.stderr.write(`  … ${m}\n`);
let failed = 0;

async function step(name: string, run: () => Promise<ToolOutput>, expect: RegExp) {
	process.stdout.write(`\n=== ${name}\n`);
	const t0 = Date.now();
	let out: ToolOutput;
	try {
		out = await run();
	} catch (e) {
		out = errorOutput(e);
	}
	const ok = !out.isError && expect.test(out.text);
	if (!ok) failed++;
	process.stdout.write(`${out.text.split("\n").slice(0, 14).join("\n")}\n--- ${ok ? "PASS" : "FAIL"} (${Date.now() - t0} ms, ${Buffer.byteLength(out.text)} bytes)\n`);
}

await step("doctor", () => runDoctor(deps, undefined, progress), /Engine: api/);
await step("trending (personalized + news)", () => runTrending(deps, { limit: 10 }, undefined, progress), /^Trending — /);
await step("trending worldwide", () => runTrending(deps, { location: "worldwide", limit: 5, include_news: false }, undefined, progress), /Worldwide/);
await step("trending drill-down", () => runTrending(deps, { limit: 5, drilldown: 1, include_news: false }, undefined, progress), /Why it's trending/);
await step("search", () => runSearch(deps, { query: "AI agents", type: "Top", limit: 30, min_likes: 20 }, undefined, progress), /Stats: \d+ posts/);
await step("tweet (syndication)", () => runTweet(deps, { id_or_url: "https://x.com/jack/status/20" }, undefined, progress), /just setting up my twttr/);
await step("tweet + replies", () => runTweet(deps, { id_or_url: "20", replies: 10 }, undefined, progress), /Top replies/);
await step("user + posts", () => runUser(deps, { username: "OpenAI", posts: 10 }, undefined, progress), /@OpenAI/);

await deps.sessions.closeAll();
process.stdout.write(`\n${failed ? `✗ ${failed} step(s) failed` : "✓ all smoke steps passed"}\n`);
process.exit(failed ? 1 : 0);
