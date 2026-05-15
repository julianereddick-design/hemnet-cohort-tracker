// lib/booli-to-hemnet-mapping.js
//
// Maps Booli's `objectType` (Swedish, e.g. 'Lägenhet', 'Villa') to Hemnet's
// item_types[] URL query parameter (lowercase Swedish, e.g. 'bostadsratt',
// 'villa'). Used by the future Job B rewrite that narrows Hemnet's search
// instead of paginating an entire municipality's listings.
//
// Vocabulary verified 2026-05-15 via scripts/diagnostics/probe-hemnet-item-types.js
// (live probe of hemnet.se with each candidate URL token; valid tokens produce a
// non-empty housingFormGroups in Hemnet's GraphQL search args). Verified tokens:
//   bostadsratt → APARTMENTS
//   villa       → HOUSES
//   radhus      → ROW_HOUSES
//   fritidshus  → VACATION_HOMES
//   gard        → HOMESTEADS
//   tomt        → PLOTS
// IGNORED by Hemnet (rolled into broader category or unsupported):
//   kedjehus, parhus → bundled into HOUSES on Hemnet → mapped to 'villa'
//   lagenhet, andelsbostad, agarlagenhet → not separate filters
//   tomt-mark, gard-skog → invalid; Hemnet uses 'tomt' and 'gard'
//
// Booli `objectType` values observed (140-card sample across 4 cohort counties,
// 2026-05-15): Lägenhet (53%), Villa (34%), Radhus (5%), Fritidshus (4%),
// Kedjehus (2%), Tomt/Mark (1%), Gård (1%). All have a mapping target.

'use strict';

const BOOLI_TO_HEMNET_ITEM_TYPE = Object.freeze({
  'Lägenhet':    'bostadsratt',
  'Villa':       'villa',
  'Radhus':      'radhus',
  'Kedjehus':    'villa',       // Hemnet bundles into HOUSES
  'Parhus':      'villa',       // Hemnet bundles into HOUSES
  'Fritidshus':  'fritidshus',
  'Tomt/Mark':   'tomt',
  'Gård':        'gard',
});

// Convenience helper. Returns the Hemnet item_types[] URL token for a Booli
// objectType, or null if the Booli value is unknown / missing. Callers that
// want to OMIT the filter on unknown types should treat null as "do not pass
// item_types[]= in the URL".
function booliObjectTypeToHemnet(booliObjectType) {
  if (booliObjectType == null || typeof booliObjectType !== 'string') return null;
  const v = BOOLI_TO_HEMNET_ITEM_TYPE[booliObjectType];
  return v == null ? null : v;
}

module.exports = {
  BOOLI_TO_HEMNET_ITEM_TYPE,
  booliObjectTypeToHemnet,
};

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network).
//   node lib/booli-to-hemnet-mapping.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('Lägenhet → bostadsratt', () => assert.strictEqual(booliObjectTypeToHemnet('Lägenhet'), 'bostadsratt'));
  check('Villa → villa',          () => assert.strictEqual(booliObjectTypeToHemnet('Villa'), 'villa'));
  check('Radhus → radhus',        () => assert.strictEqual(booliObjectTypeToHemnet('Radhus'), 'radhus'));
  check('Kedjehus → villa (bundled into HOUSES)', () => assert.strictEqual(booliObjectTypeToHemnet('Kedjehus'), 'villa'));
  check('Parhus → villa (bundled into HOUSES)',   () => assert.strictEqual(booliObjectTypeToHemnet('Parhus'), 'villa'));
  check('Fritidshus → fritidshus', () => assert.strictEqual(booliObjectTypeToHemnet('Fritidshus'), 'fritidshus'));
  check('Tomt/Mark → tomt',        () => assert.strictEqual(booliObjectTypeToHemnet('Tomt/Mark'), 'tomt'));
  check('Gård → gard',             () => assert.strictEqual(booliObjectTypeToHemnet('Gård'), 'gard'));
  check('unknown → null',          () => assert.strictEqual(booliObjectTypeToHemnet('Slott'), null));
  check('null → null',             () => assert.strictEqual(booliObjectTypeToHemnet(null), null));
  check('undefined → null',        () => assert.strictEqual(booliObjectTypeToHemnet(undefined), null));
  check('non-string → null',       () => assert.strictEqual(booliObjectTypeToHemnet(123), null));
  check('map is frozen',           () => assert.throws(() => { BOOLI_TO_HEMNET_ITEM_TYPE['x'] = 'y'; }));
  check('exact case sensitivity (Hemnet codes are lowercase)', () => {
    // Make sure no entry accidentally yields uppercase
    for (const v of Object.values(BOOLI_TO_HEMNET_ITEM_TYPE)) {
      assert.strictEqual(v, v.toLowerCase());
    }
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
