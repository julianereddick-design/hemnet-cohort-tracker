// lib/spotcheck-evidence.js
//
// Pure comparison logic for the cohort-pair spot-check (cohort-spotcheck.js).
// No DB, no network — every function here is a deterministic transform so it
// can be unit-tested via `node lib/spotcheck-evidence.js --smoke`.
//
// WHY THIS EXISTS: the matcher (cohort-create.js:116-135) pairs a Booli FS
// listing to a Hemnet listing on ONLY postcode + street_address + ±7-day listed
// window. It never looks at price, living area, or property type. Those are
// therefore *independent* signals we can use to sanity-check a match. Booli's
// price/area/type are stored in booli_listing; Hemnet's come back live by
// re-fetching the detail page (lib/hemnet-fetch.js parseActiveListing →
// askingPrice / livingArea / housingForm).
//
// IMPORTANT MODELLING CHOICES:
//   * A NULL field is "no signal", NEVER a mismatch. Pre-backfill booli_listing
//     rows can have NULL price/rooms/living_area/object_type.
//   * Living area is the strongest "same physical unit" invariant → tight
//     threshold. Price is weak (price cuts, asking-vs-accepted drift) → loose
//     threshold. Property *family* (apartment vs house) is a strong discriminator;
//     house-subtype differences (villa vs radhus) are a weak signal.
//   * Rooms is Booli-only — parseActiveListing exposes no rooms field — so it is
//     carried as descriptive context, not a delta. We do not invent a rooms match.

'use strict';

const { booliObjectTypeToHemnet } = require('./booli-to-hemnet-mapping');

// Thresholds. Above these, the per-field gap is flagged.
const AREA_PCT_THRESHOLD = 0.07;  // 7% — living area is near-invariant for a unit
const PRICE_PCT_THRESHOLD = 0.12; // 12% — price drifts on the same property

// ---------------------------------------------------------------
// Small numeric / string helpers
// ---------------------------------------------------------------

function finitePos(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

// Symmetric percentage difference relative to the smaller value.
// Returns null unless both inputs are finite positives.
function pctDiff(a, b) {
  if (!finitePos(a) || !finitePos(b)) return null;
  return Math.abs(a - b) / Math.min(a, b);
}

// Lowercase, trim, collapse internal whitespace. null/non-string → null.
function normStreet(s) {
  if (s == null || typeof s !== 'string') return null;
  const t = s.toLowerCase().trim().replace(/\s+/g, ' ');
  return t.length ? t : null;
}

// Strip everything but digits (Booli stores '176 71', Hemnet '17671', and the
// DB stores integers). null/empty → null.
function normPostcode(p) {
  if (p == null) return null;
  const digits = String(p).replace(/\D/g, '');
  return digits.length ? digits : null;
}

// ---------------------------------------------------------------
// Property-type categorisation
//
// Both Booli object_type (e.g. 'Lägenhet', 'Villa', 'Radhus') and Hemnet
// housingForm (e.g. 'Lägenhet', 'Villa', 'Radhus', 'Bostadsrätt') are free-ish
// Swedish strings from two different sites. We normalise BOTH to a coarse
// category by keyword, then compare. `family` rolls the house subtypes together
// so a villa-vs-radhus difference is not treated as strongly as apartment-vs-house.
// ---------------------------------------------------------------

// Returns one of: APARTMENT | VILLA | ROWHOUSE | VACATION | PLOT | FARM | OTHER | null
function typeCategory(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.toLowerCase();
  if (s.includes('lägenhet') || s.includes('lagenhet') || s.includes('bostadsrätt') || s.includes('bostadsratt') || s.includes('ägarlägenhet')) return 'APARTMENT';
  if (s.includes('radhus')) return 'ROWHOUSE';
  if (s.includes('kedjehus') || s.includes('parhus')) return 'ROWHOUSE'; // attached houses
  if (s.includes('villa')) return 'VILLA';
  if (s.includes('fritidshus')) return 'VACATION';
  if (s.includes('tomt') || s.includes('mark')) return 'PLOT';
  if (s.includes('gård') || s.includes('gard')) return 'FARM';
  return 'OTHER';
}

// Coarse family: collapses VILLA + ROWHOUSE into HOUSE. apartment-vs-house is
// the high-confidence "wrong property" signal; this is what `family_mismatch` uses.
function typeFamily(category) {
  if (category == null) return null;
  if (category === 'VILLA' || category === 'ROWHOUSE') return 'HOUSE';
  return category;
}

// ---------------------------------------------------------------
// computeDeltas — the independent-signal comparison
//
//   booli:  { price, living_area, object_type, street_address, postcode }
//   hemnet: { asking_price, living_area, housing_form, street_address, post_code }
//           (caller passes nulls when the Hemnet re-fetch was inactive/404)
//
// Returns a plain object of deltas; never throws.
// ---------------------------------------------------------------
function computeDeltas(booli, hemnet) {
  const b = booli || {};
  const h = hemnet || {};

  const booliCategory = typeCategory(b.object_type);
  const hemnetCategory = typeCategory(h.housing_form);

  let typeMatch = null;
  if (booliCategory != null && hemnetCategory != null) {
    typeMatch = booliCategory === hemnetCategory;
  }

  let familyMatch = null;
  const bFam = typeFamily(booliCategory);
  const hFam = typeFamily(hemnetCategory);
  if (bFam != null && hFam != null) {
    familyMatch = bFam === hFam;
  }

  const bStreet = normStreet(b.street_address);
  const hStreet = normStreet(h.street_address);
  const addressMatch = (bStreet != null && hStreet != null) ? bStreet === hStreet : null;

  const bPost = normPostcode(b.postcode);
  const hPost = normPostcode(h.post_code);
  const postcodeMatch = (bPost != null && hPost != null) ? bPost === hPost : null;

  return {
    price_pct_diff: pctDiff(b.price, h.asking_price),
    area_pct_diff: pctDiff(b.living_area, h.living_area),
    type_match: typeMatch,
    family_match: familyMatch,
    booli_category: booliCategory,
    hemnet_category: hemnetCategory,
    address_match: addressMatch,
    postcode_match: postcodeMatch,
  };
}

// ---------------------------------------------------------------
// classifyDeterministic — triage only (NOT the verdict)
//
// Produces a provisional bucket so the report can surface suspects first and so
// a future automated mode can gate API calls. The real MATCH/MISMATCH/UNCERTAIN
// verdict is rendered by Claude in-session.
//
//   record: { deltas, evidence, booli }
//     evidence: 'full' | 'partial' | 'none'
//
// Returns { provisional: 'suspect'|'low-signal'|'likely-match', flags: [...] }.
// ---------------------------------------------------------------
function classifyDeterministic(record) {
  const r = record || {};
  const d = r.deltas || {};
  const b = r.booli || {};
  const flags = [];

  if (r.evidence !== 'full') flags.push('hemnet_unavailable');

  if (d.area_pct_diff != null && d.area_pct_diff > AREA_PCT_THRESHOLD) flags.push('area_gap');
  if (d.price_pct_diff != null && d.price_pct_diff > PRICE_PCT_THRESHOLD) flags.push('price_gap');
  if (d.family_match === false) flags.push('family_mismatch');
  else if (d.type_match === false) flags.push('type_mismatch'); // subtype diff (weaker)
  if (d.address_match === false) flags.push('address_drift');
  if (d.postcode_match === false) flags.push('postcode_mismatch');

  const noBooliSignal = b.price == null && b.living_area == null && b.object_type == null;
  if (noBooliSignal) flags.push('booli_fields_null');

  // STRONG signals → suspect (most likely a wrong match). Per the boarea-vs-total
  // convention finding (pair 15647): an area gap ALONE, when price agrees, is
  // usually a measurement-convention difference on a TRUE match — so it does NOT
  // escalate. Area only escalates when price ALSO diverges (the genuine
  // different-unit case, pair 16347) or price is missing so it can't corroborate.
  // Family (apartment-vs-house) and postcode mismatches stay strong on their own.
  const priceGapOrUnknown = flags.includes('price_gap') || d.price_pct_diff == null;
  const strong = (flags.includes('area_gap') && priceGapOrUnknown)
    || flags.includes('family_mismatch')
    || flags.includes('postcode_mismatch');

  // Can we actually corroborate the match with at least one independent signal?
  const haveSignal = d.area_pct_diff != null || d.price_pct_diff != null || d.type_match != null;

  let provisional;
  if (strong) {
    provisional = 'suspect';
  } else if (!haveSignal) {
    provisional = 'low-signal'; // re-fetch failed and/or Booli fields null — cannot verify
  } else {
    provisional = 'likely-match';
  }

  return { provisional, flags };
}

module.exports = {
  AREA_PCT_THRESHOLD,
  PRICE_PCT_THRESHOLD,
  pctDiff,
  normStreet,
  normPostcode,
  typeCategory,
  typeFamily,
  computeDeltas,
  classifyDeterministic,
  booliObjectTypeToHemnet, // re-exported for convenience
};

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network).
//   node lib/spotcheck-evidence.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- pctDiff ---
  check('pctDiff equal → 0', () => assert.strictEqual(pctDiff(100, 100), 0));
  check('pctDiff 10% off smaller base', () => assert.ok(Math.abs(pctDiff(100, 110) - 0.1) < 1e-9));
  check('pctDiff null when one missing', () => assert.strictEqual(pctDiff(100, null), null));
  check('pctDiff null when zero/neg', () => assert.strictEqual(pctDiff(0, 100), null));

  // --- normStreet / normPostcode ---
  check('normStreet collapses + lowercases', () => assert.strictEqual(normStreet('  Stora  Vägen 3 '), 'stora vägen 3'));
  check('normStreet null', () => assert.strictEqual(normStreet(null), null));
  check('normPostcode strips space', () => assert.strictEqual(normPostcode('176 71'), '17671'));
  check('normPostcode from int', () => assert.strictEqual(normPostcode(17671), '17671'));
  check('normPostcode empty → null', () => assert.strictEqual(normPostcode('  '), null));

  // --- typeCategory / typeFamily ---
  check('Lägenhet → APARTMENT', () => assert.strictEqual(typeCategory('Lägenhet'), 'APARTMENT'));
  check('Bostadsrätt → APARTMENT', () => assert.strictEqual(typeCategory('Bostadsrätt'), 'APARTMENT'));
  check('Villa → VILLA', () => assert.strictEqual(typeCategory('Villa'), 'VILLA'));
  check('Radhus → ROWHOUSE', () => assert.strictEqual(typeCategory('Radhus'), 'ROWHOUSE'));
  check('Kedjehus → ROWHOUSE', () => assert.strictEqual(typeCategory('Kedjehus'), 'ROWHOUSE'));
  check('Fritidshus → VACATION', () => assert.strictEqual(typeCategory('Fritidshus'), 'VACATION'));
  check('Tomt/Mark → PLOT', () => assert.strictEqual(typeCategory('Tomt/Mark'), 'PLOT'));
  check('null type → null', () => assert.strictEqual(typeCategory(null), null));
  check('VILLA family HOUSE', () => assert.strictEqual(typeFamily('VILLA'), 'HOUSE'));
  check('ROWHOUSE family HOUSE', () => assert.strictEqual(typeFamily('ROWHOUSE'), 'HOUSE'));
  check('APARTMENT family APARTMENT', () => assert.strictEqual(typeFamily('APARTMENT'), 'APARTMENT'));

  // --- computeDeltas: clean same-unit match ---
  check('computeDeltas clean match', () => {
    const d = computeDeltas(
      { price: 2000000, living_area: 50, object_type: 'Lägenhet', street_address: 'Storgatan 3', postcode: 17671 },
      { asking_price: 2000000, living_area: 50, housing_form: 'Lägenhet', street_address: 'Storgatan 3', post_code: '176 71' },
    );
    assert.strictEqual(d.area_pct_diff, 0);
    assert.strictEqual(d.price_pct_diff, 0);
    assert.strictEqual(d.type_match, true);
    assert.strictEqual(d.family_match, true);
    assert.strictEqual(d.address_match, true);
    assert.strictEqual(d.postcode_match, true);
  });

  // --- computeDeltas: apartment matched to a house (the bad case) ---
  check('computeDeltas family mismatch', () => {
    const d = computeDeltas(
      { price: 2000000, living_area: 55, object_type: 'Lägenhet', street_address: 'Storgatan 3', postcode: 17671 },
      { asking_price: 8000000, living_area: 140, housing_form: 'Villa', street_address: 'Storgatan 3', post_code: '17671' },
    );
    assert.strictEqual(d.family_match, false);
    assert.strictEqual(d.type_match, false);
    assert.ok(d.area_pct_diff > 0.07);
  });

  // --- NULL is no-signal, never a mismatch ---
  check('computeDeltas nulls → null deltas, not false', () => {
    const d = computeDeltas(
      { price: null, living_area: null, object_type: null, street_address: 'Storgatan 3', postcode: 17671 },
      { asking_price: null, living_area: null, housing_form: null, street_address: null, post_code: null },
    );
    assert.strictEqual(d.area_pct_diff, null);
    assert.strictEqual(d.price_pct_diff, null);
    assert.strictEqual(d.type_match, null);
    assert.strictEqual(d.family_match, null);
    assert.strictEqual(d.address_match, null);
  });

  // --- classifyDeterministic buckets ---
  check('classify clean → likely-match', () => {
    const deltas = computeDeltas(
      { price: 2000000, living_area: 50, object_type: 'Lägenhet', street_address: 'Storgatan 3', postcode: 17671 },
      { asking_price: 2050000, living_area: 50, housing_form: 'Lägenhet', street_address: 'Storgatan 3', post_code: '17671' },
    );
    const c = classifyDeterministic({ deltas, evidence: 'full', booli: { price: 2000000, living_area: 50, object_type: 'Lägenhet' } });
    assert.strictEqual(c.provisional, 'likely-match');
    assert.deepStrictEqual(c.flags, []);
  });

  check('classify family mismatch → suspect', () => {
    const deltas = computeDeltas(
      { price: 2000000, living_area: 55, object_type: 'Lägenhet', street_address: 'Storgatan 3', postcode: 17671 },
      { asking_price: 8000000, living_area: 140, housing_form: 'Villa', street_address: 'Storgatan 3', post_code: '17671' },
    );
    const c = classifyDeterministic({ deltas, evidence: 'full', booli: { price: 2000000, living_area: 55, object_type: 'Lägenhet' } });
    assert.strictEqual(c.provisional, 'suspect');
    assert.ok(c.flags.includes('family_mismatch'));
    assert.ok(c.flags.includes('area_gap'));
  });

  check('classify area gap alone, price agrees → likely-match (boarea convention)', () => {
    const deltas = computeDeltas(
      { price: 2000000, living_area: 50, object_type: 'Lägenhet', street_address: 'A', postcode: 1 },
      { asking_price: 2000000, living_area: 95, housing_form: 'Lägenhet', street_address: 'A', post_code: 1 },
    );
    const c = classifyDeterministic({ deltas, evidence: 'full', booli: { price: 2000000, living_area: 50, object_type: 'Lägenhet' } });
    assert.strictEqual(c.provisional, 'likely-match');
    assert.ok(c.flags.includes('area_gap'));
  });

  check('classify area + price BOTH gap → suspect (different unit)', () => {
    const deltas = computeDeltas(
      { price: 2000000, living_area: 50, object_type: 'Lägenhet', street_address: 'A', postcode: 1 },
      { asking_price: 2600000, living_area: 95, housing_form: 'Lägenhet', street_address: 'A', post_code: 1 },
    );
    const c = classifyDeterministic({ deltas, evidence: 'full', booli: { price: 2000000, living_area: 50, object_type: 'Lägenhet' } });
    assert.strictEqual(c.provisional, 'suspect');
  });

  check('classify area gap + price MISSING → suspect (no corroboration)', () => {
    const deltas = computeDeltas(
      { price: null, living_area: 50, object_type: 'Lägenhet', street_address: 'A', postcode: 1 },
      { asking_price: null, living_area: 95, housing_form: 'Lägenhet', street_address: 'A', post_code: 1 },
    );
    const c = classifyDeterministic({ deltas, evidence: 'full', booli: { price: null, living_area: 50, object_type: 'Lägenhet' } });
    assert.strictEqual(c.provisional, 'suspect');
  });

  check('classify no signal (404 + null booli) → low-signal', () => {
    const deltas = computeDeltas(
      { price: null, living_area: null, object_type: null, street_address: 'A', postcode: 1 },
      { asking_price: null, living_area: null, housing_form: null, street_address: null, post_code: null },
    );
    const c = classifyDeterministic({ deltas, evidence: 'partial', booli: { price: null, living_area: null, object_type: null } });
    assert.strictEqual(c.provisional, 'low-signal');
    assert.ok(c.flags.includes('hemnet_unavailable'));
    assert.ok(c.flags.includes('booli_fields_null'));
  });

  check('classify price gap alone → likely-match (weak signal does not escalate)', () => {
    const deltas = computeDeltas(
      { price: 2000000, living_area: 50, object_type: 'Lägenhet', street_address: 'A', postcode: 1 },
      { asking_price: 2600000, living_area: 50, housing_form: 'Lägenhet', street_address: 'A', post_code: 1 },
    );
    const c = classifyDeterministic({ deltas, evidence: 'full', booli: { price: 2000000, living_area: 50, object_type: 'Lägenhet' } });
    assert.ok(c.flags.includes('price_gap'));
    assert.strictEqual(c.provisional, 'likely-match');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
