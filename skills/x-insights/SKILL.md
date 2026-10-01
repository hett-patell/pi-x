---
name: x-insights
description: Scrape and analyze X (Twitter) — fetch tweets, scrape topics by keyword with multi-account browser rotation, look up profiles, and synthesize insights (sentiment, themes, top voices, engagement).
---

# X (Twitter) Insights

Use this skill when the user wants data or analysis **from X / Twitter**: trending
topics, keyword/topic scraping, a specific tweet's engagement, a user profile, or
sentiment/insights synthesized from posts.

## Tools available

- **`x_tweet(id_or_url)`** — fetch a single tweet (text, author, full engagement,
  hashtags, media, quote chain). **Free**, no key, no login. Use whenever the user
  references a tweet URL or ID.
- **`x_scrape_topic(query, max?, account?, type?)`** — scrape a topic from x.com
  using Pi's browser with **multi-account rotation**. **Free** (no API key) but each
  account must be logged in once (`/x login`). Returns structured posts (author,
  text, engagement, time, URL). x.com search operators work: `from:user`,
  `since:`, `until:`, `#tag`, `-filter:retweets`, `min_faves:`, `OR`.
- **`x_search(query, max_results?, type?)`** — keyword search via SocialData.tools
  (freemium, structured JSON). Use when a SocialData key is set (`/x setkey`).
- **`x_user(username)`** — public profile lookup (followers, bio, join date,
  verification). Needs a SocialData key.

## Decision guide

- Specific tweet URL/ID → `x_tweet` (always; free).
- Topic/keyword scrape, no key → `x_scrape_topic`. Ensure accounts are logged in
  (`/x login`); the tool rotates across logged-in accounts automatically.
- Topic/keyword search, key set → `x_search` (cleaner JSON than scraping).
- Author/audience context → `x_user`.

## Synthesizing insights

After fetching, **don't just list posts**. Synthesize:
- **Volume/hype** — how much discussion, growth.
- **Sentiment split** — bullish/bearish, pro/con, emotional tone.
- **Recurring themes** — cluster the conversation.
- **Top voices** — by engagement (likes/retweets) and reach (verified, followers).
- **Notable quotes** — with their X URLs.
- **Timeline/spread** — is it peaking, sustained, fading?

## Setup (one-time)

```
/x login default google     # log in an X account in a headed browser
/x login check default       # verify
/x setkey <key>              # optional: SocialData key for x_search/x_user
```

## Commands

`/x` status · `/x setkey <key>` · `/x account add|remove|list|active <name>` ·
`/x login [account] [google|apple|password|manual]` · `/x login check [account]` ·
`/x state save|restore|list [account]` · `/x keepalive [account]`

## Reality check

The official X API has **no free search tier** (free = posting only). This package
uses the genuinely free syndication feed for single tweets, and routes
search/profiles through either **SocialData.tools** (freemium) or **authenticated
browser scraping** (free, multi-account) — the practical free routes.
