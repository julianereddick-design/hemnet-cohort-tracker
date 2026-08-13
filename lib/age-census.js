'use strict';
// lib/age-census.js — pure helpers for the monthly age-penetration census.
// No network, no DB. Band maths is delegated to lib/premarket-flow.js so the monthly
// series is computed identically to the July one-off censuses.
//
// The dual tally: scripts already track newbuild[k] per band, so the 2nd-hand histogram
// is a band-wise subtraction. Binary-search methods cannot do this (they never see most
// cards) — those pools pass newbuild=null and store buckets_secondhand=NULL. See spec §5.
//
// Self-test: node lib/age-census.js --smoke
const { bandIndex, cardAgeDays, DAY } = require('./premarket-flow');

const EDGES = [30, 90, 180, 365, 548, 730];
const LABELS = ['≤1mo', '1–3mo', '3–6mo', '6–12mo', '12–18mo', '18–24mo', '>24mo'];
const BAND_KEYS = ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24'];
const N_BANDS = EDGES.length + 1;

// `seen` is injectable so per-muni accumulators dedupe against ONE global id set while
// keeping their own bands — national totals are then the sum of the per-muni bands.
function newAccumulator({ seen } = {}) {
  return {
    buckets: new Array(N_BANDS).fill(0),
    newbuild: new Array(N_BANDS).fill(0),
    seen: seen || new Set(),
    distinct: 0,
    undated: 0,
    anomalies: 0,
  };
}

// Fold one normalized card { id, published:<unix sec|null>, isNewBuild } into an accumulator.
// Returns false when the id was already counted anywhere (global dedupe).
function addCardTo(acc, card, nowSec) {
  if (card.id != null) {
    if (acc.seen.has(card.id)) return false;
    acc.seen.add(card.id);
  }
  acc.distinct++;
  const p = card.published;
  // A mangled (ISO string, garbage coercion) or future timestamp is an anomaly, never a band.
  if (p == null || typeof p !== 'number' || !isFinite(p) || p <= 0 || p > nowSec + DAY) {
    if (p != null) acc.anomalies++;
    acc.undated++;
    return true;
  }
  const k = bandIndex(cardAgeDays(p, nowSec), EDGES);
  acc.buckets[k]++;
  if (card.isNewBuild) acc.newbuild[k]++;
  return true;
}

function mergeAccumulators(accs) {
  const out = newAccumulator();
  for (const a of accs) {
    for (let k = 0; k < N_BANDS; k++) { out.buckets[k] += a.buckets[k]; out.newbuild[k] += a.newbuild[k]; }
    out.distinct += a.distinct;
    out.undated += a.undated;
    out.anomalies += a.anomalies;
  }
  return out;
}

function bucketsToObject(buckets, undated) {
  const o = {};
  BAND_KEYS.forEach((key, k) => { o[key] = buckets[k] || 0; });
  o.undated = undated || 0;
  return o;
}

// Band-wise all-minus-new-build. Clamped at 0: a band whose cards are all new-builds must
// read 0, never negative, even if a upstream counter double-counts.
function secondhandToObject(buckets, newbuild, undated) {
  const o = {};
  BAND_KEYS.forEach((key, k) => { o[key] = Math.max(0, (buckets[k] || 0) - (newbuild[k] || 0)); });
  o.undated = undated || 0;
  return o;
}

const gate = (name, passed, detail) => ({ name, passed, detail });

// Hemnet muni-partition: Σ per-muni headline totals must match the distinct union.
function gateReconciliation({ headlineSum, distinct, maxPct = 2 }) {
  if (!headlineSum) return gate('reconciliation', true, 'no headline total to reconcile');
  const deltaPct = Math.abs(headlineSum - distinct) / headlineSum * 100;
  return gate('reconciliation', deltaPct <= maxPct,
    `Σ headline ${headlineSum} vs distinct ${distinct} (Δ ${deltaPct.toFixed(2)}%, max ${maxPct}%)`);
}

// Booli FS two-pass: the 90d cutoff computed from both ends must agree.
// FAILS CLOSED BY DESIGN — unlike gateReconciliation, gateTotalDrift, gateErrorPages which
// pass on absent input (since they run on every pool), gateCrosscheck has exactly one caller:
// the Booli for-sale two-pass estimate. If these values are absent there, the two-pass estimate
// itself has broken, and silently passing would hide a broken flow. Absence here must be loud.
function gateCrosscheck({ newestPass, oldestPass, headlineTotal, maxPct = 3 }) {
  if (newestPass == null || oldestPass == null || !headlineTotal) {
    return gate('crosscheck', false, 'crosscheck values missing');
  }
  const deltaPct = Math.abs(newestPass - oldestPass) / headlineTotal * 100;
  return gate('crosscheck', deltaPct <= maxPct,
    `90d newest-pass ${Math.round(newestPass)} vs oldest-pass ${Math.round(oldestPass)} (Δ ${deltaPct.toFixed(2)}% of pool, max ${maxPct}%)`);
}

// Catches a scrape-shape regression that silently halves a pool. No prior month → pass.
function gateTotalDrift({ nTotal, priorTotal, maxPct = 25 }) {
  if (priorTotal == null) return gate('total_drift', true, 'no prior month — nothing to compare');
  const deltaPct = Math.abs(nTotal - priorTotal) / priorTotal * 100;
  return gate('total_drift', deltaPct <= maxPct,
    `n_total ${nTotal} vs prior ${priorTotal} (Δ ${deltaPct.toFixed(1)}%, max ${maxPct}%)`);
}

// Municipality coverage, PROPORTIONAL. A muni-partition census that never got page 1 for a
// municipality drops that municipality's listings from BOTH sides of gateReconciliation (0
// headline AND 0 counted), so the reconciliation Δ stays ≈0% and the gap is invisible —
// Stockholm alone is ~5,000 of ~43,000 Hemnet for-sale listings, an 11.5% undercount that
// reconciliation, error_pages (1/1208 = 0.08%) and total_drift (−11.5%, under 25%) all wave
// through. But losing Alingsås (7 listings) must not void a month's headline, so the gate is
// sized, not binary: fail when the estimated missing share exceeds maxPct of the national total.
//
// The sizing problem: a municipality whose page 1 failed never reported its total, so its size
// is unknown at run time. `priorMuniSizes` supplies it from the most recent gate-PASSED prior
// run's per-municipality rows (age_census_muni) — that table exists for exactly this question.
//
// A failed scope with NO size FAILS the gate regardless of how small it might be: an
// unmeasurable gap cannot be certified as small, and the case where that happens for a whole
// municipality (a first-ever run, or a municipality new to the partition) is precisely the one
// where guessing is least safe.
//
// A gap INSIDE a municipality whose page 1 succeeded does not need a prior month at all: that
// municipality reported its own headline total, and we know how many distinct listings we
// actually counted for it, so `headlineN - countedN` is the MEASURED size of everything missing
// inside it — whatever caused it. Those arrive as `measuredMissing`, work on the very first run,
// and let a 3-listing price band publish with a note instead of voiding a 43,000-listing pool.
// The measured shortfall is per-municipality and covers all of that municipality's failed
// sub-scopes jointly, so it is booked once, never once per band. It is a slight OVER-estimate of
// the failed band alone (it also absorbs any clamp/dedupe residue in that municipality), which
// errs toward failing — the safe direction.
//
// Note on overlap with gateReconciliation: a measured shortfall is exactly this municipality's
// contribution to Σ headline − distinct, so a large one will trip BOTH gates. That is fine and
// intended — they are consistent, not contradictory: reconciliation reports the national Δ over
// Σ headline, this gate reports the same listings over the COUNTED total, so the two percentages
// differ slightly by denominator and are labelled accordingly. A whole-municipality page-1
// failure is the opposite case: it cancels out of reconciliation entirely (0 headline AND 0
// counted) and only this gate can see it.
//
// The detail string ALWAYS names the scopes and the estimated share, so a run that passes with
// a small imperfection is still legible on a published row.
// Passes on absent input (like the other always-on gates) — a pool with no muni partition
// (Booli binary-search) simply has nothing to report here.
function gateCoverage({ failedMunis, priorMuniSizes, nationalTotal, measuredMissing, maxPct = 0.5 } = {}) {
  const failed = Array.isArray(failedMunis) ? failedMunis.filter(Boolean) : [];

  // measuredMissing accepts a per-scope list [{ label, missing }] (preferred — it names each
  // gap with its own size) or a bare total. Anything malformed is ignored rather than thrown on.
  let measured = [];
  if (Array.isArray(measuredMissing)) {
    measured = measuredMissing
      .filter(m => m && isFinite(Number(m.missing)) && Number(m.missing) >= 0)
      .map(m => ({ label: String(m.label == null ? 'scope' : m.label), missing: Number(m.missing) }));
  } else if (typeof measuredMissing === 'number' && isFinite(measuredMissing) && measuredMissing >= 0) {
    measured = [{ label: 'measured shortfall', missing: measuredMissing }];
  }
  const measuredTotal = measured.reduce((a, m) => a + m.missing, 0);

  if (failed.length === 0 && measured.length === 0) return gate('coverage', true, 'no municipality skipped');

  const sizes = priorMuniSizes || {};
  const MAX_NAMED = 12;
  const nameList = (arr) => arr.slice(0, MAX_NAMED).join(', ') + (arr.length > MAX_NAMED ? `, +${arr.length - MAX_NAMED} more` : '');

  const known = [], unknown = [];
  let priorSized = 0;
  for (const name of failed) {
    const n = sizes[name];
    if (typeof n === 'number' && isFinite(n) && n >= 0) { known.push(`${name} (~${n})`); priorSized += n; }
    else unknown.push(name);
  }
  const measuredNames = measured.map(m => `${m.label} (measured ${m.missing})`);
  const estMissing = priorSized + measuredTotal;
  const scopeCount = failed.length + measured.length;
  const sized = [...known, ...measuredNames];

  if (unknown.length) {
    return gate('coverage', false,
      `${scopeCount} scope(s) skipped; ${unknown.length} have NO measurable size — an unmeasurable gap cannot be certified as small: ${nameList(unknown)}` +
      (sized.length ? `; sized skips ${nameList(sized)} ≈ ${estMissing} listings` : ''));
  }
  if (!nationalTotal) {
    return gate('coverage', false,
      `${scopeCount} scope(s) skipped (${nameList(sized)}, ≈ ${estMissing} listings) but the national total is unknown, so the missing share cannot be measured`);
  }
  const pct = 100 * estMissing / nationalTotal;
  return gate('coverage', pct <= maxPct,
    `${scopeCount} scope(s) skipped: ${nameList(sized)} — est. ${estMissing} listings missing, ${pct.toFixed(2)}% of ${nationalTotal} counted (max ${maxPct}%)`);
}

function gateErrorPages({ errorPages, oxCalls, maxPct = 2 }) {
  if (!oxCalls) return gate('error_pages', true, 'no calls made');
  const pct = errorPages / oxCalls * 100;
  return gate('error_pages', pct <= maxPct, `${errorPages}/${oxCalls} error pages (${pct.toFixed(2)}%, max ${maxPct}%)`);
}

function evaluateGates(gates) {
  const failures = gates.filter(g => !g.passed).map(g => g.name);
  const detail = {};
  for (const g of gates) detail[g.name] = { passed: g.passed, detail: g.detail };
  return { passed: failures.length === 0, failures, detail };
}

module.exports = {
  EDGES, LABELS, BAND_KEYS, N_BANDS,
  newAccumulator, addCardTo, mergeAccumulators,
  bucketsToObject, secondhandToObject,
  gateReconciliation, gateCrosscheck, gateTotalDrift, gateErrorPages, gateCoverage, evaluateGates,
};

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { DAY } = require('./premarket-flow');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  const NOW = 5000 * DAY;

  check('addCardTo: bands, new-build split, global dedupe, undated', () => {
    const acc = newAccumulator();
    assert.strictEqual(addCardTo(acc, { id: 'a', published: NOW - 10 * DAY, isNewBuild: false }, NOW), true);
    assert.strictEqual(addCardTo(acc, { id: 'a', published: NOW - 10 * DAY, isNewBuild: false }, NOW), false, 'duplicate id must not recount');
    addCardTo(acc, { id: 'b', published: NOW - 40 * DAY, isNewBuild: true }, NOW);
    addCardTo(acc, { id: 'c', published: null, isNewBuild: false }, NOW);
    assert.strictEqual(acc.buckets[0], 1);
    assert.strictEqual(acc.buckets[1], 1);
    assert.strictEqual(acc.newbuild[1], 1);
    assert.strictEqual(acc.undated, 1);
    assert.strictEqual(acc.distinct, 3);
  });

  check('addCardTo: mangled/future publishedAt counts as anomaly + undated, never a band', () => {
    const acc = newAccumulator();
    addCardTo(acc, { id: 'x', published: NOW + 5 * DAY, isNewBuild: false }, NOW);
    addCardTo(acc, { id: 'y', published: 'not-a-number', isNewBuild: false }, NOW);
    assert.strictEqual(acc.anomalies, 2);
    assert.strictEqual(acc.undated, 2);
    assert.strictEqual(acc.buckets.reduce((a, b) => a + b, 0), 0);
  });

  check('shared seen Set: per-muni accumulators dedupe globally but bucket separately', () => {
    const seen = new Set();
    const m1 = newAccumulator({ seen }), m2 = newAccumulator({ seen });
    addCardTo(m1, { id: 'dup', published: NOW - 5 * DAY, isNewBuild: false }, NOW);
    assert.strictEqual(addCardTo(m2, { id: 'dup', published: NOW - 5 * DAY, isNewBuild: false }, NOW), false);
    addCardTo(m2, { id: 'own', published: NOW - 5 * DAY, isNewBuild: false }, NOW);
    assert.strictEqual(m1.buckets[0], 1);
    assert.strictEqual(m2.buckets[0], 1);
    const nat = mergeAccumulators([m1, m2]);
    assert.strictEqual(nat.buckets[0], 2, 'national = sum of per-muni');
  });

  check('bucketsToObject / secondhandToObject: 2nd-hand = all minus new-build, band-wise', () => {
    const buckets = [10, 20, 0, 0, 0, 0, 5];
    const newbuild = [1, 4, 0, 0, 0, 0, 5];
    const all = bucketsToObject(buckets, 3);
    const sec = secondhandToObject(buckets, newbuild, 3);
    assert.strictEqual(all.le1m, 10);
    assert.strictEqual(all.gt24, 5);
    assert.strictEqual(all.undated, 3);
    assert.strictEqual(sec.le1m, 9);
    assert.strictEqual(sec.m1_3, 16);
    assert.strictEqual(sec.gt24, 0, 'a band that is all new-build goes to zero, not negative');
    assert.deepStrictEqual(Object.keys(all), [...BAND_KEYS, 'undated']);
  });

  check('gateReconciliation: passes inside tolerance, fails outside', () => {
    assert.strictEqual(gateReconciliation({ headlineSum: 8368, distinct: 8368, maxPct: 2 }).passed, true);
    assert.strictEqual(gateReconciliation({ headlineSum: 8368, distinct: 8000, maxPct: 2 }).passed, false);
  });

  check('gateCrosscheck: July Booli FS numbers pass; a 10% split fails', () => {
    assert.strictEqual(gateCrosscheck({ newestPass: 26454, oldestPass: 26939, headlineTotal: 52349, maxPct: 3 }).passed, true);
    assert.strictEqual(gateCrosscheck({ newestPass: 20000, oldestPass: 26000, headlineTotal: 52349, maxPct: 3 }).passed, false);
  });

  check('gateCrosscheck fails closed on missing input — unlike the other gates, absence means the two-pass estimate broke', () => {
    assert.strictEqual(gateCrosscheck({ newestPass: null, oldestPass: 26939, headlineTotal: 52349, maxPct: 3 }).passed, false);
    assert.strictEqual(gateCrosscheck({ newestPass: 26454, oldestPass: 26939, headlineTotal: 0, maxPct: 3 }).passed, false);
    // contrast: the always-on gates pass when their input is absent
    assert.strictEqual(gateTotalDrift({ nTotal: 100, priorTotal: null, maxPct: 25 }).passed, true);
  });

  check('gateTotalDrift: no prior month always passes (first run must not trip)', () => {
    assert.strictEqual(gateTotalDrift({ nTotal: 33742, priorTotal: null, maxPct: 25 }).passed, true);
    assert.strictEqual(gateTotalDrift({ nTotal: 33742, priorTotal: 33000, maxPct: 25 }).passed, true);
    assert.strictEqual(gateTotalDrift({ nTotal: 16000, priorTotal: 33000, maxPct: 25 }).passed, false);
  });

  check('gateErrorPages: 0 passes; >2% fails; 0 calls never divides by zero', () => {
    assert.strictEqual(gateErrorPages({ errorPages: 0, oxCalls: 656, maxPct: 2 }).passed, true);
    assert.strictEqual(gateErrorPages({ errorPages: 50, oxCalls: 656, maxPct: 2 }).passed, false);
    assert.strictEqual(gateErrorPages({ errorPages: 0, oxCalls: 0, maxPct: 2 }).passed, true);
  });

  check('gateCoverage: no failures passes, and absent input never throws', () => {
    assert.strictEqual(gateCoverage({ failedMunis: [], priorMuniSizes: {}, nationalTotal: 43338 }).passed, true);
    // never throws on missing input, and absence is a pass (Booli pools have no muni partition)
    assert.strictEqual(gateCoverage({}).passed, true);
    assert.strictEqual(gateCoverage().passed, true);
    assert.strictEqual(gateCoverage({ failedMunis: undefined, priorMuniSizes: undefined, nationalTotal: undefined }).passed, true);
  });

  check('gateCoverage: sized by the missing share — Alingsås passes, Stockholm fails', () => {
    const SIZES = { Stockholm: 5000, 'Alingsås': 7, Kungälv: 210 };
    // 7 of 43,338 = 0.02% — a tiny municipality must not void the whole month's headline
    const small = gateCoverage({ failedMunis: ['Alingsås'], priorMuniSizes: SIZES, nationalTotal: 43338, maxPct: 0.5 });
    assert.strictEqual(small.passed, true, `a 7-listing gap must pass: ${small.detail}`);
    assert.ok(/Alingsås/.test(small.detail), 'a passing-but-imperfect run must still name the gap');
    assert.ok(/0\.02%/.test(small.detail), `the estimated share must be stated: ${small.detail}`);
    // 5,000 of 43,338 = 11.54% — must fail loudly
    const big = gateCoverage({ failedMunis: ['Stockholm'], priorMuniSizes: SIZES, nationalTotal: 43338, maxPct: 0.5 });
    assert.strictEqual(big.passed, false, 'losing Stockholm must fail the gate');
    assert.ok(/Stockholm/.test(big.detail) && /11\.54%/.test(big.detail), big.detail);
    // sizes accumulate across several small munis until they cross the threshold together
    const combined = gateCoverage({ failedMunis: ['Alingsås', 'Kungälv'], priorMuniSizes: SIZES, nationalTotal: 43338, maxPct: 0.5 });
    assert.strictEqual(combined.passed, false, '7 + 210 = 217 of 43,338 = 0.50%… just over the line');
    assert.ok(/217 listings missing/.test(combined.detail), combined.detail);
  });

  check('gateCoverage: a failed scope of UNKNOWN size fails regardless — it cannot be certified small', () => {
    const unknown = gateCoverage({ failedMunis: ['Nykommun'], priorMuniSizes: { Stockholm: 5000 }, nationalTotal: 43338, maxPct: 0.5 });
    assert.strictEqual(unknown.passed, false, 'no prior size → the gap is unmeasurable → fail');
    assert.ok(/NO measurable size/.test(unknown.detail), `the reason must be explicit: ${unknown.detail}`);
    assert.ok(/Nykommun/.test(unknown.detail));
    // first ever run: no prior data at all, so every failure is unknown
    assert.strictEqual(gateCoverage({ failedMunis: ['Alingsås'], priorMuniSizes: {}, nationalTotal: 43338 }).passed, false);
    assert.strictEqual(gateCoverage({ failedMunis: ['Alingsås'], priorMuniSizes: null, nationalTotal: 43338 }).passed, false);
    // a sub-scope label is unknown by construction — a price band we could not fetch twice
    const band = gateCoverage({ failedMunis: ['Stockholm/villa/3-4M'], priorMuniSizes: { Stockholm: 5000 }, nationalTotal: 43338 });
    assert.strictEqual(band.passed, false, 'an unfetchable price band inside a big muni must fail');
    assert.ok(/Stockholm\/villa\/3-4M/.test(band.detail));
    // an unknown scope still reports what IS known alongside it
    const mixed = gateCoverage({ failedMunis: ['Nykommun', 'Alingsås'], priorMuniSizes: { 'Alingsås': 7 }, nationalTotal: 43338 });
    assert.strictEqual(mixed.passed, false);
    assert.ok(/sized skips/.test(mixed.detail) && /Alingsås \(~7\)/.test(mixed.detail), mixed.detail);
    // a known-size gap with no national total to divide by is equally unmeasurable
    const noTotal = gateCoverage({ failedMunis: ['Alingsås'], priorMuniSizes: { 'Alingsås': 7 }, nationalTotal: 0 });
    assert.strictEqual(noTotal.passed, false, 'no denominator → the share cannot be measured → fail');
    // long lists stay truncated but keep the true count
    const many = gateCoverage({ failedMunis: Array.from({ length: 30 }, (_, i) => 'M' + i), priorMuniSizes: {}, nationalTotal: 43338 });
    assert.strictEqual(many.passed, false);
    assert.ok(/\+18 more/.test(many.detail), `long list must be truncated: ${many.detail}`);
    assert.ok(/^30 scope\(s\) skipped/.test(many.detail), 'the true count must survive truncation');
  });

  check('gateCoverage: a MEASURED shortfall is sized without any prior month', () => {
    // A gap inside a municipality whose page 1 succeeded is measured as headlineN − countedN,
    // so it needs no priorMuniSizes and works on the very first run.
    const small = gateCoverage({ measuredMissing: [{ label: 'Stockholm/villa/3-4M', missing: 20 }], nationalTotal: 43338, maxPct: 0.5 });
    assert.strictEqual(small.passed, true, `20 of 43,338 = 0.05% must publish: ${small.detail}`);
    assert.ok(/Stockholm\/villa\/3-4M \(measured 20\)/.test(small.detail), `each gap must be named with its own measured size: ${small.detail}`);
    assert.ok(/0\.05%/.test(small.detail), small.detail);
    assert.ok(!/NO measurable size/.test(small.detail), 'a measured gap is not an unmeasurable one');
    // over the threshold
    const big = gateCoverage({ measuredMissing: [{ label: 'Stockholm/villa/3-4M', missing: 900 }], nationalTotal: 43338, maxPct: 0.5 });
    assert.strictEqual(big.passed, false, '900 of 43,338 = 2.08% must fail');
    assert.ok(/2\.08%/.test(big.detail), big.detail);
    // a zero shortfall is still named, and still passes
    const zero = gateCoverage({ measuredMissing: [{ label: 'Malmö/tomt', missing: 0 }], nationalTotal: 43338 });
    assert.strictEqual(zero.passed, true);
    assert.ok(/Malmö\/tomt \(measured 0\)/.test(zero.detail), zero.detail);
    // a bare number is accepted as an unlabelled total
    const bare = gateCoverage({ measuredMissing: 900, nationalTotal: 43338, maxPct: 0.5 });
    assert.strictEqual(bare.passed, false);
    assert.ok(/measured shortfall \(measured 900\)/.test(bare.detail), bare.detail);
    // malformed input is ignored, never thrown on
    assert.strictEqual(gateCoverage({ measuredMissing: [null, { label: 'x' }, { missing: 'NaN' }], nationalTotal: 43338 }).passed, true);
    assert.strictEqual(gateCoverage({ measuredMissing: 'nonsense', nationalTotal: 43338 }).passed, true);
  });

  check('gateCoverage: measured shortfalls and prior-sized munis share ONE threshold', () => {
    // 200 measured + 100 prior-sized = 300 of 43,338 = 0.69% — neither alone crosses 0.5%,
    // together they do. The detail must name both kinds.
    const r = gateCoverage({
      failedMunis: ['Kungälv'], priorMuniSizes: { Kungälv: 100 },
      measuredMissing: [{ label: 'Göteborg/villa', missing: 200 }],
      nationalTotal: 43338, maxPct: 0.5,
    });
    assert.strictEqual(r.passed, false, `300 of 43,338 = 0.69% must fail: ${r.detail}`);
    assert.ok(/est\. 300 listings missing/.test(r.detail), r.detail);
    assert.ok(/Kungälv \(~100\)/.test(r.detail) && /Göteborg\/villa \(measured 200\)/.test(r.detail), r.detail);
    assert.ok(/^2 scope\(s\) skipped/.test(r.detail), 'both kinds must be counted as scopes');
    // an UNSIZED municipality still fails outright even next to a tiny measured gap
    const mixed = gateCoverage({
      failedMunis: ['Nykommun'], priorMuniSizes: {},
      measuredMissing: [{ label: 'Göteborg/villa', missing: 2 }],
      nationalTotal: 43338,
    });
    assert.strictEqual(mixed.passed, false);
    assert.ok(/NO measurable size/.test(mixed.detail) && /Nykommun/.test(mixed.detail), mixed.detail);
    assert.ok(/sized skips .*Göteborg\/villa \(measured 2\)/.test(mixed.detail), 'the measured gap must still be reported alongside');
  });

  check('reconciliation and coverage read coherently when the SAME gap trips both', () => {
    // A measured shortfall IS this municipality's contribution to Σ headline − distinct, so a
    // large one fires both gates. That is fine — but the two lines must corroborate, not appear
    // to disagree. They cite the same absolute gap and each names its OWN denominator.
    const HEADLINE = 43338, COUNTED = 42438, MISSING = 900;
    const rec = gateReconciliation({ headlineSum: HEADLINE, distinct: COUNTED, maxPct: 2 });
    const cov = gateCoverage({ measuredMissing: [{ label: 'Stockholm/villa/3-4M', missing: MISSING }], nationalTotal: COUNTED, maxPct: 0.5 });
    assert.strictEqual(rec.passed, false, 'a 900-listing gap is over reconciliation\'s 2%');
    assert.strictEqual(cov.passed, false, 'and over coverage\'s 0.5%');
    assert.ok(rec.detail.includes(String(HEADLINE)) && rec.detail.includes(String(COUNTED)), rec.detail);
    assert.ok(cov.detail.includes(String(MISSING)) && cov.detail.includes(String(COUNTED)), cov.detail);
    // the percentages differ ONLY by denominator, and each line says which it used
    assert.ok(/Δ 2\.08%/.test(rec.detail), rec.detail);
    assert.ok(/2\.12% of 42438 counted/.test(cov.detail), cov.detail);
    // the reverse case: a whole-muni gap cancels out of reconciliation, so only coverage sees it
    const recBlind = gateReconciliation({ headlineSum: 38338, distinct: 38338, maxPct: 2 });
    assert.strictEqual(recBlind.passed, true, 'a skipped muni subtracts from both sides — reconciliation is blind to it');
    assert.strictEqual(gateCoverage({ failedMunis: ['Stockholm'], priorMuniSizes: { Stockholm: 5000 }, nationalTotal: 38338 }).passed, false);
  });

  check('evaluateGates: collects failures by name', () => {
    const r = evaluateGates([
      gateErrorPages({ errorPages: 0, oxCalls: 10, maxPct: 2 }),
      gateTotalDrift({ nTotal: 10, priorTotal: 100, maxPct: 25 }),
    ]);
    assert.strictEqual(r.passed, false);
    assert.deepStrictEqual(r.failures, ['total_drift']);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
