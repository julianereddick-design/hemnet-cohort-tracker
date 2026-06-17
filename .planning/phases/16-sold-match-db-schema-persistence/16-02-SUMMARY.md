---
phase: 16-sold-match-db-schema-persistence
plan: 02
subsystem: database
tags: [postgres, upsert, on-conflict, sold-match, jsonb, idempotent, persist]

# Dependency graph
requires:
  - phase: 16-01
    provides: migrate-sold-phase16.js schema (booli_sold UNIQUE booli_id, hemnet_sold UNIQUE hemnet_slug, sold_match UNIQUE booli_id JSONB evidence)
  - phase: 15-sold-data-ingestion-library
    provides: lib/sold-parse.js snake_case column contract + lib/sold-config.js isTitleTransfer predicate
provides:
  - lib/sold-store.js — client-first upserts upsertBooliSold / upsertHemnetSold / upsertSoldVerdict + D-02 persistVerdictForRecord gate
  - scripts/persist-sold.js — JSONL→DB persist pass (DB store of record, JSONL retained — D-04)
  - Idempotent persistence (DB-03): ON CONFLICT DO UPDATE on every stable key, zero duplicate rows on re-run
affects: [16-03-spend-tally, 17-match-pipeline-orchestration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Client-first upsert store (spotcheck-review-store house style): exports take connected pg Client, no module-level connection"
    - "INSERT ... ON CONFLICT (stable_key) DO UPDATE SET col=EXCLUDED.col for idempotent refresh (DB-03)"
    - "JSONB column bound as JSON.stringify(obj) parameter, never concatenated (T-16-05)"
    - "D-02 title-transfer gate: parsed boolean first, isTitleTransfer config-predicate fallback"
    - "Inline --smoke with mock client capturing (sql, params), no DB / no network"

key-files:
  created:
    - lib/sold-store.js
    - scripts/persist-sold.js
  modified: []

key-decisions:
  - "Booli/Hemnet upserts use DO UPDATE (not DO NOTHING) so a detail-enriched re-fetch refreshes columns from EXCLUDED + bumps updated_at — re-running converges, never duplicates (DB-03/D-01)"
  - "persist-sold.js reads JSONL inline (split/filter/JSON.parse) rather than require('../lib/sold-transport') to avoid the SCRAPE_FORCE_OXYLABS load guard in a DB/IO-only driver"
  - "upsertSoldVerdict ships as plumbing this phase; Phase 17 fills `verdict` via adjudicatePair — sold_match stays empty in Phase 16"
  - "D-02 gate lives in persistVerdictForRecord (not upsertSoldVerdict) so callers that already have a verdict can still upsert directly; the gate is the policy layer"

requirements-completed: [DB-02, DB-03]

# Metrics
duration: 3min
completed: 2026-06-17
---

# Phase 16 Plan 02: Sold-match Persist Layer Summary

**Client-first upsert store (`lib/sold-store.js`) writing one row per `booli_id` / `hemnet_slug` / verdict into the Phase-16 sold tables via `ON CONFLICT DO UPDATE`, plus `scripts/persist-sold.js` — a JSONL→DB persist pass that makes the DB the store of record while JSONL is retained (D-04). Title transfers are stored in `booli_sold` but excluded from `sold_match` (D-02); re-running the pass yields zero duplicate rows (DB-03).**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-06-17T03:53:05Z
- **Completed:** 2026-06-17T03:55:45Z
- **Tasks:** 3
- **Files created:** 2

## Accomplishments
- `lib/sold-store.js` created — client-first, parameterized, no module-level DB connection (mirrors `lib/spotcheck-review-store.js` house style).
- `upsertBooliSold(client, row)` — 28-column INSERT in the exact `migrate-sold-phase16.js` DDL order, `ON CONFLICT (booli_id) DO UPDATE` refreshing every enriched column from `EXCLUDED` + `updated_at=NOW()`; every optional field null-coalesced (`booli_id` the only required value).
- `upsertHemnetSold(client, row)` — 18-column INSERT, `ON CONFLICT (hemnet_slug) DO UPDATE`; parser field `row.slug` mapped to column `hemnet_slug` (D-01).
- `upsertSoldVerdict(client, row)` — `INSERT INTO sold_match ... ON CONFLICT (booli_id) DO UPDATE`; `evidence` bound as `JSON.stringify` for the JSONB column (never concatenated); `matched_hemnet_slug` null accepted (booli_only is first-class).
- `persistVerdictForRecord(client, record, verdict)` — the D-02 gate: title transfers (parsed `is_title_transfer`, falling back to `isTitleTransfer(sold_price_type)`) never enter the match table; returns false + issues zero queries for a transfer.
- Inline `--smoke` (12 checks, mock client, no DB/network) covers exports, all three ON CONFLICT clauses, evidence JSON-stringify, the D-02 transfer skip (zero queries), the market-sale write, the config-predicate fallback, and null `matched_hemnet_slug`.
- `scripts/persist-sold.js` created — opens its OWN pg client via `db.js createClient()`, loops each JSONL record through the store upsert, always closes the client in a `finally`; `--smoke` offline self-test passes; `--booli` / `--hemnet` flags. JSONL read inline to avoid the transport load guard.

## Task Commits

Each task was committed atomically:

1. **Task 1: upsertBooliSold + upsertHemnetSold** — `389c1ee` (feat)
2. **Task 2: upsertSoldVerdict + D-02 gate + inline --smoke** — `c4d45a9` (feat)
3. **Task 3: scripts/persist-sold.js JSONL→DB pass** — `85bb280` (feat)

**Plan metadata:** committed separately (docs: complete plan).

## Files Created/Modified
- `lib/sold-store.js` — client-first upsert functions for `booli_sold` / `hemnet_sold` / `sold_match` with parameterized `ON CONFLICT DO UPDATE`, the D-02 title-transfer gate, and an inline 12-check `--smoke`.
- `scripts/persist-sold.js` — JSONL→DB persist pass that opens its own client and upserts via `lib/sold-store.js`; offline `--smoke`; fetcher JSONL append left untouched (D-04).

## Decisions Made
- Booli/Hemnet upserts use `DO UPDATE` (not `DO NOTHING`): a detail-enriched re-fetch must refresh the card-only row's columns from `EXCLUDED` and bump `updated_at` — re-running converges, never duplicates (DB-03 / D-01).
- `scripts/persist-sold.js` reads JSONL inline (`split('\n').filter(Boolean).map(JSON.parse)`) rather than `require('../lib/sold-transport')` so the DB/IO-only persist driver does not pull in the `SCRAPE_FORCE_OXYLABS` load guard that `sold-transport` throws on at require time.
- `upsertSoldVerdict` ships now as plumbing; Phase 17 fills `verdict` via `adjudicatePair`. `sold_match` stays empty this phase.
- The D-02 gate lives in `persistVerdictForRecord` (the policy layer), not inside `upsertSoldVerdict`, so a caller that already holds a verdict can still upsert directly while batch persistence routes through the gate.

## Deviations from Plan

None — plan executed exactly as written. The three tasks' actions, SQL shapes, smoke coverage, and acceptance greps were followed verbatim; all gates passed on first run.

## Threat Surface
All four threats with a `mitigate` disposition are addressed in code:
- **T-16-05 (SQL injection):** every value passes through `$1..$N` bound parameters; column lists are static literals; JSONB `evidence` is bound as a `JSON.stringify` parameter. Acceptance grep confirms no `${` interpolation in any query.
- **T-16-07 (duplicate / data-loss on re-run):** `ON CONFLICT (stable_key) DO UPDATE` — one row per `booli_id` / `hemnet_slug`, `DO UPDATE` refreshes from `EXCLUDED` without dropping the row.
- **T-16-08 (title transfer in match set):** `persistVerdictForRecord` skips the verdict upsert for transfers; smoke asserts zero `sold_match` writes for a transfer record.
- **T-16-09 (connection leak):** `await client.end()` in a `finally` block guarantees release on error.
- **T-16-06 (credential exposure):** `createClient()` reads `.env` only; only counts are logged, never row contents.

No new security surface introduced beyond the plan's threat model.

## Issues Encountered
- **Execution-time live persist run deferred (runtime / authorization gate, not a code defect).** The plan's `<verification>` execution-time check — `node scripts/persist-sold.js --booli verf-soldspike/seeds/<segKey>.jsonl` upserting into `booli_sold`, with a second run leaving the row count unchanged — requires the Plan-01 migration (`migrate-sold-phase16.js`) to have been applied to a reachable DB. Per the prior-wave context, that live migration is itself authorization-gated and has NOT yet been run against prod (auto-mode denied DDL against the shared production database). The tables therefore do not exist live, so a live persist run would fail on missing tables — classified as the same authorization/runtime gate, not a code failure. The offline gates all pass: `node lib/sold-store.js --smoke` (12/12), `node scripts/persist-sold.js --smoke` (ok), `node -c` syntax, and the no-`${`-interpolation grep. **Operator action required (carried from 16-01):** run `node migrate-sold-phase16.js` once on the droplet (or after `doctl` IP-whitelist), then `node scripts/persist-sold.js --booli <seed.jsonl>` twice to confirm idempotency (`SELECT count(*) FROM booli_sold` unchanged on the second run).
- **GSD SDK CLI unavailable in this environment.** Neither `node_modules/@gsd-build/sdk/dist/cli.js` nor a `gsd-sdk` on PATH is present, so the `gsd-sdk query state.*` / `roadmap.*` / `requirements.*` handlers could not be invoked. STATE.md and ROADMAP.md were updated directly via edits instead (position advanced to Plan 2-of-3 complete, progress 2/3, decisions appended). The final metadata commit includes those files.

## User Setup Required
None for the code. (See "Issues Encountered" for the one-time operator migration run + idempotency check against prod, carried forward from 16-01.)

## Next Phase Readiness
- Persist layer is in place for Plan 03 (DB-backed spend tally against `sold_spend`) and Phase 17 (`adjudicatePair` populates `sold_match` via the already-plumbed `upsertSoldVerdict` + D-02 gate).
- `sold_match` remains design-locked and empty (D-05) until Phase 17.
- Outstanding (carried from 16-01): one-time operator run of `migrate-sold-phase16.js` against prod before any live persist can write rows.

## Self-Check: PASSED

- FOUND: lib/sold-store.js
- FOUND: scripts/persist-sold.js
- FOUND: .planning/phases/16-sold-match-db-schema-persistence/16-02-SUMMARY.md
- FOUND commit: 389c1ee (Task 1)
- FOUND commit: c4d45a9 (Task 2)
- FOUND commit: 85bb280 (Task 3)

---
*Phase: 16-sold-match-db-schema-persistence*
*Completed: 2026-06-17*
