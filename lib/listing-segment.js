// lib/listing-segment.js — which Hemnet listing segment a cohort pair belongs to.
// 2026-11-04 (team decision): views are tracked on paid Hemnet ads only — the like-for-like
// block (lib/views-like-for-like.js), the per-cohort workbooks and the cross-cohort chart
// (export-hb-ratio-xlsx.js) all keep segment 'paid'. Free pairs are still collected, and
// lib/paid-coverage.js reports what share of Booli's new homes have a paid Hemnet ad.
//
//   paid  — BASIC / PLUS / PREMIUM / MAX, and new-build project packages (NC_*)
//   free  — MINIMAL, Hemnet's free tier, live 2026-10-20
//   other — anything else seen (AGGREGATED, TEASER, …): no view counter or not a seller listing
//   unknown — no package recorded and listed on/after the free-tier launch, so it could be either
//
// Package tracking started 2026-10-27, so older pairs often have no package. Before
// 2026-10-20 every Hemnet listing was paid, so a missing package on a listing published
// before then is paid, not unknown.

'use strict';

const FREE_TIER_LAUNCH = '2026-10-20';
const PAID = new Set(['BASIC', 'PLUS', 'PREMIUM', 'MAX']);

// activePackage: string or null. hemnetListed: 'YYYY-MM-DD' (or Date) or null.
function segmentOf(activePackage, hemnetListed) {
  if (typeof activePackage === 'string' && activePackage) {
    if (activePackage === 'MINIMAL') return 'free';
    if (PAID.has(activePackage) || activePackage.startsWith('NC_')) return 'paid';
    return 'other';
  }
  const listed = hemnetListed instanceof Date ? hemnetListed.toISOString().slice(0, 10) : hemnetListed;
  if (typeof listed === 'string' && listed < FREE_TIER_LAUNCH) return 'paid';
  return 'unknown';
}

// adClassOf — finer split used by the ad registry and the sold-match ad type. Unlike
// segmentOf, new-build projects are their own class: the share question is about
// second-hand sellers, so NC_* is reported beside paid, not inside it.
//   paid | free | aggregated | newbuild | teaser | other | unknown
function adClassOf(activePackage) {
  if (typeof activePackage !== 'string' || !activePackage) return 'unknown';
  if (PAID.has(activePackage)) return 'paid';
  if (activePackage === 'MINIMAL') return 'free';
  if (activePackage === 'AGGREGATED') return 'aggregated';
  if (activePackage.startsWith('NC_')) return 'newbuild';
  if (activePackage === 'TEASER') return 'teaser';
  return 'other';
}

// Ad type of a HOME from every package any of its Hemnet ads was seen with while live
// (the "paid at any point while listed" rule): the best class wins, in this order.
const CLASS_RANK = ['paid', 'newbuild', 'free', 'aggregated', 'teaser', 'other'];
function homeClassOf(packagesSeen) {
  const classes = new Set((packagesSeen || []).map(adClassOf));
  for (const c of CLASS_RANK) if (classes.has(c)) return c;
  return 'unknown';
}

// LEFT JOIN giving each row of `pairAlias` (a cohort_pairs alias) the latest known package
// of its Hemnet listing as `active_package`. hemnet_listingv2 can hold several rows per id;
// a recorded package beats none, then the most recent sighting wins.
const latestPackageJoin = (pairAlias) => `
  LEFT JOIN (SELECT DISTINCT ON (hemnet_id) hemnet_id, active_package
               FROM hemnet_listingv2
              ORDER BY hemnet_id, (active_package IS NULL), format_seen_at DESC NULLS LAST, crawled DESC) pkg
         ON pkg.hemnet_id = ${pairAlias}.hemnet_id`;

module.exports = { segmentOf, adClassOf, homeClassOf, latestPackageJoin, PAID_PACKAGES: PAID, FREE_TIER_LAUNCH };

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  assert.strictEqual(segmentOf('PREMIUM', '2026-10-25'), 'paid');
  assert.strictEqual(segmentOf('NC_PREMIUM_PROJECT', null), 'paid');
  assert.strictEqual(segmentOf('MINIMAL', '2026-10-25'), 'free');
  assert.strictEqual(segmentOf('AGGREGATED', '2026-10-30'), 'other');
  assert.strictEqual(segmentOf(null, '2026-10-01'), 'paid', 'before the free tier every listing was paid');
  assert.strictEqual(segmentOf(null, new Date('2026-10-01T00:00:00Z')), 'paid');
  assert.strictEqual(segmentOf(null, '2026-10-21'), 'unknown');
  assert.strictEqual(segmentOf(null, null), 'unknown');
  assert.strictEqual(adClassOf('PLUS'), 'paid');
  assert.strictEqual(adClassOf('MINIMAL'), 'free');
  assert.strictEqual(adClassOf('AGGREGATED'), 'aggregated');
  assert.strictEqual(adClassOf('NC_PREMIUM_PROJECT'), 'newbuild');
  assert.strictEqual(adClassOf('TEASER'), 'teaser');
  assert.strictEqual(adClassOf(null), 'unknown');
  assert.strictEqual(homeClassOf(['AGGREGATED', 'PLUS']), 'paid', 'upgraded from aggregated counts as paid');
  assert.strictEqual(homeClassOf(['AGGREGATED', 'MINIMAL']), 'free');
  assert.strictEqual(homeClassOf(['AGGREGATED']), 'aggregated');
  assert.strictEqual(homeClassOf([]), 'unknown');
  console.log('smoke: listing-segment PASS');
}
