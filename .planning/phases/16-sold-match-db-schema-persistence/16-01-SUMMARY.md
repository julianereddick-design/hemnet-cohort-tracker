---
phase: 16-sold-match-db-schema-persistence
plan: 01
subsystem: database
tags: [postgres, ddl, migration, sold-match, jsonb, spend-ceiling]

# Dependency graph
requires:
  - phase: 15-sold-data-ingestion-library
    provides: lib/sold-parse.js snake_case parser output (the booli_sold/hemnet_sold column contract)
provides:
  - Re-runnable migration migrate-sold-phase16.js creating four sold-side tables
  - booli_sold table (UNIQUE booli_id) — full lib/sold-parse.js card+detail contract
  - hemnet_sold table (UNIQUE hemnet_slug) — parseHemnetSaleCards contract
  - sold_match verdict table (design-only, empty this phase, UNIQUE booli_id, JSONB evidence)
  - sold_spend atomic counter table (UNIQUE spend_key) backing the D-03 DB ceiling
affects: [16-02-persist, 16-03-spend-tally, 17-match-pipeline-orchestration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Multi-table CREATE TABLE IF NOT EXISTS migration (migrate-spotcheck-phase13 house style)"
    - "information_schema.tables read-back verify after DDL (parameterized $1, idempotent confirm)"

key-files:
  created:
    - migrate-sold-phase16.js
  modified: []

key-decisions:
  - "sold_at stored as BIGINT (Unix epoch seconds) not DATE; sold_at_label TEXT carries human form"
  - "verdict / match_method vocabularies documented in comments, not CHECK constraints — kept loose for Phase 17"
  - "matched_hemnet_slug nullable (booli_only/uncertain is a first-class outcome, not an error)"
  - "Header comment reworded to avoid the literal 'CREATE TABLE IF NOT EXISTS' phrase so the count grep matches only real DDL"

patterns-established:
  - "Sold-side schema lives in one idempotent migration; downstream persist (16-02/16-03) writes into it"
  - "All migration SQL is static-literal DDL or parameterized $1 — zero string interpolation (T-16-01)"

requirements-completed: [DB-01]

# Metrics
duration: 2min
completed: 2026-06-17
---

# Phase 16 Plan 01: Sold-match DB Schema Migration Summary

**Idempotent Node migration creating the four sold-side Postgres tables (booli_sold, hemnet_sold, design-only sold_match verdict table, sold_spend atomic counter) with a read-back verify — column contracts 1:1 with lib/sold-parse.js.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-06-17T03:46:43Z
- **Completed:** 2026-06-17T03:48:55Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- `migrate-sold-phase16.js` created — re-runnable (`CREATE TABLE IF NOT EXISTS` for all four tables), opens its own client via `db.js createClient()`.
- `booli_sold` carries every snake_case field `lib/sold-parse.js` emits (card + detail union) plus `is_title_transfer` and `sold_in_advance`, keyed `UNIQUE(booli_id)`.
- `hemnet_sold` maps `parseHemnetSaleCards` 1:1 with the D-01 `slug` → `hemnet_slug` rename, keyed `UNIQUE(hemnet_slug)`.
- `sold_match` verdict table created design-only (empty this phase, Phase 17 populates): `UNIQUE(booli_id)`, nullable `matched_hemnet_slug`, JSONB `evidence`.
- `sold_spend` atomic counter created: `UNIQUE(spend_key)` makes the Plan-03 seed idempotent and the `calls < $2` increment race-free (closes CR-01).
- `information_schema.tables` read-back logs which of the four tables exist after a run (idempotent confirm).

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration boilerplate + booli_sold and hemnet_sold tables** - `1a9c688` (feat)
2. **Task 2: sold_match verdict table + sold_spend counter + read-back verify** - `5d40101` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Files Created/Modified
- `migrate-sold-phase16.js` - Re-runnable Node migration creating the four sold-side tables (booli_sold, hemnet_sold, sold_match, sold_spend) + read-back verify.

## Decisions Made
- `sold_at` stored as `BIGINT` (Unix epoch seconds, what the parser emits) rather than `DATE`; `sold_at_label` TEXT carries the human form.
- `verdict` (matched / booli_only / uncertain) and `match_method` (fee_exact / address_key) vocabularies documented in comments, NOT enforced via CHECK constraints — kept loose so Phase 17 can evolve them.
- `is_title_transfer` and `sold_in_advance` left nullable BOOLEAN (parsers emit null for older records — D-02/D-04).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reworded header comment so the DDL count grep is accurate**
- **Found during:** Task 1 (verify step)
- **Issue:** The file header comment contained the literal phrase `CREATE TABLE IF NOT EXISTS`, so `grep -c "CREATE TABLE IF NOT EXISTS"` returned 3 (Task 1) / would have returned 5 (Task 2) instead of the asserted 2 / 4 — the acceptance/verify gates would have failed on a cosmetic comment, not on the DDL.
- **Fix:** Reworded the comment to "each table guarded IF NOT EXISTS" so only the four real DDL statements match the count grep.
- **Files modified:** migrate-sold-phase16.js
- **Verification:** `grep -c "CREATE TABLE IF NOT EXISTS"` returns 2 after Task 1 and 4 after Task 2; both `node -c` syntax gates pass.
- **Committed in:** `1a9c688` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — verification-gate accuracy)
**Impact on plan:** Cosmetic comment fix to make the structural assertions count only real DDL. No schema change, no scope creep.

## Issues Encountered
- **Live migration run deferred (authorization gate, not a defect).** The plan's `<verification>` asks for `node migrate-sold-phase16.js` against a reachable DB to confirm all four tables are created and re-runs are idempotent. The auto-mode classifier denied executing DDL against the shared production database without explicit operator authorization. This is consistent with the plan's own note that DB reachability/IP-whitelisting is a runtime concern (whitelist local IP via doctl, or run on the already-whitelisted droplet). The offline syntax gate (`node -c`) passes and every structural acceptance criterion is met. **Operator action required:** run `node migrate-sold-phase16.js` once on the droplet (or after whitelisting local IP) to apply the schema — expected output `Tables present: booli_sold, hemnet_sold, sold_match, sold_spend`; a second run prints the same line with no error.

## User Setup Required
None - no external service configuration. (See "Issues Encountered" for the one-time operator migration run against prod.)

## Next Phase Readiness
- Schema target is in place for Plan 02 (persist booli_sold/hemnet_sold via `lib/sold-store.js` upserts) and Plan 03 (DB-backed spend tally against `sold_spend`).
- `sold_match` is created empty and design-locked (D-05) for Phase 17's `adjudicatePair` population.
- Outstanding: one-time operator run of the migration against prod (authorization-gated, see above) before Plan 02 persistence can write live rows.

## Self-Check: PASSED

- FOUND: migrate-sold-phase16.js
- FOUND: .planning/phases/16-sold-match-db-schema-persistence/16-01-SUMMARY.md
- FOUND commit: 1a9c688 (Task 1)
- FOUND commit: 5d40101 (Task 2)

---
*Phase: 16-sold-match-db-schema-persistence*
*Completed: 2026-06-17*
