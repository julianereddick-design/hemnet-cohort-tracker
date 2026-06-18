---
phase: 20-per-run-reporting-decision-grade-trend
plan: 02
subsystem: reporting
tags: [chart, sold-match, reporting, decision-grade, committed-html]
requires: [sold_match table, db.js, view-data-server.js, config/sold-panel.json]
provides: [sold-match-trend-chart.js committed-HTML trend]
affects: []
tech-stack:
  added: []
  patterns: [chart-hb-ratio.js committed-HTML Chart.js-4 family, pure-helper + --smoke offline gate]
key-files:
  created: [sold-match-trend-chart.js]
  modified: []
decisions:
  - "Fortnightly periods keyed by window_end ISO week (YYYY-Www, ISO week-year aware); batch runs fortnightly so each window_end lands on its own period."
  - "Settled non-Hemnet + match rates computed over TERMINAL verdicts only; raw booli_only/total is a separate, dashed/muted, distinctly-labelled series."
  - "Self-contained HTML (Chart.js@4 from CDN, data inline) written to view-data/<date>/sold-match/trend.html (gitignored runtime output, served by view-data-server.js:3800)."
metrics:
  completed: 2026-06-18
requirements: [REPORT-02, REPORT-03]
---

# Phase 20 Plan 02: sold-match-trend-chart.js committed-HTML trend

Standalone committed-HTML Chart.js-4 trend generator over `sold_match`: per fortnightly period it plots the settled genuine-non-Hemnet rate + match rate, with the raw booli_only rate styled/labelled distinctly.

## What was built

`sold-match-trend-chart.js` (repo root, sibling of `chart-hb-ratio.js`):

- `isoWeekKey(dateStr)` — Thursday-anchored ISO-8601 week label `YYYY-Www`, ISO week-year aware (handles the Jan-1/Dec-31 boundary, e.g. `2025-12-31 → 2026-W01`).
- `buildSeries(rows)` (pure) — groups by `isoWeekKey(window_end)`, computes per period `settled = genuine_non_hemnet/(matched+settled)`, `match = matched/(matched+settled)` over terminal verdicts only, and `rawBooliOnly = booli_only/total`. Returns `{ periods (chronological), settled, match, rawBooliOnly }` with null entries for periods with no terminal verdicts (spanGaps).
- `renderHtml(series, opts)` — self-contained Chart.js-4 line chart: Settled non-Hemnet (solid blue #1565C0 w3, decision-grade), Match rate (solid green), Raw booli_only (dashed grey, "preliminary, lag-contaminated"). Rates scaled to percent, y 0..100, spanGaps. A note paragraph explains the settled-vs-raw distinction.
- `writeChart(series, opts)` — writes to `view-data/<date>/sold-match/trend.html` (mkdir -p), returns the absolute path.
- `run()` — chart-hb-ratio.js createClient/connect/try/finally(end) lifecycle, static SELECT, then buildSeries → writeChart and a per-period console summary.

## Verification

- `node -c sold-match-trend-chart.js` — passes.
- `node sold-match-trend-chart.js --smoke` — `smoke: 9 pass, 0 fail`. No DB, no network. Writes `view-data/2026-06-18-smoke/sold-match/trend.html` and reads it back to assert chart.js@4 + both distinct labels.

## Segment format confirmed

Same as 20-01: confirmed `sold_match.segment` = `` `${muni}:${family}` `` (FAMILY ∈ HOUSE|APARTMENT) in `lib/sold-sample.js`/`sold-match-batch.js`. The mandatory national line does not depend on segment parsing (only `verdict` + `window_end`); per-region lines were left OPTIONAL per the plan and not implemented this pass — the national settled-vs-raw trend is the decision-grade output. Region rollup can be added later by reusing 20-01's `segmentToMuniRegion`.

## Known Stubs

None. Per-region series are an OPTIONAL deferral (national line is the mandatory + sufficient output per D-07 and the plan's segment_format_note), not a stub blocking the plan goal.

## Deviations from Plan

- Per-region series not implemented (plan marks them OPTIONAL; national line mandatory and built). Rationale: the decision-grade headline is the national settled rate; region breakout adds no new methodology and can reuse 20-01's parser when needed. Marked as a deferral, not a gap.
- Smoke fixture writes under a `-smoke`-suffixed date dir so it never collides with a real run's date dir; `view-data/` is gitignored (runtime output, chart-hb-ratio.js convention) so the artifact correctly stays out of git.

## Self-Check: PASSED
- sold-match-trend-chart.js — FOUND
- commit 3c5b7af — FOUND
