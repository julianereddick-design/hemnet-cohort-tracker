# Deploy Instructions for Hemnet Cohort Tracker

The droplet has a git clone at `/opt/hemnet-cohort-tracker/`. Cron jobs run from that directory. All scheduled scripts require `cron-wrapper.js` directly via `require('./cron-wrapper').runJob` — there is no CLI entry on cron-wrapper itself (cron-wrapper.js:143 exports only `runJob`).

Invocation pattern (verified at PLAN time of Plan 09-03 via `grep -l "require('./cron-wrapper')" *.js`): every cron-scheduled script — cohort-create.js, cohort-track.js, sfpl-region-snapshot.js, hemnet-targeted-refresh.js, hemnet-targeted-match.js, booli-targeted-discovery.js, **booli-targeted-refresh.js (Phase 9 / Plan 09-02)** — calls runJob at module load. The crontab MUST invoke each script directly, e.g. `node cohort-track.js`, NOT `node cron-wrapper.js cohort-track.js` (which would be a no-op require).

## Deploy code changes

1. Commit and push to `master` on GitHub
2. SSH into the droplet and pull:

```bash
cd /opt/hemnet-cohort-tracker && git pull
```

Cron jobs pick up the new code on their next run. No process restart needed.

## Environment variables

All env vars live in `/opt/hemnet-cohort-tracker/.env` and are loaded by `dotenv` at the top of every entry script. The file is gitignored — set values manually on the droplet.

Required vars (job will fail without them):
- `DATABASE_URL` — Postgres connection string for the cohort DB
- `OXYLABS_USERNAME`, `OXYLABS_PASSWORD` — for the scrape-http.js Oxylabs fallback (Jobs A, B, C, D)

Optional vars:
- `SLACK_WEBHOOK_URL` — when set, cron-wrapper.js fires an alert on any run with status='warning' or status='failure'. Without it, runs are silent. **Phase 9 requires this to be set.**

To set the Slack webhook:
```bash
ssh root@<droplet>
echo 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...' >> /opt/hemnet-cohort-tracker/.env
```

## Crontab

All times are UTC. Schedule respects:
- Every-2-days view-refresh cycle (D-06): odd days at 14:00 → 18:00 → 22:00 UTC — Job D, then Job A, then cohort-track. Four-hour gaps cover worst-case runtimes.
- Weekly cohort kickoff: Job C Sun 22:00 UTC, Job B Mon 03:00 UTC, cohort-create Mon 06:00 UTC.
- Daily SFPL ratio: sfpl-region-snapshot 08:00 UTC.
- Removed (D-07): cohort-track 23:30 UTC daily and 02:00 UTC daily — cohort-track now runs only on the every-2-days cycle.

```cron
# === v1.0 preserved jobs (D-08) — invocation pattern corrected per the runJob-direct-require contract above ===
0 6 * * 1   cd /opt/hemnet-cohort-tracker && node cohort-create.js              >> /var/log/hemnet/cohort-create.log 2>&1
0 8 * * *   cd /opt/hemnet-cohort-tracker && node sfpl-region-snapshot.js       >> /var/log/hemnet/sfpl.log 2>&1

# === Phase 9 weekly slots (D-08) ===
# Job C: weekly Booli FS discovery. Walks 4 cohort counties, UPSERTs booli_listing.
# Must finish BEFORE Job B (which reads booli_listing rows for the new week).
0 22 * * 0  cd /opt/hemnet-cohort-tracker && node booli-targeted-discovery.js   >> /var/log/hemnet/job-c.log 2>&1

# Job B: weekly Hemnet seeding. Reads new booli_listing rows, fetches matching
# Hemnet detail pages, inserts hemnet_listingv2. 3h buffer before cohort-create.
0 3 * * 1   cd /opt/hemnet-cohort-tracker && node hemnet-targeted-match.js      >> /var/log/hemnet/job-b.log 2>&1

# === Phase 9 every-2-days view-refresh cycle (D-06; D-07 removed daily cohort-track) ===
# Odd days of month: 14:00 Job D → 18:00 Job A → 22:00 cohort-track. 4h gaps.
# On 31-day months, the last fire (day 31) is followed by day 1 next month —
# a 1-day gap instead of 2. Acceptable for view tracking (D-09).
0 14 */2 * * cd /opt/hemnet-cohort-tracker && node booli-targeted-refresh.js    >> /var/log/hemnet/job-d.log 2>&1
0 18 */2 * * cd /opt/hemnet-cohort-tracker && node hemnet-targeted-refresh.js   >> /var/log/hemnet/job-a.log 2>&1
0 22 */2 * * cd /opt/hemnet-cohort-tracker && node cohort-track.js              >> /var/log/hemnet/cohort-track.log 2>&1
```

### Preserved supplementary cron lines (already live on the droplet — Phase 9 leaves these untouched)

The live droplet crontab also contains the following operational and reporting jobs added in earlier phases. Plan 09-03 does NOT modify any of these:

```cron
# Cron health monitor — daily 03:00 UTC. Aggregates cron_job_log statuses and Slack-pings on failures.
0 3 * * *   cd /opt/hemnet-cohort-tracker && node cron-health-slack.js

# Weekly reporting fan-out — Mondays 09:00 UTC and shortly after.
0 9 * * 1   cd /opt/hemnet-cohort-tracker && node listing-gap-monitor.js
0 9 * * 1   cd /opt/hemnet-cohort-tracker && node flow-monitor.js
15 9 * * 1  cd /opt/hemnet-cohort-tracker && node pool-flow-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node weekly-view-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node generate-pool-flow-charts.js
```

To update on the droplet (the actual deploy procedure — see Task 2 for the full step-by-step including the live-crontab backup BEFORE any edits, preserved from the old Plan 09-02 Task 2 safety pattern):
```bash
ssh root@<droplet>
mkdir -p /var/log/hemnet
crontab -l > /tmp/crontab-backup-$(date +%s).txt   # CRITICAL: capture live state first (rollback source of truth)
diff /tmp/crontab-backup-$(date +%s).txt deploy-instructions.md   # check for doc-vs-reality drift; if drift, fix doc FIRST
crontab -e
# paste the block above; save
crontab -l   # verify
```

## Observing jobs

1. **cron_job_log** (DB) — every cron-wrapper-wrapped run writes a row. Inspect with:
   ```bash
   cd /opt/hemnet-cohort-tracker && node scripts/verify-cron-job-log.js
   ```
   This prints the last 5 rows per script_name (cohort-create, cohort-track, sfpl-region-snapshot, hemnet-targeted-refresh, hemnet-targeted-match, booli-targeted-discovery, **booli-targeted-refresh**) with status + duration_ms + selected result_summary keys.

2. **Stdout/stderr** — written to `/var/log/hemnet/<job>.log` (one file per job). Rotate with logrotate if these grow.

3. **Slack** — `SLACK_WEBHOOK_URL` set → any warning/failure pings the channel within seconds.

## Runbook
See `## Runbook` section below (added in Plan 09-04).
