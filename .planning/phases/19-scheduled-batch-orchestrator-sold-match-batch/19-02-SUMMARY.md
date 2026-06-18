---
phase: 19-scheduled-batch-orchestrator-sold-match-batch
plan: 02
subsystem: sold-match scheduled orchestrator
tags: [orchestrator, cron, batch-ceiling, recheck-drain, fail-safe, D-16, SCHED-01, SCHED-02]
requires: [lib/sold-sample.js, scripts/sold-match-run.js, lib/sold-transport.js, lib/sold-recheck.js, lib/sold-config.js, cron-wrapper.js]
provides: [sold-match-batch.js, RECHECK_BRIDGE_FINAL_ONLY, boolEnv]
affects: [deploy-instructions.md (19-03 consumer)]
tech-stack:
  added: []
  patterns: [runJob-orchestrator, deps-injection-offline-smoke, even-week-gate, save-restore-env-toggle]
key-files:
  created: [sold-match-batch.js]
  modified: [lib/sold-config.js, lib/sold-recheck.js]
decisions: [D-02, D-05, D-06, D-07, D-08, D-09, D-14, D-16]
metrics:
  duration: ~30m
  completed: 2026-06-18
---

# Phase 19 Plan 02: Sold match batch orchestrator + D-16 lever Summary

A single in-process `node sold-match-batch.js` run drives the national sampler then matchOne per sampled record under ONE batch-wide Oxylabs ceiling, runs the Phase-18 re-check drain, no-ops on odd ISO weeks (fortnightly), and fails safe via validate() — plus the default-OFF `RECHECK_BRIDGE_FINAL_ONLY` cheaper-recheck lever. All proven offline.

## What was built

### Task 1 — D-16 cheaper-recheck lever (commit 64a6216)
- **`lib/sold-config.js`:** `boolEnv(name, dflt)` (ASVS V5 — only `1`/`true`/`0`/`false` honored, else default) + `RECHECK_BRIDGE_FINAL_ONLY = boolEnv('RECHECK_BRIDGE_FINAL_ONLY', false)`; both exported. Smoke: boolEnv truth table (`1`/`0`/`true`/`false`/`''`/typo/unset) + default-FALSE assertion → 27 pass.
- **`lib/sold-recheck.js` runRecheck:** imports the lever (overridable via `deps.bridgeFinalOnly`). Per due row computes `isFinalAttempt` = `!recheck_until || (now + RECHECK_INTERVAL_DAYS) >= recheck_until`. When the lever is ON and the attempt is INTERMEDIATE, saves `process.env.SOLD_MATCH_BRIDGE`, sets it to `'0'` for that matchOne call, restores it in a `finally` (bridgeEnabled() reads at call time; matchOne signature unchanged). Default OFF → full-fidelity drain untouched. Three new smokes: lever-OFF regression guard, lever-ON intermediate suppress/restore, lever-ON final-attempt-runs → 15 pass.

### Tasks 2 & 3 — orchestrator (commit 10daa0f)
- **`sold-match-batch.js`** (repo root) under `runJob({scriptName:'sold-match-batch', main, validate})`. First executable line `process.env.SCRAPE_FORCE_OXYLABS = '1'`; `SOLD_MATCH_BRIDGE='1'` (D-05).
- **`isoWeekNumber(date)`** Thursday-anchored (modeled on cohort-spotcheck-gate isoWeekId) → even/odd gate.
- **`main(client, log)`:** odd ISO week → `{skipped:true, reason:'off-week', isoWeek, slackMsg:null}` early no-op (D-14, no ceiling/sampler/drain). Even week → `deps.setSpendClient(client)` ONCE before the sampler (D-06); `sampleNational` once (D-13); matchOne per record via `record.seg` (tally matched/booli_only/uncertain/error); then enroll→recheck→settle drain on the real clock with a `segments` map rebuilt from the queue (D-08). CeilingError in the sampler / match loop / drain → `batchStoppedBy='ceiling'` and stop; non-ceiling sampler/recheck error → `fatalError`.
- **`validate(summary)` (D-07):** null on clean full run AND clean off-week skip; non-null Slack string on ceiling stop, fatal error, `fetchFailures > FETCH_FAIL_THRESHOLD` (5), or incomplete match pass (`recordsMatched < recordsTotal`).
- **deps indirection:** every pipeline piece routed through a module-level `deps` so `--smoke` stubs the whole orchestrator (mock pg client + injected even/odd clock) — 9 pass, 0 fail, zero Oxylabs, zero DB.
- **Single raw SQL:** only the read-only `SELECT booli_id FROM sold_match WHERE verdict = 'booli_only' AND first_unmatched_at IS NULL` (D-03 invariant); all writes via matchOne / recheck helpers.

## Verification (offline-only)

- `node -c sold-match-batch.js` → PARSE_OK; `node sold-match-batch.js --smoke` → **9 pass, 0 fail**.
- `node lib/sold-config.js --smoke` → **27 pass**; `node lib/sold-recheck.js --smoke` → **15 pass**.
- No regressions: `node lib/sold-store.js --smoke` 25 pass, `node scripts/sold-match-run.js --smoke` 18 pass.
- grep gates: SCRAPE first line ✓, `execFileSync`=0, `db/createClient`=0, `sampleNational`=14, smoke gate present, enrollment SQL=1, `runRecheck|enrollUnmatched|settleExpired`=24, `batchStoppedBy`=17, `setSpendClient`=20. Config: `RECHECK_BRIDGE_FINAL_ONLY`=5, `boolEnv`=13. Recheck: `RECHECK_BRIDGE_FINAL_ONLY|bridgeFinalOnly`=8, `SOLD_MATCH_BRIDGE`=25.

## Deviations from Plan

**1. [Plan-structure] Tasks 2 (RED scaffold) and 3 (GREEN main/validate) collapsed into one atomic green commit.**
- **Issue:** The plan structured Task 2 as a RED scaffold commit (smoke harness + stubbed main/validate, asserts allowed to fail) and Task 3 as the GREEN fill-in. The file was written complete and green in one pass.
- **Decision:** Committed the complete green file once (`feat(19-02): ...`, 10daa0f) with a message enumerating the even-week gate, sampler-driven matchOne, batch ceiling, re-check drain, fail-safe validate, and offline smoke. No functional deviation — only commit granularity; the file is always green.

**2. [Plan-structure] Comment reworded to satisfy the `execFileSync`=0 grep gate.**
- **Issue:** The header comment originally read "(NOT execFileSync)", making `grep -c "execFileSync"` return 1; acceptance requires 0.
- **Fix:** Reworded to "(NOT child-process spawning)" — same meaning, no literal token. In-process invariant intact.

**3. [Enhancement] Added a third D-16 smoke (final-attempt-runs) beyond the plan's two.**
- The plan asked for two lever smokes (OFF regression + ON intermediate). Added a third asserting the FINAL attempt runs the bridge even with the lever ON, fully pinning the intermediate-vs-final boundary. Strictly additive.

## Self-Check: PASSED
- FOUND: sold-match-batch.js
- FOUND: lib/sold-config.js (modified), lib/sold-recheck.js (modified)
- FOUND commit: 64a6216 (D-16 lever), 10daa0f (orchestrator)
