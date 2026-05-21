---
phase: 09-production-cutover-self-hosted-scraper-launch
plan: 04
artifact: green-week-observation-log
status: pending-observation
opened: 2026-05-21
gate-day: 2026-05-25
---

# Plan 09-04 Green-week observation log

This file is the data-capture surface for the Phase 9 cutover GO/NO-GO gate. It opens on **2026-05-21** (day Plan 09-04 code shipped) and closes on **2026-05-25** (the first Monday after Plan 09-03 + 09-04 reach the droplet, which is when the gate fires).

**Status as of 2026-05-21:** Code is shipped. Observation is calendar-pending — no data can be recorded until the Monday 2026-05-25 cohort-create.js cron fires and produces W21.

## Observation timeline

| Date (UTC)            | Slot               | Script                              | Expected status         |
| --------------------- | ------------------ | ----------------------------------- | ----------------------- |
| 2026-05-21 14:00      | first */2 fire     | booli-targeted-refresh (Job D)      | success / warning       |
| 2026-05-21 14:00      | first */2 fire     | hemnet-targeted-refresh (Job A)     | success / warning       |
| 2026-05-21 22:00      | first */2 fire     | cohort-track                        | success / warning       |
| 2026-05-23 14:00      | second */2 fire    | Jobs A + D                          | success / warning       |
| 2026-05-23 22:00      | second */2 fire    | cohort-track                        | success / warning       |
| 2026-05-24 22:00      | Sun                | booli-targeted-discovery (Job C)    | success / warning       |
| 2026-05-25 03:00      | Mon                | hemnet-targeted-match (Job B)       | success / warning       |
| 2026-05-25 06:00      | Mon                | cohort-create (W21)                 | success                 |
| 2026-05-25 14:00      | third */2 fire     | Jobs A + D                          | success / warning       |
| 2026-05-25 ~07:00     | gate-eval          | (operator runs GO/NO-GO checklist)  | n/a                     |

## Gate criteria (single-threshold, all 4 must pass for GO)

Reference: `deploy-instructions.md` → `## Green-week gate and rollback` → `### Green-week GO/NO-GO checklist`.

### Check 1 — Booli fetch cohort (Job C)
**Command:** `node scripts/verify-cron-job-log.js | grep booli-targeted-discovery`
**Pass:** last row's `status` IN (`success`, `warning`), NOT `failure`. The expected steady-state warning is the 100% Oxylabs fallback rate (project memory `project_booli_refresh_oxylabs_fallback_threshold_stale.md` notes this is cosmetic; for Job C the symmetry analog if it fires is also acceptable).

**Result:**
- [ ] pass
- [ ] fail
- Status: _to be filled 2026-05-25_
- Raw row: _to be pasted 2026-05-25_

### Check 2 — Hemnet match cohort (Job B)
**Command:** `node scripts/verify-cron-job-log.js | grep hemnet-targeted-match`
**Pass:** last row's `status` IN (`success`, `warning`), NOT `failure`. Low-match-rate warning is currently cosmetic (40-55% range, project memory `project_job_b_match_rate_threshold_stale.md`).

**Result:**
- [ ] pass
- [ ] fail
- Status: _to be filled 2026-05-25_
- Raw row: _to be pasted 2026-05-25_
- summary.booliCount: _to be pasted (also feeds the Plan 09-2.6 verification deadline `summary.booliCount >= 1500`)_

### Check 3 — Booli view data (Job D)
**Command:** `node scripts/verify-cron-job-log.js | grep booli-targeted-refresh`
**Pass:** last row's `status` IN (`success`, `warning`), NOT `failure`. The 100% Oxylabs-fallback warning is the expected post-09-1.5 steady-state noise.

**Result:**
- [ ] pass
- [ ] fail
- Status: _to be filled 2026-05-25_
- Raw row: _to be pasted 2026-05-25_

### Check 4 — cohort_daily_views row count ±5% of prior 4-week median
**Command:**
```bash
cd /opt/hemnet-cohort-tracker && node -e "
  require('dotenv').config();
  const { createClient } = require('./db');
  (async () => {
    const c = createClient(); await c.connect();
    const r = await c.query(\`
      SELECT cohort_id, COUNT(*)::int AS n
      FROM cohort_daily_views
      WHERE cohort_id >= TO_CHAR(NOW() - INTERVAL '5 weeks', 'IYYY-\"W\"IW')
      GROUP BY cohort_id
      ORDER BY cohort_id DESC LIMIT 5\`);
    for (const row of r.rows) console.log(row);
    await c.end();
  })();
"
```
**Pass:** newest cohort_id's `n` is within ±5% of the median of the prior 4 cohort_ids.

**Result:**
- [ ] pass
- [ ] fail (within ±5% margin? operator judgment if -6% etc.)
- Newest cohort_id: _to be filled 2026-05-25_
- Newest n: _to be filled_
- Prior 4 cohort_ids: _to be filled_
- Prior 4 n values: _to be filled_
- Prior 4 median: _to be filled_
- Newest n vs median: ±__% _to be filled_

## Anomalies during the observation week

Record any Slack alerts, unexpected statuses, or operator interventions between 2026-05-21 and 2026-05-25.

| Date (UTC)            | Script             | Severity   | Note                                  |
| --------------------- | ------------------ | ---------- | ------------------------------------- |
| (none yet)            |                    |            |                                       |

## Cohort-track null-Booli warning self-clearance (09-03 carry-forward #4)

Plan 09-03 surfaced that cohort-track has been logging `status=warning` daily since 2026-05-17 with `2026-W13/W14/W15: 54-58% null Booli`. The expectation is that the every-2-days Booli view-data refresh (first */2 fire 2026-05-21 14:00 UTC) will refresh active-listing freshness, and the warning will self-clear over 2-3 cohort-track cycles (2026-05-21 22:00 UTC, 2026-05-23 22:00, 2026-05-25 22:00).

**Self-clearance check:**
- [ ] 2026-05-21 22:00 cohort-track null-Booli pct: _to be filled_
- [ ] 2026-05-23 22:00 cohort-track null-Booli pct: _to be filled_
- [ ] 2026-05-25 22:00 cohort-track null-Booli pct: _to be filled_

**Expected:** descending percentages, ideally below the 50% warning threshold by the third fire. If NOT cleared by Mon 2026-05-25, escalate per the carry-forward note.

## Outcome (filled 2026-05-25)

**Resume signal:** _one of `cutover-complete` / `cutover-deferred-replan: <details>` / `partial: <details>`_

**If cutover-complete:**
- Tag pushed: `phase-9-cutover-complete`
- v2.0 milestone: shipped
- All 4 checks: passed
- Cohort-track null-Booli warning: cleared

**If cutover-deferred-replan:**
- Failure mode: _description_
- Rollback executed: yes / no
- Follow-up ROADMAP phase: _phase-id_
- Backup file used: `/tmp/crontab-backup-1779318677.txt`

**If partial:**
- Which check needs operator judgment: _description_
- Decision: _description_
