# Plan 23-01 Summary — Re-wire Hemnet fetch to Oxylabs (on a feature branch)

**Status:** Complete (2026-06-29) · all task gates green
**Plan:** 23-01 · Wave 1 · `requirements: FETCH-01, FETCH-03 (routing half)`
**Artifacts:** `.planning/phases/23-.../23-SNAPSHOT.md` (rollback record) + on-droplet commit on branch `feat/hemnet-oxylabs-fetch`
**Droplet:** `170.64.181.89` · repo `tt7676/hem-bol-scrapers` · `/var/www/apps/hemnet`

## What was done
1. **Snapshot (Task 1, read-only):** captured exact pre-edit state into `23-SNAPSHOT.md` — on-droplet HEAD `ff397e9` (branch `main`, clean), the original local-Chromium fetch routing, the original `CELERY_TASK_ROUTES`, the `WebScraper` entry-point signature, the `crawler-playwright` container/service state + `free -h`, and a one-line revert recipe. Zero secret tokens (gate = 0). **No droplet file mutated.**
2. **Re-wire (Task 2) on branch `feat/hemnet-oxylabs-fetch`:**
   - `apps/hemnet/tasks.py`: added `from apps.core.webscraper import WebScraper` and a helper `fetch_via_webscraper(url) -> (status, content)` (mirrors `apps/booli/tasks.py`'s `WebScraper(...).run()`); replaced all **4** `run_async(get_page_source(url))` call sites (in `scrape_listing_2`, `search_listings_2.load_page`, `__search_listings_2`, `search_pre_market_listings_2`). The local-Chromium path (`init_browser`/`get_page_source`) is left fully intact as a one-line revert.
   - `config/settings/base.py`: repointed the 3 Hemnet fetch routes (`search_listings_2`, `search_pre_market_listings_2`, `scrape_listing_2`) from `playwright_queue` → the **default** queue.

## Why base.py too (deviation from stated files_modified)
23-01's `files_modified` listed only `apps/hemnet/tasks.py`, but the queue **routing lives in `config/settings/base.py`** (`CELERY_TASK_ROUTES`), not in tasks.py. Without repointing those 3 routes, the tasks would still target `playwright_queue` (consumed only by `hemnet-crawler-playwright`), and **Phase 23-03's stop of that worker would strand all Hemnet scraping**. Editing base.py on the same feature branch is therefore necessary to satisfy FETCH-03's routing half and to make 23-03 safe. Reversible (one commit, branch-isolated).

## search_ad_cost_2 — intentionally NOT re-wired (documented)
`search_ad_cost_2` is a direct GraphQL `requests.post(GRAPHQL_URL, ...)` on the **default** queue — it never used local Chromium / `playwright_queue` and is not the 403-blocked HTML path. Routing GraphQL POSTs through `WebScraper` (a URL page-fetcher) is out of scope and higher-risk, and has no bearing on retiring the Playwright RAM driver (the phase goal). Left unchanged; flagged for a possible small follow-up if the operator wants ad-cost on Oxylabs too.

## Self-Check: PASSED — verification evidence
- `git branch --show-current` = `feat/hemnet-oxylabs-fetch`; **1** commit on branch (`7d0fe7c`); `git rev-parse main` = `ff397e9d197ecffd4bb3d3f7bfeb39b78a900466` (== pre-edit HEAD; **main untouched, not pushed**).
- In-container `ast.parse` of tasks.py + base.py → `PARSE_OK`. Django import smoke → `IMPORT_OK` (helper present, `WebScraper` resolves, no circular import).
- Runtime route resolution: `search_listings_2 / search_pre_market_listings_2 / scrape_listing_2` all → `{'queue': 'default'}`.
- `grep -vE '^#' tasks.py | grep -c webscraper` = **7** (≥2). Per-function: `search_listings_2`=1, `scrape_listing_2`=1, `search_pre_market_listings_2`=1, `search_ad_cost_2`=0 (deviation, above).
- Remaining `run_async(get_page_source(` call sites = **0**. `PLAYWRIGHT_QUEUE` routes in base.py = **0**. Active `.delay()/apply_async()` on the fetch path enqueue with no explicit queue → follow routes → `default` (not playwright_queue).
- Secret scan on the commit = **0**; on `23-SNAPSHOT.md` = **0**.

## Reversibility
- `cd /var/www/apps/hemnet && git checkout main` → back to `ff397e9`. Or on-branch `git checkout -- apps/hemnet/tasks.py config/settings/base.py`. Or re-point the 3 routes back to `playwright_queue`. Local-Chromium code is still present and callable.

## Next
Plan 23-02: rebuild ONLY the `hemnet` image from this branch, restart ONLY the worker that runs the fetch (now the **default** `hemnet-crawler`), and run the pre-approved ~200-page verification crawl to prove ~0 403s + report Oxylabs cost.
