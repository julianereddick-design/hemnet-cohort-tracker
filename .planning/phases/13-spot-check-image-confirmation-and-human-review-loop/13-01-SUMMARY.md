---
phase: 13-spot-check-image-confirmation-and-human-review-loop
plan: "01"
subsystem: database
tags: [postgres, pg, migration, crud, transaction, audit-trail, spotcheck]

requires:
  - phase: 12-cohort-match-spot-check-weekly-qa-gate
    provides: cohort_pairs table (removal target), spotcheck-adjudicate.js patterns, lib --smoke harness conventions

provides:
  - spotcheck_review table DDL (message refs + open verdicts, UNIQUE dedup on pair_id+cohort_id)
  - spotcheck_removed_pairs table DDL (audit trail for hard-removed cohort_pairs rows)
  - lib/spotcheck-review-store.js with five exported functions: upsertReviewMessage, isAlreadyAdjudicated, markAdjudicated, removeConfirmedMismatchPair, getOpenReviewMessages
  - Audited transactional hard-delete: BEGIN -> audit INSERT -> DELETE cohort_pairs -> COMMIT / ROLLBACK on error

affects:
  - 13-04 (gate extension — calls upsertReviewMessage after posting Slack messages)
  - 13-05 (reaction poller — calls getOpenReviewMessages, markAdjudicated, removeConfirmedMismatchPair)
  - 13-06 (deploy plan — runs migrate-spotcheck-phase13.js on droplet)

tech-stack:
  added: []
  patterns:
    - "Migration pattern: createClient -> connect -> CREATE TABLE IF NOT EXISTS -> client.end() -> run().catch() (from cron-setup.js)"
    - "Review-store pattern: all exported functions take a connected pg Client as first arg (no top-level connection)"
    - "Audited delete pattern: BEGIN -> INSERT audit row FIRST -> DELETE -> COMMIT, ROLLBACK on any error"
    - "TDD harness: --smoke self-test with async checkAsync() + mock client capturing query() call sequence"

key-files:
  created:
    - migrate-spotcheck-phase13.js
    - lib/spotcheck-review-store.js
  modified: []

key-decisions:
  - "No FK from spotcheck_removed_pairs.pair_id to cohort_pairs.id: the source row is deleted, so a FK would block the audit insert — kept as plain INTEGER"
  - "Dedup via UNIQUE(pair_id, cohort_id) on spotcheck_review (D-12): upsert uses ON CONFLICT DO NOTHING so a persisting UNCERTAIN pair is never re-inserted"
  - "All DB writes use $1,$2,... parameterised placeholders — no string interpolation anywhere (T-13-02 SQL injection mitigation)"
  - "Client-as-parameter pattern: gate and poller pass their runJob client; no DB connection opened at module level"

patterns-established:
  - "Async smoke test pattern: IIFE with checkAsync() wrapping async assertions on mock pg clients"
  - "Mock client for transaction testing: push sql.trim() into calls array, then assert calls[0]===BEGIN, calls[1] contains audit table, calls[2] contains DELETE target, calls[3]===COMMIT"

requirements-completed: []

duration: 12min
completed: "2026-06-11"
---

# Phase 13 Plan 01: Persistence Layer Summary

**spotcheck_review + spotcheck_removed_pairs DDL migration + five-function review-store module with audited transactional cohort_pairs hard-delete and offline --smoke green**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-11T03:47:00Z
- **Completed:** 2026-06-11T03:59:00Z
- **Tasks:** 2 (TDD task: 3 commits — RED + GREEN + feat)
- **Files modified:** 2

## Accomplishments
- Idempotent migration `migrate-spotcheck-phase13.js` creates `spotcheck_review` (message refs + verdicts, UNIQUE dedup) and `spotcheck_removed_pairs` (audit trail); safe to re-run on the droplet
- `lib/spotcheck-review-store.js` exports all five contract functions; all SQL is parameterised ($1,$2,...); no string interpolation
- Hard-delete is audit-first and transactional: audit row is inserted into `spotcheck_removed_pairs` BEFORE the `cohort_pairs` DELETE, inside one `BEGIN`/`COMMIT` block; any error triggers `ROLLBACK` and re-throw
- TDD smoke: 11 assertions, 0 fail — covers export presence, BEGIN→audit→DELETE→COMMIT ordering, ROLLBACK-on-error, ON CONFLICT DO NOTHING, isAlreadyAdjudicated true/false branches, getOpenReviewMessages row passthrough

## Task Commits

Each task was committed atomically:

1. **Task 1: migrate-spotcheck-phase13.js** - `aa2e2b6` (feat)
2. **Task 2 RED: failing smoke tests** - `49ce0af` (test)
3. **Task 2 GREEN: implement review-store** - `5cb373b` (feat)

## Files Created/Modified
- `migrate-spotcheck-phase13.js` - Idempotent DDL migration for spotcheck_review + spotcheck_removed_pairs
- `lib/spotcheck-review-store.js` - CRUD + transactional audited hard-delete for the review queue

## Decisions Made
- No FK from `spotcheck_removed_pairs.pair_id` to `cohort_pairs.id` — the source row is deleted, so a FK would block the audit insert; it is intentionally a plain INTEGER
- `upsertReviewMessage` uses `ON CONFLICT (pair_id, cohort_id) DO NOTHING` to implement D-12 dedup — a pair that previously got UNCERTAIN and re-enters the queue on a later run is silently skipped
- Every exported function takes the caller's pg `client` as first arg — the module never opens its own DB connection (gate and poller pass their `runJob` client)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `migrate-spotcheck-phase13.js` is ready to run on the droplet (gated to Plan 13-06 deploy)
- `lib/spotcheck-review-store.js` is ready for import by Plan 13-04 (gate extension) and Plan 13-05 (reaction poller)
- Both files pass `node --check` and offline smoke tests

## Self-Check: PASSED
- `migrate-spotcheck-phase13.js` exists and contains all required DDL
- `lib/spotcheck-review-store.js` exists and passes `--smoke` (11 pass, 0 fail)
- Commits aa2e2b6, 49ce0af, 5cb373b all verified in git log

---
*Phase: 13-spot-check-image-confirmation-and-human-review-loop*
*Completed: 2026-06-11*
