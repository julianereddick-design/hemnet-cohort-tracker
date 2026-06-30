# Phase 27 — Hemnet Ad-Cost GraphQL Contract Reference

**Extracted:** 2026-06-30 via read-only SSH recon (docker exec hemnet-django, no writes).
**Source files on droplet:**
- `/var/www/apps/hemnet/apps/hemnet/tasks.py` L1716–L1809 (`search_ad_cost_2`)
- `/var/www/apps/hemnet/apps/hemnet/constants.py` L1–3 (`GRAPHQL_URL`, `USER_AGENT`)
- `AdCostPricePointV2` DB table (municipality × price grid)

---

## GraphQL Endpoint

```
POST https://www.hemnet.se/graphql
Content-Type: application/json
```

The droplet's DC IP is Cloudflare-blocked (confirmed Phase 26-01). Egress MUST be residential
(Steel.dev validated: cleared Cloudflare + captured prices in Phase 26 live run).
Production technique: load hemnet.se/priser through a residential browser session,
then fire a quiet in-page `fetch('/graphql', ...)` — do NOT automate the form
(triggers mid-session Turnstile re-challenge per Phase-26 finding, locked decision D2).

---

## Operation 1: webAutocompleteLocations

**Purpose:** Resolve a municipality search string to a `locationId`.

**Operation name (page-origin):** `webAutocompleteLocations`
(The Django task uses `AutocompleteLocations`; the page's frontend uses `webAutocompleteLocations`.
In-page fetches use the page-origin name to look authentic.)

**Variables:**
```json
{
  "query": "<municipality searchQuery e.g. 'Göteborgs'>",
  "limit": 5,
  "types": ["MUNICIPALITY"]
}
```

**Query string:**
```graphql
query webAutocompleteLocations($query: String!, $limit: Int!, $types: [LocationType!]) {
  autocompleteLocations(query: $query, limit: $limit, types: $types) {
    hits {
      id: locationId
      fullName
      location {
        id
        fullName
        parent {
          id
          fullName
          __typename
        }
        type
        __typename
      }
      __typename
    }
    __typename
  }
}
```

**Match logic:** iterate `data.autocompleteLocations.hits[]`; pick the hit where
`hit.fullName === municipality.fullName` (e.g., `"Göteborgs kommun"`).
The matching `hit.id` (aliased from `locationId`) is the `locationId` for the price query.
Cache the `locationId` per municipality — it is stable across price points.

---

## Operation 2: SellerMarketingProductPrices

**Purpose:** Fetch ad-package prices for a (municipality, asking-price) pair.

**Operation name:** `SellerMarketingProductPrices` (same in page and Django task)

**Variables:**
```json
{
  "locationId": "<string from autocomplete>",
  "askingPrice": 5000000,
  "productCodes": ["BASIC","PLUS","PREMIUM","MAX","PAID_REPUBLISH","TOPLISTING","TOPLISTING_5_DAYS"]
}
```

**Query string:**
```graphql
query SellerMarketingProductPrices($locationId: ID!, $askingPrice: Int, $housingFormGroup: HousingFormGroup, $livingAreaInSqm: Float, $productCodes: [PackagePurchase!]!) {
  sellerMarketingProductPrices(
    locationId: $locationId
    askingPrice: $askingPrice
    productCodes: $productCodes
    housingFormGroup: $housingFormGroup
    livingAreaInSqm: $livingAreaInSqm
  ) {
    formattedValidThrough
    prices {
      code
      price {
        amount
        formatted
        __typename
      }
      immediatePrice {
        amount
        __typename
      }
      __typename
    }
    __typename
  }
}
```

**Response path:** `data.sellerMarketingProductPrices.prices[]`
Each element: `{ code: "PLUS", price: { amount: 10900, formatted: "10 900 kr" }, ... }`

---

## Municipality List (10 municipalities — exact from AdCostPricePointV2 DB)

| # | searchQuery | fullName |
|---|------------|----------|
| 1 | Göteborgs  | Göteborgs kommun |
| 2 | Krokoms    | Krokoms kommun |
| 3 | Lunds      | Lunds kommun |
| 4 | Malmö      | Malmö kommun |
| 5 | Sandvikens | Sandvikens kommun |
| 6 | Stockholms | Stockholms kommun |
| 7 | Uppsala    | Uppsala kommun |
| 8 | Vadstena   | Vadstena kommun |
| 9 | Varbergs   | Varbergs kommun |
| 10 | Ydre      | Ydre kommun |

`searchQuery` = what is sent as `$query` in the autocomplete operation.
`fullName` = the `hit.fullName` value to match in the autocomplete response.

---

## Price Grid (6 asking-price levels, SEK)

```
[2 000 000, 5 000 000, 7 500 000, 10 000 000, 15 000 000, 20 000 000]
```

**Total grid:** 10 municipalities × 6 prices = **60 (muni, price) pairs** per crawl run.
**Total GraphQL calls:** ~120/run (60 autocomplete-resolved + 60 price queries;
autocomplete is cached per municipality → effectively 10 + 60 = 70 calls if cached).

---

## Product Codes (7 tiers)

```
["BASIC", "PLUS", "PREMIUM", "MAX", "PAID_REPUBLISH", "TOPLISTING", "TOPLISTING_5_DAYS"]
```

Phase-26 live capture confirmed prices for BASIC/PLUS/PREMIUM/MAX (Göteborg @ 5M):
- Bas (BASIC): 6 820 kr
- Plus (PLUS): 10 900 kr  ← already includes BASIC per BASIC-sum rule
- Premium (PREMIUM): 15 300 kr  ← already includes BASIC
- Max (MAX): 21 200 kr  ← already includes BASIC

---

## BASIC-Sum Rule

Verbatim from `search_ad_cost_2` (tasks.py L1786–L1792):

```python
if "PLUS" in prices:
    prices["PLUS"] += prices.get("BASIC", 0)
if "PREMIUM" in prices:
    prices["PREMIUM"] += prices.get("BASIC", 0)
if "MAX" in prices:
    prices["MAX"] += prices.get("BASIC", 0)
```

BASIC and TOPLISTING* are stored as-is. PLUS/PREMIUM/MAX stored as (tier_amount + BASIC_amount).
The `AdCostV2.ad_price` column holds the summed value — raw tier amounts from the API
are never written directly to PLUS/PREMIUM/MAX rows.

---

## AdCostV2 Field Map

| Column | Source |
|--------|--------|
| `property_municipality` | FK to Municipality (matched via `fullName`) |
| `property_price` | askingPrice integer (SEK) |
| `ad_type` | `prices[i].code` (e.g., "PLUS") |
| `ad_price` | `prices[i].price.amount` after BASIC-sum rule applied |
| `valid_until` | None (not returned by this API path; `formattedValidThrough` is a string) |
| `crawled` | ISO 8601 datetime of the crawl run |

---

## Key References

- `scripts/lib/adcost-contract.js` — machine-readable constants (single source of truth)
- `scripts/crawl-adcost.js` — crawler using these contracts
- `scripts/adcost-parse.js` — pure parse / grid / BASIC-sum functions
- `scripts/probe-steel-adcost.js` — Phase-26 Steel validation probe (reference)
- `.planning/phases/26-ad-cost-scrape-feasibility/26-STEEL-VALIDATION.md` — live proof
- `.planning/phases/26-ad-cost-scrape-feasibility/26-PHASE27-HANDOFF.md` — build spec
