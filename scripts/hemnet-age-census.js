'use strict';
// scripts/hemnet-age-census.js — NATIONAL Hemnet pre-market (Kommande) age histogram by
// municipality partition, for a like-for-like freshness comparison vs the Booli census.
// Hemnet caps national Kommande pagination (~2,500/8,368), so we census each of the 290
// municipalities and union. Stop condition is "0 new distinct IDs" (Hemnet clamps past a
// muni's end and repeats the tail — it never returns an empty page for a small muni).
//
// Per-muni accumulators (lib/age-census.js) share ONE global `seen` Set so dedupe stays
// global while bands stay per-muni; the national histogram is the sum of the per-muni ones.
// This is also what makes the reconciliation gate (Σ headline totals vs distinct union)
// meaningful. Every card is walked, so — unlike the Booli binary-search estimate — the
// 2nd-hand histogram here is an exact band-wise subtraction, not a sample.
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
const { bandIndex, DAY } = require('../lib/premarket-flow');
const {
  EDGES, BAND_KEYS, newAccumulator, addCardTo, mergeAccumulators, bucketsToObject, secondhandToObject,
  gateReconciliation, gateTotalDrift, gateErrorPages, evaluateGates,
} = require('../lib/age-census');

const NOW_SEC = Math.floor(Date.now() / 1000);
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

// Walk one muni into ITS OWN accumulator. `acc.seen` is the shared global id set, so a
// listing that somehow appears under two munis is counted once, in the first one seen.
// Only `upcoming === true` cards are counted (defensive against any injected/recommended
// or Till-salu cards — probe 2026-07-07 saw none, but the filter WARNs if that changes).
// Walk stops when a page adds 0 new distinct IDs (clamp/end) or the safety cap — NOT on an
// empty page, since Hemnet clamps past a muni's end and repeats the tail forever.
async function walkMuni(name, id, acc, nowSec, ctx) {
  let pages = 0, total = null, counted = 0, p1Error = false;
  for (let p = 1; p <= MAX_PAGES_PER_MUNI; p++) {
    const r = await fetchPage(id, p);
    pages = p;
    if (r.cards == null) { ctx.errorPages++; if (p === 1) p1Error = true; log('WARN', `${name} p${p} status ${r.status} — gap, continuing`); continue; }
    if (p === 1) total = r.total;
    if (r.cards.length === 0) break;              // 0-Kommande muni → empty p1
    const up = r.cards.filter(c => c.upcoming);
    const nonUp = r.cards.length - up.length;
    if (nonUp) { ctx.nonUpcoming += nonUp; log('WARN', `${name} p${p}: ${nonUp} non-upcoming card(s) filtered out`); }
    let fresh = 0;
    for (const c of up) if (addCardTo(acc, c, nowSec)) { fresh++; counted++; }
    if (fresh === 0) break;                       // clamp/end: no new upcoming IDs → stop this muni
    if (p === MAX_PAGES_PER_MUNI) log('WARN', `${name} hit MAX_PAGES_PER_MUNI=${MAX_PAGES_PER_MUNI} — muni may exceed cap (unexpected)`);
  }
  return { name, id, pages, total, counted, p1Error };
}

async function run({ locations = LOCATIONS, nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  const seen = new Set();
  const ctx = { errorPages: 0, nonUpcoming: 0 };
  const names = Object.keys(locations);
  const accs = [], stats = [];
  let headlineSum = 0, done = 0;

  for (const name of names) {
    const acc = newAccumulator({ seen });
    const st = await walkMuni(name, locations[name], acc, nowSec, ctx);
    if (typeof st.total === 'number') headlineSum += st.total;
    accs.push(acc); stats.push(st);
    if (++done % 25 === 0) logger('INFO', `${done}/${names.length} munis, distinct=${seen.size}`);
  }
  // Retry munis whose page 1 errored — a whole-muni coverage gap. A p1 error does not stop
  // the walk (walkMuni logs, continues, and pages 2+ may still fetch successfully), so the
  // first attempt's accumulator may already hold real page-2+ listings whose ids are in the
  // shared `seen` Set. The retry therefore REUSES that same accumulator (does NOT replace it
  // with a fresh one) so the retried page 1 ADDS to what pages 2+ already contributed. Global
  // dedupe still makes the retry safe: any id the first attempt already folded in is skipped
  // by `seen`, so nothing is double-counted, and nothing collected on the first pass is lost.
  const p1errs = stats.map((s, i) => ({ s, i })).filter(x => x.s.p1Error);
  if (p1errs.length) {
    logger('WARN', `retrying ${p1errs.length} munis whose p1 errored: ${p1errs.map(x => x.s.name).join(', ')}`);
    for (const { s, i } of p1errs) {
      const st = await walkMuni(s.name, locations[s.name], accs[i], nowSec, ctx);
      if (typeof st.total === 'number') headlineSum += st.total;
      stats[i] = st;
    }
  }

  const nat = mergeAccumulators(accs);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const stillFailed = stats.filter(s => s.p1Error).map(s => s.name);
  const gates = [
    gateReconciliation({ headlineSum, distinct: nat.distinct, maxPct: 2 }),
    gateErrorPages({ errorPages: ctx.errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: nat.distinct, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  const notes = [
    stillFailed.length ? `munis still failing p1: ${stillFailed.join(', ')}` : null,
    ctx.nonUpcoming ? `${ctx.nonUpcoming} non-upcoming cards filtered` : null,
    nat.anomalies ? `${nat.anomalies} publishedAt anomalies` : null,
    ev.passed ? null : `gates failed: ${ev.failures.join(', ')}`,
  ].filter(Boolean).join('; ') || null;

  return {
    platform: 'hemnet', pool: 'premarket', method: 'muni-partition',
    nTotal: nat.distinct, nUndated: nat.undated,
    nNewbuild: nat.newbuild.reduce((a, b) => a + b, 0),
    newbuildSampled: false, newbuildSampleN: null,
    buckets: bucketsToObject(nat.buckets, nat.undated),
    bucketsSecondhand: secondhandToObject(nat.buckets, nat.newbuild, nat.undated),
    // countedN reads the accumulator's own `distinct`, not the last walkMuni call's returned
    // `counted` — a muni retried after a p1 error accumulates across TWO walkMuni calls (page
    // 2+ from the failed first attempt, page 1 from the retry), so `s.counted` alone would
    // reflect only the most recent call and under-report the muni's true listing count.
    muni: stats.map((s, i) => ({
      name: s.name, id: Number(s.id) || 0,
      headlineN: s.total == null ? 0 : s.total, countedN: accs[i].distinct,
      buckets: bucketsToObject(accs[i].buckets, accs[i].undated),
      bucketsSecondhand: secondhandToObject(accs[i].buckets, accs[i].newbuild, accs[i].undated),
    })),
    oxCalls, errorPages: ctx.errorPages, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed', notes,
  };
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
  L.push('', `_Stop condition = first page with 0 new IDs (Hemnet clamps past a muni's end). publishedAt = entered-Kommande, comparable to Booli published. 2nd-hand histogram is exact (every card walked); new-builds reported separately._`);
  return L.join('\n');
}

async function probe() {
  const res = await run({ locations: { 'Alingsås': LOCATIONS['Alingsås'] } });
  const m = res.muni[0];
  console.log(`PROBE Alingsås: headline=${m.headlineN} counted=${m.countedN} distinct=${res.nTotal} undated=${res.nUndated}`);
  console.log(`  buckets=${JSON.stringify(res.buckets)}`);
  console.log(`  Oxylabs calls: ${res.oxCalls}`);
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

  // --- direct walkMuni pass: verify clamp termination + non-upcoming filtering in isolation.
  // Uses its own seen Set/ctx so it can't interfere with the run() pass below (pageFetcher is
  // a pure function of (muniId, p) over idsByMuni/store, so replaying it twice is safe). ---
  const manualSeen = new Set();
  const manualCtx = { errorPages: 0, nonUpcoming: 0 };
  const muniStats = [];
  for (const name of Object.keys(munis)) {
    const acc = newAccumulator({ seen: manualSeen });
    muniStats.push(await walkMuni(name, name, acc, CLOCK, manualCtx));
  }
  // Clamp must terminate: Big has 123 listings → 3 content pages + 1 zero-new page = 4.
  const big = muniStats.find(m => m.name === 'Big');
  assert.ok(big.pages <= 5, `Big should stop by ~p4 (clamp), got p${big.pages}`);
  const empty = muniStats.find(m => m.name === 'Empty');
  assert.strictEqual(empty.pages, 1, 'Empty muni should stop at p1');
  assert.strictEqual(manualCtx.nonUpcoming, 1, `injected non-upcoming card should be filtered (nonUpcoming=${manualCtx.nonUpcoming})`);
  assert.ok(!manualSeen.has('INJECT'), 'injected non-upcoming card must not be counted');

  // --- run() contract: national bands, per-muni sum, exact 2nd-hand histogram, gates, notes ---
  const res = await run({ locations: { Big: 'Big', Small: 'Small', Undated: 'Undated', Empty: 'Empty' }, nowSec: CLOCK, logger: () => {} });
  // National bands must equal ground truth built from the synthetic store.
  for (let k = 0; k < truth.length; k++) {
    assert.strictEqual(res.buckets[BAND_KEYS[k]], truth[k], `band ${BAND_KEYS[k]}: ${res.buckets[BAND_KEYS[k]]} != ${truth[k]}`);
  }
  assert.strictEqual(res.buckets.undated, truthUndated, 'undated mismatch');
  assert.strictEqual(res.nTotal, Object.keys(store).length, 'nTotal must equal distinct listings');
  // Per-muni rows exist and sum back to the national histogram.
  assert.strictEqual(res.muni.length, 4, 'one row per muni, including empties');
  const perMuniSum = res.muni.reduce((a, m) => a + BAND_KEYS.reduce((s, k) => s + m.buckets[k], 0), 0);
  const nationalSum = BAND_KEYS.reduce((s, k) => s + res.buckets[k], 0);
  assert.strictEqual(perMuniSum, nationalSum, 'Σ per-muni bands must equal the national histogram');
  // 2nd-hand histogram is exact here (every card is walked).
  assert.ok(res.bucketsSecondhand != null, 'muni-partition must produce an exact 2nd-hand histogram');
  assert.strictEqual(res.newbuildSampled, false);
  assert.ok(res.gates.some(g => g.name === 'reconciliation'));
  // The injected non-upcoming card must never be counted: nTotal already equals the
  // synthetic store's size, which excludes it. Assert the filter counter too.
  assert.strictEqual(res.nTotal, Object.keys(store).length, 'injected non-upcoming card must not be counted');
  assert.ok(/1 non-upcoming/.test(res.notes || ''), 'the filtered card must be reported in notes');

  const md = buildMd('SELFTEST', res, null);
  assert.ok(md.includes('Census histogram'));
  console.log(`SELFTEST PASS — census==truth (${res.nTotal} distinct across ${res.muni.length} munis), clamp terminates, report renders.`);

  // --- p1-retry must not lose page-2+ data collected during the failed first attempt ---
  // Regression test (fix round 1): a p1 error does not stop walkMuni — it logs, continues, and
  // page 2+ may fetch successfully into that walk's accumulator before the walk gives up. The
  // earlier retry logic REPLACED accs[i] with a brand-new empty accumulator, silently discarding
  // whatever page 2+ had already collected (the shared `seen` Set makes the ids un-recoverable:
  // the retry's own page-2+ re-fetch finds them already seen and stops immediately). The fix
  // REUSES accs[i] on retry so the retried page 1 ADDS to what page 2+ already contributed.
  //
  // 'Flaky' has 60 listings, 50/page → p1 fails on the FIRST attempt only; the first attempt's
  // p2 (10 real listings) succeeds before the walk clamps and gives up; the retry's p1 succeeds
  // and picks up the remaining 50. All 60 must survive in the final national total.
  const flakyAges = Array.from({ length: 60 }, (_, i) => i * 3);
  const flakyStore = {};
  const flakyIds = flakyAges.map((a, i) => { const id = 'F' + i; flakyStore[id] = a; return id; });
  let flakyP1Calls = 0;
  pageFetcher = async (muniId, p) => {
    if (muniId !== 'Flaky') return { status: 200, cards: [], total: 0 };
    if (p === 1) {
      flakyP1Calls++;
      if (flakyP1Calls === 1) return { status: 500, cards: null, total: undefined };   // fails ONLY on the first attempt
    }
    const start = (p - 1) * PAGE;
    const slice = start >= flakyIds.length ? [flakyIds[flakyIds.length - 1]] : flakyIds.slice(start, start + PAGE);
    const cards = slice.map(id => ({ id, published: CLOCK - flakyStore[id] * DAY, isNewBuild: false, upcoming: true }));
    return { status: 200, cards, total: p === 1 ? flakyIds.length : undefined };
  };
  const flakyTruth = new Array(EDGES.length + 1).fill(0);
  for (const a of flakyAges) flakyTruth[bandIndex(a, EDGES)]++;

  const resFlaky = await run({ locations: { Flaky: 'Flaky' }, nowSec: CLOCK, logger: () => {} });
  assert.strictEqual(flakyP1Calls, 2, `expected exactly 2 calls to Flaky's p1 (fail then retry), got ${flakyP1Calls}`);
  // THE assertion that fails against the pre-fix code: nTotal must include BOTH the page-1
  // listings (only ever fetched on the retry) and the page-2+ listings (fetched — and, pre-fix,
  // discarded — during the failed first attempt).
  assert.strictEqual(resFlaky.nTotal, flakyIds.length, `nTotal must include all ${flakyIds.length} Flaky listings (page-1 + page-2+), got ${resFlaky.nTotal}`);
  for (let k = 0; k < flakyTruth.length; k++) {
    assert.strictEqual(resFlaky.buckets[BAND_KEYS[k]], flakyTruth[k], `Flaky band ${BAND_KEYS[k]}: ${resFlaky.buckets[BAND_KEYS[k]]} != ${flakyTruth[k]}`);
  }
  assert.strictEqual(resFlaky.muni.length, 1, 'one muni row for Flaky');
  assert.strictEqual(resFlaky.muni[0].countedN, flakyIds.length, `muni row countedN must equal the true listing count, got ${resFlaky.muni[0].countedN}`);
  const flakyPerMuniSum = BAND_KEYS.reduce((s, k) => s + resFlaky.muni[0].buckets[k], 0);
  const flakyNationalSum = BAND_KEYS.reduce((s, k) => s + resFlaky.buckets[k], 0);
  assert.strictEqual(flakyPerMuniSum, flakyNationalSum, 'Σ per-muni bands must equal the national histogram even after a p1-retry');
  console.log(`SELFTEST PASS — p1-retry preserves page-2+ data collected during the failed first attempt (Flaky: ${resFlaky.nTotal}/${flakyIds.length} recovered).`);
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

  // Write raw JSON FIRST so a formatting bug in buildMd can never destroy a ~400-480-call result.
  fs.writeFileSync(path.join(OUT_DIR, `hemnet-age-census-${dateStr}.json`), JSON.stringify(res, null, 2));
  const md = buildMd(dateStr, res, booli);
  fs.writeFileSync(path.join(OUT_DIR, `hemnet-age-census-${dateStr}.md`), md);
  console.log(`\n${md}`);
  console.log(`\nOxylabs calls: ${res.oxCalls}`);
  console.log(`Artifact -> ${OUT_DIR}/hemnet-age-census-${dateStr}.{json,md}`);
}

module.exports = { run };
if (require.main === module) main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
