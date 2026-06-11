---
phase: 13-spot-check-image-confirmation-and-human-review-loop
plan: "04"
subsystem: cohort-spotcheck-gate
tags: [gate, dhash, slack, review-queue, iso-week-guard]
dependency_graph:
  requires: [13-01, 13-02, 13-03]
  provides: [extended-gate-orchestrator]
  affects: [cohort-spotcheck-gate.js]
tech_stack:
  added: []
  patterns: [dhash-auto-confirm, slack-review-queue, iso-week-guard, advisory-vision-log]
key_files:
  modified:
    - cohort-spotcheck-gate.js
decisions:
  - "D-13 guard only applies to auto-resolved cohortId; --cohort flag bypasses it (operator override)"
  - "dHash threshold default 6 not raised; only UNCERTAIN promoted, CONFIRMED_MISMATCH never overridden"
  - "Vision advisory log placed before adjudicatePairs so p.vision is available for Slack post"
  - "Slack review post is non-fatal: null from postDigest/postReview skips upsert, run completes"
metrics:
  duration: ~20min
  completed: "2026-06-11"
  tasks_completed: 3
  files_modified: 1
---

# Phase 13 Plan 04: Gate orchestrator extension — dHash + vision advisory + review queue

Extended `cohort-spotcheck-gate.js` with four new pipeline stages: D-13 ISO-week guard, dHash auto-confirm, advisory vision logging, and Slack review-queue posting.

## What Was Built

### Task 1: D-13 ISO-week guard + isoWeekId helper + Phase-13 lib imports

Added `isoWeekId(date)` (ISO-8601 Thursday-anchored, same format as `cohorts.cohort_id`). After
auto-resolving cohortId from the DB, the guard checks `cohortId !== isoWeekId(new Date())` and
returns `{ skipped: true, staleCohort: true, reason, slackMsg }` if they diverge — preventing the
gate from silently re-adjudicating last week's cohort. An explicit `--cohort` flag bypasses the
guard (operator override).

`validate()` updated: `summary.staleCohort` triggers the Slack alert path via `summary.slackMsg`;
an ordinary `skipped: true` (no cohorts in DB) stays silent.

The three Phase-13 lib imports were added: `spotcheck-dhash`, `spotcheck-slack-bot`,
`spotcheck-review-store`.

**Commit:** `2d1fc89`

### Task 2: dHash step + auto-confirm promotion (D-02)

After the artifact is loaded and before adjudication, a `for` loop iterates every pair with both
galleries, resolves `.file` paths against `artifactDir` to absolute paths, and calls
`minDHashDistance`. Every pair's min-distance is logged (`dHash pair N: minDist=X threshold=6
AUTO-CONFIRM|escalate`) for threshold calibration. Result is stamped as `p.dhash` so it lands in
VERDICTS json.

After `adjudicatePairs(...)`, a promotion loop upgrades `UNCERTAIN → CONFIRMED_MATCH` only when
`dhashResults[pair_id].confirmed` is true. `CONFIRMED_MISMATCH` is never touched (asymmetric rule:
a shared photo confirms a match; field divergence is what makes a mismatch).

`DHASH_THRESHOLD` defaults to 6, overridable via `process.env.DHASH_THRESHOLD`.

**Commit:** `93fed09`

### Task 3: Vision advisory logging (D-06) + Slack review queue (D-07)

After the Mode B vision loop, a log loop stamps `p.vision = { sharedPhoto, confidence, reasoning }`
onto each suspect pair and logs `vision (advisory) pair N: sharedPhoto=... conf=...` for hit-rate
tracking. When `visionResults` is undefined (Mode A), the loop is a no-op.

After VERDICTS/SUMMARY files are written, the review-queue block (gated on both `SLACK_BOT_TOKEN`
and `SLACK_REVIEW_CHANNEL`) posts:
- One weekly digest message for all UNCERTAIN pairs
- One individual message per CONFIRMED_MISMATCH pair

Each posted message's `{ channel, ts }` is persisted via `upsertReviewMessage` (dedup by
`pair_id + cohort_id`). A null return from `postDigest`/`postReview` (Slack down, no token) skips
the upsert; the run completes and VERDICTS are written regardless.

**Commit:** `c4da79c`

## Deviations from Plan

None — plan executed exactly as written. All snippets applied verbatim from the plan's
`<action>` blocks.

## Verification Results

All 15 acceptance criteria pass:

- `node --check cohort-spotcheck-gate.js` exits 0
- All three Phase-13 libs imported
- `function isoWeekId` present; `staleCohort` + `summary.slackMsg` branch in validate()
- `DHASH_THRESHOLD` + `process.env.DHASH_THRESHOLD || '6'` present
- `minDHashDistance(` called; `minDist=` logged per pair
- dHash promotion guards `v.verdict === 'UNCERTAIN'`; no unconditional `v.verdict = 'CONFIRMED_MATCH'`
- `vision (advisory)` log present
- `postDigestMessage(`, `postReviewMessage(`, `upsertReviewMessage(` all present
- Slack gate on `botToken && reviewChannel`
- `removeConfirmedMismatchPair` has 0 occurrences in gate (T-13-11 satisfied)

## Threat Surface Scan

No new threat surface introduced. All T-13 mitigations confirmed:

- **T-13-11 (Elevation of Privilege):** `removeConfirmedMismatchPair` not called anywhere in the gate — deletion is poller-only (Plan 05). Vision only feeds `adjudicatePairs`. Grep confirms 0 occurrences.
- **T-13-13 (Tampering):** D-13 guard active; stale-cohort run skipped before any child processes run.
- **T-13-14 (DoS — Slack/vision outage):** All external calls non-fatal; VERDICTS still written when Slack is down.

## Self-Check: PASSED

- `cohort-spotcheck-gate.js` exists and passes `node --check`
- Commits `2d1fc89`, `93fed09`, `c4da79c` all present in git log
