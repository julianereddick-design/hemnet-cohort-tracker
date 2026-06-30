---
phase: 27-resume-weekly-scrape
plan: "02"
subsystem: ad-cost-scraper
tags: [steel, graphql, live-validation, contract-correction]
dependency_graph:
  requires: [27-01 (offline crawler + pinned contract)]
  provides: [verf-adcost/2026-07-01-validation.json, corrected webPricingCalculator contract]
  affects: [27-03 (droplet port is now a GraphQL code-port, not just an egress swap)]
key_files:
  modified:
    - scripts/lib/adcost-contract.js
    - scripts/adcost-parse.js
    - scripts/crawl-adcost.js
    - .planning/phases/27-resume-weekly-scrape/27-GRAPHQL-CONTRACT.md
  created:
    - verf-adcost/2026-07-01-validation.json
decisions:
  - "Price op corrected: SellerMarketingProductPrices (dead) → webPricingCalculator (live)"
  - "ad_price = amountInCents/100 (SEK); payment method = PAY_NOW; drop client-side BASIC-sum (server composes)"
  - "Store historical ad_type labels (BAS→BASIC, RAKETEN_3_DAGAR→TOPLISTING, etc.) for pre-Mar-16 comparability"
metrics:
  steel_spend_usd: "~0.29 (validation run; ~1.2 total incl. 4 discovery sessions)"
  rows_landed: 413
  completed: "2026-07-01"
---

# Phase 27 Plan 02: Live Steel Validation Summary

**One-liner:** The bounded paid Steel run validated the in-page-fetch pipeline live AND
uncovered the real reason the weekly scrape died — the pinned GraphQL price operation was
removed from Hemnet's schema. Corrected the contract to the live `webPricingCalculator`
operation and landed 413 parseable ad-cost rows.

## What happened

- **Task 1 (operator gate): APPROVED** by Julian ("run the whole lot to finish 27 out").
- **Task 2 (live run):** First crawl cleared Cloudflare on attempt 1 and resolved all 10
  municipalities via autocomplete, but **every price fetch returned 0 rows**.
- **Root cause:** `SellerMarketingProductPrices` no longer exists on the public schema —
  it returns `GRAPHQL_VALIDATION_FAILED: Cannot query field "sellerMarketingProductPrices"
  on type "Query"`. This is almost certainly **why the weekly scrape went dark (~Mar 16)**:
  the droplet's Django task targets the same dead operation.
- **Discovery:** Drove the live `/priser` calculator while capturing all `/graphql` POSTs
  (introspection is disabled). Captured the current op: **`webPricingCalculator`**
  (`pricingCalculator` field), then confirmed the production **in-page-fetch** path works
  with it (7/7 tiers returned for Stockholm @ 5M).
- **Fix:** Rewrote `adcost-contract.js` (new query + `OFFER_SLUGS` + `SLUG_TO_AD_TYPE` +
  `COMPOSE_UPGRADES_WITH_BASIC` + `PAYMENT_METHOD`), `adcost-parse.js`
  (`parseProductPrices` reads `pricingCalculator[].prices.PAY_NOW.total.amountInCents/100`
  and maps slug→ad_type; `applyBasicSum` is now a documented no-op), and the crawler's
  price-fetch variables + smoke fixture. Offline smoke: **21/21**.
- **Re-run:** Full grid landed **413 rows** (10 munis × 6 prices × 7 tiers − 7 from one
  transient "Failed to fetch" on a single Lunds price-point). Acceptance check passes:
  10 munis, all 7 tiers, all `ad_price > 0`. Output: `verf-adcost/2026-07-01-validation.json`.

## Locked decisions (parse semantics)

| Decision | Value | Rationale |
|----------|-------|-----------|
| Price unit | `amountInCents / 100` (SEK) | Match historical `AdCostV2.ad_price` |
| Payment method | `PAY_NOW` | Upfront cost = historical single price; boosts lack PAY_ONLY_IF_SOLD |
| BASIC-sum | dropped (no-op) | `composeUpgradesWithBasic:true` composes PLUS/PREMIUM/MAX server-side |
| ad_type labels | historical (BAS→BASIC, RAKETEN_*→TOPLISTING*) | Keep resumed rows comparable to pre-Mar-16 data; ⚠ Raketen is a newer product than old toplistning |

## Spend

`EXACT_SPEND_USD: ~0.29` for the validation run (69 Steel calls). Including the 4 discovery
sessions (debug raw, form-capture ×2, new-op validate), total Steel spend ≈ **$1.2** — still
trivial and well within the bounded validation budget.

## Impact on downstream plans

- **27-03 (droplet port) is now bigger than planned:** it must port the Django
  `search_ad_cost_2` from `SellerMarketingProductPrices` to `webPricingCalculator` —
  new query, cents/100, PAY_NOW selection, slug→ad_type map, and **remove** the Python
  BASIC-sum block — in addition to the residential-egress swap. This is a change to the
  **team's production repo** (tt7676/hem-bol-scrapers) and the droplet, so it warrants an
  explicit look before the write.
- **Phase 28 (reporting):** the ~3.5-month gap (Mar 16 → resume) is now explained (dead op),
  not just an outage. Add-on products (Raketen) differ from old toplistning — note in reports.

## Self-check

| Check | Result |
|-------|--------|
| `node scripts/crawl-adcost.js --smoke` | SMOKE OK 21/21 |
| `verf-adcost/2026-07-01-validation.json` exists, JSON array, 6-field rows | YES (413 rows) |
| Acceptance: ≥8 munis + BASIC/PLUS/PREMIUM/MAX/TOPLISTING + ad_price>0 | PASS (10 munis, 7 tiers) |
| EXACT_SPEND_USD reported | YES (~0.29) |
| No prod DB write | Confirmed (local JSON only) |
| No leaked Steel sessions | release() in finally |
