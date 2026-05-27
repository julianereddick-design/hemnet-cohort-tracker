# Phase 11: Daily market-totals capture + minimal report - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-27
**Phase:** 11-daily-market-totals-capture-and-minimal-report
**Areas discussed:** Booli segment-split strategy, Smoke-probe scope + placement, Alert thresholds, Reporting consumer choice

---

## Booli segment-split strategy

Initial question framed three options for how to gather the three originally-scoped Booli segments (Till salu / Kommande / Sold).

| Option | Description | Selected |
|--------|-------------|----------|
| One filtered + one unfiltered + sold (3 reqs) | Filtered `?upcomingSale=0` for till_salu, unfiltered for kommande via facets, plus a third sold fetch. Exact + 1 extra Oxylabs req/day. | |
| One unfiltered + facets (2 reqs) | Read both facets from the unfiltered URL; accept ~0.8% underread on Till salu vs filtered total. Cheapest. | |
| Filtered + unfiltered + sold, storing both numbers (3 reqs) | Same as (a), keep both filtered and facet numbers to track drift. | |
| (operator free-text) | "Don't need sold properties. Happy for one call each for Till Salu and Kommande" | ✓ |

**Follow-up: confirm daily Oxylabs req budget (Sold dropped)**

| Option | Description | Selected |
|--------|-------------|----------|
| 3 reqs/day — Hemnet 1 + Booli 2 | Hemnet single fetch returns both segments; Booli 2 separate filtered fetches. 4 rows/day. Cheapest exact. | ✓ |
| 4 reqs/day — Hemnet 2 + Booli 2 | Symmetric per-segment fetches both sides. No accuracy benefit. | |

**User's choice:** 3 reqs/day — Hemnet 1 + Booli 2.
**Notes:** Sold dropped from scope entirely. Cost lands at 3 Oxylabs reqs/day, 4 rows/day. ROADMAP SC-1 "6 rows/day" needs an update.

---

## Smoke-probe scope + placement

| Option | Description | Selected |
|--------|-------------|----------|
| Inline + key-present + total > 1000 sanity bound | First action in `main()`; throw on missing key OR low total. | |
| Separate `scripts/probe-market-totals-schema.js` with own cron slot | Pre-flight script fires ~06:00 UTC, before the main 08:00 job. Costs 3 extra Oxylabs reqs/day. | |
| Inline, key-present only | Same as (a) but skip the >1000 sanity bound. | |

Operator asked for an explainer before answering. After the explainer covered why __NEXT_DATA__ internal Apollo keys are unstable and what a "smoke-probe" means, the question was re-presented:

| Option | Description | Selected |
|--------|-------------|----------|
| Inline (key-present only) | Check JSON paths resolve to numbers before writing. Throw → cron-wrapper marks failure → Slack. No extra cost. | ✓ |
| Inline + sanity-bound (total > 1000) | Catches stub-page case but risks false alerts on real market events. | |
| Separate probe script + own cron slot | Costs 3 extra Oxylabs reqs/day. Pages even on days main job is skipped. | |

**User's choice:** Inline in `market-totals-daily.js`, key-present only.
**Notes:** Operator explicitly rejected sanity bounds — a low total is a real market signal, not a schema break.

---

## Alert thresholds — "unexpected delta"

| Option | Description | Selected |
|--------|-------------|----------|
| Skip delta alerting in v1 — only path-break + fetch-failure | Phase 11 ships with two alert paths only. Add delta thresholds once baseline exists. | ✓ |
| ±20% DoD per segment (catastrophe-only) | Alert on >20% day-over-day change per segment. | |
| ±10% WoW per segment (smoother, 7-day buffer) | Compare today vs 7 days ago; needs week of history first. | |

**User's choice:** Skip delta alerting in v1.
**Notes:** Direct continuity with Phase 10's alert-fatigue cleanup. ROADMAP SC-2's "or unexpected delta" clause should be dropped.

---

## Reporting consumer choice

| Option | Description | Selected |
|--------|-------------|----------|
| Daily Slack one-liner | Every day, every segment, with WoW. Tests cron liveness. | |
| Tile in `weekly-view-report.js` | Once a week, lower noise, fits existing cadence. | |
| Both — daily Slack + weekly tile | Maximum surface area, ~2x code in 11-03. | |
| Just write the table — no consumer in Phase 11 | Defer consumer to v2.3. Violates ROADMAP SC-4. | |
| (operator free-text) | "Weekly Slack - we can work together to figure out what the output looks like but it's going to show WoW change in Till Salu in absolute levels and that compares between Hemnet and Booli" | ✓ |

**Follow-up: output mockup selection**

| Option | Description | Selected |
|--------|-------------|----------|
| Compact, 2-line | Hemnet + Booli rows with last-week → this-week, abs delta, percent delta. | |
| Compact + Booli−Hemnet gap row | Same as (a) plus a third row showing the gap and how it moved. | ✓ |
| Table form, 4 weeks history | Per-platform values across last 4 weeks; needs 4 weeks of data. | |
| Just numbers, no commentary | Bare values. | |

**User's choice:** Compact + Booli−Hemnet gap row.
**Notes:** Locked output format — operator-selected preview. Kommande captured in `market_totals` but not surfaced in weekly Slack consumer (deferred). Cadence: Monday alongside `weekly-view-report.js`.

---

## Claude's Discretion

- Exact wording of log lines and `resultSummary` field names.
- Inline cron-slot recommendation (08:30 UTC daily, Mon 09:30 UTC weekly) — sensible defaults, planner may revisit.
- Whether the weekly Slack consumer lives in a new `market-totals-weekly-report.js` (recommended) or is embedded in `weekly-view-report.js` (acceptable). Operator did not specify; CONTEXT.md recommends separation, planner decides.
- Number formatting in Slack output (comma vs space thousands separator; comma slightly recommended).
- Retry counts inside the JSON-path probe (single-shot — underlying `getWithRetry` already retries).

## Deferred Ideas

- **Sold / historic-sold totals** — JSON paths known, schema is trivially extensible, but operator dropped from scope. Re-add via a future plan.
- **Unexpected-delta alerting** — defer until 30+ days of baseline data accrue. Open question: DoD ±20% vs WoW ±10% vs segment-specific thresholds (Kommande is more volatile).
- **Per-municipality / per-county totals** — out of scope per ROADMAP; own milestone.
- **Long-horizon backfill** — out of scope per ROADMAP.
- **Cross-platform reconciliation analysis** — analyst-side, not pipeline; see `[[project-booli-hemnet-totals-asymmetry]]`.
- **Surfacing Kommande in weekly Slack** — captured in `market_totals`, but operator chose Till salu only for the consumer. Easy add later.
- **Verifying the actual crontab line for `weekly-view-report.js`** — `deploy-instructions.md` shows Mon 09:00 UTC for the legacy Pool & Flow block (scheduled for retirement in Plan 10-05); `weekly-view-report.js`'s own slot isn't explicit there. Planner should confirm during 11-03.
