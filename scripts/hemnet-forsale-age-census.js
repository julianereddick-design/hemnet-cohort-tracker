'use strict';
// scripts/hemnet-forsale-age-census.js — NATIONAL Hemnet FOR-SALE (Till salu) age histogram
// by municipality partition, the like-for-like Hemnet companion to the Booli FS age estimate
// (scripts/forsale-age-penetration.js). This is the ONLY way to get Hemnet FS age depth:
// Hemnet clamps national /bostader pagination at ~2,500 (page 50) and exposes no oldest-first
// sort, so the cheap two-pass trick used for Booli cannot work here. Instead we partition into
// the 290 municipalities (each usually < the clamp) and walk each to exhaustion.
//
// BIG-MUNI CLAMP: a municipality whose FS pool itself exceeds the clamp (Stockholm, Göteborg,
// …) would silently undercount. We detect that (page-1 total > THRESHOLD) and RECURSIVELY
// sub-partition it with Hemnet's own filters — first by item_types[] (housing form), then by
// price_min/price_max bands — until every scope fits under the clamp. All listings dedupe into
// one global age histogram by listing id, so overlapping scopes are harmless; only gaps matter,
// and we reconcile the union's distinct count against each muni's headline total to surface any.
//
//   node   scripts/hemnet-forsale-age-census.js --selftest          # offline, synthetic; free
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js --probe [Muni]   # 1 muni live (default Stockholm)
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js                  # full national run
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');
const { bandIndex, cardAgeDays, DAY } = require('../lib/premarket-flow');

const NOW_SEC = Math.floor(Date.now() / 1000);
const EDGES = [30, 90, 180, 365, 548, 730];
const LABELS = ['≤1mo', '1–3mo', '3–6mo', '6–12mo', '12–18mo', '18–24mo', '>24mo'];
const LOCATIONS = require('../lib/hemnet-locations-full.json');
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

const PAGE_SIZE = 50;
const MAX_PAGES = 50;                 // Hemnet clamp: pages past ~50 repeat the tail
const CLAMP_LISTINGS = MAX_PAGES * PAGE_SIZE;   // 2,500
const THRESHOLD = 2400;               // sub-partition any scope whose headline exceeds this (margin under clamp)
const ITEM_TYPES = ['bostadsratt', 'villa', 'radhus', 'fritidshus', 'gard', 'tomt'];  // verified tokens
const PRICE_BANDS = [                  // MECE-ish kr bands; dedupe by id absorbs 1-kr boundary overlap
  { max: 1000000 }, { min: 1000000, max: 2000000 }, { min: 2000000, max: 3000000 },
  { min: 3000000, max: 4000000 }, { min: 4000000, max: 5500000 }, { min: 5500000, max: 8000000 },
  { min: 8000000, max: 12000000 }, { min: 12000000 },
];

function fsUrl(scope, page) {
  const p = new URLSearchParams();
  p.append('location_ids[]', String(scope.locationId));
  if (scope.itemType) p.append('item_types[]', scope.itemType);
  if (scope.priceMin != null) p.append('price_min', String(scope.priceMin));
  if (scope.priceMax != null) p.append('price_max', String(scope.priceMax));
  p.append('sort', 'NEWEST');
  p.append('page', String(page));
  return `https://www.hemnet.se/bostader?${p.toString()}`;
}
function scopeLabel(scope) {
  return [scope.name || scope.locationId, scope.itemType, scope.priceMin != null || scope.priceMax != null ? `${(scope.priceMin || 0) / 1e6}-${scope.priceMax ? scope.priceMax / 1e6 : '∞'}M` : null]
    .filter(Boolean).join('/');
}

function apolloFrom(html) {
  const d = extractNextData(html);
  const a = d && d.props && d.props.pageProps && d.props.pageProps.__APOLLO_STATE__;
  if (!a) throw new Error('__APOLLO_STATE__ missing');
  return a;
}
function forSaleTotal(apollo) {
  const r = apollo.ROOT_QUERY || {};
  for (const k of Object.keys(r)) {
    if (k.startsWith('searchForSaleListings')) { const n = r[k]; if (n && typeof n === 'object' && typeof n.total === 'number') return n.total; }
  }
  return undefined;
}
// Returns { status, cards, total } — cards null on persistent non-200 (error != end).
async function realFetch(scope, p) {
  const res = await getWithRetry(fsUrl(scope, p), { logger: () => {} });
  if (res.status !== 200) return { status: res.status, cards: null, total: undefined };
  const apollo = apolloFrom(res.html);
  const cards = parseListingCards(apollo).map(c => ({ id: c.id, published: c.publishedAt, isNewBuild: c.newConstruction, upcoming: c.upcoming }));
  return { status: 200, cards, total: p === 1 ? forSaleTotal(apollo) : undefined };
}
let fetchScope = realFetch;                 // swappable for --selftest

// Retry transient throws (DNS blips) so one hiccup doesn't abort a long run.
async function safeFetch(scope, p, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetchScope(scope, p); }
    catch (e) { lastErr = e; log('WARN', `${scopeLabel(scope)} p${p} threw (${e.message.slice(0, 50)}) — retry ${i + 1}/${tries}`); await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw lastErr;
}

// ---- Global age accumulators (union across all scopes; dedupe by listing id) ----
const buckets = new Array(EDGES.length + 1).fill(0);
const newbuild = new Array(EDGES.length + 1).fill(0);
const seen = new Set();
let distinct = 0, undated = 0, anomalies = 0, nonUpcoming = 0, rawCards = 0, pagesWithCards = 0, errorPages = 0;

function addCard(c) {
  if (c.id != null) { if (seen.has(c.id)) return false; seen.add(c.id); }
  distinct++;
  const p = c.published;
  if (p == null || typeof p !== 'number' || !isFinite(p) || p <= 0 || p > NOW_SEC + DAY) { if (p != null) anomalies++; undated++; return true; }
  const k = bandIndex(cardAgeDays(p, NOW_SEC), EDGES);
  buckets[k]++; if (c.isNewBuild) newbuild[k]++;
  return true;
}

// Walk ONE scope (already known to be < clamp) to exhaustion. Returns { pages, clampedSuspect }.
async function walkScope(scope) {
  let pages = 0, lastFresh = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const r = await safeFetch(scope, p);
    pages = p;
    if (r.cards == null) { errorPages++; log('WARN', `${scopeLabel(scope)} p${p} status ${r.status} — gap, continuing`); continue; }
    if (r.cards.length === 0) break;
    const up = r.cards.filter(c => c.upcoming).length;
    if (up) { nonUpcoming += up; log('WARN', `${scopeLabel(scope)} p${p}: ${up} upcoming card(s) filtered`); }
    const forSale = r.cards.filter(c => !c.upcoming);
    let fresh = 0;
    for (const c of forSale) if (addCard(c)) fresh++;
    lastFresh = fresh;
    if (fresh === 0) break;                    // clamp/end: no new IDs → stop
    rawCards += forSale.length; pagesWithCards++;
  }
  return { pages, clampedSuspect: pages === MAX_PAGES && lastFresh > 0 };
}

// Recursively census a scope, sub-partitioning (item_type → price band) until under the clamp.
// level 0 = whole muni, 1 = item_type fixed, 2 = item_type+price fixed. Returns { headline }.
async function censusScope(scope, level) {
  const first = await safeFetch(scope, 1);
  const total = first.cards == null ? null : first.total;
  if (first.cards == null) { errorPages++; log('WARN', `${scopeLabel(scope)} p1 status ${first.status} — scope skipped`); return { headline: 0, sub: [] }; }
  if (total != null && total <= THRESHOLD) {
    // Reuse the page-1 cards we already have, then continue walking.
    const forSale = first.cards.filter(c => !c.upcoming);
    for (const c of forSale) addCard(c);
    if (forSale.length) { rawCards += forSale.length; pagesWithCards++; }
    if (total > forSale.length) { for (let p = 2; p <= MAX_PAGES; p++) { const r = await safeFetch(scope, p); if (r.cards == null) { errorPages++; continue; } if (r.cards.length === 0) break; const fs2 = r.cards.filter(c => !c.upcoming); let fresh = 0; for (const c of fs2) if (addCard(c)) fresh++; if (fresh === 0) break; rawCards += fs2.length; pagesWithCards++; } }
    return { headline: total, sub: [] };
  }
  // Over threshold → sub-partition.
  if (level === 0) {
    log('INFO', `${scopeLabel(scope)} total=${total} > ${THRESHOLD} → splitting by item_type`);
    let sumTypes = 0;
    for (const t of ITEM_TYPES) { const r = await censusScope({ ...scope, itemType: t }, 1); sumTypes += r.headline; }
    const residual = total - sumTypes;
    if (residual > 0.02 * total) log('WARN', `${scopeLabel(scope)}: item_types cover ${sumTypes}/${total}; ~${residual} listings not in the 6 types (uncovered residual)`);
    return { headline: total, sub: ITEM_TYPES };
  }
  if (level === 1) {
    log('INFO', `${scopeLabel(scope)} total=${total} > ${THRESHOLD} → splitting by price band`);
    for (const b of PRICE_BANDS) { const s = { ...scope, priceMin: b.min != null ? b.min : null, priceMax: b.max != null ? b.max : null }; const r = await safeFetch(s, 1); if (r.cards != null && r.total > 0) await censusScope(s, 2); }
    return { headline: total, sub: PRICE_BANDS.length + ' price bands' };
  }
  // level 2: type+price still over clamp (rare) — walk anyway, warn about undercount.
  log('WARN', `${scopeLabel(scope)} total=${total} still > clamp after type+price — walking, will undercount by ~${total - CLAMP_LISTINGS}`);
  await walkScope(scope);
  return { headline: total, sub: [] };
}

async function censusMuni(name, id) {
  const before = distinct;
  const r = await censusScope({ locationId: id, name }, 0);
  return { name, id, headline: r.headline, counted: distinct - before };
}

// ---- reporting ----
function pct(n, d) { return d ? (100 * n / d) : 0; }
function loadLatestBooliFs() {
  try {
    const f = fs.readdirSync(OUT_DIR).filter(x => /^forsale-age-penetration-.*\.json$/.test(x)).sort();
    if (!f.length) return null;
    const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f[f.length - 1]), 'utf8'));
    return j.results && j.results.find(r => r.name === 'booli');
  } catch (e) { return null; }
}
function buildMd(dateStr, muniStats, headlineSum, oxCalls, booli) {
  const datedTotal = buckets.reduce((a, b) => a + b, 0);
  const L = [];
  L.push(`# Hemnet for-sale (Till salu) age penetration — national — ${dateStr}`, '');
  L.push(`Municipality-partition census over ${muniStats.length} munis (big munis sub-partitioned by item_type + price). Age = days since Hemnet publish.`, '');
  L.push('## Census histogram', '');
  L.push('| Bucket | Count | % of dated | Cumulative % | of which new-build |');
  L.push('|---|--:|--:|--:|--:|');
  let cum = 0;
  for (let k = 0; k < LABELS.length; k++) { cum += buckets[k]; L.push(`| ${LABELS[k]} | ${buckets[k].toLocaleString()} | ${pct(buckets[k], datedTotal).toFixed(1)}% | ${pct(cum, datedTotal).toFixed(1)}% | ${newbuild[k]} |`); }
  L.push(`| _undated_ | ${undated.toLocaleString()} | — | — | — |`);
  L.push(`| **dated total** | **${datedTotal.toLocaleString()}** | | | ${newbuild.reduce((a, b) => a + b, 0)} new-build |`, '');
  if (booli) {
    const bb = booli.bands, bTot = bb.reduce((a, b) => a + b, 0);
    L.push('## Like-for-like: Hemnet vs Booli for-sale (share of dated pool)', '');
    L.push('| Bucket | Hemnet % | Booli % |'); L.push('|---|--:|--:|');
    for (let k = 0; k < LABELS.length; k++) L.push(`| ${LABELS[k]} | ${pct(buckets[k], datedTotal).toFixed(1)}% | ${pct(bb[k], bTot).toFixed(1)}% |`);
    const h3 = pct(buckets[0] + buckets[1], datedTotal), b3 = pct(bb[0] + bb[1], bTot);
    const h24 = pct(buckets[6], datedTotal), b24 = pct(bb[6], bTot);
    L.push('', `Hemnet ${h3.toFixed(0)}% ≤3mo vs Booli ${b3.toFixed(0)}%; zombie tail (>24mo) Hemnet ${h24.toFixed(1)}% vs Booli ${b24.toFixed(1)}%.`, '');
  }
  const withListings = muniStats.filter(m => m.counted > 0).length;
  L.push('## Coverage & quality', '');
  L.push(`- Munis: ${muniStats.length} processed, ${withListings} with FS listings.`);
  L.push(`- Distinct listings counted: **${distinct.toLocaleString()}** (dated ${datedTotal.toLocaleString()} + undated ${undated}).`);
  L.push(`- Σ muni headline totals=${headlineSum.toLocaleString()} vs distinct counted ${distinct.toLocaleString()} (gap = clamp-undercount + dedupe; count is truth).`);
  L.push(`- Error/gap pages: ${errorPages}. Upcoming cards filtered: ${nonUpcoming}. publishedAt anomalies: ${anomalies}.`);
  L.push(`- Oxylabs calls: **${oxCalls}**.`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// --selftest: offline. Synthetic national universe incl. a big muni that needs
// item_type split AND a type that needs a further price split. The census must
// reconstruct the FULL distinct count (not the ~2,500 clamp).
// ---------------------------------------------------------------------------
async function selftest() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SELFTEST FAIL [${n}]: ${e.message}`); fail++; } };

  // Build a synthetic universe: listings with { id, muni, itemType, price, ageDays }.
  const universe = [];
  let gid = 0;
  const addListings = (muni, itemType, price, n, ageStart) => { for (let i = 0; i < n; i++) universe.push({ id: 'L' + (gid++), muni, itemType, price, ageDays: ageStart + i * 0.5 }); };
  // Small muni: 120 apartments (fits, 3 pages).
  addListings('Small', 'bostadsratt', 2500000, 120, 1);
  // Big muni needing type split: 3,000 apartments (needs price split) + 900 villas + 300 radhus.
  addListings('Big', 'bostadsratt', 1500000, 1500, 1);      // low band
  addListings('Big', 'bostadsratt', 6000000, 1500, 100);    // high band → forces price split of bostadsratt
  addListings('Big', 'villa', 8000000, 900, 50);
  addListings('Big', 'radhus', 3000000, 300, 20);
  const BIG_TOTAL = 1500 + 1500 + 900 + 300;                // 4,200

  // Synthetic fetcher: filters universe by scope, newest-first, paginates, simulates Hemnet clamp.
  fetchScope = async (scope, p) => {
    let rows = universe.filter(r => r.muni === (scope.name || scope.locationId));
    if (scope.itemType) rows = rows.filter(r => r.itemType === scope.itemType);
    if (scope.priceMin != null) rows = rows.filter(r => r.price >= scope.priceMin);
    if (scope.priceMax != null) rows = rows.filter(r => r.price < scope.priceMax);
    const total = rows.length;
    rows.sort((a, b) => a.ageDays - b.ageDays);           // newest-first
    let start = (p - 1) * PAGE_SIZE;
    let slice;
    if (start >= Math.min(total, CLAMP_LISTINGS)) slice = total ? [rows[Math.min(total, CLAMP_LISTINGS) - 1]] : []; // CLAMP repeat / empty
    else slice = rows.slice(start, start + PAGE_SIZE);
    const cards = slice.map(r => ({ id: r.id, published: NOW_SEC - Math.round(r.ageDays * DAY), isNewBuild: false, upcoming: false }));
    return { status: 200, cards, total: p === 1 ? total : undefined };
  };

  await check('small muni: walked fully, no sub-partition', async () => {
    const r = await censusMuni('Small', 9001);
    assert.strictEqual(r.counted, 120, `counted ${r.counted}`);
  });

  await check('big muni: sub-partition recovers FULL count (beats the 2,500 clamp)', async () => {
    const before = distinct;
    const r = await censusMuni('Big', 9002);
    assert.strictEqual(r.headline, BIG_TOTAL, `headline ${r.headline}`);
    assert.strictEqual(distinct - before, BIG_TOTAL, `recovered ${distinct - before} of ${BIG_TOTAL} — clamp not beaten`);
  });

  await check('naive single-scope walk WOULD have clamped at 2,500 (proves the problem is real)', async () => {
    // Walk Big as one scope with no sub-partition — should stop at the clamp.
    const s = new Set(); let cnt = 0;
    for (let p = 1; p <= MAX_PAGES; p++) { const r = await fetchScope({ name: 'Big' }, p); if (!r.cards.length) break; let fresh = 0; for (const c of r.cards) if (!s.has(c.id)) { s.add(c.id); cnt++; fresh++; } if (fresh === 0) break; }
    assert.ok(cnt <= CLAMP_LISTINGS && cnt < BIG_TOTAL, `naive walk got ${cnt}, expected clamp <=${CLAMP_LISTINGS}`);
  });

  console.log(`\nselftest: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Live orchestration
// ---------------------------------------------------------------------------
async function runProbe(muniName) {
  const name = muniName || 'Stockholm';
  const id = LOCATIONS[name];
  if (id == null) { console.error(`Unknown muni "${name}". Try one of: Stockholm, Göteborg, Malmö…`); process.exit(1); }
  resetOxylabsStats();
  console.log(`===== HEMNET FS AGE CENSUS — PROBE: ${name} (id ${id}) =====\n`);
  const r = await censusMuni(name, id);
  const ox = getOxylabsStats();
  const naiveWouldGet = Math.min(r.headline, CLAMP_LISTINGS);
  console.log(`\n  headline FS total: ${r.headline}`);
  console.log(`  distinct counted (sub-partitioned union): ${r.counted}`);
  console.log(`  a naive single-scope walk would have clamped at: ~${naiveWouldGet}`);
  console.log(`  coverage vs headline: ${pct(r.counted, r.headline).toFixed(1)}%`);
  console.log(`  buckets=${JSON.stringify(buckets)}  undated=${undated}`);
  console.log(`  Oxylabs calls: ${JSON.stringify(ox)}`);
  const verdict = r.headline <= THRESHOLD ? '(muni under clamp — no sub-partition needed; pick a bigger muni to test splitting)'
    : r.counted >= 0.97 * r.headline ? '✅ sub-partition recovered ~full count (clamp beaten)'
    : `⚠️ recovered ${pct(r.counted, r.headline).toFixed(0)}% — coverage gap, inspect residual warnings`;
  console.log(`  VERDICT: ${verdict}`);
}

// Cheap sizing: page-1 FS total for the biggest-by-population munis, to learn whether ANY
// municipality exceeds the clamp (⇒ needs the sub-partition path in the national run).
async function runSizes() {
  resetOxylabsStats();
  const CANDIDATES = ['Stockholm', 'Göteborg', 'Malmö', 'Uppsala', 'Västerås', 'Örebro',
    'Linköping', 'Helsingborg', 'Jönköping', 'Norrköping', 'Lund', 'Umeå', 'Gävle', 'Borås', 'Södertälje', 'Huddinge', 'Nacka'];
  console.log('===== HEMNET FS — MUNI SIZE PROBE (page-1 totals) =====\n');
  const rows = [];
  for (const name of CANDIDATES) {
    const id = LOCATIONS[name];
    if (id == null) { console.log(`  ${name}: (not in locations)`); continue; }
    const r = await safeFetch({ locationId: id, name }, 1);
    const total = r.cards == null ? null : r.total;
    rows.push({ name, total });
    console.log(`  ${name.padEnd(12)} ${total == null ? 'ERR' : total}${total > THRESHOLD ? '  ⚠️ OVER CLAMP — needs sub-partition' : ''}`);
  }
  const over = rows.filter(r => r.total != null && r.total > THRESHOLD);
  const max = rows.reduce((m, r) => (r.total != null && r.total > m.total ? r : m), { total: -1 });
  console.log(`\n  largest: ${max.name} = ${max.total}. Munis over clamp (${THRESHOLD}): ${over.length ? over.map(r => r.name).join(', ') : 'NONE'}.`);
  console.log(`  ⇒ ${over.length ? 'sub-partition path WILL fire — validate on ' + over[0].name : 'no muni clamps → national run is a plain muni-walk'}`);
  console.log(`  Oxylabs calls: ${JSON.stringify(getOxylabsStats())}`);
}

async function runFull() {
  resetOxylabsStats();
  console.log('===== HEMNET FS AGE CENSUS — FULL NATIONAL RUN =====\n');
  const names = Object.keys(LOCATIONS);
  const muniStats = [];
  let headlineSum = 0, i = 0;
  for (const name of names) {
    const r = await censusMuni(name, LOCATIONS[name]);
    headlineSum += r.headline; muniStats.push(r);
    if (++i % 25 === 0) log('INFO', `…${i}/${names.length} munis, distinct=${distinct}, calls=${getOxylabsStats().oxylabsCallCount}`);
  }
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const booli = loadLatestBooliFs();
  const md = buildMd(dateStr, muniStats, headlineSum, getOxylabsStats().oxylabsCallCount, booli);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = path.join(OUT_DIR, `hemnet-forsale-age-census-${dateStr}.md`);
  const jsonPath = path.join(OUT_DIR, `hemnet-forsale-age-census-${dateStr}.json`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify({ dateStr, nowSec: NOW_SEC, edges: EDGES, buckets, newbuild, undated, distinct, headlineSum, muniStats }, null, 2));
  console.log('\n' + md);
  console.log(`\nWrote ${mdPath}\nWrote ${jsonPath}`);
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--selftest') selftest();
  else if (arg === '--sizes') runSizes().catch(e => { console.error(e); process.exit(1); });
  else if (arg === '--probe') runProbe(process.argv[3]).catch(e => { console.error(e); process.exit(1); });
  else runFull().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { censusScope, censusMuni, addCard, buckets };
