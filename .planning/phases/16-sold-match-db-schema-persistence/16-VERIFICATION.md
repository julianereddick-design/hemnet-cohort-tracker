---
phase: 16-sold-match-db-schema-persistence
verified: 2026-06-17T04:43:32Z
status: human_needed
score: 3/3 must-haves verified (code-level); live-DB apply pending operator action
overrides_applied: 0
human_verification:
  - test: "Apply the migration against the project Postgres: run `node migrate-sold-phase16.js` (on the already-whitelisted droplet, or after `doctl` IP-whitelist of the local IP)."
    expected: "Prints `Created table: booli_sold` / `hemnet_sold` / `sold_match` / `sold_spend` and `Tables present: booli_sold, hemnet_sold, sold_match, sold_spend`. A second run prints the same line with no error (idempotent IF NOT EXISTS)."
    why_human: "Writing DDL to the shared production Postgres requires explicit operator authorization (auto-mode classifier denied live DDL). Cannot be exercised offline."
  - test: "Live idempotency check: after the migration, run `node scripts/persist-sold.js --booli <seed.jsonl>` twice."
    expected: "First run prints `persisted: booli=N ...`; `SELECT count(*) FROM booli_sold` is unchanged after the second run (ON CONFLICT (booli_id) DO UPDATE — zero duplicate rows, DB-03)."
    why_human: "Requires the live tables to exist and a reachable prod DB; gated on the same operator authorization as the migration run."
  - test: "Live atomic spend ceiling: with `setSpendClient(client)` set, run two near-simultaneous reserveCall loops."
    expected: "`SELECT calls FROM sold_spend WHERE spend_key='sold-global'` never exceeds the configured ceiling (atomic UPDATE ... WHERE calls < $2 RETURNING — closes CR-01)."
    why_human: "Concurrency behavior against the live sold_spend row needs a reachable DB; offline smoke proves the single-statement logic but not real concurrent execution."
---

# Phase 16: Sold-match DB Schema & Persistence Verification Report

**Phase Goal:** A migrated sold-side schema (Booli-sold table, Hemnet-`/salda` table, match/verdict table — including enriched columns and the `sold_in_advance` flag) plus an idempotent upsert layer replaces the spike's DB-free JSON output, so re-runs converge without duplicate rows.
**Verified:** 2026-06-17T04:43:32Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

The phase goal is achieved at the **code level**: the migration defines the correct three sold-side tables plus the spend counter with the right columns and stable UNIQUE keys; the upsert layer uses `ON CONFLICT` on those stable keys so re-runs converge; and the persist pass replaces JSON output by upserting fetcher JSONL into the DB. The only outstanding work is the one-time live DDL/write run against the shared production Postgres, which is operator-gated (not a code defect) and surfaced as human verification.

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | A migration creates three sold-side tables (Booli-sold, Hemnet-`/salda`, match/verdict) carrying enriched attributes + `sold_in_advance`, in the project DB | ✓ VERIFIED (code) | `migrate-sold-phase16.js` has exactly 4 `CREATE TABLE IF NOT EXISTS` blocks (`grep -c`=4): `booli_sold` (incl. `is_title_transfer BOOLEAN`, `sold_in_advance BOOLEAN`, UNIQUE(booli_id)), `hemnet_sold` (UNIQUE(hemnet_slug)), `sold_match` (UNIQUE(booli_id), JSONB evidence), `sold_spend` (UNIQUE(spend_key)). `node -c` passes. Columns are 1:1 with `lib/sold-parse.js` (`parseBooliSoldCards` l.65-81 + `parseBooliSoldDetail` l.90-114, incl. `sold_in_advance` l.112; `parseHemnetSaleCards` l.129-159, `slug`→`hemnet_slug`). Live apply pending (human item 1). |
| 2 | The pipeline persists Booli seeds, Hemnet sold cards, and match verdicts to those tables instead of writing JSON files | ✓ VERIFIED (code) | `lib/sold-store.js`: `upsertBooliSold` (28-col INSERT, `$1..$28`), `upsertHemnetSold` (`row.slug`→hemnet_slug), `upsertSoldVerdict` (INSERT INTO sold_match, JSONB evidence). `scripts/persist-sold.js` opens its own client via `createClient()`, reads fetcher JSONL, loops `upsertBooliSold(client, rec)` / `upsertHemnetSold(client, rec)`, closes client in `finally`. Store smoke 12/12, persist smoke ok. Live writes pending (human item 2). |
| 3 | Re-running the same segment+window upserts by stable keys (booli_id / hemnet slug / pair) and produces no duplicate rows | ✓ VERIFIED (code) | Every upsert uses `ON CONFLICT (<stable_key>) DO UPDATE SET col=EXCLUDED.col`: booli_sold→`ON CONFLICT (booli_id)`, hemnet_sold→`ON CONFLICT (hemnet_slug)`, sold_match→`ON CONFLICT (booli_id)`. DB spend tally is an atomic `UPDATE ... WHERE calls < $2 RETURNING calls` seeded by `INSERT ... ON CONFLICT (spend_key) DO NOTHING`. One row per stable key by construction. Live re-run count check pending (human item 2). |

**Score:** 3/3 truths verified at code level (live-DB execution = human verification, per operator-authorization gate)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `migrate-sold-phase16.js` | Re-runnable migration, 4 sold-side tables | ✓ VERIFIED | 150 lines, 4 `CREATE TABLE IF NOT EXISTS`, opens own client via `require('./db').createClient()`, read-back verify via `information_schema.tables` (`ANY($1::text[])` parameterized). `node -c` OK. |
| `lib/sold-store.js` | Client-first upserts for the three sold tables + D-02 gate | ✓ VERIFIED | 252 lines; `upsertBooliSold`/`upsertHemnetSold`/`upsertSoldVerdict`/`persistVerdictForRecord`; all parameterized; inline `--smoke` 12/12. Imported by `scripts/persist-sold.js` (WIRED). |
| `scripts/persist-sold.js` | JSONL→DB persist pass | ✓ VERIFIED | 70 lines; requires `../lib/sold-store`, opens own client, per-record upsert loop, `finally` client.end(); `--smoke` ok. |
| `lib/sold-spend.js` | Pluggable DB-atomic + file-fallback spend tally, shared CeilingError | ✓ VERIFIED | 208 lines; `makeDbTally`/`makeFileTally`/`makeSpendTally`; `calls = calls + 1`, `WHERE ... calls < $2 RETURNING calls`, `ON CONFLICT (spend_key) DO NOTHING`; `CeilingError` code OXY_CEILING; `--smoke` 6/6. Imported by `lib/sold-transport.js` (WIRED). |
| `lib/sold-transport.js` | Wired to pluggable tally; CR-01 inline race removed | ✓ VERIFIED | `require('./sold-spend')`=1; `class CeilingError`=0 (now shared); `spend.liveCalls += 1`=0 (CR-01 gone); `_tally.reserveCall()` at l.114 before fetch; `setSpendClient`, `spentCallsAsync`, `remainingCallsAsync` exported. Load probe prints `load OK no-DB`. |
| `scripts/verf-sold-transport-load.js` | Committed no-DB load probe | ✓ VERIFIED | Prints `load OK no-DB`, asserts full export surface. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `migrate-sold-phase16.js` | `db.js` | `require('./db').createClient()` | ✓ WIRED | Present at l.13/16. |
| booli_sold/hemnet_sold columns | `lib/sold-parse.js` output | 1:1 snake_case map | ✓ WIRED | DDL columns match parser fields incl. `booli_id`, `hemnet_slug` (from `slug`), `sold_in_advance`. |
| `lib/sold-store.js` | sold tables | parameterized `INSERT ... ON CONFLICT DO UPDATE` | ✓ WIRED | 3 ON CONFLICT clauses on stable keys; no string interpolation. |
| `scripts/persist-sold.js` | `lib/sold-store.js` | require + per-record upsert loop | ✓ WIRED | `require('../lib/sold-store')`, calls `upsertBooliSold`/`upsertHemnetSold`. |
| `lib/sold-store.js` title-transfer gate | `lib/sold-config.js isTitleTransfer` | skip verdict when is_title_transfer | ✓ WIRED | `require('./sold-config')`; `persistVerdictForRecord` returns false + zero queries for transfers (smoke #6/#8). |
| `lib/sold-transport.js cachedFetch` | `lib/sold-spend.js reserveCall` | reserve-before-fetch replacing inline counter | ✓ WIRED | `await _tally.reserveCall()` at l.114 before `getWithRetry`; CR-01 block removed. |
| `lib/sold-spend.js DB path` | `sold_spend` table | atomic `UPDATE ... WHERE calls < $2 RETURNING` | ✓ WIRED | l.51-54; seeded by ON CONFLICT DO NOTHING l.41-42. |

### Data-Flow Trace (Level 4)

Not applicable as a rendering trace — this phase produces persistence/DDL plumbing, not a UI rendering dynamic data. The relevant data-flow (fetcher JSONL → `readJsonl` → `upsertBooliSold`/`upsertHemnetSold` → DB) is verified structurally above; the live flow producing real rows is the operator-gated human verification item.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Migration parses (offline) | `node -c migrate-sold-phase16.js` | syntax OK | ✓ PASS |
| 4 sold-side tables defined | `grep -c "CREATE TABLE IF NOT EXISTS"` | 4 | ✓ PASS |
| Store upsert logic (mock client) | `node lib/sold-store.js --smoke` | smoke: 12 pass, 0 fail | ✓ PASS |
| Persist pass loads + arg-parses | `node scripts/persist-sold.js --smoke` | smoke: ok | ✓ PASS |
| Spend tally DB+file logic (mock) | `node lib/sold-spend.js --smoke` | smoke: 6 pass, 0 fail | ✓ PASS |
| Transport loads with no DB | `SCRAPE_FORCE_OXYLABS=1 node scripts/verf-sold-transport-load.js` | load OK no-DB | ✓ PASS |
| CR-01 inline race removed | `grep -c "spend.liveCalls += 1" lib/sold-transport.js` | 0 | ✓ PASS |
| Caller regression: booli fetcher | `SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-booli.js --smoke` | smoke: 17 pass, 0 fail | ✓ PASS |
| Caller regression: hemnet fetcher | `SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-hemnet.js --smoke` | smoke: 23 pass, 0 fail | ✓ PASS |
| No SQL string interpolation | grep template-literal `${` inside query() across 4 files | none | ✓ PASS |
| Live DDL/write apply | `node migrate-sold-phase16.js` against prod | not run (operator-gated) | ? SKIP → human |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| DB-01 | 16-01 | Sold-side schema migrated: Booli-sold, Hemnet-`/salda`, match/verdict tables (enriched cols + `sold_in_advance`) | ✓ SATISFIED (code; live apply operator-gated) | `migrate-sold-phase16.js` 4-table DDL; REQUIREMENTS.md marks Complete with "live prod apply operator-gated" note. |
| DB-02 | 16-02, 16-03 | Pipeline persists seeds/cards/verdicts to DB, replacing JSON output | ✓ SATISFIED (code; live writes operator-gated) | `lib/sold-store.js` + `scripts/persist-sold.js` + DB spend tally; REQUIREMENTS.md Complete. |
| DB-03 | 16-02, 16-03 | Re-runs idempotent — upsert by stable keys, no duplicate rows | ✓ SATISFIED (code) | `ON CONFLICT DO UPDATE` on booli_id/hemnet_slug/booli_id + atomic spend `UPDATE ... WHERE calls<$2 RETURNING`; REQUIREMENTS.md Complete. |

No orphaned requirements: REQUIREMENTS.md maps only DB-01/02/03 to Phase 16, all three claimed by plans 16-01/16-02/16-03.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none blocking) | — | — | — | Schema/persist/spend code is substantive, parameterized, and smoke-covered. `sold_match` intentionally ships empty (design-only, populated Phase 17 — documented, not a stub). |

The 16-REVIEW.md raised 0 critical / 5 warning / 5 info findings (client-leak on migration error path WR-01, `seeded` flag coupling WR-02, `max<=0`/NaN ceiling guard WR-03, eager/unguarded JSONL parse WR-04/WR-05). These are robustness hardening items, not goal blockers — the upsert/ON CONFLICT/atomic-increment core that the phase goal depends on is correct. They do not change any observable truth's status; flag for Phase 17 hardening if drivers build on this plumbing.

### Human Verification Required

The migration and persist/spend DB writes are fully written, committed, and pass all offline smokes, but the one-time live execution against the shared production Postgres was denied by the auto-mode authorization gate (live DDL/writes require explicit operator authorization). Three operator actions confirm live behavior:

1. **Apply the migration** — `node migrate-sold-phase16.js` (droplet, already whitelisted; or after `doctl` local-IP whitelist). Expect the four `Created table:` lines and `Tables present: booli_sold, hemnet_sold, sold_match, sold_spend`; a second run is a no-op (idempotent).
2. **Live idempotency** — `node scripts/persist-sold.js --booli <seed.jsonl>` twice; `SELECT count(*) FROM booli_sold` unchanged on the second run (DB-03).
3. **Live atomic ceiling** — with `setSpendClient(client)`, two concurrent `reserveCall` loops never push `sold_spend.calls` past the configured max (CR-01 closed).

### Gaps Summary

No code gaps. All three observable truths and all six artifacts are verified at the code level: the schema DDL is correct and idempotent, the upsert layer uses ON CONFLICT on the correct stable keys, the persist pass replaces JSON output, and the spend tally's atomic increment is race-free. The sole outstanding item is the operator-gated live DB apply/write run, classified as human verification per the explicit phase context (authorization-gated live runs against shared prod Postgres), not a defect. Status is `human_needed` because non-empty human verification items take priority over `passed`.

---

_Verified: 2026-06-17T04:43:32Z_
_Verifier: Claude (gsd-verifier)_
