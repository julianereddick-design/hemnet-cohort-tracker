# Data Streams & Jobs — Operator Handover

**Project:** `hemnet-cohort-tracker` — a Node.js pipeline scraping Hemnet.se and Booli.se (Swedish
real-estate portals) via Oxylabs, to measure Hemnet's dominance vs Booli across listing views,
sold-market share, supply pool, and listing age.

**Scope of this doc:** every scraping / data-collection job and the data stream it belongs to —
what it collects, where from, how (method), what it writes, when it runs, and how to run it by hand.

---

## 0. Shared infrastructure (read this first)

### Scrape transport — `lib/scrape-http.js`
A single HTTP layer used by (almost) every scraper. It shells out to `curl --http1.1 --compressed`
first (Cloudflare bypass), then **transparently falls back to the Oxylabs Web Scraper API**
(`https://realtime.oxylabs.io/v1/queries`, `source: 'universal'`, `geo_location: 'Sweden'`,
Advanced plan ~$249/mo) on 403/429/5xx. Env `SCRAPE_FORCE_OXYLABS=1` (alias `HEMNET_FORCE_OXYLABS=1`)
skips direct curl and routes every call through Oxylabs.

- **Steady state:** Booli is **100% Oxylabs** (direct curl 403s every Booli URL from the droplet DC IP);
  Hemnet flipped to ~100% Oxylabs over 2026-05-08 → 05-21. Each Oxylabs call ≈ 5 sec.
- **Extraction:** both sites are Next.js/Apollo. Parsers read the `__NEXT_DATA__` `<script>` blob →
  `props.pageProps.__APOLLO_STATE__`. **Not** a live GraphQL endpoint, **not** SERP — it scrapes the
  SSR HTML. (Exceptions: the sold-match SERP bridge uses Oxylabs `google_search`; the ad-cost crawler
  POSTs to Hemnet's `/graphql` through a **Bright Data Web Unlocker** proxy, with no browser at all
  — see those streams.)
- Oxylabs call stats (`getOxylabsStats` / `resetOxylabsStats`) are module-level singletons shared
  across Hemnet + Booli callers.

### Cron wrapper — `cron-wrapper.js`
Exports `runJob({ scriptName, main, validate })`. Every scheduled job that uses it: connects to
Postgres, inserts a `cron_job_log` row (`status='running'`), runs `main`, runs `validate` (which
returns a warning string or null), updates the log row, and then decides whether to alert.

**Alerting is tier-gated** (rebuilt 2026-08-17 — earlier revisions of this file said it posts on
any `warning`/`failure`, which is no longer true). Only **tier-1** jobs post, and only on a
0h/+24h/+72h/daily re-notify ladder; tier-2 jobs post nothing and surface in the 03:00 digest.
Tiers are declared in `lib/job-registry.js`; the reasoning is in
**[`05-MONITORING-AND-ALERTS.md`](05-MONITORING-AND-ALERTS.md)**. `cron-setup.js` creates the
`cron_job_log` table; `migrate-alert-state.js` creates `alert_state` and `disk_sample`.

- **Cron invocation contract:** cron lines call the script **directly** (`node cohort-track.js`) —
  each script calls `runJob` at module load. `cron-wrapper.js` has no CLI entry.

### Where jobs run
- **Cohort-tracker droplet** (`/opt/hemnet-cohort-tracker/`, 170.64.197.241): runs the crontab below.
  Deploy = `git pull` on the droplet; cron picks up new code next run.
- **Price-scraper droplet** (`170.64.181.89`, separate box): **no longer runs anything for this
  project.** It used to run the ad-cost crawl on its own Django/Celery beat; that job was ported into
  this repo and cut over to the cohort-tracker droplet on **2026-08-18** (§f). Its beat row is
  disabled. The box stays alive only until the first unattended monthly run (1 Sept 2026) is
  verified, then it is destroyed — snapshot `241648610` is the rollback.
- Env vars live in `/opt/hemnet-cohort-tracker/.env` (gitignored). Full crontab + runbook:
  `deploy-instructions.md`.

### The live crontab (all times UTC)

> 🚨 **The crontab is GENERATED from `lib/job-registry.js` — never hand-edit it.** Change the
> registry, then `node scripts/render-crontab.js | crontab -`. `node scripts/render-crontab.js
> --check` (on the droplet) detects drift and also runs as a daily digest assertion. Backups:
> `/root/crontab-backup-*.txt`.
>
> The table below is a **reading aid for the core scrapers only and is not exhaustive** — it
> predates the registry and omits the retention jobs, `premarket-quality-measure`, the censuses,
> `ad-cost-crawler`, `adcost-report`, `cron-health-sweep` and `alerting-heartbeat` (28 job lines
> live). For the
> authoritative list run `crontab -l` on the droplet, or
> `node -e "console.log(Object.keys(require('./lib/job-registry').JOBS).length)"`.

| Time (UTC) | Job | Cadence |
|---|---|---|
| `0 22 * * 0` (Sun) | `booli-targeted-discovery.js` | weekly |
| `0 3 * * 1` (Mon) | `hemnet-targeted-match.js` | weekly |
| `0 6 * * 1` (Mon) | `cohort-create.js` | weekly |
| `30 6 * * 1` (Mon) | `cohort-spotcheck-gate.js` | weekly |
| `30 7 * * 1` (Mon) | `sold-match-batch.js` | weekly line, **fortnightly effect** (even ISO weeks) |
| `0 11 / 5 11 / 10 11 * * 1` (Mon) | `sold-match-report.js` / `sold-match-trend-chart.js` / `sold-match-xlsx.js` | weekly |
| `30 8 * * *` (daily) | `market-totals-daily.js` | daily |
| `50 8 * * 1` (Mon) | `scripts/premarket-flow-measure.js` | weekly |
| `35 9 * * 1` (Mon) | `market-totals-weekly-report.js` | weekly |
| `40 9 * * 1` (Mon) | `premarket-flow-weekly-report.js` | weekly |
| `30 9 * * 1` (Mon) | `weekly-view-report.js` | weekly |
| `0 14 */2 * *` | `booli-targeted-refresh.js` + `hemnet-targeted-refresh.js` (parallel) | every 2 days |
| `0 22 */2 * *` | `cohort-track.js` | every 2 days |
| `0 12 * * *` (daily) | `spotcheck-reaction-poller.js` | daily |
| `0 3 * * *` (daily) | `cron-health-slack.js` | daily |

---

## Summary table — all jobs

> **Which of these matter most?** Each job carries an explicit **tier** in
> `lib/job-registry.js`. Tier 1 means *perishable* — a missed run destroys an observation that
> can never be recovered — and those are the only jobs that interrupt you. Tier 2 means
> *recoverable*: re-run it and the numbers are the same. The per-job breakdown of exactly what
> is lost when each tier-1 job misses is in
> **[`05-MONITORING-AND-ALERTS.md`](05-MONITORING-AND-ALERTS.md) §3** — deliberately kept in one
> place rather than duplicated into this table, so the two cannot drift apart.

| Job (file) | Purpose | Source (site · method) | Schedule (UTC) | Output tables / artifacts |
|---|---|---|---|---|
| **Cohort view-tracking** |||||
| `booli-targeted-discovery.js` (Job C) | Weekly discovery of new Booli for-sale listings, 4 counties | Booli · Oxylabs · `__NEXT_DATA__`/Apollo | Sun 22:00 | `booli_listing` |
| `hemnet-targeted-match.js` (Job B) | Seed Hemnet listings matching new Booli rows | Hemnet · Oxylabs · Apollo | Mon 03:00 | `hemnet_listingv2` |
| `cohort-create.js` | Build weekly cohort of matched Booli↔Hemnet pairs (DB only) | none (DB) | Mon 06:00 | `cohorts`, `cohort_pairs`, `cohort_unmatched`, `cohort_daily_views` |
| `booli-targeted-refresh.js` (Job D) | Refresh view counts for paired Booli listings | Booli · Oxylabs · Apollo | every 2d 14:00 | `booli_listing` (UPDATE) |
| `hemnet-targeted-refresh.js` (Job A) | Refresh view counts for paired Hemnet listings | Hemnet · direct→Oxylabs · Apollo | every 2d 14:00 | `hemnet_listingv2` (UPDATE) |
| `cohort-track.js` | Append daily view time-series per pair; manage drops | none (DB) | every 2d 22:00 | `cohort_daily_views`, `cohort_pairs` (UPDATE) |
| ~~`sfpl-region-snapshot.js`~~ | RETIRED 2026-08-13 — unscheduled, no consumer | none (DB agg) | — | `sfpl_region_daily` (frozen) |
| ~~`sfpl-region-analysis.js`~~ | Console ratio report of the frozen snapshot | none (DB) | manual | console only |
| `weekly-view-report.js` | Orchestrate exports + Slack post | none (DB) | Mon 09:30 | Slack + child xlsx/HTML |
| `export-hb-ratio-xlsx.js` | Per-cohort H/B xlsx + charts | none (DB) | via weekly-view-report | `view-data/…/*.xlsx`, `charts.html` |
| `export-cross-cohort-chart.js` | Cross-cohort H%-of-views chart | none (reads xlsx) | via weekly-view-report | `view-data/…/cross-cohort-hpct.html` |
| `chart-hb-ratio.js` | On-demand H/B ratio chart + CSVs | none (DB) | manual | `view-data/…/hb-ratio-*.{html,csv}` |
| `export-views-wide.js` | Wide-format CSV dump of a cohort | none (DB) | manual | `view-data/…/*.csv` |
| **Sold-match (Hemnet market share)** |||||
| `sold-match-batch.js` | Fortnightly national sold-match pipeline (sample→match→recheck) | Booli `/slutpriser` + Hemnet `/salda` + SERP bridge · Oxylabs | Mon 07:30 (even wks) | `booli_sold`, `hemnet_sold`, `sold_match`, `sold_spend` |
| `sold-match-report.js` | Slack settled-rate summary | none (DB) | Mon 11:00 | Slack |
| `sold-match-trend-chart.js` | Committed HTML trend chart | none (DB) | Mon 11:05 | `view-data/…/sold-match/trend.html` |
| `sold-match-xlsx.js` | Per-cohort audit workbook | none (DB) | Mon 11:10 | `view-data/…/sold-match/*.xlsx` |
| `scripts/sold-match-run.js` | Manual end-to-end matcher (home of `matchOne`) | Booli+Hemnet+SERP · Oxylabs | manual | `booli_sold`, `hemnet_sold`, `sold_match` |
| `scripts/booli-sold.js` | Fetch Booli sold seeds → JSONL | Booli `/slutpriser` · Oxylabs | manual | JSONL only |
| `scripts/hemnet-sold.js` | Search Hemnet `/salda` per seed → JSONL | Hemnet `/salda` · Oxylabs | manual | JSONL only |
| `scripts/persist-sold.js` | Load JSONL → DB | none (local files) | manual | `booli_sold`, `hemnet_sold` |
| `scripts/sold-residue-recheck.js` | One-off recall-lift measurement | SERP bridge · Oxylabs | manual | JSON only |
| `scripts/export-sold-match.js` | xlsx+csv export by created_at | none (DB) | manual | `view-data/…/sold-match/*.{xlsx,csv}` |
| `scripts/run-sold-match-batch-now.js` | Odd-week manual catch-up of the batch | (delegates to batch) | manual | same as batch |
| **Market supply totals** |||||
| `market-totals-daily.js` | Daily nationwide Till salu / Kommande counts | Hemnet `/bostader` + Booli `?upcomingSale=0\|1` · Oxylabs · Apollo ROOT_QUERY | daily 08:30 | `market_totals` (4 rows/day) |
| `market-totals-weekly-report.js` | Weekly supply-pulse Slack post | none (DB) | Mon 09:35 | Slack |
| **Pre-market flow** |||||
| `scripts/premarket-flow-measure.js` | Weekly pre-market new-listing flow + staleness | Hemnet `/kommande` + Booli `?upcomingSale=1` · Oxylabs · Apollo | Mon 08:50 | `premarket_flow_weekly` (2 rows/wk) |
| `premarket-flow-weekly-report.js` | Weekly flow comparison Slack post | none (DB) | Mon 09:40 | Slack |
| **Age-penetration censuses** (all one-off, JSON/MD only, NOT in crontab) |||||
| `scripts/booli-age-census.js` | Booli pre-market age histogram (census vs binary-search bake-off) | Booli `?upcomingSale=1` · Oxylabs | manual | `verf-flow-probe/*.{json,md}` |
| `scripts/hemnet-age-census.js` | Hemnet pre-market (Kommande) age histogram (muni-partition) | Hemnet `/kommande` · Oxylabs | manual | `verf-flow-probe/*.{json,md}` |
| `scripts/hemnet-forsale-age-census.js` | Hemnet for-sale age histogram (recursive muni-partition) | Hemnet `/bostader` · Oxylabs | manual | `verf-flow-probe/*.{json,md}` |
| `scripts/forsale-age-penetration.js` | For-sale age estimate (binary-search / two-pass) | Hemnet + Booli · Oxylabs | manual | `verf-flow-probe/*.{json,md}` |
| **Ad-cost** (Hemnet's seller ad pricing — **on this droplet since 2026-08-18**) |||||
| `adcost-crawl.js` → `scripts/adcost-crawl.py` | Monthly ad-price grid: 10 munis × 6 price points × 7 offers = **420 rows** | Hemnet `/graphql` · **Bright Data Web Unlocker** (no browser) | 1st 00:30 | `hemnet_adcostv2` |
| `adcost-report.js` → `scripts/adcost-report.py` | Monthly ad-pricing Slack post + heat map + workbook | none (DB) | 1st 07:10 | Slack (business) + `view-data/<date>/adcost/` |
| `scripts/lib/adcost_grid.py` | The **one** definition of the scrape grid | none | n/a (library) | none |
| `scripts/lib/adcost_write.py` | Idempotent day-scoped write into `hemnet_adcostv2` | none | n/a (library) | none |
| ~~`scripts/crawl-adcost.js`~~, `adcost-parse.js`, `probe-steel-adcost.js` | **SUPERSEDED 2026-08-18** — the Steel-browser path. Reference only, unscheduled | Hemnet `/priser` · Steel | — | `verf-adcost/*.json` |
| **QA / spot-check + health** |||||
| `cohort-spotcheck-gate.js` | Weekly QA gate: sample cohort, dHash+vision adjudication, Slack review queue | Hemnet+Booli detail (via children) · Oxylabs | Mon 06:30 | `spotcheck_review`, `cohort_pairs`, `verf-spotcheck-*` artifacts, Slack |
| `cohort-spotcheck.js` | Sample + re-fetch evidence (child of gate) | Hemnet detail · Oxylabs | via gate | `verf-spotcheck-*` JSON/MD |
| `spotcheck-photos.js` | Download photo galleries + unit fields (child of gate) | Hemnet+Booli detail · Oxylabs | via gate | artifact JSON + images |
| `spotcheck-reaction-poller.js` | Apply human emoji verdicts; soft-remove mismatches | Slack + DB | daily 12:00 | `cohort_pairs` (soft-delete), `spotcheck_removed_pairs`, `spotcheck_review` |
| `scripts/make-manual-spotcheck.js` | Build manual eyeball-audit MD pack | local JSON | manual | `MANUAL-SPOTCHECK-*.md` |
| `scripts/spotcheck-readjudicate-from-disk.js` | Recover adjudication from on-disk images | local images | manual | console only |
| `cron-health.js` | Console cron-log health report | none (DB) | manual | console |
| `cron-health-slack.js` | Daily Slack health report + view-quality checks | none (DB) + Slack | daily 03:00 | Slack |
| `check-data-freshness.js` | Freshness probe (exit code) | none (DB) | manual | console + exit code |
| `view-data-server.js` | Static file server for `view-data/` (:3800) | none | long-running | serves HTML/xlsx/csv |

> **Only 4 view-tracking scripts, the sold-match fetchers, market-totals-daily, premarket-flow-measure,
> the age censuses, the ad-cost crawler, and the two spot-check evidence children actually hit the
> network.** Everything else is DB → Slack/CSV/xlsx/HTML/console.

---

## (a) Cohort view-tracking

Tracks how listing **view counts** grow over time on Hemnet vs Booli for the same physical property.
Core tables: `cohorts`, `cohort_pairs`, `cohort_unmatched`, `cohort_daily_views` (the time-series
heart), plus source/inventory tables `booli_listing` and `hemnet_listingv2`.

**Weekly build chain:** Job C (Sun 22:00) → Job B (Mon 03:00) → `cohort-create` (Mon 06:00).
**Every-2-day refresh:** Jobs A + D (14:00, parallel) → `cohort-track` (22:00).
**Reporting:** `weekly-view-report` (Mon 09:30) → `export-hb-ratio-xlsx` (per cohort) → `export-cross-cohort-chart`.

### `booli-targeted-discovery.js` — Job C (Booli fetch cohort)
- **Computes:** weekly discovery of new Booli for-sale listings in the 4 cohort counties
  (Stockholm=2, Västra Götaland=23, Skåne=64, Uppsala=118) for the upcoming cohort week. Walks
  search pages until the first card is past a 7-day rolling cutoff, fetches each in-window detail page.
- **Source:** Booli. Search `https://www.booli.se/sok/till-salu?areaIds=<id>&page=<n>` (no `sort=`),
  detail `/annons/<id>` or `/bostad/<id>`. Oxylabs · `__NEXT_DATA__`/Apollo. Pre-market filtered
  parser-side (`upcomingSale===false`).
- **Writes:** `INSERT INTO booli_listing … ON CONFLICT (url) DO UPDATE` (times_viewed, is_active,
  crawled, days_listed, is_pre_market, price, rooms, living_area, object_type).
- **Cost:** ~3,405 in-window candidates × ~5s ÷ concurrency 8 ≈ ~45 min wall-clock (~0.48 req/s,
  ~1% of the 50 jobs/s Oxylabs cap); `JOB_BUDGET_MS=180 min`.
- **Schedule:** `0 22 * * 0` (Sun 22:00 UTC). Must finish before Job B.
- **Run manually:** `node booli-targeted-discovery.js` (flags: `--dry-run`, `--limit N`, `--week YYYY-MM-DD`)

### `hemnet-targeted-match.js` — Job B (Hemnet match cohort)
- **Computes:** for each new Booli FS row, builds a narrowed Hemnet search (price ±5%, exact rooms,
  mapped item_type, location) → fetches one page of candidates → matches on street + ±7 days →
  fetches the detail → seeds `hemnet_listingv2` so `cohort-create` finds matches.
- **Source:** Hemnet. `/bostader?location_ids[]=…&price_min/max&rooms_min/max&item_types[]=…` then
  `/bostad/<id>`. Oxylabs · Apollo. Postcode-mismatch gate rejects contradictory matches.
- **Writes:** `UPDATE hemnet_listingv2` (all rows for the hemnet_id); defensive `INSERT` when absent.
- **Cost:** ~2,400 rows / ~48 rows/min @ conc 8 ≈ ~50 min; `JOB_BUDGET_MS=120 min`.
- **Schedule:** `0 3 * * 1` (Mon 03:00). Runs after Job C, before `cohort-create`.
- **Run manually:** `node hemnet-targeted-match.js` (flags: `--dry-run`, `--limit N`, `--week YYYY-MM-DD`)

### `cohort-create.js` (Cohort create)
- **Computes:** weekly, matches the week's Booli FS listings to Hemnet listings on
  `(postcode, normalized street_address, ±7 days listed)`; records Day-0 view counts. **No scraping.**
- **Source:** none — reads `cohorts`, `booli_listing`, `hemnet_listingv2`.
- **Writes:** `cohorts`; `cohort_pairs … ON CONFLICT (cohort_id, booli_id, hemnet_id) DO NOTHING`;
  `cohort_unmatched`; `cohort_daily_views … ON CONFLICT (pair_id, date) DO NOTHING` (Day-0 seed).
  Cohort id = `YYYY-Www`. Counties: Stockholm, VG, Skåne, Uppsala.
- **Schedule:** `0 6 * * 1` (Mon 06:00). Depends on Jobs B + C for the target week.
- **Run manually:** `node cohort-create.js`  (npm: `npm run create`)

### `booli-targeted-refresh.js` — Job D (Booli view data)
- **Computes:** every cycle, refresh `times_viewed` + `is_active` for every active matched-pair Booli
  URL (last 8 weeks, not dropped). Keeps `booli_listing.times_viewed` fresh for `cohort-track`.
- **Source:** Booli detail pages (`fetchBooliDetail`), Oxylabs · Apollo. Pair-only (JOIN cohort_pairs).
- **Writes:** `UPDATE booli_listing SET times_viewed, is_active, crawled, days_listed, price, rooms,
  living_area, object_type` (COALESCE-preserving); `is_active=false` on 404 (preserves times_viewed).
- **Cost:** ~8k pairs @ ~52/min conc 8 ≈ ~155 min; `JOB_BUDGET_MS=240 min`. **100% Oxylabs-fallback
  warning is expected noise** — do not action unless the rate suddenly drops.
- **Schedule:** `0 14 */2 * *` (every 2 days 14:00, parallel with Job A), before `cohort-track`.
- **Run manually:** `node booli-targeted-refresh.js` (flags: `--dry-run`, `--limit N`; no `--week`)

### `hemnet-targeted-refresh.js` — Job A (Hemnet view data)
- **Computes:** every cycle, refresh `times_viewed` + `is_active` for every active cohort hemnet_id.
- **Source:** Hemnet detail pages (`fetchDetail`), Apollo. Today mostly direct-curl, staged for Oxylabs.
- **Writes:** `UPDATE hemnet_listingv2` (all matching rows, COALESCE-preserving); `is_active=false` on
  404; defensive `INSERT` when 0 rows match.
- **Cost:** ~10–20 min direct steady state (~155 min if fully flipped to Oxylabs); `JOB_BUDGET_MS=240 min`.
- **Schedule:** `0 14 */2 * *` (parallel with Job D), before `cohort-track`.
- **Run manually:** `node hemnet-targeted-refresh.js` (flags: `--dry-run`, `--limit N`)

### `cohort-track.js` (Cohort track)
- **Computes:** every ~2 days, for each active pair in cohorts of the last 63 days, reads current
  `times_viewed` from the source tables and appends a daily row. Drop/recovery via a streak counter
  (5 inactive runs ≈ 10 calendar days). Per-pair horizon 56 days.
- **Source:** none — reads already-refreshed `times_viewed` (Hemnet via `MAX(times_viewed) WHERE is_active`).
- **Writes:** `UPDATE cohort_pairs` (streak/drop state); `INSERT INTO cohort_daily_views … ON CONFLICT
  (pair_id, date) DO NOTHING`.
- **Schedule:** `0 22 */2 * *` (every 2 days 22:00). Must run after Jobs A+D in the same cycle.
- **Run manually:** `node cohort-track.js`  (npm: `npm run track`)

### `sfpl-region-snapshot.js` — RETIRED 2026-08-13
> Removed from the crontab. Nothing consumed `sfpl_region_daily` except `cron-health-slack.js`'s
> own row-count check and the manual `sfpl-region-analysis.js` console report. The two for-sale
> columns are region totals duplicated across all six age buckets, and the universe is our
> 4-county cohort DB rather than national — superseded by `premarket_flow_weekly` and the
> `scripts/*-age-census.js` work. Table retained (2,880 rows, 2026-03-06 → 2026-08-12);
> to revive, restore the daily 08:00 UTC crontab line.

- **Computes:** daily point-in-time inventory counts (Booli pre-market by listing-age bucket, Booli FS,
  Hemnet FS) grouped into regions Stockholm / VG / Rest. The "Pool & Flow" stock counter (separate
  from pair-level view tracking). **No scraping** — DB aggregation.
- **Source:** none — reads `booli_listing`, `hemnet_listingv2`.
- **Writes:** `CREATE TABLE IF NOT EXISTS sfpl_region_daily`; `INSERT … ON CONFLICT
  (snapshot_date, region, age_bucket) DO UPDATE`. Exactly 18 rows/day (3 regions × 6 buckets).
- **Schedule:** none (was `0 8 * * *` until 2026-08-13).
- **Run manually:** `node sfpl-region-snapshot.js`

### `sfpl-region-analysis.js`
- **Computes:** read-only console report — daily and 7-day-rolling Booli-PM/Hemnet-FS ratio tables by
  region + national. Not a cron job.
- **Source:** none — reads `sfpl_region_daily`. Output: `console.table` only.
- **Run manually:** `node sfpl-region-analysis.js`

### `weekly-view-report.js`
- **Computes:** finds cohorts with ≥5 days tracked (skips W09–W11), shells out `export-hb-ratio-xlsx.js`
  per cohort then `export-cross-cohort-chart.js`, and posts a Slack message with chart links.
- **Source:** none — reads `cohort_pairs ⋈ cohort_daily_views`. No DB writes.
- **Schedule:** `30 9 * * 1` (Mon 09:30).
- **Run manually:** `node weekly-view-report.js`

### `export-hb-ratio-xlsx.js`
- **Computes:** per-cohort ExcelJS workbook (cumulative views, inclusion flags, 2-day incrementals,
  live-formula aggregation with Count/Mean/Median/H-B-Ratio/H%-of-Total per region) + `charts.html`.
  Canonical view-tracking deliverable.
- **Source:** none — reads `cohort_pairs`, `cohort_daily_views`.
- **Writes:** `view-data/<runDate>/<cohortId>/hb-ratio-<cohortId>.xlsx` + `charts.html`.
- **Run manually:** `node export-hb-ratio-xlsx.js --cohort <YYYY-Www>` (default latest; `--include-latest`)

### `export-cross-cohort-chart.js`
- **Computes:** aggregates the per-cohort xlsx workbooks into one cross-cohort "Hemnet % of total
  incremental views" chart. Reads xlsx, not DB.
- **Source:** none — parses `view-data/<date>/*/hb-ratio-*.xlsx`.
- **Writes:** `view-data/<date>/cross-cohort-hpct.html`.
- **Run manually:** `node export-cross-cohort-chart.js --date <YYYY-MM-DD>`

### `chart-hb-ratio.js`
- **Computes:** on-demand H/B ratio chart for one cohort (or `--cohorts N` pooled): per-pair rolling-7d
  daily deltas → Hemnet/Booli ratio → median per region per day. Includes Östermalm postcode overlay.
- **Source:** none — reads `cohort_pairs`, `cohort_daily_views`.
- **Writes:** `view-data/<runDate>/<label>/hb-ratio-chart.html` + `hb-ratio-summary.csv` + `hb-ratio-detail.csv`.
- **Run manually:** `node chart-hb-ratio.js --cohort <YYYY-Www>` (or `--cohorts N`)

### `export-views-wide.js`
- **Computes:** wide-format CSV dump of one cohort (cumulative, gap-aware incremental, rolling-7d,
  region aggregate).
- **Source:** none — reads `cohort_pairs`, `cohort_daily_views`.
- **Writes:** `view-data/<runDate>/<cohortId>/{cumulative,incremental,rolling-7d,aggregate}.csv`.
- **Run manually:** `node export-views-wide.js --cohort <YYYY-Www>`

---

## (b) Sold-match — Booli-sold → Hemnet-sold matching / Hemnet market share

Estimates the share of listing-process sales that happen on Hemnet by matching Booli sold records to
Hemnet sold records; unmatched-after-recheck ⇒ genuine non-Hemnet. **Methodology is Slutpris-only.**

**Core tables** (written by `lib/sold-store.js`):
- `booli_sold` — 1 row per `booli_id` (28 cols: sold_price, sold_date, street_address, municipality,
  living_area, rooms, segment, family, is_title_transfer, …). `ON CONFLICT (booli_id) DO UPDATE`.
- `hemnet_sold` — 1 row per `hemnet_slug` (final_price, asking_price, sold_at, living_area, …).
- `sold_match` — 1 row per `booli_id`: `verdict` (`matched|booli_only|uncertain|genuine_non_hemnet`),
  `match_method`, `evidence` (JSONB), `segment` = `"<Muni>:<FAMILY>"`, `window_start/end`, plus
  Phase-18 recheck cols `first_unmatched_at`, `recheck_until`, `next_recheck_at`. (Rechecking is
  columns on `sold_match`, not a separate table.)
- `sold_spend` — DB-atomic Oxylabs spend tally (one batch-wide ceiling).

**Fetch method:** all live fetches force Oxylabs (each entry sets `SCRAPE_FORCE_OXYLABS=1`;
`lib/sold-transport.js` throws at require-time if unset). Pages parsed from `__NEXT_DATA__` → Apollo.
Spend ceiling `MAX_OXY_CALLS` (default 4000 in lib; set `8000` in `.env` for the full batch).

**SERP bridge** (`lib/sold-serp.js`, `SOLD_MATCH_BRIDGE=1`): for a `booli_only` residue record, runs an
Oxylabs **`google_search`** SERP (`domain:'se', geo_location:'Sweden', locale:'sv-se', parse:true`) for
`"hemnet <addr> <area> <muni>"`, filters to `/bostad/…` URLs matching the exact street, fetches the
`/bostad` page via Oxylabs, and confirms address + living-area against the `Deactivated*PropertyListing`
Apollo node → reclassifies as `matched` with `match_method='bostad_bridge'`.

### `sold-match-batch.js` — the orchestrator (Phase 19, PRODUCTION)
- **Computes:** the whole pipeline in one process. On **odd ISO weeks it no-ops** (`skipped:'off-week'`,
  not an error); on even weeks: `sampleNational` (config/sold-panel.json, ~1000-record de-duped 14-day
  sample) → `matchOne` per record (bounded worker pool `SOLD_BATCH_CONC`, default 6) → recheck drain
  (`enrollUnmatched → runRecheck → settleExpired`). Fortnight interlock skips if a prior success exists
  for the same ISO week (`SOLD_BATCH_FORCE=1` overrides).
- **Source:** Booli `/slutpriser` + Hemnet `/salda` + SERP bridge · Oxylabs (delegated). Sets both
  `SCRAPE_FORCE_OXYLABS=1` and `SOLD_MATCH_BRIDGE=1`.
- **Writes:** `booli_sold`, `hemnet_sold`, `sold_match`, `sold_spend`; `result_summary` → `cron_job_log`.
- **Cost:** one batch-wide ceiling `MAX_OXY_CALLS` (spend key scoped per fortnight, resets each run).
  ~3–6k calls/run → ~7–13k/month. Worker pool cuts a ~1000-record run to ~40–60 min.
  Cost lever `RECHECK_BRIDGE_FINAL_ONLY=1` (~9k→~6k/mo). `validate()` escalates on ceiling-stop /
  fatal / fetchFailures > threshold / incomplete pass.
- **Schedule:** `30 7 * * 1` (Mon 07:30 UTC), fortnightly effect (even weeks only).
- **Run manually:** `node sold-match-batch.js` (idempotent; `--smoke` = offline self-test). Odd-week
  catch-up: `node scripts/run-sold-match-batch-now.js`.

### `sold-match-report.js` (Phase 20)
- **Computes:** buckets `sold_match` by segment → region/national/family. Headline = settled
  genuine-non-Hemnet rate = `genuine_non_hemnet / (matched + genuine_non_hemnet)` over terminal
  verdicts only. Live `run()` posts a minimal weekly table (Matched-on-Hemnet % + n, last ~5 cohorts) +
  chart link (detailed renderers dormant). DB-only.
- **Source:** none — reads `sold_match ⋈ booli_sold`. Posts to Slack via `lib/spotcheck-slack-bot`.
- **Schedule:** `0 11 * * 1` (Mon 11:00), after the batch.
- **Run manually:** `node sold-match-report.js`

### `sold-match-trend-chart.js` (Phase 20)
- **Computes:** per fortnightly cohort (keyed by `window_end` ISO week), stacked on-Hemnet share
  (firstPull matched + incremental recheck matches). Excludes pilot cohort 2026-W12.
- **Source:** none — reads `sold_match`. Writes Chart.js-4 HTML to `view-data/<date>/sold-match/trend.html`.
- **Schedule:** `5 11 * * 1` (Mon 11:05).
- **Run manually:** `node sold-match-trend-chart.js`

### `sold-match-xlsx.js`
- **Computes:** one auditable workbook per cohort (`window_end`) — every sampled Booli property with
  verdict + clickable Booli/Hemnet links.
- **Source:** none — reads `sold_match ⋈ booli_sold`. Writes
  `view-data/<date>/sold-match/sold-audit-<cohort>.xlsx`.
- **Schedule:** `10 11 * * 1` (Mon 11:10).
- **Run manually:** `node sold-match-xlsx.js` (flags `--window-end`, `--all`; default latest)

### Manual / dev tools (not scheduled)
- **`scripts/sold-match-run.js`** — manual end-to-end matcher; **home of `matchOne`** reused by the
  batch + recheck. Seeds `booli_sold`, searches Hemnet `/salda`, adjudicates (houses via `address_key`;
  apartments via `single_candidate_confirmed` / `fee_exact`; bridge → `bostad_bridge`), writes
  `booli_sold`/`hemnet_sold`/`sold_match`. Uses `config/sold-segments.json`.
  Run: `node scripts/sold-match-run.js`
- **`scripts/booli-sold.js`** — fetch Booli `/slutpriser` sold cards per segment → JSONL under
  `verf-soldspike/seeds/` (no DB). `--detail-scope all` (~2× spend) is approval-gated.
  Run: `node scripts/booli-sold.js`
- **`scripts/hemnet-sold.js`** — per Booli seed, narrowed Hemnet `/salda` search → candidates JSONL
  (`verf-soldspike/hemnet-candidates/`). Reads seeds from `booli-sold.js`.
  Run: `node scripts/hemnet-sold.js`
- **`scripts/persist-sold.js`** — load fetcher JSONL → DB. `--booli` → `booli_sold`, `--hemnet` →
  `hemnet_sold`. No Oxylabs (avoids the transport load guard).
  Run: `node scripts/persist-sold.js --booli` (or `--hemnet`)
- **`scripts/sold-residue-recheck.js`** — one-off recall-lift measurement re-running the residue through
  the SERP bridge. Reads `verf-soldmatch-serp/overlap-properties.csv`, writes `residue-recheck.json`. No DB.
  Run: `MAX_OXY_CALLS=20000 node scripts/sold-residue-recheck.js`
- **`scripts/export-sold-match.js`** — read-only xlsx+csv export by `created_at` (surfaces rows with
  NULL `window_end` the cron trio drop). Writes `view-data/<label>/sold-match/*.{xlsx,csv}`.
  Run: `node scripts/export-sold-match.js --since <YYYY-MM-DD> --until <YYYY-MM-DD>`

### Config
- **`config/sold-panel.json`** — national sampler panel: `target_sample_size: 1000`, `lookback_days: 14`,
  **11 municipalities** each with `pop` weight + `booli_area_id` + `hemnet_location_id` + `region`
  (Stockholm, Göteborg, Malmö, Uppsala, Helsingborg, Lund, Borås, Nacka, Södertälje, Täby, Kungälv).
  Report-only `overlays[]` (Stockholm innerstad, Östermalm) re-bucket by `descriptive_area`.
  `_backfill_pending` lists munis needing Hemnet location IDs (the coverage-expansion lever, config-only).
- **`config/sold-segments.json`** — 4 segments for `sold-match-run.js` (stockholm-apt, taby-villa,
  kungalv-apt, kungalv-villa), each with family + Booli areaIds/objectType + Hemnet locationId/itemType.

---

## (c) Market supply totals

Daily nationwide headline counts of the on-market pool (Till salu) and upcoming pool (Kommande) on both
sites — the site-headline "market totals" universe (distinct from the our-DB pool-flow tables).

### `market-totals-daily.js` (Phase 11 / v2.2)
- **Computes:** daily national listing totals. Fetches Hemnet (1 req — both segments from one page's
  `__NEXT_DATA__`) + Booli (2 reqs, one per segment). Writes **4 rows/day** (2 sites × 2 segments:
  `till_salu`, `kommande`). Inline smoke probe rejects undefined/non-positive totals (D-02).
- **Source:** Hemnet `https://www.hemnet.se/bostader`; Booli
  `https://www.booli.se/sok/till-salu?upcomingSale=0` (till_salu) and `?upcomingSale=1` (kommande).
  Oxylabs · `__NEXT_DATA__` → `__APOLLO_STATE__.ROOT_QUERY`, total read by call-name prefix
  (`pickByPrefix`, e.g. `searchForSaleListings(...)`).
- **Writes:** `CREATE TABLE IF NOT EXISTS market_totals (day, site, segment, total, fetched_at,
  source_url, PRIMARY KEY (day, site, segment))`; `INSERT … ON CONFLICT (day, site, segment) DO UPDATE`.
- **Cost:** **3 Oxylabs reqs/day** (trivial).
- **Schedule:** `30 8 * * *` (daily 08:30). Silent on success; alerts only on missing JSON path or <4 rows.
- **Run manually:** `node market-totals-daily.js`

### `market-totals-weekly-report.js` (Phase 11 / v2.2)
- **Computes:** weekly supply-pulse Slack post — reads `market_totals` for `(today, today-7)` ×
  {hemnet, booli} × `segment='till_salu'`, renders WoW deltas, posts to `SLACK_WEBHOOK_URL`.
  First valid run ≥ 7 days post-deploy (earlier renders "?"). No delta alarms (D-03). DB-only.
- **Source:** none — reads `market_totals`.
- **Schedule:** `35 9 * * 1` (Mon 09:35), 5 min after `weekly-view-report`.
- **Run manually:** `node market-totals-weekly-report.js`

Related helper (manual): `scripts/show-market-totals.js` (droplet-safe DB query, no psql).

---

## (d) Pre-market flow

Weekly flow of NEW pre-market (Kommande / upcoming) second-hand listings and pool staleness, Hemnet vs Booli.

### `scripts/premarket-flow-measure.js`
- **Computes:** walks Hemnet `/kommande` + Booli `?upcomingSale=1` **newest-first to a 7-day cutoff**,
  counts second-hand adds (excludes new-builds), samples pool depth (`sampleDepth`) and mean dwell,
  computes metrics (`lib/premarket-flow.js` `walkFlow` / `computeMetrics`). Writes **2 rows/week**
  (one per platform).
- **Source:** Hemnet `/kommande` + Booli `/sok/till-salu?upcomingSale=1` · Oxylabs (`SCRAPE_FORCE_OXYLABS=1`,
  droplet DC IP gets CF 403 on direct) · `__NEXT_DATA__` → Apollo (`parseListingCards` /
  `parseBooliSearchCards`), total by `pickByPrefix`. `MAX_PAGES=80`, `WINDOW_DAYS=7`.
- **Writes:** `CREATE TABLE IF NOT EXISTS premarket_flow_weekly (snapshot_date, platform, window_days,
  stock_total, stock_secondhand_est, adds_window_secondhand, flow_per_day, newbuild_share_window,
  newbuild_share_pool_est, mean_dwell_days, pages_walked, oxylabs_calls, PRIMARY KEY
  (snapshot_date, platform))`; `ON CONFLICT (snapshot_date, platform) DO UPDATE`. Also writes an
  artifact into `verf-flow-probe/`.
- **Cost:** ~107 Oxylabs calls/run (non-JS), ~4 min.
- **Schedule:** `50 8 * * 1` (Mon 08:50). The cron line prefixes `SCRAPE_FORCE_OXYLABS=1`.
- **Run manually:** `SCRAPE_FORCE_OXYLABS=1 node scripts/premarket-flow-measure.js`

### `premarket-flow-weekly-report.js`
- **Computes:** reads `premarket_flow_weekly` for `(today, today-7)`, renders the comparison block
  (stock / adds-per-week / mean dwell + Booli/Hemnet ratios + Hemnet share + WoW adds), posts to Slack.
- **Source:** none — reads `premarket_flow_weekly`.
- **Schedule:** `40 9 * * 1` (Mon 09:40).
- **Run manually:** `node premarket-flow-weekly-report.js`

---

## (e) Age-penetration censuses

Measure the **age distribution** of the for-sale / pre-market pool (how fresh vs stale listings are).
**All four are one-off / manual analysis tools — NONE use `cron-wrapper`, NONE are in the crontab, and
NONE write to Postgres.** Each dumps JSON + Markdown into `verf-flow-probe/`. All refuse to run
un-proxied unless `SCRAPE_FORCE_OXYLABS=1`, and all share the 7-band edges `[30,90,180,365,548,730]`
and `lib/premarket-flow` bisection helpers. Requires the `SCRAPE_FORCE_OXYLABS=1` prefix to run.

### `scripts/booli-age-census.js`
- **Computes:** Booli pre-market age histogram, run two ways for a bake-off: an exact **full census**
  (~955 pages) vs a cheap **binary-search estimate** (bisects the newest-first pool for each cutoff
  crossover), with a PASS/FAIL comparison to decide whether binary-search can replace the census.
- **Source:** Booli `https://www.booli.se/sok/till-salu?upcomingSale=1&page=N` · Oxylabs · `__NEXT_DATA__`/Apollo.
- **Output:** `verf-flow-probe/booli-age-census-<date>.{json,md}`. No DB.
- **Cost:** full run ≈ **982 Oxylabs calls**; `--probe` = 1 call.
- **Run manually:** `SCRAPE_FORCE_OXYLABS=1 node scripts/booli-age-census.js` (`--selftest` offline, `--probe`)

### `scripts/hemnet-age-census.js`
- **Computes:** national Hemnet **pre-market (Kommande)** age histogram via **municipality-partition**
  (Hemnet caps national Kommande pagination ~2,500 of 8,368; censuses each of ~290 munis and unions by id;
  stop condition = first page adding 0 new distinct IDs). Produces a like-for-like table vs the Booli census.
- **Source:** Hemnet `https://www.hemnet.se/kommande/bostader?location_ids[]=<id>&sort=NEWEST&page=N` ·
  Oxylabs · Apollo (`parseListingCards`); locations from `lib/hemnet-locations-full.json`.
- **Output:** `verf-flow-probe/hemnet-age-census-<date>.{json,md}`. No DB.
- **Cost:** full run ≈ **400–480 calls**; `--probe` = 1 muni.
- **Run manually:** `SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-age-census.js` (`--selftest`, `--probe`)

### `scripts/hemnet-forsale-age-census.js`
- **Computes:** national Hemnet **for-sale (Till salu)** age histogram via **muni-partition + recursive
  sub-partition** (any scope whose page-1 total > 2400 is split by `item_types[]` then price bands until
  under the ~2,500 clamp; global dedup by id). Reconciles union distinct count vs muni headline totals.
- **Source:** Hemnet `https://www.hemnet.se/bostader?location_ids[]=<id>[&item_types[]=..][&price_min/max]
  &sort=NEWEST&page=N` · Oxylabs · Apollo.
- **Output:** `verf-flow-probe/hemnet-forsale-age-census-<date>.{json,md}`. No DB.
- **Cost:** proportional to munis × sub-partitions (no single headline). Modes: `--sizes`, `--probe [Muni]`.
- **Run manually:** `SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js` (`--selftest`, `--sizes`, `--probe`)

### `scripts/forsale-age-penetration.js`
- **Computes:** for-sale age **estimate** for both sites using the cheap binary-search / two-pass method
  only. Booli FS uses a **two-pass** approach (small cutoffs from newest-first, large cutoffs from an
  oldest-first pass `?sort=published&ascending=1`) to beat the pagination clamp. In the full run **Hemnet
  is intentionally skipped** (national FS clamps at ~2,500, no oldest-first sort → needs the muni-partition
  census above); only Booli is estimated. `--preflight` checks viability first.
- **Source:** Hemnet `/bostader?sort=NEWEST|OLDEST` + Booli `/sok/till-salu?upcomingSale=0` (+ oldest-first
  `&sort=published&ascending=1`) · Oxylabs · Apollo.
- **Output:** `verf-flow-probe/forsale-age-penetration-<date>.{json,md}`. No DB.
- **Cost:** preflight ~6 calls; full run ≈ **80–100 calls/viable platform** ("trivial vs a full census ~2,000").
- **Run manually:** `SCRAPE_FORCE_OXYLABS=1 node scripts/forsale-age-penetration.js` (`--selftest`, `--preflight`, `--sortprobe`)

---

## (f) Ad-cost — Hemnet's seller ad pricing

Scrapes Hemnet's seller advertising price calculator (`/priser`) — **what Hemnet charges a seller to
advertise a property**, by municipality and asking-price band. This is the direct read on Hemnet's
pricing power, and it is the one stream that uses neither Oxylabs nor `__NEXT_DATA__`.

> 🔄 **Migrated onto this droplet 2026-08-18.** Until then the crawl ran **weekly** on the separate
> price-scraper droplet (`170.64.181.89`) as a Django/Celery task driving a **Steel.dev** headless
> browser. That box is being decommissioned, so the crawler was ported into this repo, the Steel and
> Browser-API transports were deleted, and the job now runs from this droplet's crontab with a
> `cron_job_log` row and tier-1 Slack alerting like every other job here. The cadence also changed
> **weekly → monthly** (2026-08-17).
>
> - Design + plan: `docs/superpowers/specs/2026-08-18-adcost-scrape-migration-design.md`,
>   `docs/superpowers/plans/2026-08-18-adcost-scrape-migration.md`
> - The byte-identical Django original is preserved at `docs/handover/adcost-django-source/`.
>   **Reference only** — nothing in this repo imports or executes it.
> - **Rollback is the DigitalOcean snapshot `241648610`** (hold to ~2026-11-18), *not* a transport
>   flag. `ADCOST_TRANSPORT=steel` no longer exists.
> - The old box's beat row is disabled, and the box is destroyed only after the **1 Sept 2026** run
>   is verified. Two writers must never target the same crawl day.

**The grid (`scripts/lib/adcost_grid.py`)** — 10 municipalities × 6 price points = **60 cells**, each
yielding **7 offers** (BASIC, PLUS, PREMIUM, MAX, PAID_REPUBLISH, TOPLISTING, TOPLISTING_5_DAYS) =
**420 rows/month**. Before the migration this was defined *twice* — as rows in
`hemnet_adcostpricepointv2` edited through the Django admin, and hardcoded in `adcost-report.py` —
with nothing checking they agreed. It is now one versioned file, and `assert_matches_db()` catches
drift against the legacy table (which still lives in the managed Postgres and can still be hand-edited).

### `adcost-crawl.js` → `scripts/adcost-crawl.py` — the monthly crawl (SCHEDULED, **tier 1**)
- **Computes:** for each of the 60 (municipality, price) cells: resolves the muni's `locationId` via
  the `webAutocompleteLocations` op (cached), then fires `webPricingCalculator` and parses the seven
  offers into `hemnet_adcostv2` rows.
- **Source / transport:** `POST https://www.hemnet.se/graphql` through **Bright Data Web Unlocker**
  (native proxy, port `44445`). **No browser at all** — no Playwright, no CDP, no Steel, no Cloudflare
  page-clearing. TLS verification is off because the unlocker terminates TLS (their own sample uses
  `curl -k`); it is a proxy we authenticate to, and the payload carries no secrets.
- **⚠ The price field is `PAY_WHEN_LISTING_IS_REMOVED`, not `PAY_NOW`.** `ad_price =
  prices[PAYMENT_METHOD].total.amountInCents / 100`, in SEK **net of the 25% moms**. The Django
  docstring claimed `PAY_NOW`; the code never did, and switching would break continuity across the
  scrape gap and drop every price ~6.5%. `composeUpgradesWithBasic:true` means PLUS/PREMIUM/MAX are
  **already composed** — never sum BASIC into them.
- **Writes:** `hemnet_adcostv2` via `scripts/lib/adcost_write.py` — an **idempotent day-scoped**
  write (the table has no uniqueness constraint, so a wrong key or day boundary would silently
  duplicate rows and corrupt the series).
- **Reliability:** Cloudflare starts refusing `POST /graphql` a few requests into a session and the
  refusal **latches**. The crawler retries each cell, detects the latched state, rebuilds the session
  and resumes from the failed cell. A run that collects **zero** cells exits 4, and the completeness
  gate **fails the job on any month short of all 420 cells** — this is the fix for the 2026-08-02
  silent failure that wrote 6/420 rows and exited 0 (`docs/handover/adcost-crawler-silent-failure.md`).
  ⚠ Do not trust the warm-up as proof a session is usable: `CLEAR_RE` is permissive enough that
  Hemnet's global-nav "Priser" satisfies it. The completeness gate downstream is what actually holds.
- **Exit codes:** `0` ok · `1` error · `2` misconfig · `4` transport blocked. Non-zero propagates as a
  `runJob` failure, and the **stderr tail rides along into the Slack alert** — that tail is what tells
  a `WARMUP_FAILED` run (wrote nothing, cheap to re-run now) from a short grid (**already wrote rows,
  do NOT re-crawl**).
- **Cost / timing:** billed **per successful request** at $1.50/CPM, so failed retries are free —
  **~$0.45/month**. Measured 2026-08-17: ~21s/cell, ~39s warm-up, 420/420 rows. The subprocess kill
  timer is **2700s** and the crawler derives its own `TIME_BUDGET` from it; `SUBPROCESS_TIMEOUT_SEC`
  in the JS and `DEFAULT_SUBPROCESS_TIMEOUT` in the Python **must never drift apart**, because
  `subprocess.run` **discards stdout on timeout** — an overrun loses the whole month, not its tail.
- **Schedule:** `30 0 1 * *` — **1st of the month, 00:30 UTC**. Deliberately *not* 02:00, which
  `age-census-monthly` owns and runs ~3h: two never-before-run monthly tier-1 jobs on one vCPU / 2 GB
  with no swap is a contention risk with no upside. Log `/var/log/hemnet/adcost-crawl.log`.
- **Env:** `BRIGHTDATA_UNLOCKER_PROXY` (read from env, else the repo-root `.env`; **never logged** —
  the Python scrubs the credential out of its own exception text) and `PYTHON_BIN` pointing at
  `/opt/hemnet-cohort-tracker/.venv-adcost/bin/python` (the system `python3` is PEP-668
  externally-managed and has neither `psycopg` nor `openpyxl`).
- **Run manually:**
  - `node adcost-crawl.js --smoke` — **offline**: no DB, no Python, no network, no spend.
  - `python scripts/adcost-crawl.py --selftest` — offline Python self-test.
  - `node adcost-crawl.js --dry-run` — ⚠ **crawls fully and spends provider $**, but writes nothing
    and prints a JSON diff. This is *not* an offline check.
  - `node adcost-crawl.js` — the real thing. Needs Julian's go-ahead for that specific run.

### `adcost-report.js` → `scripts/adcost-report.py` — the monthly report (SCHEDULED, tier 2)
See **[`04-REPORTING-AND-SLACK.md`](04-REPORTING-AND-SLACK.md)**. Runs `10 7 1 * *` (**1st 07:10
UTC**, 6h40m after the crawl), posts two county × package tables to the **business** channel, and
links a heat map + workbook written to `view-data/<date>/adcost/`. Same `PYTHON_BIN` venv requirement
as the crawl.

### Superseded — the Steel path (reference only, unscheduled)
`scripts/crawl-adcost.js`, `scripts/adcost-parse.js`, `scripts/lib/adcost-contract.js` and
`scripts/probe-steel-adcost.js` are the **pre-2026-08-18** implementation: a Steel.dev residential
browser loading `hemnet.se/priser`, clearing Cloudflare, then doing a quiet in-page `fetch('/graphql')`.
They are not in the crontab, have no cron-wrapper, and write JSON to `verf-adcost/` rather than the DB.
Steel's clear rate had decayed to ~12% and the Bright Data Browser API returned
`resolve_fail_cf_max_tries`, which is why the transport moved. **Do not re-litigate Steel, the
Browser API, or Oxylabs-render for this stream — all three were falsified empirically.**

---

## (g) QA / spot-check + cron health

### `cohort-spotcheck-gate.js` (Phase 12/13, SCHEDULED)
- **Computes:** the weekly QA orchestration + escalation gate. Resolves the latest cohort (ISO-week stale
  guard), runs `cohort-spotcheck.js` then `spotcheck-photos.js` as child processes, flags multi-unit
  addresses, runs dHash photo-correspondence, adjudicates every pair (Mode A deterministic; Mode B =
  Claude vision on suspect pairs when `ANTHROPIC_API_KEY` set, capped `VISION_MAX_CALLS=60`, model
  `claude-sonnet-4-6`), computes the confirmed-mismatch rate + Wilson CI, writes verdict artifacts, and
  posts a **per-pair Slack review queue**.
- **Source:** Hemnet + Booli detail (indirectly, via the two children) · Oxylabs. Itself does dHash on
  already-downloaded images — no direct network. Uses the Anthropic SDK (Mode B).
- **Writes:** `spotcheck_review` (via `lib/spotcheck-review-store`); reads `cohorts`/`cohort_pairs`;
  artifacts `VERDICTS-<cohort>.json` + `SUMMARY-<cohort>.md` into `verf-spotcheck-*`; Slack review posts;
  `result_summary` → `cron_job_log`. `validate()` escalates on stale cohort / fetch failures / rate > 5%.
- **Schedule:** `30 6 * * 1` (Mon 06:30), right after `cohort-create`.
- **Run manually:** `node cohort-spotcheck-gate.js` (or `--cohort 2026-Wxx`, `--rate 0.10`, `--threshold 0.10`)

### `cohort-spotcheck.js` (child of gate)
- **Computes:** deterministic stratified-by-county sample (~8% default) of a cohort's matched pairs;
  re-fetches the **live Hemnet detail page** per sampled pair to gather independent signals (price /
  living-area / property-type / address), computes deltas + a provisional triage + Wilson CI.
- **Source:** Hemnet detail (`lib/hemnet-fetch`) · direct→Oxylabs. `--refetch-booli` also scrapes Booli.
  Read-only on Postgres. No Anthropic API.
- **Output:** `verf-spotcheck-<cohort>-<ts>/spotcheck-<cohort>.{json,md}` (verdict fields left null for
  later adjudication). ~1 Oxylabs call/sampled pair.
- **Run manually:** `node cohort-spotcheck.js --cohort <YYYY-Www>` (`--rate`, `--limit`, `--conc`, `--refetch-booli`)

### `spotcheck-photos.js` (child of gate)
- **Computes:** enriches a spot-check artifact with hero + gallery photos and per-side page disposition
  (active/delisted/error) + unit-identity fields (fee/floor/rooms) so pairs can be visually confirmed.
- **Source:** Hemnet + Booli detail via `lib/scrape-http` (`getWithRetry`) · Apollo; images from CDN
  (free). Booli prefers `/annons/<booli_id>`, falls back to canonical URL. ~2 detail fetches/pair.
- **Output:** writes galleries/`page_status`/unit fields back into the artifact JSON, downloads images to
  `<dir>/photos/`, emits `PHOTOS-<cohort>.md`. No DB.
- **Run manually:** `node spotcheck-photos.js <artifact-dir>` (`--all`, `--gallery`, `--limit`, `--max`, `--conc`)

### `spotcheck-reaction-poller.js` (Phase 13, SCHEDULED)
- **Computes:** daily poller reading emoji reactions on open Slack review messages and applying the human
  verdict: ✅ → CONFIRMED_MISMATCH (audit-first **soft-remove** the pair), ❌ → OVERRIDE_MATCH (keep),
  ❓ → UNCERTAIN. Auth-gated by `SLACK_ALLOWED_REACTORS`; escalates reviews unanswered > `STALE_REVIEW_DAYS`
  (default 7). Slack + DB only, no scraping, no Anthropic API.
- **Writes:** `UPDATE cohort_pairs SET removed_at/removed_reason/removed_by` (soft-delete, never DELETE);
  audit row in `spotcheck_removed_pairs`; `markAdjudicated` stamps `spotcheck_review`; `result_summary`
  → `cron_job_log`.
- **Schedule:** `0 12 * * *` (daily 12:00).
- **Run manually:** `node spotcheck-reaction-poller.js` (`--smoke` = offline self-test)

### Manual QA tools
- **`scripts/make-manual-spotcheck.js`** — reads a gate `VERDICTS-*.json`, builds a
  `MANUAL-SPOTCHECK-<cohort>.md` eyeball-audit pack (samples each funnel stage). No network/DB.
  Run: `node scripts/make-manual-spotcheck.js <VERDICTS.json>`
- **`scripts/spotcheck-readjudicate-from-disk.js`** — recovery tool (for the 2026-W27 incident):
  reconstructs galleries from already-downloaded images, re-runs the same dHash + adjudication, prints the
  real review list. Console only, no network/DB.
  Run: `node scripts/spotcheck-readjudicate-from-disk.js <artifact-dir>` (`--json`)

### Cron health / observability

Full treatment: **[`05-MONITORING-AND-ALERTS.md`](05-MONITORING-AND-ALERTS.md)**.

- **`cron-health-slack.js`** (SCHEDULED `0 3 * * *` daily 03:00) — the daily health digest, in six
  sections (Liveness, Assertions, Open conditions, Tier-1 backstop, Disk headroom, and the
  view-growth / null-view "canary" product checks). Coverage is **derived from
  `lib/job-registry.js`**, so it spans every scheduled job (24 currently), and liveness and
  assertions anchor on each job's `last_expected_fire + grace` rather than a fixed window.
  Wrapped in `runJob` like every other job since Phase 1 (2026-08-17), and posts through
  `lib/slack-post.js` (ops audience), not its own sender. Reads `cron_job_log`, `alert_state`,
  `disk_sample`, `cohort_daily_views`, `cohort_pairs`, `cohorts` and each tier-1 job's output
  table. Run: `node cron-health-slack.js` (add `--dry-run` to render without posting).
- **`cron-health-slack.js --sweep`** (SCHEDULED `0 1,11,17,23 * * *`, registry name
  `cron-health-sweep`) — between-digest check for missing / orphaned / failing **tier-1** jobs.
  Posts **one** rolled-up message however many are broken, subject to the same re-notify ladder.
- **`cron-health-slack.js --heartbeat`** (SCHEDULED `0 12 * * 4`, registry name
  `alerting-heartbeat`) — weekly unconditional proof-of-life on the alert webhook. **Its absence
  is the alert**: every other message is conditional, so without it a dead transport is
  indistinguishable from a healthy week.
- **`migrate-alert-state.js`** — idempotent creator of the two alerting tables (`alert_state`,
  `disk_sample`). Run: `node migrate-alert-state.js` (`--check` reports without writing).
- **`cron-health.js`** (manual) — console version of the same cron-log aggregation (`--days`, default 7).
  Run: `node cron-health.js --days 7`
- **`check-data-freshness.js`** (manual) — compares today vs yesterday `cohort_daily_views` per source,
  exits non-zero if ≤50% of pairs changed. Run: `node check-data-freshness.js`
- **`view-data-server.js`** (long-running server) — serves the `view-data/` directory over HTTP
  (port 3800, `VIEW_SERVER_PORT`) with auto directory index + traversal guard. Serves all the xlsx/HTML/CSV
  deliverables above (including the sold-match trend chart and weekly-view charts).
  Run: `node view-data-server.js`

---

## Observability & runbook (all streams)

1. **cron_job_log (DB)** — every `runJob`-wrapped run writes a row. Inspect:
   `node scripts/verify-cron-job-log.js` (last 5 rows per script_name).
2. **Logs** — `/var/log/hemnet/<job>.log` (one per job) on the droplet.
3. **Slack** — alerts are **tier-gated**, not "any warning/failure". Only **tier-1** jobs
   (perishable: a missed run destroys an observation that can never be recovered) post, as
   `🚨 TIER1 <!channel> [FAILURE|WARNING|KILLED] …` on a 0h/+24h/+72h/daily ladder. **Tier-2
   jobs post nothing** — they write a `cron_job_log` row and appear in the 03:00 digest. Each
   job's tier is declared in `lib/job-registry.js`. **Do not read a quiet channel as a healthy
   system without checking the digest and the Thursday heartbeat first** —
   see [`05-MONITORING-AND-ALERTS.md`](05-MONITORING-AND-ALERTS.md) §5.
   `SLACK_BOT_TOKEN` + `SLACK_ALLOWED_REACTORS` drive the spot-check review queue/poller;
   channel routing for every job is resolved in `lib/slack-post.js` (see `04` §1).
4. **Manual re-runs** — never launch a long cron in a naked console (SIGHUP orphans a `running` row); use
   `tmux` or `nohup … & disown`. Full per-job failure-mode runbook is in `deploy-instructions.md`.

**Required env:** discrete `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` (what `db.js` actually
reads — *not* `DATABASE_URL`, despite `deploy-instructions.md`), `OXYLABS_USERNAME`, `OXYLABS_PASSWORD`. Optional/feature:
`SLACK_WEBHOOK_URL`, `SLACK_BOT_TOKEN`/`SLACK_REVIEW_CHANNEL`/`SLACK_ALLOWED_REACTORS`, `DHASH_THRESHOLD`,
`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `MAX_OXY_CALLS` (sold-match, set 8000), `SOLD_MATCH_BRIDGE`,
`RECHECK_BRIDGE_FINAL_ONLY`, `SOLD_BATCH_CONC`, `STEEL_API_KEY` (ad-cost).
