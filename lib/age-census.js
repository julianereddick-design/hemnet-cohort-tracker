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

// Municipality coverage. A muni-partition census that never got page 1 for a municipality
// drops that municipality's listings from BOTH sides of gateReconciliation (0 headline AND
// 0 counted), so the reconciliation Δ stays ≈0% and the gap is invisible — Stockholm alone
// is ~5,000 of ~43,000 Hemnet for-sale listings, an 11.5% undercount that reconciliation,
// error_pages (1/1208 = 0.08%) and total_drift (−11.5%, under 25%) all wave through. This
// gate exists so a whole-municipality coverage failure can never be reported as clean.
// Passes on absent input (like the other always-on gates) — a pool with no muni partition
// (Booli binary-search) simply has nothing to report here.
function gateCoverage({ failedMunis, totalMunis } = {}) {
  const failed = Array.isArray(failedMunis) ? failedMunis.filter(Boolean) : [];
  const scope = totalMunis ? `/${totalMunis}` : '';
  if (failed.length === 0) return gate('coverage', true, `no municipality skipped${totalMunis ? ` (${totalMunis} processed)` : ''}`);
  const MAX_NAMED = 12;
  const named = failed.slice(0, MAX_NAMED).join(', ');
  const more = failed.length > MAX_NAMED ? `, +${failed.length - MAX_NAMED} more` : '';
  return gate('coverage', false, `${failed.length}${scope} municipalities skipped entirely (page 1 never fetched): ${named}${more}`);
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

  check('gateCoverage: zero failures passes; one failure fails and names it; absent input passes', () => {
    assert.strictEqual(gateCoverage({ failedMunis: [], totalMunis: 290 }).passed, true);
    const one = gateCoverage({ failedMunis: ['Stockholm'], totalMunis: 290 });
    assert.strictEqual(one.passed, false, 'a single skipped municipality must fail the gate');
    assert.ok(/Stockholm/.test(one.detail), 'the detail must name the municipality');
    assert.ok(/1\/290/.test(one.detail), 'the detail must say how many of how many');
    // never throws on missing input, and absence is a pass (Booli pools have no muni partition)
    assert.strictEqual(gateCoverage({}).passed, true);
    assert.strictEqual(gateCoverage().passed, true);
    assert.strictEqual(gateCoverage({ failedMunis: undefined, totalMunis: undefined }).passed, true);
    // a long list is truncated but still reports the true count
    const many = gateCoverage({ failedMunis: Array.from({ length: 30 }, (_, i) => 'M' + i), totalMunis: 290 });
    assert.strictEqual(many.passed, false);
    assert.ok(/\+18 more/.test(many.detail), `long list must be truncated: ${many.detail}`);
    assert.ok(/^30\/290/.test(many.detail), 'the true count must survive truncation');
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
