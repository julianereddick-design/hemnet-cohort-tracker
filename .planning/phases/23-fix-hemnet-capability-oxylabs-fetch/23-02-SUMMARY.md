# Plan 23-02 Summary — Deploy re-wire + verification crawl

**Status:** Complete (2026-06-29) · FETCH-01 + FETCH-02 proven at code/approach level · 1 escalation (dead droplet Oxylabs creds)
**Plan:** 23-02 · Wave 2 · `requirements: FETCH-01, FETCH-02`
**Artifact:** `.planning/phases/23-.../23-VERIFICATION-CRAWL.md`

## What was done
1. **Rebuilt ONLY the `hemnet` image** from branch `feat/hemnet-oxylabs-fetch` (`docker compose build django` — `django` is the sole buildable service for the shared `hemnet` image; cached layers, no `--pull`/`--no-cache`, so no base/dep drift). New image `549bc2e…`. The build was non-disruptive (running containers kept serving the old image throughout).
   - **Disk note:** the rebuild spiked disk to **1.9 GB free (97 %)** because an old prune had invalidated the playwright layer cache (it re-ran `playwright install`). Reclaimed 7 GB of build cache (`docker builder prune -f`) → restored to **8.5 GB free**. Flagged: this box needs the Phase-24 disk reclaim; rebuilds here are expensive.
2. **Recreated ONLY `hemnet-crawler`** (the default-queue eventlet worker that now runs the re-wired fetch) on the new image: `docker compose up -d --no-deps --force-recreate crawler`. Fresh `CreatedAt`, `Up`, clean celery boot (all hemnet tasks registered, `ready`, 0 tracebacks), in-container `grep -c webscraper` = 7.
3. **Verification crawl (FETCH-02):** 200 Hemnet listing pricing pages + 5 search pages via the Oxylabs `source=universal` path → **200/200 OK, 0 HTTP-403, 0 blocks, 0.00 % block rate**. Run OFF the droplet on Decade's Oxylabs account (see escalation). ~205 calls (valid run); ~$0.49 list / ≈$0 marginal on the flat subscription.

## Disturb-nothing evidence
`docker ps` after recreate: `hemnet-crawler` fresh (`2026-06-29 11:53:46`, image `549bc2e`); **`hemnet-redis`, `hemnet-metabase`, `hemnet-beat`, `hemnet-django`, `hemnet-writer`, `hemnet-crawler-playwright` ALL retain original `CreatedAt` `2026-04-18`**; all 8 containers present (no `prune`/`down`). Beat schedule unchanged: `Scrape hemnet.se` (`search_listings_2`) + ad-cost tasks all `enabled=False`, `last_run=None`.

## ⚠️ Escalation — droplet Oxylabs API creds are DEAD (401)
The droplet's own Web Scraper API credentials are **rejected by Oxylabs with HTTP 401** (creds are clean strings; the local-Chromium path never used the API, so they're stale/never-exercised). The crawl was therefore run off-box on Decade's account — also avoiding exposing working creds on this **malware-compromised** host. **Consequence:** the code re-wire is correct and the approach is proven, but **Hemnet scraping on the droplet won't run until the team refreshes the droplet's Oxylabs Web Scraper API credentials** (operator/team action, out of phase scope — we write no secrets to the box).

## Self-Check: PASSED
- `23-VERIFICATION-CRAWL.md`: ≥15 lines, N=200, 403 rate 0.00 %, 403 count + 200 count + Oxylabs calls + cost stated, **0 secret patterns**.
- Targeted worker recreated on new code; all other containers + queues + beat schedule undisturbed.

## Next
Plan 23-03: stop `hemnet-crawler-playwright` (free ~6.2 GB RAM) reversibly. Safe regardless of the cred issue — beat is disabled (no live work) and the Hemnet fetch no longer routes to `playwright_queue`; `docker start` is the one-line revert. The dead-creds blocker is independent and escalated separately.
