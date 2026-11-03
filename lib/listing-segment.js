// lib/listing-segment.js — which Hemnet listing segment a cohort pair belongs to, for
// reporting H% separately for paid and free listings. Used by the like-for-like views
// block (lib/views-like-for-like.js); the xlsx/chart split is still a draft on
// branch draft/paid-free-split, awaiting the team's decision.
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

module.exports = { segmentOf, FREE_TIER_LAUNCH };

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
  console.log('smoke: listing-segment PASS');
}
