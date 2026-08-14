'use strict';
// lib/age-census.js — pure helpers for the monthly age-penetration census.
// No network, no DB. Band maths is delegated to lib/premarket-flow.js so the monthly
// series is computed identically to the July one-off censuses.
//
// The dual tally: the Hemnet muni-partition scripts track newbuild[k] per band, so their
// 2nd-hand histogram is a band-wise subtraction (secondhandToObject). See spec §5.
//
// The Booli binary-search pools cannot subtract per band — they never see most cards — so they
// get their 2nd-hand histogram a different way: by running the same bisection a SECOND time
// against Booli's `isNewConstruction=0` stream (2026-08-13; the spec's older note that those
// pools always store buckets_secondhand=NULL is superseded). That second basis is only safe if
// the filter really applied and the two independent bisections agree, which is what
// filterApplied / secondhandBandTolerance / reconcileSecondhandBands below decide.
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

// ---------------------------------------------------------------------------
// Second-hand basis validation (Booli binary-search pools).
//
// Both Booli pools infer their second-hand histogram by running the SAME bisection a second
// time against Booli's `isNewConstruction=0` stream. These three helpers are the safety rules
// that decide whether that second basis may be published at all. They live here, not in the
// scrapers, because they were byte-identical copies in both and encode decisions that must
// never drift apart. Pure: no network, no DB, no module state.
// ---------------------------------------------------------------------------

// DID THE FILTER ACTUALLY APPLY?
// Booli silently ignores query parameters it does not recognise. When it does, the "filtered"
// URL serves the UNFILTERED pool and its page 1 carries the unfiltered headline total — so the
// two totals come back EQUAL, or a listing or two apart in whichever direction the pool drifted
// between the two page-1 reads. A `filtered > unfiltered` test therefore catches only the
// coin-flip half of that; the other half publishes bucketsSecondhand == buckets and
// nNewbuild == 0 as EXACT, unattended, with no note and no gate. That is precisely the silent
// wrong number this whole feature exists to avoid, and it is why the discovery probe
// (scripts/probe-booli-newconstruction-filter.js) asked for `=1` rather than trusting a small
// `=0` delta. Two independent signals, EITHER of which is disqualifying:
//
//   (a) FLAG   — every card the filtered pass fetched carries isNewBuild. A working filter
//                leaves essentially none behind. Needs a real sample before it can judge.
//   (b) VOLUME — a working filter always removes at least the new-builds. Measured live
//                2026-08-13: for-sale removes 2.62% of the pool, pre-market 0.59%. A removal
//                under 0.1% is not a filter, it is noise.
//
// (a) is the sharper signal but the weaker one on the pre-market pool: Booli pre-market is only
// 0.59% new-build, barely above the 0.5% threshold, so sampling noise can hide it. (b) is
// decisive there (an ignored filter removes 0.00%). Requiring only ONE of them to trip is what
// makes the pair robust.
const FILTER_MAX_NEWBUILD_RATE = 0.005;   // (a) >0.5% of cards seen still flagged new-build
const FILTER_MIN_REMOVED_PCT = 0.001;     // (b) <0.1% of the pool removed
const FILTER_MIN_FLAG_SAMPLE = 100;       // cards the filtered pass must have seen before (a) judges

function filterApplied({ unfilteredTotal, filteredTotal, cardsSeen = 0, newbuildSeen = 0 }) {
  if (!unfilteredTotal || filteredTotal == null) {
    return { applied: false, reason: `no headline total to compare (unfiltered ${unfilteredTotal}, filtered ${filteredTotal})` };
  }
  const nbRate = cardsSeen ? newbuildSeen / cardsSeen : 0;
  const removed = unfilteredTotal - filteredTotal;
  const removedPct = removed / unfilteredTotal;
  const canJudgeFlag = cardsSeen >= FILTER_MIN_FLAG_SAMPLE;
  const flagTrips = canJudgeFlag && nbRate > FILTER_MAX_NEWBUILD_RATE;
  const volumeTrips = removedPct < FILTER_MIN_REMOVED_PCT;
  const evidence =
    `${newbuildSeen}/${cardsSeen} cards seen on the filtered pass are still flagged new-build ` +
    `(${(nbRate * 100).toFixed(2)}%, max ${(FILTER_MAX_NEWBUILD_RATE * 100).toFixed(2)}%` +
    `${canJudgeFlag ? '' : `; under ${FILTER_MIN_FLAG_SAMPLE} cards, too small to judge`}); ` +
    `filtered total ${filteredTotal} vs unfiltered ${unfilteredTotal} removes ${removed} ` +
    `(${(removedPct * 100).toFixed(3)}%, min ${(FILTER_MIN_REMOVED_PCT * 100).toFixed(3)}%)`;
  if (flagTrips || volumeTrips) {
    return { applied: false, reason: `the isNewConstruction=0 filter appears to have been IGNORED — ${evidence}` };
  }
  return { applied: true, reason: evidence };
}

// SECOND-HAND BAND TOLERANCE — derived from the estimator's error model, not chosen by feel.
//
//   * A cumulative count from one bisection carries ~±pageSize: findCrossoverPage resolves the
//     boundary to a PAGE and then counts within it, so the residual error is a page at most.
//   * A BAND is the difference of two cumulative estimates -> ~±2·pageSize.
//   * We compare a band from the all-listings bisection against a band from a COMPLETELY
//     INDEPENDENT filtered bisection, so the difference of those two carries ~±4·pageSize.
//        -> floor 1: 4 × pageSize.
//   * That alone under-covers the residual >24mo band, which is not a difference of two
//     crossover estimates but datedBase − c730, where datedBase = headlineTotal × (1 −
//     undatedRate) and undatedRate is SAMPLED from the few hundred cards the pass happened to
//     see. At Booli's ~0.5% undated rate that sampling error is ~±0.29pp — ~±150 listings on a
//     52,000 pool. It scales with the POOL, not the page.
//        -> floor 2: 0.5% of the pool total.
//
// MEASURED (scratch simulation, July-shaped 52,349-listing pool, pageSize 35, the two bases
// given independently perturbed orderings): on a cleanly sorted pool the estimator is EXACT and
// every band excess is negative. Healthy excesses climb to +102 at 7 days of ordering
// perturbation and +140 at 14 days. A one-page tolerance (35) withheld the basis on healthy
// data in 2 of 15 trials — i.e. the second basis would have been withheld most months, and the
// whole exact-second-hand feature would silently never have appeared. max(4·pageSize, 0.5%) =
// 262 on that pool leaves ~1.9× margin over the worst observed healthy case while still being
// only ~15% of the thinnest real band (18-24mo, ~3.3% of pool), so a genuine contradiction is
// still caught.
function secondhandBandTolerance(pageSize, poolTotal) {
  return Math.max(4 * (pageSize || 1), Math.round(0.005 * (poolTotal || 0)));
}

// BAND-SUBSET INVARIANT, ENFORCED AT RUN TIME.
// The two bases come from two INDEPENDENT bisections, each carrying up to ±pageSize of error,
// so a thin band can come back LARGER in the filtered basis than in the all-listings one —
// which would imply a negative new-build count in that band. Within tolerance that is estimator
// noise: clamp to the all-listings band and say so on the row. Beyond it the two bisections
// genuinely disagree and the whole second basis is untrustworthy, so it is withheld.
// Returns { bands, clamped:[label], withhold:<reason|null> }; bands is null when withholding.
function reconcileSecondhandBands(bands, filteredBands, pageSize, poolTotal) {
  const out = filteredBands.slice();
  const clamped = [];
  const slack = Math.max(1, secondhandBandTolerance(pageSize, poolTotal));
  for (let k = 0; k < bands.length; k++) {
    const excess = filteredBands[k] - bands[k];
    if (excess <= 0) continue;
    if (excess > slack) {
      return {
        bands: null, clamped,
        withhold: `band ${BAND_KEYS[k]} is ${filteredBands[k]} in the 2nd-hand basis vs ${bands[k]} in the ` +
          `all-listings one — an excess of ${excess}, beyond the ${slack}-listing tolerance (4x page ${pageSize} / 0.5% of pool); the two bisections disagree`,
      };
    }
    out[k] = bands[k];
    clamped.push(`${BAND_KEYS[k]} (+${excess})`);
  }
  return { bands: out, clamped, withhold: null };
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
  filterApplied, secondhandBandTolerance, reconcileSecondhandBands,
  FILTER_MAX_NEWBUILD_RATE, FILTER_MIN_REMOVED_PCT, FILTER_MIN_FLAG_SAMPLE,
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

  // --- Second-hand basis validation (moved here from the two Booli scrapers) -------------
  // The scraper selftests exercise these end-to-end through run(); these are the unit-level
  // checks of the rules themselves, so a change to a threshold or a boundary fails here first.

  check('filterApplied: a real filter passes both signals', () => {
    // for-sale reality 2026-08-13: 56,493 -> 55,067 (2.62% removed), no new-builds left behind.
    const r = filterApplied({ unfilteredTotal: 56493, filteredTotal: 55067, cardsSeen: 600, newbuildSeen: 0 });
    assert.strictEqual(r.applied, true, r.reason);
    assert.ok(/removes 1426/.test(r.reason) && /2\.524%/.test(r.reason), r.reason);
  });

  check('filterApplied: VOLUME signal — an ignored filter returns the SAME pool, so the totals match', () => {
    // This is the case a `filtered > unfiltered` guard cannot see: Booli ignores the parameter,
    // serves the unfiltered pool, and its page 1 reports the unfiltered total. Equal totals.
    const same = filterApplied({ unfilteredTotal: 31602, filteredTotal: 31602, cardsSeen: 600, newbuildSeen: 0 });
    assert.strictEqual(same.applied, false, 'removing 0 listings is not a filter');
    assert.ok(/IGNORED/.test(same.reason) && /removes 0 \(0\.000%/.test(same.reason), same.reason);
    // …and pool drift between the two page-1 reads pushes it either way by a listing or two.
    for (const [f, label] of [[31600, 'drift +2'], [31604, 'drift -2']]) {
      const r = filterApplied({ unfilteredTotal: 31602, filteredTotal: f, cardsSeen: 600, newbuildSeen: 0 });
      assert.strictEqual(r.applied, false, `${label}: still under the 0.1% floor`);
      assert.ok(/IGNORED/.test(r.reason), r.reason);
    }
    // A genuine 0.59% removal (pre-market reality) is above the floor and passes.
    assert.strictEqual(filterApplied({ unfilteredTotal: 31602, filteredTotal: 31418, cardsSeen: 600, newbuildSeen: 0 }).applied, true);
  });

  check('filterApplied: FLAG signal — cards still flagged new-build mean the filter did not apply', () => {
    // Volume looks plausible (5% "removed") but the stream still serves new-builds.
    const lying = filterApplied({ unfilteredTotal: 2000, filteredTotal: 1900, cardsSeen: 600, newbuildSeen: 26 });
    assert.strictEqual(lying.applied, false, '4.33% of cards flagged new-build is not a filtered stream');
    assert.ok(/IGNORED/.test(lying.reason) && /flagged new-build/.test(lying.reason), lying.reason);
    // Either signal alone is disqualifying, so both notes quote both signals.
    assert.ok(/removes 100/.test(lying.reason), 'the volume figure is reported even when the flag tripped');
    // Just under the 0.5% threshold is tolerated (a working filter can leave a stray).
    assert.strictEqual(filterApplied({ unfilteredTotal: 2000, filteredTotal: 1900, cardsSeen: 600, newbuildSeen: 2 }).applied, true);
    // Below the sample floor the flag cannot judge — it must not trip on 1 card out of 35.
    const tiny = filterApplied({ unfilteredTotal: 2000, filteredTotal: 1900, cardsSeen: 35, newbuildSeen: 5 });
    assert.strictEqual(tiny.applied, true, 'a 35-card sample cannot condemn the stream');
    assert.ok(/too small to judge/.test(tiny.reason), tiny.reason);
  });

  check('filterApplied: a missing total on either side is never compared, it is reported', () => {
    for (const args of [{ unfilteredTotal: 3000, filteredTotal: null }, { unfilteredTotal: null, filteredTotal: 2969 }]) {
      const r = filterApplied(args);
      assert.strictEqual(r.applied, false);
      assert.ok(/no headline total to compare/.test(r.reason), r.reason);
    }
  });

  check('secondhandBandTolerance: takes the LARGER of 4x pageSize and 0.5% of the pool', () => {
    assert.strictEqual(secondhandBandTolerance(35, 3000), 140, '4 x page wins on a small pool (140 > 15)');
    assert.strictEqual(secondhandBandTolerance(20, 2000), 80, '4 x page wins again (80 > 10)');
    assert.strictEqual(secondhandBandTolerance(35, 52349), 262, '0.5% of pool wins on the real FS pool (262 > 140)');
    assert.strictEqual(secondhandBandTolerance(35, 31602), 158, '0.5% of pool wins on the real PM pool (158 > 140)');
    // The crossover between the two terms sits where 0.005 x pool == 4 x pageSize.
    assert.strictEqual(secondhandBandTolerance(35, 28000), 140, 'just below the crossover');
    assert.strictEqual(secondhandBandTolerance(35, 28400), 142, 'just above it');
    // Degenerate input must not produce 0 tolerance (that would withhold on any excess at all).
    assert.ok(secondhandBandTolerance(0, 0) >= 1);
    assert.ok(secondhandBandTolerance(undefined, undefined) >= 1);
  });

  check('reconcileSecondhandBands: a genuine subset passes through untouched', () => {
    const all = [100, 50, 20, 10, 5, 3, 2000];
    const r = reconcileSecondhandBands(all, [90, 45, 18, 9, 4, 2, 1800], 35, 3000);
    assert.deepStrictEqual(r.bands, [90, 45, 18, 9, 4, 2, 1800]);
    assert.deepStrictEqual(r.clamped, []);
    assert.strictEqual(r.withhold, null);
    // An EQUAL band is not an excess — a band with no new-builds in it is legitimate.
    const eq = reconcileSecondhandBands(all, all.slice(), 35, 3000);
    assert.deepStrictEqual(eq.clamped, []);
    assert.strictEqual(eq.withhold, null);
  });

  check('reconcileSecondhandBands: the clamp/withhold boundary sits exactly at the tolerance', () => {
    // pageSize 35, pool 3000 -> tolerance 140. Probe either side of it, and ON it.
    const all = [1000, 500, 200, 100, 50, 30, 2000];
    const at = reconcileSecondhandBands(all, [1000, 500, 200, 100, 50, 30 + 140, 2000], 35, 3000);
    assert.strictEqual(at.withhold, null, 'an excess EQUAL to the tolerance clamps, it does not withhold');
    assert.strictEqual(at.bands[5], 30, 'and the band is pulled back to the all-listings value');
    assert.deepStrictEqual(at.clamped, ['m18_24 (+140)']);

    const over = reconcileSecondhandBands(all, [1000, 500, 200, 100, 50, 30 + 141, 2000], 35, 3000);
    assert.strictEqual(over.bands, null, 'one listing past the tolerance withholds the whole basis');
    assert.ok(/m18_24/.test(over.withhold) && /disagree/.test(over.withhold), over.withhold);
    assert.ok(/beyond the 140-listing tolerance/.test(over.withhold), over.withhold);
  });

  check('reconcileSecondhandBands: withholding is all-or-nothing, and names the first bad band', () => {
    const all = [100, 50, 20, 10, 5, 3, 2000];
    // le1m is fine, m1_3 is over: the whole basis goes, not just that band.
    const r = reconcileSecondhandBands(all, [90, 50 + 500, 20, 10, 5, 3, 1800], 35, 3000);
    assert.strictEqual(r.bands, null);
    assert.ok(/band m1_3/.test(r.withhold), r.withhold);
  });

  check('reconcileSecondhandBands: REAL pool geometry — measured noise clamps, contradiction withholds', () => {
    // July-shaped for-sale pool. Simulation showed healthy band excesses reaching +140 once the
    // two bases see independently perturbed orderings, so +200 must be treated as noise. Under
    // the earlier one-page (35) rule it withheld — which would have suppressed the second basis
    // most months and made the whole exact-second-hand feature invisible.
    const ALL = [26436, 11307, 4136, 3246, 2251, 1728, 3246];
    const noisy = reconcileSecondhandBands(ALL, [25750, 11507, 4021, 3148, 2192, 1692, 3153], 35, 52349);
    assert.strictEqual(noisy.withhold, null, `+200 on a 52k pool is bisection noise: ${noisy.withhold}`);
    assert.deepStrictEqual(noisy.clamped, ['m1_3 (+200)']);
    assert.strictEqual(noisy.bands[1], 11307, 'clamped down to the all-listings band');
    // +300 is past the 262 tolerance and is a real disagreement.
    const bad = reconcileSecondhandBands(ALL, [25750, 11607, 4021, 3148, 2192, 1692, 3153], 35, 52349);
    assert.strictEqual(bad.bands, null, '+300 is past the 262 tolerance');
  });

  check('reconcileSecondhandBands: never mutates the caller\'s arrays', () => {
    const all = [100, 50, 20, 10, 5, 3, 2000];
    const filtered = [100, 50, 20, 10, 8, 3, 1800];
    const allCopy = all.slice(), filteredCopy = filtered.slice();
    reconcileSecondhandBands(all, filtered, 35, 3000);
    assert.deepStrictEqual(all, allCopy, 'all-listings bands must be left alone');
    assert.deepStrictEqual(filtered, filteredCopy, 'filtered bands must be left alone');
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
