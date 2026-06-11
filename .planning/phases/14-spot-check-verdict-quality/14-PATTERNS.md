# Phase 14: Spot-check verdict quality — Pattern Map

**Mapped:** 2026-06-11
**Files analyzed:** 5 (4 modify + 1 new)
**Analogs found:** 5 / 5

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `lib/spotcheck-adjudicate.js` | utility (pure transform) | request-response | self (modify in place) | self |
| `lib/spotcheck-dhash.js` | utility (pure compute) | transform | self (modify in place) | self |
| `lib/spotcheck-vision.js` | utility (AI adjudicator) | request-response | self (modify in place) | self |
| `cohort-spotcheck-gate.js` | orchestrator / cron job | batch, request-response | self (modify in place) | self |
| `scripts/probe-dhash-sizing.js` | one-off probe script | batch, transform | `scripts/probe-oxylabs-booli.js` + `cohort-spotcheck.js` | role-match |

---

## Pattern Assignments

### `lib/spotcheck-adjudicate.js` (utility, pure transform — MODIFY)

**Analog:** self — read `lib/spotcheck-adjudicate.js` lines 1–331 in full above.

**Current signature** (lines 47–113):
```javascript
function adjudicatePair(record, { visionResult } = {}) {
  const r = record || {};
  const d = r.deltas || {};
  const photos = r.photos || {};

  const priceAgrees =
    d.price_pct_diff != null && d.price_pct_diff <= 0.05;

  const hasPhotos =
    (photos.hemnet_gallery?.length > 0) && (photos.booli_gallery?.length > 0);

  const sharedPhoto = visionResult != null ? (visionResult.sharedPhoto ?? null) : null;
  const provisional = r.provisional;

  // Branch 2 (THE DRAIN — to be reworked per D-02):
  if (priceAgrees && hasPhotos && provisional === 'likely-match' && sharedPhoto == null) {
    return {
      verdict: 'CONFIRMED_MATCH',
      source: 'deterministic',
      reason: 'price agrees + likely-match + photos present (deterministic promote)',
    };
  }
  // ...
}
```

**What D-02 changes — proposed new signature:**
The third parameter `dhashResult` must be added. `hasPhotos` as a confirmation signal is retired. Branch 2 must become:
```javascript
// PROPOSED Branch 2 (D-02 + D-05):
// dhashResult: { minDist, confirmed, sharedCount, hasFloorplanOnly, isMultiUnit } | null
function adjudicatePair(record, { visionResult } = {}, dhashResult = null) {
  // ...existing signal derivation unchanged...

  // Branch 2 rework (D-02 + D-05):
  //   confirmed     = dhashResult?.confirmed  (minDist <= threshold, non-floorplan images)
  //   sharedCount   = dhashResult?.sharedCount >= 2  (≥2 distinct shared photos)
  //   hasFloorplanOnly = dhashResult?.hasFloorplanOnly  (all matches were floorplan images)
  //   isMultiUnit   = dhashResult?.isMultiUnit  (multi-unit address flag from gate)
  const dhashConfirmed =
    dhashResult != null &&
    dhashResult.confirmed === true &&
    (dhashResult.sharedCount == null || dhashResult.sharedCount >= 2) &&
    !dhashResult.hasFloorplanOnly &&
    !dhashResult.isMultiUnit;

  if (priceAgrees && provisional === 'likely-match' && sharedPhoto == null && dhashConfirmed) {
    return {
      verdict: 'CONFIRMED_MATCH',
      source: 'deterministic',
      reason: `price agrees + likely-match + dHash shared photo (minDist=${dhashResult.minDist}, sharedCount=${dhashResult.sharedCount})`,
    };
  }
  // D-03: no silent confirm without photo correspondence
  // priceAgrees + likely-match + dhashResult present but NOT confirmed → fall through to UNCERTAIN
  // ...Branches 1, 3, 4, 5 unchanged...
}
```

**D-04 challenge flag pattern:**
After the promotion loop in `cohort-spotcheck-gate.js`, any pair that was Branch-2 confirmed but has `dhashResult.minDist > threshold` must log a visible warning. This is tracked via `v.dhash_challenge = true` on the pair record, not a new branch in adjudicatePair itself.

**--smoke test framework** (lines 146–331) — ALL new cases must follow this exact pattern:
```javascript
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // Helper already in file:
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

  // New smoke cases needed for D-02:
  //   'Branch 2: priceAgrees + likely-match + dhashConfirmed → CONFIRMED_MATCH'
  //   'Branch 2: priceAgrees + likely-match + dHash NOT confirmed → UNCERTAIN'
  //   'Branch 2: dHash confirmed but isMultiUnit → UNCERTAIN (multi-unit guard)'
  //   'Branch 2: dHash confirmed but hasFloorplanOnly → UNCERTAIN (floorplan guard)'
  //   'Branch 2: dHash confirmed but sharedCount < 2 → UNCERTAIN (distinct photos guard)'
  //   'Regression: 15647 (suspect + priceAgrees + sharedPhoto=false) → UNCERTAIN still'
  //   'Regression: 16347 (suspect + !priceAgrees + sharedPhoto=false) → CONFIRMED_MISMATCH still'

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

**Regression fixtures to preserve** (lines 253–268):
- Pair 15647: `{ pair_id: 15647, provisional: 'suspect', deltas: { price_pct_diff: 0.0, area_pct_diff: 0.18 } }` + `{ visionResult: { sharedPhoto: false } }` → MUST remain UNCERTAIN
- Pair 16347: `{ pair_id: 16347, provisional: 'suspect', deltas: { price_pct_diff: 0.16, area_pct_diff: 0.17 } }` + `{ visionResult: { sharedPhoto: false } }` → MUST remain CONFIRMED_MISMATCH

**adjudicatePairs** (lines 128–138) also needs updating to accept and pass through `dhashResults` map (keyed by pair_id → dhashResult) to `adjudicatePair`.

---

### `lib/spotcheck-dhash.js` (utility, pure compute — MODIFY)

**Analog:** self — read `lib/spotcheck-dhash.js` lines 1–147 in full above.

**Existing exports** (line 73):
```javascript
module.exports = { minDHashDistance };
```

**New function needed — `sharedPhotoPairs`:**
Returns ALL (bFile, hFile) cross-pairs within threshold, then checks diversity among matched pairs:
```javascript
// PROPOSED new export:
// sharedPhotoPairs(booliFiles, hemnetFiles, threshold) ->
//   { pairs: [{bFile, hFile, dist}], sharedCount, distinct }
// Where:
//   pairs      = all (b,h) pairs with Hamming dist <= threshold
//   sharedCount = pairs.length (number of matched cross-pairs)
//   distinct   = true when matched booli images are themselves dissimilar (dist > threshold
//                among each other) AND matched hemnet images are themselves dissimilar
// Uses the existing hashAll() helper (already unexported but in same module scope).
async function sharedPhotoPairs(booliFiles, hemnetFiles, threshold) {
  const booli  = await hashAll(booliFiles  || []);
  const hemnet = await hashAll(hemnetFiles || []);
  const pairs = [];
  for (const b of booli) {
    for (const h of hemnet) {
      const dist = hamming(b.d, h.d);
      if (dist <= threshold) pairs.push({ bFile: b.file, hFile: h.file, dist });
    }
  }
  // Distinct check: matched booli images must be dissimilar from each other
  const matchedBooli  = [...new Set(pairs.map(p => p.bFile))];
  const matchedHemnet = [...new Set(pairs.map(p => p.hFile))];
  let distinct = true;
  if (matchedBooli.length >= 2) {
    const booliHashes = booli.filter(b => matchedBooli.includes(b.file));
    for (let i = 0; i < booliHashes.length && distinct; i++) {
      for (let j = i + 1; j < booliHashes.length && distinct; j++) {
        if (hamming(booliHashes[i].d, booliHashes[j].d) <= threshold) distinct = false;
      }
    }
  }
  // Same check for hemnet side
  if (matchedHemnet.length >= 2) {
    const hemnetHashes = hemnet.filter(h => matchedHemnet.includes(h.file));
    for (let i = 0; i < hemnetHashes.length && distinct; i++) {
      for (let j = i + 1; j < hemnetHashes.length && distinct; j++) {
        if (hamming(hemnetHashes[i].d, hemnetHashes[j].d) <= threshold) distinct = false;
      }
    }
  }
  return { pairs, sharedCount: pairs.length, distinct };
}
```

**New function needed — `filterDiscriminatingFiles`:**
Filter non-discriminating images (floorplan/property_map/nearby_area by label; Hemnet by heuristic) before hashing:
```javascript
// NON_DISCRIMINATING labels (Booli primaryLabel values confirmed in live data):
const NON_DISCRIMINATING_LABELS = new Set(['floorplan', 'property_map', 'nearby_area']);

// galleryEntries: [{ file: absolutePath, label: string|null }]
// Returns filtered array of absolute file paths (label-discriminated for Booli,
// pass-through for Hemnet null-label entries in Phase 14; heuristic extension deferred).
function filterDiscriminatingFiles(galleryEntries) {
  return (galleryEntries || [])
    .filter(g => !(g.label && NON_DISCRIMINATING_LABELS.has(g.label)))
    .map(g => g.file);
}
```

**Updated module.exports** (to add):
```javascript
module.exports = { minDHashDistance, sharedPhotoPairs, filterDiscriminatingFiles };
```

**--smoke async test pattern** (lines 111–145) — new cases must follow `checkAsync`:
```javascript
(async () => {
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // New smoke cases needed:
  //   'filterDiscriminatingFiles: removes floorplan label'
  //   'filterDiscriminatingFiles: removes property_map label'
  //   'filterDiscriminatingFiles: passes through null label (Hemnet)'
  //   'filterDiscriminatingFiles: passes through interior label'
  //   'sharedPhotoPairs([], []) → { pairs: [], sharedCount: 0 }'
  //   'sharedPhotoPairs distinct=false when matched booli images are near-duplicates'

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
  process.exit(1);
});
```

---

### `lib/spotcheck-vision.js` (utility, AI adjudicator — MODIFY)

**Analog:** self — read `lib/spotcheck-vision.js` lines 1–270 in full above.

**Lazy SDK load pattern** (lines 35–41) — must be preserved exactly in any new logic:
```javascript
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');  // lazy require — never at top level
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
```

**Image block building** (lines 105–112) — D-05 floorplan exclusion must filter BEFORE this:
```javascript
// CURRENT (sends all gallery entries):
const booliBlocks  = booliSlice.map((g)  => buildImageBlock(path.join(artifactDir, g.file))).filter(Boolean);
const hemnetBlocks = hemnetSlice.map((g) => buildImageBlock(path.join(artifactDir, g.file))).filter(Boolean);

// PROPOSED (filter floorplan/non-discriminating before building blocks):
const NON_DISCRIMINATING_LABELS = new Set(['floorplan', 'property_map', 'nearby_area']);
const booliFiltered  = booliSlice.filter(g => !(g.label && NON_DISCRIMINATING_LABELS.has(g.label)));
const hemnetFiltered = hemnetSlice;  // Hemnet has null labels — heuristic deferred (Phase 14 OQ-3)
const booliBlocks  = booliFiltered.map((g)  => buildImageBlock(path.join(artifactDir, g.file))).filter(Boolean);
const hemnetBlocks = hemnetFiltered.map((g) => buildImageBlock(path.join(artifactDir, g.file))).filter(Boolean);
```

**Return/null patterns** (lines 109–111, 161–163, 169–172) — any new error path must return null (never throw):
```javascript
if (booliBlocks.length === 0 || hemnetBlocks.length === 0) {
  return { sharedPhoto: null, confidence: 'low', reasoning: 'insufficient images' };
}
// ...
} catch (err) {
  console.warn(`[spotcheck-vision] API error for pair ${p.pair_id}: ${err.message}`);
  return null;  // API error → Mode A fallback, never crash
}
```

**Prompt text** (lines 122–135) — the `IMPORTANT:` instruction already warns against cover-only evidence; Phase 14 should strengthen it with an explicit floorplan warning:
```javascript
// CURRENT questionText (line 128-135):
const questionText = `Decide if these two listings show the SAME physical property.

IMPORTANT: Look for ONE clearly shared room or exterior feature across BOTH galleries...
Find a shared interior or exterior detail.
...`;

// PROPOSED addition to prompt (insert after "Find a shared interior or exterior detail."):
// "Floor plans, architectural diagrams, or building site maps are NOT valid shared photo
// evidence — ignore them even if they appear identical across both galleries."
```

**--smoke offline pattern** (lines 186–269) — new floorplan-filter case must follow the existing `checkAsync` with dummy key pattern:
```javascript
async function checkAsync(name, fn) {
  try { await fn(); pass++; }
  catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
}
// New smoke case: adjudicateWithVision with a floorplan-only gallery → returns null or
// { sharedPhoto: null } (insufficient non-floorplan images). This validates the
// filter-before-build path without any real API call.
```

---

### `cohort-spotcheck-gate.js` (orchestrator / cron job — MODIFY)

**Analog:** self — read `cohort-spotcheck-gate.js` lines 1–388 in full above.

**execFileSync child process pattern** (lines 140–171) — all child process calls use argv arrays, never shell strings:
```javascript
execFileSync(
  process.execPath,
  [
    path.join(process.cwd(), 'cohort-spotcheck.js'),
    '--cohort', cohortId,
    '--rate', String(args.rate),
    '--conc', String(args.conc),
  ],
  { stdio: 'inherit', cwd: process.cwd() }
);
```

**DB client query pattern** (lines 113–119) — multi-unit query must follow this parameterized style:
```javascript
// EXISTING DB query pattern (line 113-119):
const r = await client.query('SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1');

// PROPOSED multi-unit query (D-05) — insert after cohortId is resolved, before dHash step:
const multiUnitRes = await client.query(
  `SELECT LOWER(TRIM(street_address)) AS addr, postcode
   FROM cohort_pairs
   WHERE cohort_id = $1
   GROUP BY LOWER(TRIM(street_address)), postcode
   HAVING COUNT(*) > 1`,
  [cohortId]
);
const multiUnitAddrs = new Set(
  multiUnitRes.rows.map(r => `${r.addr}|${r.postcode}`)
);
// Then per pair in artifact.pairs:
// p.isMultiUnit = multiUnitAddrs.has(
//   `${(p.street_address || '').toLowerCase().trim()}|${p.postcode || ''}`
// );
```

**Current dHash step** (lines 205–224) — Phase 14 replaces `minDHashDistance` with `sharedPhotoPairs` + `filterDiscriminatingFiles`:
```javascript
// CURRENT (lines 205-224):
const DHASH_THRESHOLD = parseInt(process.env.DHASH_THRESHOLD || '6', 10);
const dhashResults = {};
for (const p of (artifact.pairs || [])) {
  const photos = p.photos || {};
  const booliFiles  = (photos.booli_gallery  || []).map(g => path.join(artifactDir, g.file));
  const hemnetFiles = (photos.hemnet_gallery || []).map(g => path.join(artifactDir, g.file));
  if (booliFiles.length === 0 || hemnetFiles.length === 0) {
    log('INFO', `dHash pair ${p.pair_id}: skipped (no gallery on one side)`);
    continue;
  }
  const { minDist, bFile, hFile } = await minDHashDistance(booliFiles, hemnetFiles);
  const confirmed = minDist <= DHASH_THRESHOLD;
  dhashResults[p.pair_id] = { minDist, confirmed, bFile, hFile };
  p.dhash = { minDist, confirmed, threshold: DHASH_THRESHOLD };
  log('INFO', `dHash pair ${p.pair_id}: minDist=${minDist} threshold=${DHASH_THRESHOLD} ${confirmed ? 'AUTO-CONFIRM' : 'escalate'}`);
}

// PROPOSED (Phase 14 — uses sharedPhotoPairs + filterDiscriminatingFiles):
for (const p of (artifact.pairs || [])) {
  const photos = p.photos || {};
  const booliEntries  = (photos.booli_gallery  || []).map(g => ({ file: path.join(artifactDir, g.file), label: g.label || null }));
  const hemnetEntries = (photos.hemnet_gallery || []).map(g => ({ file: path.join(artifactDir, g.file), label: g.label || null }));
  if (booliEntries.length === 0 || hemnetEntries.length === 0) { continue; }
  const booliFilesFiltered  = filterDiscriminatingFiles(booliEntries);
  const hemnetFilesFiltered = filterDiscriminatingFiles(hemnetEntries);  // pass-through for null labels
  const { pairs: matchedPairs, sharedCount, distinct } = await sharedPhotoPairs(booliFilesFiltered, hemnetFilesFiltered, DHASH_THRESHOLD);
  const minDist = matchedPairs.length > 0 ? Math.min(...matchedPairs.map(x => x.dist)) : 64;
  const hasFloorplanOnly = booliEntries.length > 0 && booliFilesFiltered.length === 0; // all booli images were filtered
  const confirmed = sharedCount > 0;
  dhashResults[p.pair_id] = { minDist, confirmed, sharedCount, distinct, hasFloorplanOnly, isMultiUnit: !!p.isMultiUnit };
  p.dhash = { minDist, confirmed, sharedCount, distinct, threshold: DHASH_THRESHOLD };
  log('INFO', `dHash pair ${p.pair_id}: minDist=${minDist} sharedCount=${sharedCount} distinct=${distinct} isMultiUnit=${!!p.isMultiUnit} ${confirmed ? 'AUTO-CONFIRM-CANDIDATE' : 'escalate'}`);
}
```

**Current promotion loop** (lines 270–279) — Phase 14 replaces it with adjudicatePair receiving dhashResult as 3rd param:
```javascript
// CURRENT promotion loop (to be REMOVED in Phase 14):
for (const v of verdicts) {
  const dr = dhashResults[v.pair_id];
  if (dr && dr.confirmed && v.verdict === 'UNCERTAIN') {
    v.verdict = 'CONFIRMED_MATCH'; v.verdict_source = 'dhash';
    v.verdict_reason = `dHash shared image (minDist=${dr.minDist} <= ${DHASH_THRESHOLD})`;
  }
}

// PROPOSED (Phase 14 — D-02 + D-04):
// 1. Pass dhashResults into adjudicatePairs as a third argument map.
// 2. D-04 challenge flag: after adjudication, any pair that was Branch-2 confirmed
//    BUT its dhashResult has confirmed=false (minDist > threshold) → log and flag.
//    This requires adjudicatePairs to accept a dhashResults map.
const verdicts = adjudicatePairs(artifact.pairs || [], { visionResults }, dhashResults);

// D-04 challenge logging (post-adjudication):
for (const v of verdicts) {
  const dr = dhashResults[v.pair_id];
  if (dr && !dr.confirmed && v.verdict === 'CONFIRMED_MATCH' && v.verdict_source === 'deterministic') {
    // A pair silently confirmed via Branch 2 but dHash found no shared photo.
    // Under D-02 this can no longer happen (Branch 2 now requires dhashConfirmed).
    // This is the challenge-flag path for Phase 14 transition period visibility.
    v.dhash_challenge = true;
    log('WARN', `dHash CHALLENGE pair ${p.pair_id}: confirmed via Branch2 but minDist=${dr.minDist} (no shared photo found)`);
  }
}
```

**runJob / validate pattern** (lines 374–388) — unchanged in Phase 14, just reference:
```javascript
runJob({
  scriptName: 'cohort-spotcheck-gate',
  main,
  validate: (summary) => {
    if (!summary) return null;
    if (summary.skipped) return summary.staleCohort ? summary.slackMsg : null;
    if (summary.fetchFailures > 0) { return `${summary.fetchFailures} fetch failure(s)...`; }
    if (summary.confirmedMismatchRate > summary.threshold) { return summary.slackMsg; }
    return null;
  },
});
```

---

### `scripts/probe-dhash-sizing.js` (new — one-off probe)

**Primary analog:** `scripts/probe-oxylabs-booli.js` (lines 1–181) for overall script structure.
**Secondary analog:** `cohort-spotcheck.js` for artifact-dir discovery + DB client pattern.

**Script header and env-load pattern** (probe-oxylabs-booli.js lines 1–31):
```javascript
'use strict';
// probe-dhash-sizing.js — D-01 sizing probe for Phase 14.
// [doc comment describing purpose, cost, usage, pass criteria]

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('../db');
// ... other imports from existing lib/spotcheck-* modules
```

**DB connect + release pattern** (probe-oxylabs-booli.js lines 125–141):
```javascript
const client = createClient();
try {
  await client.connect();
} catch (e) {
  log('FAIL', `DB connect failed: ${e && e.message ? e.message : 'unknown'}`);
  process.exit(1);
}

// ... use client for multi-unit query and cohort resolution ...

try { await client.end(); } catch (_) { /* best effort */ }
```

**Artifact dir discovery pattern** (cohort-spotcheck-gate.js lines 91–104):
```javascript
// The probe should accept an existing artifact dir as a CLI arg (--dir <path>)
// OR discover the latest via findArtifactDir(cohortId). Copy this function:
function findArtifactDir(cohortId) {
  const prefix = `verf-spotcheck-${cohortId}-`;
  const cwd = process.cwd();
  let dirs;
  try {
    dirs = fs.readdirSync(cwd).filter(
      (d) => d.startsWith(prefix) && fs.statSync(path.join(cwd, d)).isDirectory()
    );
  } catch (_) { return null; }
  if (dirs.length === 0) return null;
  return path.join(cwd, dirs.sort().pop());
}
```

**Log helper pattern** (probe-oxylabs-booli.js lines 52–57):
```javascript
function nowIso() { return new Date().toISOString(); }
function log(prefix, msg) {
  process.stdout.write(`[${nowIso()}] [${prefix}] ${msg}\n`);
}
// cohort-spotcheck.js uses a slightly different form:
function log(level, msg) {
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);
}
// Either is fine; follow cohort-spotcheck.js form for consistency with other spotcheck tools.
```

**Main async IIFE pattern** (probe-oxylabs-booli.js lines 116–181):
```javascript
(async () => {
  // ... all async work ...
  // Pass/fail summary at end with process.exit(0/1)
})().catch((e) => {
  log('UNEXPECTED', e && e.stack ? e.stack : String(e));
  process.exit(1);
});
```

**Wilson CI pattern** (cohort-spotcheck.js lines 108–117 — also exported from lib/spotcheck-summary.js):
```javascript
// Prefer importing from the already-exported lib module:
const { wilson95 } = require('../lib/spotcheck-summary');
// Then use:
const [lo, hi] = wilson95(nDhashFail, nWithBothGalleries);
```

**Probe artifact output convention** (verf-spotcheck-*/):
```javascript
// Output directory name: follow cohort-spotcheck.js tsStamp pattern (line 101-104):
function tsStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// Probe writes to the SAME artifact dir it reads from (it enriches the existing artifact
// with dHash results, or writes a new PROBE-DHASH-<cohortId>.md file into it).
// Dir name: verf-spotcheck-<cohortId>-<ts>/ — already established by cohort-spotcheck.js.
```

**Pair record shape expected by probe** (from artifact JSON):
```javascript
// Each pair in artifact.pairs has (after spotcheck-photos.js --gallery --all):
{
  pair_id,
  county,
  provisional,         // 'likely-match' | 'suspect' | 'low-signal'
  deltas: {
    price_pct_diff,    // null if Hemnet 404
    area_pct_diff,
  },
  photos: {
    hemnet_gallery: [{ file, label }],   // label always null for Hemnet
    booli_gallery:  [{ file, label }],   // label from Booli primaryLabel
  },
  street_address,
  postcode,
}
```

**D-01 per-pair output record shape** (from RESEARCH.md §Probe Design):
```javascript
// Each row in the probe report:
{
  pair_id,
  provisional,
  triage_flags: [],          // flags from classifyDeterministic
  priceAgrees: bool,         // price_pct_diff <= 0.05
  dHash: {
    minDist: number,
    confirmed: bool,         // under proposed D-02 rules
    sharedCount: number,
    distinct: bool,
    hasFloorplanOnly: bool,
  },
  current_verdict: string,   // what current Branch 2 produces
  proposed_verdict: string,  // what D-02 + D-05 would produce
  wouldRouteToVision: bool,  // proposed_verdict !== CONFIRMED_MATCH && has both galleries
  vision_cost_est: '$0.042', // constant per pair that would go to vision
  isMultiUnit: bool,
  booliIsNewConstruction: bool,  // from artifact if available; else null
  hasFloorplanBooli: bool,   // any booli_gallery[i].label === 'floorplan'
}
```

---

## Shared Patterns

### --smoke self-test framework
**Source:** `lib/spotcheck-adjudicate.js` (lines 146–331), `lib/spotcheck-dhash.js` (lines 79–146), `lib/spotcheck-vision.js` (lines 186–269)
**Apply to:** All `lib/spotcheck-*.js` modifications — any new function or new branch must have a corresponding `--smoke` case.

Core pattern for synchronous cases:
```javascript
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  // ... sync cases ...
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

Core pattern for async cases (required in spotcheck-dhash.js and spotcheck-vision.js):
```javascript
  (async () => {
    async function checkAsync(name, fn) {
      try { await fn(); pass++; }
      catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
    }
    // ... async cases ...
    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
```

### DB client (createClient)
**Source:** `db.js` (lines 1–16)
**Apply to:** `cohort-spotcheck-gate.js` (already uses it via `runJob`), `scripts/probe-dhash-sizing.js` (new)
```javascript
require('dotenv').config();
const { createClient } = require('../db');  // from scripts/
// or
const { createClient } = require('./db');   // from root

const client = createClient();
await client.connect();
// ... use client.query('...', [$1]) with parameterized placeholders ...
try { await client.end(); } catch (_) {}
```

### Error handling — never throw from dHash or vision
**Source:** `lib/spotcheck-dhash.js` (lines 46–50, hashAll), `lib/spotcheck-vision.js` (lines 169–172)
**Apply to:** All new functions in `lib/spotcheck-dhash.js` and `lib/spotcheck-vision.js`
```javascript
// hashAll: skip unreadable files, never throws:
async function hashAll(files) {
  const out = [];
  for (const f of files) {
    try { out.push(await hashImage(f)); }
    catch (e) { console.warn(`spotcheck-dhash: skipping unreadable file ${path.basename(f)}: ${e.message}`); }
  }
  return out;
}

// vision: all errors return null, never throw to caller:
} catch (err) {
  console.warn(`[spotcheck-vision] API error for pair ${p.pair_id}: ${err.message}`);
  return null;
}
```

### Parameterized SQL queries (no injection risk)
**Source:** `cohort-spotcheck.js` (lines 152–168), `cohort-spotcheck-gate.js` (lines 113–119)
**Apply to:** Multi-unit address detection query in `cohort-spotcheck-gate.js`, any probe DB queries
```javascript
// All DB queries use $N placeholders — never string interpolation:
await client.query(
  'SELECT ... WHERE cohort_id = $1 AND foo = $2',
  [cohortId, value]
);
```

### Booli floorplan label constant (single definition)
**Source:** Defined in RESEARCH.md and proposed for `lib/spotcheck-dhash.js` (new function section above)
**Apply to:** `lib/spotcheck-dhash.js` (filterDiscriminatingFiles), `lib/spotcheck-vision.js` (pre-filter before image blocks)
```javascript
// Define once in each module that needs it (they are separate modules, no shared config):
const NON_DISCRIMINATING_LABELS = new Set(['floorplan', 'property_map', 'nearby_area']);
```

### Artifact JSON parse with error wrapping
**Source:** `cohort-spotcheck-gate.js` (lines 183–190)
**Apply to:** `scripts/probe-dhash-sizing.js` when reading an existing artifact
```javascript
let artifact;
try {
  artifact = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse spot-check artifact ${jsonPath}: ${err.message}`);
}
if (!Array.isArray(artifact.pairs)) {
  throw new Error(`Spot-check artifact ${jsonPath} has no pairs[] array`);
}
```

---

## No Analog Found

No files in Phase 14 have zero analog. All are either self-modifications of existing files or probes following established probe + artifact patterns.

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| — | — | — | All files have strong analogs |

---

## Metadata

**Analog search scope:** `lib/spotcheck-*.js`, `cohort-spotcheck-gate.js`, `cohort-spotcheck.js`, `spotcheck-photos.js`, `scripts/probe-*.js`, `db.js`
**Files read:** 11 source files (all relevant lib modules, gate orchestrator, 2 probe scripts, db.js)
**Pattern extraction date:** 2026-06-11
