'use strict';
// scripts/hemnet-age-census.js — one-off NATIONAL Hemnet pre-market (Kommande) age
// histogram by municipality partition, for a like-for-like freshness comparison vs the
// Booli census. Hemnet caps national Kommande pagination (~2,500/8,368), so we census each
// of the 290 municipalities and union. Stop condition is "0 new distinct IDs" (Hemnet clamps
// past a muni's end and repeats the tail — it never returns an empty page for a small muni).
//
//   node scripts/hemnet-age-census.js --selftest   # offline, synthetic clamp pool
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-age-census.js --probe   # 1 muni live sanity
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-age-census.js           # full ~400-480 calls
//
// Spec: docs/superpowers/specs/2026-07-07-hemnet-age-penetration-census-design.md
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');
const { bandIndex, cardAgeDays, DAY } = require('../lib/premarket-flow');

const NOW_SEC = Math.floor(Date.now() / 1000);
const EDGES = [30, 90, 180, 365, 548, 730];
const LABELS = ['≤1mo', '1–3mo', '3–6mo', '6–12mo', '12–18mo', '18–24mo', '>24mo'];
const MAX_PAGES_PER_MUNI = 40;                 // Stockholm ends ~p24; 40 is an ample backstop
const LOCATIONS = require('../lib/hemnet-locations-full.json');
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);
const url = (id, p) => `https://www.hemnet.se/kommande/bostader?location_ids[]=${id}&sort=NEWEST&page=${p}`;

function apolloFrom(html) {
  const d = extractNextData(html);
  const a = d && d.props && d.props.pageProps && d.props.pageProps.__APOLLO_STATE__;
  if (!a) throw new Error('__APOLLO_STATE__ missing');
  return a;
}
function muniTotal(apollo) {
  const r = apollo.ROOT_QUERY || {};
  for (const k of Object.keys(r)) if (k.startsWith('searchUpcomingListings')) { const n = r[k]; if (n && typeof n === 'object') return n.total; }
  return undefined;
}
// Returns { status, cards, total } — cards null on persistent non-200 (error != end).
async function realFetchPage(id, p) {
  const res = await getWithRetry(url(id, p), { logger: () => {} });
  if (res.status !== 200) return { status: res.status, cards: null, total: undefined };
  const apollo = apolloFrom(res.html);
  const cards = parseListingCards(apollo).map(c => ({ id: c.id, published: c.publishedAt, isNewBuild: c.newConstruction, upcoming: c.upcoming }));
  return { status: 200, cards, total: p === 1 ? muniTotal(apollo) : undefined };
}
let pageFetcher = realFetchPage;                 // swappable for --selftest
const fetchPage = (id, p) => pageFetcher(id, p);

// Accumulators (module-level so walkMuni folds into them).
const buckets = new Array(EDGES.length + 1).fill(0);
const newbuild = new Array(EDGES.length + 1).fill(0);
const seen = new Set();
let undated = 0, distinct = 0, errorPages = 0, rawCards = 0, pagesWithCards = 0, anomalies = 0, nonUpcoming = 0;

function addCard(c) {
  if (c.id != null) { if (seen.has(c.id)) return false; seen.add(c.id); }
  distinct++;
  const p = c.published;
  // Guard: publishedAt must be a sane unix-seconds value. A mangled/ISO value (coerceNumber
  // can produce garbage) or future date is counted as an anomaly, not silently misbucketed.
  if (p == null || typeof p !== 'number' || !isFinite(p) || p <= 0 || p > NOW_SEC + DAY) {
    if (p != null) anomalies++;
    undated++; return true;
  }
  const k = bandIndex(cardAgeDays(p, NOW_SEC), EDGES);
  buckets[k]++; if (c.isNewBuild) newbuild[k]++;
  return true;
}

// Walk one muni until a page adds 0 new distinct IDs (clamp/end) or the safety cap.
// Only `upcoming === true` cards are counted (defensive against any injected/recommended
// or Till-salu cards — probe 2026-07-07 saw none, but the filter WARNs if that changes).
async function walkMuni(name, id) {
  let pages = 0, total = null, counted = 0, p1Error = false;
  for (let p = 1; p <= MAX_PAGES_PER_MUNI; p++) {
    const r = await fetchPage(id, p);
    pages = p;
    if (r.cards == null) { errorPages++; if (p === 1) p1Error = true; log('WARN', `${name} p${p} status ${r.status} — gap, continuing`); continue; }
    if (p === 1) total = r.total;
    if (r.cards.length === 0) break;             // 0-Kommande muni → empty p1
    const up = r.cards.filter(c => c.upcoming);
    const nonUp = r.cards.length - up.length;
    if (nonUp) { nonUpcoming += nonUp; log('WARN', `${name} p${p}: ${nonUp} non-upcoming card(s) filtered out`); }
    let fresh = 0;
    for (const c of up) if (addCard(c)) { fresh++; counted++; }
    if (fresh === 0) break;                       // clamp/end: no new upcoming IDs → stop this muni
    rawCards += up.length; pagesWithCards++;
    if (p === MAX_PAGES_PER_MUNI) log('WARN', `${name} hit MAX_PAGES_PER_MUNI=${MAX_PAGES_PER_MUNI} — muni may exceed cap (unexpected)`);
  }
  return { name, id, pages, total, counted, p1Error };
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

function buildMd(dateStr, muniStats, natTotalSum, oxCalls, booli) {
  const datedTotal = buckets.reduce((a, b) => a + b, 0);
  const L = [];
  L.push(`# Hemnet pre-market (Kommande) age penetration — national — ${dateStr}`, '');
  L.push(`Municipality-partition census over ${Object.keys(LOCATIONS).length} munis. Age = days since Hemnet publish (\`publishedAt\`).`, '');
  L.push(`## Census histogram`, '');
  L.push(`| Bucket | Count | % of dated | Cumulative % | of which new-build |`);
  L.push(`|---|--:|--:|--:|--:|`);
  let cum = 0;
  for (let k = 0; k < LABELS.length; k++) {
    cum += buckets[k];
    L.push(`| ${LABELS[k]} | ${buckets[k].toLocaleString()} | ${pct(buckets[k], datedTotal).toFixed(1)}% | ${pct(cum, datedTotal).toFixed(1)}% | ${newbuild[k]} |`);
  }
  L.push(`| _undated_ | ${undated.toLocaleString()} | — | — | — |`);
  L.push(`| **dated total** | **${datedTotal.toLocaleString()}** | | | ${newbuild.reduce((a, b) => a + b, 0)} new-build |`, '');

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

  const munisWithListings = muniStats.filter(m => m.counted > 0).length;
  L.push(`## Coverage & quality`, '');
  L.push(`- Munis: ${muniStats.length} processed, ${munisWithListings} with Kommande, ${muniStats.length - munisWithListings} empty.`);
  L.push(`- Distinct listings counted: **${distinct.toLocaleString()}** (dated ${datedTotal.toLocaleString()} + undated ${undated}).`);
  L.push(`- Σ muni headline totals=${natTotalSum.toLocaleString()} vs distinct counted ${distinct.toLocaleString()} (Hemnet totals are approximate — count is truth).`);
  L.push(`- Error/gap pages: ${errorPages}. Mean upcoming cards/content-page: ${(pagesWithCards ? rawCards / pagesWithCards : 0).toFixed(1)}.`);
  const p1fail = muniStats.filter(m => m.p1Error).map(m => m.name);
  L.push(`- Non-upcoming cards filtered: ${nonUpcoming}. publishedAt anomalies: ${anomalies}. Munis with p1 still failing: ${p1fail.length}${p1fail.length ? ' (' + p1fail.join(', ') + ')' : ''}.`);
  L.push(`- Oxylabs calls: **${oxCalls}**.`);
  L.push('', `_Stop condition = first page with 0 new IDs (Hemnet clamps past a muni's end). publishedAt = entered-Kommande, comparable to Booli published. New-builds reported separately._`);
  return L.join('\n');
}

async function probe() {
  const r = await walkMuni('Alingsås', LOCATIONS['Alingsås']);
  console.log(`PROBE Alingsås: pages=${r.pages} total=${r.total} counted=${r.counted} distinct=${distinct} undated=${undated}`);
  console.log(`  buckets=${JSON.stringify(buckets)} newbuild=${JSON.stringify(newbuild)}`);
  console.log(`  Oxylabs: ${JSON.stringify(getOxylabsStats())}`);
}

async function selftest() {
  const assert = require('assert');
  // Synthetic munis with Hemnet's clamp: past the end, repeat the last card forever.
  const PAGE = 50;
  const CLOCK = NOW_SEC;
  const munis = {
    // name: array of listing ages (days). null → undated.
    Big: Array.from({ length: 123 }, (_, i) => i * 8),        // 3 pages (50/50/23) then clamp
    Small: [1, 40, 200, 800],                                  // 1 page then clamp
    Undated: [5, null, 400, null],
    Empty: [],
  };
  const store = {}; // id -> {ages}
  let gid = 0;
  const idsByMuni = {};
  for (const [n, ages] of Object.entries(munis)) {
    idsByMuni[n] = ages.map(a => { const id = 'L' + (gid++); store[id] = a; return id; });
  }
  pageFetcher = async (muniId, p) => {
    const ids = idsByMuni[muniId] || [];
    if (ids.length === 0) return { status: 200, cards: [], total: 0 };
    const start = (p - 1) * PAGE;
    let slice;
    if (start >= ids.length) slice = [ids[ids.length - 1]];    // CLAMP: repeat last card
    else slice = ids.slice(start, start + PAGE);
    const cards = slice.map(id => ({ id, published: store[id] == null ? null : CLOCK - store[id] * DAY, isNewBuild: false, upcoming: true }));
    // Inject a non-upcoming (recommended/Till-salu) card on Big p1 — must be filtered out.
    if (muniId === 'Big' && p === 1) cards.unshift({ id: 'INJECT', published: CLOCK - 10 * DAY, isNewBuild: false, upcoming: false });
    return { status: 200, cards, total: ids.length };
  };
  // Ground truth over all distinct listings.
  const truth = new Array(EDGES.length + 1).fill(0); let truthUndated = 0;
  for (const a of Object.values(store)) { if (a == null) truthUndated++; else truth[bandIndex(a, EDGES)]++; }

  const muniStats = [];
  for (const name of Object.keys(munis)) muniStats.push(await walkMuni(name, name));
  for (let k = 0; k < truth.length; k++) assert.strictEqual(buckets[k], truth[k], `bucket ${k}: ${buckets[k]} != ${truth[k]}`);
  assert.strictEqual(undated, truthUndated, 'undated mismatch');
  assert.strictEqual(distinct, Object.keys(store).length, `distinct ${distinct} != ${Object.keys(store).length}`);
  // Clamp must terminate: Big has 123 listings → 3 content pages + 1 zero-new page = 4.
  const big = muniStats.find(m => m.name === 'Big');
  assert.ok(big.pages <= 5, `Big should stop by ~p4 (clamp), got p${big.pages}`);
  const empty = muniStats.find(m => m.name === 'Empty');
  assert.strictEqual(empty.pages, 1, 'Empty muni should stop at p1');
  assert.strictEqual(nonUpcoming, 1, `injected non-upcoming card should be filtered (nonUpcoming=${nonUpcoming})`);
  assert.ok(!seen.has('INJECT'), 'injected non-upcoming card must not be counted');
  const md = buildMd('SELFTEST', muniStats, 0, 0, null);
  assert.ok(md.includes('Census histogram'));
  console.log(`SELFTEST PASS — census==truth (${distinct} distinct across ${muniStats.length} munis), clamp terminates, report renders.`);
}

async function main() {
  if (process.argv.includes('--selftest')) { await selftest(); return; }
  if (process.env.SCRAPE_FORCE_OXYLABS !== '1') {
    console.error('Refusing to run un-proxied. Set SCRAPE_FORCE_OXYLABS=1 (or use --selftest).');
    process.exit(1);
  }
  resetOxylabsStats();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (process.argv.includes('--probe')) { await probe(); return; }

  const names = Object.keys(LOCATIONS);
  console.log(`Censusing ${names.length} municipalities…`);
  const muniStats = [];
  let natTotalSum = 0, done = 0;
  for (const name of names) {
    const r = await walkMuni(name, LOCATIONS[name]);
    if (typeof r.total === 'number') natTotalSum += r.total;
    muniStats.push(r);
    done++;
    if (done % 25 === 0) log('INFO', `${done}/${names.length} munis, distinct=${distinct}, calls=${getOxylabsStats().oxylabsCallCount}`);
  }
  // Retry pass for munis whose page 1 errored (a whole-muni coverage gap). Global dedup
  // keeps a re-walk safe (already-seen ids skipped).
  const p1errs = muniStats.filter(m => m.p1Error).map(m => m.name);
  if (p1errs.length) {
    log('WARN', `retrying ${p1errs.length} munis whose p1 errored: ${p1errs.join(', ')}`);
    for (const name of p1errs) {
      const r = await walkMuni(name, LOCATIONS[name]);
      if (typeof r.total === 'number') natTotalSum += r.total;
      muniStats[muniStats.findIndex(m => m.name === name)] = r;
    }
  }
  const stillFailed = muniStats.filter(m => m.p1Error).map(m => m.name);
  if (stillFailed.length) log('WARN', `${stillFailed.length} munis STILL failing p1 after retry (coverage gap): ${stillFailed.join(', ')}`);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const booli = loadLatestBooli();

  const payload = {
    snapshot_date: dateStr, now_sec: NOW_SEC, edges_days: EDGES, labels: LABELS,
    buckets, newbuild, undated, distinct, dated_total: buckets.reduce((a, b) => a + b, 0),
    muni_total_sum: natTotalSum, error_pages: errorPages, oxylabs_calls: oxCalls,
    munis: muniStats,
  };
  fs.writeFileSync(path.join(OUT_DIR, `hemnet-age-census-${dateStr}.json`), JSON.stringify(payload, null, 2));
  const md = buildMd(dateStr, muniStats, natTotalSum, oxCalls, booli);
  fs.writeFileSync(path.join(OUT_DIR, `hemnet-age-census-${dateStr}.md`), md);
  console.log(`\n${md}`);
  console.log(`\nOxylabs total: ${JSON.stringify(ox)}`);
  console.log(`Artifact -> ${OUT_DIR}/hemnet-age-census-${dateStr}.{json,md}`);
}

main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
