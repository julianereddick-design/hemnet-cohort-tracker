---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Self-hosted scraper
status: Plan 09-2.5 code-complete (7/9 tasks shipped); Tasks 8 (deploy) + 9 (Sun/Mon cron verification) are operator-action; Plan 09-02 closed out as partial (wet-run skipped)
last_updated: "2026-05-15T09:15:00.000Z"
current_phase: 09-production-cutover-self-hosted-scraper-launch
current_plan: 09-2.5
last_completed_plan: 09-1.5
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 6
  completed_plans: 2
  percent: 33
session_continuity:
  last_session: "2026-05-15"
  stopped_at: "Plan 09-2.5 Tasks 1-7 shipped (commits 618c896 + dfe9fb0); Task 8 deploy is operator-action via git pull on droplet; Task 9 is natural-cron checkpoint Sun 22:00 UTC + Mon 03:00/06:00 UTC"
  resume_command: "Operator: run deploy commands on droplet, then monitor Sun/Mon crons, then return with success/partial/failed resume signal per Plan 09-2.5 Task 9 <resume-signal>"
carry_forward:
  - "09-02 #1: Wet-run gate (Task 5, D-19) SKIPPED at operator direction. Job D + Job A conc-8 worker pool unexercised at scale. First real test is Tue 2026-05-19 14:00 UTC cron — recovery path is Slack-alert → diagnose → patch → next cycle. Residual risk acknowledged in 09-02-SUMMARY.md."
  - "09-02 #2: Job A retrofit (D-16) shipped — hemnet-targeted-refresh.js symmetric to Job D (conc 8, budget 240, validate budgetExceeded + workerErrors branches). Today's Hemnet stays direct-curl-fast; workers run ~80% idle until Hemnet flips."
  - "09-02 #3: D-17 cron-grid amendment (Job D + Job A PARALLEL at 14:00 UTC odd days) DOCUMENTED but NOT YET deployed. Plan 09-03 owns the deploy-instructions.md crontab edit."
  - "09-2.5 #1 (NEW): Django scraper decommission discovered mid-session (2026-05-15: writes dropped from ~75% pop to 1/610). Booli enrichment fields (price/rooms/living_area/object_type/agent_id) now captured by Job C + Job D directly from Apollo state. Schema migration ran live."
  - "09-2.5 #2 (NEW): 26.7% aggregate match rate over 8 weeks (5484/15036) — substantially worse than the 42.4% VERF-05 snapshot. Job B targeted-search rewrite is the path back; uses price ±5% + exact rooms + 8-entry Booli→Hemnet item_type mapping."
  - "09-2.5 #3 (NEW): agent_id SEMANTIC DIVERGENCE flagged for Metabase consumers — Booli's Source.id (broker chain) differs from Django's old agent_id values. Operator action item: Metabase reports keyed on Django agent_id values may need rebuilding."
  - "09-2.5 #4 (NEW): cohort_unmatched bucket-level diagnostic DEFERRED — NOT EXISTS scans against hemnet_listingv2's LOWER(TRIM(street_address)) time out without functional index. Add later if needed."
  - "09-1.5 #1: 180-min JOB_BUDGET_MS for Job C may not fit full 3.4k-detail queue at 13/min rate — first production Sunday cron is verifier; bump to 300 min or raise conc if budget-exceeded recurs. By analogy with 09-02 raising Job D's conc 2→8, Job C may want similar treatment in Phase 10."
  - "09-01 #3: Final: status field vs cron-wrapper status mismatch — cosmetic; Phase 10."
recent_commits:
  - "49970b8 docs(09): formalize Plan 09-2.5 + close out 09-02 (wet-run skipped)"
  - "618c896 feat(booli): capture price/rooms/living_area/object_type/agent_id from Apollo"
  - "eb3975e fix(09-02): probe-booli-refresh SQL — SELECT DISTINCT + ORDER BY rule"
  - "41a0664 feat(09-02): scripts/probe-oxylabs-hemnet.js — Hemnet-via-Oxylabs probe (D-18)"
  - "fd8ac88 refactor(09-02): Job A retrofit — symmetric 09-01 hardening + conc 8 + budget 240 (D-16)"
  - "a939767 feat(09-02): VERF-09-2 dry-run probe scripts/probe-booli-refresh.js"
  - "b3884e8 feat(09-02): Job D booli-targeted-refresh.js — conc 8, budget 240 (D-15)"
  - "aa25ef8 docs(09-02): replan — D-15..D-19 baked in"
deadlines:
  - "Mon 2026-05-18 03:00 UTC — Job B cron slot. Plan 09-2.5 Task 7 (Job B rewrite) MUST ship and deploy before this for W21 cohort to benefit. Acceptable degradation: slip → W22 absorbs."
  - "Mon 2026-05-18 06:00 UTC — cohort-create cron run. First W21 cohort built against new Booli fields + (ideally) new Job B narrowed-search output."
  - "Sun 2026-05-17 22:00 UTC — Job C cron run. First wet exercise of Plan 09-2.5 field-capture code (commit 618c896) at scale."
---
