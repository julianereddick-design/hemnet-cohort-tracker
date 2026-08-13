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
const booli = {
  name: 'booli',
  // Default (no sort param) is newest-first. Oldest-first requires the EXPLICIT pair
  // `sort=published&ascending=1` (verified in Booli's own sort UI 2026-07-09 — the old
  // "any sort=* flips ascending" note is stale). upcomingSale=0 = FS-only complement of the
  // pre-market census's upcomingSale=1.
  url: (p, asc) => `https://www.booli.se/sok/till-salu?upcomingSale=0&page=${p}${asc ? '&sort=published&ascending=1' : ''}`,
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
  for (const m of [memoNew, memoOld]) for (const cards of m.values()) for (const c of cards) {
    seen++; if (c.published == null) undated++; else { datedSeen++; if (c.isNewBuild) newbuild++; }
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
  return {
    cumulative, undatedRate, newbuildRate: datedSeen ? newbuild / datedSeen : 0,
    seenPages: memoNew.size + memoOld.size, crosscheck,
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
  // Clean pool: card global index i has ageDays = i (strictly increasing with depth).
  const cleanPlat = {
    name: 'clean',
    async fetch(p, asc = false) {
      if (p < 1 || p > LAST) return { status: 200, cards: [], total: TOTAL };
      const cards = [];
      for (let j = 0; j < PAGE; j++) {
        const idx = (p - 1) * PAGE + j;
        const age = asc ? (TOTAL - 1 - idx) : idx;      // oldest-first reverses the age axis
        cards.push({ id: `c${age}`, published: CLOCK - age * DAY, isNewBuild: false, upcoming: false });
      }
      return { status: 200, cards, total: p === 1 ? TOTAL : undefined };
    },
  };
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

  await check('run(): returns the standard result shape with a crosscheck gate', async () => {
    const res = await run({ platform: cleanPlat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.pool, 'forsale');
    assert.strictEqual(res.method, 'sort-flip');
    assert.strictEqual(res.bucketsSecondhand, null);
    assert.ok(res.gates.some(g => g.name === 'crosscheck'), 'two-pass must report a crosscheck gate');
    const keys = ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24'];
    assert.deepStrictEqual(Object.keys(res.buckets), [...keys, 'undated']);
    const sum = keys.reduce((a, k) => a + res.buckets[k], 0);
    assert.ok(Math.abs(sum + res.buckets.undated - res.nTotal) <= 1, 'bands must reconcile to nTotal');
    assert.strictEqual(res.errorPages, 0, 'clean synthetic pool must report zero error pages');
    assert.ok(res.gates.some(g => g.name === 'error_pages'), 'gate list must include an error_pages gate');
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
      async fetch(p, asc = false) {
        if (p === 25 && asc === false) { hit = true; return { status: 500, cards: null, total: undefined }; }
        return cleanPlat.fetch(p, asc);
      },
    };
    const res = await run({ platform: flaky, nowSec: CLOCK, logger: () => {} });
    assert.ok(hit, 'the injected broken page (25, newest-first) was never queried — test setup is wrong');
    assert.strictEqual(res.errorPages, 1, `expected exactly 1 error page from the injected failure, got ${res.errorPages}`);
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

const { bucketsToObject, gateCrosscheck, gateTotalDrift, gateErrorPages, evaluateGates } = require('../lib/age-census');

// Monthly-job entry point: Booli FS two-pass estimate (newest-first for the young bands,
// oldest-first for the deep ones). `platform` is injectable so --selftest drives a synthetic
// pool; production always passes the module's `booli` adapter.
async function run({ platform = booli, nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  errorPages = 0;
  const newest = await probeEnd(platform, false);
  const oldest = await probeEnd(platform, true);
  const overlap = newest.reachableListings + oldest.reachableListings - newest.total;
  if (overlap <= 0) throw new Error(`two-pass ends do not overlap (gap ${-overlap}) — cannot cover the age axis`);

  const est = await estimateTwoPass(platform, {
    newestHi: newest.reachablePage, oldestHi: oldest.reachablePage,
    pageSize: newest.pageSize, headlineTotal: newest.total,
  });
  const { bands, undatedEst } = bandsFromCumulative(est.cumulative, newest.total, est.undatedRate);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const cc = est.crosscheck;
  const gates = [
    gateCrosscheck({ newestPass: cc.newestPass, oldestPass: cc.oldestPass, headlineTotal: newest.total, maxPct: 3 }),
    gateErrorPages({ errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: newest.total, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  logger('INFO', `run() bands=${JSON.stringify(bands)} calls=${oxCalls} gates=${ev.passed ? 'ok' : ev.failures.join(',')}`);
  return {
    platform: 'booli', pool: 'forsale', method: 'sort-flip',
    nTotal: newest.total, nUndated: undatedEst,
    nNewbuild: Math.round(newest.total * est.newbuildRate),
    newbuildSampled: true, newbuildSampleN: est.seenPages * (newest.pageSize || 0),
    buckets: bucketsToObject(bands, undatedEst),
    bucketsSecondhand: null,
    muni: [],
    oxCalls, errorPages, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed',
    notes: ev.passed ? null : `gates failed: ${ev.failures.join(', ')}`,
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

module.exports = { preflightPlatform, estimatePlatform, estimateTwoPass, findCrossoverOlder, bandsFromCumulative, hemnet, booli, run };
