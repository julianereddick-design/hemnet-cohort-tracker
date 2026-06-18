# Trend chart — add first-scrape vs final match-rate series

**Status:** PENDING — enhancement (Phase 20 follow-up). Logged 2026-06-18.
**Related:** `sold-match-trend-chart.js`, `sold-match-report.js`, REPORT-02/03, the `clearRecheck` late-marker fix (commit `acd98c0`).

## What
Add a **first-scrape match-rate** series to `sold-match-trend-chart.js`, plotted next to the existing
final (post-re-check) match-rate line, per fortnightly cohort (keyed by `window_end` ISO week). The gap
between the two lines = how much the re-check drain recovered for that cohort after the first scrape.

Per period, from current `sold_match` state (no snapshot table needed — the preserved `first_unmatched_at`
marker carries the signal):
- **first-scrape matched** = `verdict='matched' AND first_unmatched_at IS NULL`
- **final matched** = all `verdict='matched'` (first-scrape + late-added)
- first-scrape rate = first-scrape matched / cohort total; final rate = final matched / cohort total

## Why
Operator wants to see, for a given market-share period (cohort of sold Booli properties), **what the first
scrape caught vs how many were added later by the re-check** — the recovery, visible at a glance. The
numeric decomposition already lands in `sold-match-report.js` (`matched=N (late=M)` per segment); this is
the visual counterpart on the trend chart.

## Scope
~15 lines in `sold-match-trend-chart.js`: one more derived series in `buildSeries` + one more Chart.js
dataset (distinct style/label from the final line). Offline `--smoke`: assert the first-scrape series is
present, distinct from the final line, and that first-scrape ≤ final per period. Pure/fixture-tested.

## Not this
Not a global rate-over-reporting-dates time-series (rejected — operator wants the per-cohort first-scrape-
vs-late decomposition, which the single-row state already supports; no `sold_match_snapshots` table).
