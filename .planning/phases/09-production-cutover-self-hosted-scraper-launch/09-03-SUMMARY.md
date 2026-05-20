---
phase: 09-production-cutover-self-hosted-scraper-launch
plan: 03
subsystem: ops/cron
tags: [crontab, cron, slack, deploy, cutover, droplet, every-2-days]
provides:
  - Droplet crontab carrying the every-2-days view-refresh cycle (Booli view data + Hemnet view data at 14:00 UTC parallel; Cohort track at 22:00 UTC) on odd days
  - SLACK_WEBHOOK_URL active on the droplet (confirmed working end-to-end)
  - scripts/verify-cron-job-log.js — operational health-check helper covering all seven cron-wrapped scripts
  - deploy-instructions.md reflecting actual droplet state (12 preserved lines documented; node-direct invocation pattern; D-17 parallel cadence)
affects: [09-04, 10]
tech-stack:
  added: []
  patterns:
    - "Doc-first crontab management — deploy-instructions.md is the authoritative source; live droplet pulls match"
    - "Slack alerting via SLACK_WEBHOOK_URL in cron-wrapper.runJob for any status='warning'|'failure'"
    - "verify-cron-job-log.js as ops smoke test — proves every expected script has logged at least one row in 14d"
key-files:
  created:
    - scripts/verify-cron-job-log.js
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-03-SUMMARY.md
  modified:
    - deploy-instructions.md
    - droplet:crontab
    - droplet:/opt/hemnet-cohort-tracker/.env (SLACK_WEBHOOK_URL — already set; confirmed not added)
key-decisions:
  - "D-17 parallel 14:00 honored over D-06 sequential 14:00/18:00/22:00 (operator confirmed mid-deploy — the plan body had stale D-06 text)"
  - "Task 3 forced-warning probe was substituted by the natural warning fired by Task 2's Booli view-data dry-run (`--dry-run --limit 5`); both probe vectors verify the same chain (cron-wrapper → validate() → Slack → cron_job_log row + exit 0)"
  - "deploy-instructions.md rewritten end-to-end against the actual droplet crontab (12 preserved lines + 3 new */2 lines), not the doc's stale 4-line snapshot"
duration: ~75min
completed: 2026-05-21
---

# Plan 09-03: Crontab cutover to every-2-days view-refresh cycle

**Booli view data, Hemnet view data, and Cohort track now run on the every-2-days cadence on the droplet; Slack alerting is live and was confirmed end-to-end by a real warning from Task 2's dry-run.**

## Performance

- **Duration:** ~75 minutes (Task 1 + operator-action Tasks 2 + 3)
- **Tasks:** 3/3 complete
- **Commits:** 3 (Task 1, mid-deploy D-17 doc reconciliation, this SUMMARY)
- **Files modified:** 2 in repo + droplet crontab + droplet .env (verified pre-existing)

## Task Commits

1. **Task 1: deploy-instructions.md rewrite + scripts/verify-cron-job-log.js** — `2fadeb2`
2. **Task 1.5 (mid-deploy reconcile): D-17 parallel 14:00 in deploy-instructions.md** — `39d3865`
3. **Task 2 + Task 3 (operator action — no code commits; SUMMARY captures evidence)** — this commit

## Accomplishments

- **Every-2-days view-refresh cycle is wired:** Booli view data + Hemnet view data at `0 14 */2 * *` (parallel per D-17), Cohort track at `0 22 */2 * *`. Removed the prior daily Cohort track lines (`30 23 * * *` and `0 2 * * *`) per D-07. First production fire: **2026-05-21 14:00 UTC** (~14.5 hours after deploy).
- **Slack alerting is end-to-end verified:** The Task 2 dry-run of Booli view data (`booli-targeted-refresh.js --dry-run --limit 5`) fired a real `status=warning` via the validate() path, which (a) wrote row id=427 to `cron_job_log` and (b) posted to the `Hemnet Status` channel with the verbatim message `[WARNING] booli-targeted-refresh: high Oxylabs fallback rate: 100.0% — direct path degraded; investigate`. SLACK_WEBHOOK_URL was already set on the droplet — the codebase intel files (`.planning/codebase/{CONCERNS,STACK,INTEGRATIONS}.md`) flagging it as missing are stale.
- **`scripts/verify-cron-job-log.js` ships green:** all 7 expected scripts have rows in the last 14d (`OK: every expected script has at least 1 row in the last 14 days`).
- **deploy-instructions.md now matches reality:** 12 preserved cron lines documented (the doc previously listed 4), `node <script>.js` direct-invocation pattern documented (previously documented as `node cron-wrapper.js <script>.js`, which was wrong but a no-op).

## Files Created/Modified

- `deploy-instructions.md` — rewritten end-to-end: SLACK_WEBHOOK_URL setup, full 13-line crontab block in canonical form, three `*/2` view-refresh lines (D-17 parallel), preserved-slot supplementary block, runbook stub pointing forward to 09-04, observability section pointing at `verify-cron-job-log.js` and `/var/log/hemnet/`.
- `scripts/verify-cron-job-log.js` — created. `EXPECTED_SCRIPTS = ['cohort-create', 'cohort-track', 'sfpl-region-snapshot', 'hemnet-targeted-refresh', 'hemnet-targeted-match', 'booli-targeted-discovery', 'booli-targeted-refresh']`. Prints the last N rows per script with status + duration + summary keys; exits 0 if all scripts have ≥ 1 row in 14d, exit 1 otherwise. Passes `node --check`.
- `droplet:/opt/hemnet-cohort-tracker` — `git pull` to commit `39d3865`.
- `droplet:crontab` — 12 lines → 13 lines (added 3 `*/2` lines, removed 2 daily Cohort track lines).
- `droplet:/opt/hemnet-cohort-tracker/.env` — `SLACK_WEBHOOK_URL` confirmed pre-existing; not modified.

## Decisions & Deviations

### D-17 honored over D-06 (mid-deploy reconciliation, `39d3865`)

The 09-03 plan body documents D-06's sequential cadence (`14:00 Job D → 18:00 Job A → 22:00 cohort-track`). The 09-02-SUMMARY locks D-17 (`14:00 PARALLEL Job D + Job A → 22:00 cohort-track`), and 09-02-PLAN explicitly marks 09-03 as the consumer that should follow D-17 verbatim. The Task 1 commit (`2fadeb2`) followed the stale plan body. Operator confirmed mid-deploy that D-17 is the locked decision; deploy-instructions.md was reconciled in `39d3865` before the operator edited the droplet crontab. Net effect: both Booli and Hemnet view-data refresh fire at the same `0 14 */2 * *` slot, with combined Oxylabs load at ~4% of the 50/sec cap (09-02 analysis).

### Task 3 verification substitution

The plan's Task 3 prescribes a synthetic `test-warning` script_name probe via inline node `-e` invocation. The Task 2 dry-run of Booli view data ended in `status=warning` (stale Oxylabs-fallback threshold — see `project_booli_refresh_oxylabs_fallback_threshold_stale.md` memory) and triggered the same code path: Slack POST + `cron_job_log` row + exit 0. The natural warning probes the chain at least as well as the synthetic one (it exercises validate() with real data through a real worker pool), so the synthetic probe was skipped. The `test-warning` cleanup row deletion was therefore also skipped.

### Doc-vs-reality diff outcome: 2b (drift detected → doc updated before crontab edit)

The pre-edit live crontab captured to `/tmp/crontab-backup-1779318677.txt` contained **12 lines** versus the **4 lines** in pre-deploy `deploy-instructions.md`. The diff revealed:

- 8 supplementary lines that had been added to the droplet outside this plan: `cron-health-slack.js` daily 03:00 UTC; Mon-morning report fan-out (`listing-gap-monitor.js`, `flow-monitor.js`, `pool-flow-report.js`, `weekly-view-report.js`, `generate-pool-flow-charts.js`); Job C (`booli-targeted-discovery.js`) Sun 22:00 UTC; Job B (`hemnet-targeted-match.js`) Mon 03:00 UTC.
- Invocation pattern drift: doc said `node cron-wrapper.js <script>.js`; reality used `node <script>.js`. Both produce the same behavior (cron-wrapper is `require`d inside each script) but the doc was inaccurate.

Task 1 rewrote the doc against the live crontab before the operator touched anything. The pre-edit backup file at `/tmp/crontab-backup-1779318677.txt` remains as the rollback source of truth.

## Verbatim artifacts (preserved per plan `<output>` spec)

### Pre-edit live droplet crontab (`/tmp/crontab-backup-1779318677.txt`)

```
30 23 * * * cd /opt/hemnet-cohort-tracker && node cohort-track.js
0 2 * * * cd /opt/hemnet-cohort-tracker && node cohort-track.js
0 6 * * 1 cd /opt/hemnet-cohort-tracker && node cohort-create.js
0 8 * * * cd /opt/hemnet-cohort-tracker && node sfpl-region-snapshot.js
0 3 * * * cd /opt/hemnet-cohort-tracker && node cron-health-slack.js
0 9 * * 1 cd /opt/hemnet-cohort-tracker && node listing-gap-monitor.js
0 9 * * 1 cd /opt/hemnet-cohort-tracker && node flow-monitor.js
15 9 * * 1  cd /opt/hemnet-cohort-tracker && node pool-flow-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node weekly-view-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node generate-pool-flow-charts.js
0 22 * * 0  cd /opt/hemnet-cohort-tracker && node booli-targeted-discovery.js
0 3 * * 1   cd /opt/hemnet-cohort-tracker && node hemnet-targeted-match.js
```

### Post-edit live droplet crontab (`crontab -l`)

```
0 6 * * 1 cd /opt/hemnet-cohort-tracker && node cohort-create.js
0 8 * * * cd /opt/hemnet-cohort-tracker && node sfpl-region-snapshot.js
0 3 * * * cd /opt/hemnet-cohort-tracker && node cron-health-slack.js
0 9 * * 1 cd /opt/hemnet-cohort-tracker && node listing-gap-monitor.js
0 9 * * 1 cd /opt/hemnet-cohort-tracker && node flow-monitor.js
15 9 * * 1  cd /opt/hemnet-cohort-tracker && node pool-flow-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node weekly-view-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node generate-pool-flow-charts.js
0 22 * * 0  cd /opt/hemnet-cohort-tracker && node booli-targeted-discovery.js
0 3 * * 1   cd /opt/hemnet-cohort-tracker && node hemnet-targeted-match.js
0 14 */2 * * cd /opt/hemnet-cohort-tracker && node booli-targeted-refresh.js    >> /var/log/hemnet/job-d.log 2>&1
0 14 */2 * * cd /opt/hemnet-cohort-tracker && node hemnet-targeted-refresh.js   >> /var/log/hemnet/job-a.log 2>&1
0 22 */2 * * cd /opt/hemnet-cohort-tracker && node cohort-track.js              >> /var/log/hemnet/cohort-track.log 2>&1
```

### Slack alert (Hemnet Status channel, 2026-05-21 09:25 local — i.e. 2026-05-20 23:25 UTC)

```
[WARNING] booli-targeted-refresh: high Oxylabs fallback rate: 100.0% — direct path degraded; investigate
```

### `cron_job_log` row from Task 2/3 probe

| id  | started_at                  | duration_ms | status  | error_message |
|-----|-----------------------------|-------------|---------|---------------|
| 427 | 2026-05-20T23:25:11.877Z    | 42405       | warning | `high Oxylabs fallback rate: 100.0% — direct path degraded; investigate` |

## Carry-forward issues (for Plan 09-04 and Phase 10)

1. **(09-04 input) cohort-track drop-streak threshold is now miscalibrated** — Per D-11, `cohort-track.js:114` and `:168` should change `>= 10` → `>= 5` to compensate for the every-2-days cadence. Without this, a Booli- or Hemnet-side outage would take ~20 calendar days to flip a pair to `dropped_*_on` (was 10 days under the daily cadence). Plan 09-04 owns this two-line edit.

2. **(09-04 input) Backlogged Cohort track null-Booli warnings** — Cohort track has been logging `status=warning` daily since 2026-05-17 with `2026-W13/W14/W15: 54-58% null Booli`. These warnings were going to Slack the whole time (confirmed by the working webhook), but the channel apparently wasn't actively watched. Once the Booli view-data refresh starts firing (`*/2 14:00`) the active-listing freshness should recover and the warning should self-clear over 2-3 cycles. Worth a follow-up check after the 2026-05-21 14:00 UTC fire.

3. **(Phase 10) Orphaned `running` rows in `cron_job_log`** — Three rows in `booli-targeted-discovery` (ids 359, 406, 407) and one `killed` row in `hemnet-targeted-match` (id 418) lack a finalizer; their durations are null. cron-wrapper's signal handler does not catch SIGHUP/SIGTERM. Worth a `scripts/unstick-cron-row.js` cleanup pass and a cron-wrapper signal-handler hardening.

4. **(Phase 10) Codebase intel files claim SLACK_WEBHOOK_URL not configured** — `.planning/codebase/CONCERNS.md:153`, `STACK.md:54`, `INTEGRATIONS.md:10` all say "not yet configured on Droplet". The webhook is set and working. Worth a `gsd-map-codebase` re-run or a manual correction.

5. **(Phase 10) Booli view-data validate() Oxylabs-fallback warning is cosmetic** — 100% Oxylabs is the steady-state normal post-09-1.5 for Booli; every Job D run will warn. Captured in memory `project_booli_refresh_oxylabs_fallback_threshold_stale.md`. Either remove the threshold or re-target it (e.g., warn only if fallback rate suddenly *drops*).

## Next Phase Readiness

Plan 09-04 is unblocked. The crontab is live; the only remaining production-readiness gap is the cohort-track streak threshold halving (D-11). 09-04 should ship as soon as practical to avoid the 20-day drop-detection interim state. After 09-04 ships, Phase 9 enters the single green-week observation window with the next Mon cohort-create row count as the GO/NO-GO signal against the historical baseline.
