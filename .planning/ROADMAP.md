# Roadmap: Hemnet Cohort Tracker

## Milestones

- ✅ **v1.0 Cohort tracker MVP** — Phases 1–5 (shipped, in production on Droplet)
- ✅ **v2.0 Self-hosted scraper** — Phases 6–9 (shipped 2026-05-26; cutover-complete tag `phase-9-cutover-complete`)
- 🚧 **v2.1 Self-hosted scraper hardening** — Phase 10 (cleanup of observation-week carry-forwards; production-stable, no launch deadlines)

## Phases

<details>
<summary>✅ v1.0 Cohort tracker MVP (Phases 1–5) — SHIPPED</summary>

### Phase 1: Cohort schema simplification
**Goal**: Cohort tables use a 4-column INSERT pattern; redundant fields removed.
**Plans**: 2 plans

Plans:
- [x] 01-01: Migrate `cohort_daily_views` schema + update `cohort-setup.js`
- [x] 01-02: Simplify `cohort-create.js` Day-0 INSERT and `cohort-track.js` to 4-column INSERT

### Phase 2: Incremental reporting
**Goal**: Aggregate incremental report with data-quality flags; CSV export aligned.
**Plans**: 2 plans

Plans:
- [x] 02-01: Add aggregate incremental report with DQ flags
- [x] 02-02: Update CSV export for simplified schema

### Phase 3: Data freshness + deploy hygiene
**Goal**: Daily freshness check; obsolete scripts removed; deploy instructions documented.
**Plans**: 1 plan

Plans:
- [x] 03-01: Add freshness check + deploy-instructions.md + cleanup

### Phase 4: Streak-based dropped-listing recovery
**Goal**: Listings that recover from a "dropped" state are reactivated; data repair shipped.
**Plans**: 1 plan

Plans:
- [x] 04-01: Schema migration for streak columns + data repair script

### Phase 5: Drop logic + Pool & Flow reporting
**Goal**: Streak-based drop logic in `cohort-track.js`; weekly Pool & Flow Slack report + dashboard live.
**Plans**: 1 plan

Plans:
- [x] 05-01: Implement streak-based drop logic and recovery; Pool & Flow report stack

</details>

### 🚧 v2.0 Self-hosted scraper (In Progress)

**Milestone Goal:** Replace the external scraping process (which populates `booli_listing` and `hemnet_listingv2`) with in-repo jobs that own the source tables end-to-end, so the cohort tracker no longer depends on a black-box upstream feed.

#### Phase 6: Hemnet fetcher foundation
**Goal**: A reusable `lib/hemnet-fetch.js` that bypasses Cloudflare, parses Hemnet's `__NEXT_DATA__`, and extracts `ActivePropertyListing` / `ListingCard` payloads.
**Depends on**: Nothing upstream (cohort schema is stable since Phase 1)
**Success Criteria**:
  1. `lib/hemnet-fetch.js` returns parsed listing objects for a known good Hemnet detail URL
  2. `scripts/probe-hemnet-fetch.js` (VERF-01) exits 0 against live Hemnet
  3. Cloudflare 403s recover via curl + retry
**Plans**: 1 plan

Plans:
- [x] 06-01: `lib/hemnet-fetch.js` + `lib/hemnet-locations.js` + VERF-01 probe (curl Cloudflare bypass)

#### Phase 7: Hemnet daily refresh (Job A) + Oxylabs fallback
**Goal**: `hemnet-targeted-refresh.js` refreshes `times_viewed`/`is_active` for every active cohort `hemnet_id` (last 12 weeks) within a single 33–51 min cron window; transient Hemnet 403/5xx fail over to Oxylabs Web Scraper API.
**Depends on**: Phase 6
**Success Criteria**:
  1. Job A processes the full active set without timing out under the 120s statement timeout + cron-wrapper retry
  2. Persistent 403/5xx triggers Oxylabs fallback, and stats appear in the run summary
  3. VERF-03 snapshot helper shows no data regressions vs the external scraper
**Plans**: 2 plans

Plans:
- [x] 07-01: `hemnet-targeted-refresh.js` Job A daily refresh script + VERF-03 helper
- [x] 07.1: `lib/hemnet-fetch.js` Oxylabs fallback on persistent 403/5xx + summary stats + VERF-03 re-check

#### Phase 8: Hemnet weekly seeding (Job B) + Booli discovery (Job C)
**Goal**: Weekly Mon-pre-cohort-create seed of `hemnet_listingv2` from each new Booli FS row (Job B), and weekly Mon Booli search-walk discovery of FS listings to UPSERT into `booli_listing` (Job C). After Phase 8, both source tables can be populated end-to-end by this repo.
**Depends on**: Phase 7
**Success Criteria**:
  1. Job B (`hemnet-targeted-match.js`) inserts ≥ baseline match count for the upcoming cohort week (VERF-05 baseline)
  2. Job C (`booli-targeted-discovery.js`) UPSERTs the full week's FS listings across the 4 cohort counties (VERF-B1/B2 baseline)
  3. Postcode validation rejects mismatched UPSERTs (08-03 INSERT NOT-NULL fix)
  4. Shared `lib/scrape-http.js` provides HTTP/Oxylabs core; `lib/booli-fetch.js` provides Booli parsers
**Plans**: 4 plans (5 commit-groups, consolidated)

Plans:
- [x] 08-01: `hemnet-targeted-match.js` Job B weekly seeding + smoke test + VERF-04 helper
- [x] 08-03: Hemnet INSERT NOT-NULL gap fix + VERF-04/05 pass-with-override (42.4% match rate, accepted)
- [x] 08-05: `booli-targeted-discovery.js` Job C + `lib/booli-fetch.js` + VERF-B1/B2 pass-with-override
- [x] 8.5: `lib/scrape-http.js` extraction + lib genitive fix + observability deltas + helper-script move

**Known carry-forward**: VERF-05 Hemnet match rate 42.4% (warning override accepted). VERF-B2 wet-run terminated `EXIT=1` mid-run on Booli `/annons/` 403s (carries into Phase 9).

#### Phase 9: Production cutover — self-hosted scraper launch
**Goal**: Own both view streams (Booli + Hemnet) end-to-end on an every-2-days cadence (Job D + Job A + cohort-track on odd days, plus weekly Job C + Job B + cohort-create), then run the cohort pipeline to green for one full week-cycle on self-hosted data alone (both external scrapers already off).
**Depends on**: Phase 8
**Requirements**: TBD (no REQUIREMENTS.md yet)
**Success Criteria**:
  1. Booli discovery (Job C) completes a full weekly run end-to-end without `EXIT=1` — the VERF-B2 mid-run failure on `/annons/` 403s is resolved
  2. All four jobs (A, B, C, D) run under `cron-wrapper.runJob` with `cron_job_log` rows, Slack alerts on failure/warning, and stable exit codes
  3. Droplet crontab schedules the every-2-days view-refresh cycle (14:00 Job D / 18:00 Job A / 22:00 cohort-track UTC on odd days), preserves the existing Job C Sun 22:00 UTC + Job B Mon 03:00 UTC + cohort-create Mon 06:00 UTC + sfpl-region-snapshot daily 08:00 UTC slots, and REMOVES the prior cohort-track 23:30 UTC + 02:00 UTC daily slots
  4. The cohort pipeline runs to green for one full week-cycle on self-hosted data alone (Jobs A+B+C+D + cohort-create + cohort-track)
  5. A short runbook in `deploy-instructions.md` (or sibling) covers: how to detect, diagnose, and re-run each job after a failure
**Plans**: 5 plans (Booli hardening / Oxylabs+county-loop triage / Job D / cron integration with every-2-days cadence / cutover + runbook)

Plans:
- [x] 09-01-PLAN.md — Booli discovery hardening: catch worker-level rejections, add 35-min wall-clock budget, resolve VERF-B2 EXIT=1
- [x] 09-1.5-PLAN.md — Oxylabs detail-page fallback + multi-county walk triage: D-13 confirmed (paid creds alone fixed both); JOB_BUDGET_MS 35→180 min; 8-week cohort window alignment shipped alongside
- [~] 09-02-PLAN.md — Job D booli-targeted-refresh + Job A retrofit + probes: code-complete (4/5 tasks shipped); Task 5 wet-run gate explicitly SKIPPED at operator direction — see 09-02-SUMMARY.md
- [~] 09-2.5-PLAN.md — Booli field capture + Job B narrowed-search matching fix: triggered by Django scraper decommission (2026-05-15) + 26.7% aggregate match rate; field capture (price/rooms/living_area/object_type/agent_id) shipped in commit 618c896; Job B rewrite pending; hard deadline Mon 2026-05-18 06:00 UTC for cohort-create
- [ ] 09-2.6-PLAN.md — Hemnet match cohort acceleration + W20 recovery: triggered by 2026-05-18 wet cron failure (Hemnet match cohort still running 5+ hours in, only ~700 of 5,563 rows processed, W20 cohort built at 441 pairs vs ~1,500 typical). Ships conc 2→8 + delta filter + JOB_BUDGET_MS = 120 min. Targets ~50 min weekly runtime + W20 cohort_pairs recovery to ~1,500.
- [x] 09-03-PLAN.md — Cron integration with every-2-days cadence: Jobs A/B/C/D + cohort-track on odd days (14:00 parallel D+A per D-17, 22:00 cohort-track UTC), remove daily cohort-track slots, SLACK_WEBHOOK_URL — deployed 2026-05-21; first production fire 2026-05-21 14:00 UTC
- [x] 09-04-PLAN.md — Cutover + runbook: halve cohort-track streak threshold 10→5 for every-2-days cadence (cohort-track.js:123 + :180), green-week observation, no parallel-run — code-complete 2026-05-21 (Tasks 1+2 shipped: 1460857 streak halve, 198344c runbook); green-week gate cleared 2026-05-26 (W21=1,303 day-0 pairs, all 4 cron-status checks PASS, Check 4 PASS via operator-judgment per .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-GREEN-WEEK.md — strict ±5% threshold mooted by W17/W18 broken-cohort noise in prior-4 window)

**Out of scope for Phase 9**: Investigating the 42.4% Hemnet match rate from VERF-05 (deferred — accepted with warning override). If the cutover surfaces this as a launch blocker, file a follow-up phase. Updating downstream reports for every-2-days `cohort_daily_views` granularity (deferred to Phase 10 per CONTEXT [[downstream-reports-deferred]]). The `Final:`-JSON-`status:success` vs cron-wrapper-`status:warning` cosmetic mismatch (09-01-SUMMARY carry-forward issue #3) is also deferred to Phase 10.

### 🚧 v2.1 Self-hosted scraper hardening (In Progress)

**Milestone Goal:** Absorb the Phase 9 + observation-week carry-forwards into a stable, low-noise production posture. No launch deadline — production is stable on the v2.0 every-2-days cadence; this milestone reduces operational noise (Slack alert fatigue, orphan cron rows, stale validate-thresholds) and closes small consistency gaps.

#### Phase 10: Self-hosted scraper hardening
**Goal**: cron-wrapper survives operator-kill cleanly; validate() warnings only fire on real anomalies; one-off scripts archived; export tooling adapted to every-2-days cadence.
**Depends on**: Phase 9 (cutover-complete tag `phase-9-cutover-complete`)
**Requirements**: derived from STATE carry-forwards (see `.planning/STATE.md` → carry_forward)
**Success Criteria**:
  1. Operator-killed crons no longer leave `status=running` orphans in `cron_job_log` — SIGHUP/SIGTERM/SIGINT handlers resolve the row to `status=killed` with a meaningful `error_message`
  2. The three cosmetic validate() warnings firing every cycle (Job B match-rate 40-55%, Job C/D 100% Oxylabs fallback) are either retargeted (warn on real anomalies only) or demoted to reporting fields — Slack channel goes quiet on cosmetic noise
  3. cohort-track null-Booli warning is age-bounded or delta-based (not a flat >50% threshold that fires forever on old cohorts)
  4. Job C Sunday cron resolves to the current week (W-1), not W-2
  5. `agent_id` FK constraint no longer drops ~9% of Job C/D writes — resolved via one of the three options in carry-forward 09-2.5 #6
  6. `export-views-wide.js` and any other consumers of 1-day deltas work correctly under the every-2-days cadence
  7. scripts/ directory cleaned of spent one-offs; verf09-2-5-logs/ + verf09-2-logs/ archived or removed; .planning/codebase/ intel files refreshed
**Plans**: 4 plans (proposed; refine when planning each)

Plans:
- [x] 10-01: cron-wrapper signal handlers + general unsticker — shipped 2026-05-26. `cron-wrapper.js` now resolves orphan rows to `status='killed'` on SIGHUP/SIGTERM/SIGINT via a fresh recovery client (avoids in-flight-query collision on main client). `scripts/unstick-cron-row.js` general-purpose unsticker (--id, --all-orphans, --list, --reason). Cleaned 8 known orphans (memory tracked only 4 — discovered 4 more older ones from 2026-05-12 to 2026-05-15). Closes 09-2.6 #1 + 09-03 #5. See `.planning/phases/10-self-hosted-scraper-hardening/10-01-SUMMARY.md`.
- [x] 10-02: cosmetic-warning retargets + small consistency fixes — COMPLETE 2026-05-26 (9 of 9 sub-items shipped). (a/b) removed `oxylabsFallbackRate > 0.30` warning from Jobs A/C/D — rate now a reporting field, not an alert; (c) lowered Job B match-rate threshold 50%→30% (in-range 40-55% no longer alerts); (d) fixed Job C `defaultWeekDate()` Sun off-by-one (Sun now returns this-week's Mon, not last-week's); (e) stopped writing `agent_id` from Booli fetch cohort + Booli view data — SQL passes literal null, existing Django values preserved via COALESCE, FK violation eliminated; (f) raised Booli fetch cohort concurrency 2→8 (Plan 09-01 hardening lock relaxed; expect Sun wall-clock to drop ~4× from ~3h to ~45 min, no more `budgetExceeded`); (g) COALESCE-preserve Hemnet view data discovery metadata (mirrors Booli view data D-24 symmetry); (h) Hemnet match cohort log canonical `booli.url` instead of constructed wrong `/bostad/${id}`; (i) `CREATE INDEX CONCURRENTLY hemnet_listingv2_norm_street_idx ON hemnet_listingv2 (LOWER(TRIM(street_address)))` + re-enable fuller delta filter in Hemnet match cohort SELECT — EXPLAIN ANALYZE 932ms vs 104s pre-index = 110× speedup, +9% scope catches previously-skipped Booli rows. Stretch item deferred to a future plan: 09-2.5 #7 postcode-mismatch loosening (could lift Job B writes 41→55%).
- [ ] 10-03-PLAN.md — cohort-track null-Booli threshold retarget: dedicated plan because the right fix needs thought. Three options: (a) age-bounded (warn only cohorts ≤ N weeks old), (b) week-over-week delta threshold, (c) demote from warning to reporting field. Closes 09-04 #4 (new green-week finding) + supersedes the closed-but-stale 09-03 #4 hypothesis.
- [ ] 10-04-PLAN.md — export tooling + scripts cleanup + intel refresh: (a) fix `export-views-wide.js` 1-day delta math under every-2-days cadence (09-04 #5); (b) sweep one-off scripts + spike outputs per `project_todo_cleanup_claude_outputs` decision matrix; (c) refresh `.planning/codebase/` intel files (CONCERNS/STACK/INTEGRATIONS) to reflect actual Slack/Droplet state per 09-03 #2; (d) fix Final-JSON-status vs cron-wrapper-status cosmetic mismatch (09-01 #3); (e) one-line fix to `scripts/enrich-booli-week.js` (missing `crawled = NOW(),` — 09-2.5 #10).

**Out of scope for Phase 10**: anything that materially changes the cohort pipeline behavior (cutover is stable, leave it alone). The 42.4% VERF-05 Hemnet match rate (already accepted with override) stays out unless 10-02 (h)/(i) raise it as a side effect.

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 7.1 → 8 → 9 → 10

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Cohort schema simplification | v1.0 | 2/2 | Complete | 2025–early shipped |
| 2. Incremental reporting | v1.0 | 2/2 | Complete | 2025 |
| 3. Data freshness + deploy hygiene | v1.0 | 1/1 | Complete | 2025 |
| 4. Streak-based dropped-listing recovery | v1.0 | 1/1 | Complete | 2025 |
| 5. Drop logic + Pool & Flow reporting | v1.0 | 1/1 | Complete | 2025 |
| 6. Hemnet fetcher foundation | v2.0 | 1/1 | Complete | 2026-03 |
| 7. Hemnet daily refresh (Job A) + Oxylabs fallback | v2.0 | 2/2 | Complete | 2026-04 |
| 8. Hemnet weekly seeding + Booli discovery | v2.0 | 4/4 | Complete (with overrides) | 2026-05-12 |
| 9. Production cutover — self-hosted scraper launch | v2.0 | 5/5 | Complete (cutover-complete) | 2026-05-26 |
| 10. Self-hosted scraper hardening | v2.1 | 1/4 | In Progress | - |

---

*Backfilled from commit history on 2026-05-14. Phases 1–5 collapsed to summary; Phases 6–8 reconstructed from commit subjects. No PLAN.md files exist in `.planning/phases/` for backfilled phases — only the implementations + verf logs remain. Future phases (9+) follow the full GSD workflow.*
