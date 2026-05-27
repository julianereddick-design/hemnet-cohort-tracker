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
- Every-2-days view-refresh cycle (D-06 + D-17): odd days at 14:00 UTC (Job D and Job A in PARALLEL per 09-02 D-17) → 22:00 UTC cohort-track. Combined Oxylabs load at parallel start is ~4% of the 50/sec cap (09-02 analysis); each job opens its own pg.Client so no DB pool contention. Eight-hour gap to cohort-track covers worst-case runtimes (Job D ~30-60 min, Job A ~33-51 min with Oxylabs fallback headroom).
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
```

Deploy: per `[[project-deploy-process]]`, push the repo change and then `cd /opt/hemnet-cohort-tracker && git pull` on the droplet, then add the crontab line via `crontab -e` (back up first per the procedure documented in lines 86-93 of this file).

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
