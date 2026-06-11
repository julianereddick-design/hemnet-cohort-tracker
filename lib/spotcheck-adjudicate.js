// lib/spotcheck-adjudicate.js
//
// Pure per-pair verdict logic for the cohort-match spot-check weekly QA gate.
// No DB, no network — deterministic transform over already-fetched in-memory
// records. Mode B vision results and dHash results are INJECTED as parameters,
// never imported here, keeping this module testable and side-effect-free.
//
// PHASE 14 IDENTITY MODEL (14-CONTEXT.md D-02/D-03/D-04/D-05/D-08/D-09):
// the matcher (cohort-create) pairs on BUILDING-level identity only (postcode +
// street + ±7d). This adjudicator adds the WITHIN-BUILDING discrimination the
// matcher never had. Default verdict is UNCERTAIN — confirmation must be earned.
//
//   Unit-level signals (identify a unit within a building):
//     feeMatch     — exact-kr monthly fee equality (hemnet_unit.fee == booli_unit.rent)
//     photoShared  — dHash found >= N distinct shared scenes after excluding
//                    floorplans/renders (dhashResult.confirmed, computed by gate)
//     visionShared — Claude vision confirmed same property (visionResult.sharedPhoto)
//   Supporting (building-level) signals — can corroborate, NEVER confirm alone:
//     priceAgrees (<=5%), areaAgrees (<=7%)
//   Contradiction signals (any one = different unit):
//     feeContradict, floorContradict (floor can contradict, never confirm — two
//     units often share a floor), familyMismatch (apt vs house, only when price
//     also diverges — D-03 guard), bothFieldGap (price>12% AND area>7%, the
//     pair-16347 case)
//
//   CONFIRMED_MATCH    : >=1 unit-level signal AND >=2 total supporting signals
//   CONFIRMED_MISMATCH : any contradiction signal, UNLESS photo evidence says
//                        same property (shared photo proves identity; field
//                        divergence is then data noise -> UNCERTAIN+conflict)
//   UNCERTAIN          : everything else (insufficient evidence; price alone
//                        NEVER confirms — D-09)
//
//   D-04: a MATCH whose photos LOOK different (high dHash minDist, no shared
//   scene) carries a `challenge` field so the gate can surface it instead of
//   silently discarding the disagreement.
//
// Usage:
//   const { adjudicatePair, adjudicatePairs } = require('./lib/spotcheck-adjudicate');
//   node lib/spotcheck-adjudicate.js --smoke

'use strict';

// Thresholds (see 14-CONTEXT.md; FEE_TOLERANCE_KR=0 means exact-kr equality —
// recalibrate from probe near-miss data if real cross-platform rounding shows up)
const PRICE_AGREE_PCT = 0.05;
const AREA_AGREE_PCT = 0.07;
const PRICE_GAP_PCT = 0.12;
const FEE_TOLERANCE_KR = 0;

// ---------------------------------------------------------------
// deriveSignals(record, visionResult, dhashResult) — pure signal extraction.
// Exported for the probe/report tooling so signal logic is defined ONCE.
// ---------------------------------------------------------------
function deriveSignals(record, visionResult, dhashResult) {
  const r = record || {};
  const d = r.deltas || {};
  const photos = r.photos || {};
  const hu = r.hemnet_unit || {};
  const bu = r.booli_unit || {};

  const priceAgrees = d.price_pct_diff != null && d.price_pct_diff <= PRICE_AGREE_PCT;
  const areaAgrees = d.area_pct_diff != null && d.area_pct_diff <= AREA_AGREE_PCT;

  const feeBoth = hu.fee != null && bu.rent != null;
  const feeMatch = feeBoth && Math.abs(hu.fee - bu.rent) <= FEE_TOLERANCE_KR;
  const feeContradict = feeBoth && Math.abs(hu.fee - bu.rent) > FEE_TOLERANCE_KR;

  // Floor tolerance ±0.5: Booli reports half-floors (halvtrappa, e.g. 0.5 / 1.5)
  // where Hemnet rounds — probe W23 showed 4 of 5 floor "disagreements" among
  // fee-exact true matches were exactly this convention gap.
  const floorBoth = hu.floor != null && bu.floor != null;
  const floorContradict = floorBoth && Math.abs(hu.floor - bu.floor) > 0.5;

  const familyMismatch = d.family_match === false;
  const bothFieldGap =
    d.price_pct_diff != null && d.price_pct_diff > PRICE_GAP_PCT &&
    d.area_pct_diff != null && d.area_pct_diff > AREA_AGREE_PCT;

  const hasPhotos = (photos.hemnet_gallery?.length > 0) && (photos.booli_gallery?.length > 0);
  const photoShared = dhashResult != null && dhashResult.confirmed === true;
  const sharedPhoto = visionResult != null ? (visionResult.sharedPhoto ?? null) : null;

  return {
    priceAgrees, areaAgrees,
    feeBoth, feeMatch, feeContradict,
    floorBoth, floorContradict,
    familyMismatch, bothFieldGap,
    hasPhotos, photoShared, visionShared: sharedPhoto,
    fees: feeBoth ? { hemnet: hu.fee, booli: bu.rent } : null,
    floors: floorBoth ? { hemnet: hu.floor, booli: bu.floor } : null,
  };
}

// ---------------------------------------------------------------
// adjudicatePair(record, { visionResult, dhashResult } = {})
//
//   record       — one element from artifact.pairs (post-photos enrichment):
//                  { pair_id, provisional, deltas, photos, hemnet_unit,
//                    booli_unit, isMultiUnit, ... }
//   visionResult — optional Mode B result: { sharedPhoto: true|false|null }
//   dhashResult  — optional gate-computed photo correspondence:
//                  { minDist, confirmed, sharedCount, threshold }
//                  confirmed = label-filtered distinct shared scenes >= needed
//
// Returns { verdict, source, reason, signals, challenge? } where verdict is:
//   'CONFIRMED_MATCH' | 'CONFIRMED_MISMATCH' | 'UNCERTAIN'
// ---------------------------------------------------------------
function adjudicatePair(record, { visionResult, dhashResult } = {}) {
  const s = deriveSignals(record, visionResult, dhashResult);

  const photoSaysSame = s.photoShared || s.visionShared === true;

  // --- 1a. HARD contradiction → CONFIRMED_MISMATCH ---
  // price+area both diverging (pair 16347) or family mismatch with diverging
  // price. Photo evidence of SAME property overrides (fields can be stale; an
  // identical non-floorplan photo can't be) → conflict instead of mismatch.
  // familyMismatch keeps the D-03 price guard.
  const hardContradiction =
    s.bothFieldGap ? 'price and area both diverge' :
    (s.familyMismatch && !s.priceAgrees) ? 'property family differs (apt vs house) and price diverges' :
    null;

  if (hardContradiction && !photoSaysSame) {
    return {
      verdict: 'CONFIRMED_MISMATCH',
      source: 'field-divergence',
      reason: hardContradiction,
      signals: s,
    };
  }

  // --- 1b. SOFT (unit-field) contradiction → UNCERTAIN conflict, human review ---
  // Fee/floor disagreement is the different-unit SIGNATURE but NOT proof: the
  // W23 probe found believed-true matches with fee drift (one platform showing
  // a pre-revision fee — incl. regression pair 15647 at 5208 vs 4356) and a
  // recurring Booli≈80%-of-Hemnet cluster. These pairs must NEVER silently
  // confirm AND never auto-remove — they go to a human with the numbers shown.
  const softContradiction =
    s.feeContradict ? `fee differs (Hemnet ${s.fees.hemnet} kr vs Booli ${s.fees.booli} kr)` :
    s.floorContradict ? `floor differs (Hemnet ${s.floors.hemnet} vs Booli ${s.floors.booli})` :
    null;

  if (hardContradiction || softContradiction) {
    return {
      verdict: 'UNCERTAIN',
      source: 'conflict',
      reason: photoSaysSame
        ? `photo evidence says same property BUT ${hardContradiction || softContradiction} — needs human review`
        : `${hardContradiction || softContradiction} — possible different unit, needs human review`,
      signals: s,
    };
  }

  // --- 2. Unit-level confirmation → CONFIRMED_MATCH ---
  // Needs >=1 unit-level signal (fee exact / shared photo / vision) and >=2
  // supporting signals total. Price+area alone NEVER confirm (no unit-level
  // signal — this is what makes multi-unit addresses safe by construction).
  const unitSignals = [
    s.feeMatch && 'fee-exact',
    s.photoShared && `dhash-shared×${dhashResult ? dhashResult.sharedCount : '?'}`,
    s.visionShared === true && 'vision-shared',
  ].filter(Boolean);
  const supportSignals = [
    s.priceAgrees && 'price',
    s.areaAgrees && 'area',
  ].filter(Boolean);

  if (unitSignals.length >= 1 && unitSignals.length + supportSignals.length >= 2) {
    const result = {
      verdict: 'CONFIRMED_MATCH',
      source: s.feeMatch ? 'unit-fields' : (s.photoShared ? 'dhash' : 'mode-b-vision'),
      reason: `unit-level: ${unitSignals.join(' + ')}; supporting: ${supportSignals.join(' + ') || 'none'}`,
      signals: s,
    };
    // D-04: photos disagree with a non-photo confirmation → visible challenge,
    // never silently discarded. (dHash ran, found nothing shared, distance high.)
    if (!s.photoShared && s.visionShared !== true && dhashResult &&
        dhashResult.minDist > (dhashResult.threshold ?? 6)) {
      result.challenge = `dhash-high-distance (minDist=${dhashResult.minDist})`;
    }
    return result;
  }

  // --- 3. Insufficient evidence → UNCERTAIN ---
  if (!s.hasPhotos) {
    return {
      verdict: 'UNCERTAIN',
      source: 'no-photos',
      reason: 'no photo galleries available and no unit-level field evidence',
      signals: s,
    };
  }
  return {
    verdict: 'UNCERTAIN',
    source: 'insufficient-evidence',
    reason: 'no unit-level signal (fee/shared-photo/vision) — price alone never confirms',
    signals: s,
  };
}

// ---------------------------------------------------------------
// adjudicatePairs(records, { visionResults, dhashResults } = {})
//
//   records       — array of pair records (post-photos enrichment)
//   visionResults — optional map pair_id → { sharedPhoto, ... } (Mode B)
//   dhashResults  — optional map pair_id → { minDist, confirmed, sharedCount, threshold }
//
// Mutates each record in-place, attaching verdict / verdict_source /
// verdict_reason / verdict_challenge (when D-04 fires). Returns the array.
// ---------------------------------------------------------------
function adjudicatePairs(records, { visionResults, dhashResults } = {}) {
  const arr = records || [];
  for (const record of arr) {
    const visionResult = visionResults ? (visionResults[record.pair_id] ?? undefined) : undefined;
    const dhashResult = dhashResults ? (dhashResults[record.pair_id] ?? undefined) : undefined;
    const { verdict, source, reason, challenge } = adjudicatePair(record, { visionResult, dhashResult });
    record.verdict = verdict;
    record.verdict_source = source;
    record.verdict_reason = reason;
    if (challenge) record.verdict_challenge = challenge;
  }
  return arr;
}

module.exports = { adjudicatePair, adjudicatePairs, deriveSignals, PRICE_AGREE_PCT, AREA_AGREE_PCT, FEE_TOLERANCE_KR };

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network).
//   node lib/spotcheck-adjudicate.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  function rec(overrides) {
    return Object.assign({
      pair_id: 1,
      county: 'Stockholm',
      provisional: 'likely-match',
      deltas: { price_pct_diff: 0.03, area_pct_diff: 0.01 },
      photos: {
        hemnet_gallery: [{ file: 'h1.jpg', label: null }],
        booli_gallery:  [{ file: 'b1.jpg', label: null }],
      },
    }, overrides);
  }
  const dhYes = { minDist: 2, confirmed: true, sharedCount: 2, threshold: 6 };
  const dhNo  = { minDist: 23, confirmed: false, sharedCount: 0, threshold: 6 };

  // --- Identity model: fee exact + price → MATCH (unit-fields) ---
  check('fee exact + price agrees → CONFIRMED_MATCH (unit-fields)', () => {
    const r = rec({ hemnet_unit: { fee: 4080 }, booli_unit: { rent: 4080 } });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH');
    assert.strictEqual(result.source, 'unit-fields');
  });

  // --- Fee contradiction catches a price-coincidence pair (Julian's nightmare case):
  //     routed to HUMAN REVIEW as a conflict (probe-validated: fee drift exists on
  //     true matches, so never auto-MISMATCH on fee alone — but never confirm either) ---
  check('same price, fee differs → UNCERTAIN conflict (caught, human reviews)', () => {
    const r = rec({ hemnet_unit: { fee: 5593 }, booli_unit: { rent: 4080 }, deltas: { price_pct_diff: 0.0, area_pct_diff: 0.0 } });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'conflict');
    assert.ok(/fee differs/.test(result.reason));
  });

  // --- Probe regression: 15647 fee drift (5208 vs 4356) on a believed-true match
  //     must NOT auto-MISMATCH — conflict review ---
  check('15647 fee-drift pair → UNCERTAIN conflict, never CONFIRMED_MISMATCH', () => {
    const r = rec({ pair_id: 15647, hemnet_unit: { fee: 5208 }, booli_unit: { rent: 4356 }, deltas: { price_pct_diff: 0.0, area_pct_diff: 0.18 } });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.notStrictEqual(result.verdict, 'CONFIRMED_MISMATCH');
  });

  // --- Halvtrappa: Booli half-floor (0.5) vs Hemnet 0 is NOT a contradiction ---
  check('floor 0 vs 0.5 (halvtrappa) → no contradiction', () => {
    const r = rec({ hemnet_unit: { fee: 4080, floor: 0 }, booli_unit: { rent: 4080, floor: 0.5 } });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH'); // fee exact + price
  });

  // --- dHash shared photos + price → MATCH ---
  check('dhash confirmed + price agrees → CONFIRMED_MATCH (dhash)', () => {
    const result = adjudicatePair(rec({}), { dhashResult: dhYes });
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH');
    assert.strictEqual(result.source, 'dhash');
  });

  // --- THE OLD BRANCH-2 FIG LEAF IS DEAD: price + photos-exist + likely-match alone → UNCERTAIN ---
  check('price agrees + galleries exist + likely-match but NO unit signal → UNCERTAIN (W1 fix)', () => {
    const result = adjudicatePair(rec({}), { dhashResult: dhNo });
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'insufficient-evidence');
  });

  // --- dHash can CHALLENGE (D-04): fee-confirmed but photos look different → flagged ---
  check('fee-confirmed MATCH with high dHash distance carries challenge (D-04)', () => {
    const r = rec({ hemnet_unit: { fee: 4080 }, booli_unit: { rent: 4080 } });
    const result = adjudicatePair(r, { dhashResult: dhNo });
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH');
    assert.ok(result.challenge && /dhash-high-distance/.test(result.challenge));
  });

  // --- Photo evidence overrides field contradiction → conflict UNCERTAIN, not MISMATCH ---
  check('shared photo + fee contradiction → UNCERTAIN conflict (photo wins, human reviews)', () => {
    const r = rec({ hemnet_unit: { fee: 5593 }, booli_unit: { rent: 4080 } });
    const result = adjudicatePair(r, { dhashResult: dhYes });
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'conflict');
  });

  // --- Floor contradicts (>0.5 apart) → conflict review (never confirms, never auto-mismatch) ---
  check('floor differs by 2 → UNCERTAIN conflict', () => {
    const r = rec({ hemnet_unit: { floor: 3 }, booli_unit: { floor: 1 } });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'conflict');
  });
  check('floor matches alone does NOT confirm (neighbours share floors)', () => {
    const r = rec({ hemnet_unit: { floor: 2 }, booli_unit: { floor: 2 } });
    const result = adjudicatePair(r, { dhashResult: dhNo });
    assert.strictEqual(result.verdict, 'UNCERTAIN');
  });

  // --- Vision still works: vision shared + price → MATCH ---
  check('vision sharedPhoto=true + price agrees → CONFIRMED_MATCH (mode-b-vision)', () => {
    const result = adjudicatePair(rec({}), { visionResult: { sharedPhoto: true } });
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH');
    assert.strictEqual(result.source, 'mode-b-vision');
  });

  // --- Vision shared but price gap → UNCERTAIN (1 unit signal, 0 support → needs 2 total) ---
  check('sharedPhoto=true but price gap and no other support → UNCERTAIN', () => {
    const r = rec({ deltas: { price_pct_diff: 0.20, area_pct_diff: null } });
    const result = adjudicatePair(r, { visionResult: { sharedPhoto: true } });
    assert.strictEqual(result.verdict, 'UNCERTAIN');
  });

  // --- D-03 regression — pair 15647: price agrees, area gap (boarea), vision found no shared photo
  //     → UNCERTAIN (never CONFIRMED_MISMATCH; bothFieldGap false because price agrees) ---
  check('15647 price-agreeing suspect + sharedPhoto=false → UNCERTAIN (not CONFIRMED_MISMATCH)', () => {
    const r = rec({ pair_id: 15647, provisional: 'suspect', deltas: { price_pct_diff: 0.0, area_pct_diff: 0.18 } });
    const result = adjudicatePair(r, { visionResult: { sharedPhoto: false } });
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.notStrictEqual(result.verdict, 'CONFIRMED_MISMATCH');
  });

  // --- D-03 regression — pair 16347: price diverges 16% + area 17% → CONFIRMED_MISMATCH ---
  check('16347 price+area both diverge → CONFIRMED_MISMATCH (field-divergence)', () => {
    const r = rec({ pair_id: 16347, provisional: 'suspect', deltas: { price_pct_diff: 0.16, area_pct_diff: 0.17 } });
    const result = adjudicatePair(r, { visionResult: { sharedPhoto: false } });
    assert.strictEqual(result.verdict, 'CONFIRMED_MISMATCH');
  });

  // --- Multi-unit safety emerges by construction: price+area agree at multi-unit, no unit signal → UNCERTAIN ---
  check('multi-unit address with only price+area agreement → UNCERTAIN (D-09)', () => {
    const r = rec({ isMultiUnit: true, deltas: { price_pct_diff: 0.0, area_pct_diff: 0.0 } });
    const result = adjudicatePair(r, { dhashResult: dhNo });
    assert.strictEqual(result.verdict, 'UNCERTAIN');
  });

  // --- No photos and no unit fields → UNCERTAIN no-photos ---
  check('no photos, no unit fields → UNCERTAIN (no-photos)', () => {
    const r = rec({ photos: { hemnet_gallery: [], booli_gallery: [] } });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'no-photos');
  });

  // --- Fee match works even with NO photos (delisted pages but fields captured) ---
  check('fee exact + price agrees with no galleries → CONFIRMED_MATCH', () => {
    const r = rec({ photos: { hemnet_gallery: [], booli_gallery: [] }, hemnet_unit: { fee: 3001 }, booli_unit: { rent: 3001 } });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH');
  });

  // --- Null guards ---
  check('missing deltas/units → no crash, UNCERTAIN', () => {
    const r = { pair_id: 99, provisional: 'suspect', photos: { hemnet_gallery: [{ file: 'x' }], booli_gallery: [{ file: 'y' }] } };
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'UNCERTAIN');
  });
  check('null price_pct_diff → no CONFIRMED_MATCH without unit signal', () => {
    const r = rec({ deltas: { price_pct_diff: null } });
    const result = adjudicatePair(r, { dhashResult: dhNo });
    assert.notStrictEqual(result.verdict, 'CONFIRMED_MATCH');
  });
  check('fee null on one side is NO signal (not match, not contradiction)', () => {
    const r = rec({ hemnet_unit: { fee: 4080 }, booli_unit: { rent: null } });
    const result = adjudicatePair(r, { dhashResult: dhNo });
    assert.strictEqual(result.verdict, 'UNCERTAIN');
  });

  // --- adjudicatePairs mutates + routes maps by pair_id ---
  check('adjudicatePairs routes vision + dhash maps and mutates in place', () => {
    const records = [
      rec({ pair_id: 20, hemnet_unit: { fee: 100 }, booli_unit: { rent: 100 } }),
      rec({ pair_id: 21 }),
      rec({ pair_id: 22 }),
    ];
    const out = adjudicatePairs(records, {
      visionResults: { 21: { sharedPhoto: true } },
      dhashResults: { 22: { minDist: 1, confirmed: true, sharedCount: 2, threshold: 6 } },
    });
    assert.strictEqual(out, records);
    assert.strictEqual(records[0].verdict, 'CONFIRMED_MATCH'); // fee
    assert.strictEqual(records[1].verdict, 'CONFIRMED_MATCH'); // vision
    assert.strictEqual(records[2].verdict, 'CONFIRMED_MATCH'); // dhash
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
