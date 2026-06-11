// scripts/spotcheck-phash-probe.js
//
// One-off probe: can a deterministic perceptual hash confirm that a
// Booli<->Hemnet pair shares >=1 image — WITHOUT a vision model?
//
// Computes BOTH dHash (gradient) and pHash (DCT, low-frequency) for every image,
// then per pair cross-compares every Booli image against every Hemnet image (the
// nested loop) and keeps the closest pair under each hash. Ground truth (verdict
// + provisional) comes from the artifact JSON so we can see whether real matches
// share an image and the known false-match (16347) does not.
//
//   node scripts/spotcheck-phash-probe.js [artifactDir]

'use strict';

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const ARTIFACT = process.argv[2] || 'verf-spotcheck-2026-W23-20260610-131907';
const PHOTOS = path.join(ARTIFACT, 'photos');

// ---------- dHash: 9x8 greyscale, adjacent-pixel gradient -> 64 bits ----------
async function dhash(img9x8) {
  const W = 9;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = img9x8.bitmap.data[(y * W + x) * 4];
      const right = img9x8.bitmap.data[(y * W + (x + 1)) * 4];
      bits += left > right ? '1' : '0';
    }
  }
  return bits;
}

// ---------- pHash: 32x32 greyscale -> 2D DCT -> top-left 8x8 vs median --------
const N = 32; // DCT input size
const M = 8;  // low-freq block kept
// precompute cosine table once: COS[k][x] = cos((2x+1)*k*PI/(2N))
const COS = [];
for (let k = 0; k < N; k++) {
  COS[k] = [];
  for (let x = 0; x < N; x++) COS[k][x] = Math.cos(((2 * x + 1) * k * Math.PI) / (2 * N));
}
function phashFromMatrix(f) {
  // f is N x N grayscale (row-major f[y][x]); compute top-left M x M DCT-II coeffs
  const F = [];
  for (let u = 0; u < M; u++) {
    F[u] = [];
    for (let v = 0; v < M; v++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        const cy = COS[v][y];
        const row = f[y];
        for (let x = 0; x < N; x++) sum += row[x] * COS[u][x] * cy;
      }
      F[u][v] = sum; // alpha scaling omitted — monotonic, irrelevant to median threshold
    }
  }
  // median over the block EXCLUDING the DC term [0][0] (it's overall brightness)
  const vals = [];
  for (let u = 0; u < M; u++) for (let v = 0; v < M; v++) if (!(u === 0 && v === 0)) vals.push(F[u][v]);
  const sorted = vals.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let bits = '';
  for (let u = 0; u < M; u++) for (let v = 0; v < M; v++) bits += F[u][v] > med ? '1' : '0';
  return bits;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function hashImage(file) {
  // dHash needs 9x8, pHash needs 32x32 — read once, two resized copies
  const base = await Jimp.read(file);
  const d = await dhash(base.clone().resize(9, 8).greyscale());
  const big = base.clone().resize(N, N).greyscale();
  const f = [];
  for (let y = 0; y < N; y++) {
    f[y] = [];
    for (let x = 0; x < N; x++) f[y][x] = big.bitmap.data[(y * N + x) * 4];
  }
  return { file: path.basename(file), d, p: phashFromMatrix(f) };
}

function listImages(dir, prefix) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().startsWith(prefix) && /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(dir, f));
}

async function hashAll(files) {
  const out = [];
  for (const f of files) {
    try { out.push(await hashImage(f)); } catch (e) { /* skip unreadable */ }
  }
  return out;
}

(async () => {
  let pairs = [];
  try {
    const jf = fs.readdirSync(ARTIFACT).find((f) => /^spotcheck-.+\.json$/.test(f));
    const j = JSON.parse(fs.readFileSync(path.join(ARTIFACT, jf), 'utf8'));
    pairs = j.pairs || (j.artifact && j.artifact.pairs) || [];
  } catch (e) { console.error('could not load artifact json:', e.message); }
  const label = {};
  for (const p of pairs) label[p.pair_id] = { provisional: p.provisional, verdict: p.verdict };

  const dirs = fs.readdirSync(PHOTOS).filter((d) => /^pair\d+$/.test(d)).map((d) => path.join(PHOTOS, d));
  const rows = [];

  for (const dir of dirs) {
    const pid = path.basename(dir).replace('pair', '');
    const booliFiles = listImages(dir, 'booli_');
    const hemnetFiles = listImages(dir, 'hemnet_');
    if (booliFiles.length === 0 || hemnetFiles.length === 0) continue;

    const booli = await hashAll(booliFiles);
    const hemnet = await hashAll(hemnetFiles);

    let bestD = { dist: 64, b: null, h: null };
    let bestP = { dist: 64, b: null, h: null };
    for (const b of booli) {
      for (const h of hemnet) {
        const dd = hamming(b.d, h.d);
        if (dd < bestD.dist) bestD = { dist: dd, b: b.file, h: h.file };
        const pp = hamming(b.p, h.p);
        if (pp < bestP.dist) bestP = { dist: pp, b: b.file, h: h.file };
      }
    }
    const lab = label[pid] || {};
    rows.push({ pid, verdict: lab.verdict || '?', prov: lab.provisional || '?', dMin: bestD.dist, pMin: bestP.dist, pB: bestP.b, pH: bestP.h });
  }

  rows.sort((a, b) => a.pMin - b.pMin);

  console.log('\n=== dHash vs pHash — min Hamming distance per pair (lower = more likely shared image) ===');
  console.log('pair     truth(verdict/prov)      dHashMin  pHashMin   pHash closest match');
  for (const r of rows) {
    console.log(
      `${r.pid.padEnd(8)} ${(r.verdict + '/' + r.prov).padEnd(23)} ` +
        `${String(r.dMin).padStart(7)}   ${String(r.pMin).padStart(7)}    ${r.pB} ~ ${r.pH}`
    );
  }

  console.log('\n=== separation check (key: hard true-match 15647 vs true-mismatch 16347) ===');
  for (const hash of ['dMin', 'pMin']) {
    const tMatch = rows.filter((r) => r.verdict === 'MATCH');
    const tMis = rows.filter((r) => r.verdict === 'MISMATCH');
    const worstMatch = Math.max(...tMatch.map((r) => r[hash])); // hardest true-match
    const bestMis = Math.min(...tMis.map((r) => r[hash]));       // closest true-mismatch
    const gap = bestMis - worstMatch;
    console.log(
      `${hash === 'dMin' ? 'dHash' : 'pHash'}: hardest true-MATCH=${worstMatch}, closest true-MISMATCH=${bestMis}, ` +
        `gap=${gap} ${gap > 0 ? '(separable)' : '(OVERLAP — no safe threshold)'}`
    );
  }
})().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });
