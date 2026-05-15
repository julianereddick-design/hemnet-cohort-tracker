---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Self-hosted scraper
status: Plan 09-2.5 code-complete (7/9 tasks shipped); Tasks 8 (deploy) + 9 (Sun/Mon cron verification) are operator-action; Plan 09-02 closed out as partial (wet-run skipped)
last_updated: "2026-05-15T10:50:00.000Z"
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
  - "09-2.5 #5 (NEW, 2026-05-15 dry-run finding): Local Job B --dry-run --limit 200 --week 2026-05-11 against W20 surfaced that today's W20 booli_listing rows are mostly UNENRICHED (rooms/object_type NULL, sometimes price too) — because the field-capture code shipped 2026-05-15 (618c896) with no Job C/D run since. First 34 rows showed filters=[] (11) or filters=[price] (17) — ZERO rows used the intended [price,rooms,item_type] narrowing. Implication: even Mon 2026-05-18 03:00 UTC Job B wet cron will run mostly on unenriched rows, since Sun's Job C only re-touches rows still active on Booli's search feed (W20 listings already off-feed won't be enriched). W21 match rate is therefore a LOWER BOUND on the rewrite's true effect. W22 cohort (after Tue/Thu/Sat Job D refresh cycles touch the full active inventory + after another Sun Job C pass) is the truer first measurement. Resolved 2026-05-15 evening by running scripts/enrich-booli-week.js --week 2026-05-11 (one-off probe; 2045 rows updated of 2368 candidates before 30-min budget; Job B dry-run then re-run with full discriminator firing)."
  - "09-2.5 #7 (NEW, 2026-05-16 verification observation — DEFERRED): Spot-checking the 27 postcode-mismatch rows in verf09-2-5-logs/dry-run-w20-n200-report.md showed many of them appear to be the SAME PROPERTY on Booli vs Hemnet despite the postcode mismatch (e.g., same street + same building, but Booli reports postcode A and Hemnet reports postcode B for the same address). Implication: the postcode-mismatch gate may be over-rejecting valid matches due to upstream postcode-data drift between Booli and Hemnet. Operator decision (2026-05-16): IGNORE for now — accept the conservative loss; the headline match rate is already strong. Phase 10 follow-up: investigate whether (a) loosen the postcode comparison (prefix-only? ±1?), (b) stop using postcode as a hard reject and instead use it as a signal among others, or (c) data-clean upstream. Track: 27/200 = 13.5% of W20 dry-run rows hit this; net writes would lift from 41% to ~55% if all postcode-mismatches were genuinely the same property."
  - "09-2.5 #8 (NEW, 2026-05-16 noise-reduction follow-up — DEFERRED): Job B's match log line at hemnet-targeted-match.js:486 constructs the Booli URL as 'https://www.booli.se/bostad/${booli_id}' — wrong for two reasons: (a) /bostad/ takes residenceId not listingId, (b) active FS listings use /annons/ not /bostad/. The correct URL is stored in booli_listing.url (already fetched in the SELECT). Same wrong-url pattern likely exists in Job C/Job D logs. Fix: log booli.url instead of constructing. Cosmetic — only affects log readability; doesn't change matching behavior. Phase 10 cleanup."
  - "09-2.5 #6 (NEW, 2026-05-15 enrichment finding — DEPLOY BLOCKER): The 2026-05-15 enrichment surfaced 139 worker errors (~9% of 1531 fetched), ALL the same FK constraint violation: 'booli_listing_agent_id_9a6480c3_fk_booli_agent_id'. The Booli Source.id we capture as agent_id (D-22 broker chain id) is not a value that exists in booli_agent — Django populated booli_agent with different values historically. Job C's INSERT (booli-targeted-discovery.js:316/320/352) and Job D's UPDATE both write agent_id and will throw this FK error in production. cron-wrapper's per-row try/catch swallows it (workerErrors++) and validate() escalates to Slack as 'warning' status. Sun 22:00 UTC Job C and Tue 14:00 UTC Job D will leak ~9% workerErrors and trigger Slack alerts. THREE FIX OPTIONS: (a) ALTER TABLE booli_listing DROP/relax the agent_id FK constraint, (b) drop agent_id from Job C/D writes (revert D-22 capture), (c) two-phase write: INSERT into booli_agent first then UPDATE booli_listing. Pre-deploy decision required."
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
