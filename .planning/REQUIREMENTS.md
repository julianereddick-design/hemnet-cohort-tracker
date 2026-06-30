# Requirements — Milestone v5.0: Hemnet Ad-Pricing — Resume Scrape + Weekly Reporting

**Defined:** 2026-06-30
**Scope:** Resume the dormant Hemnet advertising-package price scrape (`AdCostV2`, weekly task disabled since 2026-03-16) on the price-scraper droplet `170.64.181.89`, and build a weekly Slack + Chart.js + Excel reporting suite **in this cohort-tracker repo** mirroring the sold-match suite. Spans two systems: the scrape lives in `github.com/tt7676/hem-bol-scrapers` (operator-owned droplet); the reporting is new Node scripts here.

**Approach:** feasibility-test first (the GraphQL ad-cost path is un-rerouted and untested post-May-2026 blocking) → resume scrape → build reports → wire weekly cron. Absolute kronor (not take-rate %). Reuse `cron-wrapper.runJob` + Slack + chart + xlsx infra.

> Prior milestone (v4.0 price-scraper droplet audit/right-size) requirements are preserved in git history and traced in PROJECT history.

---

## v5.0 Requirements

### Ad-cost scrape feasibility (FEAS)
- [x] **FEAS-01**: A cheap, operator-approved test crawl confirms whether the Hemnet ad-cost GraphQL POST path (`search_ad_cost_2`) still works directly post-May-2026-blocking, or is blocked. — **Answered 2026-06-30 (26-01): BLOCKED.** Direct POST returns HTTP 403 Cloudflare from the droplet IP; see `.planning/phases/26-ad-cost-scrape-feasibility/26-DIRECT-TEST-RESULT.md`.
- [ ] **FEAS-02**: A working ad-cost fetch path is established — kept direct if it still works, else rerouted through Oxylabs (mirroring P23) — producing fresh `AdCostV2` rows.
- [ ] **FEAS-03**: The recurring scrape cost (direct ≈ free vs Oxylabs ≈ small per run) is quantified and surfaced to the operator before any recurring scraping is enabled (recurring-cost decision is the operator's).

### Resume weekly scrape (SCRAPE)
- [ ] **SCRAPE-01**: The dormant weekly "Scrape hemnet.se ad cost" `PeriodicTask` (cron `0 6 * * 1`, Australia/Sydney) is re-enabled on the price-scraper droplet so the crawl runs on its weekly cadence.
- [ ] **SCRAPE-02**: A first resumed crawl is verified — fresh rows land in `AdCostV2` with current `crawled` dates across the expected ~10 municipalities and ad tiers; the ~3.5-month gap (Mar 16 → resume) is left as a visible forward hole (not backfilled — ad prices are current-only).

### Weekly reporting suite (REPORT) — in this repo
- [ ] **REPORT-01**: A weekly Slack summary reports average `ad_price` by tier, week-over-week change, and a per-municipality breakdown, in **absolute kronor** (not take-rate %), posted to the sold-match review channel `C0B9X2WDC4C`.
- [ ] **REPORT-02**: A committed Chart.js trend HTML visualizes ad-price history over time with per-tier series (mirrors `sold-match-trend-chart.js`, committed-HTML-from-DB pattern).
- [ ] **REPORT-03**: An ExcelJS workbook provides an auditable per-week ad-price export with clickable full URLs (mirrors `sold-match-xlsx.js`).

### Scheduling (SCHED)
- [ ] **SCHED-01**: The reporting suite runs on a weekly cron via `cron-wrapper.runJob` in this repo (scrape Mon AM → report Mon later), mirroring the sold-match cron wiring; the run is DB-only (no Oxylabs cost on the report side).

---

## Future Requirements (deferred)
- **Take-rate / % view** — explicitly declined for v5.0 (absolute kronor only); revisit if the absolute series proves insufficient.
- **Backfilling the Mar 16 → resume gap** — not possible (ad prices are current-only); the hole stays.
- **Booli / listings scrape resume** on the price box — out of this milestone (leave those beat tasks disabled per v4.0).

## Out of Scope (v5.0)
- **Reporting as a Django celery task on the price box** — rejected; report home is Node scripts in this repo (locked 2026-06-30).
- **Dedicated ad-pricing Slack channel** — operator chose to reuse `C0B9X2WDC4C` at kickoff.
- **Non-Hemnet scrapers** (block_inc/procore/spotify) — stay killed per v4.0; not touched.
- **Managed-Postgres `simple_history` ~49 GB retention/cleanup + dedicated rotatable Oxylabs sub-user** — deferred v4.0 follow-through, its own future phase.

## Traceability

| REQ | Phase |
|-----|-------|
| FEAS-01 | Phase 26 |
| FEAS-02 | Phase 26 |
| FEAS-03 | Phase 26 |
| SCRAPE-01 | Phase 27 |
| SCRAPE-02 | Phase 27 |
| REPORT-01 | Phase 28 |
| REPORT-02 | Phase 28 |
| REPORT-03 | Phase 28 |
| SCHED-01 | Phase 29 |

**Coverage:** 9/9 v1 requirements mapped — no orphans, no duplicates.

| Phase | Requirements | Depends on |
|-------|--------------|------------|
| 26. Ad-cost scrape feasibility (gates milestone) | FEAS-01, FEAS-02, FEAS-03 | — (first phase) |
| 27. Resume weekly scrape | SCRAPE-01, SCRAPE-02 | Phase 26 |
| 28. Weekly reporting suite | REPORT-01, REPORT-02, REPORT-03 | Phase 27 |
| 29. Weekly scheduling | SCHED-01 | Phase 28 |
