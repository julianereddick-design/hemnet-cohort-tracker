---
phase: 19-scheduled-batch-orchestrator-sold-match-batch
plan: 03
subsystem: deploy docs
tags: [crontab, env-vars, runbook, SCHED-03]
requires: [sold-match-batch.js, config/sold-panel.json, lib/sold-config.js]
provides: [deploy-instructions.md sold-match-batch crontab line + env vars + runbook entry]
affects: []
tech-stack:
  added: []
  patterns: [weekly-cron-fortnightly-gate, operator-runbook-detect-diagnose-rerun]
key-files:
  created: []
  modified: [deploy-instructions.md]
decisions: [D-11, D-13, D-14, D-16, D-17]
metrics:
  duration: ~12m
  completed: 2026-06-18
---

# Phase 19 Plan 03: Deploy docs (deploy-instructions.md) Summary

Documents SCHED-03: the installable Mon 07:30 UTC `node sold-match-batch.js` crontab line (weekly cron / fortnightly even-week effect), the Phase 19 env-var subsection (MAX_OXY_CALLS ~8000 ceiling, SOLD_MATCH_BRIDGE default-on, RECHECK_BRIDGE_FINAL_ONLY default-off cost lever, SLACK_WEBHOOK_URL), and a detect/diagnose/re-run operator runbook entry — all in deploy-instructions.md. No code.

## What was built

### Task 1 — crontab line + env vars (commit 9823c9d)
- **Crontab stanza** added directly after the Phase 12 cohort-spotcheck-gate stanza (Monday jobs stay grouped): `30 7 * * 1  cd /opt/hemnet-cohort-tracker && node sold-match-batch.js >> /var/log/hemnet/sold-match-batch.log 2>&1`, with a header comment explaining the weekly-cron / fortnightly-even-week-gate effect, the fail-safe, and that the 07:30 slot clears all live Monday crons.
- **Env-var subsection** ("Phase 19 (v3.1) — Sold match batch vars"): DATABASE_URL + Oxylabs creds (already required), `MAX_OXY_CALLS=8000` (cost model ~3–6k/run; transport default 4000 is too low → set explicitly), `SOLD_MATCH_BRIDGE` (default-on, opt-out `=0`), `RECHECK_BRIDGE_FINAL_ONLY` (default-OFF cost lever, D-16), `SOLD_BATCH_FETCH_FAIL_THRESHOLD` (default 5), `SLACK_WEBHOOK_URL` (same webhook as Phase 12, not the bot token).

### Task 2 — operator runbook entry (commit 528144d)
- Entry under `## Runbook` modeled on the cohort-spotcheck-gate entry:
  - **Header:** `sold-match-batch.js (Phase 19 Sold match batch) status=warning` + escalation triggers (ceiling / fatal / excess fetchFailures / incomplete pass); Slutpris-only (D-01); off-week skip = NORMAL (not an escalation).
  - **Detect:** Slack `[WARNING|FAILURE]`, `cron_job_log` via `verify-cron-job-log.js` (filter `script_name='sold-match-batch'`), log file.
  - **Diagnose:** read `result_summary` — `skipped/off-week`, `batchStoppedBy`, sample stats, `recordsMatched`/`recordsTotal`, `fetchFailures`, `oxylabsSpent` vs `MAX_OXY_CALLS`, re-check block; ceiling → raise MAX_OXY_CALLS or set RECHECK_BRIDGE_FINAL_ONLY=1.
  - **Re-run:** idempotent `node sold-match-batch.js` (ON CONFLICT upserts + booli_sold de-dup; re-enrolls only un-enrolled booli_only); even-week gate is the only cadence control.
  - **Panel + cost levers (D-13/D-16/D-17):** config/sold-panel.json coverage lever + `._backfill_pending` morning task; MAX_OXY_CALLS + RECHECK_BRIDGE_FINAL_ONLY cost levers.
  - **Go-live note:** DDL migration / first wet run / crontab install are operator-gated, not phase acceptance.

## Verification (offline-only — docs plan, no code)

- grep gates (Task 1): exact cron line=1, log file=1, `MAX_OXY_CALLS`=2, `RECHECK_BRIDGE_FINAL_ONLY`=1, `SOLD_MATCH_BRIDGE`=1, fortnight/even-week/odd-week=3, no duplicate `^30 7 * * 1` slot (=1).
- grep gates (Task 2): `sold-match-batch`=6, `batchStoppedBy`=2, `verify-cron-job-log.js` resolves (=5), `sold-panel.json`=2, `backfill`=1, off-week/skipped=3, `node sold-match-batch.js`=2, Phase 19 runbook header=1.
- The chosen slot does not collide with any live Monday UTC cron (cohort-create 06:00, spotcheck-gate 06:30, Job B 03:00, market-totals 08:30).

## Deviations from Plan

None — both tasks executed exactly as written and committed separately (9823c9d, 528144d).

## Self-Check: PASSED
- FOUND: deploy-instructions.md (modified)
- FOUND commit: 9823c9d (crontab + env vars), 528144d (runbook entry)
