# Phase 27 — Hemnet Ad-Cost GraphQL Contract Reference

> ## ⚠️ CONTRACT CHANGED — corrected 2026-07-01 (Plan 27-02 live validation)
>
> The price operation pinned from the droplet's Django task (`SellerMarketingProductPrices`)
> was **removed from the public Hemnet schema** — it now returns
> `GRAPHQL_VALIDATION_FAILED: Cannot query field "sellerMarketingProductPrices"`.
> **This is the root cause of the weekly scrape going dark (~Mar 16).**
>
> The current operation, captured LIVE on 2026-07-01 from the page's own request, is
> **`webPricingCalculator`** (field `pricingCalculator`). See **Operation 2** below for the
> live contract. The autocomplete operation (Operation 1) is unchanged and still works.
>
> Consequence for Plan 27-03: porting the droplet's `search_ad_cost_2` is a **GraphQL
> code-port** (new op + new parse semantics), not just an egress swap.

**Extracted:** 2026-06-30 via read-only SSH recon (docker exec hemnet-django, no writes).
Price operation **corrected 2026-07-01** against the live schema (see warning above).
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

## Operation 2: webPricingCalculator  ✅ CURRENT (captured live 2026-07-01)

**Purpose:** Fetch ad-package prices for a (municipality, asking-price) pair.

**Operation name:** `webPricingCalculator` (field `pricingCalculator`).
Replaces the dead `SellerMarketingProductPrices`. Captured from the page's own
`/graphql` POST when the calculator computes a price, so in-page fetches are authentic.

**Variables:**
```json
{
  "locationId": "<string from autocomplete>",
  "askingPrice": 5000000,
  "offerSlugs": ["BAS","PLUS","PREMIUM","MAX","FORNYA_ANNONS","RAKETEN_3_DAGAR","RAKETEN_5_DAGAR"],
  "composeUpgradesWithBasic": true
}
```
> The page itself also requests the upgrade-only slugs
> `PLUS_UPPGRADERING / PREMIUM_UPPGRADERING / MAX_UPPGRADERING`; we omit them because
> `composeUpgradesWithBasic:true` already returns PLUS/PREMIUM/MAX fully composed.

**Query string:**
```graphql
query webPricingCalculator($locationId: ID!, $askingPrice: Int, $housingFormGroup: HousingFormGroup, $livingAreaInSqm: Float, $offerSlugs: [OfferSlug!]!, $composeUpgradesWithBasic: Boolean) {
  pricingCalculator(
    locationId: $locationId
    askingPrice: $askingPrice
    offerSlugs: $offerSlugs
    housingFormGroup: $housingFormGroup
    livingAreaInSqm: $livingAreaInSqm
    composeUpgradesWithBasic: $composeUpgradesWithBasic
  ) {
    offerSlug
    prices {
      PAY_NOW { total { amountInCents amountBeforeDiscountInCents __typename } __typename }
      PAY_WHEN_LISTING_IS_REMOVED { total { amountInCents __typename } __typename }
      PAY_ONLY_IF_SOLD { total { amountInCents __typename } __typename }
      __typename
    }
    __typename
  }
}
```

**Response path:** `data.pricingCalculator[]`
Each element: `{ offerSlug: "PLUS", prices: { PAY_NOW: { total: { amountInCents: 1090000 } }, ... } }`

**Parse semantics (locked Plan 27-02):**
- **Unit:** `amountInCents / 100` → SEK (matches historical `AdCostV2.ad_price`).
- **Payment method:** use `PAY_NOW` (upfront price = the historical single ad cost).
  The boost slugs (`RAKETEN_*`, `FORNYA_ANNONS`) have no `PAY_ONLY_IF_SOLD`.
- **No client-side BASIC-sum:** `composeUpgradesWithBasic:true` returns PLUS/PREMIUM/MAX
  already composed with BASIC server-side (the old `applyBasicSum` is now a no-op).

**Slug → historical `ad_type` map** (so resumed rows stay comparable to pre-Mar-16 data):

| offerSlug | AdCostV2 ad_type | Note |
|-----------|------------------|------|
| `BAS` | `BASIC` | base package |
| `PLUS` | `PLUS` | composed w/ BASIC |
| `PREMIUM` | `PREMIUM` | composed w/ BASIC |
| `MAX` | `MAX` | composed w/ BASIC |
| `FORNYA_ANNONS` | `PAID_REPUBLISH` | renew listing |
| `RAKETEN_3_DAGAR` | `TOPLISTING` | ⚠ "Raketen" boost is a newer product than old toplistning |
| `RAKETEN_5_DAGAR` | `TOPLISTING_5_DAYS` | ⚠ same caveat |

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

## Offer Slugs (7 — current) → stored ad_type

Sent as `$offerSlugs`: `["BAS","PLUS","PREMIUM","MAX","FORNYA_ANNONS","RAKETEN_3_DAGAR","RAKETEN_5_DAGAR"]`
(see the slug→ad_type map under Operation 2).

Live capture 2026-07-01 (Stockholm @ 5M, PAY_NOW):
- BAS (BASIC): 6 820 kr
- PLUS: 10 900 kr  ← already includes BASIC (composeUpgradesWithBasic)
- PREMIUM: 15 300 kr  ← already includes BASIC
- MAX: 21 200 kr  ← already includes BASIC
- FORNYA_ANNONS (PAID_REPUBLISH): 6 210 kr
- RAKETEN_3_DAGAR (TOPLISTING): 1 580 kr
- RAKETEN_5_DAGAR (TOPLISTING_5_DAYS): 2 050 kr

Full validation crawl (413 rows, 10 munis × 6 prices × 7 tiers minus 1 transient miss):
`verf-adcost/2026-07-01-validation.json`.

---

## BASIC-Sum Rule — SUPERSEDED

The old `search_ad_cost_2` summed BASIC into PLUS/PREMIUM/MAX client-side. Under
`webPricingCalculator` with `composeUpgradesWithBasic:true`, the **server** returns those
tiers already composed, so the client-side sum is **dropped** (re-adding would double-count).
The net stored values still match the historical "summed" semantics. The droplet port
(27-03) must remove the Python BASIC-sum block when it switches to the new op.

---

## AdCostV2 Field Map (current op)

| Column | Source |
|--------|--------|
| `property_municipality` | FK to Municipality (matched via `fullName`) |
| `property_price` | askingPrice integer (SEK) |
| `ad_type` | `SLUG_TO_AD_TYPE[pricingCalculator[i].offerSlug]` (e.g. BAS→"BASIC") |
| `ad_price` | `pricingCalculator[i].prices.PAY_NOW.total.amountInCents / 100` (SEK) |
| `valid_until` | None (not returned by this API path) |
| `crawled` | ISO 8601 datetime of the crawl run |

---

## Key References

- `scripts/lib/adcost-contract.js` — machine-readable constants (single source of truth)
- `scripts/crawl-adcost.js` — crawler using these contracts
- `scripts/adcost-parse.js` — pure parse / grid / BASIC-sum functions
- `scripts/probe-steel-adcost.js` — Phase-26 Steel validation probe (reference)
- `.planning/phases/26-ad-cost-scrape-feasibility/26-STEEL-VALIDATION.md` — live proof
- `.planning/phases/26-ad-cost-scrape-feasibility/26-PHASE27-HANDOFF.md` — build spec
