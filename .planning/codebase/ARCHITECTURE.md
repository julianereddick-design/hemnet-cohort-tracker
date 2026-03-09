# Architecture

**Analysis Date:** 2026-03-09

## Pattern Overview

**Overall:** Flat script-based architecture with shared database layer and cron job orchestration wrapper

**Key Characteristics:**
- All scripts are standalone Node.js CLI programs in the project root
- No web server or API layer -- all scripts connect directly to a remote PostgreSQL database
- Two distinct analytical domains coexist: cohort tracking (Hemnet vs Booli views) and SFPL ratio analysis
- Cron-scheduled scripts use a shared wrapper (`cron-wrapper.js`) that provides retry, logging, validation, and alerting
- Manual/ad-hoc scripts connect to the DB directly via `db.js` without the cron wrapper

## Layers

**Database Connection (`db.js`):**
- Purpose: Single factory function for PostgreSQL client creation
- Location: `db.js`
- Contains: `createClient()` function using `pg.Client` with SSL, env-based config, 10s connection timeout
- Depends on: `dotenv`, `pg`, environment variables (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME)
- Used by: Every script in the project

**Cron Job Wrapper (`cron-wrapper.js`):**
- Purpose: Resilient execution harness for scheduled scripts -- provides DB retry, job logging, validation, Slack alerts
- Location: `cron-wrapper.js`
- Contains: `runJob({ scriptName, main, validate })` function, `connectWithRetry()`, `sendSlackAlert()`, `makeLogger()`
- Depends on: `db.js`, `cron_job_log` table
- Used by: `cohort-track.js`, `cohort-create.js`, `sfpl-region-snapshot.js`
- Pattern: Each cron script exports nothing -- it calls `runJob()` at module level with a `main(client, log)` function and optional `validate(summary)` callback

**Cron-Scheduled Scripts (automated):**
- Purpose: Data collection that runs on schedule via Droplet crontab
- Location: `cohort-track.js`, `cohort-create.js`, `sfpl-region-snapshot.js`
- Contains: Business logic wrapped in `runJob()` calls
- Depends on: `cron-wrapper.js`
- Invoked by: Droplet crontab (primary) and GitHub Actions (backup for cohort-track)

**Manual/Ad-hoc Scripts (analyst-run):**
- Purpose: Reporting, backfilling, data export, health checks
- Location: `cohort-report.js`, `cohort-views-report.js`, `cohort-summary.js`, `cohort-backfill.js`, `export-cohort-csv.js`, `cron-health.js`, `cron-health-slack.js`, `sfpl-region-analysis.js`
- Contains: Direct `createClient()` calls with own connect/end lifecycle
- Depends on: `db.js` directly (no cron wrapper)
- Invoked by: User running `node <script>.js [args]` locally

**Schema Setup:**
- Purpose: DDL scripts to create/initialize database tables
- Location: `cohort-setup.js` (cohort tables), `cron-setup.js` (cron_job_log table)
- Contains: `CREATE TABLE IF NOT EXISTS` statements
- Run once manually during initial setup

## Data Flow

**Weekly Cohort Creation (Monday 06:00 UTC):**

1. `cohort-create.js` runs via cron wrapper
2. Queries `booli_listing` for active, non-pre-market listings in target counties (Stockholm, VG, Skane, Uppsala) listed in the previous week
3. For each Booli listing, queries `hemnet_listingv2` to find matching listing by postcode + street address + date proximity (+/- 7 days)
4. Creates `cohorts` row, inserts matched pairs into `cohort_pairs`, unmatched into `cohort_unmatched`
5. Records day-0 view snapshots for all pairs in `cohort_daily_views`

**Daily View Tracking (20:00 + 23:00 UTC):**

1. `cohort-track.js` runs via cron wrapper
2. Finds active cohorts (within 44-day window)
3. For each pair in each cohort, computes `day` number from `booli_listed` to today
4. Reads current `times_viewed` from `booli_listing` and `hemnet_listingv2` (source tables managed by external scraping process)
5. Inserts delta (views - day0_views) into `cohort_daily_views`
6. Detects and records dropped listings (went inactive)
7. `ON CONFLICT (pair_id, date) DO NOTHING` provides idempotent duplicate protection

**SFPL Snapshot (08:00 + 12:00 UTC):**

1. `sfpl-region-snapshot.js` runs via cron wrapper
2. Queries `booli_listing` for pre-market listings grouped by county and age bucket
3. Queries `hemnet_listingv2` for active for-sale listing counts by county
4. Aggregates into 3 regions (Stockholm, VG, Rest) x 6 age buckets
5. Upserts 18 rows into `sfpl_region_daily`

**State Management:**
- All state lives in PostgreSQL (DigitalOcean managed database)
- No local state files -- scripts are stateless
- Source tables (`booli_listing`, `hemnet_listingv2`, `booli_historicallisting`, `hemnet_historicallistingv2`) are populated by an external scraping process outside this repo
- Cohort tables (`cohorts`, `cohort_pairs`, `cohort_daily_views`, `cohort_unmatched`) are owned by this project
- `sfpl_region_daily` is owned by this project
- `cron_job_log` tracks execution history for all cron scripts

## Key Abstractions

**Cron Job Contract:**
- Purpose: Standardized interface for any scheduled script
- Examples: `cohort-track.js`, `cohort-create.js`, `sfpl-region-snapshot.js`
- Pattern: Call `runJob({ scriptName, main, validate })` where:
  - `main(client, log)` receives a connected pg Client and structured logger, returns a summary object
  - `validate(summary)` returns a warning string or null
  - Wrapper handles: connection retry (3x exponential backoff), 120s statement timeout, `cron_job_log` insert/update, Slack alerting on failure/warning, process exit codes

**Cohort Pair:**
- Purpose: A matched Booli + Hemnet listing for the same property in the same week
- Examples: Rows in `cohort_pairs` table
- Pattern: Matching is address-based (postcode + street address, case-insensitive) with +/- 7 day date tolerance

**Day Calculation:**
- Purpose: Track how views accumulate over a listing's lifetime
- Pattern: `dayNum = daysBetween(pair.booli_listed, today)` -- computed per-pair from individual listing date, not from cohort week_start

## Entry Points

**Cron-scheduled (Droplet):**
- `cohort-track.js`: Daily view tracking. Triggers: crontab 20:00 + 23:00 UTC
- `cohort-create.js`: Weekly cohort creation. Triggers: crontab Mon 06:00 UTC
- `sfpl-region-snapshot.js`: Daily SFPL snapshot. Triggers: crontab 08:00 + 12:00 UTC

**GitHub Actions:**
- `.github/workflows/cohort-automation.yml`: Backup runner for cohort-track (daily 20:00 UTC), manual dispatch for create/report

**Manual CLI:**
- `node cohort-report.js [cohort_id]`: View accumulation report with county breakdowns
- `node cohort-views-report.js [cohort_id]`: Enhanced views report with per-listing-day and incremental tables
- `node cohort-summary.js`: Quick SQL-based summary for hardcoded cohort (2026-W09)
- `node cohort-backfill.js [cohort_id]`: Rebuild daily_views from historical snapshot tables
- `node export-cohort-csv.js [cohort_id]`: Export cohort view data to CSV
- `node cron-health.js [--days N]`: Console health check of cron job logs
- `node cron-health-slack.js`: Send health report to Slack
- `node sfpl-region-analysis.js`: Daily and 7-day rolling SFPL ratio analysis

**Setup (run once):**
- `node cohort-setup.js`: Create cohort tables
- `node cron-setup.js`: Create cron_job_log table

## Error Handling

**Strategy:** Two-tier -- cron wrapper provides robust error handling for scheduled scripts; manual scripts use simple try/catch with process.exit(1)

**Patterns:**
- Cron wrapper: `connectWithRetry()` with 3 retries and exponential backoff (1s, 2s, 4s). Statement timeout 120s. Uncaught exception/rejection handlers that update `cron_job_log` before exiting
- Cron wrapper validation: `validate(summary)` callback returns warning strings for anomalies (e.g., 0 pairs tracked, unexpected row counts). Warnings are logged and trigger Slack alerts
- Manual scripts: `run().catch(err => { console.error(err.message); process.exit(1); })`
- Duplicate protection: All insert operations use `ON CONFLICT ... DO NOTHING` for idempotent re-runs
- Dropped listing detection: `cohort-track.js` marks listings as dropped when they become inactive, skipping them in future runs

## Cross-Cutting Concerns

**Logging:** Cron wrapper provides `makeLogger(scriptName)` with ISO timestamps and level tags (`[INFO]`, `[ERROR]`, `[WARN]`). Manual scripts use bare `console.log`/`console.error`.

**Validation:** Cron wrapper `validate` callback pattern. Each script defines what constitutes a "warning" result (e.g., 0 tracked pairs, wrong row count). No input validation beyond basic null checks.

**Authentication:** Database connection via environment variables loaded from `.env` by `dotenv`. SSL required (`rejectUnauthorized: false`). No application-level auth (scripts run locally or on trusted Droplet).

**Alerting:** Slack webhook integration in `cron-wrapper.js` (sends on failure/warning). Standalone `cron-health-slack.js` for daily digest reports. Both require `SLACK_WEBHOOK_URL` env var.

---

*Architecture analysis: 2026-03-09*
