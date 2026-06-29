# Phase 22 — Deep-dive audit: raw evidence appendix

**Captured:** 2026-06-29 (read-only SSH sweep of the live team-owned price-scraper droplet `170.64.181.89`, root).
**Method:** every command below was run READ-ONLY via the Phase-21 key (`ssh -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=12 -i ~/.ssh/droplet_ed25519 root@170.64.181.89`). No droplet state was mutated. Credential values appear only as `<REDACTED>`; just key names / locations are recorded.
**Consumed by:** Plan 22-02 → `docs/price-scraper-droplet-audit.md`.

> **Headline reframing discovered during the sweep:** the milestone's "6 apps" (`hemnet`, `booli`, `spotify`, `procore`, `block_inc`, `core`) are **Django apps inside one project** (`/var/www/apps/hemnet/apps/*`), NOT six separate deployments. Only the single `hemnet` repo/image runs here. Keep/kill therefore means enabling/removing an app *module* (its tables, tasks, code), not killing a container.

---

## 1. App inventory & host

### `docker ps -a` (all containers — every one is from the single `hemnet` image)
```
NAMES                            IMAGE                       STATUS        CREATED AT
hemnet-crawler-playwright        hemnet                      Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-beat                      hemnet                      Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-writer                    hemnet                      Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-crawler                   hemnet                      Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-django                    hemnet                      Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-redis                     redis:7-alpine              Up 2 months   2026-04-18 09:16:44 +0000 UTC
hemnet-metabase                  metabase/metabase:v0.47.1   Up 2 months   2026-04-18 09:16:44 +0000 UTC
hemnet-django-run-e2e3a39dc795   hemnet                      Up 7 months   2025-11-18 08:34:50 +0000 UTC   <-- stale orphan run container
```

### `ls -la /var/www/apps/` — only ONE app tree on disk
```
drwxrwxr-x 11 raymondsunartio raymondsunartio 4096 Mar 19 07:05 hemnet
```
(`/var/www/` also has an empty `html/`. No booli/spotify/etc. directories — they are sub-apps, see below.)

### `docker-compose.yml` services (what each container actually runs)
```
redis               -> redis:7-alpine                    (Celery broker, container hemnet-redis)
django              -> python manage.py runserver 0.0.0.0:8000   (DEV server, port 8000)
crawler             -> celery -A config.celery worker -P eventlet --loglevel=INFO        (default queue)
crawler-playwright  -> celery -A config.celery worker --concurrency=8 -Q playwright_queue --loglevel=DEBUG
writer              -> celery -A config.celery worker -Q writer_queue --concurrency 2 --loglevel=INFO
beat                -> celery -A config.celery beat --loglevel=INFO                       (scheduler)
metabase            -> metabase/metabase:v0.47.1          (port 3000)
```
All app containers bind-mount the whole repo: `volumes: - .:/app`.

### The 6 Django apps (`config/settings/base.py` → `LOCAL_APPS`)
```
LOCAL_APPS = ("config", "apps.block_inc", "apps.booli", "apps.core",
              "apps.hemnet", "apps.procore", "apps.spotify")
THIRD_PARTY_APPS = ("django_celery_beat", "django_celery_results",
                    "django_extensions", "django_json_widget", "import_export", "simple_history")
```

### Per-app last-active evidence — newest file mtime in `apps/<app>/`
```
block_inc -> 2025-04-03  apps/block_inc/tasks.py     (~14 mo stale; untouched by the Apr-2026 deploy)
booli     -> 2026-04-18  apps/booli/tasks.py         (touched at last deploy — active)
core      -> 2026-04-17  apps/core/models.py         (touched at last deploy — active shared lib)
hemnet    -> 2026-04-18  apps/hemnet/tasks.py        (touched at last deploy — active, primary)
procore   -> 2024-11-24  apps/procore/tasks.py       (~19 mo stale — OLDEST)
spotify   -> 2025-10-15  apps/spotify/constants.py   (~8 mo stale)
```
(mtimes mostly reflect the git checkout date; the OLDER-than-deploy ones — procore, block_inc, spotify — are reliable staleness signals.)

### Per-app Celery task files (`grep -rlE '@shared_task|@app.task|@task'` count)
```
block_inc: 1   booli: 1   core: 0   hemnet: 2   procore: 1   spotify: 1
```
`core` has no Celery tasks — it is the shared library (webscraper, models, middleware), not a scraper.

### Owner / provenance
```
git remote: https://github.com/tt7676/hem-bol-scrapers.git   (branch: main)
last commit: ff397e9  IlliaKupriianov <114153535+IlliaKupriianov@users.noreply.github.com>
             Sat Apr 18 2026  "Merge pull request #22 from tt7676/feat/webscraper-api"
files owned by: raymondsunartio (repo tree)   |   docker/compose files owned by: root
```
Owners: **team (Illia Kupriianov = recent committer; Raymond Sunartio = repo file owner).** Not us.

## 4. Resource + cost baseline

### `doctl compute droplet list` — REAL slug confirmed (run from operator workstation, box untouched)
```
ID          Name                        Public IPv4     Region   Memory   VCPUs   Disk   Status
357087018   ubuntu-s-1vcpu-2gb-syd1-01  170.64.181.89   syd1     16384    8       50     active
```
The legacy name says `1vcpu-2gb`; the box is actually **8 VCPUs / 16384 MB (16 GB) RAM / 50 GB disk** = an `s-8vcpu-16gb` (~$96–126/mo). Confirms the Phase-21 carry-forward.

### `nproc; uptime; free -h; df -h`
```
nproc: 8
uptime: 09:00 up 228 days, load average: 0.29, 0.18, 0.15      <-- ~0.2 load on 8 cores = CPU almost entirely idle
free -h:  Mem total 15Gi | used 8.9Gi | free 224Mi | buff/cache 6.5Gi | available 6.4Gi   (Swap: 0B)
df -h /:  /dev/vda1  49G size  30G used  19G avail  62% used
```

### `docker stats --no-stream` (per-container live usage)
```
NAME                             CPU %    MEM USAGE / LIMIT     MEM %
hemnet-crawler-playwright        0.19%    6.228GiB / 15.61GiB   39.89%   <-- single biggest RAM consumer
hemnet-metabase                  0.47%    1.628GiB / 15.61GiB   10.43%
hemnet-django                    2.16%    328.5MiB / 15.61GiB    2.05%
hemnet-writer                    0.04%    208.9MiB / 15.61GiB    1.31%
hemnet-crawler                   0.10%    200MiB   / 15.61GiB    1.25%
hemnet-beat                      0.00%    75.61MiB / 15.61GiB    0.47%
hemnet-redis                     0.27%    8.656MiB / 15.61GiB    0.05%
hemnet-django-run-e2e3a39dc795   0.00%    49.36MiB / 15.61GiB    0.31%
```
**Right-sizing read (feeds Phase 25):** CPU is grossly over-provisioned (load ~0.2 / 8 cores). RAM ~8.9 GB of 16 GB used, dominated by `crawler-playwright` (6.2 GB). Retiring self-hosted Playwright (Phase 23, → Oxylabs) removes the main RAM driver and would make a 4 vCPU / 8 GB slug plausible.

---

## 2. Data + storage

### Postgres — EXTERNAL DigitalOcean **managed** database (no local PG container)
`.env` `DATABASE_URL` (credential stripped):
```
postgresql://doadmin:<REDACTED>@db-postgresql-syd1-79303-do-user-14149368-0.b.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```
Metabase points at the SAME managed cluster (`MB_DB_HOST=private-db-postgresql-syd1-79303-...`, `MB_DB_TYPE=postgres`).

#### Database sizes (`SELECT datname, pg_size_pretty(pg_database_size(datname)) ...`)
```
defaultdb     55 GB     <-- the price-scraper + cohort-tracker shared DB
eom_reviews   24 MB
hemnet_news   10 MB
Pocketsmith   8311 kB
_dodb         7823 kB
```

#### Top tables in `defaultdb` (`pg_stat_user_tables`, by total relation size)
```
relname                              n_live_tup   total_size
booli_historicallisting              0            34 GB     <-- simple_history bloat, 0 live rows
hemnet_historicallistingv2           0            15 GB     <-- simple_history bloat, 0 live rows
hemnet_listingv2                     206855       1829 MB   <-- ACTIVE hemnet source table (cohort tracker consumes)
booli_listing                        234078       1473 MB   <-- ACTIVE booli source table (cohort tracker consumes)
hemnet_listing                       0            677 MB    (legacy v1)
hemnet_scrapeerror                   0            446 MB
django_celery_results_taskresult     1            272 MB
booli_historicalagent                0            232 MB
block_inc_historicallisting          0            197 MB
hemnet_historicallisting             0            154 MB
metabase_field                       47930        53 MB     (Metabase metadata, same DB)
cohort_daily_views                   408328       46 MB     <-- COHORT-TRACKER table (this repo)
block_inc_listing                    0            43 MB
core_webscraperrunresult             0            41 MB
procore_historicallisting            0            22 MB
procore_listing                      0            21 MB
task_history                         100211       21 MB
cohort_unmatched                     2122         4408 kB   <-- cohort-tracker
cohort_pairs                         16696        4008 kB   <-- cohort-tracker
sold_match                           1588         2872 kB   <-- cohort-tracker (this repo, Phase 16)
view_log                             10           2680 kB   <-- cohort-tracker
```
**Key facts:** (a) `booli_historicallisting` 34 GB + `hemnet_historicallistingv2` 15 GB (both 0 live tuples) ≈ 49 GB of the 55 GB — `simple_history` bloat is the DB's size. (b) the SAME `defaultdb` holds BOTH the scraper's source tables AND this repo's cohort/sold-match tables → the two systems share one managed DB.

#### Stale-app tables (`relname ~ '^(spotify|procore|block_inc)_'`)
```
block_inc_businessunit       0   40 kB
block_inc_category           0   24 kB
block_inc_historicallisting  0   197 MB
block_inc_listing            0   43 MB
block_inc_region             0   24 kB
block_inc_scrapeerror        0   432 kB
procore_category             0   24 kB
procore_department           0   40 kB
procore_historicallisting    0   22 MB
procore_listing              0   21 MB
procore_scrapeerror          0   1520 kB
(spotify_* : NONE — the spotify app has no data tables at all)
```
Every block_inc and procore table has **0 live tuples**; spotify created none. No active data in any of the three.

### Redis (`hemnet-redis`) — broker only
```
docker exec hemnet-redis redis-cli INFO keyspace  ->  db0:keys=5,expires=0,avg_ttl=0
docker exec hemnet-redis redis-cli DBSIZE         ->  5
keys (--scan): _kombu.binding.{writer_queue,celeryev,playwright_queue,celery.pidbox,default}
queue depths: LLEN celery=0  LLEN playwright_queue=0  LLEN writer_queue=0    (idle at capture time)
mem: 8.656 MiB (from docker stats)
```

### Metabase
`metabase/metabase:v0.47.1`, container `hemnet-metabase`, port 3000, backing store = the same managed Postgres (`MB_DB_*` env, credential `<REDACTED>`).

### Docker volumes / images (`docker volume ls`, `docker system df`)
```
4 local volumes (hashed names), 25.4 MB total (99% reclaimable)
docker system df:
  Images          14 total, 3 active, 10.71GB, RECLAIMABLE 10.19GB (95%)
  Containers      8 total, 494.2MB
  Local Volumes   4 total, 25.4MB
  Build Cache     87, 4.8MB
```

### Large on-disk logs (sizes only — never read contents)
```
find ... -name '*.log' -printf '%s\t%p' | sort -rn | head:
4685891472  /home/raymondsunartio/kill.log                                       = 4.4 GB  (du -sh: 4.4G)
1726091890  /var/www/apps/hemnet/scraper_log_export/writer_2025-11-01_to_11-20.log          = 1.7 GB
1494865149  /var/www/apps/hemnet/scraper_log_export/hemnet_crawler_2025-11-01_to_11-20.log  = 1.5 GB
1231160396  /var/www/apps/hemnet/scraper_log_export/HEMNET_key_errors.log                   = 1.2 GB
1075403750  /var/www/apps/hemnet/scraper_log_export/hemnet_playwright_2025-11-01_to_11-20.log= 1.07 GB
 936493193  /var/www/apps/hemnet/scraper_log_export/HEMNET_key_errors_tight.log             = 936 MB
 352827107  /var/www/apps/hemnet/scraper_log_export/booli_crawler_2025-12-10_to_12-20.log   = 353 MB
 121124632  /var/www/apps/hemnet/scraper_log_export/HEMNET_http_blocking_signals.log        = 121 MB  <-- the "121 MB blocking log"
ls -la /home/raymondsunartio/kill.log -> -rw-r--r-- root root 4685891472 Jun 29 09:03 (still being appended)
du -sh /var/www/apps/hemnet/scraper_log_export -> 6.6G
```
Disk-reclaim opportunity (Phase 24): `kill.log` 4.4 G + `scraper_log_export` 6.6 G + reclaimable Docker images 10.2 G ≈ **21 GB of the 30 GB used**.

---

## 3. Scheduled / triggered work

### System cron (`crontab -l`)
```
* * * * * /home/raymondsunartio/kill.sh >> /home/raymondsunartio/kill.log 2>&1
# 0 5 * * * /home/raymondsunartio/restart_crawler_playwright.sh >> /home/raymondsunartio/restart_crawler.log 2>&1   (COMMENTED OUT)
```
`/etc/cron.d`, `cron.daily`, `cron.hourly`: only OS defaults (e2scrub, apt-compat, logrotate, man-db, dpkg, apport, droplet-agent) — nothing app-related.

**Cadence: `kill.sh` runs EVERY MINUTE.** Its content (a malware-suppression hack — see §5 / security note):
```bash
#!/bin/bash
kill $(pgrep kdevtmp)
kill $(pgrep kinsing)
find / -iname kdevtmpfsi -exec rm -fv {} \;
find / -iname kinsing    -exec rm -fv {} \;
```
This per-minute `find /` + append is what grows `kill.log` to 4.4 GB. `kdevtmpfsi`/`kinsing` = known Linux cryptomining malware.

### Celery beat schedule — DB-backed (`django_celery_beat.PeriodicTask`, 8 rows)
(No static `beat_schedule`/`CELERYBEAT_SCHEDULE` in code — `grep` found none; schedule lives in the managed DB.)
```
enabled | name                          | task                                  | schedule (cron)            | last_run
True    | celery.backend_cleanup        | celery.backend_cleanup                | 0 4 * * *  UTC             | 2026-06-29 04:00:00  <-- ONLY enabled task
False   | Scrape hemnet.se              | apps.hemnet.tasks.search_listings_2   | 0 23 * * * Australia/Sydney | None
False   | Scrape booli                  | apps.booli.tasks.search_listings      | 0 17 * * * Australia/Sydney | None
False   | Scrape hemnet.se ad cost      | apps.hemnet.tasks.search_ad_cost_2    | 0 6 * * 1  Australia/Sydney | None
False   | Scrape block inc              | apps.block_inc.tasks.search_listings  | 5 18 * * * Australia/Sydney | None
False   | Scrape procore                | apps.procore.tasks.search_listings    | 5 18 * * * Australia/Sydney | None
False   | [adhoc] Scrape hemnet.se ad cost | apps.hemnet.tasks.search_ad_cost_2 | (no schedule)              | None
False   | Scrape spotify                | apps.spotify.tasks.search_listings    | 10 18 * * * Australia/Sydney| None
```
**Critical:** EVERY scrape task is **disabled** (`enabled=False`, `last_run=None`) — including hemnet and booli. The only enabled periodic task is Celery's own `backend_cleanup`. So live scraping is **not** driven by the beat schedule; it is triggered manually/externally (e.g. invoking the task by hand). Workers are up but queues were empty (0) at capture.

### Restart / entrypoint scripts (`/var/www/apps/hemnet/bin/` + home)
```
bin/restart.sh                      -> cd repo; docker compose up -d; docker compose restart
bin/production.sh                   -> docker compose up -d --force-recreate --remove-orphans; exec django manage.py migrate
bin/db_local_refresh.sh             -> (local DB refresh helper)
/home/raymondsunartio/restart_crawler_playwright.sh -> cd repo; echo "Restarting..." >> /var/log/restart_crawler_playwright.log; docker compose restart crawler-playwright   (its cron line is COMMENTED OUT)
```

---

## 5. Dependency evidence (what breaks if an app/module is removed)

### Shared managed Postgres `defaultdb` (the central coupling)
- The droplet's `DATABASE_URL` and this repo's cohort-tracker BOTH point at `db-postgresql-syd1-79303-...:25060/defaultdb`. The scraper **produces** `hemnet_listingv2` (206 855 rows) and `booli_listing` (234 078 rows); the cohort tracker **consumes** them (and writes `cohort_*`, `sold_match`, `view_log` into the same DB). → removing the hemnet or booli scraper app starves the cohort-tracker thesis of its source tables.
- Metabase reads the same `defaultdb`.

### Shared Redis broker
- One `hemnet-redis` serves all Celery workers via queues `default`, `playwright_queue`, `writer_queue`. Per-app coupling is via these shared queues, not separate brokers.

### `core` = shared library (not a scraper)
- `apps.core` has **0 Celery tasks**; it provides `webscraper.py` (the Oxylabs path Phase 23 will use), `models.py`, and `apps.core.middleware.TimezoneMiddleware` (wired into global `MIDDLEWARE`). hemnet/booli scraping import from it. → `core` is a KEEP-by-dependency; removing it breaks every scraper and the Django middleware stack.

### Per-app keep/kill raw inputs
```
hemnet    : ACTIVE source app. Produces hemnet_listingv2 (1.8 GB, 206k rows). Tasks present (2 files), beat-disabled but the live workload. cohort tracker depends on it.  -> KEEP (primary).
booli     : ACTIVE source app. Produces booli_listing (1.5 GB, 234k rows). cohort tracker's cross-platform thesis depends on booli_listing.  -> KEEP (resolves the milestone's "Booli keep/kill" question = KEEP, dependency-backed).
core      : shared lib (webscraper/models/middleware), 0 tasks, imported by hemnet+booli, middleware globally wired.  -> KEEP.
block_inc : task disabled, code ~14 mo stale, all tables 0 live tuples (~240 MB dead).  -> KILL candidate (no active data, no consumer found).
procore   : task disabled, code ~19 mo stale (oldest), all tables 0 live tuples (~45 MB dead).  -> KILL candidate.
spotify   : task disabled, code ~8 mo stale, NO data tables at all.  -> KILL candidate (clearest).
```
(These are raw facts for Plan 22-02 to turn into the keep/kill section. No consumer of block_inc/procore/spotify data was found in this repo or the scraper.)

### Access hygiene (carry-forward from Phase 21 — confirmed)
`/root/.ssh/authorized_keys` has 3 functional keys; line 1 (Tom's ed25519) carries a **dangling inline `ssh-rsa` blob** (`grep -cE 'ssh-(rsa|ed25519).*ssh-(rsa|ed25519)'` = 1) ending `rsa-key-20230525` — inert (one-key-per-line), remediation deferred to Phase 24. Keys: 1=Tom ed25519 (+dangling rsa), 2=`raymondsunartio@aero-5-xe` rsa, 3=`julian-droplet` ed25519 (ours).

---

*Evidence captured read-only 2026-06-29 for Phase 22. No mutations performed; secrets redacted.*
