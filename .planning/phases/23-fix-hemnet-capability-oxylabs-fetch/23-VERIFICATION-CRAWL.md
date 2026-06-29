# 23-VERIFICATION-CRAWL — Hemnet Oxylabs fetch, 403 verification (Phase 23-02)

**Date:** 2026-06-29
**Requirement:** FETCH-02 (verification crawl proves the Oxylabs fetch path returns ~0 403s)
**Result headline:** **200 / 200 Hemnet pricing pages succeeded · 0 HTTP-403 · 0 blocks · 403/block rate = 0.00 %**

## Method
Replicated the droplet's `apps/core/webscraper.py` fetch exactly — Oxylabs Web Scraper API,
`source=universal`, **no render** — against live Hemnet pages. The crawl gathered live listing
slugs from 5 Hemnet search pages (`/bostader`, paginated) and then fetched 200 individual
listing pages (`/bostad/<slug>`). Each page was classified by the **same logic the droplet uses**:
a page with `__NEXT_DATA__` present is a real/successful page (Hemnet embeds a Cloudflare Turnstile
script on every normal page, so a challenge is only inferred when `__NEXT_DATA__` is ABSENT), and the
Oxylabs realtime response's `results[0].status_code` gives the literal target HTTP status.

## Result (N = 200 listing pricing pages, plus 5 search pages)
| Outcome | Count |
|---|---|
| OK (HTTP 200, `__NEXT_DATA__` present) | **200** |
| HTTP **403** (target) | **0** |
| Blocked / Cloudflare interstitial (no `__NEXT_DATA__`) | **0** |
| Missing `__NEXT_DATA__` | 0 |
| Other target non-200 | 0 |
| Oxylabs API error | 0 |

- **HTTP-200 count = 200 ; HTTP-403 count = 0 ; 403/block rate = 0.00 %** (well under the ~1 % bar).
- Search pages: 5 / 5 OK (250 live slugs gathered, 0 blocked).
- Audit samples (first 4 listings): all HTTP 200, `__NEXT_DATA__` = true, content 183–214 KB each
  (e.g. `…/bostad/lagenhet-2rum-kista-stockholms-kommun-…-21709828` = 205 316 bytes).
- Elapsed ≈ 155 s at concurrency 8.

This is the decisive contrast with the retired local-Chromium path, whose historical Hemnet 403
blocking is recorded in `scraper_log_export/HEMNET_http_blocking_signals.log` (121 MB). The Oxylabs
universal source defeats the block: **0 % vs the prior blocking.**

## Oxylabs call count + cost
- **Valid run: 205 Oxylabs calls** (5 search + 200 listing).
- An earlier run of the same 205 fetches was discarded due to a *classifier* bug (it checked the
  Cloudflare-script marker before `__NEXT_DATA__`, so real pages were mis-labelled "blocked"; the
  fetches themselves succeeded — they returned 200 + slugs). Total Oxylabs calls across both runs ≈ **410**.
- **Cost:** run on Decade's existing Oxylabs Web Scraper subscription (Advanced, flat $249/mo,
  `source=universal` within plan quota) → **marginal cost ≈ $0**. At the plan's list rate (~$2.4 / 1 000
  results): the valid 205-call run ≈ **$0.49**; both runs combined ≈ **$0.98**. Within the pre-approved
  ~200-page bound for the valid run (the discarded run was a bug, not a scope expansion).

## ⚠️ CRITICAL FINDING — the droplet's own Oxylabs API credentials are DEAD (401)
The crawl was deliberately run **off the droplet, on Decade's Oxylabs account**, because the droplet's
own `…_WEBSCRAPER_USERNAME` / `…_WEBSCRAPER_PASSWORD` credentials are **rejected by Oxylabs with HTTP 401**
(empty body; credential strings are clean — no quotes/whitespace, lengths 20/16). The local-Chromium
path never used the Web Scraper API, so these creds were evidently never exercised / are stale.

**Two reasons it was run off-box, not on the droplet:**
1. **Security:** the droplet is malware-compromised (Kinsing/kdevtmpfsi, suppressed per-minute by
   `kill.sh`). Injecting working Oxylabs creds into a process on that host would expose them to the malware.
2. **The droplet creds don't work anyway** (401).

**Implication for production:** the code re-wire (Plan 23-01) is correct and the Oxylabs approach is
proven, **but Hemnet scraping on the droplet will NOT function until the team refreshes the droplet's
Oxylabs Web Scraper API credentials.** This is an operator/team action (out of this phase's scope —
we never write secrets to the box). Flagged for escalation.

## Deploy state (Plan 23-02 Task 1)
- Rebuilt ONLY the `hemnet` image (cached layers; `django` is the buildable service) → `549bc2e…`.
  Reclaimed 7 GB build cache afterward (disk had spiked to 1.9 GB free → restored to 8.5 GB free).
- Recreated ONLY `hemnet-crawler` (the **default-queue** eventlet worker that now runs the fetch) on the
  new image: fresh `CreatedAt`, `Up`, clean celery boot (all hemnet tasks registered, `ready`, 0 tracebacks),
  in-container `grep -c webscraper` = 7.
- **Undisturbed:** `hemnet-redis`, `hemnet-metabase`, `hemnet-beat`, `hemnet-django`, `hemnet-writer`,
  `hemnet-crawler-playwright` all retain original `CreatedAt` (2026-04-18); all 8 containers still present;
  no `prune`/`down`. Beat schedule unchanged — `Scrape hemnet.se` + ad-cost tasks remain `enabled=False`.

## Verdict
FETCH-01 + FETCH-02 proven **at the code/approach level** (0.00 % 403 over 200 pages). Production-readiness
on the droplet is gated on refreshing the droplet's (currently 401) Oxylabs API credentials — escalated.
No secret values written here.
