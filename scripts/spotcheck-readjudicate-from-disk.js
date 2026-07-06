#!/usr/bin/env node
/**
 * spotcheck-readjudicate-from-disk.js — recovery tool.
 *
 * When the weekly gate (cohort-spotcheck-gate.js) runs but spotcheck-photos.js
 * dies before writing galleries back into the artifact JSON (incident 2026-W27),
 * the gate adjudicates every pair as a false "no-photos" UNCERTAIN and floods the
 * review channel. The photos were still DOWNLOADED to <dir>/photos/pair<ID>/ —
 * only the JSON write-back was lost. This tool reconstructs the gallery arrays
 * from those on-disk images, re-runs the SAME dHash + adjudication the gate would
 * have, and prints the REAL (much shorter) list of pairs that actually need human
 * review. No network, no Oxylabs, no Slack posting — read-only recovery.
 *
 * Limitations (recovery is best-effort, no re-fetch):
 *   - Unit fields (fee/floor) are NOT on disk, so fee-exact confirmations and
 *     fee/floor conflict routing are unavailable — a few pairs that the live gate
 *     would have MATCH-ed on fee may show here as UNCERTAIN (conservative).
 *   - Image labels are recovered from filenames; FLOOR_PLAN exclusion works,
 *     but property_map/nearby_area tags lose their underscore and are not excluded.
 *
 * Usage:
 *   node scripts/spotcheck-readjudicate-from-disk.js <artifact-dir> [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { adjudicatePairs } = require('../lib/spotcheck-adjudicate');
const { sharedPhotoPairs, filterDiscriminating } = require('../lib/spotcheck-dhash');

function die(msg) { console.error(msg); process.exit(1); }

// Reconstruct one side's gallery [{ file, label }] from a pair's photo dir.
// dlGallery names gallery images "<side>_NN[_label].jpg" starting at NN=01; the
// hero is "<side>_00_hero.jpg" and is NOT part of the gallery arrays the gate
// hashed, so exclude it. Label is the filename tag (matches how dlGallery wrote
// it: alnum-only, truncated); null when absent.
function reconstructGallery(pairDirAbs, pairDirRel, side) {
  let files;
  try { files = fs.readdirSync(pairDirAbs); } catch (_) { return []; }
  const re = new RegExp(`^${side}_(\\d{2})(?:_([A-Za-z0-9]+))?\\.jpg$`);
  const out = [];
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    if (m[1] === '00') continue;               // hero, not a gallery entry
    if (m[2] && /^hero$/i.test(m[2])) continue; // defensive
    out.push({ idx: parseInt(m[1], 10), file: `${pairDirRel}/${f}`, label: m[2] || null });
  }
  out.sort((a, b) => a.idx - b.idx);
  return out.map(({ file, label }) => ({ file, label }));
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) die('usage: node scripts/spotcheck-readjudicate-from-disk.js <artifact-dir> [--json]');
  if (!fs.existsSync(dir)) die(`no such dir: ${dir}`);

  const jsonFile = fs.readdirSync(dir).find((f) => /^spotcheck-.+\.json$/.test(f));
  if (!jsonFile) die(`no spotcheck-*.json in ${dir}`);
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), 'utf8'));
  const cohortId = (artifact.meta && artifact.meta.cohort_id) || jsonFile.replace(/^spotcheck-|\.json$/g, '');
  const pairs = artifact.pairs || [];

  const DHASH_THRESHOLD = parseInt(process.env.DHASH_THRESHOLD || '6', 10);
  const dhashResults = {};
  let reconstructed = 0;

  for (const p of pairs) {
    const pairDirRel = `photos/pair${p.pair_id}`;
    const pairDirAbs = path.join(dir, pairDirRel);
    const hAll = reconstructGallery(pairDirAbs, pairDirRel, 'hemnet');
    const bAll = reconstructGallery(pairDirAbs, pairDirRel, 'booli');
    // Re-attach galleries so the adjudicator's hasPhotos/no-photos logic matches the gate.
    p.photos = Object.assign({}, p.photos, { hemnet_gallery: hAll, booli_gallery: bAll });
    if (hAll.length && bAll.length) reconstructed++;
    if (bAll.length === 0 || hAll.length === 0) continue;

    const bUse = filterDiscriminating(bAll);
    const hUse = filterDiscriminating(hAll);
    if (bUse.length === 0 || hUse.length === 0) {
      dhashResults[p.pair_id] = { minDist: 64, confirmed: false, sharedCount: 0, threshold: DHASH_THRESHOLD };
      continue;
    }
    const r = await sharedPhotoPairs(
      bUse.map((g) => path.join(dir, g.file)),
      hUse.map((g) => path.join(dir, g.file)),
      DHASH_THRESHOLD
    );
    const needed = (bUse.length <= 2 || hUse.length <= 2) ? 1 : 2;
    dhashResults[p.pair_id] = {
      minDist: r.minDist, confirmed: r.sharedCount >= needed,
      sharedCount: r.sharedCount, needed, threshold: DHASH_THRESHOLD,
    };
  }

  const verdicts = adjudicatePairs(pairs, { dhashResults });

  const counts = { CONFIRMED_MATCH: 0, CONFIRMED_MISMATCH: 0, UNCERTAIN: 0 };
  for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  const needReview = verdicts.filter((v) => v.verdict === 'UNCERTAIN' || v.verdict === 'CONFIRMED_MISMATCH');

  if (asJson) {
    console.log(JSON.stringify({ cohortId, reconstructed, counts, needReview: needReview.map((v) => ({
      pair_id: v.pair_id, verdict: v.verdict, source: v.verdict_source, reason: v.verdict_reason,
      dhash: dhashResults[v.pair_id] || null,
    })) }, null, 2));
    return;
  }

  const out = [];
  out.push(`RECOVERY re-adjudication — cohort ${cohortId}`);
  out.push(`galleries reconstructed from disk for ${reconstructed}/${pairs.length} pairs`);
  out.push(`verdicts: CONFIRMED_MATCH=${counts.CONFIRMED_MATCH} · UNCERTAIN=${counts.UNCERTAIN} · CONFIRMED_MISMATCH=${counts.CONFIRMED_MISMATCH}`);
  out.push('');
  out.push(`>>> ${needReview.length} pair(s) actually need review (vs ${pairs.length} messaged in the failed run):`);
  out.push('');
  const order = { CONFIRMED_MISMATCH: 0, UNCERTAIN: 1 };
  needReview.sort((a, b) => (order[a.verdict] - order[b.verdict]) || a.pair_id - b.pair_id);
  for (const v of needReview) {
    const d = dhashResults[v.pair_id];
    const dh = !d ? 'no galleries'
      : d.confirmed ? `dHash CONFIRMED (minDist ${d.minDist}, ${d.sharedCount} scene(s))`
      : `dHash no shared photo (minDist ${d.minDist})`;
    out.push(`[${v.verdict}] pair ${v.pair_id} — ${v.street_address || '(no address)'}, ${v.municipality || ''}`);
    out.push(`  Hemnet: https://www.hemnet.se/bostad/${v.hemnet_id}`);
    out.push(`  Booli:  https://www.booli.se/annons/${v.booli_id}`);
    out.push(`  ${dh} | ${v.verdict_reason}`);
    out.push('');
  }
  console.log(out.join('\n'));
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
