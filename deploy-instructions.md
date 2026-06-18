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

Phase 13 vars (required for the image-confirmation + review-loop go-live):
- `SLACK_BOT_TOKEN=xoxb-…` — Slack bot OAuth token for posting review-queue messages and reading reactions (`chat:write` + `reactions:read` scopes). Obtained by following `SLACK-REVIEW-SETUP.md`. **Separate from `SLACK_WEBHOOK_URL`** — the webhook stays for Phase 12 threshold/fetch-failure alerts; the bot token is used only by `cohort-spotcheck-gate.js` and `spotcheck-reaction-poller.js`.
- `SLACK_REVIEW_CHANNEL=C0……` — Slack channel id (not name) for the review queue. The bot must be invited to this channel (`/invite @<bot-name>`).
- `SLACK_ALLOWED_REACTORS=U0……` — comma-separated Slack user id(s) authorised to confirm removals via emoji reaction. **REQUIRED before trusting auto-removal.** Without it, the poller falls back to accepting reactions from ALL users (documented first-run fallback only). Set to the operator's own Slack user id at go-live.
- `DHASH_THRESHOLD=6` — (default: 6) dHash distance threshold for auto-confirming a shared-image match. Do not raise without reviewing the per-pair minDist distribution from several gate runs (see Phase 13 runbook below).

Phase 19 (v3.1) — Sold match batch vars (for `sold-match-batch.js`):
- `DATABASE_URL` — already required (above); the batch reuses the cron-wrapper pg client. No separate var.
- `OXYLABS_USERNAME` / `OXYLABS_PASSWORD` — already required (above); the batch forces the Oxylabs transport (`SCRAPE_FORCE_OXYLABS=1` is the orchestrator's first line). No separate var.
- `MAX_OXY_CALLS` — the **batch-wide Oxylabs ceiling** (one `setSpendClient` governs the whole run). Cost model: ~1000 sampled records + the re-check drain (~50% reaching the SERP bridge) ≈ ~3–6k calls/run → ~7–13k/month (mid ~9k). Set **`MAX_OXY_CALLS=8000`** — high enough to complete a full fortnight, low enough to be a real hard cap (D-17). NOTE: the `lib/sold-transport.js` DEFAULT is **4000** (too low for the full batch) → set it explicitly in `.env`.
- `SOLD_MATCH_BRIDGE` — **default-on**; the orchestrator sets it to `'1'` itself (D-05), so both the first-pass match and the re-check `matchOne` use the SERP /bostad bridge. Document the opt-out as `SOLD_MATCH_BRIDGE=0` (disables the bridge entirely — only for debugging).
- `RECHECK_BRIDGE_FINAL_ONLY` — **default OFF** cost lever (D-16). When `=1`, the re-check drain skips the SERP bridge on INTERMEDIATE re-attempts and runs it only on the FINAL attempt before settle (~mid 9k → ~6k calls/month). Leave **OFF** for the full-fidelity drain; flip to `1` only as a deliberate cost lever. Validated by `boolEnv` (only `1`/`true`/`0`/`false` honored; a typo falls back to OFF).
- `SOLD_BATCH_FETCH_FAIL_THRESHOLD` — (default: 5) optional. Number of sampler fetch failures above which `validate()` escalates to Slack. Raise only if transient Booli fetch noise is expected.
- `SLACK_WEBHOOK_URL` — already documented (above); the batch's `validate()` escalations post here via cron-wrapper (the **same webhook** as Phase 12 — NOT the `SLACK_BOT_TOKEN`).

To set the Slack webhook:
```bash
ssh root@<droplet>
echo 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...' >> /opt/hemnet-cohort-tracker/.env
```

## Crontab

All times are UTC. Schedule respects:
- Every-2-days view-refresh cycle (D-06 + D-17): odd days at 14:00 UTC (Job D and Job A in PARALLEL per 09-02 D-17) → 22:00 UTC cohort-track. Combined Oxylabs load at parallel start is ~4% of the 50/sec cap (09-02 analysis); each job opens its own pg.Client so no DB pool contention. Eight-hour gap to cohort-track covers worst-case runtimes (Job D ~30-60 min, Job A ~33-51 min with Oxylabs fallback headroom).
- Weekly cohort kickoff: Job C Sun 22:00 UTC, Job B Mon 03:00 UTC, cohort-create Mon 06:00 UTC.
- Daily SFPL ratio: sfpl-region-snapshot 08:00 UTC.
- Removed (D-07): cohort-track 23:30 UTC daily and 02:00 UTC daily — cohort-track now runs only on the every-2-days cycle.

```cron
# === v1.0 preserved jobs (D-08) — invocation pattern corrected per the runJob-direct-require contract above ===
0 6 * * 1   cd /opt/hemnet-cohort-tracker && node cohort-create.js              >> /var/log/hemnet/cohort-create.log 2>&1

# === Phase 12 — Weekly cohort spot-check QA gate (Mon 06:30 UTC, immediately after cohort-create) ===
# Runs 30 min after cohort-create to let cohort-create finish. Samples the new cohort, adjudicates
# Booli↔Hemnet pair quality (Mode A — deterministic, no Anthropic API), computes the confirmed
# false-match rate + Wilson 95% CI by county, writes VERDICTS + SUMMARY artifacts, and logs to
# cron_job_log. Escalates to Slack if rate > 5% OR if any Hemnet fetch failed.
30 6 * * 1  cd /opt/hemnet-cohort-tracker && node cohort-spotcheck-gate.js     >> /var/log/hemnet/spotcheck-gate.log 2>&1

# === Phase 19 (v3.1) — Sold match batch (weekly cron, FORTNIGHTLY effect, Mon 07:30 UTC) ===
# sold-match-batch.js runs the whole sold-match pipeline in ONE process: calls the national
# population-weighted sampler (config/sold-panel.json) for a de-duped ~1000-record 14-day sample,
# matches each record against Hemnet, then runs the Phase-18 re-check drain, all under ONE
# batch-wide Oxylabs ceiling (MAX_OXY_CALLS). The line fires WEEKLY but the orchestrator no-ops
# on ODD ISO weeks (even-week gate) → effective FORTNIGHTLY cadence. Fails safe: validate()
# escalates to Slack on ceiling/fatal/incomplete rather than logging a partial run as success.
# Slot 07:30 UTC clears cohort-create (06:00), cohort-spotcheck-gate (06:30), Job B (03:00),
# market-totals (08:30). Logs to cron_job_log + the log file below.
30 7 * * 1  cd /opt/hemnet-cohort-tracker && node sold-match-batch.js        >> /var/log/hemnet/sold-match-batch.log 2>&1

0 8 * * *   cd /opt/hemnet-cohort-tracker && node sfpl-region-snapshot.js       >> /var/log/hemnet/sfpl.log 2>&1

# === Phase 9 weekly slots (D-08) ===
# Job C: weekly Booli FS discovery. Walks 4 cohort counties, UPSERTs booli_listing.
# Must finish BEFORE Job B (which reads booli_listing rows for the new week).
0 22 * * 0  cd /opt/hemnet-cohort-tracker && node booli-targeted-discovery.js   >> /var/log/hemnet/job-c.log 2>&1

# Job B: weekly Hemnet seeding. Reads new booli_listing rows, fetches matching
# Hemnet detail pages, inserts hemnet_listingv2. 3h buffer before cohort-create.
0 3 * * 1   cd /opt/hemnet-cohort-tracker && node hemnet-targeted-match.js      >> /var/log/hemnet/job-b.log 2>&1

# === Phase 9 every-2-days view-refresh cycle (D-06 + D-17 parallel; D-07 removed daily cohort-track) ===
# Odd days of month: 14:00 Job D + Job A PARALLEL (D-17 amends D-06) → 22:00 cohort-track.
# Combined parallel load is ~4% of Oxylabs 50/sec cap (09-02 analysis); each job opens
# its own pg.Client so no DB pool contention. 8h gap to cohort-track covers worst case.
# On 31-day months, the last fire (day 31) is followed by day 1 next month —
# a 1-day gap instead of 2. Acceptable for view tracking (D-09).
0 14 */2 * * cd /opt/hemnet-cohort-tracker && node booli-targeted-refresh.js    >> /var/log/hemnet/job-d.log 2>&1
0 14 */2 * * cd /opt/hemnet-cohort-tracker && node hemnet-targeted-refresh.js   >> /var/log/hemnet/job-a.log 2>&1
0 22 */2 * * cd /opt/hemnet-cohort-tracker && node cohort-track.js              >> /var/log/hemnet/cohort-track.log 2>&1
```

```cron
# === Phase 11 (v2.2) — Daily market-totals capture (08:30 UTC) ===
# market-totals-daily.js fetches Hemnet (1 req — both segments via one __NEXT_DATA__) +
# Booli (2 reqs — one per segment, filtered ?upcomingSale=0|1). 3 Oxylabs reqs/day total.
# Writes 4 rows/day into market_totals. Cron-wrapped: Slack alerts on failure/warning;
# silent on success by design (weekly-report consumer surfaces values on Mondays).
# Slot rationale: 30-min buffer after sfpl-region-snapshot (08:00 UTC, DB-only, finishes
# in seconds), clear of every-2-days view-refresh (14:00/18:00/22:00 odd days), clear of
# Mon-morning fan-out (09:00-09:30).
30 8 * * *  cd /opt/hemnet-cohort-tracker && node market-totals-daily.js       >> /var/log/hemnet/market-totals.log 2>&1

# Phase 11 (v2.2) — Weekly market-supply Slack pulse (Mondays 09:35 UTC).
# market-totals-weekly-report.js reads market_totals for (today, today-7) × {hemnet, booli}
# × segment='till_salu', renders the locked Slack format, and posts to SLACK_WEBHOOK_URL.
# Slot rationale: 5 minutes AFTER weekly-view-report.js (09:30 UTC). weekly-view-report
# runs in well under 5 min (DB-only, no scrape), so 09:35 is a clean sequential slot.
# First valid run is >= 7 days post-deploy; earlier runs render "?" in delta cells.
35 9 * * 1  cd /opt/hemnet-cohort-tracker && node market-totals-weekly-report.js >> /var/log/hemnet/market-totals-weekly.log 2>&1
```

```cron
# === Phase 13 — Image confirmation + review loop (go-live with Phase 13, implements D-14) ===
# The Phase 12 weekly gate line (Mon 06:30 UTC above) now does useful work: dHash shared-image
# check + advisory Claude vision on suspect pairs + Slack review-queue post. D-13 guard skips
# + alerts to Slack if this week's cohort (ISO week) is not yet available.
#
# ADD the daily reaction poller (D-10). Reads ✅/❌/❓ reactions on open review messages,
# applies verdicts, audits confirmed mismatches, and hard-removes them from cohort_pairs.
0 12 * * *  cd /opt/hemnet-cohort-tracker && node spotcheck-reaction-poller.js     >> /var/log/hemnet/spotcheck-poller.log 2>&1
```

### Phase 13 go-live — step-by-step (operator checklist)

Run in order on the droplet after `git pull`:

**1. Stand up the Slack app (one-time)**

Follow `SLACK-REVIEW-SETUP.md` (committed to the repo). It covers: creating the Slack app,
adding the required OAuth scopes (`chat:write` + `reactions:read`), installing to workspace,
inviting the bot to the review channel, and smoke-testing the connection.

**2. Set env vars in `/opt/hemnet-cohort-tracker/.env` (never commit)**

```bash
# Required for Phase 13 review queue (Slack bot — separate from SLACK_WEBHOOK_URL):
SLACK_BOT_TOKEN=xoxb-…          # bot OAuth token from SLACK-REVIEW-SETUP.md step 4
SLACK_REVIEW_CHANNEL=C0……       # the Slack channel id for the review queue

# REQUIRED before trusting auto-removal. Without it, the poller falls back to allowing
# ALL reactors — document-only first-run fallback; set to your own Slack user id immediately.
SLACK_ALLOWED_REACTORS=U0……     # comma-separated Slack user id(s) authorised to confirm removals

# Optional (default is 6 — conservative near-identical threshold; do not raise until you
# have reviewed the per-pair minDist distribution from several weeks of gate logs):
# DHASH_THRESHOLD=6

# KEEP — Phase 12 threshold/fetch-failure alerts use this separate webhook path.
# SLACK_WEBHOOK_URL stays; do not remove or replace it with SLACK_BOT_TOKEN.
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…  # already set; leave as-is
```

**3. Run the migration (one-time, idempotent)**

```bash
cd /opt/hemnet-cohort-tracker && node migrate-spotcheck-phase13.js
```

Expected output:
```
Created table: spotcheck_review
Created table: spotcheck_removed_pairs
```

If the tables already exist the script exits cleanly (IF NOT EXISTS DDL — safe to re-run).

Phase 13.1 adds a second one-time migration (soft-delete columns on `cohort_pairs` —
ran 2026-06-12; idempotent, safe to re-run):

```bash
cd /opt/hemnet-cohort-tracker && node migrate-cohort-pairs-soft-delete.js
```

**4. Smoke the Slack path**

Follow step 7 in `SLACK-REVIEW-SETUP.md` (post the setup-test digest). Confirm the message
appears in the review channel and that you can add an emoji reaction.

**5. Install the daily poller crontab line**

The Phase 12 weekly gate line (Mon 06:30 UTC) is already live. ADD the new line:

```bash
crontab -l > /tmp/crontab-backup-$(date +%s).txt   # back up first
crontab -e
# Add:
# 0 12 * * *  cd /opt/hemnet-cohort-tracker && node spotcheck-reaction-poller.js  >> /var/log/hemnet/spotcheck-poller.log 2>&1
crontab -l   # verify both lines appear:
#   30 6 * * 1  ... cohort-spotcheck-gate.js ...
#   0 12 * * *  ... spotcheck-reaction-poller.js ...
```

**6. Optional dry run**

```bash
# Gate with explicit cohort (bypasses the D-13 ISO-week guard):
node cohort-spotcheck-gate.js --cohort $(date +%G-W%V)

# Reaction poller (reads any reactions already on open review messages):
node spotcheck-reaction-poller.js
```

Deploy: per `[[project-deploy-process]]`, push the repo change and then `cd /opt/hemnet-cohort-tracker && git pull` on the droplet, then add the crontab line via `crontab -e` (back up first per the procedure documented in lines 86-93 of this file).

### Preserved supplementary cron lines (already live on the droplet — Phase 9 leaves these untouched)

The live droplet crontab also contains the following operational and reporting jobs added in earlier phases. Plan 09-03 does NOT modify any of these:

```cron
# Cron health monitor — daily 03:00 UTC. Aggregates cron_job_log statuses and Slack-pings on failures.
0 3 * * *   cd /opt/hemnet-cohort-tracker && node cron-health-slack.js

# Weekly reporting — Mondays 09:00 UTC.
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node weekly-view-report.js
```

> **Phase 10-05 (2026-06-12): the pre-v2.0 Pool & Flow fan-out was retired.** The four
> Monday-09:00 jobs `listing-gap-monitor.js`, `flow-monitor.js`, `pool-flow-report.js`
> (direct Slack), and `generate-pool-flow-charts.js` (port-3800 dashboard HTML) were
> superseded by the v2.0 cohort pipeline + `weekly-view-report.js` (which STAYS). Their
> four `.js` files + `setup-chart-cron.sh` were deleted from the repo and the four crontab
> lines removed from the droplet. The `view-data-server.js` static server on :3800 is KEPT
> (it also serves `weekly-view-report.js`); only the `pool-flow-dashboard.html` it served is
> retired. The `listing_gap_weekly` + `listing_flow_weekly` tables have no remaining
> consumer and can be dropped (operator-confirmed schema change).

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

Each of the 7 scheduled scripts (cohort-create, cohort-track, sfpl-region-snapshot, hemnet-targeted-refresh, hemnet-targeted-match, booli-targeted-discovery, booli-targeted-refresh) is wrapped by `cron-wrapper.runJob` and writes a row to `cron_job_log` on every invocation. Triage flow when something breaks:

### Detect

1. Slack channel `Hemnet Status` — `SLACK_WEBHOOK_URL` fires on any run with `status IN ('warning','failure')`. Message format: `[WARNING|FAILURE] <script_name>: <error_message>`. **Operator MUST be actively watching this channel**: the 09-03 deploy surfaced that the channel had been firing alerts since at least 2026-05-17 (cohort-track null-Booli warnings) that no one was reading.
2. cron_job_log table — `node scripts/verify-cron-job-log.js` on the droplet prints the last 5 rows per script_name. Any "NO ROWS" line for the last 14 days means the script has not been running.
3. /var/log/hemnet/<job>.log — full stdout/stderr for each cron-wrapped script. Useful when cron_job_log only has a `running` row (signal-kill case — see Phase 10 carry-forward 09-2.6 #1).

### Diagnose

For any specific failed run, find the cron_job_log row:

```bash
cd /opt/hemnet-cohort-tracker && node -e "
  require('dotenv').config();
  const { createClient } = require('./db');
  (async () => {
    const c = createClient(); await c.connect();
    const r = await c.query(\`SELECT * FROM cron_job_log WHERE script_name = \$1 ORDER BY started_at DESC LIMIT 5\`, [process.argv[1]]);
    for (const row of r.rows) console.log(JSON.stringify(row, null, 2));
    await c.end();
  })();
" <script-name>
```

Then read the stdout/stderr log for that run's exact timestamp:
```bash
grep -A 50 -B 5 "$(date -u +%Y-%m-%dT)" /var/log/hemnet/<job>.log | less
```

Job-specific failure modes:

- **hemnet-targeted-refresh.js (Hemnet view data) status=failure** — usually Oxylabs creds missing, DB unreachable, or the daily list of active hemnet_ids is empty. Re-run manually: `node hemnet-targeted-refresh.js --dry-run` to confirm no DB issue, then drop `--dry-run`.

- **hemnet-targeted-match.js (Hemnet match cohort) status=warning low-match-rate** — the validate() branch fires when inserted/booliCount < 50%. Post-09-2.5 healthy range is 40-55% so this warning is currently cosmetic (project memory `project_job_b_match_rate_threshold_stale.md`). Inspect `result_summary.postcodeMismatch` and `result_summary.parseErrors` to confirm the warning is from filtering, not from Hemnet returning bad data.

- **booli-targeted-discovery.js (Booli fetch cohort) status=warning budgetExceeded=true** — the 180-min `JOB_BUDGET_MS` wall-clock budget hit. Either (a) Booli is rate-limiting (high oxylabsFallbackRate in result_summary — investigate banning), or (b) the queue is genuinely too large. Re-run with `--limit 500` to confirm Oxylabs+direct paths are healthy on a smaller queue.

- **booli-targeted-discovery.js status=warning workerErrors>0** — Plan 09-01's defense-in-depth catch fired. Grep the stdout log for `worker-uncaught url=` lines and inspect the captured stack trace. The trace identifies which hypothesis from Plan 09-01's diagnose-verf-b2.md was correct. File a follow-up if the same stack repeats across multiple runs.

- **booli-targeted-discovery.js status=failure (EXIT=1)** — the Plan 09-01 hardening should have prevented this. If it happens, investigate: was there a NEW failure mode (DB connection death, OOM, throw OUTSIDE the worker body)? Check `dmesg | tail` on the droplet for OOM-killer activity. Restore from git tag `phase-9-pre-cutover` if needed (created in Task 3).

- **booli-targeted-refresh.js (Booli view data) status=warning 'high Oxylabs fallback rate: 100.0% — direct path degraded; investigate'** — **EXPECTED NOISE post-09-1.5.** 100% Oxylabs is the steady-state normal for Booli; every Job D run will fire this warning. Captured in memory `project_booli_refresh_oxylabs_fallback_threshold_stale.md`. Phase 10 will re-target the threshold. No action needed unless the rate suddenly DROPS (which would indicate Booli un-blocked the direct path).

- **booli-targeted-refresh.js (Booli view data) status=warning budgetExceeded=true** — same as Job C: 35-min wall-clock budget hit. Job D should run faster than Job C since it's a refresh (no search-walk phase) — if it consistently hits the budget, investigate Booli IP banning of the droplet. Re-run with `--limit 100` to confirm fetch path is healthy.

- **booli-targeted-refresh.js status=warning workerErrors>0** — Plan 09-02's defense-in-depth catch fired. Grep the stdout log for `worker-uncaught booli_id=` lines and inspect the captured stack trace. Same triage as Job C. NOTE: post-09-2.5 a known FK violation on `booli_listing_agent_id_9a6480c3_fk_booli_agent_id` may fire ~9% of rows (09-2.5 #6 carry-forward — deploy-time decision still open).

- **booli-targeted-refresh.js status=warning '0 listings parsed'** — Booli pipeline degraded. Run `node scripts/probe-booli-refresh.js` to confirm the parser is healthy on a known-good URL; if probe fails too, escalate to lib/booli-fetch.js / lib/scrape-http.js investigation.

- **cohort-track.js (Cohort track) status=warning '>50% null Booli/Hemnet'** — one or more cohorts have >50% null view counts. This is the canary for upstream feed health. If the newest cohort is affected, Booli view data or Hemnet view data likely failed within the last 2-day cycle — check the `### Detect` section above. With the D-11 streak threshold halved to 5, sustained inactivity will mark pairs as dropped after ~10 calendar days (5 runs × every-2-days). Backlogged warnings from 2026-05-17+ should self-clear over 2-3 cycles after the first 14:00 UTC */2 Booli view-data fire (09-03 #4 carry-forward).

- **cohort-create.js, sfpl-region-snapshot.js** — predate Phase 9; runbook for these lives in their v1.0 docs.

- **cohort-spotcheck-gate.js (Phase 12 spot-check QA gate) status=warning 'confirmed false-match rate X.X% ...'** — `validate()` fired because the confirmed false-match rate exceeded the 5% threshold OR Hemnet fetch failures were detected. The gate samples the latest cohort (default 20%), adjudicates every sampled Booli↔Hemnet pair using the deterministic Mode A rule (price agrees + photos + likely-match → CONFIRMED_MATCH; no Anthropic API required), and computes the confirmed false-match rate with 95% Wilson CI broken down by county. Current adjudication mode is **Mode A (deterministic)**; Mode B (Claude vision for uncertain pairs) is added in Plan 12-03 via `--mode-b`.

  **Detect:** Slack channel `Hemnet Status` — `[WARNING] cohort-spotcheck-gate: confirmed false-match rate X.X% ...` or `[WARNING] cohort-spotcheck-gate: N fetch failure(s)...`. Also visible in `cron_job_log` (`node scripts/verify-cron-job-log.js`) and `/var/log/hemnet/spotcheck-gate.log`.

  **Artifacts:** `verf-spotcheck-<cohort>-<ts>/VERDICTS-<cohort>.json` (adjudication output with per-pair verdicts + summary stats) and `verf-spotcheck-<cohort>-<ts>/SUMMARY-<cohort>.md` (markdown with rate table, by-county breakdown, mismatch list). The artifact dir is created by the `cohort-spotcheck.js` child process and reused — the gate does NOT create a new dir.

  **Re-run manually:**
  ```bash
  # Re-run for the latest cohort (same as cron):
  node cohort-spotcheck-gate.js

  # Re-run for a specific cohort (e.g. after a failed run):
  node cohort-spotcheck-gate.js --cohort 2026-W23

  # Re-run with a lower sample rate (faster, fewer Oxylabs calls):
  node cohort-spotcheck-gate.js --cohort 2026-W23 --rate 0.10

  # Re-run with a custom escalation threshold (e.g. 10%):
  node cohort-spotcheck-gate.js --cohort 2026-W23 --threshold 0.10
  ```

  **Triage fetch failures:** Grep the artifact JSON: `cat verf-spotcheck-<cohort>-<ts>/spotcheck-<cohort>.json | node -e "const a=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(a.meta.hemnet);"`. If `error > 0`, Oxylabs or direct Hemnet fetch is degraded — check `lib/scrape-http.js` + Oxylabs creds.

  **Triage high false-match rate:** Open `VERDICTS-<cohort>.json` and review the `pairs` array. Mismatches have `verdict: 'CONFIRMED_MISMATCH'`. Check `deltas.price_pct_diff` and `deltas.area_pct_diff` — a cluster of mismatches in one county suggests a matching-logic drift (multi-unit address aliasing, address normalisation change). Reference `COHORT-SPOTCHECK.md §4` for root-cause framework.

- **sold-match-batch.js (Phase 19 Sold match batch) status=warning** — `validate()` escalated. The orchestrator runs the whole sold-match pipeline in ONE process (national sampler → matchOne per sampled record → Phase-18 re-check drain) under ONE batch-wide Oxylabs ceiling. `validate()` escalates when ANY of: the **batch stopped on a ceiling** before completing (`batchStoppedBy='ceiling'`); a **fatal sampler/match error**; **`fetchFailures` over threshold** (`SOLD_BATCH_FETCH_FAIL_THRESHOLD`, default 5); or an **incomplete match pass** (`recordsMatched < recordsTotal`). Methodology is **Slutpris-only and unchanged** (D-01). An **OFF-WEEK skip on an odd ISO week is NORMAL and does NOT escalate** (`result_summary.skipped=true, reason='off-week'`, `validate()` returns null) — the cron line fires weekly but the batch acts fortnightly (even-week gate, D-14).

  **Detect:** Slack channel `Hemnet Status` — `[WARNING] sold-match-batch: ...` (or `[FAILURE] sold-match-batch: ...`). Also `cron_job_log` (`node scripts/verify-cron-job-log.js`, filter `script_name = 'sold-match-batch'`) and `/var/log/hemnet/sold-match-batch.log`.

  **Diagnose:** Read the last `cron_job_log` row's `result_summary`:
  - If `skipped:true` (`reason:'off-week'`), it was an **odd-week no-op** — expected fortnightly, NOT a failure.
  - Else inspect `batchStoppedBy` (`'ceiling'` vs `null`), the sample stats (`allocated` / `fetched` / `deedsExcluded` / `dupsExcluded` / `perMuni` / `window`), `recordsMatched` vs `recordsTotal`, `fetchFailures`, `oxylabsSpent` vs `MAX_OXY_CALLS`, and the re-check block (`enrolled` / `rechecked` / `lateMatched` / `stillPending` / `uncertain` / `settled`).
  - A `ceiling` stop means `MAX_OXY_CALLS` was too low this fortnight → raise it, OR set `RECHECK_BRIDGE_FINAL_ONLY=1` (skip the SERP bridge on intermediate re-checks, ~9k → ~6k calls/month).

  **Re-run:**
  ```bash
  # Re-run the whole batch (idempotent upserts per DB-03; same as cron):
  node sold-match-batch.js
  ```
  The re-run is **idempotent** (`ON CONFLICT (booli_id)` upserts + the sampler de-dups against `booli_sold.booli_id`) and re-enrolls only un-enrolled `booli_only` rows, so a re-run after a ceiling stop **resumes safely**. The even-week gate is the ONLY cadence control — there is no week-parity override flag by default, so a manual catch-up run must be done on an EVEN ISO week (or the operator temporarily edits the panel/cron). The `--smoke` flag runs the offline self-test only (no DB, no Oxylabs).

  **Panel + cost levers (D-13/D-16/D-17):** `config/sold-panel.json` is the **coverage lever** — the v1 11-muni panel is metro/south-heavy (no Norrland); appending munis from `config/sold-panel.json._backfill_pending` (8 need Hemnet IDs, the rest need both — a morning **backfill** task) widens national coverage with a one-line config edit, NOT a code change. `target_sample_size` (~1000) and `lookback_days` (14) also live in the panel. The Oxylabs **cost levers** are `MAX_OXY_CALLS` (the hard ceiling) and `RECHECK_BRIDGE_FINAL_ONLY` (skip the bridge on intermediate re-checks, ~9k → ~6k/mo).

  **Go-live note:** the live DDL migration (Phase 18), the first Oxylabs wet run, and installing this crontab line on the droplet are **operator-gated go-live steps — NOT part of phase acceptance** (offline `--smoke` is). No Oxylabs run without explicit per-run operator go-ahead.

- **spotcheck-reaction-poller.js (daily reaction poller) — Phase 13**

  **What it does:** reads emoji reactions (✅ / ❌ / ❓) posted by authorised reactors on open
  review messages in `SLACK_REVIEW_CHANNEL`, applies the verdict, and (on ✅) SOFT-removes the
  pair — `UPDATE cohort_pairs SET removed_at=NOW(), removed_reason, removed_by` — after writing
  an audit record to `spotcheck_removed_pairs`. (Phase 13.1 reversed the original hard-DELETE:
  the `cohort_daily_views` FK blocked it on any tracked pair, and the view history must survive.)
  Soft-removed pairs are excluded from all tracking, refresh, reporting, export, and spot-check
  sampling queries (`removed_at IS NULL` filters).
  The `cron_job_log` `result_summary` for each poller run contains:
  `removed` / `kept` / `left` / `conflicts` / `sharedTsIgnored` / `staleCount` counts.

  **Detect:** `/var/log/hemnet/spotcheck-poller.log` or `cron_job_log` for `script_name =
  'spotcheck-reaction-poller'`. A `conflicts` count > 0 means one or more messages had both ✅
  and ❌ from authorised reactors — those pairs are left open for human triage (not auto-removed).
  `sharedTsIgnored` > 0 means legacy digest-era review rows exist (multiple pairs sharing one
  Slack message ts, from before Phase 13.1) — the poller never acts on those; dispose of them
  manually via SQL if they linger. A Slack alert fires when open review items sit unanswered
  for more than `STALE_REVIEW_DAYS` (default 7).

  **Review the queue manually:**
  - Open `SLACK_REVIEW_CHANNEL` in Slack. The gate posts ONE message PER pair needing review —
    `[REVIEW] UNCERTAIN pair …` and `[REVIEW] MISMATCH pair …` — each with its own ts, so a
    reaction applies to exactly that pair. Unreviewable (delisted) pairs arrive as one
    informational `[SPOT-CHECK]` summary with no reaction handling.
  - React with: **✅** = confirm mismatch (pair audited + soft-removed) · **❌** =
    override, valid match (pair kept + override recorded) · **❓** = unsure (left UNCERTAIN, not
    re-surfaced on the same week's messages).
  - Only reactions from a `SLACK_ALLOWED_REACTORS` user count (set in `.env`). If
    `SLACK_ALLOWED_REACTORS` is not set, the poller falls back to accepting ALL reactors — this
    is a documented first-run fallback only; set your own Slack user id before relying on
    auto-removal.

  **Recovering a wrongly-removed pair:** the row never left `cohort_pairs` — removal is the
  `removed_at` timestamp. Restore by nulling it (the audit trail in `spotcheck_removed_pairs`
  stays):

  ```bash
  cd /opt/hemnet-cohort-tracker && node -e "
    require('dotenv').config();
    const { createClient } = require('./db');
    (async () => {
      const c = createClient(); await c.connect();
      const before = await c.query('SELECT id, removed_at, removed_reason, removed_by FROM cohort_pairs WHERE id = \$1', [<PAIR_ID>]);
      console.log('before:', JSON.stringify(before.rows[0]));
      await c.query('UPDATE cohort_pairs SET removed_at=NULL, removed_reason=NULL, removed_by=NULL WHERE id = \$1', [<PAIR_ID>]);
      const after = await c.query('SELECT id, removed_at FROM cohort_pairs WHERE id = \$1', [<PAIR_ID>]);
      console.log('after:', JSON.stringify(after.rows[0]));
      await c.end();
    })();
  "
  ```

  Replace `<PAIR_ID>` with the pair id (visible in the Slack message or in
  `spotcheck_removed_pairs`). The pair re-enters tracking/reporting on the next run of each job.

  **dHash calibration:** The gate logs `dHash pair <id>: minDist=<n>` for every sampled pair.
  After 4–6 weeks, inspect the distribution:
  ```bash
  grep "dHash pair" /var/log/hemnet/spotcheck-gate.log | awk -F'minDist=' '{print $2}' | sort -n | uniq -c
  ```
  The threshold is `DHASH_THRESHOLD` in `.env` (default 6 = near-identical only). Do not raise
  it until you have a clear view of the minDist distribution — raising it prematurely increases
  false auto-confirms.

  **Stale-cohort skip (D-13 guard):** If `cohort-create.js` hasn't produced this week's cohort
  by the time the gate fires (Mon 06:30 UTC), the gate skips and fires a Slack alert:
  `[WARNING] cohort-spotcheck-gate skipped: cohort <week> not yet available`. This is expected
  if cohort-create is delayed. Re-run the gate manually once cohort-create completes:
  ```bash
  node cohort-spotcheck-gate.js --cohort $(date +%G-W%V)
  ```
  (`--cohort` bypasses the D-13 guard and runs against the specified week.)

### Re-run

Any job can be re-run manually with the same flags the cron line uses. **CRITICAL: never launch a long-running cron in a naked interactive console** — `cron-wrapper.js` does not yet handle SIGHUP/SIGTERM/SIGINT (Phase 10 / carry-forward 09-2.6 #1), so a console disconnect (DigitalOcean web console, ssh hang-up) leaves an orphan `running` row in `cron_job_log` that requires manual cleanup. Always use one of:

- **tmux (preferred):**
  ```bash
  ssh root@<droplet>
  tmux new -s reruns
  cd /opt/hemnet-cohort-tracker && node booli-targeted-refresh.js
  # Detach with Ctrl-b d; reattach later with: tmux attach -t reruns
  ```
- **nohup + disown:**
  ```bash
  ssh root@<droplet>
  cd /opt/hemnet-cohort-tracker
  nohup node booli-targeted-refresh.js >> /var/log/hemnet/job-d-manual.log 2>&1 &
  disown
  ```

Re-run commands once you are inside tmux or have disowned:

```bash
cd /opt/hemnet-cohort-tracker
node hemnet-targeted-refresh.js                              # Hemnet view data — refresh all active
node hemnet-targeted-match.js   --week 2026-05-11            # Hemnet match cohort — explicit week override
node booli-targeted-discovery.js --week 2026-05-04           # Booli fetch cohort — explicit week override
node booli-targeted-refresh.js                               # Booli view data — refresh all matched-pair URLs
node cohort-track.js                                         # Cohort track — every-2-days run
```

All four refresh/discovery jobs (Job A/B/C/D) support `--dry-run` (no DB writes) and `--limit N` (cap queue). Jobs B and C also support `--week YYYY-MM-DD` (override cohort week). Job D does NOT support `--week` — its 8-week lookback is fixed (D-05).

If a manual cron run was killed by a signal and left a `running` row in `cron_job_log`, the row needs manual UPDATE to flip `status` from `running` to `killed` and populate `ended_at`/`duration_ms` — see `scripts/unstick-cron-row-418.js` (one-off from 09-2.6) as a template. Phase 10 will ship a general-purpose `scripts/unstick-cron-row.js`.

## Green-week gate and rollback

Phase 9 cutover is single-shot. Both external scrapers are already off (D-10), so there is no parallel-run comparison; the cohort pipeline is running solo on self-hosted writers immediately after the Plan 09-03 crontab deploys. The green-week gate verifies the pipeline produces the expected volume of cohort_daily_views rows on the first Monday after deploy.

### Green-week GO/NO-GO checklist (run on the Monday after Plan 09-03 deploys — 2026-05-25)

Run all four checks. ALL must pass for GO; ANY failure = NO-GO + rollback.

1. **Booli fetch cohort (Job C) ran the prior Sun 22:00 UTC with status='success' or 'warning'.**
   `node scripts/verify-cron-job-log.js | grep booli-targeted-discovery` — last row's `status` in {`success`,`warning`}, NOT `failure`.

2. **Hemnet match cohort (Job B) ran Mon 03:00 UTC with status='success' or 'warning'.**
   Same as #1 but for `hemnet-targeted-match`.

3. **Booli view data (Job D) ran at least once in the past 48h (the previous odd-day 14:00 UTC slot) with status='success' or 'warning'.**
   Same as #1 but for `booli-targeted-refresh`. The expected-noise Oxylabs-fallback warning (see Diagnose section) is acceptable for this gate.

4. **cohort-create.js ran Mon 06:00 UTC and produced a cohort_daily_views row count within ±5% of the prior 4-week median.**
   ```bash
   cd /opt/hemnet-cohort-tracker && node -e "
     require('dotenv').config();
     const { createClient } = require('./db');
     (async () => {
       const c = createClient(); await c.connect();
       const r = await c.query(\`
         SELECT cohort_id, COUNT(*)::int AS n
         FROM cohort_daily_views
         WHERE cohort_id >= TO_CHAR(NOW() - INTERVAL '5 weeks', 'IYYY-\"W\"IW')
         GROUP BY cohort_id
         ORDER BY cohort_id DESC LIMIT 5\`);
       for (const row of r.rows) console.log(row);
       await c.end();
     })();
   "
   ```
   Compare the newest cohort_id's `n` to the median of the prior 4. Within ±5% = pass.

### Cutover complete (after a single GO week)

Tag the repo so rollback is fast if a future regression appears:
```bash
git tag phase-9-cutover-complete -m "Self-hosted scraper canonical writer for hemnet_listingv2 and booli_listing"
git push --tags
```

Phase 9 closes with status `cutover-complete`. v2.0 milestone ships.

### Rollback (if green-week NO-GO)

1. Revert the crontab to the pre-Phase-9 schedule:
   ```bash
   # The actual backup file captured 2026-05-20 during the Plan 09-03 deploy:
   crontab /tmp/crontab-backup-1779318677.txt
   crontab -l   # verify — should be the 12-line pre-Phase-9 block
   ```
   This restores the pre-Phase-9 cron lines (cohort-track 23:30+02:00 daily, cohort-create Mon 06:00, sfpl-region-snapshot daily 08:00, plus the 8 supplementary lines for cron-health/Mon-morning reports). The 3 Phase-9 `*/2` cron lines (Jobs A/D + every-2-days cohort-track) stop firing immediately. The weekly Job B (Mon 03:00) and Job C (Sun 22:00) lines remain — they were added before Plan 09-03 and the backup file captures them.

   If the backup file no longer exists (older than droplet `/tmp` cleanup window), reconstruct the pre-Phase-9 block from `09-03-SUMMARY.md` "Pre-edit live droplet crontab" section.

2. Investigate the failure mode. Common causes:
   - Booli view data (Job D) never ran (cron config issue) → cohort-track reads stale Booli view counts
   - Hemnet view data (Job A) failure rate elevated → cohort-track sees high hemnet_views nulls
   - Hemnet match cohort (Job B) match rate dropped below the post-09-2.5 baseline → fewer new pairs in the new cohort
   - cohort-track itself failed → no new rows in cohort_daily_views

3. File a follow-up ROADMAP phase to address the persistent failure mode.

4. Phase 9 closes with status `cutover-deferred-replan` (a follow-up phase is required before v2.0 milestone ships).

Self-hosted code stays deployed (no `git revert` needed) — it just stops running from cron. This keeps the diagnostic trail intact (cron_job_log + /var/log/hemnet/*.log) for the follow-up investigation.

### Diagnosing `market-totals-daily` Slack alerts

`market-totals-daily.js` is silent on success. The two non-silent paths:

1. **`JSON path missing for <label>: expected positive number, got …`** — the inline smoke probe (D-02) caught one of the four expected Apollo paths returning undefined/null/NaN/non-positive. Likely causes, in priority order:
   - **Hemnet or Booli renamed an Apollo `ROOT_QUERY` call signature** (e.g. `searchForSaleListings` → `searchListings`). Re-run `scripts/probe-total-listings.js` against the live site, compare keys against `market-totals-daily.js` `pickByPrefix` prefixes, update the prefix string + ship a fix. The fix is a one-line edit in `market-totals-daily.js`.
   - **`extractNextData` returned a different shape** (e.g. `pageProps` moved). Inspect `verf-totals/<site>-next-data.json` after re-running the probe; update the `extractApolloRoot` walk if the shape moved.
   - **Cloudflare started returning an HTML interstitial instead of the rendered page** — `extractNextData` would throw "no __NEXT_DATA__"; the alert text would differ from the one above. Confirm by running `node -e "const { getWithRetry } = require('./lib/scrape-http'); getWithRetry('https://www.hemnet.se/bostader', { logger: console.log }).then(r => console.log(r.html.length, r.html.slice(0,200)))"` on the droplet. Fix is `lib/scrape-http.js` (out of scope for this script).
   - **A real market crash drove a segment to 0.** Phase 11 deliberately rejects this case (D-02 — `n <= 0` throws). Acceptable for now; if it becomes a real-world false positive, lift the floor to 0 with sign-off.
   Verify the fix using the offline regression test: `node scripts/test-market-totals-probe.js` (PASS: 16/16). Then deploy + re-run the daily job manually before letting the next cron fire be the validator.

2. **`Expected 4 rows upserted, got <N>`** — `validate()` warned because fewer than 4 rows landed. Possibilities: a fetch silently returned a `null` total (Apollo serialization drift — same fix path as above), or an UPSERT race (extremely unlikely given the PK). Check `cron_job_log.result_summary.perRow` for the missing site/segment.

**What this alert is NOT:** an unexpected-delta alarm. Phase 11 deliberately does NOT alert on WoW/DoD deltas (D-03). If a daily total swings dramatically week-to-week, you see it in the weekly market-supply-pulse Slack on Monday, not as an alert.

Note on the streak-threshold change (D-11): cohort-track.js's drop threshold was halved from `>= 10` to `>= 5` in Plan 09-04 to compensate for the every-2-days cadence (Plan 09-03 / D-07 removed cohort-track 23:30+02:00 daily). Time-to-drop stays at ~10 calendar days under the new cadence. If a rollback restores the daily cohort-track schedule, the halved threshold means drops fire at ~5 calendar days instead of ~10 — operator should consider reverting cohort-track.js to the pre-D-11 `>= 10` threshold at the same time as the crontab rollback for symmetry.
