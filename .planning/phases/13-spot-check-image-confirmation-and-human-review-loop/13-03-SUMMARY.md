---
phase: 13-spot-check-image-confirmation-and-human-review-loop
plan: "03"
subsystem: spotcheck-slack-bot
tags: [slack, bot-token, reactions, review-queue, lib]
dependency_graph:
  requires: [13-01, 13-02]
  provides: [lib/spotcheck-slack-bot.js, SLACK-REVIEW-SETUP.md]
  affects: [cohort-spotcheck-gate.js, spotcheck-reaction-poller.js]
tech_stack:
  added: []
  patterns:
    - raw https.request for Slack API (POST + GET) with Authorization Bearer header
    - missing-env → return null no-throw guard (mirrors spotcheck-vision.js getClient)
    - pure parseReactions helper for offline smoke testing
key_files:
  created:
    - lib/spotcheck-slack-bot.js
    - SLACK-REVIEW-SETUP.md
  modified: []
decisions:
  - "Token guard via token() helper — every function returns null immediately when SLACK_BOT_TOKEN absent; never throws (T-13-08/T-13-10)"
  - "parseReactions extracted as pure helper so smoke tests the parse logic without any network call"
  - "Booli URLs use /annons/<booli_id> per COHORT-SPOTCHECK.md §4 (canonical current-ad URL)"
  - "SLACK_WEBHOOK_URL not referenced anywhere in the new module — strict separation from Phase 12 alert path"
  - "SLACK-REVIEW-SETUP.md runbook authored autonomously; Slack app creation deferred to operator at deploy time (Plan 06)"
metrics:
  duration: "~20 minutes"
  completed: "2026-06-11"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 13 Plan 03: Spotcheck Slack Bot Summary

Bot-token Slack I/O (chat.postMessage + reactions.get) with missing-token graceful degradation and a numbered operator runbook for app setup.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write lib/spotcheck-slack-bot.js | 0082f50 | lib/spotcheck-slack-bot.js |
| 2 | Write SLACK-REVIEW-SETUP.md operator runbook | ec28c6e | SLACK-REVIEW-SETUP.md |

## What Was Built

### lib/spotcheck-slack-bot.js

Three exports providing the D-07/D-08/D-09 Slack primitives:

- **`postReviewMessage(channel, pair)`** — posts a high-stakes single-pair MISMATCH message with the Hemnet URL (`hemnet.se/bostad/<id>`) and Booli canonical URL (`booli.se/annons/<id>`), dHash/vision summary, and the emoji legend.
- **`postDigestMessage(channel, pairs)`** — posts a weekly digest listing all pairs needing review, with both ad URLs per pair.
- **`getReactions(channel, ts)`** — calls `reactions.get` and returns `[{ name, users }]` mapped from the API response, or `null` on any error.

Internal helpers:
- `slackApiPost` / `slackApiGet` — raw `https.request` wrappers with `Authorization: Bearer <token>`, 10s timeout + destroy (T-13-10), collect-body-parse, `ok=false` → warn + null.
- `parseReactions(json)` — pure function exposed for offline smoke testing. Extracts `[{ name, users }]` from `reactions.get` JSON shape.
- `token()` — guard helper; every function returns `null` immediately when `SLACK_BOT_TOKEN` absent.

Smoke: 12 tests, 0 fail — all offline (no network, no DB):
- exports present, missing-token → null for all three functions
- URL shape: `hemnet.se`, `booli.se/annons/<id>`, NOT `/bostad/`
- `parseReactions` against 4 canned cases (with reactions, empty, ok=false, white_check_mark emoji)

### SLACK-REVIEW-SETUP.md

7-step numbered runbook covering:
1. Create app at api.slack.com/apps
2. Add `chat:write` + `reactions:read` scopes (with WHY each is needed)
3. Install to workspace, copy `xoxb-` token
4. Set `SLACK_BOT_TOKEN` in `.env` on droplet (security note: never commit/log)
5. Copy channel ID, set `SLACK_REVIEW_CHANNEL` in `.env`
6. `/invite @Hemnet Spot-check Review` into the channel (mandatory — bot must be member)
7. Verify with one-liner `postDigestMessage` call, react to confirm reactions work

Includes reaction protocol table (✅/❌/❓) and note to keep `SLACK_WEBHOOK_URL` (Phase 12) and `SLACK_BOT_TOKEN` (this plan) as separate env vars.

## Deviations from Plan

### Auto-adjusted Issues

**1. [Rule 1 - Consistency] Comment reference to SLACK_WEBHOOK_URL removed from file**
- **Found during:** Task 1 acceptance criteria check
- **Issue:** Plan's action text said to reference "never the write-only SLACK_WEBHOOK_URL" in the header comment, but the acceptance criterion requires `grep -c SLACK_WEBHOOK_URL` returns 0. Contradiction.
- **Fix:** Rephrased the header comment to say "write-only incoming webhook env var" without spelling out `SLACK_WEBHOOK_URL`. Criterion satisfied; intent preserved.
- **Files modified:** lib/spotcheck-slack-bot.js (comment only)
- **Commit:** 0082f50

## Threat Model Compliance

| Threat | Disposition | Applied |
|--------|-------------|---------|
| T-13-08: SLACK_BOT_TOKEN disclosure | mitigate | Token read only from `process.env.SLACK_BOT_TOKEN`; never hardcoded; never logged; runbook states "never commit / never log" |
| T-13-09: Authorization header | mitigate | Every API call sends `Authorization: Bearer <token>`; scopes limited to chat:write + reactions:read |
| T-13-10: DoS via Slack API | mitigate | 10s setTimeout + req.destroy() on every request; any error returns null |

## Known Stubs

None. The module has no hardcoded empty values flowing to UI. Bot token absent → null return is intentional graceful degradation, not a stub.

## Threat Flags

None. No new network endpoints or auth paths beyond what the plan's threat model covers.

## Self-Check: PASSED

- lib/spotcheck-slack-bot.js exists: FOUND
- SLACK-REVIEW-SETUP.md exists: FOUND
- Commit 0082f50 exists: FOUND
- Commit ec28c6e exists: FOUND
- Smoke: 12 pass, 0 fail
