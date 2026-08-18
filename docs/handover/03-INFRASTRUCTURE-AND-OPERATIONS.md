# 03 — Infrastructure & Operations

Operator handover for **`hemnet-cohort-tracker`** — a Node.js pipeline that tracks
Hemnet-vs-Booli listing views, market supply, pre-market flow, and Booli→Hemnet
sold-match rates for the Swedish residential real-estate market. This document covers the
**base infrastructure and day-to-day operations**: hosting, database, secrets, the Oxylabs
proxy, deploy, cron, monitoring, and disk/retention.

Primary source files: `deploy-instructions.md` (the canonical ops runbook — read it in
full), `db.js`, `cron-wrapper.js`, `cron-health-slack.js`, `cron-setup.js`,
`lib/scrape-http.js`, `.env.example`, the `migrate-*.js` scripts, and the droplet docs under
`docs/`.

---

## 1. Runtime & Hosting

The project touches **three DigitalOcean droplets**. Only the first runs *this* repo's cron
jobs. Do not confuse them.

| Droplet | IP | Role for this project | Notes |
|---|---|---|---|
| **cohort-tracker** (the "Hemnet box") | `170.64.197.241` | **Runs this repo.** All cron jobs in this document fire here from `/opt/hemnet-cohort-tracker`. | Ubuntu, login `root`. Git clone deployed at `/opt/hemnet-cohort-tracker`. SSH config alias `cohort-droplet` (Claude may SSH as of 2026-06-11). |
| **price-scraper droplet** | `170.64.181.89` (region `syd1`, DO id `357087018`) | **Separate, team-owned box.** Does the actual Hemnet + Booli *listing* scraping into the shared DB. This repo *consumes* its output tables (`hemnet_listingv2`, `booli_listing`), it does not run here. | Repo `github.com/tt7676/hem-bol-scrapers`, app at `/var/www/apps/hemnet` (Django + Celery + Docker). Was `s-8vcpu-16gb` (~$100/mo), **right-sized to `s-1vcpu-2gb` (~$12/mo)** in v4.0 Phase 25. See `docs/price-scraper-droplet-audit.md`, `-runbook.md`, `-remediation.md`. |
| **monitor-prod-syd1** | `209.38.93.133` | **NONE.** Separate fintech watchlist monitor. **Does NOT do any Hemnet scraping** (verified 2026-06-29). | Listed only to prevent mis-identification. |

### The cohort-tracker box (this repo)

- **Machine:** DigitalOcean droplet **556306295**, region `syd1`, Ubuntu 24.04 LTS.
  **`s-1vcpu-2gb`** — 1 vCPU, **2 GB RAM, 50 GB disk**, $12/mo. **No swap.**
  > **Sizing:** the heaviest single job (`export-hb-ratio-xlsx.js`) peaks around **550 MB** and
  > its memory *grows with cohort size*, so headroom shrinks as cohorts grow. Measure rather
  > than assume: `node scripts/mem-profile.js -- node <job>.js` (§8).
  >
  > The disk was expanded with `--resize-disk`, which DigitalOcean cannot undo — **this droplet
  > can never be downsized below 2 GB.**
- **Code location:** `/opt/hemnet-cohort-tracker/` (git clone; `cd … && git pull` to deploy).
- **Job execution:** Linux **cron** (per-user crontab, `root`). Every scheduled script is
  wrapped by `cron-wrapper.js` → `runJob` (invoked at module load — see §5/§6). No process
  manager; jobs are short-lived cron invocations.
- **Long-running service:** `view-data-server.js` runs as a **systemd** unit
  (`view-data-server.service`, `Restart=always`) on **port 3800**, serving the weekly view
  report / static view data. Installed by `setup-droplet.sh`. `EnvironmentFile=/opt/hemnet-cohort-tracker/.env`.
- **Log dir:** `/var/log/hemnet/<job>.log` (one file per job; stdout+stderr). Create with
  `mkdir -p /var/log/hemnet` before first deploy. Rotate with logrotate if they grow.
- **SSH gotcha (applies to the price-scraper box; good practice everywhere):** always pass
  `-o IdentitiesOnly=yes -o IdentityAgent=none -i <key>` or the agent offers wrong keys and
  you get a false `Permission denied (publickey)`.

### Access to the price-scraper box (reference only)

`ssh -o IdentitiesOnly=yes -o IdentityAgent=none -i ~/.ssh/droplet_ed25519 root@170.64.181.89`.
Operator key `~/.ssh/droplet_ed25519` (comment `julian-droplet`, DO key id `55446611`). Full
runbook: `docs/price-scraper-droplet-runbook.md`. That box also hosts **Metabase** on `:3000`
(backed by the same managed Postgres). NOTE: it had a Kinsing/kdevtmpfsi cryptomining
infection that was **remediated** in v4.0 Phase 24 (`docs/price-scraper-droplet-remediation.md`).

---

## 2. Database — DigitalOcean Managed Postgres

- **Engine:** DigitalOcean **managed Postgres**, host
  `db-postgresql-syd1-79303-….ondigitalocean.com`, port **`25060`**, database **`defaultdb`**,
  user **`doadmin`**, **SSL required**.
- **Shared `defaultdb`:** the **same `defaultdb`** holds *both* the price-scraper's source
  tables (`hemnet_listingv2` ~207k rows, `booli_listing` ~234k rows, plus large 0-row
  `simple_history` bloat tables ~49 GB) *and* this repo's cohort / sold-match / market tables.
  `defaultdb` was ~55 GB at last audit. Treat cross-repo tables with care.

### Connection code (`db.js`)

`db.js` exports a single `createClient()` returning a `pg.Client` built from **discrete env
vars** (not a URL):

```
DB_HOST, DB_PORT, DB_USER (doadmin), DB_PASSWORD, DB_NAME (defaultdb)
ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000
```

> ⚠ **Doc-vs-code discrepancy to know:** `deploy-instructions.md` §"Environment variables"
> lists `DATABASE_URL` as required, but the actual code path (`db.js`, used by every
> cron-wrapped job) reads the **discrete `DB_*` vars** shown in `.env.example`. The droplet
> `.env` must define the `DB_*` set for the pipeline to connect. `DATABASE_URL` is the form
> used by the *price-scraper* Django app on the other box.

### Querying prod (no psql on the droplet)

The droplet has **no `psql` client**. Query prod via a **committed Node script** using
`db.js`'s `createClient()` — never inline `node -e` ad hoc for anything durable. Canonical
helpers:

- `node scripts/verify-cron-job-log.js` — last 5 `cron_job_log` rows per script (health triage).
- Inline `node -e` pattern with `require('./db').createClient()` is used in
  `deploy-instructions.md` for one-off diagnosis (e.g. reading a `cron_job_log` row, restoring
  a soft-removed pair) — see that file's Runbook §Diagnose.
- Local connections may need **DB IP whitelisting** via `doctl`; the default `doctl` token
  authenticates for **reads only** (DO writes such as firewall/resize need an operator
  write-scoped token).

### Main tables (from `migrate-*.js` + `*-setup.js`)

| Table | Created by | Holds |
|---|---|---|
| `cohorts` | `cohort-setup.js` | One row per weekly cohort (`cohort_id` e.g. `2026-W10`, week_start/end). |
| `cohort_pairs` | `cohort-setup.js` | Matched Booli+Hemnet listing pairs per cohort (ids, address, county, day-0 views, drop dates). Phase 13.1 added soft-delete cols `removed_at/removed_reason/removed_by` (`migrate-cohort-pairs-soft-delete.js`). |
| `cohort_daily_views` | `cohort-setup.js` | One row per pair per date: `booli_views`, `hemnet_views` (the core time series, ~408k rows). |
| `cohort_unmatched` | `cohort-setup.js` | Booli listings that did not match a Hemnet listing in a cohort. |
| `cron_job_log` | `cron-setup.js` | One row per cron-wrapped run: `script_name`, timing, `status` (running/success/warning/failure/killed), `error_message`, `result_summary` JSONB. The observability backbone. |
| `market_totals` | `market-totals-daily.js` | Daily site headline totals: 4 rows/day (`{hemnet,booli}` × `{till_salu, kommande}`). |
| `premarket_flow_weekly` | `migrate-premarket-flow.js` / `scripts/premarket-flow-measure.js` | Weekly pre-market flow & staleness (2 rows/week, Hemnet vs Booli). |
| `booli_sold` | `migrate-sold-phase16.js` | One row per Booli `/slutpriser` sold record (UNIQUE `booli_id`); price, date, geo, type. |
| `hemnet_sold` | `migrate-sold-phase16.js` | One row per Hemnet `/salda` sold record (UNIQUE `hemnet_slug`). |
| `sold_match` | `migrate-sold-phase16.js` (populated Phase 17+) | Verdict table: Booli-sold ↔ Hemnet-sold match outcome (matched / booli_only / uncertain), window bounds. Phase 18 re-check cols via `migrate-sold-recheck-phase18.js`; single-candidate backfill `migrate-sold-backfill-single-candidate.js`; segment canonicalize `migrate-sold-canonicalize-segments.js`. |
| `sold_spend` | `migrate-sold-phase16.js` | Atomic Oxylabs spend counter backing the DB-backed per-run ceiling. |
| `spotcheck_review`, `spotcheck_removed_pairs` | `migrate-spotcheck-phase13.js` | Spot-check QA review queue + audit of removed pairs. |
| `sfpl_region_daily` | ~~`sfpl-region-snapshot.js`~~ | FROZEN 2026-08-13 — writer retired, table retained (2026-03-06 → 2026-08-12). |

**Migrations are manual and idempotent** (`IF NOT EXISTS` DDL): run
`node <migrate-file>.js` on the droplet after a `git pull` that introduces one. There is no
migration framework/ordering — each is a standalone script.

---

## 3. Credentials & Secrets

All secrets live in **`/opt/hemnet-cohort-tracker/.env`** on the droplet (git-ignored — see
`.gitignore`; set manually on the box). Loaded via `require('dotenv').config()` at the top of
every entry script. **Never commit `.env`; never print secret values.** `.env.example` is the
committed template (variable names only).

| Variable | Purpose | Notes |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Managed Postgres connection (`db.js`). | `DB_SSL=require` also present in the example. Port 25060, user `doadmin`, db `defaultdb`. |
| `OXYLABS_USERNAME`, `OXYLABS_PASSWORD` | Oxylabs Web Scraper API auth (`lib/scrape-http.js`). | Required for all scrape jobs. |
| `SLACK_WEBHOOK_URL` | cron-wrapper warning/failure alerts + weekly report posts. | Without it, runs are **silent** on failure. Phase 9+ requires it. |
| `SLACK_BOT_TOKEN` (`xoxb-…`) | Spot-check review-queue posting + reading reactions (`chat:write`, `reactions:read`). | **Separate** from the webhook. Used only by `cohort-spotcheck-gate.js` + `spotcheck-reaction-poller.js`. Setup: `SLACK-REVIEW-SETUP.md`. |
| `SLACK_REVIEW_CHANNEL` (`C0…`) | Channel id (not name) for the review queue; bot must be invited. | |
| `SLACK_ALLOWED_REACTORS` (`U0…`) | Comma-sep Slack user id(s) allowed to confirm removals via emoji. | **Set before trusting auto-removal** — absent → poller accepts ALL reactors (first-run fallback only). |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional Mode-B Claude vision adjudicator in spot-check. | Absent → deterministic Mode A. |
| `MAX_OXY_CALLS`, `SOLD_MATCH_BRIDGE`, `RECHECK_BRIDGE_FINAL_ONLY`, `SOLD_BATCH_FETCH_FAIL_THRESHOLD`, `SOLD_BATCH_CONC` | Sold-match batch tuning/cost levers. | Set `MAX_OXY_CALLS=8000` in `.env` (the `lib/sold-transport.js` default of 4000 is too low for a full fortnight). Details in `deploy-instructions.md` Phase 19 section. |
| `DHASH_THRESHOLD` | Spot-check dHash auto-confirm distance (default 6). | Do not raise without reviewing the minDist distribution. |
| `VIEW_SERVER_HOST`, `VIEW_SERVER_PORT` (3800) | Written by `setup-droplet.sh` for the view-data systemd service. | |

**Known dead-credential issue:** the **price-scraper droplet's own Oxylabs API creds are DEAD
(401)** as of Phase 23 — prod on that box won't scrape until the team refreshes them (verified
off-box that the code works on Decade's creds). This is on the *other* droplet's `.env`
(`/var/www/apps/hemnet/.env`), not this repo's. Track before relying on that box's fetch path.

---

## 4. Oxylabs (proxy / scraping transport)

- **How calls are made:** `lib/scrape-http.js` is the shared HTTP transport. It first tries a
  **direct `curl --http1.1 --compressed` shellout** (Cloudflare bypass), then transparently
  **falls back to the Oxylabs Web Scraper API** on 403/429/5xx. Endpoint:
  **`https://realtime.oxylabs.io/v1/queries`** (`OXYLABS_ENDPOINT`), 90 s timeout, 1 internal
  retry. Active plan: **Advanced ($249/mo)**, `source=universal`, `render=none`,
  `premium=false`.
- **Force-Oxylabs flag:** `SCRAPE_FORCE_OXYLABS=1` (alias `HEMNET_FORCE_OXYLABS=1`) skips the
  direct path entirely — required on the droplet because its datacenter IP now gets a
  Cloudflare 403 on direct Hemnet/Booli. Several cron lines set it inline. Sold-match batch
  forces it too.
- **Reality:** **Hemnet is now ~100% Oxylabs** (direct-curl stopped working 2026-05→2026-05-21)
  and **Booli view data is 100% Oxylabs steady-state** (a "100% fallback" warning on Job D is
  *expected noise*, not a fault). Oxylabs spend roughly doubled as a result.
- **Per-run counters:** `getOxylabsStats()` exposes `oxylabsCallCount / oxylabsFailureCount /
  directSuccessCount / oxylabsFallbackRate` (module-level singleton, combined across Hemnet +
  Booli); these land in `cron_job_log.result_summary`. Sold-match uses a **DB-backed atomic
  ceiling** (`sold_spend` table + `MAX_OXY_CALLS`).

### Account usage & cap (the real budget risk)

- **Account-wide usage API:** read via `https://data.oxylabs.io/v1/stats` (HTTP-basic with the
  Oxylabs account creds). Use it to check month-to-date consumption.
- **Monthly cap:** **262k non-JS requests/mo** (199.2k JS) on a flat $249/mo plan. Usage runs
  roughly **40–60% in a normal month** and has touched **86% in a heavy one** — headroom for
  about one more region. **This figure moves, so measure it rather than quoting this line:**
  ```
  curl -s -u "$OXYLABS_USERNAME:$OXYLABS_PASSWORD" https://data.oxylabs.io/v1/stats?group_by=month
  ```
  The response splits by source — add `google_search` (the sold-match SERP bridge) to
  `universal` for the true total.
- **County expansion is the main breach risk** — budget any new geographies against the cap
  before enabling. Do **not** launch paid Oxylabs runs without explicit per-run go-ahead
  (offline smokes + existing CSVs are free).

---

## 5. Deploy Process

**Canonical procedure is `deploy-instructions.md` (read fully).** Summary:

1. Commit & push to **`master`** on GitHub.
2. On the droplet: `cd /opt/hemnet-cohort-tracker && git pull`.
3. Cron jobs pick up new code on their next run — **no process restart needed** (except the
   `view-data-server` systemd unit, which would need `systemctl restart view-data-server`).
4. If a `git pull` introduced a migration, run it manually: `node <migrate-file>.js`.

**Invocation contract (critical):** every cron-scheduled script calls
`require('./cron-wrapper').runJob` **at module load**. The crontab must invoke each script
**directly** (`node cohort-track.js`), **NOT** `node cron-wrapper.js cohort-track.js` (which
is a no-op require — `cron-wrapper.js` exports only `runJob`, no CLI entry).

**Updating cron safely:**
```bash
crontab -l > /tmp/crontab-backup-$(date +%s).txt   # ALWAYS back up live state first
crontab -e                                          # edit
crontab -l                                          # verify
```
Note `crontab -e` is interactive — not usable from a non-interactive Claude/CI shell; do it in
a real SSH/tmux session.

**Deploy-drift risk (recurring, track it):** local ≠ origin ≠ droplet has bitten this project
repeatedly. History: cohort-tracker was once **42 commits behind** prod (local≠prod drift);
branch reconciliation for age-census / forsale-age is **outstanding** (unpushed branches,
duplicate commit `70ba1c5` vs `ce4dbca` needs rebase-not-merge). Before deploying, confirm
`git log origin/master` matches what the droplet has (`git -C /opt/hemnet-cohort-tracker rev-parse HEAD`).

**cron-wrapper.js** (the wrapper every job runs through) provides: DB connect with
exponential-backoff retry (3 attempts), inserts a `running` row in `cron_job_log`, sets
`statement_timeout=120000`, runs `main()`, runs optional `validate()` (→ status `warning`),
catches errors (→ `failure`), writes the final row, and posts a Slack alert on
warning/failure. It installs `uncaughtException` / `unhandledRejection` / SIGHUP/SIGTERM/SIGINT
handlers that flip the row to `failure`/`killed` via a fresh recovery client. **Caveat:** a
naked interactive console disconnect can still orphan a `running` row — always re-run long jobs
in **tmux** or via **nohup + disown** (see `deploy-instructions.md` §Re-run).

**cron-health.js** (`npm run health`) is the local/CLI health checker; **cron-health-slack.js**
is the deployed daily monitor (see §7).

---

## 6. Cron Schedule (all times UTC)

Full annotated crontab is in `deploy-instructions.md`. Enumerated:

**Weekly cohort pipeline (Sun→Mon fan-out):**
| Time | Job | Script |
|---|---|---|
| Sun 22:00 | Booli fetch cohort (Job C) | `booli-targeted-discovery.js` |
| Mon 03:00 | Hemnet match cohort (Job B) | `hemnet-targeted-match.js` |
| Mon 06:00 | Cohort create | `cohort-create.js` |
| Mon 06:30 | Spot-check QA gate | `cohort-spotcheck-gate.js` |
| Mon 07:30 | Sold-match batch (**fortnightly effect** — no-ops on odd ISO weeks) | `sold-match-batch.js` |
| Mon 08:50 | Pre-market flow measure (`SCRAPE_FORCE_OXYLABS=1`) | `scripts/premarket-flow-measure.js` |
| Mon 09:00 | Weekly view report | `weekly-view-report.js` |
| Mon 09:35 | Market-supply weekly pulse | `market-totals-weekly-report.js` |
| Mon 09:40 | Pre-market flow weekly report | `premarket-flow-weekly-report.js` |
| Mon 11:00 | Sold-match Slack report | `sold-match-report.js` |
| Mon 11:05 | Sold-match trend chart | `sold-match-trend-chart.js` |
| Mon 11:10 | Sold-match audit xlsx | `sold-match-xlsx.js` |

**Every-2-days view-refresh cycle (odd days of month):**
| Time | Job | Script |
|---|---|---|
| 14:00 (odd days) | Booli view data (Job D) — parallel | `booli-targeted-refresh.js` |
| 14:00 (odd days) | Hemnet view data (Job A) — parallel | `hemnet-targeted-refresh.js` |
| 22:00 (odd days) | Cohort track | `cohort-track.js` |

**Daily:**
| Time | Job | Script |
|---|---|---|
| 03:00 daily | Cron health monitor (→ Slack) | `cron-health-slack.js` |
| 08:30 daily | Market-totals capture (3 Oxylabs reqs, 4 rows/day) | `market-totals-daily.js` |
| 12:00 daily | Spot-check reaction poller | `spotcheck-reaction-poller.js` |

Notes: Job C must finish before Job B (B reads C's rows). Combined Job A+D parallel load is
~4% of the Oxylabs 50/sec cap. `cohort-track` daily 23:30/02:00 lines were **removed** (D-07) —
it now only runs on the every-2-days cycle. The retired pre-v2.0 Pool & Flow Monday fan-out
(4 scripts) is gone. `weekly-view-report.js` cron line is (re)installed by `setup-droplet.sh`.

---

## 7. Monitoring & Alerting

Full treatment — every message shape, the tier rationale, what silence proves — is in
**[`05-MONITORING-AND-ALERTS.md`](05-MONITORING-AND-ALERTS.md)**. What follows is the
infrastructure-level summary, in four layers, most useful first:

1. **Tier-gated alerts → `#hemnet-ops`.** `cron-wrapper.js` decides on *every* outcome whether
   to alert, based on the job's `tier` in `lib/job-registry.js`. **Tier 1** (perishable — a
   missed run destroys an observation that can never be recovered) posts
   `🚨 TIER1 <!channel> [FAILURE|WARNING|KILLED] …`. **Tier 2** (recoverable — reports, exports,
   retention) posts **nothing** and surfaces only in the daily digest. A repeating tier-1
   condition alerts on a **0h / +24h / +72h / then daily** ladder, not on every run, and clears
   after two consecutive clean runs.
   > **This is why the channel is quiet, and quiet is not proof of health.** 56 of the 59 alerts
   > in the 60 days to 2026-08-17 came from one recurring tier-2 warning, and the 3 that mattered
   > were missed in the noise. Read `05` §5 before concluding that silence means healthy.
2. **`cron-health-slack.js` (daily 03:00 UTC → `#hemnet-ops`)** — the digest, in six sections:
   Liveness, Assertions, Open conditions, Tier-1 backstop, Disk headroom, and the two
   cross-cutting product checks (view-growth; per-cohort null-view rates with a canary on the
   newest cohort). Coverage is **derived from `lib/job-registry.js`** — every scheduled job, not
   a hardcoded list — and both liveness and assertions anchor on each job's
   `last_expected_fire + grace` rather than a fixed window, because the digest runs at 03:00 and
   any "a row for today" test would fail every day.
   **Assertions test each tier-1 job's own output table, not its exit code** — exit 0 is not
   evidence, and a job that exited clean having written nothing broke the spot-check gate for
   three consecutive weeks (`05` §7, incident 3).
3. **Two sibling modes of the same script.** `--sweep` (`cron-health-sweep`, 01/11/17/23) checks
   for missing / orphaned / failing **tier-1** jobs between digests and posts **one** rolled-up
   message however many are broken. `--heartbeat` (`alerting-heartbeat`, Thu 12:00) posts an
   unconditional proof-of-life over the raw webhook — **its absence is the alert**, since every
   other message is conditional and a dead transport otherwise looks exactly like a healthy week.
4. **`cron_job_log` + `alert_state` + `/var/log/hemnet/<job>.log`.** `node
   scripts/verify-cron-job-log.js` prints the last 5 rows per script. The per-job log holds full
   stdout/stderr for deep triage — **including child-process output**, which is how signal kills
   are diagnosed: a child killed by the kernel prints no stack, so an error line with *nothing
   before it* is itself the evidence (see §8). `alert_state` holds live suppression state.

**Two tables back this**, created by `node migrate-alert-state.js` (idempotent, `--check`):
`alert_state` (suppression) and `disk_sample` (one row/day, feeding `days_to_full`).

🚨 **The crontab is GENERATED from `lib/job-registry.js` — never hand-edit it.**
`node scripts/render-crontab.js | crontab -`; `--check` detects drift and runs as a digest
assertion.

Per-job failure-mode triage (Oxylabs creds, low-match warnings, budget-exceeded, expected Booli
100%-fallback noise, etc.) is documented job-by-job in `deploy-instructions.md` §Runbook — the
first place to look when an alert fires.

---

## 8. Disk / Capacity & Retention

**This (cohort-tracker) box** — 2 GB RAM, 50 GB disk, **no swap** (§1). Both are comfortable
today: the volume runs around 15% used, and the heaviest job peaks at ~550 MB against 2 GB.

**Memory is the tighter of the two, and it is the one that fails silently.**

- **What consumes it.** `export-hb-ratio-xlsx.js` builds an entire workbook in memory —
  ~1,586 pairs × 249 columns ≈ **395,000 cells** via exceljs `new Workbook()` +
  `wb.xlsx.writeFile()` — peaking at **~550 MB**, and **its memory grows with cohort size**.
  `cohort-spotcheck-gate`'s photo child holds ~170 MB, and it overlaps the 5-hour
  `sold-match-batch` (~65 MB) from 07:30 on a Monday.
- **How it fails.** With no swap, a process that exceeds available memory is **SIGKILLed
  outright** — no stack trace, no degraded performance. `weekly-view-report.js` loops cohorts
  with `execSync` inside a `try/catch` that logs and continues, so the parent still exits
  `success` and **the symptom is cohorts quietly missing from the weekly report**, not an error.
  Check the report names the cohorts you expect.
- **How to diagnose it.** A kernel OOM leaves the job log showing an error line with *nothing
  before it* — that absence is the signature, not missing plumbing. Confirm with
  `journalctl | grep "Killed process"` before assuming a code bug. And note that a peak measured
  while a job is being killed is the **ceiling, not the requirement**: measure again with
  headroom before concluding how much it needs.
- **How to measure it.** `node scripts/mem-profile.js -- node <job>.js` reports peak RSS across
  the whole process tree, minimum `MemAvailable`, and a plateau-vs-climbing verdict. A job still
  climbing in its final third retains per-item state and will outgrow any ceiling you buy it.

**Retention:**

- `spotcheck-artifact-retention` (daily 06:20) keeps the 3 newest `verf-spotcheck-*` cohorts at
  roughly 1 GB each. It prunes *before* the gate writes the new cohort at ~06:38, so **4 cohorts
  sit on disk six days out of seven**. Harmless at 50 GB — noted only so it is not
  re-diagnosed as "the prune is not running", which is exactly what it looks like and is not.
- `soldmatch-cache-retention` (daily 06:30) trims `verf-soldspike/cache` at `-mtime +3`,
  **preserving the `_*` ledger files** — `_spend.json` is the Oxylabs spend ledger and must
  survive. A fortnightly `sold-match-batch` writes ~1.9 GB here in one run.
- `premarket-quality-retention` (daily 06:35) drops `quality-*.json` older than 70 days.
- Large scrape artifacts are git-ignored (`view-data/`, `cohort-*-views.csv`,
  `verf-soldspike*/cache/`, `data/*.xlsx`). `/var/log/hemnet/*.log` is under logrotate.

**Known open data cleanup:** 86 stale "no-photos" UNCERTAIN spot-check rows from the 2026-W27
write-back incident; the guard (abort if 0 galleries) and the on-disk recovery tool shipped in
`496537b`.

**Price-scraper box (`170.64.181.89`, reference):** hit 100% disk history too; v4.0 Phase 24
reclaimed ~17 GB (deleted a 4.4 GB `kill.log` from the malware suppressor, 6.6 GB
`scraper_log_export`, Docker build cache). **~49 GB of `simple_history` DB bloat in the shared
`defaultdb` remains DEFERRED** — worth watching since it's the same database this repo uses.

---

## Quick reference — first things a new operator should do

1. SSH to `170.64.197.241` (the cohort-tracker box); code at `/opt/hemnet-cohort-tracker`.
2. Confirm `.env` has `DB_*`, `OXYLABS_*`, `SLACK_WEBHOOK_URL` set; check droplet HEAD ==
   `origin/master`.
3. `node scripts/verify-cron-job-log.js` — confirm all jobs ran recently, none `failure`/`NO ROWS`.
4. Watch the Slack `Hemnet Status` channel; confirm the daily 03:00 health report is arriving.
5. Check Oxylabs month-to-date via `data.oxylabs.io/v1/stats` against the 262k cap before any
   scope expansion.
6. Read `deploy-instructions.md` end-to-end — it is the authoritative runbook this document
   summarizes.
