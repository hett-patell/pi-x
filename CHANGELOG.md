# Changelog

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
