# 23-SNAPSHOT — Pre-edit rollback record (Phase 23, Plan 01)

**Captured:** 2026-06-29 (read-only SSH, before any edit)
**Droplet:** `170.64.181.89` (team-owned price-scraper box, `s-8vcpu-16gb` syd1; hostname `ubuntu-s-1vcpu-2gb-syd1-01` is the stale provision-time name). App at `/var/www/apps/hemnet`.
**Repo:** `github.com/tt7676/hem-bol-scrapers`.

> NOTE: This file deliberately omits literal credential variable-name tokens (the secret-scan gate
> matches names, not just values). Where the source references env-var names, they are described
> generically ("Oxylabs webscraper creds", "DB url", "Django secret").

## 1. On-droplet git state (pre-edit)

- `git rev-parse HEAD`: **`ff397e9d197ecffd4bb3d3f7bfeb39b78a900466`**
- `git log -1 --oneline`: `ff397e9 Merge pull request #22 from tt7676/feat/webscraper-api`
- `git branch --show-current`: **`main`**
- `git status --porcelain`: only `?? scraper_log_export/` (untracked log dir; no tracked-file modifications)
- `git remote -v`: `origin  https://github.com/tt7676/hem-bol-scrapers.git` (fetch+push)

## 2. Original Hemnet fetch routing — `apps/hemnet/tasks.py` (1774 lines)

The Hemnet listing/search HTML fetch is driven by a **local headless-Chromium** path:

- `init_browser()` (L587) launches `playwright.chromium.launch(headless=True)`; only initialised in
  `worker_process_init` when the worker consumes `playwright_queue` (L617-621).
- `_get_page_source_inner(url)` (L629) does `page.goto(url, wait_until="domcontentloaded")` and
  returns `(status, content)` where `status = response.status` (the target page HTTP status).
- `get_page_source(url)` (L652) wraps the inner with an asyncio timeout; returns `(status, content)`.
- `run_async(coro)` (L583) = `asyncio.get_event_loop().run_until_complete(coro)`.

**The four fetch call sites (all the form `status, page_source = run_async(get_page_source(url))`):**
- L1006 — inside `scrape_listing_2` (detail page). `status >= 400` ⇒ failure.
- L1116 — inside `search_listings_2.load_page()` closure (search page; 4-retry loop).
- L1433 — inside `__search_listings_2` (legacy/dead variant; `search_listings_2(self)` takes no `url`,
  so the `search_listings_2.delay(url=...)` recursion at L1438/L1521 cannot target it — kept for parity).
- L1582 — inside `search_pre_market_listings_2`.

`search_ad_cost_2` (L1692) is **NOT** on this path — it issues direct `requests.post(GRAPHQL_URL, ...)`
GraphQL calls (L1728, L1743) on the default queue; it does not use Chromium / `playwright_queue`.

## 3. Original celery routing — `config/settings/base.py` `CELERY_TASK_ROUTES` (L268-300)

The three HTML-fetch tasks are routed to **`playwright_queue`** (consumed ONLY by `hemnet-crawler-playwright`):
```
"apps.hemnet.tasks.search_listings_2":            queue = playwright_queue
"apps.hemnet.tasks.search_pre_market_listings_2": queue = playwright_queue
"apps.hemnet.tasks.scrape_listing_2":             queue = playwright_queue
"apps.hemnet.tasks.save_listing_2":               queue = writer_queue
```
`search_ad_cost_2` is unrouted ⇒ `default` queue. `CELERY_TASK_DEFAULT_QUEUE` default = `default`.
No `CELERY_TASK_*` overrides exist in `.env` (verified by name-only grep).

## 4. Oxylabs entry point — `apps/core/webscraper.py` (the path to route through)

- Class `WebScraper` (dataclass). Constructor params: `url`, `source="universal"`,
  `endpoint="https://data.oxylabs.io/v1/queries"`, `username`, `password`, `render`,
  `poll_interval_s=2.0`, `max_wait_s=120.0`.
- `.run() -> str` posts to the Oxylabs queries endpoint and returns the page **content** (HTML) string;
  raises `HTTPError` on Oxylabs API status >= 400, `RuntimeError` on timeout/failed job.
- `_auth()` reads the Oxylabs webscraper username/password from environment via `os.getenv` (names per `.env`).
- Already used in production by `apps/booli/tasks.py` (`WebScraper(url=url, max_wait_s=300, poll_interval_s=3.0).run()`),
  which extracts `__NEXT_DATA__` from the returned HTML — the established pattern to mirror.
- `.env` has the Oxylabs webscraper username + password keys present (name-only grep = 1 each).

## 5. Worker / container + Playwright state (pre-edit)

Worker → queue map (from running `docker ps` commands + compose):
- `hemnet-crawler` = `celery worker -P eventlet` (no `-Q`) ⇒ **default** queue. (survives Phase 23-03)
- `hemnet-crawler-playwright` = `celery worker --concurrency=8 -Q playwright_queue` ⇒ the 6.2 GB RAM driver (stopped in 23-03)
- `hemnet-writer` = `-Q writer_queue --concurrency 2`
- `hemnet-beat` = celery beat (all scrape beat tasks DISABLED)

`docker ps -a` (Names / Status / CreatedAt) at snapshot time:
```
hemnet-crawler-playwright        Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-beat                      Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-writer                    Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-crawler                   Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-django                    Up 2 months   2026-04-18 09:16:45 +0000 UTC
hemnet-redis                     Up 2 months   2026-04-18 09:16:44 +0000 UTC
hemnet-metabase                  Up 2 months   2026-04-18 09:16:44 +0000 UTC
hemnet-django-run-e2e3a39dc795   Up 7 months   2025-11-18 08:34:50 +0000 UTC  (stale orphan)
```
`free -h` (pre-edit): Mem total 15Gi, **used 8.9Gi**, available 6.4Gi. Swap 0.

`crawler-playwright` compose service (`docker-compose.yml` L56-75) — env var names omitted per the gate:
```
crawler-playwright:
  image: hemnet
  container_name: hemnet-crawler-playwright
  depends_on: [django]
  command: celery -A config.celery worker --concurrency=8 -Q playwright_queue --loglevel=DEBUG
  restart: on-failure
  environment: [ 8 pass-through vars: DB/Django/Oxylabs creds — names omitted ]
  extra_hosts: [ host.docker.internal:host-gateway ]
  volumes: [ .:/app ]   # bind-mount: on-disk code is live in the container; a worker RESTART reloads it
```

## 6. Planned edit (Plan 23-01) and one-line revert recipe

**Edit (on branch `feat/hemnet-oxylabs-fetch` only):**
1. `apps/hemnet/tasks.py` — add `from apps.core.webscraper import WebScraper`; add helper
   `fetch_via_webscraper(url) -> (status, content)` (mirrors booli, `max_wait_s=110` to stay under
   `scrape_listing_2`'s 135 s soft limit); replace the 4 `run_async(get_page_source(url))` call sites
   with `fetch_via_webscraper(url)`. Local-Chromium code (`init_browser`/`get_page_source`) left intact.
2. `config/settings/base.py` — repoint the 3 `playwright_queue` routes to the `default` queue, so the
   fetch tasks run on the surviving `hemnet-crawler` (eventlet) worker. **This file is a necessary
   addition beyond 23-01's stated `files_modified` (tasks.py only): the queue routing lives in settings,
   and without it Phase 23-03 (stopping the Playwright worker) would strand all Hemnet scraping.**

**Scoping note (documented deviation):** `search_ad_cost_2` is intentionally NOT re-wired — it is a
GraphQL `requests.post` on the default queue, not the Chromium/`playwright_queue` HTML path that 403-blocks,
and routing GraphQL POSTs through `WebScraper` (a GET page-fetcher) is out of scope and higher-risk. The
phase goal (end HTML 403 blocking + retire the Playwright RAM driver) is fully met by re-wiring the three
HTML-fetch tasks. Flagged for operator review; an ad-cost-via-Oxylabs follow-up can be a small later change.

**One-line revert (per file, on the droplet checkout):**
- `cd /var/www/apps/hemnet && git checkout main` (returns to `ff397e9`, the pre-edit HEAD), **or**
- on the feature branch: `git checkout -- apps/hemnet/tasks.py config/settings/base.py` (discard edits), **or**
- selectively revert just the routing: re-point the 3 routes back to `playwright_queue` in `config/settings/base.py`.

Team `main` is never touched/force-pushed; pre-edit HEAD `ff397e9d197ecffd4bb3d3f7bfeb39b78a900466` is the rollback anchor.
