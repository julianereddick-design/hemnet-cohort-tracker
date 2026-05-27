---
phase: 11-daily-market-totals-capture-and-minimal-report
plan: "03"
subsystem: reporting-consumer
tags:
  - market-totals
  - weekly-slack
  - reporting-consumer
  - phase-11

dependency_graph:
  requires:
    - 11-01 (market_totals table schema + daily writer must exist)
  provides:
    - market-totals-weekly-report.js — weekly Slack consumer surfacing Till salu WoW
    - deploy-instructions.md Monday 09:35 UTC crontab entry
  affects:
    - Slack channel (SLACK_WEBHOOK_URL) — new Monday 09:35 UTC message

tech_stack:
  added: []
  patterns:
    - reporting-consumer (fire-and-forget, NOT cron-wrapped)
    - inline sendSlack helper verbatim from weekly-view-report.js
    - db.createClient + connect + query + end (direct DB read)
    - missing-data "?" rendering with WARN log

key_files:
  created:
    - market-totals-weekly-report.js
  modified:
    - deploy-instructions.md

decisions:
  - "Code location: new file market-totals-weekly-report.js (not embedded in weekly-view-report.js) — per D-04 operator preference; embedding inherently adds a market-totals DB query path to the cohort report, which is the thing the operator said to reject"
  - "Cron slot: Monday 09:35 UTC (not 09:30) — 5-minute sequential gap after weekly-view-report.js at 09:30; clean separation in Slack channel and log files; weekly-view-report is DB-only and finishes well under 5 minutes"
  - "U+2212 MINUS used in 'Booli − Hemnet' label and in negative delta values per D-04 locked format"
  - "Kommande segment captured in market_totals but NOT surfaced by this consumer — till_salu only per D-04"

metrics:
  duration: "~10 minutes"
  completed: "2026-05-27"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 2
---

# Phase 11 Plan 03: Weekly Market-Supply Slack Pulse Summary

Weekly reporting consumer that queries market_totals for (today, today-7) × {hemnet, booli} × till_salu, renders the operator-locked WoW Slack format with U+2212 minus signs and missing-data "?" semantics, and ships on a Monday 09:35 UTC crontab.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write market-totals-weekly-report.js | 2c79d29 | market-totals-weekly-report.js (155 lines) |
| 2 | Register Mon 09:35 UTC crontab entry | 76b246b | deploy-instructions.md |

## What Was Built

### Task 1: market-totals-weekly-report.js

New top-level script (155 lines) following the `weekly-view-report.js` reporting-consumer pattern exactly:

- `require('dotenv').config()` at top (NOT cron-wrapped, so must load env itself)
- `sendSlack` helper pasted verbatim from `weekly-view-report.js:9-30` per PATTERNS.md Pattern A
- `db.createClient()` + connect + query + end pattern for direct DB read
- Query filters on `segment = 'till_salu'` only and `day IN (CURRENT_DATE, CURRENT_DATE - INTERVAL '7 days')`
- Shapes rows into `{ hemnet: { prior, curr }, booli: { prior, curr } }` buckets
- Computes Booli − Hemnet gap for both weeks
- `renderDeltaPair(curr, prior)` returns `{ abs: '?', pct: '?' }` when either value is null — logs WARN, does NOT crash
- Slack message body wrapped in triple-backtick fences for monospace column alignment
- `run().catch(err => process.exit(1))` fire-and-forget termination

Locked output format (D-04) reproduced with U+2212 MINUS in "Booli − Hemnet" label and in negative delta values.

### Task 2: deploy-instructions.md crontab entry

Added inside the existing Phase 11 (v2.2) cron block, immediately after the `30 8 * * *` market-totals-daily.js line:

```cron
35 9 * * 1  cd /opt/hemnet-cohort-tracker && node market-totals-weekly-report.js >> /var/log/hemnet/market-totals-weekly.log 2>&1
```

Log directory `/var/log/hemnet` was created by Plan 11-01 Task 4 — no mkdir needed.

## Key Decisions

### Code location: new file vs embed

**Decision: new file `market-totals-weekly-report.js`.**

Operator preference in D-04: "Recommend a new `market-totals-weekly-report.js`; clean separation; one concern per script. Reject embedding if it adds a market-totals DB query path to the cohort report." Embedding in `weekly-view-report.js` inherently adds the very query path the operator said to reject. New file was the only option consistent with D-04.

### Cron slot: 09:35 not 09:30

`weekly-view-report.js` already fires at Monday 09:30 UTC. D-05 says "chain after it." The simplest read is 5 minutes later — 09:35 UTC gives clean sequential separation in the Slack channel and log files. `weekly-view-report.js` is DB-only (no scrape) and completes in well under 5 minutes, so 09:35 provides a safe sequential slot. PATTERNS.md flagged 09:30 as a race risk ("both lines firing at 09:30 will race"); 09:35 is the conservative pick per the plan notes.

### First valid run

The first run that can produce numeric (non-?) deltas is **deploy date + 7 days**. Earlier runs (including the first 6 days after Phase 11 deploy) will render `?` in all delta cells. This is expected behavior per D-04, not a defect.

## Deviations from Plan

None — plan executed exactly as written. The code in the plan action block was used as the basis without structural changes. Minor: `renderDeltaPair` uses U+2212 for negative values in both `abs` and `pct` output (consistent with D-04's U+2212 requirement for the label), which improves negative-delta rendering beyond the ASCII hyphen the plan template used in `pctStr`.

## Follow-up: SC-5 (7 consecutive days run green)

ROADMAP SC-5 ("7 consecutive days run green") is an **operational observation**, not a code deliverable. It is verifiable only after 7 days of production operation following Phase 11 deploy. This criterion belongs in the Phase 11 retrospective, not in this plan's completion criteria. No code action required here.

## Known Stubs

None — the script queries the live `market_totals` table directly. The "?" rendering on first-week runs is intentional behavior per D-04 (missing-data semantics), not a stub.

## Threat Flags

No new security-relevant surface introduced. The script is a read-only DB consumer that sends to an existing Slack webhook (SLACK_WEBHOOK_URL, already in use by cron-wrapper). No new network endpoints, auth paths, or schema changes.

## Self-Check: PASSED

- market-totals-weekly-report.js exists at repo root: FOUND
- Commit 2c79d29 exists: FOUND
- Commit 76b246b exists: FOUND
- deploy-instructions.md has `35 9 * * 1` cron line: FOUND
- No STATE.md or ROADMAP.md modifications made
