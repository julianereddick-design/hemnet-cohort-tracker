'use strict';
// scripts/hemnet-age-census.js — NATIONAL Hemnet pre-market (Kommande) age histogram by
// municipality partition, for a like-for-like freshness comparison vs the Booli census.
//
// Since 2026-10-28 the walk itself lives in scripts/hemnet-forsale-age-census.js, which serves
// both Hemnet pools; this file runs it with pool 'premarket' and keeps the pre-market report.
// Why: Hemnet's 2026-10-06 redesign retired /kommande/bostader and searchUpcomingListings (the
// URL now renders a mixed for-sale + pre-market list), and from ~2026-10-27 aggregated listings
// took national pre-market from ~7.6k to ~27k — Stockholm alone (4,466) now exceeds the 2,500
// clamp, so pre-market needs the same item-type / price sub-partitioning as for-sale. The old
// pre-market-only walker could not split a municipality and stopped at 40 pages.
// The stored histogram excludes MINIMAL and AGGREGATED listings so the series stays comparable
// with earlier months; the full per-type picture is in the result's `allTypes`.
// See docs/handover/CHANGELOG.md, 2026-10-28.
//
//   node scripts/hemnet-age-census.js --selftest                         # offline
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-age-census.js --probe     # 1 muni live sanity
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-age-census.js             # full national run
//
// Spec: docs/superpowers/specs/2026-07-07-hemnet-age-penetration-census-design.md
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { BAND_KEYS } = require('../lib/age-census');

const NOW_SEC = Math.floor(Date.now() / 1000);
const LABELS = ['≤1mo', '1–3mo', '3–6mo', '6–12mo', '12–18mo', '18–24mo', '>24mo'];
const LOCATIONS = require('../lib/hemnet-locations-full.json');
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

// The engine is required lazily so --selftest can substitute it.
let engine = () => require('./hemnet-forsale-age-census');
function run(opts = {}) {
  return engine().run({ ...opts, pool: 'premarket' });
}

function pct(n, d) { return d ? (100 * n / d) : 0; }

// ---- combined like-for-like table vs the latest Booli census ----
function loadLatestBooli() {
  try {
    const f = fs.readdirSync(OUT_DIR).filter(x => /^booli-age-census-.*\.json$/.test(x)).sort();
    if (!f.length) return null;
    return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f[f.length - 1]), 'utf8'));
  } catch (e) { return null; }
}

function buildMd(dateStr, res, booli) {
  const buckets = BAND_KEYS.map(k => res.buckets[k]);
  const bucketsSecondhand = BAND_KEYS.map(k => res.bucketsSecondhand[k]);
  const datedTotal = buckets.reduce((a, b) => a + b, 0);
  const undated = res.buckets.undated;
  const headlineSum = res.muni.reduce((a, m) => a + (m.headlineN || 0), 0);
  const L = [];
  L.push(`# Hemnet pre-market (Kommande) age penetration — national — ${dateStr}`, '');
  L.push(`Municipality-partition census over ${res.muni.length} munis. Age = days since Hemnet publish (\`publishedAt\`).`, '');
  L.push(`## Census histogram`, '');
  L.push(`| Bucket | Count | % of dated | Cumulative % | of which new-build |`);
  L.push(`|---|--:|--:|--:|--:|`);
  let cum = 0;
  for (let k = 0; k < LABELS.length; k++) {
    cum += buckets[k];
    const nb = buckets[k] - bucketsSecondhand[k]; // exact: bucketsSecondhand is a band-wise subtraction, never sampled
    L.push(`| ${LABELS[k]} | ${buckets[k].toLocaleString()} | ${pct(buckets[k], datedTotal).toFixed(1)}% | ${pct(cum, datedTotal).toFixed(1)}% | ${nb} |`);
  }
  L.push(`| _undated_ | ${undated.toLocaleString()} | — | — | — |`);
  L.push(`| **dated total** | **${datedTotal.toLocaleString()}** | | | ${res.nNewbuild} new-build |`, '');

  if (booli) {
    const bb = booli.census.buckets, bTot = bb.reduce((a, b) => a + b, 0);
    L.push(`## Like-for-like: Hemnet vs Booli (share of dated pool)`, '');
    L.push(`| Bucket | Hemnet % | Booli % |`);
    L.push(`|---|--:|--:|`);
    for (let k = 0; k < LABELS.length; k++) L.push(`| ${LABELS[k]} | ${pct(buckets[k], datedTotal).toFixed(1)}% | ${pct(bb[k], bTot).toFixed(1)}% |`);
    const hCum3 = pct(buckets[0] + buckets[1], datedTotal), bCum3 = pct(bb[0] + bb[1], bTot);
    const hCum12 = pct(buckets.slice(0, 4).reduce((a, b) => a + b, 0), datedTotal), bCum12 = pct(bb.slice(0, 4).reduce((a, b) => a + b, 0), bTot);
    L.push('', `Hemnet ${hCum3.toFixed(0)}% ≤3mo / ${hCum12.toFixed(0)}% ≤12mo vs Booli ${bCum3.toFixed(0)}% / ${bCum12.toFixed(0)}% — ${hCum3 > bCum3 ? 'Hemnet' : 'Booli'} pre-market pool is fresher.`, '');
  } else {
    L.push(`_(No Booli census artifact found for the combined table.)_`, '');
  }

  const munisWithListings = res.muni.filter(m => m.countedN > 0).length;
  L.push(`## Coverage & quality`, '');
  L.push(`- Munis: ${res.muni.length} processed, ${munisWithListings} with Kommande, ${res.muni.length - munisWithListings} empty.`);
  L.push(`- Distinct listings counted: **${res.nTotal.toLocaleString()}** (dated ${datedTotal.toLocaleString()} + undated ${undated}).`);
  L.push(`- Σ muni headline totals=${headlineSum.toLocaleString()} vs distinct counted ${res.nTotal.toLocaleString()} (Hemnet totals are approximate — count is truth).`);
  L.push(`- Error/gap pages: ${res.errorPages}. Oxylabs calls: **${res.oxCalls}**. Runtime: ${res.runtimeS}s.`);
  L.push(`- Gates: ${res.gates.map(g => `${g.name}=${g.passed ? 'pass' : 'FAIL'}`).join(', ')} (status: ${res.status}).`);
  if (res.notes) L.push(`- Notes: ${res.notes}`);
  L.push('', `_Each municipality is walked to the end of its result list (big ones split by property type and price). Excludes free (MINIMAL) and aggregated listings, see notes. publishedAt = entered-Kommande, comparable to Booli published. 2nd-hand histogram is exact (every card walked); new-builds reported separately._`);
  return L.join('\n');
}

async function probe() {
  const res = await run({ locations: { 'Alingsås': LOCATIONS['Alingsås'] } });
  const m = res.muni[0];
  console.log(`PROBE Alingsås: headline=${m.headlineN} counted=${m.countedN} distinct=${res.nTotal} undated=${res.nUndated}`);
  console.log(`  buckets=${JSON.stringify(res.buckets)}`);
  console.log(`  allTypes=${JSON.stringify(res.allTypes && res.allTypes.byType && Object.fromEntries(Object.entries(res.allTypes.byType).map(([t, v]) => [t, v.n])))}`);
  console.log(`  notes: ${res.notes}`);
  console.log(`  Oxylabs calls: ${res.oxCalls}`);
}

async function selftest() {
  const assert = require('assert');
  // run() must always ask the engine for the PRE-MARKET pool, whatever the caller passes,
  // and hand every other option through untouched.
  let got = null;
  engine = () => ({ run: async (o) => { got = o; return { pool: o.pool }; } });
  const r = await run({ pool: 'forsale', priorTotal: 6806, priorMuniSizes: { Stockholm: 1 }, locations: { X: 1 } });
  assert.strictEqual(got.pool, 'premarket', 'pool is pinned to premarket');
  assert.strictEqual(r.pool, 'premarket');
  assert.strictEqual(got.priorTotal, 6806);
  assert.deepStrictEqual(got.priorMuniSizes, { Stockholm: 1 });
  assert.deepStrictEqual(got.locations, { X: 1 });
  // the report renders from an engine-shaped result
  const zero = Object.fromEntries([...BAND_KEYS, 'undated'].map(k => [k, 0]));
  const md = buildMd('SELFTEST', {
    buckets: { ...zero, le1m: 5 }, bucketsSecondhand: { ...zero, le1m: 4 }, nNewbuild: 1, nTotal: 5,
    muni: [{ name: 'A', headlineN: 9, countedN: 5 }], errorPages: 0, oxCalls: 3, runtimeS: 1,
    gates: [{ name: 'reconciliation', passed: true }], status: 'ok', notes: 'excludes 4 listings',
  }, null);
  assert.ok(md.includes('Census histogram') && md.includes('excludes 4 listings'));
  console.log('SELFTEST PASS — hemnet-age-census delegates to the shared engine with pool=premarket (engine tests: node scripts/hemnet-forsale-age-census.js --selftest).');
}

async function main() {
  if (process.argv.includes('--selftest')) { await selftest(); return; }
  if (process.env.SCRAPE_FORCE_OXYLABS !== '1') {
    console.error('Refusing to run un-proxied. Set SCRAPE_FORCE_OXYLABS=1 (or use --selftest).');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (process.argv.includes('--probe')) { await probe(); return; }

  console.log(`Censusing ${Object.keys(LOCATIONS).length} municipalities…`);
  const res = await run({ logger: log });
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const booli = loadLatestBooli();

  // Write raw JSON FIRST so a formatting bug in buildMd can never destroy a paid result.
  fs.writeFileSync(path.join(OUT_DIR, `hemnet-age-census-${dateStr}.json`), JSON.stringify(res, null, 2));
  const md = buildMd(dateStr, res, booli);
  fs.writeFileSync(path.join(OUT_DIR, `hemnet-age-census-${dateStr}.md`), md);
  console.log(`
${md}`);
  console.log(`
Oxylabs calls: ${res.oxCalls}`);
  console.log(`Artifact -> ${OUT_DIR}/hemnet-age-census-${dateStr}.{json,md}`);
}

module.exports = { run };
if (require.main === module) main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
