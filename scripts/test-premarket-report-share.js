// scripts/test-premarket-report-share.js
// Offline test for the Hemnet/Booli ADDS SHARE row in the pre-market flow weekly report.
// This ratio is the headline metric (Hemnet's share of fresh pre-market origination): it
// stayed ~46-49% while both platforms' absolute inflow fell ~30%, so the absolute numbers
// mislead and the ratio doesn't. It gets a first-class table row + a WoW pp delta.
//
// Run: node scripts/test-premarket-report-share.js
// Exit 0 on pass, 1 on any failure. Output: "PASS: N/M" or "FAIL: ...".

'use strict';

const { addsShare, formatShareRow, formatShareHistory } = require('../premarket-flow-weekly-report');

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

// --- formatShareHistory: the historic trend of the ratio ------------------------------
// Real series so far: 07-06 45.5%, 07-13 48.7%, 07-22 46.7%.

const HIST = [
  { day: '2026-07-06', hemnetAdds: 1143, booliAdds: 2512 },
  { day: '2026-07-13', hemnetAdds: 1081, booliAdds: 2218 },
  { day: '2026-07-22', hemnetAdds: 817,  booliAdds: 1750 },
];

test('formatShareHistory returns one line per snapshot, in the order given', () => {
  const lines = formatShareHistory(HIST);
  assert(Array.isArray(lines), 'should return an array of lines');
  assert(lines.length === 3, `expected 3 lines, got ${lines.length}`);
  assert(/2026-07-06/.test(lines[0]), `first line should be the oldest snapshot, got: ${lines[0]}`);
  assert(/2026-07-22/.test(lines[2]), `last line should be the newest snapshot, got: ${lines[2]}`);
});

test('formatShareHistory computes the share for each snapshot', () => {
  const lines = formatShareHistory(HIST);
  assert(/45\.5%/.test(lines[0]), `expected 45.5% on 07-06, got: ${lines[0]}`);
  assert(/48\.7%/.test(lines[1]), `expected 48.7% on 07-13, got: ${lines[1]}`);
  assert(/46\.7%/.test(lines[2]), `expected 46.7% on 07-22, got: ${lines[2]}`);
});

test('formatShareHistory shows the raw adds so the ratio is auditable', () => {
  const lines = formatShareHistory(HIST);
  assert(/1,143/.test(lines[0]) && /2,512/.test(lines[0]), `expected raw adds, got: ${lines[0]}`);
});

test('formatShareHistory renders ? for a partial week rather than crashing', () => {
  // Exactly the 2026-07-22 pre-re-run state: Hemnet persisted, Booli failed.
  const lines = formatShareHistory([{ day: '2026-07-22', hemnetAdds: 817, booliAdds: null }]);
  assert(lines.length === 1, 'partial week must still produce a line');
  assert(/\?/.test(lines[0]), `expected ? share for a partial week, got: ${lines[0]}`);
  assert(/817/.test(lines[0]), `should still show the side we do have, got: ${lines[0]}`);
});

test('formatShareHistory handles an empty series without crashing', () => {
  const lines = formatShareHistory([]);
  assert(Array.isArray(lines) && lines.length >= 1, 'empty history should yield a placeholder line');
});

if (fail === 0) {
  console.log(`PASS: ${pass}/${pass + fail}`);
  process.exit(0);
} else {
  console.log(`FAIL: ${fail}/${pass + fail} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
