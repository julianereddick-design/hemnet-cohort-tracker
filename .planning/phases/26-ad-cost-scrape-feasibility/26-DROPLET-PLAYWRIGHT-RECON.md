# Phase 26 — Droplet Playwright Recon (ad-cost headless-browser feasibility)

**Date:** 2026-06-30
**Box:** price-scraper droplet `170.64.181.89` (`ubuntu-s-1vcpu-2gb-syd1-01`) — NOT the cohort-tracker box.
**Repo on box:** `/var/www/apps/hemnet` (github.com/tt7676/hem-bol-scrapers), Django/Celery. HEAD `ed7192c`.
**Mode:** READ-ONLY recon. No container started/stopped, no file edited, no scrape run. (`docker run` was correctly blocked by guardrail; used `docker exec` on the already-running `hemnet-django` instead.)

---

## 1. Container / image inventory

`docker ps -a`:

| Container | Image | Status | Ports |
|---|---|---|---|
| hemnet-django | hemnet | Up 5h | 127.0.0.1:8000->8000 |
| hemnet-crawler | hemnet | Up 5h | (default-queue worker) |
| hemnet-beat | hemnet | Up 5h | |
| hemnet-writer | hemnet | Up 5h | (writer_queue) |
| hemnet-redis | redis:7-alpine | Up 5h | 6379 |
| **hemnet-crawler-playwright** | **hemnet** | **Exited (0) 5h ago** | none |
| hemnet-metabase | metabase/metabase:v0.47.1 | Exited (137) 5h ago | none |

`docker images`: `hemnet:latest` / `hemnet:pre-24-05` (same id `549bc2ec0f41`, **10.5 GB**), an orphan `<none>` 3.54 GB, metabase, redis.

**The "Playwright service" = `hemnet-crawler-playwright`.** It is NOT a standalone browser server (no browserless, no CDP/9222/3000 endpoint). It is a **Celery worker** that consumes the `playwright_queue` and launches a **LOCAL headless Chromium in-process**:

- Cmd: `celery -A config.celery worker --concurrency=8 -Q playwright_queue --loglevel=DEBUG`
- RestartPolicy: **`no`** (live container), ExitCode 0, started 03:48 / finished 03:52 today.
- Last logs show 8 forked pool workers each closing a browser: `INFO/ForkPoolWorker-N Playwright browser closed` — i.e. each worker process owned its own Chromium. This is a worker-with-embedded-browser, not a shared CDP server.

**Chromium IS present in the image** (so no ~6 GB reinstall needed):
`docker exec hemnet-django`: playwright **1.52.0**, `/root/.cache/ms-playwright/chromium-1169/chrome-linux/chrome` → `CHROME_BINARY_PRESENT`.

## 2. How Playwright was wired (and what it fetched)

Code: `apps/hemnet/tasks.py`.
- `init_browser()` (L588): `playwright.chromium.launch(headless=True)`, one `new_context` with a hardcoded desktop Chrome UA (`Chrome/113.0.0.0`). Browser is started once per worker process via the `@worker_process_init.connect` hook **only if** `"playwright_queue" in current_app.amqp.queues` (L619–622).
- `get_page_source(url)` / `_get_page_source_inner` (L630–664): `page.goto(url, wait_until="domcontentloaded", timeout=60000)`, then waits for `networkidle` and for `script#__NEXT_DATA__` (8 s), returns `(status, content)`. Reads the page's `__NEXT_DATA__` JSON payload.
- **What it fetched:** Hemnet search + listing pages only — `https://www.hemnet.se/bostader?…` (search), `/kommande/bostader?…` (upcoming), `/bostad/<slug>` (listing detail). No `/priser`, no Booli.
- **Cloudflare handling:** essentially none beyond a desktop UA + waits. There is a downstream `detect_interstitial_reason()` that flags Cloudflare challenge markers (`cdn-cgi/challenge-platform`, `turnstile`, "verify you are human") but it only *detects* a block, it does not defeat one. No stealth plugin, no cookie priming, no Turnstile solver.
- `tasks_old.py` holds the original synchronous version (`sync_playwright`, same `chromium.launch(headless=True)`, same UA) — historical.

## 3. Hemnet-scrape history + what "gated off" means now

**Timeline (from code + git):**
- Originally Hemnet listing/search fetch ran through this **local headless Chromium** (Playwright) on `playwright_queue`. This is the path that broke against Hemnet's Cloudflare block (the May-2026 block referenced in project memory) — the embedded `detect_interstitial_reason` markers are the residue of that fight.
- **P23 (commit `7d0fe7c`, "route search/scrape fetch through Oxylabs webscraper (FETCH-01); move those tasks off playwright_queue to default (FETCH-03)")** rewired all Hemnet fetches to **Oxylabs Web Scraper API**:
  - `fetch_via_webscraper(url)` (tasks.py L666) → `WebScraper(url=…).run()`; `apps/core/webscraper.py` posts to `https://data.oxylabs.io/v1/queries` (`source="universal"`, optional `render`). All four live call-sites now use `fetch_via_webscraper` (L1031, L1141, L1458, L1607). `get_page_source` (local Chromium) is **dead code, never called** — intentionally left as a "one-line revert."
  - `CELERY_TASK_ROUTES` (config/settings/base.py L268+) now routes `search_listings_2`, `search_pre_market_listings_2`, `scrape_listing_2` to the **`default`** queue. Nothing is routed to `playwright_queue` anymore.
- **"Gated off" today = two layers, both confirmed:**
  1. **No producer:** nothing enqueues to `playwright_queue` (P23 reroute), so the worker has no work even if running.
  2. **Not started at boot (P25):** `docker-compose.override.yml` (created 2026-06-30 03:52) puts `crawler-playwright` (and `metabase`) behind `profiles: ["ondemand"]`, so `hemnet.service`'s boot-time `docker compose up -d` skips it; live container also set `--restart=no`. That is why it shows Exited(0) — it came up on reboot then was stopped when the override landed.
  - The image and the Chromium binary are **retained**; nothing was removed. "Gated off" did NOT delete the Playwright capability — it parked it.

**Crucially:** the local-Chromium Hemnet path was abandoned in favour of Oxylabs *because it was getting Cloudflare-blocked from this datacenter IP.* That is a direct negative signal for the headless-from-droplet ad-cost plan (see §5).

## 4. The existing ad-cost task (highly relevant)

`search_ad_cost_2` (tasks.py L1716) already exists and is the AdCostV2 path. **It does NOT use Playwright and does NOT use Oxylabs.** It does a direct `requests.post` to Hemnet's GraphQL:
- `GRAPHQL_URL = "https://www.hemnet.se/graphql"` (constants.py), plain desktop UA, `requests` default IP (the droplet's DC IP).
- Two ops: `AutocompleteLocations` (municipality → locationId) then **`SellerMarketingProductPrices`** with `productCodes = [BASIC, PLUS, PREMIUM, MAX, PAID_REPUBLISH, TOPLISTING, TOPLISTING_5_DAYS]` and `askingPrice` → returns `prices[].price.amount` per package. It then sums BASIC into PLUS/PREMIUM/MAX and writes `AdCostV2` rows.
- This is exactly the ad-package pricing we want — but via the GraphQL API, not by rendering `/priser`.

**Beat state (DB / django_celery_beat — DatabaseScheduler):** both ad-cost periodic tasks are **disabled**:
- `False | [adhoc] Scrape hemnet.se ad cost | apps.hemnet.tasks.search_ad_cost_2`
- `False | Scrape hemnet.se ad cost | apps.hemnet.tasks.search_ad_cost_2`
- (Every Hemnet/Booli scrape beat task is also `enabled=False` — matches the P22 finding. Only `celery.backend_cleanup` is enabled.)

So the existing ad-cost mechanism is a **direct GraphQL POST that is currently disabled** — and a direct POST from this IP is precisely what Cloudflare started blocking in May-2026.

## 5. Box resources

- `free -m`: total **1963 MB**, used 646, free 572, **available 1143 MB**, **Swap 0**.
- `df -h /`: 49 G total, 21 G used, **28 G free** (43%).
- Single vCPU (s-1vcpu-2gb, per P25 right-size).

## 6. Reusability verdict for the ad-cost headless-browser approach

**(a) Is reusable Playwright/Chromium infra still on the box?** **Yes.** The `hemnet` image carries Playwright 1.52.0 + a working Chromium binary (chromium-1169), and there is a ready-made local-launch path (`init_browser`/`get_page_source` in tasks.py, dead but intact). No ~6 GB reinstall needed. We would *not* reuse `crawler-playwright`'s queue plumbing for a one-shot ad-cost fetch — simpler to add a small task that calls `init_browser` + navigates `/priser`. The infra/image is reusable; the wiring is not a great fit as-is.

**(b) Resource risk on s-1vcpu-2gb?** **Moderate, manageable if single-concurrency.** ~1.1 GB free + **zero swap**. The old `crawler-playwright` ran `--concurrency=8` = 8 Chromiums — that would OOM this box. A **single** headless Chromium for a periodic ad-cost run (a few municipalities, sequential) fits in the ~1.1 GB headroom, but with no swap there is no safety margin if Metabase or a big crawl is also running. Keep it concurrency=1 and don't co-run with Metabase.

**(c) DC-IP vs Cloudflare — the decisive signal:** **Negative.** The single strongest piece of evidence on this box is that the local-headless-Chromium Hemnet fetch from *this datacenter IP* was **abandoned in P23 because it was Cloudflare-blocked** (the `detect_interstitial_reason` Cloudflare markers + the wholesale switch to Oxylabs). Separately, the existing ad-cost task hits `hemnet.se/graphql` directly from the DC IP and is disabled. So we have prior evidence that **both** a real headless browser **and** direct requests from this droplet's IP got blocked by Hemnet's Cloudflare. Julian's "works in a real browser" proof was almost certainly from a **residential IP**, not a Sydney DigitalOcean IP. The open risk is therefore not "can Chromium fill the form" — the image can do that — it is **"does headless Chromium from this DC IP pass Cloudflare's Turnstile/bot check on `/priser`."** Prior history says probably not.

### Bottom line
- **Reusable infra: yes** (image + Chromium + launch code all present; no reinstall).
- **Resource fit: yes at concurrency=1, no swap margin** — don't run alongside Metabase.
- **The blocker is unchanged and is the whole question: Cloudflare vs the droplet's datacenter IP.** History on this exact box (P23 Playwright abandonment + disabled direct-GraphQL ad-cost task) is a *negative* indicator. Before investing in a droplet-headless ad-cost build, the cheap decisive test is a one-off: run the existing in-image Chromium against `https://www.hemnet.se/priser` from the droplet and check for a Cloudflare challenge / `__NEXT_DATA__`. If it challenges (likely), the realistic productionizable paths are (i) re-enable the existing `search_ad_cost_2` GraphQL task but route it **through Oxylabs** (render=true), reusing the P23 `WebScraper` plumbing, or (ii) Oxylabs `render=html` on `/priser`. The local-headless-on-droplet path is the least likely to survive Cloudflare given this box's own history.

### Concrete evidence index
- `apps/hemnet/tasks.py` L588–600 (`init_browser`, `chromium.launch(headless=True)`), L630–664 (`get_page_source`), L666–693 (`fetch_via_webscraper` + P23 note), L619–622 (queue-gated browser init), L726+ (`detect_interstitial_reason` Cloudflare markers), L1716–1809 (`search_ad_cost_2`, GraphQL `SellerMarketingProductPrices`).
- `apps/hemnet/constants.py` L1–3 (`BASE_URL`, `GRAPHQL_URL=https://www.hemnet.se/graphql`, `USER_AGENT`).
- `apps/core/webscraper.py` L10–44 (Oxylabs `data.oxylabs.io/v1/queries`, `source=universal`, `render`).
- `config/settings/base.py` L263–298 (DatabaseScheduler; routes Hemnet tasks to `default`, none to `playwright_queue`).
- `docker-compose.yml` L56–61 (`crawler-playwright` concurrency=8 `-Q playwright_queue`); `docker-compose.override.yml` (P25 `profiles: ["ondemand"]` for crawler-playwright + metabase).
- git `7d0fe7c` (P23 FETCH-01/FETCH-03), `ed7192c` (P24 bind to 127.0.0.1).
- DB `django_celery_beat.PeriodicTask`: both `search_ad_cost_2` entries `enabled=False`.
