---
title: Daily health report — widen job coverage and stop the stale-cohort null-view false alarms
priority: high
area: cron-health-slack
status: pending
created: 2026-08-13
resolves_phase: null
---
Two separate weaknesses in `cron-health-slack.js`, both found while retiring SFPL on
2026-08-13. The cadence-window false alarms found at the same time are already FIXED (see
[[sfpl-retirement-and-health-window-fix]]); these two are not.

**1. Coverage gap — the report checks 2 jobs out of ~20 (HIGH).**
`SCRIPTS = ['cohort-track', 'cohort-create']`. Every other scheduled job — `sold-match-batch`,
`market-totals-daily`, `scripts/premarket-flow-measure`, `cohort-spotcheck-gate`,
`spotcheck-reaction-poller`, the four scrape jobs (A/B/C/D), and all the Monday reporters —
is only covered by `cron-wrapper`'s event-driven failure alert. That catches a job that runs
and fails; it does NOT catch a job that never fires at all.

This is exactly the 2026-07-20 pre-market flow incident: the measure job died and the weekly
datapoint was lost silently. A "did this job fire inside its expected window?" check over all
scheduled scripts would have caught it. Now cheap to add — `WINDOW_HOURS` already models
per-frequency windows, so each new script just needs a `{ frequency, label }` entry.

Note the fortnightly wrinkle: `sold-match-batch` runs weekly but no-ops on odd ISO weeks, so
it needs either a 15-day window or awareness that a `skipped: true` result is a healthy run.

**2. Stale-cohort null-view warnings are permanent noise (MEDIUM).**
The per-cohort null-view check warns at a flat `>50%` regardless of cohort age. Old cohorts
decay naturally — their listings get delisted and stop returning view counts — so they cross
50% and then warn forever. Live example (2026-08-13): W25 at 53%/60% and W26 at 54% produce 3
of the report's 3 remaining issues, while the canary (newest cohort, W32) sits at 1%.

The canary is the signal that actually matters; the tail is expected decay. Suggested fix:
suppress the warning for cohorts older than ~4 weeks, or scale the threshold by cohort age,
and keep the line in the body as information rather than an issue. Julian's call on what he
wants to be told — flagged, not changed.
