---
phase: 18-re-check-state-slutpris-lag-drain-logic
plan: 03
subsystem: sold-match-persist
tags: [sold-match, recheck, store-layer, sql, offline-smoke]
requires:
  - "Plan 01: migrate-sold-recheck-phase18.js (first_unmatched_at / recheck_until / next_recheck_at columns on sold_match)"
  - "Plan 02: lib/sold-config.js RECHECK_WINDOW_DAYS / RECHECK_INTERVAL_DAYS (semantics only; not imported here)"
provides:
  - "lib/sold-store.js: enrollRecheck, advanceRecheck, settleNonHemnet, clearRecheck, fetchDueRecheck — parameterized scheduling-state SQL primitives"
affects:
  - "Plan 04: lib/sold-recheck.js drain loop consumes these as its only sold_match SQL"
tech-stack:
  added: []
  patterns:
    - "client-first + $1,$2,... parameterized + guarded UPDATE idiom (mirrors upsertSoldVerdict)"
    - "store takes pre-computed timestamps as params; clock + window live in the caller (Plan 04)"
key-files:
  created: []
  modified:
    - "lib/sold-store.js"
decisions:
  - "settleNonHemnet and advanceRecheck guard `AND verdict = 'booli_only'` so a concurrently matched/settled row is never clobbered (T-18-06)"
  - "fetchDueRecheck excludes terminal/matched/uncertain by construction (verdict='booli_only' filter) rather than an explicit NOT IN list"
  - "Rows past recheck_until are intentionally NOT returned by fetchDueRecheck — Plan 04 settles them via a separate path, not re-search"
metrics:
  duration: "~12 min"
  completed: "2026-06-18"
  tasks: 2
  files: 1
---

# Phase 18 Plan 03: Re-check Store-Layer Scheduling Helpers Summary

Five parameterized sold_match scheduling primitives (enroll/advance/settle/clear writers + fetchDueRecheck reader) added to `lib/sold-store.js`, keeping all sold_match SQL in the established persist layer so Plan 04's drain loop stays pure orchestration. All offline-verified via the inline `--smoke` harness (25 pass, 0 fail).

## What was built

**Task 1 — writers (commit cf26a45):**
- `enrollRecheck(client, booliId, sched)` — RECHECK-01. ONE UPDATE setting `first_unmatched_at / recheck_until / next_recheck_at` guarded by `verdict='booli_only' AND first_unmatched_at IS NULL`. Idempotent: a second enroll updates zero rows. Returns rowCount.
- `advanceRecheck(client, booliId, nextRecheckAt)` — RECHECK-02. ONE UPDATE of `next_recheck_at` only, guarded `verdict='booli_only'`; verdict untouched.
- `settleNonHemnet(client, booliId, {adjudicatedAt})` — RECHECK-03. Terminal UPDATE `verdict='genuine_non_hemnet'`, `next_recheck_at=NULL`, `adjudicated_at=$2`, guarded `verdict='booli_only'`. `recheck_until / first_unmatched_at` retained for audit.
- `clearRecheck(client, booliId)` — RECHECK-02 late-match cleanup. Nulls all three scheduling columns when a re-check flips to matched.

**Task 2 — reader + smoke (commit 15a8935):**
- `fetchDueRecheck(client, {now, segment, limit})` — RECHECK-02. ONE SELECT of `verdict='booli_only' AND first_unmatched_at IS NOT NULL AND next_recheck_at <= $1 AND recheck_until >= $1`, optional `segment = $n`, `ORDER BY next_recheck_at ASC`, optional `LIMIT $n`. Returns `r.rows`.
- `mockClient()` upgraded with a `rowsToReturn` field so the SELECT test asserts seeded-row passthrough.
- 9 new offline smoke checks (exports + per-helper SQL-shape + params + seeded-row + segment/limit binding), original checks retained.

All five names added to `module.exports`.

## Verification

- `node lib/sold-store.js --smoke` → `smoke: 25 pass, 0 fail` (baseline was 12; +13 net incl. 9 new scheduling checks).
- grep gates: `enrollRecheck`, `settleNonHemnet`, `genuine_non_hemnet`, `first_unmatched_at IS NULL`, `fetchDueRecheck`, `verdict = 'booli_only'`, `next_recheck_at <= $1`, `recheck_until`, `first_unmatched_at IS NOT NULL` all present.
- Export presence one-liner exits 0 (all five are functions).
- No value concatenation in SQL — grep for `${` excluding `params.length` returns no matches; the only built fragment is the integer placeholder index `$${params.length}` (T-18-05 mitigated).
- Offline only: mock client, no DB, no network.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] advanceRecheck smoke assertion was over-broad**
- **Found during:** Task 2 (first smoke run, 24 pass / 1 fail).
- **Issue:** The plan's literal assertion `does NOT include the word "verdict ="` fails because advanceRecheck's WHERE clause legitimately contains the guard `verdict = 'booli_only'`. The plan's stated intent is "no verdict *mutation*", i.e. the SET clause must not touch verdict.
- **Fix:** Scoped the assertion to the SET clause only (`sql.split('WHERE')[0]`), preserving the plan's intent (no verdict mutation) while allowing the guard. The function code is exactly as specified in the plan.
- **Files modified:** lib/sold-store.js (smoke harness only)
- **Commit:** 15a8935

### Note on "original 9 checks"
The plan repeatedly references "the original 9 smoke checks." The file's actual baseline is **12 passes** (4 export checks + 8 functional checks). All 12 were retained; the acceptance criterion "pass count > original" holds either way (25 > 12).

## Threat surface scan

No new security surface beyond the plan's `<threat_model>`. T-18-05 (SQL injection) mitigated — every value bound via `$n`, only the integer placeholder index is string-built. T-18-06 (verdict clobber) mitigated — settle/advance both guard `AND verdict = 'booli_only'`. No threat flags.

## Known Stubs

None. All five helpers are complete parameterized SQL functions; the drain decisions they serve are implemented in Plan 04.

## Self-Check: PASSED

- FOUND: lib/sold-store.js (modified, contains all five functions + exports)
- FOUND: commit cf26a45 (Task 1 writers)
- FOUND: commit 15a8935 (Task 2 reader + smoke)
- FOUND: .planning/phases/18-re-check-state-slutpris-lag-drain-logic/18-03-SUMMARY.md
