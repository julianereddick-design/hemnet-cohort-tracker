---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Self-hosted scraper
status: Executing Phase 09 — Plan 09-1.5 complete (partial-budget-hit); Plan 09-02 next (Job D Booli refresh)
last_updated: "2026-05-15T03:56:00.000Z"
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
  - "09-1.5 #1: 180-min JOB_BUDGET_MS may not fit full 3.4k-detail queue at observed 13/min rate — first production Sunday cron is the verifier; if budget-exceeded recurs, bump to 300 min or raise concurrency 2→4 (see 09-1.5-SUMMARY)"
  - "09-1.5 #2: Job D's 8k-pair queue × 5s/call × concurrency 2 = ~333 min wall-clock — doesn't fit the 14:00→18:00 UTC cron gap. Address in 09-02 discuss-phase BEFORE building Job D"
  - "09-01 #3: Final: status field vs cron-wrapper status mismatch — cosmetic; Phase 10"
---
