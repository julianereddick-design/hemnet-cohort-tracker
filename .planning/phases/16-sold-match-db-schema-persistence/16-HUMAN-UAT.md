---
status: partial
phase: 16-sold-match-db-schema-persistence
source: [16-VERIFICATION.md]
started: 2026-06-17T04:45:21Z
updated: 2026-06-17T04:45:21Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Apply the migration against the project Postgres
command: `node migrate-sold-phase16.js` (on the already-whitelisted droplet, or after `doctl` IP-whitelist of the local IP)
expected: Prints `Created table: booli_sold` / `hemnet_sold` / `sold_match` / `sold_spend` and `Tables present: booli_sold, hemnet_sold, sold_match, sold_spend`. A second run prints the same line with no error (idempotent IF NOT EXISTS).
why_human: Writing DDL to the shared production Postgres requires explicit operator authorization (auto-mode classifier denied live DDL). Cannot be exercised offline.
result: [pending]

### 2. Live idempotency check
command: after the migration, run `node scripts/persist-sold.js --booli <seed.jsonl>` twice
expected: First run prints `persisted: booli=N ...`; `SELECT count(*) FROM booli_sold` is unchanged after the second run (ON CONFLICT (booli_id) DO UPDATE — zero duplicate rows, DB-03).
why_human: Requires the live tables to exist and a reachable prod DB; gated on the same operator authorization as the migration run.
result: [pending]

### 3. Live atomic spend ceiling
command: with `setSpendClient(client)` set, run two near-simultaneous reserveCall loops
expected: `SELECT calls FROM sold_spend WHERE spend_key='sold-global'` never exceeds the configured ceiling (atomic UPDATE ... WHERE calls < $2 RETURNING — closes CR-01).
why_human: Concurrency behavior against the live sold_spend row needs a reachable DB; offline smoke proves the single-statement logic but not real concurrent execution.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
