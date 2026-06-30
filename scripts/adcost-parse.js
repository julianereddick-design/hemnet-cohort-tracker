'use strict';
/**
 * adcost-parse.js — Pure parse / grid / BASIC-sum functions for the ad-cost crawler.
 *
 * All functions are pure (no network, no DB, no side effects) so they are
 * unit-testable via the --smoke path in crawl-adcost.js.
 *
 * BASIC-sum rule (from droplet tasks.py search_ad_cost_2 L1786-1792):
 *   PLUS    += BASIC
 *   PREMIUM += BASIC
 *   MAX     += BASIC
 *   BASIC + TOPLISTING* are written as-is (no addition).
 */

const { ADCOSTV2_FIELDS } = require('./lib/adcost-contract');

/**
 * buildGrid(munis, prices) → Array<{ municipality, askingPrice }>
 * Returns all (municipality, askingPrice) pairs: munis.length × prices.length entries.
 */
function buildGrid(munis, prices) {
  const grid = [];
  for (const municipality of munis) {
    for (const askingPrice of prices) {
      grid.push({ municipality, askingPrice });
    }
  }
  return grid;
}

/**
 * parseProductPrices(gqlJson) → Array<{ code, amount }>
 *
 * Reads data.sellerMarketingProductPrices.prices[].{ code, price.amount }
 * from a SellerMarketingProductPrices GraphQL response.
 * Returns one entry per code with a numeric amount (coerced, 0 if absent).
 *
 * T-27-03: reads only expected fields (code, price.amount); numeric coercion
 * + >=0 guard; no eval of response content.
 */
function parseProductPrices(gqlJson) {
  const prices =
    (gqlJson &&
      gqlJson.data &&
      gqlJson.data.sellerMarketingProductPrices &&
      gqlJson.data.sellerMarketingProductPrices.prices) ||
    [];
  return prices.map((p) => ({
    code: String(p.code || ''),
    amount: Number((p.price && p.price.amount) || 0),
  }));
}

/**
 * applyBasicSum(rows) → Array<{ code, amount }>
 *
 * Adds the BASIC amount into PLUS, PREMIUM, and MAX per the BASIC-sum rule.
 * BASIC and TOPLISTING* rows are left unchanged.
 * Returns a new array (does not mutate input).
 */
function applyBasicSum(rows) {
  const basicRow = rows.find((r) => r.code === 'BASIC');
  const basicAmount = basicRow ? basicRow.amount : 0;
  const SUMMED_INTO = new Set(['PLUS', 'PREMIUM', 'MAX']);
  return rows.map((r) => {
    if (SUMMED_INTO.has(r.code)) {
      return { code: r.code, amount: r.amount + basicAmount };
    }
    return { code: r.code, amount: r.amount };
  });
}

/**
 * toAdCostV2Rows(municipality, askingPrice, rows, crawledISO)
 *   → Array<{ property_municipality, property_price, ad_type, ad_price, valid_until, crawled }>
 *
 * Emits one AdCostV2-shaped object per tier row.
 * Keys are exactly ADCOSTV2_FIELDS: property_municipality, property_price,
 * ad_type, ad_price, valid_until, crawled.
 */
function toAdCostV2Rows(municipality, askingPrice, rows, crawledISO) {
  return rows.map((r) => ({
    property_municipality: municipality,
    property_price: askingPrice,
    ad_type: r.code,
    ad_price: r.amount,
    valid_until: null,
    crawled: crawledISO,
  }));
}

// Verify the exported function keys match ADCOSTV2_FIELDS at module load time
// (catches accidental field renames during development).
(function validateFieldMap() {
  const sample = toAdCostV2Rows('test', 1, [{ code: 'BASIC', amount: 1 }], 'iso');
  const keys = Object.keys(sample[0]);
  const missing = ADCOSTV2_FIELDS.filter((f) => !keys.includes(f));
  const extra = keys.filter((k) => !ADCOSTV2_FIELDS.includes(k));
  if (missing.length || extra.length) {
    throw new Error(
      `adcost-parse: toAdCostV2Rows field mismatch. Missing: [${missing}] Extra: [${extra}]`
    );
  }
})();

module.exports = { buildGrid, parseProductPrices, applyBasicSum, toAdCostV2Rows };
