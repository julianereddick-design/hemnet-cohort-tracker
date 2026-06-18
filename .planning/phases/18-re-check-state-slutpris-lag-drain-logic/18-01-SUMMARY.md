---
phase: 18-re-check-state-slutpris-lag-drain-logic
plan: 01
subsystem: sold-match
tags: [migration, schema, re-check, sold_match]
requires:
  - "sold_match table (UNIQUE(booli_id)) from migrate-sold-phase16.js"
  - "db.js createClient export"
provides:
  - "sold_match.first_unmatched_at / recheck_until / next_recheck_at scheduling columns"
  - "migrate-sold-recheck-phase18.js (idempotent, operator-runnable)"
affects:
  - "Plan 03 store-layer scheduling helpers (read/write the new columns)"
  - "Plan 04 drain loop (finds rows due for re-check)"
tech-stack:
  added: []
  patterns:
    - "ALTER TABLE ... ADD COLUMN IF NOT EXISTS (idempotent additive DDL)"
    - "parameterized information_schema read-back verify (ANY($1::text[]))"
    - "client.end() in finally (WR-01)"
key-files:
  created:
    - migrate-sold-recheck-phase18.js
  modified: []
decisions:
  - "Three new columns are all TIMESTAMPTZ and nullable — matched/uncertain rows leave them null; only booli_only candidates schedule"
  - "Mirrored migrate-sold-phase16.js structure verbatim rather than introducing a new migration pattern"
metrics:
  duration: ~3m
  completed: 2026-06-18
requirements: [RECHECK-01]
---

# Phase 18 Plan 01: sold_match re-check scheduling columns migration Summary

Added an idempotent standalone migration (`migrate-sold-recheck-phase18.js`) that extends the existing `sold_match` table with three nullable TIMESTAMPTZ re-check scheduling columns (`first_unmatched_at`, `recheck_until`, `next_recheck_at`) via `ADD COLUMN IF NOT EXISTS`, plus a parameterized read-back verify — the schema half of RECHECK-01 that later plans' drain loop and store helpers depend on.

## What Was Built

- **`migrate-sold-recheck-phase18.js`** (repo root): a standalone, re-runnable migration that mirrors `migrate-sold-phase16.js` style exactly:
  - `createClient()` → `connect()` → `try { ... } finally { await client.end(); }`
  - One `ALTER TABLE sold_match` statement adding all three columns, each guarded by `ADD COLUMN IF NOT EXISTS` so a re-run is a no-op.
  - Parameterized read-back verify against `information_schema.columns` using `ANY($1::text[])` — no string interpolation.
  - `run().catch(... process.exit(1))` tail.

## Column Semantics

| Column | Type | Meaning |
|--------|------|---------|
| `first_unmatched_at` | TIMESTAMPTZ (nullable) | When the row first became a `booli_only` candidate for re-check |
| `recheck_until` | TIMESTAMPTZ (nullable) | `first_unmatched_at + RECHECK_WINDOW_DAYS` — the settle deadline |
| `next_recheck_at` | TIMESTAMPTZ (nullable) | When the row is next eligible for a re-check search (advances by `RECHECK_INTERVAL_DAYS` each pass) |

All nullable: matched/uncertain rows leave them null.

## Verification

- `node -c migrate-sold-recheck-phase18.js` → exit 0 (SYNTAX_OK).
- All grep acceptance gates PASS: the three `ADD COLUMN IF NOT EXISTS` lines, `ALTER TABLE sold_match`, `information_schema.columns`, `ANY($1::text[])`, `await client.end()`.
- No `${` interpolation anywhere in the SQL (confirmed).
- `migrate-sold-phase16.js` unmodified (not in this plan's edit set).
- Live DDL execution against prod is an operator-gated step (same gate as phase16) and is NOT a plan acceptance criterion.

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface

No new threat surface beyond the plan's `<threat_model>`. T-18-01 (SQL injection) mitigated via parameterized read-back + static-literal ALTER (no interpolation). T-18-02 (destructive DDL) accepted — additive `ADD COLUMN IF NOT EXISTS` only, non-destructive, idempotent.

## Self-Check: PASSED

- FOUND: migrate-sold-recheck-phase18.js
- FOUND commit: 0bd6463 (feat(18-01): add sold_match re-check scheduling columns migration)
