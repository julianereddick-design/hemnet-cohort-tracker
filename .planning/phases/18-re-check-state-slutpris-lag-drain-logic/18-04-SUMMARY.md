---
phase: 18-re-check-state-slutpris-lag-drain-logic
plan: 04
subsystem: sold-match
tags: [recheck, drain-loop, slutpris-lag, scheduling, offline-smoke]
requires:
  - lib/sold-store.js (Plan 03 scheduling helpers: enrollRecheck/fetchDueRecheck/advanceRecheck/settleNonHemnet/clearRecheck)
  - lib/sold-config.js (Plan 02 RECHECK_WINDOW_DAYS/RECHECK_INTERVAL_DAYS)
  - scripts/sold-match-run.js (Phase 17 matchOne — re-used, not re-implemented)
provides:
  - lib/sold-recheck.js (enrollUnmatched, runRecheck, settleExpired drain orchestration over an injected clock)
affects:
  - Phase 19 cron orchestrator (calls the three functions inside cron-wrapper.runJob)
  - Phase 20 reporting (consumes the machine-readable count objects)
tech-stack:
  added: []
  patterns:
    - injected-clock (toISO/addDaysISO) — deterministic timestamps, no bare new Date() in date math
    - deps-injection (matchOne/loadBooliRecord/fetchExpired) — offline smoke stubs every DB+network edge
    - lazy require of the runner (resolveMatchOne) — keeps require('./sold-recheck') network-free
key-files:
  created:
    - lib/sold-recheck.js
  modified: []
decisions:
  - "Re-used the Phase-17 matchOne verbatim (deps-injected) rather than re-implementing matching — late re-checks flow through the SAME adjudication + persist path."
  - "settleExpired uses a deps.fetchExpired hook (default = parameterized SELECT) so the offline smoke seeds past-window rows DB-free; the terminal settle is itself the unbounded-spend control (T-18-09)."
  - "Lazy require of scripts/sold-match-run.js inside resolveMatchOne — the runner sets SCRAPE_FORCE_OXYLABS on its first line, so a top-level require would couple the lib to the live transport."
metrics:
  duration: ~25m
  completed: 2026-06-18
  tasks: 3
  files: 1
---

# Phase 18 Plan 04: Re-check drain loop (lib/sold-recheck.js) Summary

Built the genuinely-new drain logic of the slutpris-lag milestone: three clock-injected orchestration functions in `lib/sold-recheck.js` that enroll unmatched `booli_only` sold rows with scheduling state (RECHECK-01), re-run the SAME Phase-17 `matchOne` for due in-window rows — flipping late matches to `matched` and advancing the rest (RECHECK-02) — and settle past-window rows to the terminal `genuine_non_hemnet` verdict so they are never re-searched (RECHECK-03), with the window/interval read from config (RECHECK-04). The whole loop is proven offline by an inline 11-check `--smoke` over a fixed clock, a mock pg client, and a stubbed matchOne — zero Oxylabs spend, zero live DB writes (SC-5).

## What was built

- **`enrollUnmatched(client, { now, rows })`** (RECHECK-01) — stamps `first_unmatched_at = now`, `recheck_until = now + RECHECK_WINDOW_DAYS`, `next_recheck_at = now + RECHECK_INTERVAL_DAYS` on each supplied booli_only row via the Plan-03 `enrollRecheck`. Row-driven so the smoke (and Phase 19) supply the rows; returns `{ enrolled }`.
- **`runRecheck(client, { now, segments, limit?, log?, deps })`** (RECHECK-02) — loads due rows via `fetchDueRecheck`, rebuilds `seg` from `segments[row.segment]` + the full booli record via `loadBooliRecord`, re-runs the deps-injectable `matchOne(client, record, seg, segKey, minSoldDate, maxSoldDate, log, deps)`. A `'matched'` verdict → `clearRecheck` (leaves the queue) + `lateMatched++`; any other verdict → `advanceRecheck(now + RECHECK_INTERVAL_DAYS)` + `stillPending++`. Returns `{ rechecked, lateMatched, stillPending }`. A `CeilingError` from matchOne propagates unchanged so the Phase-19 batch ceiling still stops the drain.
- **`settleExpired(client, { now, deps })`** (RECHECK-03) — fetches booli_only rows past `recheck_until` (default: parameterized SELECT; `deps.fetchExpired` for the smoke) and settles each via `settleNonHemnet`. Returns `{ settledNonHemnet }`.
- **Injected clock + helpers** — `toISO` (Date | ISO string | undefined → ISO) and pure `addDaysISO`; no bare `new Date()` in any date-math path (SC-5).
- **`resolveMatchOne` / `loadBooliRecord`** — deps-first resolution; the real runner is **lazily** required (count == 1, inside `resolveMatchOne`) so `require('./sold-recheck')` is network-free.
- **Thin `main()`** — a bare `node lib/sold-recheck.js` prints usage and exits 0 with no DB connect; the live drain is Phase 19's job.
- **Inline `--smoke`** — 11 offline checks: addDaysISO/toISO determinism, enroll window stamping, late-match-flip, still-pending-advance, no-due zero counts, unknown-segment skip, in-window/past-window settle, full enroll→recheck→settle lifecycle, and CeilingError propagation.

## Tasks completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | enrollUnmatched + settleExpired (clock-injected) | 6aa2898 | lib/sold-recheck.js |
| 2 | runRecheck — re-run matchOne; flip late matches, advance rest | b70244c | lib/sold-recheck.js |
| 3 | Offline --smoke (mocked clock + stubbed search) | 4868e6c | lib/sold-recheck.js |

## Verification

- `node -c lib/sold-recheck.js` → exits 0.
- `node lib/sold-recheck.js --smoke` → `smoke: 11 pass, 0 fail`, exit 0.
- `node -e "require('./lib/sold-recheck')"` → loads with no DB/network (lib decoupled).
- `grep -c "require('../scripts/sold-match-run')"` == 1, inside `resolveMatchOne` (lazy).
- Both inline queries (`settleExpired` SELECT, `loadBooliRecord` SELECT) use `$1` — no `${` value interpolation (T-18-08). All other writes go through the Plan-03 parameterized store helpers.
- No `createClient` / `.connect(` anywhere in the file.

Live wet run (real matchOne against Oxylabs/DB) is deliberately NOT a plan acceptance criterion — it is the operator-gated Phase-19 cron step.

## Deviations from Plan

None — plan executed exactly as written. The three tasks map 1:1 to the three commits; all acceptance criteria and grep gates pass.

## Threat surface

No new external surface. The two inline queries are parameterized (T-18-08, mitigated). The terminal `genuine_non_hemnet` settle + `fetchDueRecheck`'s past-window exclusion are the unbounded-re-search-spend control (T-18-09, mitigated); a CeilingError propagates unchanged to stop the drain mid-run. Verdict changes stamp `adjudicated_at` and retain `first_unmatched_at`/`recheck_until` for audit (T-18-10, accepted — offline lib, single operator).

## Self-Check: PASSED

- FOUND: lib/sold-recheck.js
- FOUND commit 6aa2898 (Task 1)
- FOUND commit b70244c (Task 2)
- FOUND commit 4868e6c (Task 3)
