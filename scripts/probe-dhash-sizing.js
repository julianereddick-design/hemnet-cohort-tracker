#!/usr/bin/env node
/**
 * scripts/probe-dhash-sizing.js — Phase 14 Plan 14-01 sizing + trust probe (D-01).
 *
 * Runs the CURRENT spot-check pipeline and the PROPOSED identity-model rules
 * side-by-side over a full cohort sample (N=200+) and reports:
 *
 *   T1  Fee coverage & power     — % of apartment pairs with exact fee on both
 *                                  sides; agree/contradict distribution.
 *   T2  Verdict redistribution   — current gate verdict vs proposed verdict,
 *                                  pair by pair (the operator trust dataset).
 *   T3  Gallery-cap test (D-11)  — dHash at cap-6 vs FULL galleries; how many
 *                                  pairs flip to shared-photo; where the best
 *                                  match sits in gallery order.
 *   T4  Label-filter effect      — dHash before/after excluding floorplan/
 *                                  property_map/nearby_area images (D-10);
 *                                  counts auto-confirms that relied on a
 *                                  non-discriminating image (Type 3 risk).
 *   T5  Residue & cost           — how many pairs would need vision/human under
 *                                  candidate routings, priced in $; 20% vs 100%
 *                                  coverage economics.
 *
 * Usage (droplet — DB + Oxylabs reachable there):
 *   node scripts/probe-dhash-sizing.js --cohort 2026-W23 --rate 0.20
 *   node scripts/probe-dhash-sizing.js --dir verf-spotcheck-2026-W23-<ts>   # reuse artifact
 *   Flags: --max 30 (gallery cap for the FULL-gallery test) --conc 5
 *          --keep-images (skip post-hash cleanup of images beyond index 6)
 *
 * Read-only against the DB. Writes PROBE-<cohort>.md + probe-<cohort>.json
 * into the artifact dir. Deletes gallery images beyond index 6 after hashing
 * (hashes are persisted) so the artifact stays small; --keep-images disables.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createClient } = require('../db');
const { hashAll, sharedFromHashes, filterDiscriminating, NON_DISCRIMINATING_LABELS } = require('../lib/spotcheck-dhash');
const { adjudicatePair } = require('../lib/spotcheck-adjudicate');
const { wilson95 } = require('../lib/spotcheck-summary');

// ---- candidate-rule constants (the PROPOSED design being sized) ----
const DHASH_THRESHOLD = parseInt(process.env.DHASH_THRESHOLD || '6', 10);
const PRICE_AGREE = 0.05;       // adjudicate-level price agreement
const AREA_AGREE = 0.07;        // triage area threshold reused as agreement bound
const FEE_TOLERANCE = 0;        // exact-kr equality; near-misses recorded for calibration
const VISION_COST_PER_CALL = 0.042; // ~12 images @ sonnet pricing (RESEARCH.md)
const OXYLABS_COST_PER_CALL = 0.005;

function log(level, msg) { console.log(`${new Date().toISOString()} [${level}] ${msg}`); }

function parseArgs(argv) {
  const a = { rate: 0.20, conc: 5, max: 30, keepImages: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dir') a.dir = argv[++i];
    else if (t === '--cohort') a.cohort = argv[++i];
    else if (t === '--rate') a.rate = parseFloat(argv[++i]);
    else if (t === '--max') a.max = Math.max(6, parseInt(argv[++i], 10) || 30);
    else if (t === '--conc') a.conc = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (t === '--keep-images') a.keepImages = true;
  }
  return a;
}

function latestArtifactDir() {
  const dirs = fs.readdirSync('.').filter((d) => /^verf-spotcheck-.+/.test(d) && fs.statSync(d).isDirectory());
  return dirs.length ? dirs.sort().pop() : null;
}

function loadArtifact(dir) {
  const jsonFile = fs.readdirSync(dir).find((f) => /^spotcheck-.+\.json$/.test(f));
  if (!jsonFile) throw new Error(`no spotcheck-*.json in ${dir}`);
  const p = path.join(dir, jsonFile);
  return { artifact: JSON.parse(fs.readFileSync(p, 'utf8')), jsonPath: p };
}

const pct = (n, d) => (d > 0 ? ((100 * n) / d).toFixed(1) + '%' : '—');

// ---- proposed identity-model verdict (candidate rules; production version
//      lands in lib/spotcheck-adjudicate.js after this probe sizes it) ----
function proposedVerdict(p, dh, isMultiUnit) {
  const d = p.deltas || {};
  const hu = p.hemnet_unit || {};
  const bu = p.booli_unit || {};
  const priceAgrees = d.price_pct_diff != null && d.price_pct_diff <= PRICE_AGREE;
  const areaAgrees = d.area_pct_diff != null && d.area_pct_diff <= AREA_AGREE;

  const feeBoth = hu.fee != null && bu.rent != null;
  const feeMatch = feeBoth && Math.abs(hu.fee - bu.rent) <= FEE_TOLERANCE;
  const feeContradict = feeBoth && Math.abs(hu.fee - bu.rent) > FEE_TOLERANCE;

  const floorBoth = hu.floor != null && bu.floor != null;
  const floorMatch = floorBoth && hu.floor === bu.floor;
  const floorContradict = floorBoth && hu.floor !== bu.floor;

  // photo correspondence = label-filtered FULL-gallery shared scenes; ≥2 distinct
  // scenes, relaxed to ≥1 when either side has ≤2 usable images (Pitfall 2).
  const tiny = dh && (dh.fullFiltered.bCount <= 2 || dh.fullFiltered.hCount <= 2);
  const needed = tiny ? 1 : 2;
  const photoShared = !!dh && dh.fullFiltered.sharedCount >= needed;

  const unitAgrees = [feeMatch, floorMatch, photoShared].filter(Boolean).length;
  const totalAgrees = unitAgrees + [priceAgrees, areaAgrees].filter(Boolean).length;

  const familyMismatch = d.family_match === false;
  const bothFieldGap = (d.price_pct_diff != null && d.price_pct_diff > 0.12) && (d.area_pct_diff != null && d.area_pct_diff > AREA_AGREE);

  if (feeContradict || floorContradict || familyMismatch || bothFieldGap) {
    const why = feeContradict ? `fee differs (H ${hu.fee} vs B ${bu.rent})`
      : floorContradict ? `floor differs (H ${hu.floor} vs B ${bu.floor})`
        : familyMismatch ? 'family mismatch' : 'price+area both diverge';
    return { verdict: 'CONFIRMED_MISMATCH', why, signals: { feeMatch, floorMatch, photoShared, priceAgrees, areaAgrees } };
  }
  if (unitAgrees >= 1 && totalAgrees >= 2) {
    const why = [feeMatch && 'fee exact', floorMatch && 'floor', photoShared && `shared photo×${dh.fullFiltered.sharedCount}`, priceAgrees && 'price', areaAgrees && 'area'].filter(Boolean).join(' + ');
    return { verdict: 'CONFIRMED_MATCH', why, signals: { feeMatch, floorMatch, photoShared, priceAgrees, areaAgrees } };
  }
  const why = isMultiUnit && priceAgrees ? 'multi-unit address; no unit-level signal' : 'insufficient evidence';
  return { verdict: 'UNCERTAIN', why, signals: { feeMatch, floorMatch, photoShared, priceAgrees, areaAgrees } };
}

// emulate what the CURRENT live gate decides (Mode A adjudicate + cap-6
// unfiltered dHash promotion of UNCERTAIN; vision approximated as not-run —
// it only fires on suspects, ~3% of pairs, and needs an API key)
function currentVerdict(p, dh) {
  const r = adjudicatePair(p);
  if (r.verdict === 'UNCERTAIN' && dh && dh.cap6Unfiltered.minDist <= DHASH_THRESHOLD) {
    return { verdict: 'CONFIRMED_MATCH', source: 'dhash-promote' };
  }
  return { verdict: r.verdict, source: r.source };
}

(async () => {
  const args = parseArgs(process.argv);
  let dir = args.dir;

  // ---- Step 0: build artifact if not reusing one ----
  if (!dir) {
    const sc = ['cohort-spotcheck.js', '--rate', String(args.rate), '--conc', String(args.conc)];
    if (args.cohort) sc.push('--cohort', args.cohort);
    log('INFO', `running: node ${sc.join(' ')}`);
    execFileSync('node', sc, { stdio: 'inherit' });
    dir = latestArtifactDir();
    if (!dir) throw new Error('cohort-spotcheck.js produced no artifact dir');
    log('INFO', `running: node spotcheck-photos.js ${dir} --all --gallery --max ${args.max} --conc ${args.conc}`);
    execFileSync('node', ['spotcheck-photos.js', dir, '--all', '--gallery', '--max', String(args.max), '--conc', String(args.conc)], { stdio: 'inherit' });
  }
  const { artifact, jsonPath } = loadArtifact(dir);
  const cohortId = artifact.meta.cohort_id;
  const pairs = artifact.pairs || [];
  log('INFO', `probe over ${pairs.length} sampled pairs of ${cohortId} (artifact ${dir})`);

  // ---- Step 1: multi-unit set from full cohort (read-only; in-sample fallback) ----
  let multiUnit = new Set();
  let multiUnitSource = 'db';
  let cohortSize = null;
  try {
    const client = createClient();
    await client.connect();
    const mu = await client.query(
      `SELECT LOWER(TRIM(street_address)) AS addr, postcode
       FROM cohort_pairs WHERE cohort_id = $1
       GROUP BY LOWER(TRIM(street_address)), postcode HAVING COUNT(*) > 1`, [cohortId]);
    multiUnit = new Set(mu.rows.map((r) => `${r.addr}|${r.postcode}`));
    const sz = await client.query('SELECT COUNT(*)::int AS n FROM cohort_pairs WHERE cohort_id = $1', [cohortId]);
    cohortSize = sz.rows[0].n;
    await client.end();
  } catch (e) {
    multiUnitSource = `in-sample fallback (db: ${e.message})`;
    const counts = {};
    for (const p of pairs) {
      const k = `${String(p.street_address || '').toLowerCase().trim()}|${p.postcode}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    multiUnit = new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }
  log('INFO', `multi-unit addresses: ${multiUnit.size} (${multiUnitSource}); cohort size ${cohortSize ?? 'unknown'}`);

  // ---- Step 2: hash all galleries once; compute the 4 dHash variants ----
  const rows = [];
  let hashed = 0;
  for (const p of pairs) {
    const ph = p.photos || {};
    const bg = ph.booli_gallery || [];
    const hg = ph.hemnet_gallery || [];
    const abs = (g) => ({ file: path.join(dir, g.file), label: g.label || null });
    let dh = null;
    if (bg.length && hg.length) {
      const bAll = await hashAll(bg.map((g) => path.join(dir, g.file)));
      const hAll = await hashAll(hg.map((g) => path.join(dir, g.file)));
      // re-attach labels by gallery order (hashAll keeps order, skips unreadable by basename)
      const labelByBase = (gal) => Object.fromEntries(gal.map((g) => [path.basename(g.file), g.label || null]));
      const bLabels = labelByBase(bg); const hLabels = labelByBase(hg);
      const withLabel = (hs, labels) => hs.map((h) => ({ ...h, label: labels[h.file] ?? null }));
      const bH = withLabel(bAll, bLabels); const hH = withLabel(hAll, hLabels);
      const filt = (hs) => filterDiscriminating(hs.map((h) => ({ ...h, file: h.file, label: h.label }))).map((e) => ({ file: e.file, d: e.d }));
      const v = {
        cap6Unfiltered: sharedFromHashes(bH.slice(0, 6), hH.slice(0, 6), DHASH_THRESHOLD),
        cap6Filtered: sharedFromHashes(filt(bH.slice(0, 6)), filt(hH.slice(0, 6)), DHASH_THRESHOLD),
        fullUnfiltered: sharedFromHashes(bH, hH, DHASH_THRESHOLD),
        fullFiltered: sharedFromHashes(filt(bH), filt(hH), DHASH_THRESHOLD),
      };
      // gallery-order position of the best full-gallery match
      let bestPos = null;
      if (v.fullUnfiltered.matches.length) {
        const m = v.fullUnfiltered.matches[0];
        bestPos = { b: bH.findIndex((x) => x.file === m.bFile), h: hH.findIndex((x) => x.file === m.hFile) };
      }
      dh = {
        ...v,
        bestPos,
        bCount: bH.length, hCount: hH.length,
        fullFiltered: { ...v.fullFiltered, bCount: filt(bH).length, hCount: filt(hH).length },
        floorplanOnlyConfirm: v.cap6Unfiltered.minDist <= DHASH_THRESHOLD && v.cap6Filtered.minDist > DHASH_THRESHOLD,
        hashes: { b: bH.map((x) => ({ f: x.file, d: x.d, l: x.label })), h: hH.map((x) => ({ f: x.file, d: x.d, l: x.label })) },
      };
      hashed++;
    }
    const muKey = `${String(p.street_address || '').toLowerCase().trim()}|${p.postcode}`;
    const isMultiUnit = multiUnit.has(muKey);
    const cur = currentVerdict(p, dh);
    const prop = proposedVerdict(p, dh, isMultiUnit);
    const hu = p.hemnet_unit || {}; const bu = p.booli_unit || {};
    rows.push({
      pair_id: p.pair_id, address: `${p.street_address}, ${p.municipality}`, county: p.county,
      provisional: p.provisional, flags: p.flags || [],
      isApartment: /APARTMENT|läg/i.test(String((p.hemnet && p.hemnet.housing_form) || (p.booli && p.booli.object_type) || '')),
      price_pct: p.deltas ? p.deltas.price_pct_diff : null,
      area_pct: p.deltas ? p.deltas.area_pct_diff : null,
      feeH: hu.fee ?? null, feeB: bu.rent ?? null,
      floorH: hu.floor ?? null, floorB: bu.floor ?? null,
      aptNo: bu.apartmentNumber ?? null, newBuild: bu.isNewConstruction ?? null,
      isMultiUnit,
      dh: dh ? {
        cap6: { minDist: dh.cap6Unfiltered.minDist, shared: dh.cap6Unfiltered.sharedCount },
        cap6f: { minDist: dh.cap6Filtered.minDist, shared: dh.cap6Filtered.sharedCount },
        full: { minDist: dh.fullUnfiltered.minDist, shared: dh.fullUnfiltered.sharedCount },
        fullf: { minDist: dh.fullFiltered.minDist, shared: dh.fullFiltered.sharedCount, bCount: dh.fullFiltered.bCount, hCount: dh.fullFiltered.hCount },
        bestPos: dh.bestPos, bCount: dh.bCount, hCount: dh.hCount,
        floorplanOnlyConfirm: dh.floorplanOnlyConfirm,
      } : null,
      current: cur, proposed: prop,
    });
    // post-hash cleanup: keep first 6 per side (enough for vision later), drop the rest
    if (!args.keepImages && dh) {
      for (const g of [...bg.slice(6), ...hg.slice(6)]) {
        try { fs.unlinkSync(path.join(dir, g.file)); } catch (_) { /* best effort */ }
      }
    }
  }
  log('INFO', `dHash computed for ${hashed}/${pairs.length} pairs (both galleries present)`);

  // ---- Step 3: aggregate the 5 tests ----
  const R = rows;
  const apts = R.filter((r) => r.isApartment);
  const feeBoth = apts.filter((r) => r.feeH != null && r.feeB != null);
  const feeEq = feeBoth.filter((r) => Math.abs(r.feeH - r.feeB) <= FEE_TOLERANCE);
  const feeNear = feeBoth.filter((r) => Math.abs(r.feeH - r.feeB) > FEE_TOLERANCE && Math.abs(r.feeH - r.feeB) <= 0.02 * Math.max(r.feeH, r.feeB));
  const feeDiff = feeBoth.filter((r) => Math.abs(r.feeH - r.feeB) > FEE_TOLERANCE);

  const withDh = R.filter((r) => r.dh);
  const capFlips = withDh.filter((r) => r.dh.full.minDist <= DHASH_THRESHOLD && r.dh.cap6.minDist > DHASH_THRESHOLD);
  const fpOnly = withDh.filter((r) => r.dh.floorplanOnlyConfirm);
  const histBins = [[0, 3], [4, 6], [7, 10], [11, 15], [16, 30], [31, 64]];
  const hist = (sel) => histBins.map(([lo, hi]) => withDh.filter((r) => { const v = sel(r); return v >= lo && v <= hi; }).length);

  const matrix = {};
  for (const r of R) {
    const k = `${r.current.verdict}→${r.proposed.verdict}`;
    matrix[k] = (matrix[k] || 0) + 1;
  }
  const curSilent = R.filter((r) => r.current.verdict === 'CONFIRMED_MATCH');
  const silentNow = {
    stay: curSilent.filter((r) => r.proposed.verdict === 'CONFIRMED_MATCH').length,
    toUncertain: curSilent.filter((r) => r.proposed.verdict === 'UNCERTAIN').length,
    toMismatch: curSilent.filter((r) => r.proposed.verdict === 'CONFIRMED_MISMATCH').length,
  };

  const residue = R.filter((r) => r.proposed.verdict === 'UNCERTAIN');
  const residueWithGalleries = residue.filter((r) => r.dh);
  const residueDelisted = residue.filter((r) => !r.dh);
  const routings = {
    'A: all residue-with-galleries → vision': residueWithGalleries.length,
    'B: only price-agreeing residue → vision': residueWithGalleries.filter((r) => r.price_pct != null && r.price_pct <= PRICE_AGREE).length,
    'C: no vision (all residue → human)': 0,
  };

  const sampleN = R.length;
  const weeklyCalls20 = sampleN * 3; // hemnet evidence + hemnet page + booli page (per current pipeline)
  const fullCohortN = cohortSize || Math.round(sampleN / (args.rate || 0.2));
  const aptShare = apts.length / Math.max(1, sampleN);
  const weeklyCalls100 = Math.round(fullCohortN * (1 + 1 + aptShare)); // booli page only needed where fee matters (apartments)

  const report = {
    meta: { cohortId, dir, generated: new Date().toISOString(), sampleN, cohortSize: fullCohortN, dhashThreshold: DHASH_THRESHOLD, multiUnitSource, nonDiscriminatingLabels: [...NON_DISCRIMINATING_LABELS] },
    t1_fee: {
      apartments: apts.length, aptShare,
      bothFeesPresent: feeBoth.length, bothFeesPct: pct(feeBoth.length, apts.length),
      exactEqual: feeEq.length, exactEqualPct: pct(feeEq.length, feeBoth.length),
      near2pct: feeNear.length,
      contradict: feeDiff.length,
      contradictPairs: feeDiff.map((r) => ({ pair_id: r.pair_id, address: r.address, feeH: r.feeH, feeB: r.feeB, current: r.current.verdict })),
      wilsonBothFees: feeBoth.length && apts.length ? wilson95(feeBoth.length, apts.length) : null,
    },
    t2_redistribution: { matrix, currentSilentConfirms: curSilent.length, silentNow },
    t3_capTest: {
      withBothGalleries: withDh.length,
      sharedAtCap6: withDh.filter((r) => r.dh.cap6.minDist <= DHASH_THRESHOLD).length,
      sharedAtFull: withDh.filter((r) => r.dh.full.minDist <= DHASH_THRESHOLD).length,
      flips: capFlips.length,
      flipPairs: capFlips.map((r) => ({ pair_id: r.pair_id, bestPos: r.dh.bestPos, fullMin: r.dh.full.minDist, cap6Min: r.dh.cap6.minDist })),
      bestPosHistogram: withDh.filter((r) => r.dh.bestPos).reduce((acc, r) => { const m = Math.max(r.dh.bestPos.b, r.dh.bestPos.h); const bin = m <= 5 ? '0-5' : m <= 11 ? '6-11' : m <= 17 ? '12-17' : '18+'; acc[bin] = (acc[bin] || 0) + 1; return acc; }, {}),
    },
    t4_labelFilter: {
      floorplanOnlyConfirms: fpOnly.length,
      floorplanOnlyPairs: fpOnly.map((r) => ({ pair_id: r.pair_id, address: r.address, newBuild: r.newBuild, current: r.current.verdict })),
      histCap6Unfiltered: hist((r) => r.dh.cap6.minDist),
      histFullFiltered: hist((r) => r.dh.fullf.minDist),
      histBins: histBins.map(([a, b]) => `${a}-${b}`),
    },
    t5_residue: {
      residue: residue.length, withGalleries: residueWithGalleries.length, delistedOrNoPhotos: residueDelisted.length,
      multiUnitInSample: R.filter((r) => r.isMultiUnit).length,
      routings: Object.fromEntries(Object.entries(routings).map(([k, n]) => [k, { visionCallsPerWeek: n, visionCostPerWeek: `$${(n * VISION_COST_PER_CALL).toFixed(2)}`, humanQueue: residue.length - n + residueDelisted.length * 0 }])),
      coverage: {
        'current 20% sample': { oxylabsCallsPerWeek: weeklyCalls20, costPerWeek: `$${(weeklyCalls20 * OXYLABS_COST_PER_CALL).toFixed(2)}` },
        '100% structured': { oxylabsCallsPerWeek: weeklyCalls100, costPerWeek: `$${(weeklyCalls100 * OXYLABS_COST_PER_CALL).toFixed(2)}`, note: 'both pages for apartments, hemnet-only for houses; photos only on residue' },
      },
    },
    pairs: rows,
  };

  const jsonOut = path.join(dir, `probe-${cohortId}.json`);
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, `PROBE-${cohortId}.md`), renderMd(report));
  log('INFO', `wrote ${jsonOut} and PROBE-${cohortId}.md`);
  console.log(`Final: ${JSON.stringify({ status: 'success', sampleN, feeBothPct: report.t1_fee.bothFeesPct, feeContradicts: feeDiff.length, capFlips: capFlips.length, floorplanOnly: fpOnly.length, silentConfirmRedistribution: silentNow })}`);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });

function renderMd(rep) {
  const L = [];
  const m = rep.meta;
  L.push(`# Phase 14 sizing + trust probe — ${m.cohortId}`);
  L.push('');
  L.push(`Sample **${m.sampleN}** of ~${m.cohortSize} pairs · dHash threshold ${m.dhashThreshold} · generated ${m.generated}`);
  L.push('');
  L.push('## T1 — Fee coverage & power (the unit-identity signal)');
  const t1 = rep.t1_fee;
  L.push(`- Apartments in sample: **${t1.apartments}** (${pct(t1.apartments, m.sampleN)})`);
  L.push(`- Both fees present (H exact kr + B exact kr): **${t1.bothFeesPresent}** = **${t1.bothFeesPct}** of apartments${t1.wilsonBothFees ? ` (95% CI ${(t1.wilsonBothFees[0] * 100).toFixed(0)}–${(t1.wilsonBothFees[1] * 100).toFixed(0)}%)` : ''}`);
  L.push(`- Exact equal: **${t1.exactEqual}** (${t1.exactEqualPct} of both-present) · within 2% (near-miss, calibration): ${t1.near2pct} · contradict: **${t1.contradict}**`);
  if (t1.contradictPairs.length) {
    L.push('');
    L.push('| pair | address | Hemnet fee | Booli fee | current verdict |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const p of t1.contradictPairs) L.push(`| ${p.pair_id} | ${p.address} | ${p.feeH} | ${p.feeB} | ${p.current} |`);
  }
  L.push('');
  L.push('## T2 — Verdict redistribution (current gate → proposed identity model)');
  const t2 = rep.t2_redistribution;
  L.push(`Current silent CONFIRMED_MATCH: **${t2.currentSilentConfirms}** → stay MATCH ${t2.silentNow.stay} · to UNCERTAIN ${t2.silentNow.toUncertain} · to MISMATCH **${t2.silentNow.toMismatch}**`);
  L.push('');
  L.push('| current → proposed | pairs |');
  L.push('| --- | --- |');
  for (const [k, v] of Object.entries(t2.matrix).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## T3 — Gallery cap test (6 vs full)');
  const t3 = rep.t3_capTest;
  L.push(`Pairs with both galleries: ${t3.withBothGalleries} · shared photo found at cap-6: **${t3.sharedAtCap6}** · at full gallery: **${t3.sharedAtFull}** · **flips: ${t3.flips}** (recall lost to the cap)`);
  L.push(`Best-match gallery position (max of the two sides): ${JSON.stringify(t3.bestPosHistogram)}`);
  L.push('');
  L.push('## T4 — Label filter effect (floorplan/render exclusion, Type 3 risk)');
  const t4 = rep.t4_labelFilter;
  L.push(`Pairs whose cap-6 auto-confirm relied ONLY on a non-discriminating image: **${t4.floorplanOnlyConfirms}**`);
  if (t4.floorplanOnlyPairs.length) {
    L.push('');
    L.push('| pair | address | new-build | current verdict |');
    L.push('| --- | --- | --- | --- |');
    for (const p of t4.floorplanOnlyPairs) L.push(`| ${p.pair_id} | ${p.address} | ${p.newBuild} | ${p.current} |`);
  }
  L.push('');
  L.push(`dHash min-distance histogram (bins ${t4.histBins.join(', ')}):`);
  L.push(`- cap-6 unfiltered (today): ${t4.histCap6Unfiltered.join(' / ')}`);
  L.push(`- full filtered (proposed): ${t4.histFullFiltered.join(' / ')}`);
  L.push('');
  L.push('## T5 — Residue & cost');
  const t5 = rep.t5_residue;
  L.push(`Proposed UNCERTAIN residue: **${t5.residue}** (${t5.withGalleries} with galleries, ${t5.delistedOrNoPhotos} delisted/no-photos) · multi-unit pairs in sample: ${t5.multiUnitInSample}`);
  L.push('');
  L.push('| routing | vision calls/week | vision $/week |');
  L.push('| --- | --- | --- |');
  for (const [k, v] of Object.entries(t5.routings)) L.push(`| ${k} | ${v.visionCallsPerWeek} | ${v.visionCostPerWeek} |`);
  L.push('');
  L.push('| coverage | Oxylabs calls/week | $/week |');
  L.push('| --- | --- | --- |');
  for (const [k, v] of Object.entries(t5.coverage)) L.push(`| ${k} | ${v.oxylabsCallsPerWeek} | ${v.costPerWeek} |`);
  L.push('');
  L.push('## Per-pair trust dataset');
  L.push('');
  L.push('| pair | address | triage | priceΔ | feeH/feeB | dHash c6/full(f) | shared | MU | current | proposed | why |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rep.pairs) {
    const fee = `${r.feeH ?? '—'}/${r.feeB ?? '—'}`;
    const dh = r.dh ? `${r.dh.cap6.minDist}/${r.dh.fullf.minDist}` : '—';
    const shared = r.dh ? r.dh.fullf.shared : '—';
    L.push(`| ${r.pair_id} | ${r.address} | ${r.provisional} | ${r.price_pct == null ? '—' : (r.price_pct * 100).toFixed(0) + '%'} | ${fee} | ${dh} | ${shared} | ${r.isMultiUnit ? 'Y' : ''} | ${r.current.verdict.replace('CONFIRMED_', '')} | ${r.proposed.verdict.replace('CONFIRMED_', '')} | ${r.proposed.why} |`);
  }
  L.push('');
  return L.join('\n');
}
