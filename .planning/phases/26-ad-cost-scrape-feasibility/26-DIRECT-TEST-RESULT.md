VERDICT: DIRECT_BLOCKED

# Phase 26 — Direct ad-cost (`search_ad_cost_2`) on-droplet test result

**Run:** 2026-06-30, on the price-scraper droplet `170.64.181.89` (Sydney), container `hemnet-django`.
**Cost:** ZERO Oxylabs spend. No creds read. No secrets written. No schedule change.
**Branch outcome:** smoke was non-200 → the representative all-10-municipality pass was **NOT run** (per the plan branch rule). FEAS-02 (a working fetch path producing fresh `AdCostV2` rows) is **deferred to 26-02** (Oxylabs rewire).

---

## Smoke HTTP status (the whole point of this test)

| Step | POST | HTTP status | Body signature |
|------|------|-------------|----------------|
| 1 (autocomplete) | `AutocompleteLocations` → `https://www.hemnet.se/graphql` | **403** | Cloudflare interstitial: `<!DOCTYPE html>…<title>Just a moment...</title>` |
| 2 (ad-cost) | `SellerMarketingProductPrices` | not reached | step 1 blocked first |

The direct GraphQL POST issued **from the droplet's own source IP** is intercepted by a **Cloudflare "Just a moment…" challenge (HTTP 403)** on the very first request. The block hits the autocomplete step before any location ID is resolved, so the ad-cost query is never reached and **no `AdCostV2` rows were written** (`FRESH_ROWS=0` for today). This is the `DIRECT_BLOCKED` signal that activates 26-02.

This confirms the post-May-2026 Cloudflare blocking that P23 already saw on Hemnet HTML fetches now **also covers the `search_ad_cost_2` GraphQL POST path** — the endpoint P23 had deliberately left un-rerouted (default celery queue, believed POST-not-Chromium). The direct path is dead from the droplet IP.

**Smoke cell:** muni `Göteborgs` (full name `Göteborgs kommun`), asking price `2 000 000` (first `AdCostPricePointV2` by muni+price).

---

## Recon — current shape of `search_ad_cost_2` (read read-only from droplet code)

**File:** `apps/hemnet/tasks.py::search_ad_cost_2` (repo `github.com/tt7676/hem-bol-scrapers`).

**Endpoint + headers (from `apps/hemnet/constants.py`):**
- `GRAPHQL_URL = "https://www.hemnet.se/graphql"`
- `USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) … Chrome/113.0.0.0 Safari/537.36"`
- `TIMEOUT = (30, 30)` (connect, read)
- Plain `requests.post(GRAPHQL_URL, headers={"user-agent": USER_AGENT}, json=payload, timeout=TIMEOUT)` — **no Cloudflare bypass, no Oxylabs**, raw `requests`.

**Two-step GraphQL POST per price point:**
1. `operationName: AutocompleteLocations` — `variables.query = price_point.property_municipality.name`, `limit: 5`, `types: ["STREET","MUNICIPALITY"]`. The code then matches a hit whose `fullName == property_municipality.full_name` to recover its `locationId`.
2. `operationName: SellerMarketingProductPrices` — `variables.locationId` (from step 1), `askingPrice = price_point.property_price`, `productCodes: ["BASIC","PLUS","PREMIUM","MAX","PAID_REPUBLISH","TOPLISTING","TOPLISTING_5_DAYS"]`. Reads `data.sellerMarketingProductPrices.prices[].{code, price.amount}`.

**Iteration:** `for price_point in AdCostPricePointV2.objects.all()` — **60 price points = 10 municipalities × 6 asking-price levels** (2M / 5M / 7.5M / 10M / 15M / 20M SEK). One autocomplete POST + one ad-cost POST per price point (≈120 POSTs for a full pass).

**Tier post-processing (additive packaging):** after fetch, `PLUS += BASIC`, `PREMIUM += BASIC`, `MAX += BASIC` (the displayed package price stacks the BASIC base) before writing rows.

**Write target — `apps/hemnet/models.py::AdCostV2`** (one row per tier per price point):
- `property_municipality` (FK → `MunicipalityV2`)
- `property_price` (PositiveIntegerField — the asking-price level)
- `ad_type` (CharField — the tier code, e.g. BASIC/PLUS/PREMIUM/MAX/PAID_REPUBLISH/TOPLISTING/TOPLISTING_5_DAYS)
- `ad_price` (PositiveIntegerField — the resolved package price)
- `valid_until` (DateField, nullable — written `None`)
- `crawled` (DateTimeField, `auto_now_add=True` — the freshness stamp; filter `crawled__date=today`)

**History (`AdCostV2`):** 17,234 rows total, 10 munis, last `crawled = 2026-03-16 09:53 UTC`, then stopped. `0` rows dated today before and after this test.

**Tier note:** the historical `ad_type` set is the GraphQL `productCodes` list. The plan's "five tiers BASIC/PLUS/PREMIUM/MAX/TOPLISTING" is the headline subset; the code actually requests seven codes (adds `PAID_REPUBLISH`, `TOPLISTING_5_DAYS`). 26-02's row-coverage check should tolerate the full code set.

---

## Guardrail compliance

- **Zero Oxylabs calls, zero spend** — direct path only, no creds touched.
- **No secrets written**, no `.env` read on the box.
- **Weekly `Scrape hemnet.se ad cost` PeriodicTask remains DISABLED** (`ENABLED=False`); the `[adhoc] Scrape hemnet.se ad cost` task also remains `ENABLED=False`. No schedule changed, no container restarted, no team-`main` push.
- The single-cell smoke wrote **0 rows** (blocked before write); the temp smoke script was removed from the droplet.

---

## Handoff to 26-02

`VERDICT: DIRECT_BLOCKED` → the conditional Oxylabs rewire plan **26-02 runs** (does not no-op). 26-02 should:
- Reroute the two `requests.post(GRAPHQL_URL, …)` calls in `search_ad_cost_2` through the P23 `apps/core/webscraper.py` `WebScraper` Oxylabs path (POST GraphQL via Oxylabs, mirroring the P23 HTML-fetch rewire).
- Use the **borrowed cohort-tracker Oxylabs creds** (D-07) — the droplet's own Oxylabs API creds are dead (HTTP 401, v4.0 carry).
- Run a **bounded** validation probe (benchmark ~P23's $0.49 / 200 pages) and report exact spend, then deliver the FEAS-03 recurring-cost go/no-go.
