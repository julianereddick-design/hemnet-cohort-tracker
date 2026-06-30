---
phase: 27-resume-weekly-scrape
plan: "01"
subsystem: ad-cost-scraper
tags: [graphql, steel, crawler, offline-gate, tdd]
dependency_graph:
  requires: [26-03 (Steel validated, FEAS complete)]
  provides: [scripts/lib/adcost-contract.js, scripts/crawl-adcost.js, scripts/adcost-parse.js]
  affects: [27-02 (live crawl uses these modules)]
tech_stack:
  added: [scripts/lib/ directory, adcost-contract.js, adcost-parse.js, crawl-adcost.js]
  patterns: [pluggable-session-provider, in-page-fetch, tdd-red-green, retry-on-block]
key_files:
  created:
    - scripts/lib/adcost-contract.js
    - scripts/adcost-parse.js
    - scripts/crawl-adcost.js
    - .planning/phases/27-resume-weekly-scrape/27-GRAPHQL-CONTRACT.md
  modified: []
decisions:
  - "Used webAutocompleteLocations (page-origin name) for autocomplete op to make in-page fetches look authentic"
  - "TDD: RED commit (0111232) then GREEN commit (d745a53) per task requirement"
  - "Municipality list sourced from live DB query (10 munis) not hardcoded estimate"
metrics:
  duration: "~30 min"
  completed: "2026-06-30"
  tasks: 3
  files: 4
---

# Phase 27 Plan 01: Pin Ad-Cost GraphQL Contract + Build Crawler Summary

**One-liner:** Pinned 10-muni × 6-price GraphQL contract from live droplet DB and built a pluggable Steel-default in-page-fetch crawler with 24-assertion offline smoke gate.

## What Was Built

### Task 1 — Pin the GraphQL contract (droplet recon)

Read-only SSH recon into the price-scraper droplet (`170.64.181.89`, container `hemnet-django`). Extracted from `apps/hemnet/tasks.py::search_ad_cost_2` (L1716-1809) and the `AdCostPricePointV2` DB table:

- **10 municipalities** (exact from DB): Göteborgs, Krokoms, Lunds, Malmö, Sandvikens, Stockholms, Uppsala, Vadstena, Varbergs, Ydre
- **2 GraphQL operations:** `AutocompleteLocations` (droplet) / `webAutocompleteLocations` (page-origin name) + `SellerMarketingProductPrices` (verbatim from the task)
- **BASIC-sum rule** confirmed: PLUS/PREMIUM/MAX += BASIC amount; BASIC + TOPLISTING* as-is
- **AdCostV2 fields:** `property_municipality, property_price, ad_type, ad_price, valid_until, crawled`

Contract file `scripts/lib/adcost-contract.js` exports these as constants (single source of truth for all downstream modules). `27-GRAPHQL-CONTRACT.md` is the human-readable reference.

Verification: `6 7 10` (ASKING_PRICES.length, PRODUCT_CODES.length, MUNICIPALITIES.length). Node contract assertion passed.

No droplet mutation — SSH was read-only (`docker exec sed`/`python -c ... objects.all()`).

### Task 2 — Build parse module + crawler (TDD)

**RED** (commit `0111232`): `adcost-parse.js` with stubs (return `[]`); `crawl-adcost.js` with 16-assertion smoke — confirmed 2/16 pass (provider stubs only), 14/16 fail.

**GREEN** (commit `d745a53`): `adcost-parse.js` with real implementations:
- `buildGrid(munis, prices)` → all (muni, askingPrice) pairs
- `parseProductPrices(gqlJson)` → `[{code, amount}]` from `data.sellerMarketingProductPrices.prices[].price.amount`
- `applyBasicSum(rows)` → PLUS/PREMIUM/MAX get +BASIC; others unchanged
- `toAdCostV2Rows(muni, price, rows, iso)` → objects with exactly ADCOSTV2_FIELDS keys

`scripts/crawl-adcost.js` (>120 lines):
- Pluggable session provider: `PROVIDERS['steel']` (Steel.dev, validated Phase 26) and `PROVIDERS['oxylabs-render']` (stub, D1 seam)
- STEEL_API_KEY read via `envFromDotenv` only (T-27-01)
- `sessions.create()` guarded behind non-smoke entrypoint (T-27-04)
- Retry-on-block loop (MAX_ATTEMPTS=5, BLOCK_RE/CLEAR_RE gates from probe)
- In-page `fetch('/graphql')` via `page.evaluate` — no form automation (D2)
- Location cache per muni (avoids repeat autocomplete calls)
- JSON output to `verf-adcost/` for Plan 27-02

### Task 3 — Harden offline smoke gate

Added 8 more explicit named assertions (7 tier names individually + `valid_until=null`). Final smoke: 24/24 assertions, deterministic across multiple runs.

Smoke covers all 5 required behaviors:
1. `buildGrid(MUNICIPALITIES, ASKING_PRICES)` = 60 pairs (10×6)
2. `parseProductPrices(fixture)` = 7 rows, all amounts > 0, all codes present including TOPLISTING_5_DAYS and PAID_REPUBLISH
3. `applyBasicSum`: PLUS/PREMIUM/MAX += BASIC; BASIC unchanged; TOPLISTING unchanged
4. `toAdCostV2Rows` key set === ADCOSTV2_FIELDS (6 keys), valid_until=null
5. Both session providers registered (steel + oxylabs-render)

## Decisions Made

1. **webAutocompleteLocations for autocomplete op name** — Phase-26 Steel probe captured the page-origin query as `webAutocompleteLocations`. Using this name for in-page fetches makes them indistinguishable from real page requests (D2 rationale). Django task uses `AutocompleteLocations` but the GraphQL server accepts both.

2. **Municipality list from live DB query** — DB query returned exactly 10 municipalities (consistent with all Phase-26 references to "10 munis"). Ordered alphabetically in contract to be deterministic.

3. **TDD gate sequence correct** — RED commit (0111232) → GREEN commit (d745a53) → REFACTOR/HARDEN (7ea60e0). No gate compliance issues.

## Deviations from Plan

None — plan executed exactly as written.

The only implementation decision not specified in the plan was using `webAutocompleteLocations` vs `AutocompleteLocations` for the in-page fetch: the plan said "Prefer the page-origin operation names (`webAutocompleteLocations`)", which I followed.

## TDD Gate Compliance

| Gate | Commit | Verified |
|------|--------|---------|
| RED  | 0111232 `test(27-01)` | 2/16 pass (only provider stubs) → confirmed failing |
| GREEN | d745a53 `feat(27-01)` | 16/16 pass → confirmed passing |
| HARDEN | 7ea60e0 `feat(27-01)` | 24/24 pass |

## Known Stubs

- `PROVIDERS['oxylabs-render'].createSession()` — throws "not yet wired — drop-in seam per D1". Intentional: pending Oxylabs support confirmation (26-OXYLABS-INQUIRY.md Q1). Plan 27-02 uses Steel by default.

## Threat Flags

None. All 5 threats from the plan's STRIDE register are mitigated:
- T-27-01: STEEL_API_KEY via `envFromDotenv` only; grep confirmed no literal log
- T-27-02: Droplet recon was read-only; no mtime change (sed + python read-only queries)
- T-27-03: `parseProductPrices` reads only `code` + `price.amount`; numeric coercion applied
- T-27-04: `sessions.create()` unreachable from `--smoke` or `require`
- T-27-05: No secret files; .env is gitignored

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| scripts/lib/adcost-contract.js exists | FOUND |
| scripts/adcost-parse.js exists | FOUND |
| scripts/crawl-adcost.js exists | FOUND |
| 27-GRAPHQL-CONTRACT.md exists | FOUND |
| commit 0ffa53c (contract) | FOUND |
| commit 0111232 (RED) | FOUND |
| commit d745a53 (GREEN) | FOUND |
| commit 7ea60e0 (harden) | FOUND |
| `node scripts/crawl-adcost.js --smoke` | SMOKE OK 24/24 assertions |
