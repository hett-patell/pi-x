# pi-x

**Give your Pi agent eyes on X — trending topics, news, and *why* things trend. No API keys.**

[![pi-package](https://img.shields.io/badge/pi-package-blueviolet?style=flat-square)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-109%20passing-brightgreen?style=flat-square)](./test)
[![npm](https://img.shields.io/npm/v/@hett/pi-x?style=flat-square)](https://www.npmjs.com/package/@hett/pi-x)

pi-x is a [Pi](https://pi.dev) extension that lets your coding agent read X (Twitter) through
**your own logged-in browser session** — trending topics and news, keyword search with real
stats, threads, and profiles. No developer account, no $200/mo API tier, no cookies handed to
a third-party script.

---

## Demo

```
> What's trending on X right now and why?

Trending — Worldwide
 1. #PPxSTAKE
 2. #BELTUR
 3. #PlsLoveรักได้ไหมEP4
 4. LENAMIU PLS LOVE EP4
 5. #TaşacakBuDeniz

Why it's trending (top posts per trend):

▸ #PPxSTAKE — 20 posts sampled
Stats: 20 posts over 1.1h (18.2/h) · 2026-10-02 18:03 → 2026-10-02 19:07
  likes 4.6K (median 2) · reposts 2.5K · replies 14K · views 87K
  verified authors 70%
  top voices: @pp_privatejet_2 (2, score 42K), @Junsznx (1, score 49), @aikawins (2, score 46)
```

That's one call to `x_trending` with `drilldown: 1` — a real trend, real engagement numbers,
sampled live from X. No scraped HTML dump, no "I don't have access to real-time data."

## Why pi-x

- **Free** — runs on the X session you're already logged into. No API keys, no per-call cost.
- **Trends + news + drill-down** — not just a trends list: X News stories with volume & age, and
  a `drilldown` that samples top posts per trend so the agent can explain *why* something is hot.
- **Stats built for LLMs** — every search/trend result comes with a compact stats block
  (velocity, medians, verified share, top voices/hashtags/sites) instead of a wall of raw JSON.
- **Self-healing** — discovers X's internal API query IDs and features at runtime, and falls
  back to page-scraping when X changes something, instead of breaking outright.
- **Multi-account rotation** — add several accounts; pi-x rotates and backs off on rate limits.
- **Cookies never leave the browser** — calls run *inside* the logged-in page; pi-x never
  extracts your cookies or sends them anywhere.
- **Read-only by default** — no posting, liking, or following. DM access (read your inbox, send a DM you confirm) is opt-in via `/x write on`.

## How pi-x compares

| | **pi-x** | Official X API | Scweet | twscrape | twikit | Agent-Reach / twitter-cli |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| No API key needed | ✅ | ❌ (search from ~$200/mo) | ✅ | ✅ | ✅ | ✅ |
| Trends + news | ✅ | — | ❌ | ✅ (trends only) | ✅ (trends only) | ❌ |
| Explains *why* it's trending | ✅ | — | ❌ | ❌ | ❌ | ❌ |
| LLM-sized stats blocks | ✅ | — | ❌ | ❌ | ❌ | ❌ |
| Cookies stay in the browser | ✅ | n/a | ❌ (reads `auth_token` out) | ❌ (stores cookies) | ❌ (stores cookies) | ❌ (reads cookies out) |
| Agent-native (Pi tools, not a library) | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ CLI, not Pi-native |

*Sources checked against each project's own code/docs as of 2026-10-01 — see `docs/superpowers/specs/2026-10-01-pi-x-v1-design.md` for the full survey. Scweet, twscrape, and twikit are Python libraries; Agent-Reach is a multi-platform CLI router that, for X, delegates to twitter-cli (no trends of its own). The closest architectural cousin is OpenCLI's `twitter` command, which also runs inside a logged-in browser page — but its trending is DOM-only, with no drill-down, stats, or Pi integration.*

## Install

Requires [Pi](https://pi.dev) ≥ 0.99, Node ≥ 22.18 (for development), and the
[agent-browser](https://www.npmjs.com/package/agent-browser) CLI:

```bash
npm i -g agent-browser && agent-browser install
```

Then, in Pi:

```bash
pi install npm:@hett/pi-x
# or try it once without installing:
pi -e npm:@hett/pi-x
# or track the latest main branch:
pi install git:github.com/hett-patell/pi-x
```

## Quick start

```
/x login
```

Finish signing in (Google, Apple, or password + 2FA) in the browser window that opens — pi-x
confirms the login itself and closes the window. Then just ask:

```
What's trending on X right now, and why?
```

## Tools

| Tool | Key params | What it does |
|---|---|---|
| `x_trending` | `location?`, `tab?` (trending/news/sports/entertainment), `include_news?`, `limit?`, `drilldown?` (0–5) | Ranked trends + X News stories; `drilldown` samples top posts per trend to explain why it's trending. Marks trends `NEW` since the last check. |
| `x_search` | `query`, `type?` (Latest/Top/Media), `limit?` (≤300), `from`/`to`/`mentions`, `since`/`until`, `lang`, `min_likes`/`min_retweets`/`min_replies`, `has`, `exclude`, `verified_only`, `near`/`within`, `cursor` | Filtered search with pagination and a stats block (velocity, medians, verified share, top voices/hashtags/sites, earliest notable post). |
| `x_tweet` | `id_or_url`, `replies?` (0–100) | Reads one post with full engagement + quote chain; with `replies`, also the author's thread and top replies by engagement. |
| `x_user` | `username`, `posts?` (0–100) | Profile (bio, followers, verified, joined); with `posts`, their recent posts with stats. |
| `x_doctor` | — | Live per-account login check, API discovery report, exact fixes. Run this first if anything looks wrong. |
| `x_dm_inbox` | `account?` | Your recent 1:1 DM conversations: who, last message, unread. Needs `/x write on`. |
| `x_dm` | `to`, `text`, `account?` | Send one DM. Needs `/x write on`; you confirm every message in the Pi UI. Sent once, from one account — never rotated or retried. |

## Commands

| Command | What it does |
|---|---|
| `/x status` | Accounts, login state, rotation, trends location |
| `/x login [account]` | Connect an X account (opens a browser window) |
| `/x logout [account]` | Disconnect and delete the account's browser profile |
| `/x add <name>` | Add another X account slot |
| `/x remove <account>` | Remove an account (browser profile kept on disk) |
| `/x use <account\|auto>` | Pin the account tools use (`auto` = rotate) |
| `/x enable <account>` | Include an account in rotation |
| `/x disable <account>` | Exclude an account from rotation |
| `/x proxy <account> [url\|off]` | Set or clear an account's proxy |
| `/x import-chrome <account>` | Reuse your desktop Chrome login for an account |
| `/x location [place\|default]` | Default region for `x_trending` |
| `/x write on\|off [--no-confirm]` | Allow DM access: read inbox + send (off by default). `--no-confirm` skips the per-message prompt, e.g. for headless use |
| `/x doctor` | Full health check with fixes |
| `/x backup [account]` | Save the account's login state to a file (0600) |
| `/x restore [account]` | Restore a saved login state |
| `/x close` | Close all pi-x browser windows |
| `/x help` | Show all commands |

## Example prompts

- "What's trending on X right now, and why?"
- "What's trending in India today?" *(location trends by place name or WOEID)*
- "What's in the news on X?" *(`tab: "news"`)*
- "What are people saying about the new iPhone, and what are the main complaints?"
- "Search X for 'AI agents', top posts, min 20 likes"
- "Find recent posts about the earthquake, excluding retweets, last 24 hours"
- "Summarize this thread: https://x.com/user/status/12345" *(with reply reactions)*
- "What do people think of this post's replies?"
- "Look up @someaccount — are they a credible source?"
- "Has pi-x's X session stopped working? Run a diagnostic."

## How it works

```
 agent calls x_trending / x_search / x_tweet / x_user
                      │
                      ▼
        ┌─────────────────────────┐
        │  in-page X API engine   │  runs fetch() inside your logged-in
        │  (xapi.ts + page.ts)    │  x.com tab — cookies never leave it
        └────────────┬────────────┘
                      │ needs a query ID / feature flag it hasn't seen?
                      ▼
        ┌─────────────────────────┐
        │  runtime API discovery  │  finds the current GraphQL query ID
        │                         │  from X's own loaded JS, caches it
        └────────────┬────────────┘
                      │ X changed the page layout, discovery fails?
                      ▼
        ┌─────────────────────────┐
        │   DOM scrape fallback   │  reads the rendered page instead
        │        (dom.ts)         │  of calling the API at all
        └─────────────────────────┘

 rate limit / lock on one account → back off, rotate to the next enabled account
```

Account rotation is least-recently-used by default (`/x use <account>` to pin one); a per-account
lock keeps two tools from fighting over the same browser tab.

Running several Pi instances against the same X account at the same time isn't supported: the
locks are per process, and exiting one Pi closes the pi-x browser sessions the others are using.

## Privacy & safety

- Cookies stay in the browser profile under `~/.pi/agent/pi-x/profiles` (directories `0700`)
  and are never extracted or sent anywhere by pi-x. The in-page code reads X's `ct0` CSRF token
  inside the page only to authorize X's own requests, exactly as x.com does.
- `/x backup` writes the account's login state (cookies included) to
  `~/.pi/agent/pi-x/state/<account>.json` — `0600` inside a `0700` directory. Keep that file
  private; anyone holding it can use your X session.
- Config (`~/.pi/agent/pi-x/config.json`) is written `0600`.
- Proxy credentials are masked in every message, log, and tool output.
- Read-only by default: no posting, liking, or following, and DMs are untouched. `/x write on` lets `x_dm_inbox` read your DMs and `x_dm` send them. Each send shows the recipient and text for you to approve (unless you chose `--no-confirm`), goes out from exactly one account, and is never retried — so no duplicates or messages from the wrong account.
- Use a secondary/burner X account if you're not comfortable connecting your main one.
- You're responsible for respecting X's Terms of Service and rate limits — pi-x backs off on
  rate limits automatically but doesn't bypass them.

## Upgrading from 0.x

pi-x 1.0 is a complete rewrite. On first run it **automatically migrates** your config from
`~/.pi/x-insights.json` to `~/.pi/agent/pi-x/config.json` — no action needed. A few things to
know:

- **SocialData is gone.** `x_search` and `x_user` now use your logged-in browser session instead
  of a paid key. Any `SOCIALDATA_API_KEY` or saved key is unused and can be deleted.
- **`x_scrape_topic` merged into `x_search`** — use `x_search` with filters instead.
- `/x setkey` / `/x clearkey` are gone; pi-x tells you so if you run them.
- If you previously copied the old extension manually, remove
  `~/.pi/agent/extensions/x-insights.ts` so it doesn't shadow the installed package.

## Troubleshooting

| Error | Fix |
|---|---|
| `browser_missing` | `npm i -g agent-browser && agent-browser install` |
| `chrome_missing` | `agent-browser install` (Linux: `agent-browser install --with-deps`) |
| `profile_busy` | The account's profile is open in another Chrome window — close it (or `/x close`) and retry |
| `not_logged_in` | `/x login <account>` |
| `account_locked` | Open x.com for this account in a normal browser, complete X's unlock challenge, then `/x login <account>` |
| `rate_limited` | Wait a few minutes, lower `limit`, or add another account (`/x add <name>`, then `/x login <name>`) |
| `timeout` | Retry; if it keeps happening, `/x doctor` (slow network or proxy?) |
| `aborted` | Cancelled — no action needed |
| `not_found` | Check the ID/handle — the post or account may be deleted, protected, or suspended |
| `api_changed` | X changed its internal API. Run `x_doctor`; tools fall back to page scraping where possible |
| `dom_changed` | X changed its page layout. Run `x_doctor`, update pi-x (`pi update`), or report it at https://github.com/hett-patell/pi-x/issues |
| `invalid_input` | Fix the parameters and retry |
| `network` | Check your connection/proxy and retry |

## Development

```bash
npm install
npm test        # unit tests against recorded fixtures
npm run check   # tsc -p .
npm run smoke   # live smoke test against real X — needs a logged-in account
```

Project layout:

```
extensions/pi-x/
  index.ts         tool registration (x_trending, x_search, x_tweet, x_user, x_dm, x_dm_inbox, x_doctor), /x wiring
  commands.ts      /x command handling, SUBCOMMANDS, status footer, login watcher
  deps.ts          builds the shared ToolDeps (lazy agent-browser runner, sessions, engine, locks)
  config.ts        config load/save, 0.x migration, account validation, managed-profile check
  accounts.ts      account lookup/rotation order, proxy/secret masking
  browser.ts       spawns agent-browser (only module that does), sessions, per-account locks
  page.ts          page-side code (String.raw, runs inside the logged-in tab)
  xapi.ts          in-page X GraphQL engine + runtime query-ID discovery
  dom.ts           DOM-scrape fallback when the API engine can't be used
  normalize.ts     parse X payloads into Tweet / XUser / Trend / Place
  score.ts         engagement score, dedupe, search filters → query, stats
  format.ts        compact text rendering + OUTPUT_BUDGET fitting
  errors.ts        XErrorCode, FIXES, XError
  util.ts          clamp, unique, abortable sleep
  tools/           context.ts (shared deps, account rotation, pagination) + one module per tool
                   (trending, search, tweet, user, doctor)
skills/pi-x/       SKILL.md — how an agent should route requests and write insights
test/              unit tests + recorded fixtures
scripts/smoke.ts   live smoke script (npm run smoke)
```

## Disclaimer

pi-x automates your own browser session to read publicly visible X content on your behalf. It
does not post, like, follow, or message anyone. You are responsible for complying with X's Terms
of Service and applicable law in your jurisdiction. Not affiliated with or endorsed by X Corp.

## License

[MIT](./LICENSE)
