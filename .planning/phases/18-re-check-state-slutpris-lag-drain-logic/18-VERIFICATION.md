---
phase: 18-re-check-state-slutpris-lag-drain-logic
verified: 2026-06-18T00:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
---

# Phase 18: Re-check state + slutpris-lag drain logic Verification Report

**Phase Goal:** Unmatched `booli_only` sold records carry re-check scheduling state and are re-attempted against Hemnet `/salda` until a configurable ~4-week window expires — late matches flip to `matched` with evidence, records still unmatched at window-end settle to a terminal `genuine non-Hemnet` verdict and stop consuming Hemnet searches. This drains slutpris-lag contamination out of the raw `booli_only` rate.
**Verified:** 2026-06-18
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | Unmatched `booli_only` record persists re-check scheduling state (`first_unmatched_at`, `recheck_until`, `next_recheck_at`) and is queryable as "due for re-check" later — offline against migrated schema | ✓ VERIFIED | `migrate-sold-recheck-phase18.js:25-43` adds all three TIMESTAMPTZ cols via `ALTER TABLE sold_match ADD COLUMN IF NOT EXISTS` + parameterized read-back. `lib/sold-store.js` `enrollRecheck` (157) stamps state; `fetchDueRecheck` (214) selects `verdict='booli_only' AND first_unmatched_at IS NOT NULL AND next_recheck_at <= $1 AND recheck_until >= $1`. `node -c` OK; store smoke 25/25 |
| 2 | A re-check pass re-runs the Hemnet `/salda` search for a due in-window record; a late match flips verdict to `matched` with evidence and removes it from the queue | ✓ VERIFIED | `lib/sold-recheck.js` `runRecheck` (134) loads due rows via `fetchDueRecheck`, re-runs `matchOne` (deps-injected, real one lazily required from `scripts/sold-match-run.js`, signature matches export at `sold-match-run.js:232`); on `'matched'` calls `clearRecheck` + `lateMatched++`. Smoke check 4 asserts `clearRecheck` ran (`SET first_unmatched_at = NULL`). matchOne persists verdict+evidence internally (Phase 17 path) |
| 3 | (RECHECK-03) Records still unmatched past `recheck_until` settle to terminal `genuine_non_hemnet` and never re-searched | ✓ VERIFIED | `settleNonHemnet` (`sold-store.js:183`) sets `verdict='genuine_non_hemnet', next_recheck_at=NULL` guarded `AND verdict='booli_only'`; `settleExpired` (`sold-recheck.js:90`) loads `recheck_until < $1` rows and settles. `fetchDueRecheck` excludes terminal rows by `verdict='booli_only'` filter → never re-searched. Smoke checks 8/9 confirm both branches |
| 4 | (RECHECK-04) Window/interval configurable without code edit (env override) | ✓ VERIFIED | `lib/sold-config.js:54` `posIntEnv` validates env; `RECHECK_WINDOW_DAYS` (66) default 28, `RECHECK_INTERVAL_DAYS` (67) default 7, both exported. Live-tested: `RECHECK_WINDOW_DAYS=21` → 21; `=0` → 28; `=abc` → 28. config smoke 25/25 |
| 5 | Whole drain loop runs offline (mocked clock + stubbed search + mock pg client) with zero Oxylabs spend and zero live DB writes | ✓ VERIFIED | `lib/sold-recheck.js --smoke` → `11 pass, 0 fail`. Uses fixed clock `T0/T_DUE/T_EXPIRED`, `mockClient()`, `deps.matchOne` stub. Full-lifecycle check 10 chains enroll→recheck→settle. `require('./lib/sold-recheck')` loads clean with no DB/network (verified) |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `migrate-sold-recheck-phase18.js` | Idempotent ALTER adding 3 cols + read-back | ✓ VERIFIED | 55 lines; `ADD COLUMN IF NOT EXISTS` ×3, parameterized `ANY($1::text[])` read-back, `client.end()` in finally, `node -c` OK, committed `0bd6463` |
| `lib/sold-config.js` | `RECHECK_WINDOW_DAYS`/`RECHECK_INTERVAL_DAYS` + validated env override | ✓ VERIFIED | `posIntEnv` helper + 2 constants exported; env-override behavior live-tested; backward-compat exports retained; committed `ba1ce6f` |
| `lib/sold-store.js` | 5 parameterized scheduling helpers | ✓ VERIFIED | `enrollRecheck`/`advanceRecheck`/`settleNonHemnet`/`clearRecheck`/`fetchDueRecheck` all present + in `module.exports` (line 232-235); original 9 smoke checks retained (25 total); committed `cf26a45`/`15a8935` |
| `lib/sold-recheck.js` | enroll/runRecheck/settle drain w/ injected clock + smoke | ✓ VERIFIED | 416 lines; all 3 + helpers exported; inline `--smoke` 11/11; lazy matchOne require count=1 inside `resolveMatchOne`; committed `6aa2898`/`b70244c`/`4868e6c` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `migrate-sold-recheck-phase18.js` | `sold_match` | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | ✓ WIRED | Static literal at lines 26-29 |
| `lib/sold-config.js` | `process.env.RECHECK_WINDOW_DAYS` | validated env override | ✓ WIRED | `posIntEnv('RECHECK_WINDOW_DAYS', 28)` line 66; live-tested |
| `lib/sold-store.js fetchDueRecheck` | sold_match scheduling cols | `next_recheck_at <= $1` | ✓ WIRED | Line 223 |
| `lib/sold-store.js settleNonHemnet` | sold_match.verdict | `verdict='genuine_non_hemnet'` | ✓ WIRED | Line 186 |
| `lib/sold-recheck.js runRecheck` | `sold-match-run.js matchOne` | lazy deps-injected re-run | ✓ WIRED | `resolveMatchOne` (120) → `require('../scripts/sold-match-run').matchOne`, count=1; matchOne exported with matching 8-arg signature (`sold-match-run.js:232/462`) |
| `lib/sold-recheck.js` | sold-store scheduling helpers | imports | ✓ WIRED | Destructured import line 34-36 |
| `lib/sold-recheck.js` | `lib/sold-config.js RECHECK_WINDOW_DAYS` | config import | ✓ WIRED | Line 33; used in enroll/run date math |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Migration syntax | `node -c migrate-sold-recheck-phase18.js` | exit 0 | ✓ PASS |
| Config smoke | `node lib/sold-config.js --smoke` | 25 pass, 0 fail | ✓ PASS |
| Store smoke | `node lib/sold-store.js --smoke` | 25 pass, 0 fail | ✓ PASS |
| Recheck drain smoke | `node lib/sold-recheck.js --smoke` | 11 pass, 0 fail | ✓ PASS |
| Env override (21) | `RECHECK_WINDOW_DAYS=21 node -e ...` | 21 | ✓ PASS |
| Invalid override (0→28, abc→28) | `RECHECK_WINDOW_DAYS=0/abc node -e ...` | 28 | ✓ PASS |
| Library loads no DB/network | `node -e "require('./lib/sold-recheck')"` | 3 funcs exported, clean load | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| RECHECK-01 | 18-01, 18-03, 18-04 | Persist re-check scheduling state | ✓ SATISFIED | Migration cols + `enrollRecheck`/`enrollUnmatched` |
| RECHECK-02 | 18-03, 18-04 | Re-attempt due records; late match flips + dequeues | ✓ SATISFIED | `fetchDueRecheck` + `runRecheck` + `clearRecheck`/`advanceRecheck` |
| RECHECK-03 | 18-03, 18-04 | Settle to terminal `genuine_non_hemnet`, never re-searched | ✓ SATISFIED | `settleNonHemnet` + `settleExpired`; excluded from due query |
| RECHECK-04 | 18-02, 18-04 | Window configurable without code edit | ✓ SATISFIED | `posIntEnv` env override, live-tested |

No orphaned requirements: REQUIREMENTS.md maps exactly RECHECK-01..04 to Phase 18, all claimed by plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `lib/sold-recheck.js` | 27,28,38,119 | `SCRAPE_FORCE_OXYLABS` mentioned | ℹ️ Info | All four are COMMENTS explaining why it is deliberately NOT set at module top; clean-load test confirms no actual coupling. Not a stub |
| `lib/sold-store.js` | 225,227 | `$${params.length}` in SQL | ℹ️ Info | Interpolates an integer placeholder INDEX, not a value; the value is bound via params (T-18-05 mitigation). Confirmed safe |

No blocker or warning anti-patterns. No TODO/FIXME/placeholder/stub returns in any phase-18 file. SQL is fully parameterized (no `${value}` interpolation).

### Human Verification Required

None. The phase acceptance bar is offline-complete (consistent with Phases 15-17). Live DDL execution of `migrate-sold-recheck-phase18.js` against prod and the live drain (Phase 19 cron) are deliberately operator-gated and explicitly NOT part of Phase 18 acceptance per the ROADMAP success criteria (all five are offline-verifiable).

### Gaps Summary

No gaps. All five ROADMAP success criteria are verified against the actual codebase, all four artifacts exist/substantive/wired, all seven key links are connected, all four offline smoke suites pass (25/25/25/11), env-override behavior is live-confirmed, and the lib loads with zero DB/network. All four requirement IDs (RECHECK-01..04) are satisfied with concrete code evidence. The TDD commit sequence (test before feat in 18-02) is present and `migrate-sold-phase16.js` was untouched in this phase.

---

_Verified: 2026-06-18_
_Verifier: Claude (gsd-verifier)_
