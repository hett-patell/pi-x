# Changelog

## 2.0.0 — 2026-11-23

### Added
- **`/x feed` — live feed sidebar.** Your home feed docked full-height on the right of the TUI,
  auto-refreshing every 5 minutes.
  - Non-capturing: the editor keeps the keyboard. `alt+x` (or `/x feed` again) focuses the feed,
    `Tab`/`Esc` hand input back, `q` or `/x feed close` closes it.
  - Inline media thumbnails via Kitty/iTerm2 graphics (`m` toggles); clickable `🖼 media` link
    on other terminals.
  - `a` cycles to the next connected account.
- **`/x dm` — interactive DM chat overlay** (inbox, threads, compose + send), with
  `/x dm [account] [user]` syntax and `a` to switch account.
- Tools: `x_dm_thread`, `x_followers`, `x_following`, `x_post`, `x_like`, `x_retweet`,
  `x_bookmark`, `x_bookmarks`, `x_retweeters`, `x_likers`, `x_home` (18 tools total).
- DM threads paginate through the full history; encrypted messages are shown as placeholders.

### Changed (breaking)
- `/x write on` now gates **all** write actions — DMs, posts, likes, retweets, bookmarks — and
  bookmark reading, not just DMs.
- `x_home` returns recent posts from accounts you follow, replies excluded (`filter:follows`
  search). X removed the `HomeLatestTimeline` API, so the algorithmic "For you" ordering is gone.
- Personal tools (DMs, bookmarks, home) never rotate across accounts: with several connected they
  use the pinned account or ask once per session. `/x feed` and `/x dm` ask on every open;
  `/x use` clears the remembered choice.

### Fixed
- `/x dm` accepts account names that aren't valid X handles.
- `x_home` / `/x feed` failing with `operation HomeLatestTimeline not found in main bundle`.

## 1.1.0 — 2026-10-05

### Added
- `x_dm_inbox`: recent 1:1 DM conversations with the last message and unread status.
- `x_dm`: send a direct message (create or reuse the 1:1 conversation).
- `/x write on|off [--no-confirm]`: opt-in DM access, off by default. `/x status` shows it.
- API discovery scans every loaded script bundle, so operations outside `main.js` are found too.

### Safety
- Each `x_dm` send asks you to confirm the recipient and text in the Pi UI. Without a UI it refuses unless you chose `/x write on --no-confirm`.
- A DM goes out from exactly one account (named, else active, else first enabled) and is never rotated to another account.
- A DM is sent exactly once: no re-run after a failed page script and no rate-limit retry, so a timeout can't cause a duplicate.
- Both DM tools are blocked until `/x write on`; DM text is treated as untrusted input in the skill.

### Fixed
- DM inbox picked the wrong "latest" message and unread state when message ids had different lengths (ids were compared as text).

## 1.0.2 — 2026-10-05

### Fixed
- Skill routing:
  - `x_trending()` without a location uses the `/x location` default; it is personalized Explore only when no default is saved.
  - News, sports and entertainment exist only on personalized Explore, so those requests pass `location: "default"`.
  - The x_trending guideline and the `location` / `include_news` descriptions now say the same.
- Skill counting rule:
  - Stance is counted only from posts whose text is shown ("of the posts shown (from N sampled)").
  - Percentages the stats block printed, such as verified share, are repeated as-is.

## 1.0.1 — 2026-10-05

### Changed
- Rewrote the `pi-x` skill so agents report results accurately. They now:
  - say whose trends they are (account Explore vs. worldwide / a place);
  - describe stance by counting posts instead of inventing sentiment percentages;
  - read sample stats correctly;
  - fetch less by default, and size the answer to the question;
  - relay each error's fix line instead of editing the installed package.
- Tool `promptGuidelines` now defer to the skill (one source of truth).
- `dom_changed` fix hint points users to `pi update` / issues instead of patching package files.

## 1.0.0 — 2026-10-01

Complete rewrite.

### Added
- `x_trending`: personalized Explore tabs (trending/news/sports/entertainment) or any location (WOEID), X News stories with volume & age, `drilldown` to explain *why* topics trend, NEW-since-last-check marking.
- `x_search`: filters (from/to/mentions, since/until, lang, min likes/retweets/replies, media/links/video, exclude replies/retweets, verified, near/within), pagination to 300, cursor continuation, stats block (velocity, medians, verified share, top voices/hashtags/sites, earliest notable post), copy-paste collapse.
- `x_tweet`: author thread + top replies via `replies`.
- `x_user`: profiles via your session (no key) + recent posts with stats.
- `x_doctor`: live per-account check, API discovery report, fixes.
- `/x` command: status dashboard, autocomplete, pickers, `login` that confirms itself, `use auto`, `enable/disable`, `proxy`, `location`, `backup/restore`, `close`, `help`; footer status.
- In-page X API engine with runtime query-ID/feature discovery and DOM fallback; per-account locks; rate-limit backoff + account rotation; Esc cancels everything.

### Changed
- Config moved to `~/.pi/agent/pi-x/` (auto-migrated from `~/.pi/x-insights.json`), written atomically with 0600.
- Browser sessions are named `pix-<account>` and closed when Pi exits.

### Removed
- SocialData backend (`x_search`/`x_user` no longer need a key), `/x setkey`, `x_scrape_topic` (merged into `x_search`).

### Security
- Proxy credentials masked everywhere and passed via env, not argv; saved login state 0600; env API keys never persisted.
