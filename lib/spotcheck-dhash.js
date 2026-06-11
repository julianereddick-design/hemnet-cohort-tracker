// lib/spotcheck-dhash.js
//
// Deterministic dHash (gradient hash) cross-comparison for Booli<->Hemnet gallery pairs.
// Extracted from scripts/spotcheck-phash-probe.js. Pure-JS via jimp. No DB, no network.
//
// Usage:
//   const { minDHashDistance } = require('./lib/spotcheck-dhash');
//   node lib/spotcheck-dhash.js --smoke

'use strict';

const fs   = require('fs');
const path = require('path');
// jimp v1.x exports a named Jimp class; destructure rather than use the default export.
const { Jimp } = require('jimp');

// ---------- dHash: 9x8 greyscale, adjacent-pixel gradient -> 64 bits ----------
async function dhash(img9x8) {
  const W = 9;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left  = img9x8.bitmap.data[(y * W + x)       * 4];
      const right = img9x8.bitmap.data[(y * W + (x + 1)) * 4];
      bits += left > right ? '1' : '0';
    }
  }
  return bits;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function hashImage(file) {
  // Jimp.read is a static method on the named class (jimp v1.x API).
  // resize takes { w, h } in v1.x (not positional args like v0.x).
  const base = await Jimp.read(file);
  const d = await dhash(base.clone().resize({ w: 9, h: 8 }).greyscale());
  return { file: path.basename(file), d };
}

async function hashAll(files) {
  const out = [];
  for (const f of files) {
    try { out.push(await hashImage(f)); } catch (e) { console.warn(`spotcheck-dhash: skipping unreadable file ${path.basename(f)}: ${e.message}`); }
  }
  return out;
}

// ---------------------------------------------------------------
// minDHashDistance(booliFiles, hemnetFiles) -> { minDist, bFile, hFile }
//
// booliFiles / hemnetFiles are arrays of ABSOLUTE file paths.
// Returns { minDist: 64, bFile: null, hFile: null } when either side has no readable images.
// Never throws — unreadable images are skipped (hashAll), errors logged to console.warn.
// ---------------------------------------------------------------
async function minDHashDistance(booliFiles, hemnetFiles) {
  const booli  = await hashAll(booliFiles  || []);
  const hemnet = await hashAll(hemnetFiles || []);
  let best = { minDist: 64, bFile: null, hFile: null };
  for (const b of booli) {
    for (const h of hemnet) {
      const dist = hamming(b.d, h.d);
      if (dist < best.minDist) best = { minDist: dist, bFile: b.file, hFile: h.file };
    }
  }
  return best;
}

// ---------------------------------------------------------------
// Phase 14: label-based non-discriminating-image exclusion + all-pairs
// shared-photo matching with distinct-scene counting.
// ---------------------------------------------------------------

// Image labels that must NEVER count as same-property proof: floorplans
// (identical across units in a building/development), maps, area shots.
// Booli labels are lowercase ('floorplan', 'property_map', 'nearby_area');
// Hemnet Apollo labels are UPPERCASE ('FLOOR_PLAN') — compare case-insensitively.
const NON_DISCRIMINATING_LABELS = new Set(['floorplan', 'floor_plan', 'property_map', 'nearby_area']);

// entries: [{ file, label }] — returns only entries whose label is NOT in the
// exclusion set. Null/missing labels pass through (no label is no evidence of
// being a floorplan; heuristic exclusion was deliberately dropped per D-10).
function filterDiscriminating(entries) {
  return (entries || []).filter((e) => {
    const l = e && e.label != null ? String(e.label).toLowerCase() : null;
    return !(l && NON_DISCRIMINATING_LABELS.has(l));
  });
}

// Pure matcher over precomputed hashes ([{ file, d }] from hashAll).
// Returns ALL cross-pairs within threshold plus a distinct-scene count:
// matches are greedily accepted (closest first) only if BOTH sides' hashes
// differ from every already-accepted match by > threshold — so a hero photo
// duplicated in a gallery cannot count as two shared scenes.
function sharedFromHashes(booliHashes, hemnetHashes, threshold) {
  const t = Number.isFinite(threshold) ? threshold : 6;
  const all = [];
  for (const b of booliHashes || []) {
    for (const h of hemnetHashes || []) {
      const dist = hamming(b.d, h.d);
      if (dist <= t) all.push({ bFile: b.file, hFile: h.file, bHash: b.d, hHash: h.d, dist });
    }
  }
  all.sort((a, b) => a.dist - b.dist);
  const accepted = [];
  for (const m of all) {
    const dupe = accepted.some(
      (a) => hamming(a.bHash, m.bHash) <= t || hamming(a.hHash, m.hHash) <= t
    );
    if (!dupe) accepted.push(m);
  }
  let minDist = 64;
  for (const b of booliHashes || []) {
    for (const h of hemnetHashes || []) {
      const dist = hamming(b.d, h.d);
      if (dist < minDist) minDist = dist;
    }
  }
  return {
    minDist,
    matches: all.map(({ bFile, hFile, dist }) => ({ bFile, hFile, dist })),
    sharedCount: accepted.length,
  };
}

// File-path convenience wrapper (hashes internally; never throws).
async function sharedPhotoPairs(booliFiles, hemnetFiles, threshold) {
  const booli = await hashAll(booliFiles || []);
  const hemnet = await hashAll(hemnetFiles || []);
  return sharedFromHashes(booli, hemnet, threshold);
}

module.exports = {
  minDHashDistance,
  hashAll,
  hamming,
  NON_DISCRIMINATING_LABELS,
  filterDiscriminating,
  sharedFromHashes,
  sharedPhotoPairs,
};

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network, no real images required).
//   node lib/spotcheck-dhash.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- hamming: identical string → 0 ---
  check('hamming(x,x) === 0', () => {
    assert.strictEqual(hamming('10101010', '10101010'), 0);
  });

  // --- hamming: one bit flip → 1 ---
  check('hamming with 1 bit flip === 1', () => {
    assert.strictEqual(hamming('10101010', '10101011'), 1);
  });

  // --- hamming: all bits differ → length ---
  check('hamming(all zeros, all ones) === length', () => {
    const a = '0'.repeat(64);
    const b = '1'.repeat(64);
    assert.strictEqual(hamming(a, b), 64);
  });

  (async () => {
    // --- empty arrays → { minDist: 64, bFile: null, hFile: null } ---
    await checkAsync('minDHashDistance([], []) → { minDist: 64 }', async () => {
      const result = await minDHashDistance([], []);
      assert.strictEqual(result.minDist, 64);
      assert.strictEqual(result.bFile, null);
      assert.strictEqual(result.hFile, null);
    });

    // --- unreadable files are skipped, returns sentinel without throwing ---
    await checkAsync('minDHashDistance([nonexistent], [nonexistent]) → { minDist: 64 } no throw', async () => {
      const result = await minDHashDistance(['/no/such/a.jpg'], ['/no/such/b.jpg']);
      assert.strictEqual(result.minDist, 64);
      assert.strictEqual(result.bFile, null);
      assert.strictEqual(result.hFile, null);
    });

    // --- null/undefined inputs treated as empty ---
    await checkAsync('minDHashDistance(null, null) → { minDist: 64 } no throw', async () => {
      const result = await minDHashDistance(null, null);
      assert.strictEqual(result.minDist, 64);
    });

    // --- one side empty → sentinel ---
    await checkAsync('minDHashDistance([], [nonexistent]) → { minDist: 64 }', async () => {
      const result = await minDHashDistance([], ['/no/such/b.jpg']);
      assert.strictEqual(result.minDist, 64);
    });

    // --- filterDiscriminating: drops floorplan labels both casings, keeps null ---
    check('filterDiscriminating drops floorplan/FLOOR_PLAN, keeps interior + null', () => {
      const out = filterDiscriminating([
        { file: 'a.jpg', label: 'floorplan' },
        { file: 'b.jpg', label: 'FLOOR_PLAN' },
        { file: 'c.jpg', label: 'interior' },
        { file: 'd.jpg', label: null },
        { file: 'e.jpg', label: 'property_map' },
      ]);
      assert.deepStrictEqual(out.map((e) => e.file), ['c.jpg', 'd.jpg']);
    });

    // --- sharedFromHashes: identical pair matches; duplicated scene counts once ---
    check('sharedFromHashes counts distinct scenes (dupe hero = 1)', () => {
      const sceneA = '1'.repeat(32) + '0'.repeat(32);
      const sceneAish = '1'.repeat(32) + '0'.repeat(30) + '11'; // dist 2 from sceneA
      const sceneB = '0'.repeat(64);
      const r = sharedFromHashes(
        [{ file: 'b1', d: sceneA }, { file: 'b2', d: sceneAish }, { file: 'b3', d: sceneB }],
        [{ file: 'h1', d: sceneA }, { file: 'h2', d: sceneB }],
        6
      );
      assert.strictEqual(r.minDist, 0);
      // b1↔h1 (0), b2↔h1 (2), b3↔h2 (0) are all within threshold...
      assert.strictEqual(r.matches.length, 3);
      // ...but b2 is the same SCENE as b1 (dist 2 ≤ 6) so distinct scenes = 2 (A + B)
      assert.strictEqual(r.sharedCount, 2);
    });

    // --- sharedFromHashes: nothing within threshold → 0 matches, real minDist ---
    check('sharedFromHashes no-match keeps minDist', () => {
      const r = sharedFromHashes(
        [{ file: 'b1', d: '1'.repeat(64) }],
        [{ file: 'h1', d: '0'.repeat(64) }],
        6
      );
      assert.strictEqual(r.matches.length, 0);
      assert.strictEqual(r.sharedCount, 0);
      assert.strictEqual(r.minDist, 64);
    });

    // --- sharedPhotoPairs: unreadable files → sentinel, no throw ---
    await checkAsync('sharedPhotoPairs unreadable → empty result no throw', async () => {
      const r = await sharedPhotoPairs(['/no/such/a.jpg'], ['/no/such/b.jpg'], 6);
      assert.strictEqual(r.sharedCount, 0);
      assert.strictEqual(r.minDist, 64);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
