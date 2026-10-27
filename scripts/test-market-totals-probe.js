// scripts/test-market-totals-probe.js
// Offline regression test for the JSON-path smoke probe in market-totals-daily.js.
// Catches future refactors that accidentally weaken the probe.
// Hemnet totals parsing: see scripts/test-market-totals-daily.js.
//
// Run: node scripts/test-market-totals-probe.js
// Exit 0 on pass, 1 on any failure. Output: "PASS: N/M" or "FAIL: ...".

'use strict';


// Helpers imported from the job itself (exported since 2026-10-27; requiring it
// no longer runs it), so there is no copy to drift.
const { assertNumericTotal, pickByPrefix } = require('../market-totals-daily');

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok ${pass + fail}: ${name}`);
  } catch (e) {
    fail++;
    failures.push(`  FAIL ${pass + fail}: ${name} — ${e.message}`);
    console.error(`  FAIL ${pass + fail}: ${name} — ${e.message}`);
  }
}

function assertThrows(fn, msgIncludes) {
  let threw = false;
  let actualMsg = null;
  try { fn(); } catch (e) { threw = true; actualMsg = e.message; }
  if (!threw) throw new Error('expected function to throw, but it did not');
  if (msgIncludes && !actualMsg.includes(msgIncludes)) {
    throw new Error(`expected error message to include "${msgIncludes}", got "${actualMsg}"`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- assertNumericTotal cases (Tests 1-10) ---
test('1: positive int 50769 does not throw', () => assertNumericTotal('x', 50769));
test('2: positive int 1 does not throw',     () => assertNumericTotal('x', 1));
test('3: undefined throws with label + "undefined"', () =>
  assertThrows(() => assertNumericTotal('x', undefined), 'JSON path missing for x'));
test('4: null throws',  () => assertThrows(() => assertNumericTotal('x', null)));
test('5: NaN throws',   () => assertThrows(() => assertNumericTotal('x', NaN)));
test('6: 0 throws (n <= 0)',  () => assertThrows(() => assertNumericTotal('x', 0)));
test('7: -5 throws (n <= 0)', () => assertThrows(() => assertNumericTotal('x', -5)));
test('8: string "50769" throws (typeof guard)', () => assertThrows(() => assertNumericTotal('x', '50769')));
test('9: Infinity throws (isFinite guard)',     () => assertThrows(() => assertNumericTotal('x', Infinity)));
test('10: label propagates into error message', () =>
  assertThrows(() => assertNumericTotal('hemnet.till_salu', undefined), 'hemnet.till_salu'));

// --- pickByPrefix cases (Tests 11-15) ---
const hemnetShape = {
  'searchForSaleListings({"input":{}})':   { total: 50769 },
  'searchUpcomingListings({"input":{}})':  { total: 12345 },
};
const booliShape = {
  'searchForSale({"input":{"upcomingSale":0}})': { totalCount: 60560 },
};

test('11: hemnet searchForSaleListings.total → 50769', () =>
  assertEqual(pickByPrefix(hemnetShape, 'searchForSaleListings', 'total'), 50769, 'hemnet.till_salu'));
test('12: no matching prefix → undefined', () =>
  assertEqual(pickByPrefix(hemnetShape, 'searchNonexistent', 'total'), undefined, 'unmatched prefix'));
test('13: null rootQuery → undefined (null guard)', () =>
  assertEqual(pickByPrefix(null, 'x', 'y'), undefined, 'null root'));
test('14: matching key with null node → undefined (no TypeError)', () =>
  assertEqual(pickByPrefix({ 'searchForSale({})': null }, 'searchForSale', 'totalCount'), undefined, 'null node'));
test('15: booli searchForSale.totalCount → 60560', () =>
  assertEqual(pickByPrefix(booliShape, 'searchForSale', 'totalCount'), 60560, 'booli.till_salu'));

// --- Final summary ---
const total = pass + fail;
if (fail === 0) {
  console.log(`\nPASS: ${pass}/${total}`);
  process.exit(0);
} else {
  console.log(`\nFAIL: ${pass}/${total} passed; ${fail} failed`);
  failures.forEach(f => console.error(f));
  process.exit(1);
}
