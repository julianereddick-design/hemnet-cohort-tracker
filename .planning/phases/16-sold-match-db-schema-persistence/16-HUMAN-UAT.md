---
status: passed
phase: 16-sold-match-db-schema-persistence
source: [16-VERIFICATION.md]
started: 2026-06-17T04:45:21Z
updated: 2026-06-17T05:15:00Z
executed_by: Claude (on droplet via SSH, operator-authorized 2026-06-17)
---

## Current Test

[all 3 items executed live on the droplet — passed]

## Tests

### 1. Apply the migration against the project Postgres
command: `node migrate-sold-phase16.js` (on the already-whitelisted droplet, or after `doctl` IP-whitelist of the local IP)
expected: Prints `Created table: booli_sold` / `hemnet_sold` / `sold_match` / `sold_spend` and `Tables present: booli_sold, hemnet_sold, sold_match, sold_spend`. A second run prints the same line with no error (idempotent IF NOT EXISTS).
why_human: Writing DDL to the shared production Postgres requires explicit operator authorization (auto-mode classifier denied live DDL). Cannot be exercised offline.
result: PASS — ran twice on droplet 2026-06-17. Both runs exit 0, identical read-back `Tables present: booli_sold, hemnet_sold, sold_match, sold_spend`. Idempotent. All 4 tables now exist in prod.

### 2. Live idempotency check
command: after the migration, run `node scripts/persist-sold.js --booli <seed.jsonl>` twice
expected: First run prints `persisted: booli=N ...`; `SELECT count(*) FROM booli_sold` is unchanged after the second run (ON CONFLICT (booli_id) DO UPDATE — zero duplicate rows, DB-03).
why_human: Requires the live tables to exist and a reachable prod DB; gated on the same operator authorization as the migration run.
result: PASS — seeded `verf-soldspike/seed/taby-villa.jsonl` (1970 records) twice on droplet. Before=0 rows. After run 1: 1970 rows / 1970 distinct booli_id, skipped=0. After run 2: STILL 1970 rows / 1970 distinct, skipped=0. Zero duplicate rows — `ON CONFLICT (booli_id) DO UPDATE` confirmed live (DB-03). NOTE: the 1970 test rows remain in prod `booli_sold` pending data-cleanup decision (see Gaps).

### 3. Live atomic spend ceiling
command: with `setSpendClient(client)` set, run two near-simultaneous reserveCall loops
expected: `SELECT calls FROM sold_spend WHERE spend_key='sold-global'` never exceeds the configured ceiling (atomic UPDATE ... WHERE calls < $2 RETURNING — closes CR-01).
why_human: Concurrency behavior against the live sold_spend row needs a reachable DB; offline smoke proves the single-statement logic but not real concurrent execution.
result: PASS — concurrency probe on droplet: 4 workers on separate DB connections, max=100, dedicated throwaway key `sold-uat-ceiling`. Each worker reserved exactly 25; total_success=100, final calls=100 — never exceeded the ceiling, no double-count. CR-01 race provably closed live. Test key deleted after; real `sold-global` counter untouched.

## Summary

total: 3
passed: 3
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- **Data cleanup (RESOLVED 2026-06-17):** Operator chose truncate. Ran `TRUNCATE booli_sold RESTART IDENTITY` on the droplet — `booli_sold` 1970 → 0; all 4 schema tables remain present. Prod is back to the pre-test empty-schema state; Phase 17 will do the real segment+window seeding. The 1970 villa records are re-loadable any time from `verf-soldspike/seed/taby-villa.jsonl`.
