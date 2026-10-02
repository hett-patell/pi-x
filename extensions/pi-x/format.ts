import type { Trend, Tweet, XUser } from "./normalize.ts";
import type { Stats } from "./score.ts";

/** Bytes of tool text we produce ourselves; Pi's truncateHead (50KB) is the backstop. */
export const OUTPUT_BUDGET = 40_000;

export function compact(n: number | null | undefined): string {
	if (n == null) return "–";
	const abs = Math.abs(n);
	const units: [number, string][] = [[1e3, "K"], [1e6, "M"], [1e9, "B"]];
	const round = (v: number) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
	let i = units.findLastIndex(([d]) => abs >= d);
	if (i < 0) return String(n);
	// 999_999 rounds to "1000K" → roll over to "1M"
	if (round(abs / units[i][0]) >= 1000 && i < units.length - 1) i++;
	return `${n < 0 ? "-" : ""}${round(abs / units[i][0])}${units[i][1]}`;
}

export function oneLine(s: string, max = 600): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "?");

export function formatTweet(t: Tweet, i?: number): string {
	const m = t.metrics;
	const head = [
		`${i != null ? `[${i}] ` : ""}@${t.author.handle}${t.author.verified ? " ✓" : ""}`,
		when(t.created_at),
		`♥ ${compact(m.likes)} ⟲ ${compact(m.retweets)} ↩ ${compact(m.replies)}`,
		...(m.views != null ? [`${compact(m.views)} views`] : []),
		...(t.score != null ? [`score ${compact(t.score)}`] : []),
		...(t.retweeted_by ? [`RT by @${t.retweeted_by}`] : []),
	].join(" · ");
	const lines = [head, `    ${oneLine(t.text)}`];
	if (t.quoted) lines.push(`    ↪ quoting @${t.quoted.author.handle}: ${oneLine(t.quoted.text, 200)}`);
	lines.push(`    ${t.url}`);
	return lines.join("\n");
}

/** " (12/h)", or per day when sparse (" (~1/day)") — never "0/h". */
function rate(s: Stats): string {
	if (!s.per_hour || !s.hours) return "";
	if (s.per_hour >= 1) return ` (${s.per_hour}/h)`;
	const perDay = (s.count / s.hours) * 24;
	return Math.round(perDay) >= 1 ? ` (~${Math.round(perDay)}/day)` : " (<1/day)";
}

export function formatStats(s: Stats): string {
	if (!s.count) return "Stats: no posts";
	const lines = [
		`Stats: ${s.count} posts${s.hours != null ? ` over ${s.hours}h${rate(s)}` : ""}${s.from ? ` · ${when(s.from)} → ${when(s.to)}` : ""}`,
		`  likes ${compact(s.likes.total)} (median ${compact(s.likes.median)}) · reposts ${compact(s.retweets.total)} · replies ${compact(s.replies.total)}${s.views ? ` · views ${compact(s.views.total)}` : ""}`,
		`  verified authors ${Math.round(s.verified_share * 100)}%${s.duplicates ? ` · ${s.duplicates} copy-paste duplicates collapsed` : ""}`,
	];
	if (s.top_authors.length) lines.push(`  top voices: ${s.top_authors.map((a) => `@${a.handle} (${a.posts}, score ${compact(a.score)})`).join(", ")}`);
	if (s.top_hashtags.length) lines.push(`  hashtags: ${s.top_hashtags.map((h) => `${h.tag}×${h.count}`).join(" ")}`);
	if (s.top_domains.length) lines.push(`  linked sites: ${s.top_domains.map((d) => `${d.domain}×${d.count}`).join(" ")}`);
	if (s.earliest_notable) lines.push(`  earliest notable post: @${s.earliest_notable.author.handle} ${when(s.earliest_notable.created_at)} ${s.earliest_notable.url}`);
	return lines.join("\n");
}

export function formatTrends(title: string, trends: Trend[]): string {
	const rows = trends.map((t) => {
		const bits = [t.age, t.category, t.volume != null ? `${compact(t.volume)} posts` : undefined, t.new ? "NEW" : undefined].filter(Boolean);
		return `${String(t.rank).padStart(2)}. ${t.name}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
	});
	return [title, ...rows].join("\n");
}

export function formatUser(u: XUser): string {
	return [
		`@${u.handle}${u.verified ? " ✓" : ""} — ${u.name}${u.protected ? " 🔒" : ""}`,
		`followers ${compact(u.followers)} · following ${compact(u.following)} · posts ${compact(u.posts)}`,
		...(u.bio ? [`bio: ${oneLine(u.bio, 400)}`] : []),
		...(u.location ? [`location: ${u.location}`] : []),
		...(u.url ? [`link: ${u.url}`] : []),
		...(u.created_at ? [`joined: ${u.created_at.slice(0, 10)}`] : []),
		`https://x.com/${u.handle}`,
	].join("\n");
}

export function fitToBudget(head: string, items: string[], budget = OUTPUT_BUDGET): { text: string; shown: number; omitted: number } {
	const note = (n: number) => `\n\n(+${n} more omitted to save context — full data is in the tool details; narrow with limit/filters)`;
	let text = head;
	let shown = 0;
	for (const item of items) {
		const next = `${text}\n\n${item}`;
		if (Buffer.byteLength(next) + Buffer.byteLength(note(items.length - shown)) > budget) break;
		text = next;
		shown++;
	}
	const omitted = items.length - shown;
	return { text: omitted ? text + note(omitted) : text, shown, omitted };
}
