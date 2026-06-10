// lib/spotcheck-adjudicate.js
//
// Pure per-pair verdict logic for the cohort-match spot-check weekly QA gate.
// No DB, no network — deterministic transform over already-fetched in-memory
// records. Mode B vision results are INJECTED as a parameter, never imported
// here, keeping this module testable and side-effect-free.
//
// Confirmation rule (COHORT-SPOTCHECK.md §3 + 12-CONTEXT.md §Photo confirmation):
//
//   price agrees  ⟺  deltas.price_pct_diff != null && deltas.price_pct_diff <= 0.05
//   hasPhotos     ⟺  photos.hemnet_gallery.length > 0 && photos.booli_gallery.length > 0
//
//   CONFIRMED_MATCH    : price agrees AND ≥1 shared photo (Mode B)
//                        OR price agrees AND hasPhotos AND provisional==='likely-match' (Mode A)
//   CONFIRMED_MISMATCH : provisional==='suspect' AND shared photo is explicitly false (Mode B)
//   UNCERTAIN          : no photos, or no vision, or unresolvable
//
//   Price alone NEVER confirms a match. Logic is asymmetric: one shared photo
//   confirms; a mismatch needs field divergence (triage=suspect) PLUS no shared photo.
//
// Usage:
//   const { adjudicatePair, adjudicatePairs } = require('./lib/spotcheck-adjudicate');
//   node lib/spotcheck-adjudicate.js --smoke

'use strict';

// ---------------------------------------------------------------
// adjudicatePair(record, { visionResult } = {})
//
//   record       — one element from artifact.pairs (post-photos enrichment):
//                  { pair_id, county, provisional, deltas, photos, ... }
//   visionResult — optional Mode B result: { sharedPhoto: true|false, ... }
//                  Omit (or pass undefined) for Mode A (deterministic only).
//
// Returns { verdict, source, reason } where verdict is one of:
//   'CONFIRMED_MATCH' | 'CONFIRMED_MISMATCH' | 'UNCERTAIN'
//
// Decision order — first match wins:
//   1. priceAgrees && sharedPhoto === true   → CONFIRMED_MATCH / 'mode-b-vision'
//   2. priceAgrees && hasPhotos && provisional==='likely-match' && sharedPhoto==null
//                                            → CONFIRMED_MATCH / 'deterministic'
//   3. provisional==='suspect' && sharedPhoto===false
//                                            → CONFIRMED_MISMATCH / 'mode-b-vision'
//   4. !hasPhotos                            → UNCERTAIN / 'no-photos'
//   5. otherwise                             → UNCERTAIN / 'no-vision'
// ---------------------------------------------------------------
function adjudicatePair(record, { visionResult } = {}) {
  const r = record || {};
  const d = r.deltas || {};
  const photos = r.photos || {};

  // --- core signals (guard every field access) ---
  const priceAgrees =
    d.price_pct_diff != null && d.price_pct_diff <= 0.05;

  const hasPhotos =
    (photos.hemnet_gallery?.length > 0) && (photos.booli_gallery?.length > 0);

  // sharedPhoto: true (confirmed shared), false (confirmed no shared), null (not run / inconclusive)
  const sharedPhoto = visionResult != null ? (visionResult.sharedPhoto ?? null) : null;

  const provisional = r.provisional; // 'suspect' | 'low-signal' | 'likely-match'

  // --- decision tree (first match wins) ---

  // 1. Mode B vision says same place + price agrees
  if (priceAgrees && sharedPhoto === true) {
    return {
      verdict: 'CONFIRMED_MATCH',
      source: 'mode-b-vision',
      reason: 'price agrees + vision found shared photo',
    };
  }

  // 2. Mode A deterministic promote: price agrees, both galleries present, triage says likely-match
  //    sharedPhoto must be null (not run) — never auto-promote if vision ran and found no match
  if (priceAgrees && hasPhotos && provisional === 'likely-match' && sharedPhoto == null) {
    return {
      verdict: 'CONFIRMED_MATCH',
      source: 'deterministic',
      reason: 'price agrees + likely-match + photos present (deterministic promote)',
    };
  }

  // 3. Mode B vision says NOT the same place + triage also flags suspect
  if (provisional === 'suspect' && sharedPhoto === false) {
    return {
      verdict: 'CONFIRMED_MISMATCH',
      source: 'mode-b-vision',
      reason: 'suspect triage + vision found no shared photo',
    };
  }

  // 4. No photos available at all — cannot confirm or deny
  if (!hasPhotos) {
    return {
      verdict: 'UNCERTAIN',
      source: 'no-photos',
      reason: 'no photo galleries available to evaluate',
    };
  }

  // 5. Photos available but vision not run (Mode A) and not deterministically promotable
  return {
    verdict: 'UNCERTAIN',
    source: 'no-vision',
    reason: 'photos present but vision not run and not deterministically promotable',
  };
}

// ---------------------------------------------------------------
// adjudicatePairs(records, { visionResults } = {})
//
//   records      — array of pair records (post-photos enrichment)
//   visionResults — optional map of pair_id → { sharedPhoto, ... } from Mode B
//
// Mutates each record in-place, attaching:
//   record.verdict         — 'CONFIRMED_MATCH' | 'CONFIRMED_MISMATCH' | 'UNCERTAIN'
//   record.verdict_source  — which branch fired
//   record.verdict_reason  — human-readable explanation
//
// Returns the same array (mutated).
// ---------------------------------------------------------------
function adjudicatePairs(records, { visionResults } = {}) {
  const arr = records || [];
  for (const record of arr) {
    const visionResult = visionResults ? (visionResults[record.pair_id] ?? undefined) : undefined;
    const { verdict, source, reason } = adjudicatePair(record, { visionResult });
    record.verdict = verdict;
    record.verdict_source = source;
    record.verdict_reason = reason;
  }
  return arr;
}

module.exports = { adjudicatePair, adjudicatePairs };

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

  // Helper to build a minimal record
  function rec(overrides) {
    return Object.assign({
      pair_id: 1,
      county: 'Stockholm',
      provisional: 'likely-match',
      deltas: { price_pct_diff: 0.03, area_pct_diff: 0.01 },
      photos: {
        hemnet_gallery: [{ file: 'h1.jpg', label: 'hero' }],
        booli_gallery:  [{ file: 'b1.jpg', label: 'hero' }],
      },
    }, overrides);
  }

  // --- Branch 1: Mode B vision confirms shared photo + price agrees ---
  check('mode-b-vision CONFIRMED_MATCH (sharedPhoto=true, priceAgrees)', () => {
    const r = rec({ provisional: 'likely-match', deltas: { price_pct_diff: 0.02 } });
    const result = adjudicatePair(r, { visionResult: { sharedPhoto: true } });
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH');
    assert.strictEqual(result.source, 'mode-b-vision');
  });

  // --- Branch 2: Mode A deterministic promote ---
  check('deterministic CONFIRMED_MATCH (price agrees, likely-match, photos, no vision)', () => {
    // pair 15647 analog: area gap alone but price agrees — should promote
    const r = rec({
      provisional: 'likely-match',
      deltas: { price_pct_diff: 0.0, area_pct_diff: 0.15 }, // area gap, price exact
    });
    const result = adjudicatePair(r); // no visionResult → Mode A
    assert.strictEqual(result.verdict, 'CONFIRMED_MATCH');
    assert.strictEqual(result.source, 'deterministic');
  });

  // --- Branch 3: Mode B CONFIRMED_MISMATCH ---
  check('mode-b-vision CONFIRMED_MISMATCH (suspect + sharedPhoto=false)', () => {
    // pair 16347 analog: area+price both diverge → suspect; vision found no shared photo
    const r = rec({
      pair_id: 16347,
      provisional: 'suspect',
      deltas: { price_pct_diff: 0.16, area_pct_diff: 0.17 },
    });
    const result = adjudicatePair(r, { visionResult: { sharedPhoto: false } });
    assert.strictEqual(result.verdict, 'CONFIRMED_MISMATCH');
    assert.strictEqual(result.source, 'mode-b-vision');
  });

  // --- Branch 4: no photos → UNCERTAIN ---
  check('no-photos UNCERTAIN', () => {
    const r = rec({
      photos: { hemnet_gallery: [], booli_gallery: [] },
    });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'no-photos');
  });

  // --- Branch 4b: missing photos object entirely → UNCERTAIN ---
  check('missing photos object → UNCERTAIN (no-photos)', () => {
    const r = rec({ photos: undefined });
    const result = adjudicatePair(r);
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'no-photos');
  });

  // --- Branch 5: photos present, no vision, not deterministically promotable ---
  check('no-vision UNCERTAIN (suspect + no vision run)', () => {
    const r = rec({
      provisional: 'suspect',
      deltas: { price_pct_diff: 0.20 }, // price NOT agreeing
    });
    const result = adjudicatePair(r); // no visionResult → Mode A
    assert.strictEqual(result.verdict, 'UNCERTAIN');
    assert.strictEqual(result.source, 'no-vision');
  });

  // --- Price agrees but suspect AND no vision → UNCERTAIN (price alone never auto-promotes) ---
  check('price agrees + suspect + no vision → UNCERTAIN (not auto-MATCH)', () => {
    const r = rec({
      provisional: 'suspect',
      deltas: { price_pct_diff: 0.02 }, // price agrees, but triage said suspect
    });
    const result = adjudicatePair(r); // no visionResult → Mode A
    // Must NOT be CONFIRMED_MATCH — price alone never confirms
    assert.notStrictEqual(result.verdict, 'CONFIRMED_MATCH');
    assert.strictEqual(result.verdict, 'UNCERTAIN');
  });

  // --- Vision ran but found no shared photo + suspect — still CONFIRMED_MISMATCH ---
  check('suspect + sharedPhoto=false → CONFIRMED_MISMATCH regardless of price', () => {
    const r = rec({
      provisional: 'suspect',
      deltas: { price_pct_diff: 0.01 }, // price agrees, but area/type diverge → suspect
    });
    const result = adjudicatePair(r, { visionResult: { sharedPhoto: false } });
    assert.strictEqual(result.verdict, 'CONFIRMED_MISMATCH');
  });

  // --- Vision found shared photo but price does NOT agree → UNCERTAIN (price gate)
  //     (branch 1 requires priceAgrees; without it falls through) ---
  check('sharedPhoto=true but price gap → UNCERTAIN (no-vision fallback)', () => {
    const r = rec({
      provisional: 'likely-match',
      deltas: { price_pct_diff: 0.20 }, // price does NOT agree
    });
    const result = adjudicatePair(r, { visionResult: { sharedPhoto: true } });
    // Branch 1 skipped (no priceAgrees); branch 2 skipped (no priceAgrees);
    // branch 3 skipped (not suspect); branch 4 skipped (has photos);
    // falls to branch 5: UNCERTAIN/no-vision
    assert.strictEqual(result.verdict, 'UNCERTAIN');
  });

  // --- adjudicatePairs mutates and returns same array ---
  check('adjudicatePairs mutates records in place', () => {
    const records = [
      rec({ pair_id: 10, provisional: 'likely-match', deltas: { price_pct_diff: 0.01 } }),
      rec({ pair_id: 11, provisional: 'suspect', deltas: { price_pct_diff: 0.25 }, photos: { hemnet_gallery: [], booli_gallery: [] } }),
    ];
    const out = adjudicatePairs(records);
    assert.strictEqual(out, records); // same reference
    assert.strictEqual(records[0].verdict, 'CONFIRMED_MATCH');
    assert.strictEqual(records[0].verdict_source, 'deterministic');
    assert.strictEqual(records[1].verdict, 'UNCERTAIN');
    assert.strictEqual(records[1].verdict_source, 'no-photos');
  });

  // --- adjudicatePairs with visionResults map ---
  check('adjudicatePairs routes visionResults by pair_id', () => {
    const records = [
      rec({ pair_id: 20, provisional: 'suspect', deltas: { price_pct_diff: 0.15 } }),
      rec({ pair_id: 21, provisional: 'likely-match', deltas: { price_pct_diff: 0.02 } }),
    ];
    const visionResults = {
      20: { sharedPhoto: false },
    };
    adjudicatePairs(records, { visionResults });
    assert.strictEqual(records[0].verdict, 'CONFIRMED_MISMATCH');
    assert.strictEqual(records[1].verdict, 'CONFIRMED_MATCH'); // pair 21: no vision → deterministic
  });

  // --- Null/undefined guards: missing deltas → no crash, UNCERTAIN ---
  check('missing deltas → UNCERTAIN, no crash', () => {
    const r = { pair_id: 99, provisional: 'suspect', photos: { hemnet_gallery: [{ file: 'x' }], booli_gallery: [{ file: 'y' }] } };
    const result = adjudicatePair(r);
    assert.ok(['UNCERTAIN', 'CONFIRMED_MATCH', 'CONFIRMED_MISMATCH'].includes(result.verdict));
  });

  // --- Null price_pct_diff → priceAgrees=false → cannot reach branch 1 or 2 ---
  check('null price_pct_diff → priceAgrees=false → no CONFIRMED_MATCH via deterministic', () => {
    const r = rec({
      provisional: 'likely-match',
      deltas: { price_pct_diff: null },
    });
    const result = adjudicatePair(r);
    assert.notStrictEqual(result.verdict, 'CONFIRMED_MATCH');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
