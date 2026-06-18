'use strict';

// sold-config.js — resolved constants for the Booli-sold → Hemnet-sold matching
// pipeline (Phase 15+). Established empirically by Stage 0 recon (2026-06-16).
// See verf-soldspike/recon/ for the raw evidence dumps.
//
// Lifted verbatim from scripts/spike-config.js (Phase 15-01).

// Two segments, run separately and NEVER blended (houses vs apartments differ in
// match difficulty and data source). Each carries the area IDs for BOTH portals
// so the comparison is municipality-aligned.
const SEGMENTS = {
  'stockholm-apt': {
    label: 'Stockholm apartments',
    family: 'APARTMENT',
    booli: { areaIds: 1, objectType: 'Lägenhet' },          // /slutpriser?areaIds=1&objectType=Lägenhet
    hemnet: { locationId: 18031, itemType: 'bostadsratt' },  // /salda?location_ids[]=18031&item_types[]=bostadsratt
  },
  'taby-villa': {
    label: 'Täby houses',
    family: 'HOUSE',
    booli: { areaIds: 20, objectType: 'Hus' },               // /slutpriser?areaIds=20&objectType=Hus
    hemnet: { locationId: 17793, itemType: null },           // item_type set per-record via booliObjectTypeToHemnet
  },
};

// Booli soldPriceType values that represent a GENUINE MARKET SALE. Anything else
// (e.g. 'Lagfart', and any 'Gåva'/'Arv'/'Byte' subtypes that appear) is a title
// transfer — dropped from the match seed (house feed is raw lagfarter) but kept
// for accounting.
const MARKET_SOLD_TYPES = new Set(['Slutpris', 'Sista bud']);

function isTitleTransfer(soldPriceType) {
  if (soldPriceType == null) return false; // unknown → treat as market (conservative; keep)
  return !MARKET_SOLD_TYPES.has(soldPriceType);
}

// Match-confirmation thresholds (mirror lib/spotcheck-evidence.js).
const PRICE_AGREE_PCT = 0.05; // ±5% sold-price agreement
const AREA_AGREE_PCT = 0.07;  // ±7% living-area agreement
// Hemnet narrowed-search price band around Booli sold price (mirror cohort job).
const PRICE_BAND = 0.05;
// Sold-date match window (days) between Booli soldDate and Hemnet soldAt.
const SOLD_DATE_WINDOW_DAYS = 10;
// Read-time ratio exclusion: drop sales younger than this from the RATIO only
// (Booli house lagfarter lag in posting). Matching still runs on everything.
const READ_TIME_EXCLUDE_DAYS = 90;

const DEFAULT_TARGET_PER_SEGMENT = 300;

// posIntEnv — read a positive-integer env override (RECHECK-04), else the default.
// ASVS V5: never trust raw env. Reject NaN / <= 0 / non-integer and fall back to
// the documented default so a typo can never widen/zero the re-check window.
function posIntEnv(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return dflt;
  return n;
}

// boolEnv — read a boolean env override (D-16). ASVS V5: never trust raw env. Only
// '1'/'true' (case-insensitive) → true and '0'/'false' → false; anything else (typo,
// empty, unset) falls back to the documented default. A typo can never silently flip
// a default-OFF cost lever ON.
function boolEnv(name, dflt) {
  const raw = process.env[name];
  if (raw == null) return dflt;
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return dflt;
}

// RECHECK_BRIDGE_FINAL_ONLY (D-16) — DEFAULT FALSE. When ON, the Phase-18 re-check
// drain skips the SERP bridge on INTERMEDIATE re-attempts and runs it only on the
// FINAL attempt before settle (cuts ~mid 9k -> ~6k Oxylabs calls/month). Default OFF
// preserves the full-fidelity drain (bridge on every attempt). Operator cost lever.
const RECHECK_BRIDGE_FINAL_ONLY = boolEnv('RECHECK_BRIDGE_FINAL_ONLY', false);

// Re-check drain window (RECHECK-04, Phase 18). An unmatched booli_only row is
// re-attempted against Hemnet /salda until first_unmatched_at + RECHECK_WINDOW_DAYS,
// re-searched no more often than every RECHECK_INTERVAL_DAYS, then settled terminal.
// Both adjustable via env with NO code edit (default ~4 weeks / weekly cadence).
const RECHECK_WINDOW_DAYS = posIntEnv('RECHECK_WINDOW_DAYS', 28);
const RECHECK_INTERVAL_DAYS = posIntEnv('RECHECK_INTERVAL_DAYS', 7);

// ISO date N days before `fromISO` (or now). Used to seed the Booli sold window
// ENDING 90 days ago: every record is then ratio-eligible (older than the
// read-time exclusion) AND old enough that Hemnet has had time to post its
// slutpris — so "Booli-only" reflects genuine bypass/miss, not posting lag.
function daysAgoISO(n, fromISO) {
  const base = fromISO ? new Date(`${fromISO}T00:00:00Z`) : new Date();
  return new Date(base.getTime() - n * 86400000).toISOString().slice(0, 10);
}

module.exports = {
  SEGMENTS,
  MARKET_SOLD_TYPES,
  isTitleTransfer,
  PRICE_AGREE_PCT,
  AREA_AGREE_PCT,
  PRICE_BAND,
  SOLD_DATE_WINDOW_DAYS,
  READ_TIME_EXCLUDE_DAYS,
  DEFAULT_TARGET_PER_SEGMENT,
  RECHECK_WINDOW_DAYS,
  RECHECK_INTERVAL_DAYS,
  RECHECK_BRIDGE_FINAL_ONLY,
  posIntEnv,
  boolEnv,
  daysAgoISO,
};

// ---------------------------------------------------------------------------
// Inline smoke test — node lib/sold-config.js --smoke
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('isTitleTransfer: Lagfart → true', () => {
    assert.strictEqual(isTitleTransfer('Lagfart'), true);
  });
  check('isTitleTransfer: Slutpris → false', () => {
    assert.strictEqual(isTitleTransfer('Slutpris'), false);
  });
  check('isTitleTransfer: Sista bud → false', () => {
    assert.strictEqual(isTitleTransfer('Sista bud'), false);
  });
  check('isTitleTransfer: null → false (conservative)', () => {
    assert.strictEqual(isTitleTransfer(null), false);
  });
  check('isTitleTransfer: undefined → false (conservative)', () => {
    assert.strictEqual(isTitleTransfer(undefined), false);
  });
  check('isTitleTransfer: unknown type → true', () => {
    assert.strictEqual(isTitleTransfer('Gåva'), true);
  });
  check('SEGMENTS: stockholm-apt family is APARTMENT', () => {
    assert.strictEqual(SEGMENTS['stockholm-apt'].family, 'APARTMENT');
  });
  check('SEGMENTS: stockholm-apt booli objectType is Lägenhet', () => {
    assert.strictEqual(SEGMENTS['stockholm-apt'].booli.objectType, 'Lägenhet');
  });
  check('SEGMENTS: stockholm-apt hemnet locationId is 18031', () => {
    assert.strictEqual(SEGMENTS['stockholm-apt'].hemnet.locationId, 18031);
  });
  check('SEGMENTS: taby-villa family is HOUSE', () => {
    assert.strictEqual(SEGMENTS['taby-villa'].family, 'HOUSE');
  });
  check('SEGMENTS: taby-villa booli objectType is Hus', () => {
    assert.strictEqual(SEGMENTS['taby-villa'].booli.objectType, 'Hus');
  });
  check('daysAgoISO: returns YYYY-MM-DD string for n=0', () => {
    const r = daysAgoISO(0);
    assert.match(r, /^\d{4}-\d{2}-\d{2}$/);
  });
  check('daysAgoISO: fromISO anchor works', () => {
    assert.strictEqual(daysAgoISO(1, '2026-06-17'), '2026-06-16');
  });
  check('daysAgoISO: 7 days ago is earlier than today', () => {
    const today = daysAgoISO(0);
    const week = daysAgoISO(7);
    assert.ok(week < today);
  });
  check('MARKET_SOLD_TYPES: is a Set', () => {
    assert.ok(MARKET_SOLD_TYPES instanceof Set);
  });
  check('PRICE_AGREE_PCT: is 0.05', () => {
    assert.strictEqual(PRICE_AGREE_PCT, 0.05);
  });
  check('READ_TIME_EXCLUDE_DAYS: is 90', () => {
    assert.strictEqual(READ_TIME_EXCLUDE_DAYS, 90);
  });
  check('DEFAULT_TARGET_PER_SEGMENT: is 300', () => {
    assert.strictEqual(DEFAULT_TARGET_PER_SEGMENT, 300);
  });
  check('RECHECK_WINDOW_DAYS default is 28', () => {
    assert.strictEqual(posIntEnv('RECHECK_WINDOW_DAYS', 28), 28);
  });
  check('RECHECK_INTERVAL_DAYS default is 7', () => {
    assert.strictEqual(RECHECK_INTERVAL_DAYS, 7);
  });
  check('posIntEnv: valid override honored', () => {
    process.env.__T = '21';
    assert.strictEqual(posIntEnv('__T', 28), 21);
    delete process.env.__T;
  });
  check('posIntEnv: zero rejected → default', () => {
    process.env.__T = '0';
    assert.strictEqual(posIntEnv('__T', 28), 28);
    delete process.env.__T;
  });
  check('posIntEnv: negative rejected → default', () => {
    process.env.__T = '-5';
    assert.strictEqual(posIntEnv('__T', 28), 28);
    delete process.env.__T;
  });
  check('posIntEnv: non-numeric rejected → default', () => {
    process.env.__T = 'abc';
    assert.strictEqual(posIntEnv('__T', 28), 28);
    delete process.env.__T;
  });
  check('RECHECK_WINDOW_DAYS is a positive integer', () => {
    assert.ok(Number.isInteger(RECHECK_WINDOW_DAYS) && RECHECK_WINDOW_DAYS > 0);
  });
  check("boolEnv: '1' -> true, '0' -> false, '' -> default, typo -> default", () => {
    process.env.__T = '1';
    assert.strictEqual(boolEnv('__T', false), true, "'1' -> true");
    process.env.__T = '0';
    assert.strictEqual(boolEnv('__T', true), false, "'0' -> false");
    process.env.__T = 'true';
    assert.strictEqual(boolEnv('__T', false), true, "'true' -> true");
    process.env.__T = 'false';
    assert.strictEqual(boolEnv('__T', true), false, "'false' -> false");
    process.env.__T = '';
    assert.strictEqual(boolEnv('__T', false), false, "'' -> default (false)");
    assert.strictEqual(boolEnv('__T', true), true, "'' -> default (true)");
    process.env.__T = 'yse'; // typo
    assert.strictEqual(boolEnv('__T', false), false, 'typo -> default');
    delete process.env.__T;
    assert.strictEqual(boolEnv('__T', false), false, 'unset -> default');
  });
  check('RECHECK_BRIDGE_FINAL_ONLY defaults to false (D-16 full-fidelity drain)', () => {
    assert.strictEqual(RECHECK_BRIDGE_FINAL_ONLY, false);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
