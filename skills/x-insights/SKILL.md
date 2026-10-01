---
name: x-insights
description: >
  MUST USE when the user wants data or analysis from X / Twitter — trending
  topics, keyword/topic scraping, a specific tweet's engagement, a user
  profile, or sentiment/insights synthesized from posts. Also when the user
  shares an x.com / twitter.com URL. Multi-backend routing (free syndication
  feed / SocialData / authenticated browser), multi-account rotation.
---

# X (Twitter) Insights — internet-eyes for X, à la Agent-Reach

Read & search X with **zero API fees**: free single-tweet fetch, multi-account
browser scraping, optional SocialData search, and AI-synthesized insights.

## 0. Doctor first (like Agent-Reach)

Before any scrape when status is uncertain, run **`x_doctor`**. It reports which
backends are ready (`agent_browser`, `sqlite3`, `syndication`, `socialdata`),
which accounts are logged in, and exactly what to fix. Use its output to pick the
backend; don't guess.

```
x_doctor()   → ✅ agent_browser ✅ sqlite3 ✅ syndication ⚠️ socialdata  · accounts: default ✅
```

## Routing table (pick the first backend that's ready)

| User intent | Primary | Fallback |
|---|---|---|
| Specific tweet URL/ID | `x_tweet` (free syndication) | SocialData, then browser |
| Topic/keyword, no key | `x_scrape_topic` (browser, multi-account) | — |
| Topic/keyword, SocialData ok | `x_search` (clean JSON) | `x_scrape_topic` |
| Author/profile | `x_user` (SocialData) | browser open of the profile |
| Health check / "is it working?" | `x_doctor` | — |

## Tools

- **`x_tweet(id_or_url)`** — fetch one tweet: text, author, full engagement, hashtags,
  media, quote chain. **Free**, no key, no login.
- **`x_scrape_topic(query, max?, account?, type?)`** — scrape a topic from x.com with
  **multi-account rotation + fallback**. **Free** (each account needs `/x login` once).
  x.com operators: `from:user`, `since:`, `until:`, `#tag`, `-filter:retweets`,
  `min_faves:`, `OR`.
- **`x_search(query, max_results?, type?)`** — keyword search via SocialData (freemium).
- **`x_user(username)`** — profile lookup (SocialData).
- **`x_doctor()`** — self-diagnostic; run first when unsure.

## Synthesizing insights

Don't just list posts. Synthesize: **volume/hype**, **sentiment split**,
**recurring themes**, **top voices by engagement/reach**, **notable quotes (with
URLs)**, **timeline/spread**.

## Setup

```
/x login default google        # log in an account (headed browser; Google/Apple/email+2FA)
/x account add burner          # add more for rotation
/x account chrome default      # OR reuse your desktop Chrome's login (skip /x login)
/x account proxy default http://host:port   # optional: for IP-blocked servers
/x setkey <key>                 # optional: SocialData key → x_search/x_user
```

## Commands

`/x` status · `/x doctor [--json]` · `/x setkey <key>` ·
`/x account add|remove|list|active|chrome|proxy|noproxy <name> [url]` ·
`/x login [account] [google|apple|password|manual]` · `/x login check [account]` ·
`/x state save|restore|list [account]` · `/x keepalive [account]`

## Retry chain (when a scrape fails)

1. `x_doctor` → confirm a logged-in account exists.
2. `x_scrape_topic` auto-rotates to the next logged-in account on a wall/block.
3. Still failing? `/x login <account>` (or `/x account chrome <name>` to reuse Chrome),
   then `/x keepalive <account>`, then retry.
4. Last resort: `/x setkey <key>` and use `x_search` (structured, no browser).

## Reality check

Official X API has **no free search tier**. This uses the free syndication feed for
single tweets, and routes search/profiles through **SocialData** (freemium) or
**authenticated browser sessions** you control (free, multi-account) — the practical
free routes. Reads public data only; never posts on your behalf.
