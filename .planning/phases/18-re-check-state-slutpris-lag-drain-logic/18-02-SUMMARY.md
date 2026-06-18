---
phase: 18-re-check-state-slutpris-lag-drain-logic
plan: 02
subsystem: sold-match-config
tags: [config, recheck, env-validation, RECHECK-04]
requires:
  - "lib/sold-config.js existing constant/export/smoke structure (Phase 15-17)"
provides:
  - "RECHECK_WINDOW_DAYS (default 28) exported config constant, env-overridable + validated"
  - "RECHECK_INTERVAL_DAYS (default 7) exported config constant, env-overridable + validated"
  - "posIntEnv(name, dflt) exported validation helper (positive-integer env reader)"
affects:
  - "Plan 03 (store-layer due query) and Plan 04 (drain loop) read these constants"
tech-stack:
  added: []
  patterns:
    - "ASVS V5 env-input validation (posIntEnv mirrors validateDate idiom): reject NaN / <=0 / non-integer → documented default"
    - "Config-as-data: re-check window + cadence settable via env with no source edit (RECHECK-04)"
key-files:
  created: []
  modified:
    - "lib/sold-config.js — posIntEnv helper + RECHECK_WINDOW_DAYS/RECHECK_INTERVAL_DAYS constants + exports + 7 smoke assertions"
decisions:
  - "posIntEnv rejects NaN / <= 0 / non-integer and falls back to the default so an env typo can never zero (settle-everything) or unbounded-widen the re-check window (T-18-03 mitigated)"
  - "Both constants resolved at module-load via posIntEnv — require('./lib/sold-config') with RECHECK_WINDOW_DAYS=21 in env yields 21, no code edit (RECHECK-04 proof)"
  - "SEGMENTS/isTitleTransfer/daysAgoISO/READ_TIME_EXCLUDE_DAYS and all prior exports left intact (Pitfall 7 backward-compat for Phase 15/16/17 importers)"
metrics:
  duration: "~6 min"
  completed: "2026-06-18"
  tasks: 1
  files: 1
---

# Phase 18 Plan 02: Re-check window config constants Summary

RECHECK_WINDOW_DAYS (default 28, ~4 weeks) and RECHECK_INTERVAL_DAYS (default 7) added to `lib/sold-config.js` as env-overridable, validated constants via a new `posIntEnv` helper that rejects bad input back to the default — the configuration foundation Plans 03/04 read for the slutpris-lag drain loop.

## What Was Built

- **`posIntEnv(name, dflt)`** — a private-then-exported validation helper that reads a positive-integer env override and falls back to the supplied default for unset/empty/NaN/non-integer/`<= 0` input. Mirrors the `validateDate` ASVS-V5 idiom in `scripts/sold-match-run.js` (never trust raw env).
- **`RECHECK_WINDOW_DAYS = posIntEnv('RECHECK_WINDOW_DAYS', 28)`** — the re-check drain window (~4 weeks): an unmatched `booli_only` row is re-attempted until `first_unmatched_at + RECHECK_WINDOW_DAYS`, then settled terminal.
- **`RECHECK_INTERVAL_DAYS = posIntEnv('RECHECK_INTERVAL_DAYS', 7)`** — minimum re-search cadence (weekly).
- All three added to `module.exports`; comment-then-const style mirrors `READ_TIME_EXCLUDE_DAYS`.
- 7 new inline `--smoke` assertions added to the existing `check(name, fn)` block (defaults, valid override honored, zero/negative/non-numeric rejected, positive-integer invariant).

## How It Works

Both constants are resolved once at module load by calling `posIntEnv`, so an operator setting `RECHECK_WINDOW_DAYS=21` in the environment changes the drain behavior with no source edit (RECHECK-04). An invalid override (`0`, `-5`, `abc`) is silently coerced back to the documented default, so a typo can neither zero the window (which would settle everything immediately) nor corrupt it (T-18-03 tampering mitigated).

## Verification

| Check | Result |
|-------|--------|
| `node lib/sold-config.js --smoke` | `smoke: 25 pass, 0 fail` (exit 0; was 18 pass before this plan) |
| `node -c lib/sold-config.js` | syntax OK |
| defaults exported (28 / 7) | exit 0 |
| `RECHECK_WINDOW_DAYS=21 node -e ...` → 21 | exit 0 (env override, no code edit) |
| `RECHECK_WINDOW_DAYS=0 node -e ...` → 28 | exit 0 (invalid → default) |
| backward-compat exports (SEGMENTS / isTitleTransfer / daysAgoISO / READ_TIME_EXCLUDE_DAYS) | all present |

All checks offline — no DB, no network.

## TDD Gate Compliance

- RED: `test(18-02)` commit `6f905e1` — 7 new smoke assertions failing (posIntEnv / RECHECK_* not defined → 18 pass, 7 fail).
- GREEN: `feat(18-02)` commit `ba1ce6f` — helper + constants + exports added (25 pass, 0 fail).
- REFACTOR: none needed (minimal implementation, no cleanup warranted).

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: lib/sold-config.js (RECHECK_WINDOW_DAYS, RECHECK_INTERVAL_DAYS, function posIntEnv all present)
- FOUND: commit 6f905e1 (test RED)
- FOUND: commit ba1ce6f (feat GREEN)
