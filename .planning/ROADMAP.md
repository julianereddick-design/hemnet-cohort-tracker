# Roadmap: Hemnet Cohort Tracker

## Milestones

- ✅ **v1.0 Cohort tracker MVP** — Phases 1–5 (shipped, in production on Droplet)
- 🚧 **v2.0 Self-hosted scraper** — Phases 6–9 (Phases 6–8 complete; Phase 9 = production cutover)

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
**Goal**: Cut over from the external scraping process to this repo's Job A / Job B / Job C as the canonical writers of `hemnet_listingv2` and `booli_listing`, with all three wrapped by `cron-wrapper.js`, scheduled on the Droplet, alerting to Slack, and observable enough to debug a failed run without local repro.
**Depends on**: Phase 8
**Requirements**: TBD (no REQUIREMENTS.md yet)
**Success Criteria**:
  1. Booli discovery (Job C) completes a full weekly run end-to-end without `EXIT=1` — the VERF-B2 mid-run failure on `/annons/` 403s is resolved
  2. All three jobs (A, B, C) run under `cron-wrapper.runJob` with `cron_job_log` rows, Slack alerts on failure/warning, and stable exit codes
  3. Droplet crontab schedules Job A daily, Job B + Job C on the Mon-pre-cohort-create window, with no overlap against the existing `cohort-create.js`/`cohort-track.js`/`sfpl-region-snapshot.js` slots
  4. External scraping process is decommissioned (or quiesced) and the cohort pipeline runs to green for one full week-cycle on self-hosted data alone
  5. A short runbook in `deploy-instructions.md` (or sibling) covers: how to detect, diagnose, and re-run each job after a failure
**Plans**: 3 plans (Booli hardening / cron integration / cutover + runbook)

Plans:
- [ ] 09-01-PLAN.md — Booli discovery hardening: catch worker-level rejections, add 35-min wall-clock budget, resolve VERF-B2 EXIT=1
- [ ] 09-02-PLAN.md — Cron integration: install Droplet crontab for Jobs A/B/C, set SLACK_WEBHOOK_URL, verify with controlled-warning test
- [ ] 09-03-PLAN.md — Cutover: parallel-run observation week, GO/NO-GO checklist, quiesce external scraper, append runbook to deploy-instructions.md

**Out of scope for Phase 9**: Investigating the 42.4% Hemnet match rate from VERF-05 (deferred — accepted with warning override). If the cutover surfaces this as a launch blocker, file a follow-up phase.

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 7.1 → 8 → 9

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
| 9. Production cutover — self-hosted scraper launch | v2.0 | 0/3 | Not started | - |

---

*Backfilled from commit history on 2026-05-14. Phases 1–5 collapsed to summary; Phases 6–8 reconstructed from commit subjects. No PLAN.md files exist in `.planning/phases/` for backfilled phases — only the implementations + verf logs remain. Future phases (9+) follow the full GSD workflow.*
