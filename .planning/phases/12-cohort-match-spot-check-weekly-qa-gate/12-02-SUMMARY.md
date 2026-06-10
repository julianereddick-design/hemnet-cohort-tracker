---
phase: 12-cohort-match-spot-check-weekly-qa-gate
plan: "02"
subsystem: spotcheck-gate
tags: [orchestrator, cron-wrapper, execFileSync, mode-a-adjudication, slack-escalation]
dependency_graph:
  requires:
    - cohort-spotcheck.js
    - spotcheck-photos.js
    - lib/spotcheck-adjudicate.js
    - lib/spotcheck-summary.js
    - cron-wrapper.js
  provides:
    - cohort-spotcheck-gate.js
    - deploy-instructions.md (crontab + runbook entry)
  affects:
    - lib/spotcheck-vision.js (plan 12-03 Mode B plug-in point)
tech_stack:
  added: []
  patterns:
    - runJob-orchestrator
    - execFileSync-child-process-reuse
    - validate-warning-slack-escalation
    - argv-array-injection-safe
key_files:
  created:
    - cohort-spotcheck-gate.js
  modified:
    - deploy-instructions.md
decisions:
  - "Child-process reuse via execFileSync argv arrays (not shell strings) satisfies T-12-04; cohortId originates from own cohorts table"
  - "Slack escalation flows solely through cron-wrapper validate() non-null return — no custom sendSlack in the gate (T-12-05)"
  - "Default --rate 0.20 (20%) rather than plan note 8%; plan objective text specifies 0.20 as default; comment explains statistical sizing rationale"
  - "--mode-b stubbed as parsed-but-unused boolean; Plan 12-03 wires the Anthropic API vision path"
  - "fetchFailures read from artifact.meta.hemnet.error with fallback to per-pair hemnet.status=error count"
metrics:
  duration: 15m
  completed: "2026-06-10"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
---

# Phase 12 Plan 02: Cohort Spot-Check Gate Summary

Weekly orchestration entrypoint `cohort-spotcheck-gate.js` under `cron-wrapper.runJob` — drives existing field-evidence + photo tools as child processes, adjudicates Mode A (deterministic, no Anthropic API), writes VERDICTS + SUMMARY artifacts, and escalates via Slack when confirmed false-match rate > 5% or fetch failures occur.

## What Was Built

### cohort-spotcheck-gate.js

Cron-wrapper `runJob` orchestrator that implements the full spot-check pipeline in `main(client, log)`:

1. **Cohort resolution** — `--cohort <id>` flag or `SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1` (same query as `cohort-spotcheck.js:142`).
2. **Field evidence** — `execFileSync(process.execPath, ['cohort-spotcheck.js', '--cohort', cohortId, '--rate', rate, '--conc', conc])` writes `verf-spotcheck-<cohort>-<ts>/`.
3. **Artifact dir location** — scans cwd for `verf-spotcheck-${cohortId}-*` dirs, takes lexically-greatest (newest timestamp). Throws if none found — surfaces as `status=failure` + Slack via cron-wrapper.
4. **Photo galleries** — `execFileSync(process.execPath, ['spotcheck-photos.js', artifactDir, '--gallery', '--all', '--max', max])` enriches pairs with `photos.hemnet_gallery` / `photos.booli_gallery` arrays.
5. **Artifact read** — reads `spotcheck-<cohort>.json`, parses `artifact.pairs`.
6. **Fetch failure count** — reads `artifact.meta.hemnet.error` (authoritative) with fallback to counting `hemnet.status === 'error'` per pair.
7. **Adjudication** — `adjudicatePairs(artifact.pairs, {})` (Mode A; `{}` = no vision results).
8. **Summary** — `computeSummary(verdicts)` → rate + Wilson CI + by-county + mismatch list.
9. **Artifact write** — `VERDICTS-<cohortId>.json` (full verdicts + summary) and `SUMMARY-<cohortId>.md` (rendered markdown) into the existing artifact dir.
10. **Return** — result_summary with `cohortId, sampled, confirmedMatch, confirmedMismatch, uncertain, confirmedMismatchRate, wilsonLo, wilsonHi, fetchFailures, artifactDir, adjudicationMode, threshold, slackMsg, skipped`.

CLI flags: `--cohort`, `--rate` (default **0.20**), `--threshold` (default 0.05), `--conc` (default 5), `--max` (default 6), `--mode-b` (stub).

`validate()` escalates (non-null return → cron-wrapper Slack path) when:
- `fetchFailures > 0` → `"N fetch failure(s) during spot-check gate (cohort <id>)"`
- `confirmedMismatchRate > summary.threshold` → `renderSlackAlert(summary, cohortId)` string

### deploy-instructions.md updates

- **Crontab line** added in the weekly slot block, Mon 06:30 UTC (30 min after cohort-create at 06:00), logging to `/var/log/hemnet/spotcheck-gate.log`.
- **Runbook entry** covering: what the job does (sample → field → photo → adjudicate → summary), detect (Slack `[WARNING] cohort-spotcheck-gate: ...` + `cron_job_log`), diagnose (fetch failures via `artifact.meta.hemnet.error`, high rate via `VERDICTS-*.json` mismatch list), re-run commands (`--cohort`, `--rate`, `--threshold`), artifact locations (`verf-spotcheck-<cohort>-<ts>/VERDICTS-*.json` + `SUMMARY-*.md`), and Mode A / Mode B note.

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | cohort-spotcheck-gate.js | fd1ff07 | cohort-spotcheck-gate.js (created) |
| 2 | deploy-instructions.md crontab + runbook | 5d09a8e | deploy-instructions.md (modified) |

## Deviations from Plan

None — plan executed exactly as written. Both artifacts implement the specified contracts:
- `cohort-spotcheck-gate.js`: `node --check` passes; all 10 grep acceptance criteria pass; no hardcoded webhook; Slack flows only through cron-wrapper.
- `deploy-instructions.md`: crontab line + 5-section runbook entry; all 5 acceptance criteria pass.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. Threat register dispositions applied:

- **T-12-04 (Tampering/Injection)**: `execFileSync` called with argv arrays (not shell strings). `cohortId` originates from `cohorts` table, not user input. No shell-expansion risk.
- **T-12-05 (Info disclosure)**: No `SLACK_WEBHOOK_URL` read or assignment in the gate. Grep confirms no `hooks.slack` string literal. Escalation flows solely through `cron-wrapper`.
- **T-12-07 (Repudiation)**: Every run writes a `cron_job_log` row via `runJob` (started/finished/status/result_summary).
- **T-12-08 (DoS)**: `--rate` (default 0.20) + `--max` gallery cap bound Oxylabs spend; `--conc` default 5 matches existing tool defaults.

No new threat surface found beyond what the threat register already covers.

## Known Stubs

- `--mode-b` flag: parsed as `args.modeB` boolean but has no effect in this plan. Plan 12-03 wires the Anthropic API vision path. Until 12-03 ships, all pairs are adjudicated via Mode A (deterministic). This is intentional per the plan objective: "Mode A only (deterministic + human-fallback adjudication, NO Anthropic API)."

## Self-Check: PASSED

- `cohort-spotcheck-gate.js` exists: FOUND
- `deploy-instructions.md` updated: FOUND (33 lines added)
- Commit fd1ff07 exists: FOUND
- Commit 5d09a8e exists: FOUND
- `node --check cohort-spotcheck-gate.js`: PASSED
- All 10 acceptance criteria for Task 1: PASSED
- All 5 acceptance criteria for Task 2: PASSED
