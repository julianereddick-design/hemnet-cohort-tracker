# External Integrations

**Analysis Date:** 2026-03-09

## APIs & External Services

**Slack (audience-routed, via `lib/slack-post.js`):**
- Purpose: every report/alert in the repo, routed by **audience** (business vs. ops) rather than
  by which credential a script happens to hold. `lib/slack-post.js` is the only outbound path,
  except `cron-wrapper.js`'s own failure alert (see below).
- SDK/Client: Native Node.js `https` module (no SDK), two transports:
  - `chat.postMessage` (bot token, `SLACK_BOT_TOKEN`) — the default transport for
    `postMessage(job, text)`, used by every report.
  - Incoming webhook (`SLACK_WEBHOOK_URL`) — used only as `postMessage`'s degraded fallback (if
    the bot call fails) and as the sole transport for `postAlert(text)`, `cron-wrapper.js`'s own
    job failure/warning line (kept separate deliberately so the alert path shares no failure
    mode with the bot token it reports on).
- Auth env vars:
  - `SLACK_BOT_TOKEN=xoxb-…` — scopes `chat:write` + `reactions:read`. **`files:write` is NOT
    yet added** (outstanding as of 2026-08-14; needed only by the not-yet-built market-totals
    file-delivery work, not by anything currently deployed).
  - `SLACK_STATUS_CHANNEL` — business audience channel, `#hemnet-status` (`C0B9X2WDC4C`).
  - `SLACK_OPS_CHANNEL` — ops audience channel, `#hemnet-ops` (`C0BQ66YQX8S`, created
    2026-08-14).
  - `SLACK_WEBHOOK_URL` — created against `#hemnet-ops` (a webhook is bound to the channel it was
    created against and cannot be re-pointed in code).
  - **Retired:** `SLACK_REVIEW_CHANNEL` (honoured only as `SLACK_OPS_CHANNEL`'s fallback while
    unset) and `SOLD_MATCH_SLACK_CHANNEL` (dropped outright — do not reintroduce a per-job
    channel override; every job routes through the shared `AUDIENCE` table).
- Routing table: `AUDIENCE` in `lib/slack-post.js` — job name → `business`/`ops`, resolved to a
  channel id. A job absent from the table throws at call time. Full audience list:
  `docs/handover/04-REPORTING-AND-SLACK.md` §1.
- Implementation: `lib/slack-post.js` (`postMessage`, `postAlert`, `resolveChannel`,
  `isDryRun`); `lib/spotcheck-slack-bot.js` (retained for review-message + reaction-reading
  mechanics only — `postReviewMessage`, `getReactions` — channel resolution moved to
  `lib/slack-post.js`); `cron-wrapper.js` (`postAlert` on failure/warning); `cron-health-slack.js`
  (daily health digest, ops).
- Dry-run: every reporter accepts `--dry-run` (or `SLACK_DRY_RUN=1`/`DRY_RUN=1`), which renders
  to stdout and makes no network call. `dotenv.config()` re-injects `SLACK_BOT_TOKEN` /
  `SLACK_WEBHOOK_URL` on every run, so `env -u VAR node …` does **not** produce a dry run — use
  `--dry-run` instead. With no `SLACK_BOT_TOKEN`, `postMessage` falls back to the webhook rather
  than skipping, so a bare local run (no flag) on a machine whose `.env` carries
  `SLACK_WEBHOOK_URL` will post for real.
- Request timeout: 10,000ms (both transports)

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
- `SLACK_WEBHOOK_URL` - Slack incoming webhook; created against `#hemnet-ops`, used as
  `postAlert`'s sole transport and `postMessage`'s degraded fallback (see Slack entry above)
- `SLACK_BOT_TOKEN`, `SLACK_STATUS_CHANNEL`, `SLACK_OPS_CHANNEL` - business/ops audience routing
  (see Slack entry above). `SLACK_REVIEW_CHANNEL` and `SOLD_MATCH_SLACK_CHANNEL` are retired.

**Secrets location:**
- `.env` file at project root (local development)
- `.env` file at `/opt/hemnet-cohort-tracker/.env` (production Droplet)
- DO API token in `update-db-access.sh` (parent directory)

## Webhooks & Callbacks

**Incoming:**
- None - No HTTP server, no incoming webhooks

**Outgoing:**
- Slack webhook POST on cron job failure/warning (`cron-wrapper.js` `postAlert`) — the one path
  that stays webhook-only by design.
- Slack `chat.postMessage` (bot token) for every other report, routed by audience via
  `lib/slack-post.js` — daily health digest (`cron-health-slack.js`), weekly business reports,
  and the spot-check review queue. See the Slack entry above for the full routing table.

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
