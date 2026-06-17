---
phase: 16-sold-match-db-schema-persistence
plan: 03
subsystem: spend-tally
tags: [oxylabs, spend-ceiling, atomic-counter, postgres, concurrency, CR-01, pluggable]

# Dependency graph
requires:
  - phase: 16-sold-match-db-schema-persistence
    plan: 01
    provides: sold_spend table (UNIQUE spend_key, calls INTEGER, updated_at) — the D-03 atomic counter store
  - phase: 15-sold-data-ingestion-library
    provides: lib/sold-transport.js file-based _spend.json ceiling + CeilingError (the thing D-03 makes DB-backed)
provides:
  - lib/sold-spend.js — pluggable Oxylabs spend tally (DB atomic increment + retained file fallback), shared CeilingError (OXY_CEILING)
  - lib/sold-transport.js wired to the pluggable tally — CR-01 inline race replaced by atomic reserveCall(); setSpendClient(client) opt-in DB ceiling; sync drain-guard preserved
  - scripts/verf-sold-transport-load.js — committed no-DB load probe (load OK no-DB)
affects: [17-match-pipeline-orchestration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pluggable counter interface { reserveCall, spent, remaining, backend } with DB + file implementations selected by client presence"
    - "Atomic check-and-increment: UPDATE ... SET calls = calls + 1 WHERE calls < $2 RETURNING calls (zero rows = ceiling), seeded by INSERT ... ON CONFLICT DO NOTHING"
    - "Shared error type defined once, re-exported from the consuming module so existing catch sites stay unchanged"

key-files:
  created:
    - lib/sold-spend.js
    - scripts/verf-sold-transport-load.js
  modified:
    - lib/sold-transport.js

key-decisions:
  - "Default tally is file-backed so a plain require of sold-transport loads with NO DB (offline recon/smoke/dumps); setSpendClient(client) is opt-in for Phase-17 DB ceiling"
  - "Sync spentCalls()/remainingCalls() kept verbatim (sold-fetch-hemnet drain guard calls remainingCalls() synchronously); async spentCallsAsync()/remainingCallsAsync() added for the DB backend"
  - "CeilingError defined once in sold-spend.js, re-exported from sold-transport — 15-04/15-05 catch sites match the shared type unchanged"
  - "D-07 count-before-issue preserved: reserveCall() runs before getWithRetry so a forced attempt consumes a credit whether or not it succeeds"

patterns-established:
  - "Spend ceiling is race-free on the DB path via a single atomic UPDATE guard — no read-then-write window for concurrent Phase-17 drivers (closes CR-01)"

requirements-completed: [DB-02, DB-03]

# Metrics
duration: 8min
completed: 2026-06-17
---

# Phase 16 Plan 03: DB-backed Atomic Spend Tally Summary

**`lib/sold-spend.js` ships a pluggable Oxylabs spend tally — a DB-backed atomic `UPDATE ... WHERE calls < $2 RETURNING calls` increment (closing the CR-01 `_spend.json` read-modify-write race for Phase-17 concurrent drivers) with the retained file-based `_spend.json` fallback for offline/no-DB runs — and `lib/sold-transport.js` is wired to it, replacing the inline non-atomic counter with `await _tally.reserveCall()` while keeping every existing export and the synchronous drain-guard.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-06-17T03:55Z (approx)
- **Completed:** 2026-06-17T04:01:35Z
- **Tasks:** 2
- **Files created:** 2 (lib/sold-spend.js, scripts/verf-sold-transport-load.js)
- **Files modified:** 1 (lib/sold-transport.js)

## Accomplishments

- `lib/sold-spend.js` created — one interface (`{ reserveCall, spent, remaining, backend }`) with two implementations:
  - **DB-backed** (`makeDbTally`): seeds the row with `INSERT INTO sold_spend (spend_key, calls) VALUES ($1, 0) ON CONFLICT (spend_key) DO NOTHING`, then atomically `UPDATE sold_spend SET calls = calls + 1, updated_at = NOW() WHERE spend_key = $1 AND calls < $2 RETURNING calls`. Zero-row RETURNING = ceiling hit → `CeilingError`. The `calls < $2` guard makes check-and-increment a single statement (no read-then-write window) — **CR-01 closed** for concurrent drivers.
  - **File-backed** (`makeFileTally`): the retained `_spend.json` `{ liveCalls }` load→check→++→save counter (same shape, same `SPEND_FILE` default so existing dumps stay readable).
- `makeSpendTally({ client, spendKey, spendFile, max })` factory: client present → DB tally, else → file tally. Defaults `max` to `MAX_OXY_CALLS` (4000) and `spendKey` to `SOLD_SPEND_KEY || 'sold-global'`.
- Shared `CeilingError` (`code: 'OXY_CEILING'`) thrown by both backends.
- `lib/sold-transport.js` wired: imports the shared `CeilingError` + `makeSpendTally`, removed its local `CeilingError` class, added module-level `_tally` (file default) + `setSpendClient(client)`, replaced the CR-01 inline block in `cachedFetch` with `const liveN = await _tally.reserveCall();`. Kept sync `spentCalls`/`remainingCalls`, added async `spentCallsAsync`/`remainingCallsAsync`, extended exports.
- `scripts/verf-sold-transport-load.js` created — committed, re-runnable no-DB load probe asserting the full export surface.
- Inline `--smoke` (6 checks, no DB/network): exports present, factory backend selection, DB seed-then-increment ordering, DB ceiling-throw, file ceiling at max=1, DB `spent()`.

## Task Commits

Each task was committed atomically:

1. **Task 1: lib/sold-spend.js — pluggable tally (DB atomic + file fallback) + --smoke** — `3d4169e` (feat)
2. **Task 2: Wire lib/sold-transport.js to the pluggable tally + load probe** — `2e10695` (feat)

**Plan metadata:** committed separately (docs: complete plan).

## Files Created/Modified

- `lib/sold-spend.js` (created) — pluggable spend tally: DB atomic increment (seed + `UPDATE ... WHERE calls < $2 RETURNING calls`) + file fallback; shared `CeilingError`; parameterized SQL only; inline `--smoke`.
- `scripts/verf-sold-transport-load.js` (created) — no-DB load probe, prints `load OK no-DB`.
- `lib/sold-transport.js` (modified) — shared `CeilingError`, `_tally` selector + `setSpendClient`, CR-01 block replaced by `await _tally.reserveCall()`, async tally reads added, all existing exports + sync drain-guard preserved.

## Decisions Made

- **Default tally is file-backed.** A plain `require('./sold-transport')` keeps the current no-DB behavior; `setSpendClient(client)` is the opt-in switch Phase 17's DB-aware driver calls once before fetching. Keeps offline recon/smoke/dumps DB-free (T-16-13).
- **Sync reads kept unchanged.** `sold-fetch-hemnet.js:151` calls `remainingCalls() <= 40` synchronously and the DB tally is async — so `spentCalls()`/`remainingCalls()` stay synchronous (file-backed fast read), and async `spentCallsAsync()`/`remainingCallsAsync()` were added for DB-backend reporting. On the file backend the sync reads are authoritative; on the DB backend the authoritative stop is the `reserveCall()` `CeilingError` throw.
- **CeilingError shared, not duplicated.** Defined once in `sold-spend.js`, re-exported from `sold-transport.js`, so `e instanceof CeilingError` / `e.code === 'OXY_CEILING'` catch sites in 15-04/15-05 keep working — verified by re-running both fetcher smokes (T-16-14).
- **D-07 invariant preserved.** `reserveCall()` runs before `getWithRetry`, so a forced Oxylabs attempt consumes a credit whether or not it succeeds (count-before-issue).

## Deviations from Plan

None — plan executed exactly as written. Both tasks implemented per the `<action>` spec; all acceptance criteria and the plan-level `<verification>` gates pass offline.

## Threat Model Compliance

All five registered threats are mitigated as planned:

- **T-16-10 (TOCTOU race / CR-01):** DB path uses a single atomic `UPDATE ... WHERE calls < $2 RETURNING calls`; guard+increment are one statement. `grep -c "spend.liveCalls += 1" lib/sold-transport.js` returns 0 (inline race removed).
- **T-16-11 (SQL injection):** all values bound via `$1,$2` placeholders; `grep` for a template-literal `${...}` inside any `query()` call returns nothing.
- **T-16-12 (credential exposure):** `sold-spend.js` never opens its own connection (receives the client); nothing secret logged.
- **T-16-13 (offline path broken):** default tally is file-backed; load probe confirms the module loads under `SCRAPE_FORCE_OXYLABS=1` with no DB; fetcher smokes still pass.
- **T-16-14 (lost ceiling stop on backend swap):** `CeilingError` shared + re-exported; both backends throw it with `OXY_CEILING`; fetcher smokes confirm catch sites unbroken.

## Issues Encountered

- **Live DB run of the DB-backed path deferred — same authorization/runtime gate as 16-01/16-02 (not a code defect).** The plan's execution-time verification (`setSpendClient(client)` against a reachable DB, two near-simultaneous `reserveCall` loops never exceeding `max`, `SELECT calls FROM sold_spend WHERE spend_key='sold-global'`) requires the `sold_spend` table to exist live, but the Phase-16 migration (`migrate-sold-phase16.js`) has not yet been run against prod (operator auth gate carried from 16-01). The DB path is exercised offline via the `--smoke` mock client (seed+increment ordering, zero-row ceiling-throw). **Operator action required (one-time, unchanged from 16-01/16-02):** run `node migrate-sold-phase16.js` on the droplet (or after `doctl` IP-whitelist), then exercise the DB ceiling via `setSpendClient(client)` to confirm the live atomic increment. All offline gates pass: `node lib/sold-spend.js --smoke` 6/6, `node scripts/verf-sold-transport-load.js` `load OK no-DB`, fetcher smokes 17/23, `node -c` on all three files, no `${}` SQL interpolation.
- **GSD SDK CLI absent in environment** (no `node_modules/@gsd-build/sdk`, no `gsd-sdk` on PATH) — same as 16-02. STATE.md + ROADMAP.md updated via direct edits instead of the state handlers.

## User Setup Required

None for this plan's code. (See "Issues Encountered" for the one-time operator migration run that unblocks the live DB ceiling — shared with 16-01/16-02, not a new requirement.)

## Next Phase Readiness

- Phase 17's concurrent driver can now call `setSpendClient(client)` once and get the race-free atomic DB ceiling for free; nothing else in the fetch path changes. Without a client it falls back to the file ceiling automatically (offline recon stays operable).
- CR-01 is closed on the DB path; the `harden-spend-ceiling-concurrency.md` todo (folded via D-03) is resolved for the sold transport.
- Outstanding (carried, not introduced here): one-time operator run of `migrate-sold-phase16.js` against prod before any live DB tally / persistence write.

## Self-Check: PASSED

- FOUND: lib/sold-spend.js
- FOUND: scripts/verf-sold-transport-load.js
- FOUND: lib/sold-transport.js (modified)
- FOUND: .planning/phases/16-sold-match-db-schema-persistence/16-03-SUMMARY.md
- FOUND commit: 3d4169e (Task 1)
- FOUND commit: 2e10695 (Task 2)

---
*Phase: 16-sold-match-db-schema-persistence*
*Completed: 2026-06-17*
