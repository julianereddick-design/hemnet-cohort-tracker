'use strict';
// scripts/forsale-age-penetration.js — FOR-SALE (Till salu) age-penetration estimate,
// Hemnet vs Booli, using the CHEAP binary-search method only (no full census).
//
// This is the for-sale companion to the pre-market age census
// (scripts/{booli,hemnet}-age-census.js). The binary-search estimator was VALIDATED
// against a full census on the pre-market pool (bake-off PASS, ~16× cheaper), so here we
// run it standalone: bisect the newest-first pool for the page where age crosses each
// cutoff (30/90/180/365/548/730d) and read the cumulative-younger count off the page index.
// Core bisection = lib/premarket-flow.js:findCrossoverPage (shared, unit-tested).
//
// Streams (both newest-first, FS-only):
//   Hemnet FS   https://www.hemnet.se/bostader?sort=NEWEST&page=N            (~44.5k)
//   Booli  FS   https://www.booli.se/sok/till-salu?upcomingSale=0&page=N     (~53k)
//
// TWO BASES (monthly run() only, since 2026-08-13): Booli honours `isNewConstruction=0` on
// this search, so the whole two-pass procedure runs a SECOND time over the filtered stream.
// The unfiltered basis fills `buckets`, the filtered one `bucketsSecondhand`, and the two
// headline totals give an EXACT new-build count instead of a sampled rate. Four searches,
// ~168 calls. The standalone CLI paths (--preflight / --sortprobe / the default full report)
// are unchanged and still walk the unfiltered stream only.
//
// DESIGN RISK the preflight guards against:
//   Hemnet clamps NATIONAL pagination (pre-market Kommande capped ~2,500 of 8,368 — see
//   hemnet-age-census.js header). If national FS pagination is likewise capped, the deep
//   pages holding the older age bands are unreachable and binary-search CANNOT run for
//   Hemnet nationally (would need muni-partition, which is the expensive census path).
//   --preflight probes page 1 + a deep page per platform and reports viability BEFORE any
//   full run. Booli allowed 955-page pre-market pagination, so it is expected clamp-free.
//
// Modes:
//   node scripts/forsale-age-penetration.js --selftest    # offline, synthetic pools; free
//   SCRAPE_FORCE_OXYLABS=1 node scripts/forsale-age-penetration.js --preflight   # ~6 live calls
//   SCRAPE_FORCE_OXYLABS=1 node scripts/forsale-age-penetration.js               # full estimate
//
// Cost: preflight ~6 calls; full run ~7 cutoffs × ~log2(pages) + preflight ≈ 80-100 calls
// per viable platform (~160-200 total). Trivial vs a full census (~2,000).
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');
const { parseBooliSearchCards } = require('../lib/booli-fetch');
const { bandIndex, cardAgeDays, pageMedianAge, findCrossoverPage, DAY } = require('../lib/premarket-flow');

const NOW_SEC = Math.floor(Date.now() / 1000);
const EDGES = [30, 90, 180, 365, 548, 730];              // day cutoffs → 7 bands + undated
const LABELS = ['≤1mo', '1–3mo', '3–6mo', '6–12mo', '12–18mo', '18–24mo', '>24mo'];
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

let errorPages = 0;               // real page-fetch failures (null-cards, persistent non-200s); reset per run()

// Resilient fetch: getWithRetry already retries the HTTP call, but transient DNS/network
// blips (ENOTFOUND realtime.oxylabs.io) can still throw through it. Retry a few times with
// backoff so a single blip mid-bisection doesn't abort the whole probe.
async function safeFetch(plat, p, asc = false, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await plat.fetch(p, asc); }
    catch (e) {
      lastErr = e;
      log('WARN', `${plat.name} page ${p} threw (${e.message.slice(0, 60)}) — retry ${i + 1}/${tries}`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function apolloFrom(html) {
  const data = extractNextData(html);
  const apollo = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apollo) throw new Error('__APOLLO_STATE__ missing');
  return apollo;
}

// Read Hemnet's national for-sale pool total off ROOT_QUERY.searchForSaleListings(...).total.
function hemnetForSaleTotal(apollo) {
  const root = apollo && apollo.ROOT_QUERY;
  if (!root) return undefined;
  for (const k of Object.keys(root)) {
    if (!k.startsWith('searchForSaleListings')) continue;
    const v = root[k];
    if (v && typeof v === 'object' && typeof v.total === 'number') return v.total;
  }
  return undefined;
}

// ---- Platform adapters. Each fetch(p) → { status, cards, total } where cards is a
// normalized array [{ id, published:<unix sec|null>, isNewBuild:bool, upcoming:bool }]
// on a real 200, or null on a persistent non-200 (error, NOT an empty page). ----
const hemnet = {
  name: 'hemnet',
  // asc=true → oldest-first (reach the old tail from the front, around the page clamp).
  url: (p, asc) => `https://www.hemnet.se/bostader?sort=${asc ? 'OLDEST' : 'NEWEST'}&page=${p}`,
  async fetch(p, asc = false) {
    const res = await getWithRetry(this.url(p, asc), { logger: () => {} });
    if (res.status !== 200) return { status: res.status, cards: null, total: undefined };
    const apollo = apolloFrom(res.html);
    const cards = parseListingCards(apollo).map(c => ({
      id: c.id, published: c.publishedAt, isNewBuild: c.newConstruction, upcoming: c.upcoming,
    }));
    return { status: 200, cards, total: p === 1 ? hemnetForSaleTotal(apollo) : undefined };
  },
};
// Booli FS adapter factory. `excludeNewConstruction` appends `isNewConstruction=0`, which
// turns the same stream into a second-hand-only one carrying its own headline total — that is
// what makes an EXACT second-hand histogram possible from a method that never sees most cards.
//
// ONLY that exact spelling works: scripts/probe-booli-newconstruction-filter.js verified live
// (2026-08-13) that `newConstruction=1`, `isNewConstruction=true`, `isNewConstruction=false`
// and `newProduction=1` are all SILENTLY IGNORED and return the unfiltered pool — a wrong
// number that looks right. Do not "tidy" the spelling. Live totals that day for upcomingSale=0:
// 56,493 all / 55,067 filtered / 1,481 new-build (2.62%).
//
// The unfiltered URL is byte-identical to the one this adapter has always produced.
function makeBooli({ excludeNewConstruction = false } = {}) {
  return {
    name: excludeNewConstruction ? 'booli-2ndhand' : 'booli',
    excludeNewConstruction,
    // Default (no sort param) is newest-first. Oldest-first requires the EXPLICIT pair
    // `sort=published&ascending=1` (verified in Booli's own sort UI 2026-07-09 — the old
    // "any sort=* flips ascending" note is stale). upcomingSale=0 = FS-only complement of the
    // pre-market census's upcomingSale=1.
    url(p, asc) {
      return `https://www.booli.se/sok/till-salu?upcomingSale=0${excludeNewConstruction ? '&isNewConstruction=0' : ''}` +
        `&page=${p}${asc ? '&sort=published&ascending=1' : ''}`;
    },
    async fetch(p, asc = false) {
      const res = await getWithRetry(this.url(p, asc), { logger: () => {} });
      if (res.status !== 200) return { status: res.status, cards: null, total: undefined };
      const parsed = parseBooliSearchCards(apolloFrom(res.html));
      const cards = parsed.cards.map(c => ({
        id: c.booli_id, published: c.published, isNewBuild: c.isNewConstruction, upcoming: c.upcomingSale,
      }));
      return { status: 200, cards, total: parsed.totalCount };
    },
  };
}
const booli = makeBooli();
const booliSecondhand = makeBooli({ excludeNewConstruction: true });
// run() reaches the filtered stream through `platform.secondhand`, never through a separate
// default parameter. That is deliberate: a test injecting only `platform` would otherwise
// silently fall through to the REAL Booli adapter and put a synthetic run on the network.
booli.secondhand = booliSecondhand;

// Is a page "reachable" (real, deeper content) vs a clamp artifact (404 / empty / repeats
// the page-1 tail)? Returns { reachable, medianAge } given page-1 IDs for repeat-detection.
function pageReachability(res, ids1) {
  if (res.cards == null) return { reachable: false, why: `status ${res.status}` };
  if (res.cards.length === 0) return { reachable: false, why: 'empty' };
  const overlap = res.cards.filter(c => ids1.has(c.id)).length;
  if (overlap > res.cards.length / 2) return { reachable: false, why: `repeats page-1 (${overlap}/${res.cards.length})` };
  return { reachable: true, medianAge: pageMedianAge(res.cards, NOW_SEC) };
}

// Bisect [lo, hi] for the DEEPEST reachable page (largest p that returns real deeper content).
async function findLastReachablePage(plat, lo, hi, ids1, asc = false) {
  let a = lo, b = hi, best = lo;
  while (a <= b) {
    const mid = a + Math.floor((b - a) / 2);
    const r = pageReachability(await safeFetch(plat, mid, asc), ids1);
    if (r.reachable) { best = mid; a = mid + 1; } else { b = mid - 1; }
  }
  return best;
}

// Probe ONE end of the pool (asc=false newest-first, asc=true oldest-first): confirm the
// sort direction took, then bisect for the clamp and report the reachable depth + the
// age at that clamp. Returns { total, pageSize, lastPage, reachablePage, reachableListings,
// p1MedianAge, clampMedianAge }.
async function probeEnd(plat, asc) {
  const first = await safeFetch(plat, 1, asc);
  if (first.cards == null) { errorPages++; log('WARN', `${plat.name} probeEnd page 1 (${asc ? 'oldest' : 'newest'}-first) status ${first.status} → treated empty`); }
  const total = first.total != null ? first.total : null;
  const pageSize = first.cards ? first.cards.length : 0;
  const lastPage = total && pageSize ? Math.ceil(total / pageSize) : null;
  const ids1 = new Set((first.cards || []).map(c => c.id));
  const p1MedianAge = pageMedianAge(first.cards || [], NOW_SEC);
  let reachablePage = 1, clampMedianAge = p1MedianAge;
  if (lastPage && lastPage > 1) {
    reachablePage = await findLastReachablePage(plat, 1, lastPage, ids1, asc);
    const clamp = await safeFetch(plat, reachablePage, asc);
    if (clamp.cards == null) { errorPages++; log('WARN', `${plat.name} probeEnd clamp page ${reachablePage} (${asc ? 'oldest' : 'newest'}-first) status ${clamp.status} → treated empty`); }
    clampMedianAge = pageMedianAge(clamp.cards || [], NOW_SEC);
  }
  return {
    total, pageSize, lastPage, reachablePage,
    reachableListings: reachablePage * pageSize,
    p1MedianAge, clampMedianAge,
  };
}

// ---- Preflight: verify addressing + newest-first sort, then find the true pagination
// clamp and — decisively — how far back in AGE the reachable pages let us see. Binary-search
// can resolve every age band iff the deepest reachable page is OLDER than the oldest cutoff
// (730d). Returns a structured verdict; never throws on a "site said no" — only on our bugs.
async function preflightPlatform(plat) {
  const out = { name: plat.name, ok: false, reasons: [], total: null, pageSize: null, lastPage: null };
  const first = await safeFetch(plat, 1);
  if (first.cards == null) { out.reasons.push(`page 1 status ${first.status}`); return out; }
  if (first.cards.length === 0) { out.reasons.push('page 1 empty'); return out; }
  out.total = first.total != null ? first.total : null;
  out.pageSize = first.cards.length;
  const dated1 = first.cards.filter(c => c.published != null);
  const fsShare1 = first.cards.length ? first.cards.filter(c => !c.upcoming).length / first.cards.length : 0;
  const med1 = pageMedianAge(first.cards, NOW_SEC);
  out.p1MedianAgeDays = med1;
  out.p1FsShare = fsShare1;
  out.p1Undated = first.cards.length - dated1.length;

  // Addressing: expect an FS-only stream (no upcoming cards leaking in).
  if (fsShare1 < 0.98) out.reasons.push(`page1 FS share ${(fsShare1 * 100).toFixed(0)}% — upcoming leaking into stream`);
  // Newest-first sanity: page-1 median age should be small (fresh listings on top).
  if (med1 == null) out.reasons.push('page1 has no dated cards');
  else if (med1 > 120) out.reasons.push(`page1 median age ${med1.toFixed(0)}d — not newest-first?`);

  if (out.total == null || out.pageSize === 0) { out.reasons.push('no total / pageSize'); return out; }
  out.lastPage = Math.ceil(out.total / out.pageSize);   // page the headline total IMPLIES

  // Find the true clamp boundary + the age we can actually see back to.
  const ids1 = new Set(first.cards.map(c => c.id));
  out.lastReachablePage = await findLastReachablePage(plat, 1, out.lastPage, ids1);
  out.reachablePct = out.lastPage ? out.lastReachablePage / out.lastPage : 0;
  const deep = await safeFetch(plat, out.lastReachablePage);
  out.deepMedianAgeDays = pageMedianAge(deep.cards || [], NOW_SEC);
  out.oldestCutoff = EDGES[EDGES.length - 1];           // 730d

  if (out.lastReachablePage < out.lastPage - 1) {
    out.reasons.push(`CLAMP: only ${out.lastReachablePage}/${out.lastPage} pages reachable (${(out.reachablePct * 100).toFixed(0)}% of pool)`);
  }
  if (out.deepMedianAgeDays == null || out.deepMedianAgeDays < out.oldestCutoff) {
    out.reasons.push(`age horizon ${out.deepMedianAgeDays == null ? 'n/a' : out.deepMedianAgeDays.toFixed(0) + 'd'} < ${out.oldestCutoff}d — older bands unreachable`);
  }

  out.ok = out.reasons.length === 0;
  return out;
}

// ---- Binary-search estimate (the validated cheap method). memo shared across cutoffs so
// probe pages are fetched once. Returns bands + cumulative + undated/newbuild rates. ----
async function estimatePlatform(plat, lastPage, pageSize, memo) {
  const fetchPage = async (p) => {
    if (memo.has(p)) return memo.get(p);
    const r = await safeFetch(plat, p);
    const cards = r.cards || [];
    if (r.cards == null) log('WARN', `${plat.name} probe page ${p} status ${r.status} → treated empty`);
    memo.set(p, cards);
    return cards;
  };
  const cumulative = {};
  for (const C of EDGES) {
    const r = await findCrossoverPage({ fetchPage, cutoffDays: C, nowSec: NOW_SEC, lo: 1, hi: lastPage, pageSize, memo, logger: log });
    cumulative[C] = r.cumulativeYounger;
  }
  // Undated + new-build rates from every page actually seen (preflight + bisection probes).
  let seen = 0, undated = 0, newbuild = 0, datedSeen = 0;
  for (const cards of memo.values()) for (const c of cards) {
    seen++;
    if (c.published == null) { undated++; continue; }
    datedSeen++;
    if (c.isNewBuild) newbuild++;
  }
  const total = lastPage * pageSize;                 // coarse; refined to headline total by caller
  const undatedRate = seen ? undated / seen : 0;
  return { cumulative, undatedRate, newbuildRate: datedSeen ? newbuild / datedSeen : 0, seenPages: memo.size };
}

// Oldest-first companion to findCrossoverPage. On an oldest-first pool (page 1 = oldest,
// age DECREASES with depth), bisect for the page where age crosses below the cutoff, then
// count listings OLDER than the cutoff (age > C ⟺ published < cutoffSec) accumulated from
// the shallow (older) end. Mirrors findCrossoverPage's straddle refinement. Returns
// { straddlePage, cumulativeOlder }. Used for the deep cutoffs Booli's newest-first pass
// can't reach (its clamp is ~171d); the oldest-first pass reaches them from the back.
async function findCrossoverOlder({ fetchPage, cutoffDays, nowSec, lo, hi, pageSize, memo = new Map(), logger = () => {} }) {
  const cutoffSec = nowSec - cutoffDays * DAY;
  const getPage = async (p) => { if (memo.has(p)) return memo.get(p); const c = await fetchPage(p); memo.set(p, c); return c; };
  const countOlder = (cards) => cards.filter(c => c.published != null && c.published < cutoffSec).length;
  let a = lo, b = hi;
  while (a < b) {
    const mid = a + Math.floor((b - a) / 2);
    const m = pageMedianAge(await getPage(mid), nowSec);
    if (m == null || m >= cutoffDays) a = mid + 1;   // still older-median → crossover deeper
    else b = mid;                                     // younger-median → here-or-shallower
  }
  let straddle = a;
  if (straddle > lo) {
    const prev = await getPage(straddle - 1);
    if (countOlder(prev) < prev.length) straddle -= 1; // prev holds some younger-than-C → boundary in prev
  }
  const sc = await getPage(straddle);
  const cumulativeOlder = (straddle - 1) * pageSize + countOlder(sc);
  logger('INFO', `cutoff ${cutoffDays}d (oldest-first) -> straddle page ${straddle}, cumulativeOlder≈${cumulativeOlder}`);
  return { straddlePage: straddle, cumulativeOlder };
}

// Two-pass estimate for a pool whose newest-first clamp censors the older bands but whose
// two ends overlap (e.g. Booli FS). Small cutoffs come from the newest-first pass (cumulative
// YOUNGER, directly); large cutoffs from the oldest-first pass (cumulative OLDER → younger =
// datedTotal − older). The overlap cutoff (90d) is computed both ways as a consistency check.
// `newestHi` / `oldestHi` are each pass's last reachable page. Returns the same shape as
// estimatePlatform plus a `crosscheck` field.
async function estimateTwoPass(plat, { newestHi, oldestHi, pageSize, headlineTotal }) {
  const memoNew = new Map(), memoOld = new Map();
  const fetchNew = async (p) => {
    if (memoNew.has(p)) return memoNew.get(p);
    const r = await safeFetch(plat, p, false);
    if (r.cards == null) { errorPages++; log('WARN', `${plat.name} newest-first probe page ${p} status ${r.status} → treated empty`); }
    const c = r.cards || [];
    memoNew.set(p, c);
    return c;
  };
  const fetchOld = async (p) => {
    if (memoOld.has(p)) return memoOld.get(p);
    const r = await safeFetch(plat, p, true);
    if (r.cards == null) { errorPages++; log('WARN', `${plat.name} oldest-first probe page ${p} status ${r.status} → treated empty`); }
    const c = r.cards || [];
    memoOld.set(p, c);
    return c;
  };

  const NEWEST_CUTS = [30, 90];                          // within the ~171d newest-first horizon
  const OLDEST_CUTS = [90, 180, 365, 548, 730];          // reached from the back (age ≥ ~51d)

  const younger = {};
  for (const C of NEWEST_CUTS) {
    const r = await findCrossoverPage({ fetchPage: fetchNew, cutoffDays: C, nowSec: NOW_SEC, lo: 1, hi: newestHi, pageSize, memo: memoNew, logger: log });
    younger[C] = r.cumulativeYounger;
  }
  // Undated/new-build rates from all seen pages (both passes).
  let seen = 0, undated = 0, newbuild = 0, datedSeen = 0;
  const older = {};
  for (const C of OLDEST_CUTS) {
    const r = await findCrossoverOlder({ fetchPage: fetchOld, cutoffDays: C, nowSec: NOW_SEC, lo: 1, hi: oldestHi, pageSize, memo: memoOld, logger: log });
    older[C] = r.cumulativeOlder;
  }
  // newbuildAll counts new-build flags over EVERY card seen, dated or not — that is the
  // denominator the filter-applied flag signal needs. `newbuild` stays dated-only because
  // newbuildRate has always been a dated-card rate.
  let newbuildAll = 0;
  for (const m of [memoNew, memoOld]) for (const cards of m.values()) for (const c of cards) {
    seen++;
    if (c.isNewBuild) newbuildAll++;
    if (c.published == null) undated++; else { datedSeen++; if (c.isNewBuild) newbuild++; }
  }
  const undatedRate = seen ? undated / seen : 0;
  const datedTotal = headlineTotal * (1 - undatedRate);
  // Merge into one cumulative-younger map: newest pass for 30/90, oldest pass for 180+.
  const cumulative = {
    30: younger[30],
    90: younger[90],
    180: datedTotal - older[180],
    365: datedTotal - older[365],
    548: datedTotal - older[548],
    730: datedTotal - older[730],
  };
  const crosscheck = { cut: 90, newestPass: younger[90], oldestPass: datedTotal - older[90] };
  // seen/newbuild are also returned RAW: on the filtered stream they are the flag signal that
  // says whether Booli honoured `isNewConstruction=0` at all (see filterApplied). newbuildRate
  // is over DATED cards only, which is the wrong denominator for that test.
  return {
    cumulative, undatedRate, newbuildRate: datedSeen ? newbuild / datedSeen : 0,
    seenPages: memoNew.size + memoOld.size, seenCards: seen, newbuildSeen: newbuildAll, crosscheck,
  };
}

// Turn cumulative crossover counts into the 7 age bands, scaled to the headline pool total.
function bandsFromCumulative(cumulative, headlineTotal, undatedRate) {
  const undatedEst = Math.round(headlineTotal * undatedRate);
  const datedBase = headlineTotal - undatedEst;
  const c = cumulative;
  const bands = [
    c[30],
    c[90] - c[30],
    c[180] - c[90],
    c[365] - c[180],
    c[548] - c[365],
    c[730] - c[548],
    datedBase - c[730],
  ].map(v => Math.max(0, Math.round(v)));
  return { bands, undatedEst, datedBase };
}

function buildReport(dateStr, results) {
  const L = [];
  L.push(`# For-sale (Till salu) age penetration — Hemnet vs Booli — binary-search estimate — ${dateStr}`, '');
  L.push('National for-sale pools, newest-first. Age = days since publish. Method = binary-search', '');
  L.push('crossover (validated ±1pp vs census on the pre-market pool); no full census run here.', '');
  for (const r of results) {
    L.push('', `## ${r.name} — pool ${r.headlineTotal.toLocaleString()} (dated ${r.datedBase.toLocaleString()}, undated est ${r.undatedEst.toLocaleString()})`, '');
    L.push('| Bucket | Count | % of pool | Cumulative % |');
    L.push('|---|--:|--:|--:|');
    let cum = 0;
    for (let k = 0; k < LABELS.length; k++) {
      cum += r.bands[k];
      const pct = r.headlineTotal ? (100 * r.bands[k] / r.headlineTotal) : 0;
      const cpct = r.headlineTotal ? (100 * cum / r.headlineTotal) : 0;
      L.push(`| ${LABELS[k]} | ${r.bands[k].toLocaleString()} | ${pct.toFixed(1)}% | ${cpct.toFixed(1)}% |`);
    }
    L.push(`| _undated_ | ${r.undatedEst.toLocaleString()} | — | — |`);
    L.push('', `_Oxylabs calls: ${r.calls}. Pages probed: ${r.seenPages}. New-build rate (seen): ${(r.newbuildRate * 100).toFixed(1)}%._`);
  }
  if (results.length === 2) {
    const [a, b] = results;
    L.push('', '## Like-for-like: share of pool by age', '');
    L.push(`| Bucket | ${a.name} % | ${b.name} % |`);
    L.push('|---|--:|--:|');
    for (let k = 0; k < LABELS.length; k++) {
      const pa = a.headlineTotal ? (100 * a.bands[k] / a.headlineTotal) : 0;
      const pb = b.headlineTotal ? (100 * b.bands[k] / b.headlineTotal) : 0;
      L.push(`| ${LABELS[k]} | ${pa.toFixed(1)}% | ${pb.toFixed(1)}% |`);
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// --selftest: offline, drives preflight + binary-search against synthetic pools.
// Pool A (clean, Booli-like): globally newest-first, no clamp → bands recovered exactly.
// Pool B (clamped, Hemnet-like): deep pages repeat the tail → preflight must FAIL it.
// ---------------------------------------------------------------------------
async function selftest() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SELFTEST FAIL [${name}]: ${e.message}`); fail++; } };

  const PAGE = 20, TOTAL = 2000, LAST = TOTAL / PAGE;  // 100 pages
  const CLOCK = NOW_SEC;   // synthetic pools share the module clock the code reads
  // Clean pool: card global index i has ageDays = i (strictly increasing with depth), and
  // every 25th listing is a new-build (80 of 2,000 — the same order of magnitude as Booli's
  // real 2.62% FS share). Ages are unchanged by that flag, so every pre-existing assertion
  // that reads ages off this pool still holds.
  const NB_EVERY = 25;
  const AGES_ALL = Array.from({ length: TOTAL }, (_, i) => i);
  const AGES_SH = AGES_ALL.filter(a => a % NB_EVERY !== 0);   // the isNewConstruction=0 stream
  // A stream is just an ordered age list. The filtered stream is the same pool with the
  // new-builds dropped and the remainder RE-PAGINATED under its OWN headline total — page p
  // of one stream is not page p of the other, which is exactly how the site behaves.
  const mkPool = (name, ages, isNb = (age) => age % NB_EVERY === 0) => ({
    name,
    async fetch(p, asc = false) {
      const last = Math.ceil(ages.length / PAGE);
      if (p < 1 || p > last) return { status: 200, cards: [], total: ages.length };
      const ordered = asc ? ages.slice().reverse() : ages;   // oldest-first reverses the age axis
      const cards = ordered.slice((p - 1) * PAGE, p * PAGE).map(age => ({
        id: `c${age}`, published: CLOCK - Math.round(age * DAY), isNewBuild: isNb(age), upcoming: false,
      }));
      return { status: 200, cards, total: p === 1 ? ages.length : undefined };
    },
  });
  const cleanPlat = mkPool('clean', AGES_ALL);
  cleanPlat.secondhand = mkPool('clean-2ndhand', AGES_SH);
  const TOTAL_SH = AGES_SH.length;                            // 1,920 — 80 new-builds removed
  // Clamped pool: past page CAP the site repeats page-1 tail (Hemnet-style clamp).
  const CAP = 50;
  const clampPlat = {
    name: 'clamped',
    async fetch(p) {
      const eff = p > CAP ? 1 : p;                       // clamp: deep pages serve page-1-ish tail
      const cards = [];
      for (let j = 0; j < PAGE; j++) {
        const age = (eff - 1) * PAGE + j;
        cards.push({ id: `k${(eff - 1) * PAGE + j}`, published: CLOCK - age * DAY, isNewBuild: false, upcoming: false });
      }
      return { status: 200, cards, total: p === 1 ? TOTAL : undefined };
    },
  };

  await check('preflight passes a clean, clamp-free, FS-only newest-first pool', async () => {
    const v = await preflightPlatform(cleanPlat);
    assert.ok(v.ok, 'expected ok, reasons: ' + JSON.stringify(v.reasons));
    assert.strictEqual(v.lastPage, LAST);
  });

  await check('preflight FAILS a clamped pool (deep page repeats page-1 IDs)', async () => {
    const v = await preflightPlatform(clampPlat);
    assert.ok(!v.ok, 'expected clamp to fail preflight');
    assert.ok(v.reasons.some(r => /CLAMP/i.test(r)), 'expected a CLAMP reason, got: ' + JSON.stringify(v.reasons));
  });

  await check('preflight FAILS an FS stream polluted with upcoming cards', async () => {
    const polluted = {
      name: 'polluted',
      async fetch(p) {
        const r = await cleanPlat.fetch(p);
        if (r.cards.length) r.cards.forEach((c, i) => { c.upcoming = i % 2 === 0; }); // 50% upcoming
        return r;
      },
    };
    const v = await preflightPlatform(polluted);
    assert.ok(!v.ok && v.reasons.some(r => /FS share/i.test(r)), 'expected FS-share failure: ' + JSON.stringify(v.reasons));
  });

  await check('binary-search recovers known bands on the clean pool (exact)', async () => {
    const memo = new Map();
    const est = await estimatePlatform(cleanPlat, LAST, PAGE, memo);
    // Age == global index, so cumulative younger than C days == C listings (for C<=TOTAL).
    for (const C of EDGES) assert.strictEqual(est.cumulative[C], C, `cutoff ${C}: got ${est.cumulative[C]}`);
    const { bands } = bandsFromCumulative(est.cumulative, TOTAL, 0);
    // Bands = successive diffs of edges: [30,60,90,185,183,182, rest].
    assert.deepStrictEqual(bands.slice(0, 6), [30, 60, 90, 185, 183, 182]);
    assert.strictEqual(bands.reduce((a, b) => a + b, 0), TOTAL);       // bands partition the pool
  });

  await check('findCrossoverOlder: exact cumulative-older on an oldest-first pool', async () => {
    // Oldest-first synthetic pool: depth index d (0-based, page1=oldest) → age = (TOTAL-1-d).
    // So card older than C ⟺ age > C ⟺ d < TOTAL-1-C ⟹ cumulativeOlder(C) = TOTAL-1-C.
    const fetchDesc = async (p) => {
      if (p < 1 || p > LAST) return [];
      const out = [];
      for (let j = 0; j < PAGE; j++) {
        const d = (p - 1) * PAGE + j;                 // global depth index
        const age = (TOTAL - 1) - d;                  // decreases with depth
        out.push({ published: CLOCK - age * DAY, isNewBuild: false, upcoming: false });
      }
      return out;
    };
    const memo = new Map();
    for (const C of [30, 90, 180, 365]) {
      const r = await findCrossoverOlder({ fetchPage: fetchDesc, cutoffDays: C, nowSec: CLOCK, lo: 1, hi: LAST, pageSize: PAGE, memo });
      assert.strictEqual(r.cumulativeOlder, TOTAL - 1 - C, `cutoff ${C}: got ${r.cumulativeOlder}, want ${TOTAL - 1 - C}`);
    }
  });

  await check('two-pass merge: younger(newest) and datedTotal−older(oldest) agree in overlap', () => {
    // Given both passes on the same clean pool, cumulativeYounger(C) must reconcile:
    //   younger(C) == datedTotal − older(C). Check at the 90d overlap cutoff (no undated).
    const C = 90, datedTotal = TOTAL;
    const younger90 = C;                              // clean pool: younger(C)=C
    const older90 = TOTAL - 1 - C;                    // from findCrossoverOlder identity
    assert.ok(Math.abs(younger90 - (datedTotal - older90)) <= 1, 'overlap passes must agree within 1');
  });

  await check('bandsFromCumulative carves out undated from the dated base', () => {
    const cumulative = { 30: 100, 90: 200, 180: 300, 365: 400, 548: 450, 730: 480 };
    const { bands, undatedEst, datedBase } = bandsFromCumulative(cumulative, 1000, 0.1);
    assert.strictEqual(undatedEst, 100);        // 10% of 1000
    assert.strictEqual(datedBase, 900);
    assert.strictEqual(bands[6], 900 - 480);    // >24mo residual off the dated base
    assert.strictEqual(bands.slice(0, 6).reduce((a, b) => a + b, 0) + bands[6], datedBase);
  });

  const KEYS = ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24'];

  await check('run(): returns the standard result shape with a crosscheck gate', async () => {
    const res = await run({ platform: cleanPlat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.pool, 'forsale');
    assert.strictEqual(res.method, 'sort-flip');
    assert.ok(res.gates.some(g => g.name === 'crosscheck'), 'two-pass must report a crosscheck gate');
    assert.deepStrictEqual(Object.keys(res.buckets), [...KEYS, 'undated']);
    const sum = KEYS.reduce((a, k) => a + res.buckets[k], 0);
    assert.ok(Math.abs(sum + res.buckets.undated - res.nTotal) <= 1, 'bands must reconcile to nTotal');
    assert.strictEqual(res.errorPages, 0, 'clean synthetic pool must report zero error pages');
    assert.ok(res.gates.some(g => g.name === 'error_pages'), 'gate list must include an error_pages gate');
    assert.strictEqual(res.status, 'ok', `clean pool must pass every gate: ${JSON.stringify(res.gates)}`);
  });

  await check('run(): the isNewConstruction=0 basis yields EXACT second-hand bands', async () => {
    const res = await run({ platform: cleanPlat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.nTotal, TOTAL, 'the all-listings basis keeps the unfiltered headline total');
    assert.ok(res.bucketsSecondhand != null, 'the filtered basis must yield a 2nd-hand histogram, not null');
    assert.deepStrictEqual(Object.keys(res.bucketsSecondhand), [...KEYS, 'undated']);
    // A filtered stream is the same pool minus some cards, so no band can grow.
    for (const k of KEYS) {
      assert.ok(res.bucketsSecondhand[k] <= res.buckets[k],
        `2nd-hand band ${k} (${res.bucketsSecondhand[k]}) must not exceed the all-listings band (${res.buckets[k]})`);
    }
    // …and it must reconcile to the FILTERED total, not the pool total.
    const shSum = KEYS.reduce((a, k) => a + res.bucketsSecondhand[k], 0) + res.bucketsSecondhand.undated;
    assert.ok(Math.abs(shSum - TOTAL_SH) <= 1, `2nd-hand bands ${shSum} must reconcile to the filtered total ${TOTAL_SH}`);
    // Exact new-build count from the two headline totals — no sampling anywhere.
    assert.strictEqual(res.nNewbuild, TOTAL - TOTAL_SH, `nNewbuild must be ${TOTAL} − ${TOTAL_SH}, got ${res.nNewbuild}`);
    assert.strictEqual(res.newbuildSampled, false);
    assert.strictEqual(res.newbuildSampleN, null);
    assert.strictEqual(res.notes, null, `a clean two-basis run has nothing to note: ${res.notes}`);
  });

  // Booli silently ignores unrecognised params: the filtered URL then serves the UNFILTERED
  // pool, and its page 1 carries the unfiltered headline total. The two totals come back equal
  // — or a listing or two apart in EITHER direction from pool drift between the two page-1
  // reads. Before the two-signal check this published bucketsSecondhand == buckets and
  // nNewbuild == 0 as EXACT, with notes=null and status=ok.
  await check('run(): an IGNORED isNewConstruction=0 filter is caught, never published as exact', async () => {
    for (const drift of [0, 2, -2]) {
      const plat = mkPool('clean', AGES_ALL);
      const served = mkPool('clean-2ndhand-ignored', AGES_ALL);      // the site served the UNFILTERED pool
      plat.secondhand = {
        name: 'clean-2ndhand-ignored',
        async fetch(p, asc = false) {
          const r = await served.fetch(p, asc);
          return { ...r, total: p === 1 ? TOTAL - drift : undefined };
        },
      };
      const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
      assert.strictEqual(res.bucketsSecondhand, null, `drift ${drift}: an ignored filter must not publish a 2nd-hand histogram`);
      assert.strictEqual(res.nNewbuild, null, `drift ${drift}: nor a new-build count`);
      assert.strictEqual(res.newbuildSampled, false, `drift ${drift}: still not a sampled figure`);
      assert.ok(/IGNORED/.test(res.notes || ''), `drift ${drift}: the note must say so: ${res.notes}`);
      assert.ok(/flagged new-build/.test(res.notes) && /removes/.test(res.notes),
        `drift ${drift}: both signals must be quoted: ${res.notes}`);
      // The all-listings basis is untouched and must still publish.
      assert.strictEqual(res.status, 'ok', `drift ${drift}: a withheld 2nd basis must NOT fail the pool's gates`);
      assert.strictEqual(res.nTotal, TOTAL, `drift ${drift}: the all-listings basis must survive`);
      const sum = KEYS.reduce((a, k) => a + res.buckets[k], 0) + res.buckets.undated;
      assert.ok(Math.abs(sum - TOTAL) <= 1, `drift ${drift}: the all-listings histogram must survive intact`);
    }
  });

  await check('run(): the VOLUME signal alone catches a stream that removed nothing', async () => {
    // No new-build flags anywhere, so signal (a) can see nothing — but the pool is untouched.
    const plat = mkPool('clean', AGES_ALL);
    plat.secondhand = mkPool('no-flags-no-filter', AGES_ALL, () => false);
    const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.bucketsSecondhand, null, 'a stream that removed 0 listings is not a filtered stream');
    assert.ok(/IGNORED/.test(res.notes || '') && /removes 0 \(0\.000%/.test(res.notes), res.notes);
  });

  await check('run(): the FLAG signal alone catches a stream that only pretends to be filtered', async () => {
    // Volume looks plausible (a 5% "removal") but the cards served are still full of
    // new-builds, so the stream was never filtered. Signal (a) must catch it unaided.
    const plat = mkPool('clean', AGES_ALL);
    const served = mkPool('liar', AGES_ALL);
    plat.secondhand = {
      name: 'liar',
      async fetch(p, asc = false) {
        const r = await served.fetch(p, asc);
        return { ...r, total: p === 1 ? 1900 : undefined };
      },
    };
    const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.bucketsSecondhand, null, 'cards still flagged new-build mean the filter did not apply');
    assert.ok(/IGNORED/.test(res.notes || '') && /flagged new-build/.test(res.notes), res.notes);
  });

  await check('run(): the crosscheck gate covers BOTH bases and fails if either breaches', async () => {
    // Clean pool: both bases agree at 90d, so the single gate passes and its detail names both.
    const ok = await run({ platform: cleanPlat, nowSec: CLOCK, logger: () => {} });
    const g = ok.gates.find(x => x.name === 'crosscheck');
    assert.strictEqual(g.passed, true, g.detail);
    assert.ok(/all-listings:/.test(g.detail) && /2nd-hand:/.test(g.detail), `both bases must be reported: ${g.detail}`);

    // Break the FILTERED basis only: shift its oldest-first stream's ages far off, so its two
    // ends disagree at 90d while the all-listings basis stays perfect. The gate must still fail.
    const skewed = mkPool('clean', AGES_ALL);
    const shBase = mkPool('clean-2ndhand', AGES_SH);
    skewed.secondhand = {
      name: 'clean-2ndhand-skewed',
      async fetch(p, asc = false) {
        const r = await shBase.fetch(p, asc);
        if (asc && r.cards) r.cards = r.cards.map(c => ({ ...c, published: c.published - 400 * DAY }));
        return r;
      },
    };
    const bad = await run({ platform: skewed, nowSec: CLOCK, logger: () => {} });
    const gb = bad.gates.find(x => x.name === 'crosscheck');
    assert.strictEqual(gb.passed, false, `a 2nd-hand basis whose ends disagree must fail the gate: ${gb.detail}`);
    assert.ok(/all-listings:/.test(gb.detail) && /2nd-hand:/.test(gb.detail), gb.detail);
    assert.strictEqual(bad.status, 'gate_failed');
  });

  await check('run(): a FILTERED-basis failure withholds the 2nd basis and keeps the all-listings one', async () => {
    // The overlap check applies per basis — the filtered pool is smaller, so its reachable
    // pages differ. Clamp only the filtered stream, hard enough that its two ends cannot meet.
    // The second basis must be withheld with a note, NOT throw: throwing here would make the
    // orchestrator record the whole pool as failed and persist nothing, discarding the ~84
    // calls already spent on a perfectly good all-listings basis.
    const plat = mkPool('clean', AGES_ALL);
    const shBase = mkPool('clean-2ndhand', AGES_SH);
    plat.secondhand = {
      name: 'clean-2ndhand-clamped',
      async fetch(p, asc = false) {
        // both ends clamp at page 5 → 100 + 100 reachable of 1,920: a hole in the middle.
        const r = await shBase.fetch(p > 5 ? 1 : p, asc);
        return { ...r, total: p === 1 ? TOTAL_SH : undefined };
      },
    };
    const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.bucketsSecondhand, null, 'a basis that could not be measured must not be published');
    assert.strictEqual(res.nNewbuild, null);
    assert.strictEqual(res.nTotal, TOTAL, 'the paid-for all-listings basis must survive');
    const sum = KEYS.reduce((a, k) => a + res.buckets[k], 0) + res.buckets.undated;
    assert.ok(Math.abs(sum - TOTAL) <= 1, 'and stay intact');
    assert.ok(/second-hand.*ends do not overlap/i.test(res.notes || ''),
      `the failure must be named on the row, not swallowed: ${res.notes}`);
    assert.strictEqual(res.status, 'ok', 'the all-listings basis is still valid');
    const g = res.gates.find(x => x.name === 'crosscheck');
    assert.ok(/2nd-hand: not evaluated/.test(g.detail), `the gate must say the 2nd basis was not evaluated: ${g.detail}`);
    assert.strictEqual(g.passed, true, 'and rest on the all-listings basis alone');
  });

  await check('run(): an exhausted safeFetch on the filtered basis degrades the same way', async () => {
    // safeFetch rethrows after its retries. That must be caught too, not just the overlap throw.
    const plat = mkPool('clean', AGES_ALL);
    plat.secondhand = { name: 'always-throws', async fetch() { throw new Error('ENOTFOUND realtime.oxylabs.io'); } };
    const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.bucketsSecondhand, null);
    assert.strictEqual(res.nTotal, TOTAL, 'the all-listings basis must survive a dead filtered stream');
    assert.ok(/ENOTFOUND/.test(res.notes || ''), `the underlying error must reach the row: ${res.notes}`);
  });

  await check('reconcileSecondhandBands: clamps within a page, withholds beyond it', () => {
    const all = [100, 50, 20, 10, 5, 3, 200];
    const clean = reconcileSecondhandBands(all, [90, 45, 18, 9, 4, 2, 180], 20);
    assert.deepStrictEqual(clean.bands, [90, 45, 18, 9, 4, 2, 180], 'a genuine subset passes through untouched');
    assert.deepStrictEqual(clean.clamped, []);
    assert.strictEqual(clean.withhold, null);

    const nudged = reconcileSecondhandBands(all, [100, 50, 20, 10, 8, 3, 180], 20);
    assert.strictEqual(nudged.bands[4], 5, 'a within-one-page excess clamps down to the all-listings band');
    assert.deepStrictEqual(nudged.clamped, ['m12_18 (+3)'], 'and the clamp is named');
    assert.strictEqual(nudged.withhold, null, 'one page of bisection noise is not a reason to bin the basis');
    assert.strictEqual(nudged.bands[0], 100, 'an equal band is not an excess');

    const broken = reconcileSecondhandBands(all, [100, 50, 20, 10, 5, 3, 300], 20);
    assert.strictEqual(broken.bands, null, 'an excess beyond one page withholds the whole basis');
    assert.ok(/gt24/.test(broken.withhold) && /disagree/.test(broken.withhold), broken.withhold);
  });

  // …and it is actually WIRED into run(). Both filtered streams below ARE genuinely filtered
  // (1,920 of 2,000, no new-build flags — both filter signals pass), but their young end is
  // compressed so the first band overshoots the all-listings one.
  const skewAges = (youngN, youngRate) => {
    const a = [];
    for (let i = 0; i < youngN; i++) a.push(i * youngRate);
    const base = youngN * youngRate;
    for (let i = youngN; i < TOTAL_SH; i++) a.push(base + (i - youngN) * 1.2);
    return a;
  };

  await check('run(): a filtered band overshooting by <= one page is CLAMPED, and said so', async () => {
    const plat = mkPool('clean', AGES_ALL);
    plat.secondhand = mkPool('skew-small', skewAges(40, 0.5), () => false);
    const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
    assert.ok(res.bucketsSecondhand != null, `a one-page overshoot must clamp, not withhold: ${res.notes}`);
    assert.ok(/clamped/.test(res.notes || ''), `the clamp must be stated on the row: ${res.notes}`);
    for (const k of KEYS) {
      assert.ok(res.bucketsSecondhand[k] <= res.buckets[k],
        `after clamping, band ${k} must not exceed the all-listings band (${res.bucketsSecondhand[k]} vs ${res.buckets[k]})`);
    }
  });

  await check('run(): a filtered band overshooting by MORE than a page withholds the basis', async () => {
    const plat = mkPool('clean', AGES_ALL);
    plat.secondhand = mkPool('skew-large', skewAges(200, 0.1), () => false);
    const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.bucketsSecondhand, null, 'two bisections that genuinely disagree must not be published');
    assert.strictEqual(res.nNewbuild, null);
    assert.ok(/disagree/.test(res.notes || ''), `the disagreement must be stated: ${res.notes}`);
    assert.strictEqual(res.nTotal, TOTAL, 'the all-listings basis still stands');
  });

  await check('run(): a platform with no .secondhand adapter throws instead of hitting the network', async () => {
    const bare = mkPool('bare', AGES_ALL);           // deliberately no .secondhand
    await assert.rejects(
      () => run({ platform: bare, nowSec: CLOCK, logger: () => {} }),
      /no \.secondhand adapter/,
      'the filtered stream must come from the injected platform, never from a live default');
  });

  await check('booli adapters: the unfiltered URL is unchanged and only isNewConstruction=0 is added', () => {
    // The exact spelling is load-bearing — Booli silently ignores anything else and returns the
    // FULL pool, which would be published as "second-hand" without a single error.
    assert.strictEqual(booli.url(3, false), 'https://www.booli.se/sok/till-salu?upcomingSale=0&page=3');
    assert.strictEqual(booli.url(3, true), 'https://www.booli.se/sok/till-salu?upcomingSale=0&page=3&sort=published&ascending=1');
    assert.strictEqual(booliSecondhand.url(3, false), 'https://www.booli.se/sok/till-salu?upcomingSale=0&isNewConstruction=0&page=3');
    assert.strictEqual(booliSecondhand.url(3, true), 'https://www.booli.se/sok/till-salu?upcomingSale=0&isNewConstruction=0&page=3&sort=published&ascending=1');
    assert.strictEqual(booli.secondhand, booliSecondhand, 'the production adapter must carry its filtered sibling');
    assert.strictEqual(booli.excludeNewConstruction, false);
  });

  // errorPages must count REAL fetch failures, not be hardcoded to 0 (the defect an earlier
  // draft of this plan shipped on the sibling script — see task-5's fix round 1). Page 25 is
  // deliberately targeted: it is the 2nd bisection probe of estimateTwoPass's newest-first
  // fetchNew() for both NEWEST_CUTS (30d, 90d — traced by hand against this pool's geometry:
  // findCrossoverPage always probes mid=50 first for a [1,100] range, then 25), but it is NEVER
  // visited by probeEnd's own findLastReachablePage bisection (which, on this clamp-free pool,
  // converges upward from 50 toward the true deepest page 100: {50,75,88,94,97,99,100}). So
  // breaking page 25 exercises fetchNew's error-counting in isolation without corrupting
  // probeEnd's reachablePage/total for either pass — the run completes with a real (if
  // locally-wrong) cumulative count instead of throwing or producing NaN.
  await check('run(): errorPages counts real fetch failures, not hardcoded to 0', async () => {
    let hit = false;
    const flaky = {
      name: 'flaky',
      secondhand: cleanPlat.secondhand,        // the 2nd-hand basis stays clean, so the count is unambiguous
      async fetch(p, asc = false) {
        if (p === 25 && asc === false) { hit = true; return { status: 500, cards: null, total: undefined }; }
        return cleanPlat.fetch(p, asc);
      },
    };
    const res = await run({ platform: flaky, nowSec: CLOCK, logger: () => {} });
    assert.ok(hit, 'the injected broken page (25, newest-first) was never queried — test setup is wrong');
    assert.strictEqual(res.errorPages, 1, `expected exactly 1 error page from the injected failure, got ${res.errorPages}`);
  });

  // The mirror of the check above: errorPages must span BOTH bases, not just the first. The
  // failure is injected ONLY on the filtered stream, at page 12 of its newest-first pass —
  // traced against that stream's geometry (1,920 listings / 20 per page = 96 pages, so
  // findCrossoverPage descends 48 -> 24 -> 12), and NOT visited by probeEnd's own reachability
  // bisection on that stream ({48, 72, 84, 90, 93, 95, 96}) nor by anything on the unfiltered
  // stream. The all-listings basis runs perfectly clean, so any count at all comes from the
  // second basis, and the expected total is exactly 1.
  await check('run(): errorPages accumulates across BOTH bases', async () => {
    let hitSh = false;
    const shBase = mkPool('clean-2ndhand', AGES_SH);
    const plat = mkPool('clean', AGES_ALL);
    plat.secondhand = {
      name: 'clean-2ndhand-flaky',
      async fetch(p, asc = false) {
        if (p === 12 && asc === false) { hitSh = true; return { status: 500, cards: null, total: undefined }; }
        return shBase.fetch(p, asc);
      },
    };
    const res = await run({ platform: plat, nowSec: CLOCK, logger: () => {} });
    assert.ok(hitSh, 'the injected 2nd-hand-basis failure (page 12, newest-first) was never queried — test setup is wrong');
    assert.strictEqual(res.errorPages, 1,
      `a failure on the 2nd-hand basis alone must raise errorPages to exactly 1, got ${res.errorPages} — the counter must span both bases`);
  });

  await check('gateErrorPages reacts to a real errorPages/oxCalls pair (synthetic run has oxCalls=0, so assert the gate directly)', () => {
    // The selftest's synthetic platforms bypass lib/scrape-http entirely, so oxCalls (real
    // Oxylabs call count) is always 0 inside run() here — gateErrorPages short-circuits to a
    // pass on `!oxCalls` regardless of errorPages (see lib/age-census.js). Prove the gate
    // itself reacts correctly to a real errorPages/oxCalls pair directly, mirroring the count
    // run() just produced above plus a plausible non-zero oxCalls.
    const g = gateErrorPages({ errorPages: 1, oxCalls: 30, maxPct: 2 });
    assert.strictEqual(g.passed, false, `1 error page out of 30 calls (3.3%) must fail the 2% gate: ${g.detail}`);
  });

  console.log(`\nselftest: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Live orchestration
// ---------------------------------------------------------------------------
async function runPreflight() {
  resetOxylabsStats();
  console.log('===== FOR-SALE AGE PENETRATION — PREFLIGHT (live) =====\n');
  const verdicts = [];
  for (const plat of [hemnet, booli]) {
    console.log(`--- ${plat.name} ---`);
    const v = await preflightPlatform(plat);
    console.log(`  total=${v.total} pageSize=${v.pageSize} pages implied=${v.lastPage}`);
    console.log(`  page1: medianAge=${v.p1MedianAgeDays == null ? 'n/a' : v.p1MedianAgeDays.toFixed(1) + 'd'} FS-share=${(v.p1FsShare * 100).toFixed(0)}% undated=${v.p1Undated}`);
    console.log(`  deepest reachable page: ${v.lastReachablePage}/${v.lastPage} (${(v.reachablePct * 100).toFixed(0)}% of pool) — age horizon there=${v.deepMedianAgeDays == null ? 'n/a' : v.deepMedianAgeDays.toFixed(0) + 'd'} (need ≥${v.oldestCutoff}d)`);
    console.log(`  VERDICT: ${v.ok ? '✅ binary-search VIABLE' : '❌ NOT viable — ' + v.reasons.join('; ')}\n`);
    verdicts.push(v);
  }
  console.log(`Oxylabs calls this preflight: ${JSON.stringify(getOxylabsStats())}`);
  const estCalls = verdicts.filter(v => v.ok).reduce((s, v) => s + Math.ceil(Math.log2(Math.max(2, v.lastPage))) * EDGES.length + 6, 0);
  console.log(`If you green-light the full run, est. ~${estCalls} Oxylabs calls for the viable platform(s).`);
  return verdicts;
}

// Does flipping the sort to oldest-first unlock the censored tail? Probe BOTH ends of each
// pool and check whether the newest-reachable and oldest-reachable slices OVERLAP (their
// listing counts sum to >= the pool total). Overlap ⇒ two passes cover the whole age axis.
async function runSortProbe(only) {
  resetOxylabsStats();
  console.log('===== FOR-SALE AGE PENETRATION — SORT-FLIP COVERAGE PROBE (live) =====\n');
  const plats = only ? [hemnet, booli].filter(p => p.name === only) : [hemnet, booli];
  for (const plat of plats) {
    console.log(`--- ${plat.name} ---`);
    const newest = await probeEnd(plat, false);
    const oldest = await probeEnd(plat, true);
    const total = newest.total;
    const combined = newest.reachableListings + oldest.reachableListings;
    const overlap = combined - total;                    // >0 ⇒ ends meet in the middle
    const ascWorked = oldest.p1MedianAge != null && newest.p1MedianAge != null && oldest.p1MedianAge > newest.p1MedianAge + 30;
    console.log(`  total=${total}  pageSize=${newest.pageSize}`);
    console.log(`  NEWEST-first: reach page ${newest.reachablePage}/${newest.lastPage} = ${newest.reachableListings.toLocaleString()} listings; age at clamp ≈ ${newest.clampMedianAge == null ? 'n/a' : newest.clampMedianAge.toFixed(0) + 'd'}`);
    console.log(`  OLDEST-first: page1 medianAge=${oldest.p1MedianAge == null ? 'n/a' : oldest.p1MedianAge.toFixed(0) + 'd'} (asc sort ${ascWorked ? 'TOOK ✅' : 'did NOT flip ❌'}); reach page ${oldest.reachablePage}/${oldest.lastPage} = ${oldest.reachableListings.toLocaleString()} listings; age at clamp ≈ ${oldest.clampMedianAge == null ? 'n/a' : oldest.clampMedianAge.toFixed(0) + 'd'}`);
    const verdict = !ascWorked ? '❌ oldest-first sort did not take — cannot reach tail this way'
      : overlap > 0 ? `✅ FULL COVERAGE via 2 passes — ends overlap by ~${overlap.toLocaleString()} listings`
      : `❌ GAP of ~${(-overlap).toLocaleString()} listings in the middle (${(100 * (-overlap) / total).toFixed(0)}% of pool) unreachable from either end`;
    console.log(`  VERDICT: ${verdict}\n`);
  }
  console.log(`Oxylabs calls this probe: ${JSON.stringify(getOxylabsStats())}`);
}

const { BAND_KEYS, bucketsToObject, gateCrosscheck, gateTotalDrift, gateErrorPages, evaluateGates } = require('../lib/age-census');

// ---------------------------------------------------------------------------
// Second-hand basis validation. Kept local to each script (lib/age-census.js is owned
// elsewhere); the twin lives in scripts/booli-age-census.js and must stay in step.
// ---------------------------------------------------------------------------

// DID THE FILTER ACTUALLY APPLY?
// Booli silently ignores query parameters it does not recognise. When it does, the "filtered"
// URL serves the UNFILTERED pool and its page 1 carries the unfiltered headline total — so the
// two totals come back EQUAL, or a listing or two apart in whichever direction the pool drifted
// between the two page-1 reads. A `filtered > unfiltered` test therefore catches only the
// coin-flip half of that; the other half publishes bucketsSecondhand == buckets and
// nNewbuild == 0 as EXACT, unattended, with no note and no gate. That is precisely the silent
// wrong number this whole feature exists to avoid, and it is why the discovery probe
// (scripts/probe-booli-newconstruction-filter.js) asked for `=1` rather than trusting a small
// `=0` delta. Two independent signals, EITHER of which is disqualifying:
//
//   (a) FLAG   — every card the filtered pass fetched carries isNewBuild. A working filter
//                leaves essentially none behind. Needs a real sample before it can judge.
//   (b) VOLUME — a working filter always removes at least the new-builds. Measured live
//                2026-08-13: for-sale removes 2.62% of the pool, pre-market 0.59%. A removal
//                under 0.1% is not a filter, it is noise.
const FILTER_MAX_NEWBUILD_RATE = 0.005;   // (a) >0.5% of cards seen still flagged new-build
const FILTER_MIN_REMOVED_PCT = 0.001;     // (b) <0.1% of the pool removed
const FILTER_MIN_FLAG_SAMPLE = 100;       // cards the filtered pass must have seen before (a) judges

function filterApplied({ unfilteredTotal, filteredTotal, cardsSeen = 0, newbuildSeen = 0 }) {
  if (!unfilteredTotal || filteredTotal == null) {
    return { applied: false, reason: `no headline total to compare (unfiltered ${unfilteredTotal}, filtered ${filteredTotal})` };
  }
  const nbRate = cardsSeen ? newbuildSeen / cardsSeen : 0;
  const removed = unfilteredTotal - filteredTotal;
  const removedPct = removed / unfilteredTotal;
  const canJudgeFlag = cardsSeen >= FILTER_MIN_FLAG_SAMPLE;
  const flagTrips = canJudgeFlag && nbRate > FILTER_MAX_NEWBUILD_RATE;
  const volumeTrips = removedPct < FILTER_MIN_REMOVED_PCT;
  const evidence =
    `${newbuildSeen}/${cardsSeen} cards seen on the filtered pass are still flagged new-build ` +
    `(${(nbRate * 100).toFixed(2)}%, max ${(FILTER_MAX_NEWBUILD_RATE * 100).toFixed(2)}%` +
    `${canJudgeFlag ? '' : `; under ${FILTER_MIN_FLAG_SAMPLE} cards, too small to judge`}); ` +
    `filtered total ${filteredTotal} vs unfiltered ${unfilteredTotal} removes ${removed} ` +
    `(${(removedPct * 100).toFixed(3)}%, min ${(FILTER_MIN_REMOVED_PCT * 100).toFixed(3)}%)`;
  if (flagTrips || volumeTrips) {
    return { applied: false, reason: `the isNewConstruction=0 filter appears to have been IGNORED — ${evidence}` };
  }
  return { applied: true, reason: evidence };
}

// BAND-SUBSET INVARIANT, ENFORCED AT RUN TIME.
// The two bases come from two INDEPENDENT bisections, each carrying up to ±pageSize of error,
// so a thin band can come back LARGER in the filtered basis than in the all-listings one —
// which would imply a negative new-build count in that band. Within one page of slack that is
// estimator noise: clamp to the all-listings band and say so on the row. Beyond a page the two
// bisections genuinely disagree and the whole second basis is untrustworthy, so it is withheld.
// Returns { bands, clamped:[label], withhold:<reason|null> }; bands is null when withholding.
function reconcileSecondhandBands(bands, filteredBands, pageSize) {
  const out = filteredBands.slice();
  const clamped = [];
  const slack = Math.max(1, pageSize || 1);
  for (let k = 0; k < bands.length; k++) {
    const excess = filteredBands[k] - bands[k];
    if (excess <= 0) continue;
    if (excess > slack) {
      return {
        bands: null, clamped,
        withhold: `band ${BAND_KEYS[k]} is ${filteredBands[k]} in the 2nd-hand basis vs ${bands[k]} in the ` +
          `all-listings one — an excess of ${excess}, more than one page (${slack}); the two bisections disagree`,
      };
    }
    out[k] = bands[k];
    clamped.push(`${BAND_KEYS[k]} (+${excess})`);
  }
  return { bands: out, clamped, withhold: null };
}

// One full two-pass estimate (newest-first + oldest-first) over ONE stream. Everything that
// used to sit inline in run() lives here, so the second basis reuses it verbatim instead of a
// parallel copy. `label` only names the stream in errors and logs.
//
// The overlap check applies per stream: the filtered pool is SMALLER, so its page count and
// therefore its reachable pages differ from the unfiltered one's. A basis whose two ends do
// not meet cannot cover the age axis and must not be silently published.
async function estimateBasis(plat, label) {
  const newest = await probeEnd(plat, false);
  const oldest = await probeEnd(plat, true);
  const overlap = newest.reachableListings + oldest.reachableListings - newest.total;
  if (overlap <= 0) throw new Error(`${label}: two-pass ends do not overlap (gap ${-overlap}) — cannot cover the age axis`);
  const est = await estimateTwoPass(plat, {
    newestHi: newest.reachablePage, oldestHi: oldest.reachablePage,
    pageSize: newest.pageSize, headlineTotal: newest.total,
  });
  const { bands, undatedEst } = bandsFromCumulative(est.cumulative, newest.total, est.undatedRate);
  return { newest, oldest, overlap, est, bands, undatedEst, headlineTotal: newest.total };
}

// Monthly-job entry point: Booli FS estimate, run over TWO streams.
//   all listings          -> buckets            (the two-pass sort-flip, unchanged)
//   isNewConstruction=0   -> bucketsSecondhand  (the SAME procedure, filtered stream)
// nNewbuild is then the difference of the two headline totals — exact, not sampled.
// `platform` is injectable so --selftest drives a synthetic pool; the filtered stream is taken
// from `platform.secondhand` so an injected platform can never leak onto the real network.
// Production always passes the module's `booli` adapter.
//
// Cost: ~84 calls per basis, ~168 total (four searches: two ends x two streams).
async function run({ platform = booli, nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  errorPages = 0;
  if (!platform.secondhand) {
    throw new Error(`platform "${platform.name}" has no .secondhand adapter — the second-hand basis cannot be measured`);
  }
  const all = await estimateBasis(platform, 'all listings');

  // The second basis runs AFTER ~84 successful calls on the first. A clamp quirk on the
  // smaller filtered pool, or an exhausted safeFetch, must therefore not throw away a good
  // all-listings month: the orchestrator would record the pool as failed and persist nothing,
  // discarding work already paid for. Any failure here withholds the second basis and notes
  // it — the same honest degradation the pre-market script performs.
  const secondhandNotes = [];
  const withhold = (why) => { secondhandNotes.push(`second-hand basis withheld: ${why}`); logger('WARN', why); };
  let sh = null;
  try {
    sh = await estimateBasis(platform.secondhand, 'second-hand (isNewConstruction=0)');
  } catch (e) {
    withhold(e.message);
  }

  let bucketsSecondhand = null, nNewbuild = null;
  if (sh) {
    const verdict = filterApplied({
      unfilteredTotal: all.headlineTotal, filteredTotal: sh.headlineTotal,
      cardsSeen: sh.est.seenCards, newbuildSeen: sh.est.newbuildSeen,
    });
    if (!verdict.applied) {
      withhold(verdict.reason);
    } else {
      const rec = reconcileSecondhandBands(all.bands, sh.bands, all.newest.pageSize);
      if (rec.withhold) {
        withhold(rec.withhold);
      } else {
        bucketsSecondhand = bucketsToObject(rec.bands, sh.undatedEst);
        nNewbuild = all.headlineTotal - sh.headlineTotal;   // EXACT: two headline totals
        if (rec.clamped.length) {
          const note = `2nd-hand bands clamped to the all-listings bands in ${rec.clamped.join(', ')} — within one page (${all.newest.pageSize}) of bisection noise`;
          secondhandNotes.push(note);
          logger('WARN', note);
        }
      }
    }
  }

  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;   // covers BOTH bases
  // The crosscheck is the gate that says "the two ends of this pool agree where they meet".
  // A filtered basis whose ends disagree is exactly as untrustworthy as an unfiltered one, so
  // BOTH are evaluated and reported, and either breach fails the single named gate. When the
  // filtered basis never completed there is nothing to evaluate on that side — the gate then
  // rests on the all-listings basis alone and says so, because the second basis has already
  // been withheld with its own note rather than published unchecked.
  const ccAll = gateCrosscheck({ newestPass: all.est.crosscheck.newestPass, oldestPass: all.est.crosscheck.oldestPass, headlineTotal: all.headlineTotal, maxPct: 3 });
  const ccSh = sh
    ? gateCrosscheck({ newestPass: sh.est.crosscheck.newestPass, oldestPass: sh.est.crosscheck.oldestPass, headlineTotal: sh.headlineTotal, maxPct: 3 })
    : { passed: true, detail: 'not evaluated — basis withheld' };
  const gates = [
    { name: 'crosscheck', passed: ccAll.passed && ccSh.passed, detail: `all-listings: ${ccAll.detail} | 2nd-hand: ${ccSh.detail}` },
    gateErrorPages({ errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: all.headlineTotal, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  // A withheld second basis does NOT fail the pool's gates: the all-listings basis is still
  // valid and must still publish. The report renders notes on ok rows, so this stays visible
  // without destroying a good month.
  const notes = [];
  if (!ev.passed) notes.push(`gates failed: ${ev.failures.join(', ')}`);
  notes.push(...secondhandNotes);
  logger('INFO', `run() bands=${JSON.stringify(all.bands)} 2ndHandBands=${sh ? JSON.stringify(sh.bands) : 'withheld'} calls=${oxCalls} gates=${ev.passed ? 'ok' : ev.failures.join(',')}`);
  return {
    platform: 'booli', pool: 'forsale', method: 'sort-flip',
    nTotal: all.headlineTotal, nUndated: all.undatedEst,
    nNewbuild,
    newbuildSampled: false, newbuildSampleN: null,
    buckets: bucketsToObject(all.bands, all.undatedEst),
    bucketsSecondhand,
    muni: [],
    oxCalls, errorPages, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed',
    notes: notes.length ? notes.join('; ') : null,
  };
}

// Booli full national FS age histogram via the two-pass (newest + oldest-first) method.
// Hemnet is intentionally skipped: its national FS pagination clamps at 2,500 (~3d) and
// has no oldest-first sort, so even two-pass covers only ~13% — it needs muni-partition.
async function runFull() {
  resetOxylabsStats();
  console.log('===== FOR-SALE AGE PENETRATION — FULL ESTIMATE (Booli, two-pass) =====\n');
  const results = [];

  console.log('--- booli (newest + oldest-first) ---');
  const newest = await probeEnd(booli, false);
  const oldest = await probeEnd(booli, true);
  const overlap = newest.reachableListings + oldest.reachableListings - newest.total;
  console.log(`  total=${newest.total} pageSize=${newest.pageSize}`);
  console.log(`  newest reach ${newest.reachablePage}p (${newest.reachableListings} listings, →${newest.clampMedianAge == null ? 'n/a' : newest.clampMedianAge.toFixed(0) + 'd'}); oldest reach ${oldest.reachablePage}p (${oldest.reachableListings} listings, →${oldest.clampMedianAge == null ? 'n/a' : oldest.clampMedianAge.toFixed(0) + 'd'}); overlap ${overlap}`);
  if (overlap <= 0) {
    console.log('  ABORT: ends do not overlap — cannot cover the full age axis.');
    return;
  }
  const est = await estimateTwoPass(booli, {
    newestHi: newest.reachablePage, oldestHi: oldest.reachablePage,
    pageSize: newest.pageSize, headlineTotal: newest.total,
  });
  const { bands, undatedEst, datedBase } = bandsFromCumulative(est.cumulative, newest.total, est.undatedRate);
  const cc = est.crosscheck;
  const ccDelta = Math.abs(cc.newestPass - cc.oldestPass);
  console.log(`  90d crosscheck: newest-pass younger=${Math.round(cc.newestPass)} vs oldest-pass younger=${Math.round(cc.oldestPass)} (Δ=${Math.round(ccDelta)}, ${(100 * ccDelta / newest.total).toFixed(1)}% of pool)`);
  console.log(`  bands=${JSON.stringify(bands)} undatedEst=${undatedEst}\n`);
  results.push({
    name: 'booli', headlineTotal: newest.total, bands, undatedEst, datedBase,
    newbuildRate: est.newbuildRate, seenPages: est.seenPages,
    calls: getOxylabsStats().oxylabsCallCount || 0, crosscheck: cc,
  });

  console.log('--- hemnet: SKIPPED — national FS clamps at 2,500 (~3d), no oldest-first sort; needs muni-partition ---\n');

  if (!results.length) { console.log('No viable platform — nothing to report.'); return; }
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const md = buildReport(dateStr, results);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = path.join(OUT_DIR, `forsale-age-penetration-${dateStr}.md`);
  const jsonPath = path.join(OUT_DIR, `forsale-age-penetration-${dateStr}.json`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify({ dateStr, nowSec: NOW_SEC, edges: EDGES, results }, null, 2));
  console.log(md);
  console.log(`\nWrote ${mdPath}\nWrote ${jsonPath}`);
  console.log(`Oxylabs calls: ${JSON.stringify(getOxylabsStats())}`);
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--selftest') selftest();
  else if (arg === '--sortprobe') runSortProbe(process.argv[3]).catch(e => { console.error(e); process.exit(1); });
  else if (arg === '--preflight') runPreflight().catch(e => { console.error(e); process.exit(1); });
  else runFull().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { preflightPlatform, estimatePlatform, estimateTwoPass, estimateBasis, findCrossoverOlder, bandsFromCumulative, filterApplied, reconcileSecondhandBands, makeBooli, hemnet, booli, booliSecondhand, run };
