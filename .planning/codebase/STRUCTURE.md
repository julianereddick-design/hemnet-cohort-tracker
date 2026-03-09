# Codebase Structure

**Analysis Date:** 2026-03-09

## Directory Layout

```
hemnet-cohort-tracker/
├── .github/
│   └── workflows/
│       └── cohort-automation.yml   # GitHub Actions backup runner
├── .planning/
│   └── codebase/                   # GSD analysis documents
├── node_modules/                   # Dependencies (gitignored)
├── .env                            # Database credentials (gitignored)
├── .env.example                    # Template for env vars
├── .gitignore                      # Ignore rules
├── package.json                    # Project manifest
├── package-lock.json               # Dependency lockfile
│
├── db.js                           # Shared DB connection factory
├── cron-wrapper.js                 # Cron job execution harness
│
├── cohort-setup.js                 # DDL: create cohort tables
├── cron-setup.js                   # DDL: create cron_job_log table
│
├── cohort-create.js                # [CRON] Weekly cohort creation
├── cohort-track.js                 # [CRON] Daily view tracking
├── sfpl-region-snapshot.js         # [CRON] Daily SFPL snapshot
│
├── cohort-report.js                # [MANUAL] View accumulation report
├── cohort-views-report.js          # [MANUAL] Enhanced views report (per-listing-day)
├── cohort-summary.js               # [MANUAL] Quick SQL summary
├── cohort-backfill.js              # [MANUAL] Rebuild daily_views from historical data
├── export-cohort-csv.js            # [MANUAL] Export cohort to CSV
├── cron-health.js                  # [MANUAL] Console health check
├── cron-health-slack.js            # [MANUAL] Slack health report
├── sfpl-region-analysis.js         # [MANUAL] SFPL ratio analysis
│
└── cohort-2026-W09-views.csv       # Generated CSV export (not committed)
```

## Directory Purposes

**Root (`/`):**
- Purpose: All source code lives here -- flat structure, no subdirectories for source
- Contains: All `.js` scripts, config files, package manifest
- Key files: `db.js` (shared by all), `cron-wrapper.js` (shared by cron scripts)

**`.github/workflows/`:**
- Purpose: GitHub Actions workflow definitions
- Contains: `cohort-automation.yml` -- backup cron runner and manual dispatch
- Key files: `cohort-automation.yml`

**`.planning/codebase/`:**
- Purpose: GSD analysis and planning documents
- Contains: Architecture, structure, and other analysis markdown files
- Generated: Yes (by GSD tools)
- Committed: Yes

## Key File Locations

**Entry Points:**
- `cohort-track.js`: Primary daily data collection script
- `cohort-create.js`: Weekly cohort creation script
- `sfpl-region-snapshot.js`: Daily SFPL data collection script

**Configuration:**
- `.env`: Database connection credentials (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL)
- `.env.example`: Template showing required env vars
- `package.json`: npm scripts for common operations

**Core Logic:**
- `db.js`: Database connection factory (used by every script)
- `cron-wrapper.js`: Execution harness with retry, logging, validation, alerting

**Schema:**
- `cohort-setup.js`: Defines `cohorts`, `cohort_pairs`, `cohort_daily_views`, `cohort_unmatched` tables
- `cron-setup.js`: Defines `cron_job_log` table
- `sfpl-region-snapshot.js`: Contains inline `CREATE TABLE IF NOT EXISTS` for `sfpl_region_daily`

**Reporting:**
- `cohort-report.js`: Original cohort report with county breakdowns and H/B ratios
- `cohort-views-report.js`: Enhanced report with per-listing-day cumulative and incremental views
- `sfpl-region-analysis.js`: Daily and 7-day rolling SFPL ratio tables

**Monitoring:**
- `cron-health.js`: CLI health check (queries `cron_job_log`, flags issues)
- `cron-health-slack.js`: Sends formatted health report to Slack

**Data Operations:**
- `cohort-backfill.js`: Rebuilds `cohort_daily_views` from `booli_historicallisting`/`hemnet_historicallistingv2`
- `export-cohort-csv.js`: Exports pair view data to CSV file

## Naming Conventions

**Files:**
- `{domain}-{action}.js`: e.g., `cohort-track.js`, `cohort-create.js`, `sfpl-region-snapshot.js`
- `{domain}-{qualifier}-{action}.js`: e.g., `sfpl-region-analysis.js`, `cron-health-slack.js`
- Lowercase kebab-case for all script files
- Shared modules use simple names: `db.js`, `cron-wrapper.js`

**npm Scripts (in `package.json`):**
- `setup`: `node cohort-setup.js`
- `create`: `node cohort-create.js`
- `track`: `node cohort-track.js`
- `report`: `node cohort-report.js`
- `setup-cron`: `node cron-setup.js`
- `health`: `node cron-health.js`
- `views-report`: `node cohort-views-report.js`

**Database Tables:**
- Cohort domain: `cohorts`, `cohort_pairs`, `cohort_daily_views`, `cohort_unmatched`
- SFPL domain: `sfpl_region_daily`
- Infrastructure: `cron_job_log`
- Source tables (external): `booli_listing`, `hemnet_listingv2`, `booli_historicallisting`, `hemnet_historicallistingv2`

## Where to Add New Code

**New Cron-Scheduled Script:**
- Create `{domain}-{action}.js` in root directory
- Use the cron wrapper pattern:
  ```javascript
  const { runJob } = require('./cron-wrapper');
  async function main(client, log) { /* ... */ return summary; }
  runJob({
    scriptName: '{domain}-{action}',
    main,
    validate: (summary) => { /* return warning string or null */ },
  });
  ```
- Add to `SCRIPTS` array in `cron-health.js` and `cron-health-slack.js`
- Add crontab entry on Droplet

**New Manual/Report Script:**
- Create `{domain}-{action}.js` in root directory
- Use direct DB pattern:
  ```javascript
  const { createClient } = require('./db');
  async function run() {
    const client = createClient();
    await client.connect();
    // ... logic ...
    await client.end();
  }
  run().catch(err => { console.error('Error:', err.message); process.exit(1); });
  ```
- Optionally add npm script in `package.json`

**New Database Table:**
- Add `CREATE TABLE IF NOT EXISTS` statement to `cohort-setup.js` (cohort domain) or create a new `{domain}-setup.js`
- If the table is created inline (like `sfpl_region_daily` in `sfpl-region-snapshot.js`), include `CREATE TABLE IF NOT EXISTS` at the start of the main function

**New Shared Utility:**
- Create in root directory (e.g., `utils.js` or `{purpose}.js`)
- Export via `module.exports`
- Note: `median()`, `mean()`, `percentile()` are currently duplicated across `cohort-report.js` and `cohort-views-report.js` -- a shared stats utility would reduce duplication

**New GitHub Actions Workflow:**
- Add to `.github/workflows/`
- Follow pattern in `cohort-automation.yml`: checkout, setup-node, npm install, run script with env secrets

## Special Directories

**`node_modules/`:**
- Purpose: npm dependency tree
- Generated: Yes (via `npm install`)
- Committed: No (gitignored)

**`.planning/`:**
- Purpose: GSD planning and analysis documents
- Generated: Yes (by GSD mapping tools)
- Committed: Yes

**`.github/workflows/`:**
- Purpose: GitHub Actions CI/CD definitions
- Generated: No (manually authored)
- Committed: Yes

## Database Schema Reference

**Owned Tables (created by this project):**

| Table | Primary Key | Created By |
|-------|-------------|------------|
| `cohorts` | `cohort_id` (TEXT, e.g. "2026-W10") | `cohort-setup.js` |
| `cohort_pairs` | `id` (SERIAL), UNIQUE(cohort_id, booli_id, hemnet_id) | `cohort-setup.js` |
| `cohort_daily_views` | `id` (SERIAL), UNIQUE(pair_id, date) | `cohort-setup.js` |
| `cohort_unmatched` | `id` (SERIAL) | `cohort-setup.js` |
| `sfpl_region_daily` | (snapshot_date, region, age_bucket) composite | `sfpl-region-snapshot.js` (inline) |
| `cron_job_log` | `id` (SERIAL), indexed on (script_name, started_at DESC) | `cron-setup.js` |

**External Source Tables (populated by scraping, read-only by this project):**

| Table | Used By |
|-------|---------|
| `booli_listing` | `cohort-create.js`, `cohort-track.js`, `sfpl-region-snapshot.js` |
| `hemnet_listingv2` | `cohort-create.js`, `cohort-track.js`, `sfpl-region-snapshot.js` |
| `booli_historicallisting` | `cohort-backfill.js` |
| `hemnet_historicallistingv2` | `cohort-backfill.js` |

---

*Structure analysis: 2026-03-09*
