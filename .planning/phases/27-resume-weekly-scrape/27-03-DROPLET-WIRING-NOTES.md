# 27-03 — Droplet Wiring Notes (ad-cost scrape resume)

**Date:** 2026-07-01
**Droplet:** 357087018 / 170.64.181.89 (price-scraper box, s-1vcpu-2gb)
**Repo on box:** `/var/www/apps/hemnet`
**Feature branch:** `feat/adcost-steel-resume` (forked off `feat/p24-durable-hardening`, the box's running HEAD)
**Commit:** `4a5e1a7` — `feat(adcost): resume scrape via Steel residential + webPricingCalculator`
**NEVER pushed; NEVER on team main.** `git log origin/main..HEAD` = 3 commits (2 inherited P24 + this one).

## What changed on the box

| File | Change |
|------|--------|
| `apps/hemnet/adcost_steel.py` | **NEW** — standalone async crawler. Steel session via `requests` (Steel HTTP API), driven over CDP by `playwright.async_api` (v1.52, already in image). Clears Cloudflare (retry-on-block), in-page `fetch('/graphql')` for `webAutocompleteLocations` → `webPricingCalculator`, parses `amountInCents/100` + slug→ad_type. Reads `STEEL_API_KEY` from env or `/app/.env`. Prints rows JSON on stdout. |
| `apps/hemnet/tasks.py` | `search_ad_cost_2` egress rewired: builds the (muni, price) grid from `AdCostPricePointV2`, runs the crawler as a **subprocess** (`sys.executable adcost_steel.py`) to escape the worker's eventlet loop, writes `AdCostV2` (rounds `ad_price` to int; drops the now-wrong BASIC-sum). |
| `.env` (gitignored, untracked) | Appended `STEEL_API_KEY=…` (value NOT recorded here). Visible in-container at `/app/.env` via the `.:/app` volume mount. |

## Key architecture decisions (deviations from the plan, justified)

1. **No image rebuild.** The compose mounts `volumes: - .:/app`, so the container sees host
   files live. Code changes need only a **worker restart**, not a rebuild. Done:
   `docker restart hemnet-crawler` (isolated; did NOT touch metabase / crawler-playwright,
   which the P25 `docker-compose.override.yml` gates to the `ondemand` profile).
2. **Key via `/app/.env`, not the `environment:` allow-list.** The `crawler` service env is an
   explicit allow-list with no `STEEL_API_KEY`. Rather than edit compose + recreate the
   container (riskier on the RAM-tight box), the crawler reads the gitignored `/app/.env`
   directly (env var still takes precedence if ever injected).
3. **Subprocess, not inline.** The task runs on `crawler` (`celery -P eventlet`); Playwright is
   incompatible with eventlet monkey-patching, so the browser flow runs in a child plain-Python
   interpreter. Verified: `apps.hemnet.adcost_steel` imports with no eventlet conflict.
4. **GraphQL contract corrected** (the real reason for the deviation): old
   `SellerMarketingProductPrices` is gone; ported to `webPricingCalculator`. See 27-02-SUMMARY
   and 27-GRAPHQL-CONTRACT.md.

## Verification (all passed, no scrape fired)

- `docker exec hemnet-crawler python manage.py shell -c "import apps.hemnet.tasks as t; ..."` → task import OK
- `docker exec hemnet-crawler python -c "import apps.hemnet.adcost_steel as a; ..."` → crawler import OK
- celery worker banner lists `apps.hemnet.tasks.search_ad_cost_2`
- `parse_pricing` in-container fixture test → BAS→BASIC 6820, RAKETEN_3_DAGAR→TOPLISTING 1580
- both ad-cost PeriodicTasks `enabled=False` (weekly still off)
- `.env` gitignored (`.env` + `*.env`) and `git status --porcelain .env` empty

## Cost note

The task decorator keeps `autoretry_for=(Exception,)` + `max_retries=5`. On a persistent
Cloudflare failure the crawler retries 5 sessions internally, and celery may retry the task up
to 5× → worst case ~25 Steel sessions (~$3) before giving up. Acceptable ceiling for a weekly
task; 27-04 validates a real run before the cron is enabled.

## Revert path

- Code: `git -C /var/www/apps/hemnet checkout feat/p24-durable-hardening` (or
  `git revert 4a5e1a7`), then `docker restart hemnet-crawler`. Backup of the original task at
  `/root/tasks.py.bak-*`.
- Secret: remove the `STEEL_API_KEY=` line from `/var/www/apps/hemnet/.env`.
- Nothing was baked into an image layer; no container was recreated; metabase/crawler-playwright
  remain `ondemand`-gated.
