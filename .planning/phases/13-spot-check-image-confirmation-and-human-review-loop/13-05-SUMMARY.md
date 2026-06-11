---
phase: 13-spot-check-image-confirmation-and-human-review-loop
plan: "05"
subsystem: spot-check-feedback-loop
tags: [slack, cron, reaction-poller, cohort-pairs, audit, security]
dependency_graph:
  requires: [13-01, 13-03]
  provides: [spotcheck-reaction-poller]
  affects: [cohort_pairs, spotcheck_review, spotcheck_removed_pairs]
tech_stack:
  added: []
  patterns: [runJob-cron-controller, pure-resolver-with-smoke, authorization-gate, audit-first-delete]
key_files:
  created:
    - spotcheck-reaction-poller.js
  modified: []
decisions:
  - "resolveReaction is a pure function (no I/O) so it can be unit-tested offline — security-critical logic isolated from network"
  - "SLACK_ALLOWED_REACTORS empty/undefined → all reactors allowed (documented fallback); operator runbook instructs setting it before trusting auto-removal"
  - "Contested message (allowed ✅ AND ❌) yields action:none — no auto-delete on disagreement (T-13-12 tie-break)"
  - "runJob guarded behind !--smoke so the offline smoke path never connects to DB"
  - "Task 1 and Task 2 committed in one atomic commit — both were implemented together in the single output file"
metrics:
  duration: "~15 minutes"
  completed: "2026-06-11T04:29:30Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 0
---

# Phase 13 Plan 05: Reaction Poller Summary

**One-liner:** Daily `runJob` poller that reads Slack emoji reactions on open spot-check review messages and applies authorization-gated verdicts (✅ audit+hard-remove / ❌ keep+record / ❓ leave UNCERTAIN) with 13 offline smoke tests including the 15647/16347 regression fixtures.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Pure resolveReaction resolver with --smoke (TDD) | fbbb727 | spotcheck-reaction-poller.js (created) |
| 2 | Wire poller main + runJob registration (smoke-guarded) | fbbb727 | spotcheck-reaction-poller.js (same commit — both tasks written together) |

## What Was Built

`spotcheck-reaction-poller.js` is a standalone daily cron job registered under `cron-wrapper.runJob` that:

1. Reads all open (unadjudicated) review messages from `spotcheck_review` via `getOpenReviewMessages`
2. For each, calls `getReactions(channel, ts)` from `lib/spotcheck-slack-bot.js`
3. Resolves reactions via the pure `resolveReaction(reactions, allowedReactors)` function:
   - `white_check_mark` from an authorized reactor → `{ action: 'remove', humanVerdict: 'CONFIRMED_MISMATCH' }`
   - `x` from an authorized reactor → `{ action: 'keep', humanVerdict: 'OVERRIDE_MATCH' }`
   - `question` from an authorized reactor → `{ action: 'leave', humanVerdict: 'UNCERTAIN' }`
   - Unauthorized reactor → `{ action: 'none' }` (T-13-12 security gate)
   - Both ✅ and ❌ from authorized reactors → `{ action: 'none', conflict: true }` (never auto-delete contested)
4. On `remove`: resolves `booli_id`/`hemnet_id` via `SELECT booli_id, hemnet_id FROM cohort_pairs WHERE id = $1`, calls `removeConfirmedMismatchPair` (audit-first, BEGIN/COMMIT, T-13-15), then `markAdjudicated`
5. On `keep`/`leave`: calls `markAdjudicated` only
6. D-12 dedup: checks `isAlreadyAdjudicated` before processing any message
7. T-13-18 idempotency: pair already absent from `cohort_pairs` → mark adjudicated rather than error

## Security Mitigations Implemented

| Threat | Mitigation in Code |
|--------|-------------------|
| T-13-12 Spoofing | `reactorAllowed(user, allowedReactors)` checks `SLACK_ALLOWED_REACTORS`; unauthorized reactor → `action: 'none'` |
| T-13-12 Tie-break | `confirmUser && overrideUser` → `{ action: 'none', conflict: true }` — contested messages never auto-deleted |
| T-13-15 Tampering | Removal only via `removeConfirmedMismatchPair`; no raw `DELETE` in poller |
| T-13-16 Repudiation | `reactor` + `reason` persisted in both `spotcheck_review` (via `markAdjudicated`) and `spotcheck_removed_pairs` |
| T-13-17 Injection | `SELECT booli_id, hemnet_id FROM cohort_pairs WHERE id = $1` — parameterised; grep gate confirmed no interpolated SQL |
| T-13-18 DoS/retry | `getReactions` null → skip cycle; absent pair → idempotent adjudication |

## Smoke Test Coverage (13 tests, all passing offline)

1. `white_check_mark` from allowed reactor → remove/CONFIRMED_MISMATCH
2. `x` from allowed reactor → keep/OVERRIDE_MATCH
3. `question` from allowed reactor → leave/UNCERTAIN
4. No reactions → action:none
5. `white_check_mark` from UNAUTHORIZED reactor → action:none (T-13-12)
6. Contested `white_check_mark` + `x` from allowed → none+conflict:true
7. Empty allowedReactors → all reactors allowed (fallback)
8. undefined allowedReactors → all reactors allowed
9. **16347-style fixture:** allowed ✅ on CONFIRMED_MISMATCH review → remove/CONFIRMED_MISMATCH
10. **15647-style fixture:** ❓ on UNCERTAIN review → leave/UNCERTAIN (never CONFIRMED_MISMATCH)
11. **16347-style:** ✅ from unauthorized → none (security gate holds)
12. **16347-style:** contested ✅+❌ from allowed → none+conflict (no auto-delete)
13. null reactions array → action:none (graceful null handling)

## Deviations from Plan

### Single-commit task delivery

Task 1 and Task 2 were implemented in a single file write and committed together (commit `fbbb727`). The plan structured them as separate commits, but since both tasks produce content in the same file and Task 1's implementation naturally accommodated Task 2's poller main while writing, separating them would have required a partial file commit and a rewrite. The single commit contains all of both tasks' acceptance criteria — all verifications pass.

No other deviations. Plan executed as written.

## Verification Results

```
node --check spotcheck-reaction-poller.js     → exit 0 (syntax clean)
node spotcheck-reaction-poller.js --smoke     → smoke: 13 pass, 0 fail (exit 0)
grep -nE "query\(\s*\`[^)]*\$\{" ...         → (no matches — no interpolated SQL)
```

Key-link assertions:
- File contains `removeConfirmedMismatchPair(` ✓
- File contains `getReactions(` ✓
- File contains `isAlreadyAdjudicated(` ✓
- File contains `markAdjudicated(` ✓
- File contains `SLACK_ALLOWED_REACTORS` ✓
- File contains `runJob({` + `scriptName: 'spotcheck-reaction-poller'` ✓
- File contains `SELECT booli_id, hemnet_id FROM cohort_pairs WHERE id = $1` ✓

## Self-Check: PASSED

- spotcheck-reaction-poller.js exists: FOUND
- Commit fbbb727 exists: FOUND
- All 13 smoke tests pass offline
- No interpolated SQL
