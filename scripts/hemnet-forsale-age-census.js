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
    // Stored as a RECORD, not just a label: run()'s retry pass needs the scope object and its
    // level to re-attempt it, and the muni name to find the accumulator it belongs to.
    ctx.failedSubScopes.push({ scope, level, label: scopeLabel(scope), muni: scope.name || String(scope.locationId) });
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

async function run({ locations = LOCATIONS, nowSec = NOW_SEC, logger = log, priorTotal = null, priorMuniSizes = null } = {}) {
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

  // Retry municipalities whose page 1 errored — a whole-muni coverage gap, and this is the
  // largest and longest-running of the four pools, so it is the most exposed to a transient
  // blip (2026-07-20 cost a whole weekly datapoint that way). Mirrors the sibling pre-market
  // census. The retry REUSES that municipality's existing accumulator and never replaces it:
  // replacing it would discard anything the first attempt already collected, and the shared
  // global `seen` Set makes those ids unrecoverable (the re-walk would dedupe them away).
  // Global dedupe also makes the retry safe — nothing already folded in is counted twice.
  // A retried muni is dropped from ctx.failedMunis first, so it counts toward the coverage
  // gate only if it fails AGAIN; ctx.failedScopes keeps the cumulative attempt count.
  const p1errs = stats.map((s, k) => ({ s, k })).filter(x => x.s.p1Error);
  if (p1errs.length) {
    logger('WARN', `retrying ${p1errs.length} munis whose p1 errored: ${p1errs.map(x => x.s.name).join(', ')}`);
    for (const { s, k } of p1errs) {
      ctx.failedMunis = ctx.failedMunis.filter(n => n !== s.name);
      const st = await censusMuni(s.name, locations[s.name], accs[k], nowSec, ctx);
      headlineSum += st.headline || 0;
      stats[k] = st;
    }
  }

  // Retry failed SUB-SCOPES the same way, reusing the municipality's accumulator. A failed
  // item_type or price band inside a sub-partitioned muni is a hole in a big municipality —
  // Stockholm's 3-4M apartments, say — and it was previously only ever caught if it happened to
  // be large enough to trip gateReconciliation's 2% threshold. Anything smaller was a silent
  // hole in a status='ok' row. Ordered AFTER the muni retry because a muni retry can itself
  // spawn fresh sub-scope failures. The list is cleared first so the re-walk re-books only what
  // is STILL failing; the re-walk adds through global dedupe, so nothing is double-counted.
  const subErrs = ctx.failedSubScopes;
  if (subErrs.length) {
    ctx.failedSubScopes = [];
    logger('WARN', `retrying ${subErrs.length} sub-scopes whose p1 errored: ${subErrs.map(r => r.label).join(', ')}`);
    for (const rec of subErrs) {
      const k = names.indexOf(rec.muni);
      // A record we cannot place against a municipality cannot be retried — keep it booked as
      // a failure rather than dropping it, since dropping it would hide the gap.
      if (k < 0) { ctx.failedSubScopes.push(rec); continue; }
      await censusScope(rec.scope, rec.level, accs[k], nowSec, ctx);
    }
  }

  const nat = mergeAccumulators(accs);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;

  // Size the sub-scope gaps by MEASUREMENT, not by guesswork. A sub-scope only ever fails inside
  // a municipality whose own page 1 succeeded — which means that municipality told us its
  // headline total, and we know how many distinct listings we actually counted for it. The
  // shortfall `headlineN - countedN` is therefore the measured volume of everything missing
  // inside it, needs no prior month, and works on the very first run. It is booked ONCE per
  // municipality (not once per failed band) because one shortfall covers all of them jointly.
  // Only a sub-scope we cannot attribute to a surviving municipality stays unmeasurable.
  const measuredMissing = [], unmeasurableSubs = [];
  const subsByMuni = new Map();
  for (const rec of ctx.failedSubScopes) {
    if (!subsByMuni.has(rec.muni)) subsByMuni.set(rec.muni, []);
    subsByMuni.get(rec.muni).push(rec);
  }
  for (const [muni, recs] of subsByMuni) {
    const k = names.indexOf(muni);
    const st = k >= 0 ? stats[k] : null;
    if (k < 0 || !st || st.p1Error || !(st.headline > 0)) {
      unmeasurableSubs.push(...recs.map(r => r.label));           // no headline to measure against
      continue;
    }
    const missing = Math.max(0, st.headline - accs[k].distinct);
    measuredMissing.push({ label: recs.length === 1 ? recs[0].label : `${muni} ×${recs.length} sub-scopes`, missing });
  }

  // What the coverage gate is asked to size. Municipality names resolve against the prior
  // month's per-muni rows; a whole municipality we never reached has no headline of its own, so
  // it stays prior-sized (and fails outright when there is no prior). Sub-scopes now arrive
  // pre-measured instead, so a 3-listing price band publishes with a note rather than voiding
  // a ~43,000-listing pool.
  const coverageFailures = [...ctx.failedMunis, ...unmeasurableSubs];
  const gates = [
    gateReconciliation({ headlineSum, distinct: nat.distinct, maxPct: 2 }),
    // A skipped municipality subtracts itself from BOTH sides of gateReconciliation, so that
    // gate cannot see it. gateCoverage is the only thing standing between a run missing a whole
    // municipality and a status='ok' row posted to Slack as a validated figure. It is SIZED:
    // last valid month's per-muni totals estimate the gap, so losing Alingsås (7 listings) does
    // not void the month while losing Stockholm (~5,000) does. nationalTotal is the COUNTED
    // total, which excludes the gap and so is a slightly conservative denominator.
    gateCoverage({ failedMunis: coverageFailures, priorMuniSizes, measuredMissing, nationalTotal: nat.distinct, maxPct: 0.5 }),
    gateErrorPages({ errorPages: ctx.errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: nat.distinct, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  const notes = [
    ctx.failedMunis.length ? `munis skipped entirely (p1 never fetched): ${ctx.failedMunis.join(', ')}` : null,
    // A sub-scope gap that PASSES the sized threshold must still be visible on the published
    // row, with its measured volume, so a reader knows exactly what the number is missing.
    ctx.failedSubScopes.length
      ? `${ctx.failedSubScopes.length} sub-scopes skipped: ${ctx.failedSubScopes.slice(0, 8).map(r => r.label).join(', ')}${ctx.failedSubScopes.length > 8 ? ', …' : ''}`
        + ` (measured shortfall ${measuredMissing.reduce((a, m) => a + m.missing, 0)} listings)`
      : null,
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
    // countedN reads the accumulator's own `distinct`, not the last censusMuni call's returned
    // `counted` — a muni retried after a p1 error accumulates across TWO censusMuni calls, and
    // `counted` is a delta measured from the accumulator's state at the START of that call, so
    // the retry's value alone would under-report the muni's true listing count.
    muni: stats.map((s, k) => ({
      name: s.name, id: Number(s.id) || 0,
      headlineN: s.headline || 0, countedN: accs[k].distinct,
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
      // UNCHANGED by the measured-shortfall work: a whole municipality we never reached has no
      // headline of its own, so there is nothing to measure and no prior size to fall back on.
      assert.ok(/NO measurable size/.test(cov.detail), `a whole-muni gap with no prior size must still fail outright: ${cov.detail}`);
    } finally {
      fetchScope = clean;
    }
  });

  // --- a TRANSIENT page-1 failure is retried, and the muni is fully recovered ---------------
  // A level-0 p1 failure abandons the whole municipality, so without a retry pass one blip on
  // the longest-running pool of the four permanently loses a municipality (and now, correctly,
  // fails the whole run's coverage gate). The retry must recover it and clear the gate.
  await check('a municipality whose page 1 fails once is retried and fully recovered', async () => {
    const clean = fetchScope;
    let flakyP1Calls = 0;
    addListings('Flaky', 'bostadsratt', 2000000, 80, 2);
    fetchScope = async (scope, p) => {
      if ((scope.name || scope.locationId) === 'Flaky' && p === 1) {
        flakyP1Calls++;
        if (flakyP1Calls === 1) return { status: 500, cards: null, total: undefined };   // fails only the FIRST time
      }
      return clean(scope, p);
    };
    try {
      const res = await run({ locations: { Flaky: 9004 }, nowSec: NOW_SEC, logger: () => {} });
      assert.strictEqual(flakyP1Calls, 2, `expected exactly 2 calls to Flaky's p1 (fail then retry), got ${flakyP1Calls}`);
      assert.strictEqual(res.nTotal, 80, `the retry must recover all 80 listings, got ${res.nTotal}`);
      assert.strictEqual(res.muni[0].countedN, 80, `the muni row must report the true count, got ${res.muni[0].countedN}`);
      assert.strictEqual(res.muni[0].headlineN, 80, 'the retry must also recover the headline total');
      const cov = res.gates.find(g => g.name === 'coverage');
      assert.strictEqual(cov.passed, true, `a muni recovered by the retry must NOT count as skipped: ${cov.detail}`);
      assert.strictEqual(res.status, 'ok', `a fully recovered run must not be gate_failed (notes: ${res.notes})`);
    } finally {
      fetchScope = clean;
    }
  });

  // --- the coverage gate is SIZED, and a passing gap stays visible ---------------------------
  await check('a small known-size municipality gap passes the gate but is still named in notes', async () => {
    const clean = fetchScope;
    fetchScope = async (scope, p) => {
      if ((scope.name || scope.locationId) === 'Tiny') return { status: 500, cards: null, total: undefined };
      return clean(scope, p);
    };
    try {
      const res = await run({
        locations: { Small: 9001, Big: 9002, Tiny: 9005 }, nowSec: NOW_SEC, logger: () => {},
        priorMuniSizes: { Tiny: 5, Small: 120, Big: 4200 },      // Tiny held 5 listings last month
      });
      const cov = res.gates.find(g => g.name === 'coverage');
      assert.strictEqual(cov.passed, true, `5 of 4,320 = 0.12% must not void the month: ${cov.detail}`);
      assert.ok(/0\.12%/.test(cov.detail), `the estimated share must be stated: ${cov.detail}`);
      assert.strictEqual(res.status, 'ok', `a 0.12% gap must leave the row publishable (notes: ${res.notes})`);
      assert.ok(/Tiny/.test(res.notes || ''), 'a gap that PASSES the threshold must still be named on the published row');
      // …and the same gap, sized as Stockholm, must fail
      const big = await run({
        locations: { Small: 9001, Big: 9002, Tiny: 9005 }, nowSec: NOW_SEC, logger: () => {},
        priorMuniSizes: { Tiny: 5000 },
      });
      assert.strictEqual(big.gates.find(g => g.name === 'coverage').passed, false, 'the same gap sized at 5,000 must fail');
      assert.strictEqual(big.status, 'gate_failed');
    } finally {
      fetchScope = clean;
    }
  });

  // --- a failed PRICE BAND inside a sub-partitioned muni ------------------------------------
  // These 40 listings are deliberately small: 40 of 4,240 = 0.94%, UNDER gateReconciliation's
  // 2% threshold. That is the whole point — a failed sub-scope was recorded in notes and
  // errorPages but had no hard gate, so it was caught only when it happened to be big enough to
  // trip reconciliation. Anything smaller was a silent hole in a status='ok' row.
  addListings('Big', 'bostadsratt', 250000, 40, 3);          // Big/bostadsratt/0-1M
  const BIG_WITH_BAND = BIG_TOTAL + 40;

  await check('a price band failing BOTH attempts is SIZED by measured shortfall, and 0.95% fails', async () => {
    const clean = fetchScope;
    let bandCalls = 0;
    fetchScope = async (scope, p) => {
      if ((scope.name || scope.locationId) === 'Big' && scope.itemType === 'bostadsratt' && scope.priceMax === 1000000 && p === 1) {
        bandCalls++; return { status: 500, cards: null, total: undefined };
      }
      return clean(scope, p);
    };
    try {
      const res = await run({ locations: { Big: 9002 }, nowSec: NOW_SEC, logger: () => {}, priorMuniSizes: { Big: BIG_WITH_BAND } });
      assert.strictEqual(bandCalls, 2, `the failed band must be re-attempted exactly once (got ${bandCalls} attempts)`);
      const rec = res.gates.find(g => g.name === 'reconciliation');
      assert.strictEqual(rec.passed, true, `40 of 4,240 stays under the 2% reconciliation threshold — that is why a hard gate is needed: ${rec.detail}`);
      const cov = res.gates.find(g => g.name === 'coverage');
      assert.strictEqual(cov.passed, false, `40 of 4,200 = 0.95% is over the 0.5% threshold: ${cov.detail}`);
      // sized by MEASUREMENT (headlineN − countedN), not written off as unknown
      assert.ok(/measured 40/.test(cov.detail), `the gap must be measured, not guessed: ${cov.detail}`);
      assert.ok(!/NO measurable size/.test(cov.detail), 'a sub-scope inside a surviving muni is measurable');
      assert.ok(/0\.95%/.test(cov.detail), cov.detail);
      assert.strictEqual(res.status, 'gate_failed', `a gap over the threshold must not publish as ok (notes: ${res.notes})`);
      assert.ok(/Big\/bostadsratt\/0-1M/.test(res.notes || ''), `the band must be named in notes (got: ${res.notes})`);
      assert.strictEqual(res.nTotal, BIG_TOTAL, 'the 40 listings behind the failed band are genuinely missing');
    } finally {
      fetchScope = clean;
    }
  });

  await check('a price band failing ONCE is retried and fully recovered', async () => {
    const clean = fetchScope;
    let bandCalls = 0;
    fetchScope = async (scope, p) => {
      if ((scope.name || scope.locationId) === 'Big' && scope.itemType === 'bostadsratt' && scope.priceMax === 1000000 && p === 1) {
        bandCalls++;
        if (bandCalls === 1) return { status: 500, cards: null, total: undefined };   // transient
      }
      return clean(scope, p);
    };
    try {
      const res = await run({ locations: { Big: 9002 }, nowSec: NOW_SEC, logger: () => {}, priorMuniSizes: { Big: BIG_WITH_BAND } });
      assert.strictEqual(bandCalls, 2, `expected fail-then-retry on the band, got ${bandCalls} attempts`);
      assert.strictEqual(res.nTotal, BIG_WITH_BAND, `the retry must recover all ${BIG_WITH_BAND} listings, got ${res.nTotal}`);
      assert.strictEqual(res.gates.find(g => g.name === 'coverage').passed, true, 'a recovered band must not count as a coverage failure');
      assert.strictEqual(res.status, 'ok', `a fully recovered run must publish (notes: ${res.notes})`);
    } finally {
      fetchScope = clean;
    }
  });

  // --- a SMALL sub-scope gap must publish with a note, not void the pool ---------------------
  // The client chose proportional coverage. A price band holding 10 listings inside a ~4,250
  // municipality is 0.24% — treating it as fatal (which "sub-scopes are unknown by construction"
  // did) would void the most expensive pool of the four over a rounding error. The size does not
  // need a prior month: Big's page 1 SUCCEEDED, so its headline total is known, and
  // headlineN − countedN measures exactly what is missing inside it.
  addListings('Big', 'bostadsratt', 9000000, 10, 7);         // Big/bostadsratt/8-12M
  const BIG_WITH_BANDS = BIG_WITH_BAND + 10;

  await check('a SMALL measured sub-scope gap passes the gate and is still named in notes', async () => {
    const clean = fetchScope;
    let bandCalls = 0;
    fetchScope = async (scope, p) => {
      if ((scope.name || scope.locationId) === 'Big' && scope.itemType === 'bostadsratt' && scope.priceMin === 8000000 && p === 1) {
        bandCalls++; return { status: 500, cards: null, total: undefined };
      }
      return clean(scope, p);
    };
    try {
      const res = await run({ locations: { Big: 9002 }, nowSec: NOW_SEC, logger: () => {} });
      assert.strictEqual(bandCalls, 2, `the band must be re-attempted once before being sized (got ${bandCalls})`);
      const cov = res.gates.find(g => g.name === 'coverage');
      // measured: headline 4,250 − counted 4,240 = 10, i.e. 0.24% of counted
      assert.ok(/measured 10/.test(cov.detail), `the shortfall must be measured from headline − counted: ${cov.detail}`);
      assert.ok(/0\.24%/.test(cov.detail), cov.detail);
      assert.strictEqual(cov.passed, true, `0.24% must not void a 4,250-listing pool: ${cov.detail}`);
      assert.strictEqual(res.status, 'ok', `a sub-0.5% gap must publish (notes: ${res.notes})`);
      // …and it must remain VISIBLE on that published row
      assert.ok(/Big\/bostadsratt\/8-12M/.test(res.notes || ''), `the band must still be named in notes (got: ${res.notes})`);
      assert.ok(/measured shortfall 10 listings/.test(res.notes || ''), `notes must carry the measured volume (got: ${res.notes})`);
      assert.strictEqual(res.nTotal, BIG_WITH_BANDS - 10, 'the 10 listings behind the failed band really are absent');
      // no prior-run data was supplied at all — measurement must not depend on one
      assert.ok(!/NO measurable size/.test(cov.detail), 'measured sizing must work on a first-ever run');
      // gateReconciliation sees the SAME listings and must read coherently, not contradict:
      // it reports Δ over Σ headline, the coverage gate reports it over the counted total.
      const rec = res.gates.find(g => g.name === 'reconciliation');
      assert.strictEqual(rec.passed, true, `10 of 4,250 is far under the 2% reconciliation threshold: ${rec.detail}`);
      assert.ok(/4250 vs distinct 4240/.test(rec.detail), `reconciliation must show the same 10-listing gap: ${rec.detail}`);
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
