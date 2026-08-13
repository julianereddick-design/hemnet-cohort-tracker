'use strict';
// lib/premarket-quality.js — the Booli pre-market quality rubric.
// Pure functions, no I/O. Single source of truth for the rubric; the measure
// job and the weekly report both consume it.
//
// Rubric (Julian's definition): a quality pre-market listing has (1) an asking
// price that is not Booli's own AVM, (2) >=1 real interior photo, (3) a viewing
// date. See docs/superpowers/specs/2026-08-13-premarket-quality-weekly-design.md
//
// Self-test: node lib/premarket-quality.js --smoke

const { interiorVerdict, unknownLabels } = require('./booli-image-labels');

const WINDOW_DAYS = 7;

// The four-branch rule this whole measurement rests on. The search card caps
// images at 5, so it can only ever UNDERCOUNT interiors: three verdicts are safe,
// one needs the listing page opened.
//   >=1 interior label      -> genuine; more photos can't unfind it     (safe)
//   0 images                -> empty / broker withheld                  (safe)
//   1-4 images, no interior -> that IS the whole gallery                (safe)
//   >=5 images, no interior -> cap hit, could be 5 photos or 71     (AMBIGUOUS)
function bucketOf(verdict, nPhotos) {
  if (verdict === 'none') return 'zero_photos';
  if (verdict === 'yes') return 'has_interior';
  if (verdict === 'unknown') return 'unlabelled';
  return nPhotos >= 5 ? 'ambiguous' : 'no_interior_confirmed';
}

// Buckets that cannot be categorised from the card alone. `unlabelled` (images
// present, every label null) measured 0 in August but is included here so it can
// never silently fall out of the cohort.
const NEEDS_PAGE = new Set(['ambiguous', 'unlabelled']);

const INT = c => c.interiorVerdict === 'yes';
const P   = c => c.price != null;
const V   = c => c.nextShowing != null;

// Ordered best -> worst. Each listing falls in exactly one; `match` is evaluated
// in order, so the ladder is a partition by construction.
const LADDER = [
  { key: 'high',     label: 'High — interior + price + viewing',   rule: 'interior + price + viewing',        match: c => INT(c) && P(c) && V(c) },
  { key: 'mid_high', label: 'Mid-high — interior + viewing',       rule: 'interior + viewing, no price',      match: c => INT(c) && !P(c) && V(c) },
  { key: 'mid_sell', label: 'Mid — interior + price',              rule: 'interior + price, no viewing',      match: c => INT(c) && P(c) && !V(c) },
  { key: 'mid_fish', label: 'Mid — interior only ("fishing")',     rule: 'interior only',                     match: c => INT(c) && !P(c) && !V(c) },
  // Commitment signals but no interior photos — kept visible rather than folded
  // into Low, since a priced listing with a booked viewing is not filler.
  { key: 'other',    label: 'Other — no interior, priced/booked',  rule: 'no interior, but price or viewing', match: c => !INT(c) && (P(c) || V(c)) },
  { key: 'low',      label: 'Low — marketing filler',              rule: 'none of the three',                 match: () => true },
];

function categorise(c) {
  for (const r of LADDER) if (r.match(c)) return r.key;
  return 'low';
}

const round1 = n => Math.round(n * 10) / 10;

// Aggregate a categorised cohort into the premarket_quality_weekly row shape
// (provenance columns are added by the caller, which knows about pages/calls).
function tally(listings) {
  const n = listings.length;
  const counts = { high: 0, mid_high: 0, mid_sell: 0, mid_fish: 0, other: 0, low: 0 };
  let interior = 0, price = 0, avm = 0, viewing = 0, ambiguous = 0, resolved = 0;
  const unknown = new Set();

  for (const c of listings) {
    counts[categorise(c)]++;
    if (INT(c)) interior++;
    if (P(c)) price++;
    if (c.priceMissingAvmShown) avm++;
    if (V(c)) viewing++;
    if (NEEDS_PAGE.has(c.bucket)) {
      ambiguous++;
      if (c.resolved) resolved++;
    }
    for (const l of unknownLabels(c.cardLabels)) unknown.add(l);
  }

  const pct = x => (n ? round1(100 * x / n) : 0);
  return {
    n_total: n,
    ...counts,
    pct_interior: pct(interior),
    pct_price: pct(price),
    pct_avm_shown: pct(avm),
    pct_viewing: pct(viewing),
    n_ambiguous: ambiguous,
    n_resolved: resolved,
    n_unknown_labels: unknown.size,
    // The taxonomy-drift canary needs names, not just a count — an operator can't
    // act on "1 unknown label". Sorted for a stable, diffable report line.
    unknown_labels: Array.from(unknown).sort(),
  };
}

// The report table: cumulative counts best-first, plus Hemnet's single total
// expressed as a % of each cumulative rung. Cells above 100% render blank — the
// first row carrying a number IS the parity point.
function ladderRows(counts, hemnetAdds) {
  let cum = 0;
  return LADDER.map(r => {
    const n = counts[r.key] || 0;
    cum += n;
    const cumPct = counts.n_total ? Math.round(100 * cum / counts.n_total) : 0;
    let hemnetPct = null;
    if (hemnetAdds != null && cum > 0) {
      const p = 100 * hemnetAdds / cum;
      hemnetPct = p > 100 ? null : Math.round(p);
    }
    return { key: r.key, label: r.label, n, cumN: cum, cumPct, hemnetPct };
  });
}

module.exports = {
  WINDOW_DAYS, bucketOf, NEEDS_PAGE, LADDER, categorise, tally, ladderRows,
};

if (require.main === module && process.argv.includes('--smoke')) {
  smoke();
}

function smoke() {
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }
  };
  const eq = (a, b, m) => {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error(`${m || ''} expected ${B}, got ${A}`);
  };

  console.log('=== lib/premarket-quality.js --smoke ===');

  // --- bucketOf: the four-branch rule -------------------------------------
  check('bucketOf: no images -> zero_photos', () => eq(bucketOf('none', 0), 'zero_photos'));
  check('bucketOf: interior label -> has_interior', () => eq(bucketOf('yes', 5), 'has_interior'));
  check('bucketOf: all labels null -> unlabelled', () => eq(bucketOf('unknown', 3), 'unlabelled'));
  check('bucketOf: 4 images none interior -> confirmed', () => eq(bucketOf('no', 4), 'no_interior_confirmed'));
  check('bucketOf: exactly 5 none interior -> ambiguous', () => eq(bucketOf('no', 5), 'ambiguous'));
  check('bucketOf: 5-cap is >=5 not ==5', () => eq(bucketOf('no', 9), 'ambiguous'));

  // --- categorise: the six-rung ladder ------------------------------------
  const L = (interior, price, viewing) => ({
    interiorVerdict: interior ? 'yes' : 'no',
    price: price ? 3300000 : null,
    nextShowing: viewing ? '2026-08-18 12:00' : null,
  });
  check('categorise: interior+price+viewing -> high', () => eq(categorise(L(1, 1, 1)), 'high'));
  check('categorise: interior+viewing, no price -> mid_high', () => eq(categorise(L(1, 0, 1)), 'mid_high'));
  check('categorise: interior+price, no viewing -> mid_sell', () => eq(categorise(L(1, 1, 0)), 'mid_sell'));
  check('categorise: interior only -> mid_fish', () => eq(categorise(L(1, 0, 0)), 'mid_fish'));
  check('categorise: nothing -> low', () => eq(categorise(L(0, 0, 0)), 'low'));
  check('categorise: no interior but priced -> other', () => eq(categorise(L(0, 1, 0)), 'other'));
  check('categorise: no interior but viewing -> other', () => eq(categorise(L(0, 0, 1)), 'other'));

  // --- ladderRows: cumulative + Hemnet suppression -------------------------
  const counts = {
    n_total: 100, high: 10, mid_high: 10, mid_sell: 30, mid_fish: 30, other: 10, low: 10,
  };
  check('ladderRows: cumulative counts accumulate', () => {
    const r = ladderRows(counts, null);
    eq(r.map(x => x.cumN), [10, 20, 50, 80, 90, 100]);
  });
  check('ladderRows: cumulative pct rounds to 0dp', () => {
    const r = ladderRows(counts, null);
    eq(r.map(x => x.cumPct), [10, 20, 50, 80, 90, 100]);
  });
  check('ladderRows: hemnet cell blank above 100%', () => {
    // hemnet=40 vs cum 10 -> 400% (blank), vs cum 50 -> 80% (shown)
    const r = ladderRows(counts, 40);
    eq(r.map(x => x.hemnetPct), [null, null, 80, 50, 44, 40]);
  });
  check('ladderRows: hemnet null when adds unavailable', () => {
    const r = ladderRows(counts, null);
    eq(r.every(x => x.hemnetPct === null), true);
  });
  check('ladderRows: zero-total cohort does not divide by zero', () => {
    const r = ladderRows({ n_total: 0, high: 0, mid_high: 0, mid_sell: 0, mid_fish: 0, other: 0, low: 0 }, 5);
    eq(r.every(x => x.cumPct === 0 && x.hemnetPct === null), true);
  });

  // --- tally: DB row shape -------------------------------------------------
  check('tally: counts, signal rates and provenance', () => {
    const t = tally([
      { interiorVerdict: 'yes', price: 1, nextShowing: 1, priceMissingAvmShown: false, bucket: 'has_interior', cardLabels: {} },
      { interiorVerdict: 'yes', price: null, nextShowing: null, priceMissingAvmShown: true, bucket: 'has_interior', cardLabels: {} },
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false, bucket: 'no_interior_confirmed', cardLabels: {} },
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false, bucket: 'ambiguous', cardLabels: {}, resolved: true },
    ]);
    eq(t.n_total, 4);
    eq(t.high, 1);
    eq(t.mid_fish, 1);
    eq(t.low, 2);
    eq(t.pct_interior, 50.0);
    eq(t.pct_price, 25.0);
    eq(t.pct_avm_shown, 25.0);
    eq(t.pct_viewing, 25.0);
    eq(t.n_ambiguous, 1);
    eq(t.n_resolved, 1);
  });
  check('tally: unknown labels surface as the taxonomy canary', () => {
    const t = tally([
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false,
        bucket: 'no_interior_confirmed', cardLabels: { some_new_label: 2, facade: 1 } },
    ]);
    eq(t.n_unknown_labels, 1);
  });
  check('tally: unknown_labels names the drifted label(s), sorted, deduped', () => {
    const t = tally([
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false,
        bucket: 'no_interior_confirmed', cardLabels: { zeta_label: 1, alpha_label: 2, facade: 1 } },
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false,
        bucket: 'no_interior_confirmed', cardLabels: { alpha_label: 3 } },
    ]);
    eq(t.n_unknown_labels, 2);
    eq(t.unknown_labels, ['alpha_label', 'zeta_label']);
  });

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
