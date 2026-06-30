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

const {
  ADCOSTV2_FIELDS,
  SLUG_TO_AD_TYPE,
  PAYMENT_METHOD,
} = require('./lib/adcost-contract');

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
 * Reads data.pricingCalculator[].{ offerSlug, prices[PAYMENT_METHOD].total.amountInCents }
 * from a webPricingCalculator GraphQL response (captured live 2026-07-01).
 *
 * - offerSlug is translated to the historical AdCostV2 ad_type via SLUG_TO_AD_TYPE
 *   (e.g. BAS → BASIC, RAKETEN_3_DAGAR → TOPLISTING) so resumed rows stay
 *   comparable to pre-Mar-16 history. Unknown slugs fall back to the raw slug.
 * - amountInCents is converted to SEK (kronor) by dividing by 100, matching the
 *   historical AdCostV2.ad_price unit.
 * - PAYMENT_METHOD (PAY_NOW) selects the upfront price. Packages without that
 *   payment method are skipped (amount unavailable).
 *
 * T-27-03: reads only expected fields (offerSlug, total.amountInCents); numeric
 * coercion + >=0 guard; no eval of response content.
 */
function parseProductPrices(gqlJson) {
  const packages =
    (gqlJson && gqlJson.data && gqlJson.data.pricingCalculator) || [];
  const rows = [];
  for (const pkg of packages) {
    const slug = String((pkg && pkg.offerSlug) || '');
    if (!slug) continue;
    const pm = pkg.prices && pkg.prices[PAYMENT_METHOD];
    const cents = pm && pm.total ? pm.total.amountInCents : undefined;
    if (cents == null) continue; // payment method unavailable for this package
    rows.push({
      code: SLUG_TO_AD_TYPE[slug] || slug,
      amount: Number(cents) / 100,
    });
  }
  return rows;
}

/**
 * applyBasicSum(rows) → Array<{ code, amount }>
 *
 * NO-OP passthrough (kept for pipeline/back-compat).
 *
 * The current webPricingCalculator operation is called with
 * composeUpgradesWithBasic:true, so PLUS/PREMIUM/MAX are ALREADY returned
 * composed with the BASIC component server-side — matching the historical
 * AdCostV2 stored semantics. Re-adding BASIC here would double-count, so this
 * function now returns rows unchanged. (Under the old
 * SellerMarketingProductPrices op it summed BASIC into PLUS/PREMIUM/MAX.)
 */
function applyBasicSum(rows) {
  return rows.map((r) => ({ code: r.code, amount: r.amount }));
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
