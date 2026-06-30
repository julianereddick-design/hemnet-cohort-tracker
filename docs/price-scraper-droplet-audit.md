# Price-Scraper Droplet — Deep-Dive Audit

**Droplet:** `ubuntu-s-1vcpu-2gb-syd1-01` (legacy name; actually an `s-8vcpu-16gb` box) · **IP** `170.64.181.89` · **Region** `syd1` · **Login** `root`
**Repo it runs:** `github.com/tt7676/hem-bol-scrapers` (team-maintained), deployed at `/var/www/apps/hemnet`
**Audited:** 2026-06-29 — **read-only audit; no droplet state was changed.** Access per `docs/price-scraper-droplet-runbook.md`.
**Raw evidence:** every number below is cited to `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md` (sections §1–§5), where the exact command + output is recorded.
**Purpose:** gives Phase 24 (cleanup) the evidence to remove nothing blind, and Phase 25 (right-size) the real baseline.

> ### ⚠ Two findings that change the milestone framing — read first
> 1. **The "6 apps" are Django apps inside ONE project**, not six deployments. `/var/www/apps/` holds only `hemnet/`; its `apps/` package contains `block_inc, booli, core, hemnet, procore, spotify` (evidence §1, `LOCAL_APPS`). Only the single `hemnet` Docker image runs (7 live containers + 1 stale orphan). **"Keep/kill" therefore means enabling/removing an app *module* (code + tables + beat task), not stopping a container.**
> 2. **🚨 Security: this box is running a per-minute anti-malware whack-a-mole.** The system crontab runs `/home/raymondsunartio/kill.sh` every minute; it kills and deletes `kinsing` + `kdevtmpfsi` — **known Linux cryptomining malware** (evidence §3). That per-minute `find / … -exec rm` + append is what grew the **4.4 GB `kill.log`**. This is an active/recurring infection being suppressed, not a clean host. **✅ REMEDIATED in Phase 24 (2026-06-30) — vector closed, host verified clean, kill.sh retired; see `docs/price-scraper-droplet-remediation.md` and Hygiene & deferred findings.**

---

## App inventory
*(AUDIT-01 — evidence §1: `docker ps -a`, `ls /var/www/apps`, `LOCAL_APPS`, per-app `find -printf %T+`, `git log -1`)*

Host runs **one** Django project (image `hemnet`) as 7 containers (+1 stale orphan). The "apps" are its sub-packages:

| App (module) | Runs as / where | Purpose | Owner | Last-active evidence |
|---|---|---|---|---|
| **hemnet** | `apps/hemnet` across hemnet-django / -crawler / -crawler-playwright / -writer / -beat | **Primary** Hemnet listing+price scraper → writes `hemnet_listingv2` (206 855 rows) | team (Illia/Raymond) | newest mtime 2026-04-18 (`tasks.py`); active source table |
| **booli** | `apps/booli`, same containers | Booli listing scraper → writes `booli_listing` (234 078 rows) | team | newest mtime 2026-04-18; active source table |
| **core** | `apps/core` (library, no tasks) | Shared lib: `webscraper.py` (Oxylabs path), `models.py`, `TimezoneMiddleware` (global) | team | mtime 2026-04-17; imported by scrapers |
| **block_inc** | `apps/block_inc` | Scraper for a third site; **beat task disabled** | team | mtime 2025-04-03 (~14 mo stale) |
| **procore** | `apps/procore` | Scraper for a third site; **beat task disabled** | team | mtime 2024-11-24 (~19 mo stale — oldest) |
| **spotify** | `apps/spotify` | Scraper; **beat task disabled**, no DB tables created | team | mtime 2025-10-15 (~8 mo stale) |

**Containers (all from image `hemnet`, up since 2026-04-18):** `hemnet-django` (runserver:8000), `hemnet-crawler` (celery default queue), `hemnet-crawler-playwright` (celery `playwright_queue`, conc=8, the RAM driver), `hemnet-writer` (celery `writer_queue`), `hemnet-beat` (scheduler), `hemnet-redis` (broker), `hemnet-metabase` (v0.47.1, :3000). Plus `hemnet-django-run-e2e3a39dc795` — a **stale orphan run-container up 7 months** (kill candidate, Phase 24). Owner across the board: **team** (last commit Illia Kupriianov, repo files Raymond Sunartio).

## Data + storage map
*(AUDIT-02 — evidence §2)*

**Postgres — EXTERNAL DigitalOcean managed DB (no local PG container).** `DATABASE_URL` → `db-postgresql-syd1-79303-…ondigitalocean.com:25060/defaultdb` (credential redacted, evidence §2). **`defaultdb` is shared with this cohort-tracker repo** — it holds both the scraper's source tables and the cohort/sold-match tables.

Databases: `defaultdb` **55 GB**, `eom_reviews` 24 MB, `hemnet_news` 10 MB, `Pocketsmith` 8.3 MB, `_dodb` 7.8 MB.

Largest tables in `defaultdb` (`pg_stat_user_tables`, evidence §2):

| Table | Live rows | Size | Note |
|---|---|---|---|
| `booli_historicallisting` | 0 | **34 GB** | `simple_history` bloat, no live rows |
| `hemnet_historicallistingv2` | 0 | **15 GB** | `simple_history` bloat, no live rows |
| `hemnet_listingv2` | 206 855 | 1 829 MB | ACTIVE — cohort tracker consumes |
| `booli_listing` | 234 078 | 1 473 MB | ACTIVE — cohort tracker consumes |
| `hemnet_listing` | 0 | 677 MB | legacy v1 |
| `hemnet_scrapeerror` | 0 | 446 MB | |
| `django_celery_results_taskresult` | 1 | 272 MB | managed by `backend_cleanup` |
| `block_inc_historicallisting` / `block_inc_listing` | 0 / 0 | 197 MB / 43 MB | stale app, no live rows |
| `procore_historicallisting` / `procore_listing` | 0 / 0 | 22 MB / 21 MB | stale app, no live rows |
| `cohort_daily_views`, `cohort_pairs`, `sold_match`, `view_log` | 408k / 16k / 1.6k / 10 | 46 MB … | **cohort-tracker tables (this repo)** in the same DB |

→ **~49 GB of the 55 GB is `simple_history` bloat** (`booli_historicallisting` 34 GB + `hemnet_historicallistingv2` 15 GB, both 0 live tuples). `spotify_*`: **no tables exist**. block_inc/procore tables all 0 live tuples.

**Redis** (`hemnet-redis`): broker only — `DBSIZE` 5 (all `_kombu.binding.*`), used_memory 8.66 MiB; queues `celery`/`playwright_queue`/`writer_queue` all depth 0 at capture (evidence §2/§3).

**Metabase**: `metabase/metabase:v0.47.1` on :3000, backing store = the same managed Postgres (`MB_DB_*`, value redacted).

**Docker** (`docker system df`): 14 images **10.71 GB (10.19 GB reclaimable, 95%)**, 8 containers 494 MB, 4 local volumes 25.4 MB, build cache 4.8 MB.

**Large on-disk logs** (sizes from `ls -la`/`du -sh`, contents never read — evidence §2):

| Path | Size |
|---|---|
| `/home/raymondsunartio/kill.log` | **4.4 GB** (4 685 891 472 B, still appending) |
| `scraper_log_export/writer_2025-11-01_to_11-20.log` | 1.7 GB |
| `scraper_log_export/hemnet_crawler_2025-11-01_to_11-20.log` | 1.5 GB |
| `scraper_log_export/HEMNET_key_errors.log` | 1.2 GB |
| `scraper_log_export/hemnet_playwright_2025-11-01_to_11-20.log` | 1.07 GB |
| `scraper_log_export/HEMNET_key_errors_tight.log` | 936 MB |
| `scraper_log_export/HEMNET_http_blocking_signals.log` | **121 MB** (the "blocking log") |
| `scraper_log_export/` (whole dir) | **6.6 GB** total |

→ Disk reclaim available (Phase 24): `kill.log` 4.4 GB + `scraper_log_export` 6.6 GB + reclaimable images 10.2 GB ≈ **21 GB of the 30 GB used**.

## Scheduled / triggered work
*(AUDIT-03 — evidence §3)*

| Source | What it runs | Cadence |
|---|---|---|
| **system crontab** | `/home/raymondsunartio/kill.sh` (kills/deletes `kinsing`+`kdevtmpfsi` malware → appends `kill.log`) | **every minute** (`* * * * *`) |
| system crontab (disabled) | `restart_crawler_playwright.sh` | line **commented out** (was `0 5 * * *`) |
| **Celery beat** `celery.backend_cleanup` | celery result cleanup | `0 4 * * *` UTC — **ENABLED** (last run 2026-06-29 04:00) |
| Celery beat `Scrape hemnet.se` (`apps.hemnet.tasks.search_listings_2`) | Hemnet scrape | `0 23 * * *` Sydney — **DISABLED** (`last_run=None`) |
| Celery beat `Scrape booli` (`apps.booli.tasks.search_listings`) | Booli scrape | `0 17 * * *` Sydney — **DISABLED** |
| Celery beat `Scrape hemnet.se ad cost` (`apps.hemnet.tasks.search_ad_cost_2`) | ad-cost scrape | `0 6 * * 1` Sydney — **DISABLED** |
| Celery beat `Scrape block inc` | block_inc scrape | `5 18 * * *` Sydney — **DISABLED** |
| Celery beat `Scrape procore` | procore scrape | `5 18 * * *` Sydney — **DISABLED** |
| Celery beat `Scrape spotify` | spotify scrape | `10 18 * * *` Sydney — **DISABLED** |
| restart scripts (`bin/`) | `restart.sh` (compose up+restart), `production.sh` (force-recreate + migrate) | manual / deploy-time |

**Decisive cadence fact:** the Celery beat schedule is DB-backed (`django_celery_beat.PeriodicTask`; no static `beat_schedule` in code). **Every scrape task is disabled** — including Hemnet and Booli. The only enabled periodic job is `celery.backend_cleanup`. So **live scraping is triggered manually/externally, not by the schedule** (workers up, queues empty at capture).

## Resource + cost baseline
*(AUDIT-04 — evidence §4: `doctl`, `nproc`, `free -h`, `df -h`, `docker stats`)*

**Confirmed slug: `s-8vcpu-16gb` — 8 vCPU / 16 GB RAM / 50 GB disk** (`doctl compute droplet list`: Memory 16384, VCPUs 8, Disk 50). The legacy name `ubuntu-s-1vcpu-2gb-syd1-01` is **misleading**; real cost ≈ $96–126/mo.

Actual usage at capture:
- **CPU:** load average `0.29, 0.18, 0.15` on 8 cores → **CPU almost entirely idle** (~2–4% of capacity).
- **RAM:** 15 Gi total, **8.9 Gi used**, 6.4 Gi available (no swap). Dominated by `hemnet-crawler-playwright` at **6.228 GiB** (40%); next is metabase 1.63 GiB. All others <330 MiB.
- **Disk:** `/dev/vda1` 49 G, **30 G used (62%)**, 19 G avail.

**Right-sizing read (Phase 25):** CPU is grossly over-provisioned. RAM is the only real constraint, and it's driven almost entirely by self-hosted Playwright (6.2 GB). **Phase 23 retires Playwright (→ Oxylabs), which removes that driver — after which a 4 vCPU / 8 GB slug is plausible**, pending log/DB cleanup to fit disk.

## Keep/kill recommendations
*(AUDIT-05 — evidence §5; verdicts driven by dependency evidence, not assertion)*

**Hemnet is the keep-by-default primary workload** — the entire reason the droplet exists; it is not up for kill. Verdicts for every non-Hemnet app:

| App | Verdict | What breaks if removed (dependency evidence) | Cite |
|---|---|---|---|
| **booli** | **Keep** | Produces `booli_listing` (234 078 live rows) in the shared `defaultdb`; **this cohort-tracker repo's cross-platform thesis consumes `booli_listing`** (and sold-match). Removing it starves the Hemnet-vs-Booli comparison. Resolves the milestone's open "Booli keep/kill" question = **Keep**. | §2, §5 |
| **core** | **Keep** | Shared library, 0 Celery tasks but provides `webscraper.py` (the Oxylabs path Phase 23 will use), `models.py`, and `apps.core.middleware.TimezoneMiddleware` wired into global `MIDDLEWARE`. hemnet+booli import it. Removing it breaks every scraper and Django startup. | §1, §5 |
| **block_inc** | **Kill** (audit-cleared) | Beat task disabled; code ~14 mo stale; all `block_inc_*` tables have **0 live tuples** (~240 MB dead). No consumer found in this repo or the scraper. Removing the module + dropping its empty tables breaks nothing observed. | §1, §2, §5 |
| **procore** | **Kill** (audit-cleared) | Beat task disabled; code ~19 mo stale (oldest); all `procore_*` tables **0 live tuples** (~45 MB dead). No consumer found. | §1, §2, §5 |
| **spotify** | **Kill** (audit-cleared) | Beat task disabled; code ~8 mo stale; **no `spotify_*` tables exist at all** — never produced data. Clearest kill. | §1, §2, §5 |

No app recommended for kill has any shared-DB live data, Redis coupling, cron reference, or cross-app import detected. Hemnet/booli/core share the managed Postgres + the single Redis broker (so they cannot be removed independently of the price product). **what breaks if removed** is recorded per row above so Phase 24 acts on evidence.

## Hygiene & deferred findings

- **✅ Cryptomining malware — REMEDIATED in Phase 24** (was: 🚨 escalate). `kill.sh` had whack-a-mole'd `kinsing`/`kdevtmpfsi` every minute. Phase 24 root-caused it: **no local re-spawner** (no rogue cron/systemd/ld.so.preload); the infection re-entered over the network via the **internet-exposed Metabase v0.47.1 (pre-auth RCE) + django `runserver` on :3000/:8000** (Docker port-publishing bypassed ufw, and no DO firewall existed). Fix: closed the vector host-side (DOCKER-USER + ufw), removed the suppressor, and **proved clean** (14-min window, 0 miner return with kill.sh off). kill.sh retired, kill.log deleted. Full record → **`docs/price-scraper-droplet-remediation.md`**. Durable source-hardening (localhost-bind + Metabase upgrade + `.env` rotation) scheduled for Phase 24 wave 24-05.
- **4.4 GB `kill.log` + 6.6 GB `scraper_log_export` + 10.2 GB reclaimable Docker images** ≈ 21 GB reclaimable on disk; **~49 GB `simple_history` DB bloat** (`booli_historicallisting` 34 GB + `hemnet_historicallistingv2` 15 GB, 0 live rows) — both are Phase 24 cleanup targets and Phase 25 right-sizing enablers.
- **✅ Stale orphan container** `hemnet-django-run-e2e3a39dc795` (up 7 months) — **removed in Phase 24 (24-03)** (config saved to `/root/24-backup/orphan-inspect.json` first).
- **✅ Dangling RSA key blob** on Tom's `/root/.ssh/authorized_keys` line 1 — **remediated in Phase 24 (24-04)**: file rewritten one key per line (3 known-good keys kept, inert blob dropped), fresh-login verified.
- **Disk reclaim done (24-03):** 4.4 GB `kill.log` + 6.6 GB `scraper_log_export` + 3.2 GB Docker build cache reclaimed (~17 GB; the 10.2 GB "dangling images" were already cleared in Phase 23, so the realized figure is lower than the 21 GB estimate). The **~49 GB `simple_history` DB bloat remains DEFERRED** (D-03).
- **Credentials discovered (location only, values redacted):** `/var/www/apps/hemnet/.env` holds `DATABASE_URL`, `DJANGO_SECRET_KEY`, `MB_DB_*`, and `OXYLABS_*` — none copied here. Recommend they stay out of logs/repo. `django runserver` (dev server) + `DEBUG` toolbar config in `base.py` on a prod box is worth hardening (note for a later phase).
- **Gating:** this audit **gates Phase 24 (cleanup)** — the keep/kill verdicts above authorize removals — and feeds **Phase 25 (right-size)** with the resource baseline.

---

*GSD milestone v4.0 · Phase 22 (Deep-dive audit) · read-only, 2026-06-29. Evidence: `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md`.*
