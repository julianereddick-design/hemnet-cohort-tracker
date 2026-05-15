---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Self-hosted scraper
status: Executing Phase 09 — Plan 09-02 context gathered (Job D + symmetric Job A retrofit; conc 8, budget 240 min, parallel cron); ready for replan
last_updated: "2026-05-15T04:30:00.000Z"
current_phase: 09-production-cutover-self-hosted-scraper-launch
current_plan: 09-02
last_completed_plan: 09-1.5
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 5
  completed_plans: 2
  percent: 40
carry_forward:
  - "09-1.5 #1: 180-min JOB_BUDGET_MS may not fit full 3.4k-detail queue at observed 13/min rate — first production Sunday cron is the verifier; if budget-exceeded recurs, bump to 300 min or raise concurrency 2→4 (see 09-1.5-SUMMARY). Note: 09-02 raises Job C's sibling refresh concurrency to 8 — Job C may also want a conc bump in Phase 10 by analogy."
  - "09-1.5 #2: RESOLVED in 09-02-CONTEXT D-15: Job D sized at conc 8 + JOB_BUDGET_MS=240 min → ~155 min wall-clock for 8k pairs, fits the 14:00→18:00 cron gap with ~85 min margin"
  - "09-02 #1: Job A retrofit (D-16) brings hemnet-targeted-refresh.js to symmetric hardening posture (conc 8, budget 240, validate budgetExceeded + workerErrors branches) — protects against future Hemnet IP-ban. Today's Hemnet stays direct-curl-fast so workers will run ~80% idle"
  - "09-02 #2: Cron grid amendment per D-17: Job D + Job A run PARALLEL at 14:00 UTC odd days (was sequential 14:00→18:00). Plan 09-03 crontab needs the parallel block, not the sequential one"
  - "09-02 #3: New scripts/probe-oxylabs-hemnet.js per D-18 — insurance against Hemnet flip-to-Oxylabs scenario. Run cost ~$0.005"
  - "09-01 #3: Final: status field vs cron-wrapper status mismatch — cosmetic; Phase 10"
---
