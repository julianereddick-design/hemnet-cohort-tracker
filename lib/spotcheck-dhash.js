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

module.exports = { minDHashDistance };

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

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
