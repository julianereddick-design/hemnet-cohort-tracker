---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Self-hosted scraper
status: Phase 9 cutover-complete 2026-05-26 — v2.0 milestone SHIPPED. Green-week gate cleared with all 4 cron-status checks PASS (Job B=warning/cosmetic, Job C=warning/cosmetic, Job D=warning/cosmetic, cohort-create W21 success=1,303 day-0 pairs). Check 4 (cohort_daily_views row count ±5% of prior 4-week median) PASS via operator-judgment override — strict ±5% mooted by W17/W18 broken-cohort noise in the median window; W21=1,303 vs healthy-week baseline (W20=1,535, W16=1,486) is ~−14%, within meaningful range for a functioning cohort. See .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-GREEN-WEEK.md for the full 4-check write-up + anomalies + Phase 10 carry-overs. Self-hosted scraper (Jobs A/B/C/D + cohort-create + cohort-track on every-2-days */2 cadence + Sun/Mon weekly slots) is now in steady-state production. Phase 10 hardening queued — see carry-forwards below.
last_updated: "2026-05-26T05:30:00.000Z"
current_phase: 10-hardening
current_plan: TBD
last_completed_plan: 09-04
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 7
  completed_plans: 7
  percent: 100
session_continuity:
  last_session: "2026-05-26"
  stopped_at: "Phase 9 closed cutover-complete 2026-05-26. Green-week observation log filled in (09-04-GREEN-WEEK.md) using actual cron_job_log + cohort_pairs / cohort_daily_views data pulled live from the droplet DB. All 4 gate checks pass (Check 4 via operator-judgment per Julian — strict ±5% threshold un-applicable due to W17/W18 broken-cohort noise in prior-4 median window). ROADMAP Phase 9 marked Complete 2026-05-26 with 5/5 plans done. v2.0 milestone shipped. The W20 hb-ratio xlsx + W20 views-wide CSVs were generated as a confidence-check on the view-tracking pipeline (data is varying per pair and consistent with healthy historical patterns). Phase 10 hardening backlog absorbed all observation-week findings (SIGHUP/SIGTERM re-occurrence, Job C Sun off-by-one fired in the wild, agent_id FK leakage, cohort-track null-Booli threshold needs retargeting, export-views-wide 1-day delta math now stale under every-2-days cadence)."
  resume_command: "Next session: kick off Phase 10 hardening planning. Use /gsd-new-milestone? or /gsd-phase to insert Phase 10 in ROADMAP. The Phase 10 scope is well-stocked from the carry-forwards below — recommend bundling into ~4 plans: (10-01) cron-wrapper signal handlers + general unsticker (closes 09-2.6 #1, 09-03 #5); (10-02) Job B/C/D cosmetic-warning retarget + Job C Sun off-by-one + agent_id FK constraint (closes 09-2.5 #6, 09-03 #3, project_job_b_match_rate_threshold_stale, project_job_c_sunday_off_by_one); (10-03) cohort-track null-Booli threshold retarget (new finding from green-week observation); (10-04) export-views-wide gap-aware delta + scripts/ cleanup (closes project_todo_cleanup_claude_outputs, new finding from green-week observation). Phase 9 carry-forwards #2/#4/#7/#8/#9/#10/#11 + 09-1.5 #1 + 09-01 #3 also fold into these 4 plans. To physically tag the close: `git tag phase-9-cutover-complete` after committing this state."
carry_forward:
  - "09-2.5 #7 (still open, observation-week DEFERRED): Postcode-mismatch gate over-rejecting valid matches (27/200 = 13.5% of W20 dry-run rows). Could lift Job B writes from 41% → ~55% if loosened. Operator-judged accept the conservative loss; Phase 10 candidate — fold into 10-02 above as a stretch item, not a launch blocker."
  - "09-2.5 #8 (CLOSED by Plan 10-02 (h), 2026-05-26): hemnet-targeted-match.js log line now references `${booli.url}` instead of constructing wrong `/bostad/${booli_id}`. `url` added to SELECT projection. Pure log cosmetic. Commit f7b22bc."
  - "09-2.5 #6 (CARRY: Phase 10): agent_id FK constraint leaks workerErrors in Job C/D writes (~0.5% in id=446 = 31 errors of 7068 fetched). Three fix options documented; pick one in 10-02. Re-confirmed during green-week observation."
  - "09-2.5 #9 (CLOSED by Plan 10-02 (g), 2026-05-26): hemnet-targeted-refresh.js active-path UPDATE now COALESCE-preserves the 5 discovery-metadata fields (street_address / postcode / municipality / county / listed), mirroring booli-targeted-refresh.js D-24 symmetry. Commit f564682."
  - "09-2.5 #10 (one-line fix, Phase 10): scripts/enrich-booli-week.js UPDATE missing 'crawled = NOW(),'. Probe-script only — production paths are correct. Fold into 10-04 scripts cleanup."
  - "09-2.6 #1 (CONFIRMED-IN-WILD during green-week, Phase 10): cron-wrapper.js missing SIGHUP/SIGTERM/SIGINT handlers. Re-occurred Sat 2026-05-23 14:00 UTC Job A id=435 (left in status=running, dur=null). Fix: add ~5 lines + general scripts/unstick-cron-row.js. Highest-priority Phase 10 item (10-01)."
  - "09-2.6 #2 + 09-2.5 #4 (CLOSED by Plan 10-02 (i), 2026-05-26): functional index `hemnet_listingv2_norm_street_idx ON hemnet_listingv2 (LOWER(TRIM(street_address)))` created on prod DB (CONCURRENTLY, 1s build on ~129k rows). Fuller delta filter (crawled OR NOT EXISTS hemnet_listingv2) re-enabled in hemnet-targeted-match.js SELECT — EXPLAIN ANALYZE 932ms on W21 prod data vs 104s pre-index (110× speedup). New scope ~9% wider — catches Booli rows where prior matching failed AND bl.crawled is stale. Mon 2026-06-01 03:00 UTC fire is in-prod verifier. Commit ff44f91."
  - "09-03 #2 (Phase 10 doc hygiene): codebase intel files (.planning/codebase/CONCERNS.md:153, STACK.md:54, INTEGRATIONS.md:10) incorrectly claim SLACK_WEBHOOK_URL is not configured. Re-run /gsd-map-codebase to refresh, or manual correction. Fold into 10-04."
  - "09-03 #3 (Phase 10 cosmetic): booli-targeted-refresh.js validate() warning 'high Oxylabs fallback rate: 100.0%' is now permanent noise (project_booli_refresh_oxylabs_fallback_threshold_stale). Re-target: warn only if fallback rate suddenly DROPS. Fold into 10-02."
  - "09-03 #5 (CONFIRMED-IN-WILD during green-week, Phase 10): Orphan `running` rows in cron_job_log (3 from pre-window booli-targeted-discovery + 1 from Sat 2026-05-23 14:00 Job A id=435). Same root cause as 09-2.6 #1. scripts/unstick-cron-row.js general-purpose unsticker bundled with 10-01."
  - "09-04 #4 (NEW from green-week observation, Phase 10): cohort-track null-Booli warning does NOT self-clear over 2-3 cycles — the hypothesis in carry-forward 09-03 #4 was wrong. Structural: old cohorts naturally accumulate null Booli as listings drop off Booli's active feed. Three retargeting options: (a) age-bounded threshold (warn only for cohorts ≤ N weeks old), (b) delta threshold (warn on week-over-week jump > X%), (c) demote from warning to reporting field. Should be its own 10-03 plan to think through carefully."
  - "09-04 #5 (NEW from green-week observation, Phase 10): export-views-wide.js 1-day delta math (gap === 1 assertion at line 159-160) is broken under every-2-days cadence. Most 1-day-incremental columns are blank for W21+. Fix: gap-aware delta (divide by actual gap days) or drop the 1-day file. Fold into 10-04."
  - "09-04 #6 (NEW from green-week observation, Phase 10): Job C Sun off-by-one (project_job_c_sunday_off_by_one) fired in the wild Sun 2026-05-24 22:00 (id=438 cohortId=2026-W20 instead of W21). Did NOT block W21 cohort-create (Booli listings were freshness-refreshed by prior Job D fires). Still cosmetically wrong + structurally undersizes per-week discovery. Fold into 10-02."
  - "09-1.5 #1 (CLOSED by Plan 10-02 (f), 2026-05-26): 180-min JOB_BUDGET_MS for Booli fetch cohort would not fit at conc 2. Resolved by raising concurrency 2→8 (not by bumping the budget) — mirrors the conc-8 idiom in three sibling scrape jobs. Budget unchanged; expect Sun wall-clock to drop ~4× to ~45 min. First production verifier: Sun 2026-06-01 22:00 UTC fire."
  - "09-01 #3 (cosmetic, Phase 10): Final-JSON status field vs cron-wrapper status field mismatch. Fold into 10-04."
  - "09-02 #1 (CLOSED by green-week observation): Wet-run-skip risk played out cleanly. First production fire of */2 cadence on 2026-05-21 succeeded; subsequent fires (2026-05-23, 2026-05-25) had only the known SIGHUP-orphan + cosmetic warnings. Residual risk effectively absorbed."
  - "09-02 #2: Job A retrofit shipped — symmetric to Job D. Healthy in observation week (id=430, id=447). NO-OP."
  - "09-03 #1: D-17 parallel 14:00 cron grid CLOSED."
  - "project_todo_cleanup_claude_outputs (NEW, Phase 10 10-04 candidate): Sweep one-off scripts (scripts/check-w21.js, scripts/w20-overview.js, scripts/enrich-booli-week.js, scripts/unstick-cron-row-418.js, scripts/delete-w20-cohort.js, scripts/fix-booli-urls.js, scripts/inspect-*.js, scripts/diagnose-verf-b2.md, scripts/oxylabs-plan-shortlist.md, scripts/probe-*.js where superseded), verf09-2-5-logs/ + verf09-2-logs/ output dirs, and spike HTMLs out of the working tree. Decision matrix: keep general-purpose probes (probe-oxylabs-booli.js validated by 09-1.5 wet-run), delete spent one-offs. Per project_probe_oxylabs_booli_empirically_validated memory: skip probe-oxylabs-booli.js as re-run gate unless creds/code/site changed."
recent_commits:
  - "TBD (this commit) docs(09-04): Phase 9 cutover-complete — GREEN-WEEK observation log filled + ROADMAP marked + STATE rolled to v2.0 SHIPPED"
  - "d15c37b feat(export): --include-latest flag on views-wide + hb-ratio-xlsx"
  - "dd274d0 docs(state): fix weekday label — Thu 2026-05-21 (was Tue)"
  - "a47f10d docs(09-04): STATE + ROADMAP bookkeeping for code-complete + green-week gate"
  - "514d69b docs(09-04): Plan 09-04 code-complete — SUMMARY + green-week observation stub"
  - "198344c docs(09-04): replace runbook stub with full runbook + green-week gate + rollback"
  - "1460857 feat(09-04): halve cohort-track drop-streak threshold 10 -> 5 per D-11"
  - "367ee3b docs(09-03): Plan 09-03 complete — every-2-days crontab live + Slack verified"
deadlines:
  - "(SATISFIED 2026-05-25 03:00 UTC) Plan 09-2.6 verification gate: Hemnet match cohort id=439 status=warning, booliCount=2824 ≥ 1500 ✅, workerErrors=0 ✅, budgetExceeded=false ✅, duration 56.5 min < 90 min ✅."
  - "(SATISFIED 2026-05-25 06:00 UTC) Plan 09-04 green-week gate: cohort-create W21 id=440 status=success, 1,303 day-0 pairs (operator-judgment override on strict ±5% threshold per .planning/.../09-04-GREEN-WEEK.md)."
  - "(SATISFIED 2026-05-26) Phase 9 close: ROADMAP marked Complete, STATE rolled to v2.0 SHIPPED, Phase 9 close-state filed in carry-forwards above for Phase 10 planning."
---
