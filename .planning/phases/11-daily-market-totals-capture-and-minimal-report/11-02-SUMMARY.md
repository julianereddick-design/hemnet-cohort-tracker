---
phase: 11-daily-market-totals-capture-and-minimal-report
plan: "02"
subsystem: market-totals-capture
tags: [market-totals, regression-test, offline-test, deploy-instructions, observability]
dependency_graph:
  requires: [market-totals-daily.js (assertNumericTotal + pickByPrefix helpers — 11-01)]
  provides: [scripts/test-market-totals-probe.js, deploy-instructions.md diagnosis section]
  affects: [deploy-instructions.md]
tech_stack:
  added: []
  patterns: [framework-free Node inline test, source-equivalence drift guard, operator runbook paragraph]
key_files:
  created: [scripts/test-market-totals-probe.js]
  modified: [deploy-instructions.md]
decisions:
  - "Helpers copied verbatim into test (no require) to avoid runJob() side effect on module load; drift caught by Test 16 source-equivalence sentinel check"
  - "Diagnosis paragraph appended at end of deploy-instructions.md (after rollback section) — no existing content modified"
  - "Test 16 uses two sentinel strings to catch any future weakening of either helper"
metrics:
  duration: "~2 min"
  completed: "2026-05-27"
  tasks_complete: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
---

# Phase 11 Plan 02: Offline Regression Test + Operator Diagnosis Note Summary

**One-liner:** Framework-free 16-case Node regression test pins assertNumericTotal + pickByPrefix contract against synthetic fixtures with source-equivalence drift guard; operator diagnosis paragraph added to deploy-instructions.md covering the JSON-path-break Slack alert path and explicit D-03 delta-alarm clarification.

## Completed Tasks

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Write offline regression test for JSON-path smoke probe | e6cc111 | `scripts/test-market-totals-probe.js` (128 lines) |
| 2 | Add operator diagnosis paragraph for JSON-path-break alerts | 79c65a4 | `deploy-instructions.md` (+15 lines) |

## Task 1: Offline Regression Test

**File:** `scripts/test-market-totals-probe.js` (128 lines)

**Test cases (16/16 pass):**

| # | Description | Helper | Expected |
|---|-------------|--------|----------|
| 1 | positive int 50769 | assertNumericTotal | does NOT throw |
| 2 | positive int 1 | assertNumericTotal | does NOT throw |
| 3 | undefined | assertNumericTotal | throws; message contains 'JSON path missing for x' AND 'undefined' |
| 4 | null | assertNumericTotal | throws (typeof guard) |
| 5 | NaN | assertNumericTotal | throws (Number.isNaN guard) |
| 6 | 0 | assertNumericTotal | throws (n <= 0) |
| 7 | -5 | assertNumericTotal | throws (n <= 0) |
| 8 | string '50769' | assertNumericTotal | throws (typeof guard) |
| 9 | Infinity | assertNumericTotal | throws (Number.isFinite guard) |
| 10 | label propagation | assertNumericTotal | throws; message contains 'hemnet.till_salu' |
| 11 | hemnet searchForSaleListings.total | pickByPrefix | returns 50769 |
| 12 | no matching prefix | pickByPrefix | returns undefined |
| 13 | null rootQuery | pickByPrefix | returns undefined (null guard) |
| 14 | matching key with null node | pickByPrefix | returns undefined (no TypeError) |
| 15 | booli searchForSale.totalCount | pickByPrefix | returns 60560 |
| 16 | source-equivalence drift guard | both helpers | reads market-totals-daily.js, asserts both sentinel strings present |

**Verification:** `node scripts/test-market-totals-probe.js` → exits 0, stdout `PASS: 16/16`

**Key implementation decisions:**
- No `require('../market-totals-daily.js')` — avoids runJob() DB client side effect on module load
- No test framework dependency (plain Node, plain console.log, process.exit)
- Test 16 asserts two sentinel strings in market-totals-daily.js: `if (typeof n !== 'number' || !Number.isFinite(n) || Number.isNaN(n) || n <= 0)` and `for (const k of Object.keys(rootQuery))` — any future refactor weakening either helper will flip Test 16 from pass to fail with a clear remediation message

**Negative regression check (manual verification):** The test structurally guarantees this works — Test 6 and Test 7 verify that `0` and `-5` throw; if the `n <= 0` check were softened to `n < 0`, both would stop throwing and those test cases would fail. Test 16 would catch removal of the sentinel line entirely. No automated negative-regression run was executed (this is a manual operator check per the acceptance criteria).

## Task 2: Operator Diagnosis Note

**File:** `deploy-instructions.md`

**Insertion point:** Appended at the end of the file, directly after the "Self-hosted code stays deployed..." sentence at the bottom of the Rollback section. No existing content was modified.

**Section added:** `### Diagnosing market-totals-daily Slack alerts`

**Coverage:**
1. **Alert path 1 (`JSON path missing for <label>`):** 4 ordered root causes (Apollo call-signature rename, extractNextData shape change, Cloudflare interstitial, real market crash) with specific fix procedures per cause. References `node scripts/test-market-totals-probe.js` as the offline verification gate after any fix.
2. **Alert path 2 (`Expected 4 rows upserted, got N`):** validate() row-count warning — Apollo serialization drift or UPSERT race; points to `cron_job_log.result_summary.perRow` for triage.
3. **D-03 clarification:** Explicit statement that Phase 11 does NOT alert on WoW/DoD deltas — delta swings surface in the Monday weekly market-supply-pulse Slack, not as alerts.

**Acceptance checks (all pass):**
- `grep -q "Diagnosing .market-totals-daily. Slack alerts" deploy-instructions.md` → 0
- `grep -q "JSON path missing for" deploy-instructions.md` → 0
- `grep -q "scripts/test-market-totals-probe.js" deploy-instructions.md` → 0
- `grep -q "deliberately does NOT alert on WoW/DoD deltas" deploy-instructions.md` → 0
- `grep -c "node market-totals-daily.js" deploy-instructions.md` → 1

## Deviations from Plan

None — plan executed exactly as written. Both task skeletons and verbatim block content provided in the plan were used as-is.

## Known Stubs

None. The test is fully wired against the real `market-totals-daily.js` on disk (Test 16 sentinel read). The diagnosis paragraph is complete prose requiring no further wiring.

## Threat Flags

None. `scripts/test-market-totals-probe.js` is a read-only offline test script — no network calls, no DB access, no new endpoints. `deploy-instructions.md` is documentation only.

## Self-Check: PASSED

- `scripts/test-market-totals-probe.js` exists: CONFIRMED
- `node scripts/test-market-totals-probe.js` exits 0 with PASS: 16/16: CONFIRMED
- `deploy-instructions.md` diagnosis section present: CONFIRMED (all 5 grep checks pass)
- No STATE.md or ROADMAP.md modifications: CONFIRMED
- Commits exist:
  - `e6cc111` (Task 1 — offline regression test)
  - `79c65a4` (Task 2 — operator diagnosis note)
