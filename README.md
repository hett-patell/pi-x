# 🐦 pi-x

> Scrape & analyze **X (Twitter)** from inside [Pi](https://pi.dev) — self-diagnosing, multi-account browser scraping, free single-tweet fetch, and AI-synthesized insights. No $200/mo API required.

*Inspired by [Agent-Reach](https://github.com/Panniantong/Agent-Reach)'s multi-backend routing + `doctor` self-diagnostic — brought natively to Pi.*

[![pi-package](https://img.shields.io/badge/pi-package-blueviolet?style=flat-square)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL-lightgrey?style=flat-square)](#requirements)

A [Pi](https://pi.dev) extension that gives your coding agent **native tools to read X**:
fetch any tweet, scrape a topic by keyword, look up profiles, and turn the raw posts into
real insights (sentiment, themes, top voices, engagement). It uses **free, no-auth** paths
where they exist and **multi-account authenticated browser scraping** where X demands login —
so you don't need a paid X API tier.

---

## ✨ What it does

| Tool | Capability | Cost |
|---|---|---|
| `x_doctor()` | **Self-diagnostic** — which backends/accounts work + what to fix (run first) | Free |
| `x_tweet(id_or_url)` | Fetch a single tweet — text, author, full engagement, hashtags, media, quote chain | **Free**, no key, no login |
| `x_scrape_topic(query, max?, account?, type?)` | Scrape a topic from x.com with **multi-account rotation**, returns structured posts | **Free** (browser; needs `/x login`) |
| `x_search(query, max_results?, type?)` | Keyword search → clean JSON | Freemium ([SocialData.tools](https://socialdata.tools)) |
| `x_user(username)` | Public profile (followers, bio, join date, verification) | Freemium |

After fetching, the agent **synthesizes insights** — not a dump of tweets: volume/hype,
sentiment split, recurring themes, top voices by engagement, notable quotes (with URLs),
and timeline spread.

## 🧠 The X free-tier reality (why this exists)

The official X API has **no free search tier** — free = posting only, and search starts at
~$200/mo. This package routes around that:

- **Single-tweet fetch** uses Twitter's free, no-auth embedded-tweet syndication feed
  (`cdn.syndication.twimg.com/tweet-result`) — token is required by the endpoint but
  **not validated**.
- **Topic search / profiles** are either routed through **SocialData.tools** (freemium,
  free credits on signup, ~$0.20/1k results, no OAuth) or scraped directly from **x.com
  with authenticated browser sessions** you log into once.

## 📦 Install

### In Pi (recommended)
```bash
pi install git:github.com/hett-patell/pi-x
# or try it once without adding it:
pi -e git:github.com/hett-patell/pi-x
```

### Local / dev
```bash
git clone https://github.com/hett-patell/pi-x
pi install ./pi-x
```

## ✅ Requirements

- **Pi** (the coding agent) — [`@earendil-works/pi-coding-agent`](https://pi.dev)
- For `x_scrape_topic` (browser scraping): Pi's **agent-browser** capability
  (e.g. [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native)).
- Optional: `sqlite3` on PATH — enables login-state detection in `/x accounts` (gracefully
  skipped if absent).
- Optional: a free [SocialData.tools](https://socialdata.tools/signup) key for `x_search` / `x_user`.

## 🚀 Quick start

```bash
# 1) Log in an X account (one-time, per account). Opens a headed browser window.
/x login default google        # complete Google / Apple / email + 2FA in the window
/x login check default         # verify you're logged in

# 2) (Optional) add more accounts for rotation
/x account add burner
/x login burner password

# 3) (Optional) SocialData key for clean JSON search
/x setkey <your_key>           # from https://socialdata.tools/signup (free credits)
```

Then just ask your agent in plain English:

> *"Scrape X for trending AI news and summarize the reaction."*
> *"What's the engagement on https://x.com/elonmusk/status/… ?"*
> *"Give me a profile breakdown of @OpenAI."*

## 🎛️ Commands

| Command | What it does |
|---|---|
| `/x` | Status overview (tools, key, accounts, CLI presence) |
| `/x doctor [--json]` | **Self-diagnostic** — which backends/accounts work + fixes |
| `/x setkey <key>` · `/x clearkey` | Manage the SocialData API key |
| `/x account add <name>` · `remove` · `list` · `active <name>` | Multi-account management |
| `/x account chrome <name>` | Reuse your desktop Chrome's login (skip `/x login`) |
| `/x account proxy <name> <url>` · `/x account noproxy <name>` | Per-account proxy (for IP-blocked X) |
| `/x login [account] [google\|apple\|password\|manual]` | Log in an account (headed browser) |
| `/x login check [account]` · `/x login clear` | Verify auth / clear login-method pref |
| `/x state save\|restore\|list [account]` | Back up / restore auth (cookies + storage) |
| `/x keepalive [account]` | Refresh the session (prevents idle timeout) |

## 🔐 Auth persistence (sessions don't expire)

- X auth cookies (`auth_token`, `ct0`, `twid`) are **persistent** (~1 year) and stored in
  each account's browser profile dir — they survive Pi/browser restarts.
- `/x state save` exports cookies + localStorage + sessionStorage to a portable backup file.
- `/x keepalive` visits `x.com/home` to refresh short-lived Cloudflare/guest tokens.

## 🧪 How scraping works

`x_scrape_topic` drives Pi's browser: opens the x.com search URL in an account's
authenticated profile, polls for tweets to render, extracts them via in-page JavaScript
(`article[data-testid="tweet"]`), scrolls for more, dedupes, and returns structured posts.
On a login wall or block it **falls back to the next logged-in account** — that's
multi-account rotation.

x.com search operators are supported in `query`:
`from:elonmusk`, `since:2026-01-01`, `until:`, `#hashtag`, `-filter:retweets`, `min_faves:50`, `OR`.

## 🛠️ Troubleshooting

| Symptom | Fix |
|---|---|
| Scrape says "not logged in / blocked" | `/x login <account> <method>`, then retry |
| Scrape returns few/no posts | retry (rotates accounts), use a tighter query, or `type: "Top"` |
| `x_search` says "needs key" | run `/x setkey <key>`, or use `x_scrape_topic` (free) |
| Only `default` works, not other accounts | `/x login <other>` — check status with `/x accounts` |
| Live tool still buggy after edits | restart Pi (extensions load at startup) |

## 🗂️ Package contents

```
pi-x/
├── extensions/
│   └── x-insights.ts     # the extension (4 tools + /x command)
├── skills/
│   └── x-insights/SKILL.md   # tells Pi when/how to use the tools
├── package.json          # pi-package; peers: pi-coding-agent, pi-ai
├── README.md
└── LICENSE
```

## 🤝 Contributing

PRs welcome. Before submitting: restart Pi to load your edits, and exercise each tool path
(`x_tweet`, `x_scrape_topic`, `x_search`, `x_user`, and the `/x` subcommands).

## ⚠️ Disclaimer

This reads **public** X data via free/no-auth endpoints and authenticated browser sessions
you control. It does not post on your behalf, scrape private/DM content, or bypass X's
paywalls for non-public data. Respect X's Terms of Service and rate limits. Not affiliated
 with X/Twitter or SocialData.tools.

## 📄 License

[MIT](./LICENSE) © Het Patel
