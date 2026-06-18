---
phase: 20-per-run-reporting-decision-grade-trend
plan: 01
subsystem: reporting
tags: [slack, sold-match, reporting, decision-grade]
requires: [sold_match table, lib/spotcheck-slack-bot.js, config/sold-panel.json, db.js]
provides: [sold-match-report.js per-run Slack summary]
affects: []
tech-stack:
  added: []
  patterns: [monospace Slack block via postInfoMessage, pure-helper + --smoke offline gate]
key-files:
  created: [sold-match-report.js]
  modified: []
decisions:
  - "Settled genuine-non-Hemnet rate computed over TERMINAL verdicts only (matched + genuine_non_hemnet); booli_only AND uncertain excluded from both numerator and denominator."
  - "Raw booli_only rate reported on a separate, distinctly-labelled line (lag-contaminated) — never merged with settled."
  - "Segment parsed defensively from the real orchestrator format \"<muni>:<FAMILY>\"; unparseable segments bucket under region 'Unknown' + WARN, never throw."
metrics:
  completed: 2026-06-18
requirements: [REPORT-01, REPORT-03]
---

# Phase 20 Plan 01: sold-match-report.js per-run Slack summary

Standalone per-run Slack summary over `sold_match` with the settled genuine-non-Hemnet rate as the decision-grade headline, reported distinctly from the raw/preliminary booli_only rate.

## What was built

`sold-match-report.js` (repo root, sibling of `market-totals-weekly-report.js`):

- Pure helpers (exported, --smoke-driven): `bucketRows`, `settledRate`, `rawBooliOnlyRate`, `rollupRegion`, `segmentToMuniRegion`, `renderReport`.
- `bucketRows` produces the D-05 verdict buckets per segment: `matched` (incl. `lateResolved = matched AND first_unmatched_at != null`), `booliOnly`, `settled` (genuine_non_hemnet), `uncertain`, `total`.
- `settledRate = genuine_non_hemnet / (matched + genuine_non_hemnet)` over terminal verdicts only; returns null when no terminal verdicts. `rawBooliOnlyRate = booli_only / total` is a distinct function/number.
- `rollupRegion` groups segments by region via `config/sold-panel.json` muni→region and sums a national bucket; region/national rates come from the SUMMED terminal counts, not an average of per-segment rates.
- `renderReport` builds a monospace Slack block: LEAD national headline `SETTLED genuine-non-Hemnet (decision-grade)` then a SEPARATE `preliminary booli_only (lag-contaminated, draining ~4wk)` line, then per-region and per-segment rows.
- `run()` does the createClient/connect/try/finally(end) lifecycle, a parameterized lookback query (default today−21d, `REPORT_SINCE` override), posts via `postInfoMessage` only when `SLACK_BOT_TOKEN` is set, optional `--from-run` cron_job_log recheck block (defensive).

## Verification

- `node -c sold-match-report.js` — passes.
- `node sold-match-report.js --smoke` — `smoke: 13 pass, 0 fail`. No DB, no network, no Slack post (token deleted at smoke start; postInfoMessage asserted null).

## Segment format confirmed

Read `lib/sold-sample.js` `sampleNational` + `sold-match-batch.js`: `sold_match.segment` = `` `${muni}:${family}` `` where `muni` is the exact `config/sold-panel.json` name (e.g. `Göteborg`, `Täby`) and `family` ∈ `HOUSE | APARTMENT` (uppercase). Confirmed examples in the orchestrator smoke: `"Stockholm:APARTMENT"`, `"Täby:HOUSE"`. The report parses this exact `"<muni>:<FAMILY>"` shape and rolls muni→region via the panel's `region` field.

## Deviations from Plan

None — plan executed as written. Both tasks built in one file; TDD red/green folded into a single offline `--smoke` gate per the plan's acceptance model (no DB/network available, so the smoke IS the test). Committed as one `feat(20-01)` commit.

## Self-Check: PASSED
- sold-match-report.js — FOUND
- commit c04b5aa — FOUND
