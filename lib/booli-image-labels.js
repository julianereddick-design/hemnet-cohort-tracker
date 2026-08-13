'use strict';
// lib/booli-image-labels.js — single source of truth for Booli's image
// `primaryLabel` taxonomy.
//
// WHY THIS FILE EXISTS: the taxonomy was originally hand-built from two sample
// pages and missed an entire second vocabulary. Booli serves TWO coexisting
// labelling schemes — a coarse one (`interior`, `kitchen/dining_room`,
// `bathroom/laundry`) and a fine-grained per-room one (`bedroom`, `kitchen`,
// `wc`, `livingroom`, `dining_room`, `hall`, `laundry`, `closet`). Listings
// carrying only the fine-grained labels were wrongly scored as having NO
// interior photos — 22 of 2,264 in the 2026-08-11 week, overstating the
// no-interior rate by ~1pp.
//
// Enumerated from 537 opened galleries (34 distinct labels). If a new label
// appears, `classifyLabel` returns 'unknown' — check `unknownLabels()` output
// on every run rather than silently bucketing it as non-interior.

// Inside the dwelling.
const INTERIOR = new Set([
  // coarse vocabulary
  'interior', 'kitchen/dining_room', 'bathroom/laundry', 'fireplace', 'stove',
  // fine-grained per-room vocabulary
  'bedroom', 'kitchen', 'wc', 'livingroom', 'dining_room', 'hall', 'laundry',
  'closet', 'tiled_stove',
]);

// Of the property or its surroundings, but not a room. Deliberately includes
// balcony/patio/courtyard: they must not be able to rescue a listing that shows
// no rooms, which is the whole point of the measure.
const NON_INTERIOR = new Set([
  'exterior', 'facade', 'floorplan', 'map', 'property_map', 'nearby_area',
  'balcony', 'balcony/view', 'view', 'courtyard', 'garden', 'patio',
  'wooden_deck', 'pool', 'garage',
]);

// Genuinely undecidable from the label alone. `staircase` may be internal
// stairs or a shared stairwell; `entrance` may be a front door or an inner
// hall; `other` is unlabelled by Booli. Treated as NON-interior for scoring
// (conservative) but counted separately so the sensitivity is visible.
const AMBIGUOUS = new Set(['staircase', 'stairwell', 'entrance', 'other']);

function classifyLabel(label) {
  if (label == null) return 'unlabelled';
  if (INTERIOR.has(label)) return 'interior';
  if (NON_INTERIOR.has(label)) return 'non_interior';
  if (AMBIGUOUS.has(label)) return 'ambiguous';
  return 'unknown';                     // new vocabulary — surface it, don't swallow it
}

// Three-state verdict over a set of labels (null = Booli served no label).
//   'none'    — no images at all
//   'yes'     — >=1 interior-family label
//   'unknown' — images exist but every label is null
//   'no'      — labels present, none interior
function interiorVerdict(labels) {
  if (!labels.length) return 'none';
  if (labels.some(l => INTERIOR.has(l))) return 'yes';
  if (labels.every(l => l == null)) return 'unknown';
  return 'no';
}

// Counts of interior / total from a {label: count} map, for interior share.
function interiorCounts(labelCounts) {
  let interior = 0, total = 0, ambiguous = 0, unknown = 0;
  for (const [k, v] of Object.entries(labelCounts || {})) {
    const label = k === 'NULL' ? null : k;
    total += v;
    const c = classifyLabel(label);
    if (c === 'interior') interior += v;
    else if (c === 'ambiguous') ambiguous += v;
    else if (c === 'unknown') unknown += v;
  }
  return { interior, total, ambiguous, unknown, share: total ? interior / total : 0 };
}

// Any label in the data this file doesn't know about.
function unknownLabels(labelCounts) {
  return Object.keys(labelCounts || {})
    .filter(k => k !== 'NULL' && classifyLabel(k) === 'unknown');
}

module.exports = {
  INTERIOR, NON_INTERIOR, AMBIGUOUS,
  classifyLabel, interiorVerdict, interiorCounts, unknownLabels,
};
