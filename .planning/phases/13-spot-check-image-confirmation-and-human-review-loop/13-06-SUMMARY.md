---
phase: 13-spot-check-image-confirmation-and-human-review-loop
plan: "06"
subsystem: infra
tags: [crontab, slack, postgres, deploy, migration, spotcheck]

# Dependency graph
requires:
  - phase: 13-01
    provides: migration (spotcheck_review + spotcheck_removed_pairs tables)
  - phase: 13-02
    provides: spotcheck-dhash.js + adjudicate price-guard fix
  - phase: 13-03
    provides: spotcheck-slack-bot.js + SLACK-REVIEW-SETUP.md runbook
  - phase: 13-04
    provides: extended cohort-spotcheck-gate.js (dHash + vision + ISO-week guard + review queue)
  - phase: 13-05
    provides: spotcheck-reaction-poller.js daily runJob
provides:
  - Phase 13 pipeline live on production droplet (migration ran, both crons installed, env set)
  - D-14 go-live documented and staged in deploy-instructions.md
  - Weekly gate (Mon 06:30 UTC) and daily poller (12:00 UTC) active in crontab
  - Operator runbook covering review queue, recovery from wrongly-removed pairs, dHash calibration
affects: [phase-14-if-any, weekly-spotcheck-operations, cohort-pairs-audit-trail]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Phase 13 go-live checkpoint pattern: documentation commit precedes operator human-action gate"
    - "SLACK_ALLOWED_REACTORS env var gates auto-removal authorization; empty = all-reactors fallback for first run only"

key-files:
  created: []
  modified:
    - deploy-instructions.md

key-decisions:
  - "D-14 go-live ships Phase 12 weekly gate cron at the same time as Phase 13 — the gate was documented in Phase 12 but never actually installed on the droplet until this deploy"
  - "SLACK_ALLOWED_REACTORS marked REQUIRED in runbook before relying on auto-removal; poller fallback (all reactors) is first-run only and is documented as such"
  - "SLACK_WEBHOOK_URL (Phase 12 threshold/fetch-failure alerts) stays separate from SLACK_BOT_TOKEN (review queue bot) — two distinct Slack paths, never conflated"

patterns-established:
  - "Recovery path documented before go-live: spotcheck_removed_pairs audit table + SELECT to restore a wrongly-removed pair"
  - "dHash calibration deferred by default (DHASH_THRESHOLD=6); runbook explains how to read per-pair minDist logs before raising"

requirements-completed: []

# Metrics
duration: ~10min (human-action gate dominated; code was complete from prior plans)
completed: "2026-06-11"
---

# Phase 13 Plan 06: Go-live Summary

**Phase 13 pipeline taken live on droplet: migration ran, weekly gate + daily poller crons installed, three new env vars set, and Slack full-loop verified end-to-end.**

## Performance

- **Duration:** ~10 min (automation was fast; human-action gate time not counted)
- **Started:** 2026-06-11
- **Completed:** 2026-06-11
- **Tasks:** 2/2
- **Files modified:** 1 (deploy-instructions.md)

## Accomplishments

- deploy-instructions.md documents the full Phase 13 go-live: three new env vars (SLACK_BOT_TOKEN, SLACK_REVIEW_CHANNEL, SLACK_ALLOWED_REACTORS), one-time migration step, both crontab lines, and operator runbook covering review triage, auto-removal audit trail, recovery of wrongly-removed pairs, and dHash calibration guidance
- Operator deployed to production droplet: git pull landed Phase 13 (HEAD f8ee95d), deps jimp + glob installed OK, `node migrate-spotcheck-phase13.js` created spotcheck_review and spotcheck_removed_pairs, env vars populated (14 total in .env including SLACK_ALLOWED_REACTORS=U01KC1QT2BB)
- Slack full loop verified live: postDigestMessage returned a ts; operator reacted with checkmark; getReactions read back white_check_mark from U01KC1QT2BB; authorized-reactor match confirmed true
- Both crontab lines confirmed via `crontab -l`: weekly gate Mon 06:30 UTC and daily reaction poller 12:00 UTC

## Task Commits

Each task was committed atomically:

1. **Task 1: Document Phase 13 go-live + operator runbook in deploy-instructions.md** - `924bb95` (docs)
2. **Task 2: Operator deploys to droplet** - human-action checkpoint, no code commit (deploy confirmed by operator)

## Files Created/Modified

- `deploy-instructions.md` - Added Phase 13 go-live block: env vars, migration step, both crontab lines, and operator runbook (review queue, auto-removal, recovery, calibration)

## Decisions Made

- Phase 12 weekly gate cron (Mon 06:30 UTC) was documented in Phase 12 but had never been installed on the droplet. It went live for the first time during this Phase 13 deploy — consistent with D-14 (the gate does useful work only after the Phase 13 image confirmation + review loop is also live).
- SLACK_ALLOWED_REACTORS set to U01KC1QT2BB (operator's own Slack user id) at go-live, satisfying the T-13-20 mitigation requirement from the plan's threat model.

## Deviations from Plan

### Notable Operational Note

**Phase 12 weekly gate cron first-install during this deploy**
- **Found during:** Task 2 (operator deploys)
- **Issue:** The Phase 12 gate cron had never actually been installed on the droplet despite being documented in deploy-instructions.md. It went live now alongside the Phase 13 poller cron.
- **Impact:** None — the gate was code-complete and tested; the cron simply was not active until this moment. Consistent with D-14's intent (gate + review loop ship together).
- **No fix required:** This is an operational note, not a bug. Documented for the record.

---

**Total deviations:** 0 auto-fixed (no code changes required; one operational note recorded)
**Impact on plan:** Plan executed exactly as written. The human-action gate resolved fully.

## Issues Encountered

None — the operator deploy was clean. All verification steps passed on first attempt.

## User Setup Required

The following was completed by the operator during the Task 2 human-action checkpoint:

- **Migration:** `node migrate-spotcheck-phase13.js` — created spotcheck_review and spotcheck_removed_pairs
- **Env vars added to droplet .env:** SLACK_BOT_TOKEN (xoxb-…), SLACK_REVIEW_CHANNEL, SLACK_ALLOWED_REACTORS=U01KC1QT2BB
- **Crontab:** Both lines installed and confirmed via `crontab -l`
- **Slack bot:** Hemnet Status app (reused with added scopes chat:write + reactions:read) invited to review channel
- **Smoke verification:** Slack full loop confirmed live (post → react → read-back → authorized-reactor match)

## Next Phase Readiness

- Phase 13 is complete. The full pipeline is live: weekly gate fires Mon 06:30 UTC, daily poller fires 12:00 UTC, Slack review channel operational, auto-removal authorized for U01KC1QT2BB.
- The Phase 12 gate cron is also active for the first time — first real weekly run will fire the next Monday at 06:30 UTC.
- No blockers. The operator can recover any wrongly-removed pair from spotcheck_removed_pairs per the runbook in deploy-instructions.md.

---
*Phase: 13-spot-check-image-confirmation-and-human-review-loop*
*Completed: 2026-06-11*
