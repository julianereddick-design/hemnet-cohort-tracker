'use strict';
/**
 * adcost-contract.js — Pinned source of truth for the Hemnet ad-cost GraphQL crawl.
 *
 * Extracted 2026-06-30 via read-only SSH recon into the price-scraper droplet
 * (170.64.181.89, container hemnet-django). Source:
 *   - apps/hemnet/tasks.py  L1716-L1809  (search_ad_cost_2)
 *   - apps/hemnet/constants.py  L1-3  (GRAPHQL_URL, USER_AGENT)
 *   - AdCostPricePointV2 DB rows (10 distinct municipalities × 6 price points = 60 grid cells)
 *
 * BASIC-sum rule (verbatim from search_ad_cost_2):
 *   prices["PLUS"]    += prices.get("BASIC", 0)
 *   prices["PREMIUM"] += prices.get("BASIC", 0)
 *   prices["MAX"]     += prices.get("BASIC", 0)
 *   BASIC and TOPLISTING* are written as-is (no addition).
 *   AdCostV2 stores the SUMMED values for PLUS/PREMIUM/MAX.
 */

// ---------------------------------------------------------------------------
// Municipalities — exact set from AdCostPricePointV2.objects.all() on the
// production droplet (10 municipalities, verified 2026-06-30).
// `searchQuery` = property_municipality.name  (used as autocomplete input)
// `fullName`    = property_municipality.full_name  (used to match hit.fullName)
// ---------------------------------------------------------------------------
const MUNICIPALITIES = [
  { searchQuery: 'Göteborgs',  fullName: 'Göteborgs kommun'  },
  { searchQuery: 'Krokoms',    fullName: 'Krokoms kommun'    },
  { searchQuery: 'Lunds',      fullName: 'Lunds kommun'      },
  { searchQuery: 'Malmö',      fullName: 'Malmö kommun'      },
  { searchQuery: 'Sandvikens', fullName: 'Sandvikens kommun' },
  { searchQuery: 'Stockholms', fullName: 'Stockholms kommun' },
  { searchQuery: 'Uppsala',    fullName: 'Uppsala kommun'    },
  { searchQuery: 'Vadstena',   fullName: 'Vadstena kommun'   },
  { searchQuery: 'Varbergs',   fullName: 'Varbergs kommun'   },
  { searchQuery: 'Ydre',       fullName: 'Ydre kommun'       },
];

// ---------------------------------------------------------------------------
// Price grid — 6 asking-price levels (SEK), exact from search_ad_cost_2.
// ---------------------------------------------------------------------------
const ASKING_PRICES = [2000000, 5000000, 7500000, 10000000, 15000000, 20000000];

// ---------------------------------------------------------------------------
// Product codes — 7 tiers, exact from search_ad_cost_2 productCodes array.
// ---------------------------------------------------------------------------
const PRODUCT_CODES = [
  'BASIC',
  'PLUS',
  'PREMIUM',
  'MAX',
  'PAID_REPUBLISH',
  'TOPLISTING',
  'TOPLISTING_5_DAYS',
];

// ---------------------------------------------------------------------------
// GraphQL endpoint — from constants.py GRAPHQL_URL
// ---------------------------------------------------------------------------
const GRAPHQL_URL = 'https://www.hemnet.se/graphql';

// ---------------------------------------------------------------------------
// USER_AGENT — from constants.py USER_AGENT (used as the desktop-Chrome UA)
// ---------------------------------------------------------------------------
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// AUTOCOMPLETE_QUERY
//
// Operation name: "webAutocompleteLocations" — the page-origin name captured
// by the Phase-26 Steel probe (probe-steel-adcost.js request listener).
// Structurally identical to the Django task's "AutocompleteLocations" op;
// using the page-origin name makes in-page fetches indistinguishable from
// the real page's own requests (per locked decision D2).
//
// Variables: { query: <searchQuery>, limit: 5, types: ["MUNICIPALITY"] }
// Response path:  data.autocompleteLocations.hits[].{ locationId, fullName }
// ---------------------------------------------------------------------------
const AUTOCOMPLETE_QUERY = `query webAutocompleteLocations($query: String!, $limit: Int!, $types: [LocationType!]) {
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
}`;

// ---------------------------------------------------------------------------
// PRODUCT_PRICES_QUERY
//
// Operation name: "SellerMarketingProductPrices" — verbatim from the Django
// task (search_ad_cost_2, tasks.py L1716).
//
// Variables: { locationId: <string>, askingPrice: <int>, productCodes: PRODUCT_CODES }
// Response path:  data.sellerMarketingProductPrices.prices[].{ code, price.amount }
// ---------------------------------------------------------------------------
const PRODUCT_PRICES_QUERY = `query SellerMarketingProductPrices($locationId: ID!, $askingPrice: Int, $housingFormGroup: HousingFormGroup, $livingAreaInSqm: Float, $productCodes: [PackagePurchase!]!) {
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
}`;

// ---------------------------------------------------------------------------
// AdCostV2 field map — the 6 DB columns written by search_ad_cost_2.
// ---------------------------------------------------------------------------
const ADCOSTV2_FIELDS = [
  'property_municipality',
  'property_price',
  'ad_type',
  'ad_price',
  'valid_until',
  'crawled',
];

module.exports = {
  MUNICIPALITIES,
  ASKING_PRICES,
  PRODUCT_CODES,
  GRAPHQL_URL,
  USER_AGENT,
  AUTOCOMPLETE_QUERY,
  PRODUCT_PRICES_QUERY,
  ADCOSTV2_FIELDS,
};
