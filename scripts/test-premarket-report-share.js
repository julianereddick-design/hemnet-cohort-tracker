// scripts/test-premarket-report-share.js
// Offline test for the Hemnet/Booli ADDS SHARE row in the pre-market flow weekly report.
// This ratio is the headline metric (Hemnet's share of fresh pre-market origination): it
// stayed ~46-49% while both platforms' absolute inflow fell ~30%, so the absolute numbers
// mislead and the ratio doesn't. It gets a first-class table row + a WoW pp delta.
//
// Run: node scripts/test-premarket-report-share.js
// Exit 0 on pass, 1 on any failure. Output: "PASS: N/M" or "FAIL: ...".

'use strict';

const { addsShare, formatShareRow } = require('../premarket-flow-weekly-report');

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; failures.push(`${name}: ${e && e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// --- addsShare: Hemnet adds as a fraction of Booli adds -------------------------------

test('addsShare returns hemnet/booli fraction', () => {
  const s = addsShare(817, 1750);            // the real 2026-07-22 reading
  assert(Math.abs(s - 0.46686) < 0.0001, `expected ~0.46686, got ${s}`);
});

test('addsShare returns null when booli adds is zero', () => {
  assert(addsShare(817, 0) === null, 'zero Booli adds must not divide');
});

test('addsShare returns null when either side is missing', () => {
  assert(addsShare(null, 1750) === null, 'null hemnet -> null');
  assert(addsShare(817, null) === null, 'null booli -> null');
});

// --- formatShareRow: the table row ----------------------------------------------------

test('formatShareRow renders the share as a percent', () => {
  const row = formatShareRow(0.46686, null);
  assert(/46\.7%/.test(row), `expected 46.7% in row, got: ${row}`);
});

test('formatShareRow appends a WoW pp delta when prior exists', () => {
  // 48.737% -> 46.686% = a 2.051pp DROP -> "2.1pp". NOTE the delta is computed from the
  // UNROUNDED shares, so it can differ by 0.1 from eyeballing the two rounded percents
  // (48.7 - 46.7 = 2.0). Precision wins: this metric is read for share shifts.
  const row = formatShareRow(0.46686, 0.48737);
  assert(/46\.7%/.test(row), `expected current 46.7%, got: ${row}`);
  assert(/2\.1pp/.test(row), `expected 2.1pp delta, got: ${row}`);
  assert(/−/.test(row), `expected U+2212 minus for a drop, got: ${row}`);
});

test('formatShareRow marks a rising share with +', () => {
  // 45.5% -> 48.7% = a 3.2pp GAIN
  const row = formatShareRow(0.48737, 0.45501);
  assert(/\+3\.2pp/.test(row), `expected +3.2pp, got: ${row}`);
});

test('formatShareRow shows WoW ? when prior week missing', () => {
  const row = formatShareRow(0.46686, null);
  assert(/WoW \?/.test(row), `expected "WoW ?" when prior missing, got: ${row}`);
});

test('formatShareRow renders ? when current share unavailable', () => {
  const row = formatShareRow(null, 0.48737);
  assert(/\?/.test(row), `expected ? for missing current, got: ${row}`);
  assert(!/pp/.test(row), `must not show a pp delta with no current value, got: ${row}`);
});

test('formatShareRow is labelled so the metric is unambiguous', () => {
  const row = formatShareRow(0.46686, null);
  assert(/Hemnet\/Booli adds/.test(row), `expected explicit label, got: ${row}`);
});

if (fail === 0) {
  console.log(`PASS: ${pass}/${pass + fail}`);
  process.exit(0);
} else {
  console.log(`FAIL: ${fail}/${pass + fail} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
