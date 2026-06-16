'use strict';

// spike-config.js — resolved constants for the Booli-sold → Hemnet-sold matching
// spike, established empirically by Stage 0 recon (2026-06-16). See
// verf-soldspike/recon/ for the raw evidence dumps.

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
};
