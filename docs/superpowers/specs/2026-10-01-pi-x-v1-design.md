# pi-x v1.0 — First-class X extension for Pi

**Date:** 2026-10-01 · **Status:** approved in brainstorming, pending spec review
**Goal:** Let a Pi agent reliably answer "what's trending / hot on X right now, and why?" and
read X in depth (search, tweets + threads, profiles + timelines), for many users on
Linux/macOS/Windows — robust, secure, and easy to set up.

## 1. Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Data engine | **Hybrid**: X's internal GraphQL/REST called *inside* the logged-in agent-browser page (`fetch(..., {credentials:'include'})`), DOM scraping as automatic fallback. Cookies never leave the browser. |
| Scope | Trends + news, richer reading (threads, user timelines, API profiles, pagination), insight helpers (scoring, filters, stats, compact output). |
| SocialData | **Removed.** Single tweets still use the free no-auth syndication feed first. |
| Trend region | Account's personalized Explore by default; per-call `location` override; configurable default via `/x location`. |
| Commands | User-friendly verbs, autocompletion, interactive pickers when args missing, `/x status` dashboard, legacy aliases. |

## 2. Verified feasibility (live probe, 2026-10-01, agent-browser 0.33.2, Pi 0.99.2)

Inside a logged-in `x.com` page:
- `main.*.js` (client-web bundle) contains `queryId:"…",operationName:"…"` pairs (104 ops) and the
  web bearer token; `ct0` is readable from `document.cookie`.
- `POST /i/api/graphql/<id>/SearchTimeline` with `{variables:{rawQuery,count,querySource:'typed_query',product}, features:{}, queryId}` → **200** with results. (GET → 404.)
- `GET ExplorePage` (vars `{cursor:''}`, empty features) → **200**, contains trend names (incl. promoted).
- `GET UserByScreenName` → **200** full profile.
- `GET TweetDetail` with empty features → **422 "must be defined"** → features must be supplied (from page/bundle).
- `GET /i/api/1.1/trends/place.json?id=<WOEID>` → **200** (worldwide=1, US=23424977); `trends/available.json` → **200** (location list).
- DOM: `/explore/tabs/trending` → `[data-testid="trend"]` cells (rank · category · name; promoted cells present); `/explore/tabs/news` → story cells (title · age · category · N posts).
- Not found in main bundle: `HomeLatestTimeline`, `Bookmarks`, `ListLatestTweetsTimeline` (lazy chunks) — out of scope for v1.

## 3. Architecture

Pi loads `extensions/<dir>/index.ts` via jiti (no build step).

```
extensions/pi-x/
  index.ts      wiring: tools, /x command, session_shutdown cleanup, footer status
  config.ts     load/validate/migrate/save config; accounts model
  browser.ts    agent-browser runner (abort, per-account mutex, launch/reuse/close, Windows)
  xapi.ts       in-page API engine: op discovery + cache, call(), retry/backoff, pagination
  dom.ts        DOM fallback extractors (search, trends, news), locale-safe
  normalize.ts  Tweet/User/Trend/NewsItem from GraphQL, legacy v1.1, syndication, DOM
  score.ts      engagement score, ranking, stats block, filters → rawQuery
  format.ts     compact text rendering + truncation to Pi limits
  doctor.ts     health checks, active engine, secret scrubbing
  errors.ts     XError with codes + fix hints
skills/pi-x/SKILL.md   routing, trend-drilldown recipe, insight format, self-repair
test/*.test.ts         unit tests on fixtures (node:test + tsx), no network
scripts/smoke.sh       live end-to-end check via `pi -p`
```

Each module has one job and a small typed interface; only `browser.ts` spawns processes, only
`xapi.ts`/`dom.ts` know X's wire formats, only `index.ts` knows Pi APIs (plus `format.ts` using
Pi's truncation helpers).

### Data flow (every read tool)

1. `pickAccounts(cfg, requested?)` → ordered candidates: explicit account, else active, else
   enabled + logged-in, least-recently-used first (LRU persisted in config `lastUsed`).
2. `withAccountLock(name, fn)` — in-process mutex per account; concurrent calls queue.
3. `ensureSession(acct)` — reuse running session on `https://x.com`; launch with profile/proxy
   if not running.
4. `xapi.call(op, vars)` → on stale op (404/422/"unknown operation") refresh discovery once and
   retry → on failure, `dom.*` fallback where one exists → else `XError('api_changed')`.
5. `normalize` → `score/stats` → `format` (truncate) → tool result
   `{content:[text], details:{…structured, no raw blobs}}`.
6. Account-level failures (`not_logged_in`, `rate_limited`) rotate to the next candidate;
   result notes which accounts were skipped and why.

## 4. Tools

All tools: abort-aware, `onUpdate` progress for multi-step work, output ≤ Pi `DEFAULT_MAX_BYTES`
/ `DEFAULT_MAX_LINES` (truncation notice tells the agent how to narrow), `details` always set,
errors return `isError: true` with `details.error = {code, message, fix}`.

### `x_trending`
Params: `location?: string` (place name or WOEID; omitted → configured default → account's
personalized Explore), `include_news?: boolean = true`, `limit?: number = 20 (≤50)`, `account?`.
- Personalized: `ExplorePage` (API) → DOM `/explore/tabs/trending`.
- Location: resolve name via `trends/available.json` (cached per session; case-insensitive match on
  name/country/countryCode, "worldwide"→1) → `trends/place.json?id=`.
- News: DOM `/explore/tabs/news` (and News items present in `ExplorePage` if parseable).
- Promoted entries always filtered.
Returns `trends: {rank, name, category?, volume?, query}` and `news: {title, age?, category?, post_count?}`.

### `x_search`
Params: `query`, `type?: Latest|Top|Media = Latest`, `limit?: number = 40 (≤300)`,
`since?`, `until?` (YYYY-MM-DD), `from?`, `lang?`, `min_likes?`, `min_retweets?`,
`has?: (media|links|video)[]`, `exclude?: (replies|retweets)[]`, `sort?: recent|engagement = recent`, `account?`.
- Filters compile to X operators appended to `query` (`since:`, `until:`, `from:`, `lang:`,
  `min_faves:`, `min_retweets:`, `filter:media|links|videos`, `-filter:replies|retweets`).
- API: `SearchTimeline` POST with cursor pagination (`count` 20/page), 1.5–2.5 s jittered delay
  between pages; DOM fallback: search page + scroll (up to ~10 passes).
- Output includes **stats**: count, time span, total/median likes/RTs/replies/views,
  top authors (by summed score), top hashtags, top domains, top 5 posts by score.

### `x_tweet`
Params: `id_or_url`, `replies?: number = 0 (≤100)`, `account?`.
- `replies = 0`: syndication feed (no login) → API `TweetResultByRestId` fallback.
- `replies > 0`: API `TweetDetail` (with features) → conversation ordered by score; DOM fallback
  on `/status/<id>`.
- Distinguishes `not_found` (404/tombstone) from network/abort errors.

### `x_user`
Params: `username` (handle, @handle, or URL), `posts?: number = 0 (≤100)`, `account?`.
- `UserByScreenName` → profile (bio, followers, following, posts, joined, verified, location, url).
- `posts > 0`: `UserTweets` (paginated) + stats block.

### `x_doctor`
No params. Checks: agent-browser present + version; Chrome installed (`agent-browser` launch
probe); syndication reachable; per account: profile dir, session running, logged in (in-page
`ct0` + `viewer` handle); API discovery (ops found, bearer found); active engine
(`api` | `dom` | `none`). Returns text + structured report; proxies masked.

## 5. `/x` command

Autocompletion via `getArgumentCompletions` (subcommands; account names after
`login|logout|remove|use|enable|disable|proxy|backup|restore`). Missing args → `ctx.ui.select` /
`input`; destructive actions → `ctx.ui.confirm`. When `!ctx.hasUI`, output goes to stdout and
missing args produce a usage error instead of a prompt.

| Command | Behavior |
|---|---|
| `/x`, `/x status` | Dashboard: accounts (★ active, @handle, ✓/✗ logged in, enabled, last used, masked proxy), engine state, trends location, next-step hint. |
| `/x login [account]` | Close headless session for that account → open headed login → poll (≤5 min, abortable) until logged in → "✓ @handle connected". |
| `/x logout [account]` | Confirm → close session → delete profile dir. |
| `/x add <name>` · `/x remove <name>` | Manage accounts (names: `[A-Za-z0-9_-]{1,32}`, case-insensitive unique, reserved words rejected). |
| `/x use <name>` | Set active account. |
| `/x enable <name>` · `/x disable <name>` | Rotation membership. |
| `/x proxy <name> [url\|off]` | Set/clear proxy. |
| `/x import-chrome <name>` | Point account at desktop Chrome's default profile (warn: close Chrome first). |
| `/x location [place\|default]` | Set default trends location; no arg → picker. |
| `/x doctor` | Same report as `x_doctor`. |
| `/x backup [account]` · `/x restore [account]` | agent-browser `state save/load` to `<dataDir>/state/<name>.json` (0600). |
| `/x close` | Close all pi-x browser sessions. |
| `/x help` | Command list. |

Legacy forms (`/x account add|remove|active|chrome|proxy|noproxy`, `/x login check`,
`/x state save|restore`, `/x keepalive`, `/x accounts`) still work and print the new form.
Footer: `ctx.ui.setStatus('pi-x', '𝕏 2/3')` (⚠ when 0 logged in), refreshed on `session_start`
and after account changes.

## 6. Config & storage

- Data dir: `join(getAgentDir(), 'pi-x')` (respects `PI_CODING_AGENT_DIR`); config
  `pi-x/config.json`; profiles `pi-x/profiles/<name>`; backups `pi-x/state/<name>.json`.
- One-time migration from `~/.pi/x-insights.json` + `~/.pi/x-insights/{profiles,state}` (move if
  same filesystem, else leave in place and reference old profile paths). SocialData key dropped.
- Schema-validated (TypeBox); invalid → rename to `config.json.bak-<ts>`, warn, start fresh.
- Atomic writes (tmp + rename), file 0600, dirs 0700. Env vars never persisted.
- Shape: `{version:1, accounts:[{name, profile?, enabled, proxy?, handle?, lastUsed?}], active?, trendsLocation?}`.

## 7. Reliability & security

- Per-account mutex; `executionMode` sequential is **not** used globally (different accounts may
  run in parallel).
- AbortSignal → `execFile({signal})` and in-page work is bounded by per-call timeouts.
- Sessions closed on `session_shutdown` and `/x close`.
- Rate limit: 429 / code 88 → backoff `5·2^n + rand(0,2)` s, 3 tries, then rotate account.
- Windows: if resolved binary ends in `.cmd`/`.bat`, run via `shell: true` with each arg quoted.
- Proxy passed via `AGENT_BROWSER_PROXY` env (not argv); `maskProxy()` applied to every
  user/LLM-visible string. `ct0`/bearer never returned from page evals.
- DOM extraction: numeric counts parsed from `aria-label` digits with locale-agnostic separators;
  login wall detected by URL (`/login`, `/i/flow/login`, `/account/access`) + absence of
  `[data-testid="SideNav_AccountSwitcher_Button"]` instead of English text.

## 8. Error codes

`browser_missing`, `chrome_missing`, `not_logged_in`, `rate_limited`, `timeout`, `aborted`,
`not_found`, `api_changed`, `dom_changed`, `invalid_input`, `network`. Each maps to a one-line fix.

## 9. Skill (`skills/pi-x/SKILL.md`)

- Routing table (trending → `x_trending`; topic → `x_search`; URL → `x_tweet`; person → `x_user`;
  unsure/broken → `x_doctor`).
- Trend drill-down recipe: `x_trending` → pick top 3–5 relevant → `x_search(trend.query, type:'Top', limit:30)` each → synthesize.
- Insight format: headline, volume/hype, sentiment split, themes, top voices, notable quotes w/ URLs, timeline, caveats (sample size, bots, promoted).
- Self-repair: on `api_changed`/`dom_changed`, inspect with agent-browser, patch `xapi.ts`/`dom.ts`, `/reload`.

## 10. Testing

- `npm test` → `node --test --import tsx test/*.test.ts`: normalize (GraphQL search/detail/user,
  v1.1 trends, syndication, DOM shapes from recorded fixtures), score/stats, filters→query, format
  truncation, config validate/migrate/corrupt, account picking + mutex, proxy masking, command
  arg parsing/completions.
- `npm run check` → `tsc --noEmit` against Pi's types (devDependencies: typescript, tsx, Pi peers).
- `scripts/smoke.sh` → `pi -p -e ./ "…"` per tool against a logged-in account (manual, not CI).

## 11. Packaging & docs

- `package.json`: version 1.0.0, `"pi": {"extensions": ["extensions/pi-x/index.ts"], "skills": ["skills"]}`,
  remove `engines.pi`, add scripts + devDependencies.
- README rewrite (install → `/x login` → "what's trending in tech?"), CHANGELOG, migration notes
  (loose `~/.pi/agent/extensions/x-insights.ts` must be removed to avoid duplicate tools).
- Old `extensions/x-insights.ts` and `skills/x-insights/` removed.

## 12. Out of scope (v1)

Home/following feeds, bookmarks, lists, X Articles, posting/any write action, non-X sources,
direct cookie API without a browser.

## 13. Addendum (2026-10-01, after OSS survey + endpoint probes)

Verified live: with each operation's `featureSwitches` (from the bundle metadata) set to `true` and
`fieldToggles` set to `false`, **all** v1 operations return 200: `SearchTimeline` (POST),
`TweetDetail`, `UserByScreenName`, `UserTweets`, `TweetResultByRestId`, `ExplorePage`,
`GenericTimelineById`, `Viewer`. Explore tabs (`for_you`, `trending`, `news`, `sports`,
`entertainment`) come from `ExplorePage.body.timelines[].timeline.id` and are fetched with
`GenericTimelineById` — **trends and news come from the API; DOM is fallback only.** `Viewer` returns
the logged-in handle (login detection without English text). Response notes: `user.legacy` is
empty in current payloads (use `user.core`, `relationship_counts`, `profile_bio`, `verification`);
`tweet.legacy.entities` is often empty (derive hashtags/mentions from text; URLs from
`note_tweet` entity set when present); long posts live in `note_tweet`.

Adopted from Scweet / twscrape / twikit / opencli / twitter-cli (v1):
- Per-op `features`/`fieldToggles` extraction from bundle (anchored to `operationName`).
- Explore tabs via `GenericTimelineById` (+ `tab` param: trending|news|sports|entertainment).
- `querySource:'trend_click'` when drilling into a trend.
- Rate-limit headers (`x-rate-limit-*`) recorded per account; codes 88/429 → backoff+rotate;
  326 → `account_locked`; 32 / 401 → `not_logged_in`.
- Thread vs replies split in `x_tweet` (author self-replies = `thread`).
- Extra filters: `to`, `mentions`, `verified_only`, `near`/`within`, `min_replies`.
- Pagination stops after 3 consecutive empty pages; `next_cursor` returned in details and accepted as `cursor` input.
- Page classifier in doctor (app / login wall / no-app).

pi-x differentiators (v1): `x_trending` **drill-down** ("why is it trending": top posts, earliest
high-engagement post, stats per trend), **"new since last check"** marking per location/tab,
stats with **velocity (posts/hour)** and **verified share**, **near-duplicate collapse**, LLM-sized output.

Later (v1.1+): lazy-chunk sweep for more ops (lists, bookmarks, retweeters, home feed),
`AboutAccountQuery` authenticity, Community Notes, date-range splitting, twitter-openapi remote
fallback, `x-client-transaction-id` if X starts enforcing it.

Spec adjustments: legacy profile dirs are **referenced in place** (not moved) and tightened to 0700;
legacy state files copied to the new state dir at 0600. Browser sessions are named `pix-<account>`;
on first run, legacy sessions named after accounts are closed so the profile dir isn't locked.
`ctx.ui.notify` levels are `info|warning|error` only.
