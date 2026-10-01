---
name: pi-x
description: >
  Use for anything on X / Twitter: what's trending or hot right now, news on X, why a topic is
  trending, what people are saying about something, reading a post/thread from an x.com or
  twitter.com URL, or looking up an account. Tools: x_trending, x_search, x_tweet, x_user, x_doctor.
---

# pi-x — X (Twitter) for this agent

Data comes from the user's own logged-in X session in a background browser (no API keys).

## Route the request

| User wants | Do this |
|---|---|
| "What's trending / hot / happening on X?" | `x_trending` (add `location` if they name a place) |
| "…and why?" / "explain the trends" | `x_trending` with `drilldown: 3`, or `x_search(trend.query, type: "Top")` per trend |
| News on X | `x_trending` with `tab: "news"` |
| "What are people saying about <topic>?" | `x_search(query, type: "Top", limit: 60)` then `x_search(..., type: "Latest")` for the live pulse |
| A post URL / ID | `x_tweet(url)`; add `replies: 20` for reactions |
| An account | `x_user(handle, posts: 20)` |
| Anything fails / "is X working?" | `x_doctor` |

Filters beat raw operators: `from`, `since`/`until` (YYYY-MM-DD), `lang`, `min_likes`, `exclude: ["retweets"]`.

## Write insights, not dumps

1. **Headline** — one sentence on what's happening.
2. **Volume & velocity** — post counts, posts/hour, trend volume (from the stats block).
3. **Sentiment split** — rough %, with what drives each side.
4. **Themes** — 3–5 recurring angles.
5. **Top voices** — handles with reach/engagement.
6. **Notable posts** — 2–3 quotes, each with its URL.
7. **Origin & timeline** — use "earliest notable post".
8. **Caveats** — sample size, likely bots/copy-paste (duplicates collapsed), promoted content.

Mark trends flagged `NEW` as newly appeared since the last check.

## When things break

- `not_logged_in` → tell the user: run `/x login` (pick the account if asked).
- `rate_limited` → wait, lower `limit`, or `/x add` another account and `/x login` it.
- `api_changed` / `dom_changed` → tools already fell back to page scraping where possible. If the user
  wants it fixed: run `x_doctor`, inspect the live page with the agent-browser tool
  (`agent-browser --session pix-<account> …`), patch `extensions/pi-x/page.ts` or `dom.ts` in the
  pi-x package, then `/reload`.

Never post, like, follow, or DM — pi-x is read-only.
