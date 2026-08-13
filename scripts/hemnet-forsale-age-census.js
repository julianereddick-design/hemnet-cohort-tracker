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
// Per-muni accumulators (lib/age-census.js) share ONE global `seen` Set so dedupe stays global
// while bands stay per-muni; the WHOLE recursion for one municipality — every sub-scope it
// spawns — folds into THAT municipality's accumulator. The national histogram is then the sum
// of the per-muni ones, which is also what makes the reconciliation gate (Σ headline totals vs
// distinct union) meaningful. Unlike the Booli binary-search estimate, every card here is
// walked, so the 2nd-hand histogram is an exact band-wise subtraction, not a sample.
//
//   node   scripts/hemnet-forsale-age-census.js --selftest          # offline, synthetic; free
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js --sizes          # page-1 totals for the biggest munis
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js --probe [Muni]   # 1 muni live (default Stockholm)
//   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js                  # full national run (~1,208 calls)
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');
const { DAY } = require('../lib/premarket-flow');
const {
  EDGES, BAND_KEYS, newAccumulator, addCardTo, mergeAccumulators, bucketsToObject, secondhandToObject,
  gateReconciliation, gateTotalDrift, gateErrorPages, gateCoverage, evaluateGates,
} = require('../lib/age-census');

const NOW_SEC = Math.floor(Date.now() / 1000);
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

// Walk ONE scope (already known to be < clamp) to exhaustion, folding every card into THIS
// municipality's accumulator. `ctx` carries cross-cutting counters (errorPages, nonUpcoming)
// that are not per-muni. Returns { pages, clampedSuspect }.
async function walkScope(scope, acc, nowSec, ctx) {
  let pages = 0, lastFresh = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const r = await safeFetch(scope, p);
    pages = p;
    if (r.cards == null) { ctx.errorPages++; log('WARN', `${scopeLabel(scope)} p${p} status ${r.status} — gap, continuing`); continue; }
    if (r.cards.length === 0) break;
    const up = r.cards.filter(c => c.upcoming).length;
    if (up) { ctx.nonUpcoming += up; log('WARN', `${scopeLabel(scope)} p${p}: ${up} upcoming card(s) filtered`); }
    const forSale = r.cards.filter(c => !c.upcoming);
    let fresh = 0;
    for (const c of forSale) if (addCardTo(acc, c, nowSec)) fresh++;
    lastFresh = fresh;
    if (fresh === 0) break;                    // clamp/end: no new IDs → stop
  }
  return { pages, clampedSuspect: pages === MAX_PAGES && lastFresh > 0 };
}

// Record a scope whose page 1 never fetched. A level-0 failure means a WHOLE municipality was
// skipped (its listings vanish from both sides of the reconciliation gate — see gateCoverage in
// lib/age-census.js); a level-1/2 failure is a sub-scope of a big muni, still a real gap but a
// partial one. They are tracked separately because the two are not equally bad.
// `failedScopes` is a cumulative diagnostic across the whole run (retries included);
// `failedMunis` is the authoritative post-retry list the coverage gate reads, so run()'s retry
// pass removes a muni from it before re-walking and the re-walk puts it back only if it fails again.
function noteScopeFailure(ctx, scope, level) {
  ctx.failedScopes = (ctx.failedScopes || 0) + 1;
  const label = scope.name || String(scope.locationId);
  if (level === 0) {
    if (!ctx.failedMunis) ctx.failedMunis = [];
    if (!ctx.failedMunis.includes(label)) ctx.failedMunis.push(label);
  } else {
    if (!ctx.failedSubScopes) ctx.failedSubScopes = [];
    ctx.failedSubScopes.push(scopeLabel(scope));
  }
}

// Recursively census a scope, sub-partitioning (item_type → price band) until under the clamp.
// level 0 = whole muni, 1 = item_type fixed, 2 = item_type+price fixed. Every sub-scope this
// recursion spawns folds into the SAME `acc` — the caller's municipality accumulator — so the
// whole recursive tree for one muni ends up in one place. Returns { headline, sub, p1Error }.
async function censusScope(scope, level, acc, nowSec, ctx) {
  const first = await safeFetch(scope, 1);
  const total = first.cards == null ? null : first.total;
  if (first.cards == null) {
    ctx.errorPages++;
    noteScopeFailure(ctx, scope, level);
    log('WARN', `${scopeLabel(scope)} p1 status ${first.status} — scope skipped`);
    return { headline: 0, sub: [], p1Error: true };
  }
  if (total != null && total <= THRESHOLD) {
    // Reuse the page-1 cards we already have, then continue walking.
    const forSale = first.cards.filter(c => !c.upcoming);
    for (const c of forSale) addCardTo(acc, c, nowSec);
    if (total > forSale.length) { for (let p = 2; p <= MAX_PAGES; p++) { const r = await safeFetch(scope, p); if (r.cards == null) { ctx.errorPages++; continue; } if (r.cards.length === 0) break; const fs2 = r.cards.filter(c => !c.upcoming); let fresh = 0; for (const c of fs2) if (addCardTo(acc, c, nowSec)) fresh++; if (fresh === 0) break; } }
    return { headline: total, sub: [] };
  }
  // Over threshold → sub-partition.
  if (level === 0) {
    log('INFO', `${scopeLabel(scope)} total=${total} > ${THRESHOLD} → splitting by item_type`);
    let sumTypes = 0;
    for (const t of ITEM_TYPES) { const r = await censusScope({ ...scope, itemType: t }, 1, acc, nowSec, ctx); sumTypes += r.headline; }
    const residual = total - sumTypes;
    if (residual > 0.02 * total) log('WARN', `${scopeLabel(scope)}: item_types cover ${sumTypes}/${total}; ~${residual} listings not in the 6 types (uncovered residual)`);
    return { headline: total, sub: ITEM_TYPES };
  }
  if (level === 1) {
    log('INFO', `${scopeLabel(scope)} total=${total} > ${THRESHOLD} → splitting by price band`);
    for (const b of PRICE_BANDS) {
      const s = { ...scope, priceMin: b.min != null ? b.min : null, priceMax: b.max != null ? b.max : null };
      const r = await safeFetch(s, 1);
      // A failed page 1 here skipped a price band of a big municipality without ever entering
      // censusScope, so it has to be booked as a scope failure explicitly — otherwise this one
      // path is the single place a coverage gap could still slip past the counters.
      if (r.cards == null) { ctx.errorPages++; noteScopeFailure(ctx, s, 2); log('WARN', `${scopeLabel(s)} p1 status ${r.status} — price band skipped`); continue; }
      if (r.total > 0) await censusScope(s, 2, acc, nowSec, ctx);
    }
    return { headline: total, sub: PRICE_BANDS.length + ' price bands' };
  }
  // level 2: type+price still over clamp (rare) — walk anyway, warn about undercount.
  log('WARN', `${scopeLabel(scope)} total=${total} still > clamp after type+price — walking, will undercount by ~${total - CLAMP_LISTINGS}`);
  await walkScope(scope, acc, nowSec, ctx);
  return { headline: total, sub: [] };
}

async function censusMuni(name, id, acc, nowSec, ctx) {
  const before = acc.distinct;
  const r = await censusScope({ locationId: id, name }, 0, acc, nowSec, ctx);
  return { name, id, headline: r.headline, counted: acc.distinct - before, p1Error: !!r.p1Error };
}

async function run({ locations = LOCATIONS, nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  const seen = new Set();
  const ctx = { errorPages: 0, nonUpcoming: 0, failedScopes: 0, failedMunis: [], failedSubScopes: [] };
  const names = Object.keys(locations);
  const accs = [], stats = [];
  let headlineSum = 0, i = 0;

  for (const name of names) {
    const acc = newAccumulator({ seen });
    const st = await censusMuni(name, locations[name], acc, nowSec, ctx);
    headlineSum += st.headline || 0;
    accs.push(acc); stats.push(st);
    if (++i % 25 === 0) logger('INFO', `…${i}/${names.length} munis, distinct=${seen.size}`);
  }

  const nat = mergeAccumulators(accs);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const gates = [
    gateReconciliation({ headlineSum, distinct: nat.distinct, maxPct: 2 }),
    // A skipped municipality subtracts itself from BOTH sides of gateReconciliation, so that
    // gate cannot see it. gateCoverage is the only thing standing between a run missing a whole
    // municipality and a status='ok' row posted to Slack as a validated figure.
    gateCoverage({ failedMunis: ctx.failedMunis, totalMunis: names.length }),
    gateErrorPages({ errorPages: ctx.errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: nat.distinct, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  const notes = [
    ctx.failedMunis.length ? `munis skipped entirely (p1 never fetched): ${ctx.failedMunis.join(', ')}` : null,
    ctx.failedSubScopes.length ? `${ctx.failedSubScopes.length} sub-scopes skipped: ${ctx.failedSubScopes.slice(0, 8).join(', ')}${ctx.failedSubScopes.length > 8 ? ', …' : ''}` : null,
    ctx.nonUpcoming ? `${ctx.nonUpcoming} upcoming cards filtered` : null,
    nat.anomalies ? `${nat.anomalies} publishedAt anomalies` : null,
    ev.passed ? null : `gates failed: ${ev.failures.join(', ')}`,
  ].filter(Boolean).join('; ') || null;

  return {
    platform: 'hemnet', pool: 'forsale', method: 'muni-partition',
    nTotal: nat.distinct, nUndated: nat.undated,
    nNewbuild: nat.newbuild.reduce((a, b) => a + b, 0),
    newbuildSampled: false, newbuildSampleN: null,
    buckets: bucketsToObject(nat.buckets, nat.undated),
    bucketsSecondhand: secondhandToObject(nat.buckets, nat.newbuild, nat.undated),
    muni: stats.map((s, k) => ({
      name: s.name, id: Number(s.id) || 0,
      headlineN: s.headline || 0, countedN: s.counted,
      buckets: bucketsToObject(accs[k].buckets, accs[k].undated),
      bucketsSecondhand: secondhandToObject(accs[k].buckets, accs[k].newbuild, accs[k].undated),
    })),
    oxCalls, errorPages: ctx.errorPages, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed', notes,
  };
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
function buildMd(dateStr, res, booli) {
  const buckets = BAND_KEYS.map(k => res.buckets[k]);
  const bucketsSecondhand = BAND_KEYS.map(k => res.bucketsSecondhand[k]);
  const datedTotal = buckets.reduce((a, b) => a + b, 0);
  const undated = res.buckets.undated;
  const headlineSum = res.muni.reduce((a, m) => a + (m.headlineN || 0), 0);
  const L = [];
  L.push(`# Hemnet for-sale (Till salu) age penetration — national — ${dateStr}`, '');
  L.push(`Municipality-partition census over ${res.muni.length} munis (big munis sub-partitioned by item_type + price). Age = days since Hemnet publish.`, '');
  L.push('## Census histogram', '');
  L.push('| Bucket | Count | % of dated | Cumulative % | of which new-build |');
  L.push('|---|--:|--:|--:|--:|');
  let cum = 0;
  for (let k = 0; k < LABELS.length; k++) {
    cum += buckets[k];
    const nb = buckets[k] - bucketsSecondhand[k]; // exact: bucketsSecondhand is a band-wise subtraction, never sampled
    L.push(`| ${LABELS[k]} | ${buckets[k].toLocaleString()} | ${pct(buckets[k], datedTotal).toFixed(1)}% | ${pct(cum, datedTotal).toFixed(1)}% | ${nb} |`);
  }
  L.push(`| _undated_ | ${undated.toLocaleString()} | — | — | — |`);
  L.push(`| **dated total** | **${datedTotal.toLocaleString()}** | | | ${res.nNewbuild} new-build |`, '');
  if (booli) {
    const bb = booli.bands, bTot = bb.reduce((a, b) => a + b, 0);
    L.push('## Like-for-like: Hemnet vs Booli for-sale (share of dated pool)', '');
    L.push('| Bucket | Hemnet % | Booli % |'); L.push('|---|--:|--:|');
    for (let k = 0; k < LABELS.length; k++) L.push(`| ${LABELS[k]} | ${pct(buckets[k], datedTotal).toFixed(1)}% | ${pct(bb[k], bTot).toFixed(1)}% |`);
    const h3 = pct(buckets[0] + buckets[1], datedTotal), b3 = pct(bb[0] + bb[1], bTot);
    const h24 = pct(buckets[6], datedTotal), b24 = pct(bb[6], bTot);
    L.push('', `Hemnet ${h3.toFixed(0)}% ≤3mo vs Booli ${b3.toFixed(0)}%; zombie tail (>24mo) Hemnet ${h24.toFixed(1)}% vs Booli ${b24.toFixed(1)}%.`, '');
  } else {
    L.push('_(No Booli for-sale census artifact found for the combined table.)_', '');
  }
  const withListings = res.muni.filter(m => m.countedN > 0).length;
  L.push('## Coverage & quality', '');
  L.push(`- Munis: ${res.muni.length} processed, ${withListings} with FS listings.`);
  L.push(`- Distinct listings counted: **${res.nTotal.toLocaleString()}** (dated ${datedTotal.toLocaleString()} + undated ${undated}).`);
  L.push(`- Σ muni headline totals=${headlineSum.toLocaleString()} vs distinct counted ${res.nTotal.toLocaleString()} (gap = clamp-undercount + dedupe; count is truth).`);
  L.push(`- Error/gap pages: ${res.errorPages}. Oxylabs calls: **${res.oxCalls}**. Runtime: ${res.runtimeS}s.`);
  L.push(`- Gates: ${res.gates.map(g => `${g.name}=${g.passed ? 'pass' : 'FAIL'}`).join(', ')} (status: ${res.status}).`);
  if (res.notes) L.push(`- Notes: ${res.notes}`);
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
    const acc = newAccumulator({ seen: new Set() });
    const ctx = { errorPages: 0, nonUpcoming: 0 };
    const r = await censusMuni('Small', 9001, acc, NOW_SEC, ctx);
    assert.strictEqual(r.counted, 120, `counted ${r.counted}`);
  });

  await check('big muni: sub-partition recovers FULL count (beats the 2,500 clamp)', async () => {
    const acc = newAccumulator({ seen: new Set() });
    const ctx = { errorPages: 0, nonUpcoming: 0 };
    const r = await censusMuni('Big', 9002, acc, NOW_SEC, ctx);
    assert.strictEqual(r.headline, BIG_TOTAL, `headline ${r.headline}`);
    assert.strictEqual(r.counted, BIG_TOTAL, `recovered ${r.counted} of ${BIG_TOTAL} — clamp not beaten`);
  });

  await check('naive single-scope walk WOULD have clamped at 2,500 (proves the problem is real)', async () => {
    // Walk Big as one scope with no sub-partition — should stop at the clamp.
    const s = new Set(); let cnt = 0;
    for (let p = 1; p <= MAX_PAGES; p++) { const r = await fetchScope({ name: 'Big' }, p); if (!r.cards.length) break; let fresh = 0; for (const c of r.cards) if (!s.has(c.id)) { s.add(c.id); cnt++; fresh++; } if (fresh === 0) break; }
    assert.ok(cnt <= CLAMP_LISTINGS && cnt < BIG_TOTAL, `naive walk got ${cnt}, expected clamp <=${CLAMP_LISTINGS}`);
  });

  await check('run(): per-muni rows sum to the national histogram, 2nd-hand exact', async () => {
    const res = await run({ locations: { Small: 9001, Big: 9002 }, nowSec: NOW_SEC, logger: () => {} });
    assert.strictEqual(res.pool, 'forsale');
    assert.strictEqual(res.method, 'muni-partition');
    assert.strictEqual(res.muni.length, 2);
    const perMuni = res.muni.reduce((a, m) => a + BAND_KEYS.reduce((s, k) => s + m.buckets[k], 0), 0);
    const national = BAND_KEYS.reduce((s, k) => s + res.buckets[k], 0);
    assert.strictEqual(perMuni, national, 'Σ per-muni must equal national');
    assert.strictEqual(res.nTotal, 120 + BIG_TOTAL, 'sub-partition must recover the full count, not the 2,500 clamp');
    assert.ok(res.bucketsSecondhand != null);
    assert.strictEqual(res.newbuildSampled, false);
  });

  // --- a whole municipality that never fetches must be IMPOSSIBLE to hide -------------------
  // The reconciliation gate cancels itself out here: a muni whose page 1 fails contributes 0
  // to Σ headline AND 0 to the distinct union, so Δ stays ≈0% and reconciliation PASSES on a
  // run that is missing a whole municipality (Stockholm alone ≈ 11.5% of the national pool).
  // error_pages (1 bad page in ~1,200) and total_drift (−11.5%, under 25%) wave it through too.
  // Only gateCoverage catches it — this test asserts exactly that, and asserts reconciliation
  // still passes, so it fails loudly if anyone ever removes the coverage gate.
  await check('a municipality whose page 1 never fetches trips the coverage gate and is named in notes', async () => {
    const clean = fetchScope;
    let brokenCalls = 0;
    fetchScope = async (scope, p) => {
      if ((scope.name || scope.locationId) === 'Broken') { brokenCalls++; return { status: 500, cards: null, total: undefined }; }
      return clean(scope, p);
    };
    try {
      const res = await run({ locations: { Small: 9001, Broken: 9003 }, nowSec: NOW_SEC, logger: () => {} });
      assert.ok(brokenCalls > 0, 'the broken fetcher was never exercised — test setup is wrong');
      const rec = res.gates.find(g => g.name === 'reconciliation');
      const cov = res.gates.find(g => g.name === 'coverage');
      assert.ok(rec, 'reconciliation gate must be present');
      assert.strictEqual(rec.passed, true, 'reconciliation cancels itself out here — that is precisely why the coverage gate is needed');
      assert.ok(cov, 'a coverage gate must be evaluated on every muni-partition run');
      assert.strictEqual(cov.passed, false, 'a whole skipped municipality must fail the coverage gate');
      assert.strictEqual(res.status, 'gate_failed', `a run missing a whole municipality must never be stored as ok (got ${res.status})`);
      assert.ok(/Broken/.test(res.notes || ''), `the skipped municipality must be named in notes (got: ${res.notes})`);
    } finally {
      fetchScope = clean;
    }
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
  const acc = newAccumulator({ seen: new Set() });
  const ctx = { errorPages: 0, nonUpcoming: 0 };
  const r = await censusMuni(name, id, acc, NOW_SEC, ctx);
  const ox = getOxylabsStats();
  const naiveWouldGet = Math.min(r.headline, CLAMP_LISTINGS);
  console.log(`\n  headline FS total: ${r.headline}`);
  console.log(`  distinct counted (sub-partitioned union): ${r.counted}`);
  console.log(`  a naive single-scope walk would have clamped at: ~${naiveWouldGet}`);
  console.log(`  coverage vs headline: ${pct(r.counted, r.headline).toFixed(1)}%`);
  console.log(`  buckets=${JSON.stringify(acc.buckets)}  undated=${acc.undated}`);
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
  console.log('===== HEMNET FS AGE CENSUS — FULL NATIONAL RUN =====\n');
  const res = await run({ logger: log });
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const booli = loadLatestBooliFs();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = path.join(OUT_DIR, `hemnet-forsale-age-census-${dateStr}.md`);
  const jsonPath = path.join(OUT_DIR, `hemnet-forsale-age-census-${dateStr}.json`);
  // Write raw JSON FIRST so a formatting bug in buildMd can never destroy a ~1,208-call result.
  fs.writeFileSync(jsonPath, JSON.stringify({ ...res, dateStr, edges: EDGES }, null, 2));
  const md = buildMd(dateStr, res, booli);
  fs.writeFileSync(mdPath, md);
  console.log('\n' + md);
  console.log(`\nWrote ${mdPath}\nWrote ${jsonPath}`);
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--selftest') { selftest(); }
  else {
    // --sizes, --probe, and the default full run all make real page fetches. Refuse to run
    // un-proxied so a bare invocation never hammers the target site directly from whatever
    // machine ran it — the same guard scripts/hemnet-age-census.js and
    // scripts/booli-age-census.js already use. The orchestrator sets this itself; this only
    // ever bites a manual invocation.
    if (process.env.SCRAPE_FORCE_OXYLABS !== '1') {
      console.error('Refusing to run un-proxied. Set SCRAPE_FORCE_OXYLABS=1 (or use --selftest).');
      process.exit(1);
    }
    if (arg === '--sizes') runSizes().catch(e => { console.error(e); process.exit(1); });
    else if (arg === '--probe') runProbe(process.argv[3]).catch(e => { console.error(e); process.exit(1); });
    else runFull().catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { run, censusScope, censusMuni };
