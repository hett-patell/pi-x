---
name: pi-x
description: >
  Use when the user asks about X / Twitter — what's trending or hot, news on X, why something is
  trending, what people are saying about a topic, a post or thread from an x.com / twitter.com URL,
  or an X account — or when an x_* tool returns an error.
---

# pi-x — reading X through the user's logged-in session

Tools: `x_trending`, `x_search`, `x_tweet`, `x_user`, `x_doctor`. Read-only: never post, like, follow, or DM.

## 1. Route — fetch the least that answers the question

| User asks | Call |
|---|---|
| What's trending (no place) | `x_trending()` — this is **that account's personalized Explore**, not worldwide |
| What's trending worldwide / in a place | `x_trending({ location: "worldwide" \| "India" \| … })` |
| News on X | `x_trending()` already lists News stories (`include_news` defaults to true). `tab: "news"` only for news-only on personalized Explore |
| Sports / entertainment | `x_trending({ tab: "sports" \| "entertainment" })` — personalized only; `tab` is ignored when `location` is set |
| Why is X trending | `drilldown: 1–3` on `x_trending`, **or** one `x_search(trend.query, type: "Top")` — not both |
| What are people saying about T | one `x_search(T, type: "Top")` (default limit). Add `type: "Latest"` only if they asked "right now", or the Top sample is old/thin |
| A post URL / ID | `x_tweet(url)` — no login needed when `replies` is 0. Add `replies` only if they asked for reactions |
| An account | `x_user(handle)`; add `posts` only if they asked about their posts |

- Don't pass `account` unless the user named one — rotation is automatic.
- Search a trend's `query` exactly as returned; don't add `lang: "en"` to a non-English trend.
- Follow `next_cursor` only when they asked for more or the sample can't answer.
- If duplicates are high or verified share is very low, rerun once with `min_likes` or `exclude: ["retweets"]`.
- t.co links can't be resolved — ask for the real `x.com/<user>/status/<id>` URL.

## 2. Answer — state only what the results show

**Say whose trends they are.** Copy the header's scope: "on account X's Explore" or "worldwide" / the place.

**Counts, not guesses.** No tool measures sentiment. Describe stance only by counting posts you were given:
"of the N posts returned, K were giveaway entries / K criticised Y". Never write a percentage you didn't count.
A drill-down prints only its top 3 posts of the N sampled — say "of the 3 posts shown (from N sampled)".

**Read the stats correctly:**
- `per_hour`, medians, `verified authors` describe the **returned sample**. Trend volume ("24K posts") is X's own count. Keep them separate.
- Tiny median + huge total = a few viral posts, not broad engagement.
- `earliest notable post` = earliest post at or above the median score in the sample — not the origin of the topic.
- `NEW` is unset on the first check in a session; no NEW flags ≠ nothing new.
- Promoted entries are already removed — don't caveat about them.
- `+N omitted`, `[output truncated]` or `[page-scrape fallback]` → say the sample is partial.

**Fit the shape to the ask:**

| Ask | Give |
|---|---|
| Trends list | ranked names, volume, NEW, scope. No drill-down unless they asked why |
| Topic / why trending | one-line headline, what the sample supports (counted), 2–3 verbatim quotes with URLs, the stats reading above |
| One post | text, engagement, quote chain; replies only if asked |
| Account | bio, followers, joined, verified, 🔒 if protected (protected timelines can come back empty) |

Quote post text and URLs exactly as returned. Mention skipped accounts if the result lists any.

## 3. Errors — relay the fix

Every error ends with a `→` line. Tell the user that line (e.g. `not_logged_in` → run `/x login`; `account_locked`, `not_found`, `browser_missing`, `profile_busy`, `rate_limited` each carry their own fix). Run `x_doctor` if it's unclear what's broken.

Only edit pi-x code when the user is working in the pi-x repository and asked you to fix pi-x itself.
