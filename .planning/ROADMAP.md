# Roadmap: Hemnet Cohort Tracker

## Milestones

- ✅ **v1.0 Cohort tracker MVP** — Phases 1–5 (shipped, in production on Droplet)
- ✅ **v2.0 Self-hosted scraper** — Phases 6–9 (shipped 2026-05-26; cutover-complete tag `phase-9-cutover-complete`)
- 🚧 **v2.1 Self-hosted scraper hardening** — Phase 10 (cleanup of observation-week carry-forwards; production-stable, no launch deadlines)
- 🚧 **v2.2 Market supply pulse** — Phase 11 (new data product: daily nationwide listing totals; runs in parallel to v2.1)

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
  2. The three cosmetic validate() warnings firing every cycle (Job B match-rate 13-55%, Job C/D 100% Oxylabs fallback) are either retargeted (warn on real anomalies only) or demoted to reporting fields — Slack channel goes quiet on cosmetic noise
  3. cohort-track null-Booli warning is age-bounded or delta-based (not a flat >50% threshold that fires forever on old cohorts)
  4. Job C Sunday cron resolves to the current week (W-1), not W-2
  5. `agent_id` FK constraint no longer drops ~9% of Job C/D writes — resolved via one of the three options in carry-forward 09-2.5 #6
  6. `export-views-wide.js` and any other consumers of 1-day deltas work correctly under the every-2-days cadence
  7. scripts/ directory cleaned of spent one-offs; verf09-2-5-logs/ + verf09-2-logs/ archived or removed; .planning/codebase/ intel files refreshed
**Plans**: 5 plans (proposed; refine when planning each)

Plans:
- [x] 10-01: cron-wrapper signal handlers + general unsticker — shipped 2026-05-26. `cron-wrapper.js` now resolves orphan rows to `status='killed'` on SIGHUP/SIGTERM/SIGINT via a fresh recovery client (avoids in-flight-query collision on main client). `scripts/unstick-cron-row.js` general-purpose unsticker (--id, --all-orphans, --list, --reason). Cleaned 8 known orphans (memory tracked only 4 — discovered 4 more older ones from 2026-05-12 to 2026-05-15). Closes 09-2.6 #1 + 09-03 #5. See `.planning/phases/10-self-hosted-scraper-hardening/10-01-SUMMARY.md`.
- [x] 10-02: cosmetic-warning retargets + small consistency fixes — COMPLETE 2026-05-26 (9 of 9 sub-items shipped). (a/b) removed `oxylabsFallbackRate > 0.30` warning from Jobs A/C/D — rate now a reporting field, not an alert; (c) lowered Job B match-rate threshold 50%→30% (in-range 13-55% no longer alerts); (d) fixed Job C `defaultWeekDate()` Sun off-by-one (Sun now returns this-week's Mon, not last-week's); (e) stopped writing `agent_id` from Booli fetch cohort + Booli view data — SQL passes literal null, existing Django values preserved via COALESCE, FK violation eliminated; (f) raised Booli fetch cohort concurrency 2→8 (Plan 09-01 hardening lock relaxed; expect Sun wall-clock to drop ~4× from ~3h to ~45 min, no more `budgetExceeded`); (g) COALESCE-preserve Hemnet view data discovery metadata (mirrors Booli view data D-24 symmetry); (h) Hemnet match cohort log canonical `booli.url` instead of constructed wrong `/bostad/${id}`; (i) `CREATE INDEX CONCURRENTLY hemnet_listingv2_norm_street_idx ON hemnet_listingv2 (LOWER(TRIM(street_address)))` + re-enable fuller delta filter in Hemnet match cohort SELECT — EXPLAIN ANALYZE 932ms vs 104s pre-index = 110× speedup, +9% scope catches previously-skipped Booli rows. Stretch item deferred to a future plan: 09-2.5 #7 postcode-mismatch loosening (could lift Job B writes 41→55%).
- [x] 10-03: cohort-track null-Booli threshold retarget — shipped 2026-05-26. Hybrid (a)+(b): scope alerting to the most recent 4 cohorts AND cohortId ≥ `2026-W20` (rolling window + hard floor on the broken-scraper-period cohorts). Within scope, fire on either >50% absolute null rate OR >10pp jump vs the prior `cohort-track` run. `main()` now reads prior run's `result_summary.perCohortNull` from `cron_job_log` and bakes it into the resultSummary as `priorPerCohortNull`; `validateCohortTrack` stays sync. First run of a brand-new cohort (no prior entry) falls back to the 50% absolute check. 11/11 inline smoke tests pass (incl. real-world W14-W21 case → silent). Closes 09-04 #4 + supersedes the stale 09-03 #4 hypothesis.
- [ ] 10-04 — export tooling + scripts cleanup + intel refresh. **Detailed plan written 2026-05-26: `.planning/phases/10-self-hosted-scraper-hardening/10-04-PLAN.md`** (self-contained, with full keep/delete inventory). (a) fix `export-views-wide.js` 1-day delta under every-2-days cadence (09-04 #5 — the only functional item); (b) sweep one-off scripts + verf logs (incl. now-dead `migrate-booli-listing-drop-agent-fk.js`); (c) refresh `.planning/codebase/` intel Slack lines (09-03 #2); (d) Final-JSON vs cron-wrapper status mismatch (09-01 #3); (e) `enrich-booli-week.js` `crawled=NOW()` — or delete the script (09-2.5 #10).
- [ ] 10-05 — retire the old Pool & Flow droplet fan-out + Slack. The Monday 09:00 UTC crontab (per `deploy-instructions.md:13-81`) still runs four scripts from the pre-v2.0 Pool & Flow framework: `listing-gap-monitor.js` (writes `listing_gap_weekly`) + `flow-monitor.js` (writes `listing_flow_weekly`) → `pool-flow-report.js` (**direct Slack output** with Pool/Flow tables + dashboard link, `pool-flow-report.js:271-285`) + `generate-pool-flow-charts.js` (HTML dashboard at port 3800). All four were superseded by the cohort-based v2.0 pipeline + `weekly-view-report.js` (which **stays** — v2.0 cohort report). Sub-items: (a) remove the four crontab lines on the droplet (keep the `weekly-view-report.js` one); (b) delete the four .js files from the repo + `setup-chart-cron.sh`; (c) decide whether to drop `listing_gap_weekly` / `listing_flow_weekly` tables (only if no other consumer found in `git grep` at plan-writing time); (d) audit any dashboard URL references (`170.64.197.241:3800/pool-flow-dashboard.html`) and decide whether to retire the static-file server. **Lower-priority than 10-04** — these scripts are functional, just unwanted. No technical blocker, just operator-coordinated removal of a live cron channel.

**Out of scope for Phase 10**: anything that materially changes the cohort pipeline behavior (cutover is stable, leave it alone). The 42.4% VERF-05 Hemnet match rate (already accepted with override) stays out unless 10-02 (h)/(i) raise it as a side effect.

### 🚧 v2.2 Market supply pulse (In Progress)

**Milestone Goal:** Capture and surface daily nationwide properties-for-sale totals (Hemnet + Booli, Till salu + Kommande + historic sold) as a market-supply signal that complements the per-listing cohort view-data pipeline. Runs in parallel to v2.1 — fully orthogonal to scraper-hardening work.

**Background:** Probe on 2026-05-27 (`scripts/probe-total-listings.js`) confirmed both Hemnet and Booli expose nationwide listing totals via `__NEXT_DATA__` in a single top-level search-page fetch each. Cost is 2 Oxylabs requests/day total. See memories [[project-market-supply-pulse-feasibility]] and [[project-booli-hemnet-totals-asymmetry]] for endpoint paths and a same-minute cross-platform snapshot showing Booli's Kommande pool is ~5× Hemnet's.

#### Phase 11: Daily market-totals capture + minimal report
**Goal**: A new daily cron job captures Hemnet + Booli nationwide listing totals (Till salu, Kommande, historic sold) into a new `market_totals` table; a minimal report exposes the daily values + WoW deltas.
**Depends on**: Phase 9 (cron-wrapper.runJob infrastructure; Oxylabs creds; Slack alerting)
**Success Criteria**:
  1. `market_totals` table created with `(day, site, segment, total, fetched_at, source_url)` schema; PK on `(day, site, segment)` for idempotent reruns
  2. `market-totals-daily.js` runs daily under `cron-wrapper.runJob`; writes 4 rows/day (Hemnet × 2 segments + Booli × 2 segments) on success — Till salu + Kommande only; Sold dropped during discuss; warns to Slack on JSON-path-break or fetch failure
  3. A pre-flight smoke-probe verifies the `__NEXT_DATA__` JSON paths still resolve before each capture run (defends against silent Hemnet/Booli site breakage — both sites are Next.js and could rename Apollo keys without notice)
  4. At least one consumer surfaces the values — e.g. a tile in `weekly-view-report.js` with 7-day WoW deltas, or a daily Slack one-liner
  5. 7 consecutive days run green with no Slack alerts and no missing days in `market_totals`
**Plans**: 3 plans

Plans:
- [x] 11-01-PLAN.md — ROADMAP scope edits + `market-totals-daily.js` (inline DDL + 3-fetch + inline JSON-path smoke probe + 4-row upsert + sync validate) + crontab registry (08:30 UTC daily) + operator wet-run gate. CODE SHIPPED 2026-05-27; **wet-run GREEN 2026-05-27** (4 rows, status=success in 13.4s — hemnet 51209/6256, booli 60834/31615, all via Oxylabs fallback after expected direct-curl 403s; ratios match [[project-booli-hemnet-totals-asymmetry]]). Crontab LIVE 2026-05-28 (both lines confirmed via crontab -l; /var/log/hemnet present). Remaining: SC-5 7-day green soak only (running).
- [x] 11-02-PLAN.md — Offline regression test for the inline JSON-path probe (`scripts/test-market-totals-probe.js`) + operator diagnosis paragraph in `deploy-instructions.md` for the JSON-path-break Slack alert
- [x] 11-03-PLAN.md — Weekly Slack consumer (new file `market-totals-weekly-report.js`) + locked Till-salu WoW format + `?` missing-data semantics + crontab registry (Mon 09:35 UTC)

**Out of scope for Phase 11**: Per-municipality or per-county totals (the top-level pages only expose nationwide; per-area totals would require N×Oxylabs fan-out and belong in a future milestone). Long-horizon backfill — start fresh; historic sold totals are level-only, not deltas. Cross-platform reconciliation beyond raw deltas — see [[project-booli-hemnet-totals-asymmetry]] memory; that's an analyst-side framing question, not a pipeline concern. Sold totals — operator-deferred during Phase 11 discuss; JSON paths known but reserved for a future plan.

## Progress

**Execution Order:** Phases 1–10 executed in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 7.1 → 8 → 9 → 10. Phase 11 (v2.2) runs in parallel to Phase 10 (v2.1) — the two milestones are orthogonal.

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
| 10. Self-hosted scraper hardening | v2.1 | 3/5 | In Progress | - |
| 11. Daily market-totals capture + minimal report | v2.2 | 3/3 shipped | Live since 2026-05-28; 7-day soak running | - |

### Phase 12: Cohort match spot-check weekly QA gate

**Goal:** Turn the validated manual cohort match spot-check into a weekly automated quality gate that runs after `cohort-create` succeeds: sample each new cohort, adjudicate sampled Booli↔Hemnet pairs to a verdict (CONFIRMED MATCH / CONFIRMED MISMATCH / UNCERTAIN), compute the confirmed false-match rate with a Wilson CI by county, log to `cron_job_log`, and escalate via Slack on a high rate (>5%) or fetch failure. Orchestrates the already-built spot-check tools; the matcher fix (PRD §9) is deferred.
**Requirements**: derived from `.planning/phases/12-.../12-CONTEXT.md` decisions + COHORT-SPOTCHECK.md §7 success criteria (no REQUIREMENTS.md)
**Depends on:** Phase 11
**Plans:** 3 plans (Wave 1: pure adjudicate+summary libs · Wave 2: cron-wrapped orchestrator, Mode A · Wave 3: Mode B Claude-vision adjudicator)
**Progress:** 3/3 plans complete (Wave 1 + Wave 2 + Wave 3 done 2026-06-10)

Plans:
**Wave 1**
- [x] 12-01-PLAN.md — `lib/spotcheck-adjudicate.js` (mode-agnostic verdict logic) + `lib/spotcheck-summary.js` (Wilson CI + by-county + mismatch list + Slack/MD render); both pure, --smoke green (2026-06-10)

**Wave 2**
- [x] 12-02-PLAN.md — `cohort-spotcheck-gate.js` orchestrator under `cron-wrapper.runJob` (resolves latest cohort, drives cohort-spotcheck.js + spotcheck-photos.js as child processes, adjudicates Mode A, writes VERDICTS + SUMMARY, escalates via validate()) + crontab Mon 06:30 UTC + runbook entry (2026-06-10)

**Wave 3**
- [x] 12-03-PLAN.md — Mode B: `lib/spotcheck-vision.js` Claude-vision adjudicator (gated behind triage) + `@anthropic-ai/sdk` install + `ANTHROPIC_API_KEY` + `--mode-b` gate wiring with Mode A fallback (2026-06-10)

### Phase 13: Spot-check image confirmation and human review loop

**Goal:** Make the Phase 12 spot-check gate actually catch false matches by (a) adding a deterministic shared-image check (dHash) so pairs that share a photo are auto-confirmed for free, (b) running Claude vision on `suspect` pairs, (c) fixing the adjudication mismatch rule to require price/area divergence (a confirmed-mismatch must not fire on a price-agreeing pair), and (d) routing every remaining UNCERTAIN pair to Slack with both the Hemnet and Booli ad links so a human can adjudicate, then feeding that verdict back into the system — including correcting the cohort dataset when a false pair is confirmed. Also add a current-ISO-week guard so the gate never silently re-checks a stale cohort.

**Requirements**: derived from 13-CONTEXT.md decisions D-01..D-14 + COHORT-SPOTCHECK.md §3/§4/§7 (no REQUIREMENTS.md)
**Depends on:** Phase 12
**Plans:** 6/6 plans complete

Plans:
**Wave 1**
- [x] 13-01-PLAN.md — migration (spotcheck_review + spotcheck_removed_pairs) + lib/spotcheck-review-store.js (audited transactional hard-delete) [D-11, D-12] (2026-06-11)
- [x] 13-02-PLAN.md — lib/spotcheck-dhash.js (jimp shared-image cross-compare) + mismatch-rule price-guard fix in lib/spotcheck-adjudicate.js [D-02, D-03, D-04] (2026-06-11)
- [x] 13-03-PLAN.md — lib/spotcheck-slack-bot.js (bot-token post + reactions read) + SLACK-REVIEW-SETUP.md runbook [D-07, D-08, D-09] (2026-06-11)

**Wave 2**
- [x] 13-04-PLAN.md — extend cohort-spotcheck-gate.js: dHash step (≤6 auto-confirm + distance logging) + advisory vision logging + ISO-week guard + Slack review-queue post [D-01, D-02, D-05, D-06, D-07, D-13] (2026-06-11)
- [x] 13-05-PLAN.md — spotcheck-reaction-poller.js daily runJob: read reactions → ✅ audit+remove / ❌ keep / ❓ leave, authorization-gated + dedup [D-08, D-10, D-11, D-12] (2026-06-11)

**Wave 3**
- [x] 13-06-PLAN.md — go-live: migration + weekly gate + daily poller crons + env vars + operator runbook in deploy-instructions.md [D-14] (2026-06-11)

**Known carry-forward (2026-06-11 live test):** detection + Slack posting work; the actionable half is broken — ✅-removal blocked by the `cohort_daily_views` FK (and audit can't restore), and the UNCERTAIN digest shares one `ts` across all pairs so one reaction hits all of them. Interim operating rule: do NOT react on the digest; only ❌/❓ on individual MISMATCH messages are safe. Phases 13.1/13.2/14 below close these gaps.

**Execution order (operator decision 2026-06-11): Phase 14 FIRST, then 13.1, then 13.2.** Rationale: the live loop is useless while the verdicts behind it aren't trusted/understood — fix verdict quality before making reactions actionable. The interim operating rule stays in force across upcoming gate runs (incl. Mon 2026-06-15) until 13.1 ships.

### Phase 13.1: Spot-check review loop gap closure — make the live loop trustworthy

**Goal:** A human reaction in Slack does exactly what it says, per pair, reversibly. (a) Replace the broken hard-DELETE removal path with soft-delete: `removed_at`/`removed_reason`/`removed_by` columns on `cohort_pairs` via migration; "removal" = UPDATE, FK never involved, `cohort_daily_views` history preserved, recovery = nulling `removed_at`; all cohort reporting/tracking queries exclude `removed_at IS NOT NULL`. (b) Post every UNCERTAIN pair as its own individual Slack message (operator decision 2026-06-11 — individual messages, not threads), each with its own `ts`, so reactions are per-pair; retire the actionable digest. (c) Poller guard: ignore any `spotcheck_review` rows whose `ts` is shared by >1 pair (protects against the W23-era rows already in the table).

**Requirements:** `.planning/todos/pending/removal-hard-delete-fk-and-unrecoverable.md` + `.planning/todos/pending/uncertain-digest-no-per-pair-loop.md`
**Depends on:** Phase 14 (sequencing, not technical — verdict quality first per operator decision 2026-06-11; original Mon 2026-06-15 pre-gate target dropped, interim operating rule stands until this ships)
**Plans:** TBD (plan via gsd-plan-phase)

### Phase 13.2: Spot-check review-queue hygiene — only reviewable pairs reach a human

**Goal:** The eyeball queue contains only pairs a human can actually adjudicate, and nothing rots in it. (a) Classify each side's fetch outcome into delisted / transient-error / live-but-no-photos: delisted → own "listing delisted" bucket (summary line, not the review queue); transient-error → retry/roll-forward to next run, never silently dropped, persistent-failure count surfaced; live-but-no-photos → stays in adjudication, diverted only from image review. (b) Eyeball queue requires BOTH listings to exist (both galleries non-empty). (c) Stale-review aging alert: surface open review rows with no reaction after ~7 days in the poller's Slack output, excluding unanswerable (delisted) pairs.

**Requirements:** `.planning/todos/pending/classify-fetch-outcomes-delisted-vs-error.md` + `.planning/todos/pending/review-queue-require-both-listings-exist.md` + `.planning/todos/pending/stale-review-aging-alert.md`
**Depends on:** Phase 13.1 (the per-pair message volume from 13.1 is only sustainable once this filtering lands)
**Plans:** TBD

### Phase 14: Spot-check verdict quality — photos must correspond, not merely exist

**Goal:** Close the false-confirm paths in the adjudicator. (a) **Sizing probe first** (operator decision 2026-06-11): on a full recent cohort sample (N=200+ per standing preference), measure how many likely-match + price-agree pairs actually fail dHash, and price the implied Claude-vision calls in $ before committing to routing. (b) Branch 2 rework: `priceAgrees + likely-match` requires a real dHash shared-photo signal (dHash result becomes an input to `adjudicatePair`), not `hasPhotos`; price-agree-but-no-shared-photo routes onward (vision and/or human, sized by the probe) instead of silently confirming; high dHash distance on a price-confirmed pair raises a flag (dHash can challenge, not only upgrade). (c) dHash auto-confirm hardening, shipped WITH (b) since it makes dHash load-bearing: exclude non-discriminating images (floorplans/`planlösning`, nyproduktion renders) from the compare set, require ≥2 distinct shared photos, never auto-confirm at multi-unit addresses; same guards apply to vision sharedPhoto.

**Requirements:** `.planning/todos/pending/branch2-use-dhash-not-hasphotos.md` + `.planning/todos/pending/harden-dhash-autoconfirm-shared-stock-floorplan.md`
**Depends on:** Phase 13 (runs FIRST of the three follow-up phases per operator decision 2026-06-11). If the probe needs the delisted-vs-transient-error distinction to interpret `miss` pairs, pull that classification forward from 13.2 into the probe rather than blocking on it.
**Plans:** 4 plans (Wave 1: sizing/trust probe + operator routing gate · Wave 2: adjudicate Branch-2 rework ‖ vision floorplan guard · Wave 3: gate integration + deploy)

Plans:
**Wave 1**
- [ ] 14-01-PLAN.md — D-01 sizing/trust probe (scripts/probe-dhash-sizing.js) + dHash primitives (sharedPhotoPairs + filterDiscriminatingFiles); ends at the operator routing-decision gate [D-01, D-03, D-05]

**Wave 2**
- [ ] 14-02-PLAN.md — Branch 2 rework in lib/spotcheck-adjudicate.js: dHash as 3rd input, D-05 guards (≥2 distinct / floorplan-only / multi-unit), D-04 challenge flag [D-02, D-03, D-04, D-05]
- [ ] 14-03-PLAN.md — vision floorplan guard in lib/spotcheck-vision.js: filter non-discriminating images before payload + prompt warning [D-05]

**Wave 3**
- [ ] 14-04-PLAN.md — gate integration in cohort-spotcheck-gate.js: multi-unit query + sharedPhotoPairs dHash step + dhashResults into adjudicate + operator-chosen routing + D-04 logging + deploy [D-02, D-03, D-04, D-05]
