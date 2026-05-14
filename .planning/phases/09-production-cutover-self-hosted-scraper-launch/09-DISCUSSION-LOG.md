# Phase 9: Production cutover — self-hosted scraper launch - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-14
**Phase:** 09-production-cutover-self-hosted-scraper-launch
**Areas discussed:** Job D scope mirror, Crontab slot times, External scraper decommissioning scope

---

## Pre-discussion: existing-plans handling

| Option | Description | Selected |
|--------|-------------|----------|
| Continue and replan after | Capture decisions now; rewrite plan list after CONTEXT.md is written | ✓ |
| View existing plans first | Show 09-01/02/03 plan objectives before deciding | |
| Cancel discuss-phase | Stop here; edit plans directly | |

**User's choice:** Continue and replan after.
**Notes:** User had already invoked `/gsd-discuss-phase 9` explicitly after my ad-hoc plan was rejected; this confirmation was procedural.

---

## Job D scope mirror

| Option | Description | Selected |
|--------|-------------|----------|
| Full mirror | Identical structure to hemnet-targeted-refresh.js — same SELECT shape (swapped for booli_id + URL join), concurrency 2 + 100-300ms jitter, same validate() four-branch contract, plus 09-01 worker-pool hardening (try/catch + err.stack + 35-min budget + budgetExceeded/workerErrors validate branches). Defensive INSERT fallback included. | ✓ |
| Full mirror but drop the defensive INSERT | Same but skip the INSERT-when-booli_listing-row-missing fallback. Saves ~15 lines, loses safety net. | |
| Mirror with different lookback | 12-week lookback may not match Booli's view-count behavior — pick a different window. | |

**User's choice:** Full mirror (Recommended).

**Notes:** User initially asked to clarify which URLs Job D would scrape. Clarified that Job D filters on `cohort_pairs` (matched pairs only, not all `booli_listing` rows). User confirmed: "The job should be the same as Hemnet's but for the Booli site (i.e. only matched pair URLs)." After clarification, user picked Full mirror.

---

## Crontab slot times

| Option | Description | Selected |
|--------|-------------|----------|
| 14:00 / 18:00 / 22:00 UTC, every-2-days (`*/2`) | Job D 14:00, Job A 18:00, cohort-track 22:00, on `*/2` days. 4h gaps cover worst-case runtimes. cohort-track 22:00 safely after both refreshes. | ✓ (Claude's discretion) |
| 10:00 / 14:00 / 18:00 UTC, every-2-days | Run earlier in UTC day for European business-hours visibility. | |
| Explicit odd-day cron (1,3,5,...,29,31) | Exact 2-day spacing guaranteed; messier crontab. | |

**User's choice:** Claude's discretion (user said "you choose").

**Notes:** User initially asked for a clearer explanation of the job catalogue before deciding on timing. Provided a full job-by-job breakdown (Phase 1 weekly: Job C → Job B → cohort-create; Phase 2 every-2-days: Job D → Job A → cohort-track; Phase 3 daily: sfpl-region-snapshot). After the explainer, user delegated the slot decision. Claude picked the recommended option (14/18/22 UTC `*/2`) and flagged the consequential side-effect: cohort-track's 10-streak drop threshold in `cohort-track.js:113-127, 167-181` now triggers at ~20 calendar days instead of 10. Logged as open question D-11 for the planner.

---

## External scraper decommissioning scope

| Option | Description | Selected |
|--------|-------------|----------|
| Both Booli + Hemnet already off | External scraper is fully decommissioned. SC-4 simplifies to "verify cohort pipeline runs green for one full week-cycle." | ✓ |
| Booli off, Hemnet still running | Hemnet external scraper still writing alongside Job A — cutover needs a turn-off step. | |
| Both still running (parallel-run planned) | Original Plan 09-03 assumption — observation week + compare-writers.js. | |
| External scraper is upstream / not under our control | Can't decommission from this repo; just stop relying on it. | |

**User's choice:** Both Booli + Hemnet already off.
**Notes:** Simplifies the renumbered Plan 09-04 (was 09-03) significantly — no parallel-run observation week, no `scripts/compare-writers.js`, no quiescence ceremony. SC-4 in ROADMAP.md needs rewording during replan.

---

## Claude's Discretion

- **Crontab slot times (D-06):** User said "you choose" after the job-catalogue explainer. Locked at 14:00 / 18:00 / 22:00 UTC odd days based on runtime headroom analysis.
- **Streak-threshold halving default recommendation (D-11):** Default recommendation is to halve `10 → 5` to preserve current ~10-day drop window. Final decision deferred to the planner.

---

## Deferred Ideas

- **Update downstream reports for every-2-days cohort_daily_views granularity** — `pool-flow-report.js`, `weekly-view-report.js`, `export-views-wide.js`, etc. assume daily rows. User explicitly skipped this gray area when selecting which areas to discuss. Defer to a follow-up phase once Phase 9 is in production.
- **Extract hardened worker-pool pattern into `lib/worker-pool.js`** — Three scripts will carry near-identical hardened worker-pool code after Phase 9. Refactor candidate for Phase 10.
- **Explicit-day-list crontab vs `*/2`** — `*/2` has a 1-day gap at month boundaries on 31-day months. Operator decision after first cross-month observation.
- **One-shot Job D pre-cutover backfill** — Since the external scraper was off, the first Job D run will produce a large delta in `cohort_daily_views.booli_views`. Operator may want a one-shot pre-cutover run for a natural-looking first delta. Defer to operator preference.
- **VERF-09-1 wet-run for Job C** — Deferred until the new Job D plan ships; both wet-runs combined in one session.
