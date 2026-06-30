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

// Stubs — RED phase. Replaced by real implementations in the GREEN commit.
function buildGrid(_munis, _prices) { return []; }
function parseProductPrices(_gqlJson) { return []; }
function applyBasicSum(rows) { return rows; }
function toAdCostV2Rows(_municipality, _askingPrice, _rows, _crawledISO) { return []; }

module.exports = { buildGrid, parseProductPrices, applyBasicSum, toAdCostV2Rows };
