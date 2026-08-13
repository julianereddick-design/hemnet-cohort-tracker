---
title: Deploy the SFPL retirement + health-check cadence-window fix (code done, droplet not touched)
priority: high
area: deploy
status: pending
created: 2026-08-13
resolves_phase: null
---
Work is COMPLETE in the working tree and verified against the live DB, but deliberately NOT
deployed. Holding because the code change and the crontab change must land together.

**What was changed (2026-08-13, approved by Julian):**
- `sfpl-region-snapshot` retired — no downstream consumer existed. Its only reader was
  `cron-health-slack.js`'s own row-count check (the job's alarm confirming the job ran) plus
  the manual console report `sfpl-region-analysis.js`. Two of its three columns are region
  totals duplicated across all six age buckets, and its universe is our 4-county cohort DB,
  not national — superseded by `premarket_flow_weekly` and the `scripts/*-age-census.js` work.
  The `sfpl_region_daily` table is RETAINED (2,880 rows, 2026-03-06 → 2026-08-12).
- Two standing false alarms in the daily health report fixed. Both came from judging every
  job against a flat 25h window: weekly `cohort-create` warned on all six non-Mondays, and
  every-2-days `cohort-track` (22:00 UTC, odd days) warned on alternate days because its last
  run was ~29h old when the 03:00 check ran. Each frequency now has its own window
  (`WINDOW_HOURS = { daily: 25, every2days: 50, weekly: 192 }`).
- Added `node cron-health-slack.js --dry-run`. Needed because dotenv re-injects
  `SLACK_WEBHOOK_URL`, so `env -u` does not prevent a post — this report had no safe test path.

**Verified:** dry-run against the live droplet DB, 2026-08-13. Both jobs green, sfpl line
gone, issue count 4 → 3 (remaining 3 are the stale-cohort null warnings, see
[[health-check-coverage-and-thresholds]]).

**Files touched:** `cron-health-slack.js`, `scripts/verify-cron-job-log.js`,
`sfpl-region-snapshot.js` (deprecation header), `deploy-instructions.md`,
`docs/handover/02-DATA-STREAMS-AND-JOBS.md`, `docs/handover/03-INFRASTRUCTURE-AND-OPERATIONS.md`,
`docs/handover/04-REPORTING-AND-SLACK.md`, `.planning/codebase/INTEGRATIONS.md`.

**Remaining to deploy:** commit; merge to master; `git pull` on the droplet; remove the
`0 8 * * * … sfpl-region-snapshot.js` crontab line (back up `crontab -l` first). If the
crontab line goes without the code, the health report simply swaps one false alarm for
another ("No runs for sfpl-region-snapshot").

Should ship in the same deploy as [[slack-output-routing-split]]. Mind the existing local↔prod
drift — the droplet's master is behind and carries none of the `scripts/` age or quality tools.
