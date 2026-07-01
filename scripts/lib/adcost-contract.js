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
// Offer slugs — the CURRENT webPricingCalculator $offerSlugs values, captured
// LIVE 2026-07-01 from the hemnet.se/priser page's own GraphQL request.
//
// The old SellerMarketingProductPrices operation + its productCodes
// (BASIC/PLUS/PREMIUM/MAX/PAID_REPUBLISH/TOPLISTING/TOPLISTING_5_DAYS) were
// REMOVED from the public schema — that dead contract is why the weekly scrape
// stopped landing rows (~Mar 16). See 27-GRAPHQL-CONTRACT.md.
//
// SLUG_TO_AD_TYPE maps each current slug back to the historical AdCostV2.ad_type
// label so resumed rows stay drop-in comparable to pre-Mar-16 history.
// NOTE: RAKETEN_* (the "Raketen" boost) is a newer product than the old
// "toplistning" — treated as its historical analogue, but the product evolved.
// ---------------------------------------------------------------------------
const OFFER_SLUGS = [
  'BAS',
  'PLUS',
  'PREMIUM',
  'MAX',
  'FORNYA_ANNONS',
  'RAKETEN_3_DAGAR',
  'RAKETEN_5_DAGAR',
];

const SLUG_TO_AD_TYPE = {
  BAS: 'BASIC',
  PLUS: 'PLUS',
  PREMIUM: 'PREMIUM',
  MAX: 'MAX',
  FORNYA_ANNONS: 'PAID_REPUBLISH',
  RAKETEN_3_DAGAR: 'TOPLISTING',
  RAKETEN_5_DAGAR: 'TOPLISTING_5_DAYS',
};

// composeUpgradesWithBasic:true → the server returns PLUS/PREMIUM/MAX already
// composed WITH the BASIC component, matching the historical AdCostV2 semantics
// where PLUS/PREMIUM/MAX stored the summed value. The old client-side
// applyBasicSum is therefore NO LONGER applied (it would double-count).
const COMPOSE_UPGRADES_WITH_BASIC = true;

// Which of the 3 payment methods the AdCostV2 ad_price represents.
// PAY_WHEN_LISTING_IS_REMOVED — verified 2026-07-01 against Julian's historical
// ARPL model (Hemnet ARPL Calcs_v6.xlsx): all 4 tiers for Stockholm @5M match this
// method EXACTLY (BASIC 7297 / PLUS 11662 / PREMIUM 16370 / MAX 22683), and none
// match PAY_NOW. This is the standard "pay when the listing is removed" price and
// the one the entire pre-Mar-16 AdCostV2 series used — required for gap continuity.
const PAYMENT_METHOD = 'PAY_WHEN_LISTING_IS_REMOVED';

// Legacy alias — kept so existing references don't break; equals the historical
// ad_type label set (the VALUES stored in AdCostV2.ad_type).
const PRODUCT_CODES = OFFER_SLUGS.map((s) => SLUG_TO_AD_TYPE[s]);

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
// Operation name: "webPricingCalculator" — captured LIVE 2026-07-01 from the
// hemnet.se/priser page's own /graphql request (the page-origin op, per D2).
// This REPLACES the dead "SellerMarketingProductPrices" operation.
//
// Variables: { locationId: <string>, askingPrice: <int>,
//              offerSlugs: OFFER_SLUGS, composeUpgradesWithBasic: true }
// Response path: data.pricingCalculator[].{ offerSlug,
//              prices.PAY_NOW.total.amountInCents }  (amount is in CENTS/öre)
// ---------------------------------------------------------------------------
const PRODUCT_PRICES_QUERY = `query webPricingCalculator($locationId: ID!, $askingPrice: Int, $housingFormGroup: HousingFormGroup, $livingAreaInSqm: Float, $offerSlugs: [OfferSlug!]!, $composeUpgradesWithBasic: Boolean) {
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
      PAY_NOW {
        total {
          amountInCents
          amountBeforeDiscountInCents
          __typename
        }
        __typename
      }
      PAY_WHEN_LISTING_IS_REMOVED {
        total {
          amountInCents
          __typename
        }
        __typename
      }
      PAY_ONLY_IF_SOLD {
        total {
          amountInCents
          __typename
        }
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
  OFFER_SLUGS,
  SLUG_TO_AD_TYPE,
  COMPOSE_UPGRADES_WITH_BASIC,
  PAYMENT_METHOD,
  GRAPHQL_URL,
  USER_AGENT,
  AUTOCOMPLETE_QUERY,
  PRODUCT_PRICES_QUERY,
  ADCOSTV2_FIELDS,
};
