# External Integrations

**Analysis Date:** 2026-03-09

## APIs & External Services

**Slack (Incoming Webhook):**
- Purpose: Alert on cron job failures and warnings
- SDK/Client: Native Node.js `https` module (no SDK)
- Auth: `SLACK_WEBHOOK_URL` env var (not yet configured on production Droplet)
- Implementation: `cron-wrapper.js` lines 32-55 (auto-alert on failure/warning), `cron-health-slack.js` (daily health digest)
- Request timeout: 10,000ms

**DigitalOcean API:**
- Purpose: Update database firewall trusted sources (whitelist current IP)
- SDK/Client: Bash `curl` in `update-db-access.sh`
- Auth: DO API token hardcoded in shell script
- Endpoint: Database cluster firewall rules update

**No other external APIs are called.** The project reads from database tables (`booli_listing`, `hemnet_listingv2`) that are populated by separate scrapers outside this codebase.

## Data Storage

**Database:**
- Type: PostgreSQL (managed)
- Provider: DigitalOcean Managed Database
- Connection: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` env vars
- Port: 25060 (DO managed DB default, SSL required)
- Client: `pg` npm package, using `Client` class (not connection pooling)
- SSL: Enabled with `rejectUnauthorized: false`

**Database Tables (owned by this project):**

| Table | Purpose | Created by |
|-------|---------|------------|
| `cohorts` | One row per weekly cohort (cohort_id, week_start, week_end) | `cohort-setup.js` |
| `cohort_pairs` | Matched Booli+Hemnet listing pairs per cohort | `cohort-setup.js` |
| `cohort_daily_views` | Daily view snapshots per pair (day 0-30) | `cohort-setup.js` |
| `cohort_unmatched` | Booli listings that failed to match a Hemnet listing | `cohort-setup.js` |
| `sfpl_region_daily` | Daily SFPL ratio snapshots by region and age bucket | `sfpl-region-snapshot.js` (auto-creates) |
| `cron_job_log` | Execution log for all cron jobs | `cron-setup.js` |

**Database Tables (read-only, populated by external scrapers):**

| Table | Purpose | Key columns used |
|-------|---------|-----------------|
| `booli_listing` | Booli property listings | `booli_id`, `title`, `street_address`, `postcode`, `municipality`, `county`, `listed`, `times_viewed`, `is_active`, `is_pre_market`, `removed` |
| `hemnet_listingv2` | Hemnet property listings | `hemnet_id`, `street_address`, `postcode`, `municipality`, `county`, `listed`, `times_viewed`, `is_active`, `is_pre_market` |

**File Storage:**
- Local filesystem only (CSV export via `export-cohort-csv.js`)
- Output: `cohort-{cohort_id}-views.csv`

**Caching:**
- None

## Authentication & Identity

**Auth Provider:**
- Not applicable - No user-facing application, no authentication layer
- Database access via username/password in `.env`

## Monitoring & Observability

**Error Tracking:**
- Custom `cron_job_log` database table tracks every script execution with status, duration, error messages, and result summaries (JSONB)
- `cron-wrapper.js` provides structured logging, DB retry with exponential backoff (3 attempts), uncaught exception handling, and Slack alerting

**Logs:**
- Console stdout/stderr with structured format: `[ISO_TIMESTAMP] [LEVEL] script_name: message`
- Levels: INFO, WARN, ERROR
- Log output captured by system cron on Droplet

**Health Monitoring:**
- `cron-health.js` - CLI tool, queries `cron_job_log` and detects: missing runs, failures, warnings, anomalous results (e.g., 0 pairs tracked)
- `cron-health-slack.js` - Same checks but sends formatted Slack digest
- Validates expected row counts (e.g., sfpl-region-snapshot expects exactly 18 rows)

## CI/CD & Deployment

**Hosting:**
- DigitalOcean Droplet
- Deploy path: `/opt/hemnet-cohort-tracker`
- Manual deployment via file copy (no automated CI/CD pipeline)

**CI Pipeline:**
- None - Manual deployment

**Cron Schedule (on Droplet):**
| Script | Schedule (UTC) | Purpose |
|--------|---------------|---------|
| `cohort-track.js` | 20:00 daily + 21:15 backup | Track daily views for active cohort pairs |
| `cohort-create.js` | Mon 06:00 weekly | Create new weekly cohort |
| `sfpl-region-snapshot.js` | 08:00 daily + 12:00 backup | SFPL ratio daily snapshot |

**Git:**
- GitHub repo: `julianereddick-design/hemnet-cohort-tracker` (public)

## Environment Configuration

**Required env vars:**
- `DB_HOST` - PostgreSQL hostname
- `DB_PORT` - PostgreSQL port (25060)
- `DB_USER` - Database username
- `DB_PASSWORD` - Database password
- `DB_NAME` - Database name

**Optional env vars:**
- `SLACK_WEBHOOK_URL` - Slack incoming webhook for alerts

**Secrets location:**
- `.env` file at project root (local development)
- `.env` file at `/opt/hemnet-cohort-tracker/.env` (production Droplet)
- DO API token in `update-db-access.sh` (parent directory)

## Webhooks & Callbacks

**Incoming:**
- None - No HTTP server, no incoming webhooks

**Outgoing:**
- Slack webhook POST on cron job failure/warning (`cron-wrapper.js`)
- Slack webhook POST for daily health digest (`cron-health-slack.js`)

## Data Flow Summary

```
External scrapers (separate codebase)
    │
    ▼
┌──────────────────────────┐
│  booli_listing           │  ← Populated externally
│  hemnet_listingv2        │  ← Populated externally
└──────────────────────────┘
    │
    │ Read by cohort-create.js (weekly)
    ▼
┌──────────────────────────┐
│  cohorts                 │
│  cohort_pairs            │  ← Matched Booli+Hemnet pairs
│  cohort_unmatched        │
└──────────────────────────┘
    │
    │ Read by cohort-track.js (daily)
    ▼
┌──────────────────────────┐
│  cohort_daily_views      │  ← Day 0-30 view snapshots
└──────────────────────────┘
    │
    │ Read by report/analysis scripts
    ▼
  Console output / CSV export

External scrapers → booli_listing / hemnet_listingv2
    │
    │ Read by sfpl-region-snapshot.js (daily)
    ▼
┌──────────────────────────┐
│  sfpl_region_daily       │  ← SFPL ratio snapshots
└──────────────────────────┘
    │
    │ Read by sfpl-region-analysis.js
    ▼
  Console output (ratio tables)
```

---

*Integration audit: 2026-03-09*
