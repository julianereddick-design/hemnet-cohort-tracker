'use strict';

// sold-addr.js — normAddr v2 address normalizer for Booli-sold / Hemnet-sold matching.
//
// Satisfies MATCH-02: recovers the four spike-discovered false-negative address formats
// that caused address-equality misses before v2.
//
// normStreet is imported from lib/spotcheck-evidence (NOT inlined) so this module
// stays in sync with the cohort spot-check normalization used elsewhere.
//
// Lifted verbatim from scripts/spike-hemnet-match.js lines 64-75 (Phase 15-01).

const { normStreet } = require('./spotcheck-evidence');

// Building-level address key. Hemnet appends a floor/unit suffix to APARTMENT
// addresses ("Rindögatan 28, 3 tr", "Hägerstensvägen 130, vån 3.") that Booli
// omits, so exact street equality fails. Take the part before the first comma →
// street + house-number (incl letter, e.g. "27A"). This matches the BUILDING;
// the unit is then disambiguated by fee/area/price (Phase 14 model).
//
// Recovered false-negative formats (MATCH-02):
//   1. "norrskensvägen 1 c"  → "norrskensvägen 1c"  (space before unit letter)
//   2. "Rindögatan 28, 3 tr" → "rindögatan 28"      (comma splits floor suffix)
//   3. "X 10 / Y 6"          → "x 10"               (slash splits dual-corner address)
//   4. "58 och 58A"          → "58"                  (Booli-truncated number with " och ")
function normAddr(s) {
  if (s == null) return null;
  // Take the part before the first comma / slash / " och " (Hemnet floor suffix,
  // dual-corner addresses "X 10 / Y 6", and "58 och 58A").
  let t = String(s).split(',')[0].split('/')[0].split(/\s+och\s+/i)[0];
  t = normStreet(t);
  if (t == null) return null;
  // Merge a space between house number and a single trailing unit letter:
  // "norrskensvägen 1 c" -> "norrskensvägen 1c", "vasavägen 21 e" -> "21e".
  t = t.replace(/(\d+)\s+([a-zåäö])(?=\s|$)/g, '$1$2');
  return t;
}

module.exports = { normAddr };

// ---------------------------------------------------------------------------
// Inline smoke test — node lib/sold-addr.js --smoke
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // MATCH-02: the four spike-recovered false-negative formats
  check('normAddr: space-before-unit-letter merge (format 1)', () => {
    assert.strictEqual(normAddr('norrskensvägen 1 c'), 'norrskensvägen 1c');
  });
  check('normAddr: comma split drops floor suffix (format 2)', () => {
    assert.strictEqual(normAddr('Rindögatan 28, 3 tr'), 'rindögatan 28');
  });
  check('normAddr: slash split, dual-corner address (format 3)', () => {
    assert.strictEqual(normAddr('X 10 / Y 6'), 'x 10');
  });
  check('normAddr: " och " split, Booli-truncated number (format 4)', () => {
    assert.strictEqual(normAddr('58 och 58A'), '58');
  });
  check('normAddr: null → null', () => {
    assert.strictEqual(normAddr(null), null);
  });

  // Additional robustness checks
  check('normAddr: case-insensitive " och " split', () => {
    assert.strictEqual(normAddr('58 Och 58A'), '58');
  });
  check('normAddr: plain address normalizes (lowercase, trim)', () => {
    assert.strictEqual(normAddr('Storgatan 5'), 'storgatan 5');
  });
  check('normAddr: trailing whitespace trimmed', () => {
    assert.strictEqual(normAddr('  Storgatan 5  '), 'storgatan 5');
  });
  check('normAddr: address with letter suffix (no space)', () => {
    assert.strictEqual(normAddr('Vasavägen 21B'), 'vasavägen 21b');
  });
  check('normAddr: address with space before letter suffix', () => {
    assert.strictEqual(normAddr('vasavägen 21 e'), 'vasavägen 21e');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
