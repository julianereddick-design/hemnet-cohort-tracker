'use strict';
// scripts/premarket-quality-oracle.js — regression gate.
// Replays the audited August 2026 cohort (n=2,264) through lib/premarket-quality.js
// and asserts it reproduces the published figures in
// docs/handover/booli-premarket-quality.md §3. If this fails, the rubric changed.
//
// Run: node scripts/premarket-quality-oracle.js
const fs = require('fs');
const path = require('path');
const { categorise, tally } = require('../lib/premarket-quality');

const FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'premarket-quality-2026-08-11.json');

// Published August figures. Tolerance 0.1pp absorbs rounding only.
const EXPECTED = {
  n_total: 2264,
  pct_interior: 87.1,
  pct_price: 54.3,
  pct_avm_shown: 39.7,
  pct_viewing: 21.1,
  pct_coming_to_market: 19.7,   // high + mid_high
  pct_low: 6.4,
};
const TOL = 0.1;

function run() {
  const D = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const settled = D.listings.filter(l => l.category && l.category !== 'unresolved');
  let failed = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log(`  PASS  ${name}`);
    else { failed++; console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); }
  };

  console.log(`=== premarket-quality oracle — ${D.listings.length} listings ===`);

  // Guard the strict per-listing check's own scope: if a future fixture
  // regeneration pushed rows into `unresolved`, `settled` would silently shrink
  // and an empty array would pass the mismatch check vacuously (0 mismatches of
  // 0 rows). Assert the audited scope directly.
  check('settled scope matches the audited August cohort (2262 of 2264)',
    settled.length === 2262, `expected 2262, got ${settled.length}`);

  // Strictest check: every stored per-listing category must be reproduced.
  const mismatches = settled.filter(l => categorise(l) !== l.category);
  check(`per-listing categories reproduce (${settled.length} settled)`,
    mismatches.length === 0,
    mismatches.length ? `${mismatches.length} mismatched, first booli_id=${mismatches[0].booli_id} ` +
      `stored=${mismatches[0].category} got=${categorise(mismatches[0])}` : '');

  // Tally over the FULL 2,264, not just `settled`. Two listings (bucket
  // 'unlabelled', every detail-page label the literal string "NULL" — a label
  // extraction failure, not "no interior") never resolved and are stored as
  // category:'unresolved'. The published August denominator is the full 2,264
  // (doc §3: "Booli comparable = 1,972 of 2,264 = 87.1%", and the six ladder
  // rows sum to 99.9%, not 100%, because these 2 sit in the denominator but
  // outside every numerator). Tallying over `settled` alone (n=2,262) computes
  // pct_interior as 87.2, not 87.1 — confirmed by direct calculation, not tuned.
  const t = tally(D.listings);
  const near = (a, b) => Math.abs(a - b) <= TOL;
  check('n_total', t.n_total === EXPECTED.n_total, `expected ${EXPECTED.n_total}, got ${t.n_total}`);
  for (const k of ['pct_interior', 'pct_price', 'pct_avm_shown', 'pct_viewing']) {
    check(k, near(t[k], EXPECTED[k]), `expected ${EXPECTED[k]}, got ${t[k]}`);
  }
  const coming = Math.round(1000 * (t.high + t.mid_high) / t.n_total) / 10;
  check('pct genuinely coming to market', near(coming, EXPECTED.pct_coming_to_market),
    `expected ${EXPECTED.pct_coming_to_market}, got ${coming}`);
  const low = Math.round(1000 * t.low / t.n_total) / 10;
  check('pct marketing filler', near(low, EXPECTED.pct_low),
    `expected ${EXPECTED.pct_low}, got ${low}`);

  console.log(failed === 0 ? '\nORACLE PASS' : `\n${failed} FAILED — the rubric no longer reproduces August`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
