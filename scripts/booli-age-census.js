'use strict';
// scripts/booli-age-census.js — one-off Booli pre-market AGE-PENETRATION bake-off.
// Computes the age histogram of the national Booli pre-market pool (~33k) TWO ways —
// an exact full census (ground truth) and a cheap binary-search estimate (candidate) —
// then compares them so we can decide which method to use going forward.
//
//   node scripts/booli-age-census.js --probe   # 1 call: verify path live, print page-1 shape
//   SCRAPE_FORCE_OXYLABS=1 node scripts/booli-age-census.js   # full ~982-call bake-off
//
// Spec: docs/superpowers/specs/2026-07-07-booli-age-penetration-census-design.md
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseBooliSearchCards } = require('../lib/booli-fetch');
const { bandIndex, cardAgeDays, pageMedianAge, findCrossoverPage, DAY } = require('../lib/premarket-flow');

const NOW_SEC = Math.floor(Date.now() / 1000);
const EDGES = [30, 90, 180, 365, 548, 730];              // day cutoffs → 7 bands + undated
const LABELS = ['≤1mo', '1–3mo', '3–6mo', '6–12mo', '12–18mo', '18–24mo', '>24mo'];
const DEFAULT_PAGE_SIZE = 35;
const MAX_PAGES = 1200;                                   // safety cap (real depth ~955)
const PREFLIGHT_PAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 500, 800];
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

// `isNewConstruction=0` is the ONLY spelling Booli honours on this search — verified live by
// scripts/probe-booli-newconstruction-filter.js (2026-08-13): `newConstruction=1`,
// `isNewConstruction=true`, `isNewConstruction=false` and `newProduction=1` are all silently
// IGNORED and return the unfiltered pool, i.e. a wrong number that looks right. Do not "tidy"
// this spelling. Live totals that day: upcomingSale=1 → 31,602 all / 31,418 filtered / 185
// new-build (0.59%). The unfiltered URL is byte-identical to what it has always been.
const url = (p, filtered = false) =>
  `https://www.booli.se/sok/till-salu?upcomingSale=1${filtered ? '&isNewConstruction=0' : ''}&page=${p}`;

let stockTotal = null;            // headline total of the ALL-listings stream (page 1)
let filteredTotal = null;         // headline total of the isNewConstruction=0 stream (page 1)
let errorPages = 0;               // real page-fetch failures (null-cards, persistent non-200s); reset per run()

function apolloFrom(html) {
  const data = extractNextData(html);
  const apollo = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apollo) throw new Error('__APOLLO_STATE__ missing');
  return apollo;
}

// Low-level page fetch. Returns { status, cards } — cards is a normalized array on a real
// 200, or null on a persistent non-200 (so callers can tell an ERROR from a real empty page).
async function realFetchPage(p, filtered = false) {
  const res = await getWithRetry(url(p, filtered), { logger: () => {} });
  if (res.status !== 200) return { status: res.status, cards: null };
  const parsed = parseBooliSearchCards(apolloFrom(res.html));
  // Each stream carries its OWN headline total, and the pair of totals is what makes the
  // new-build count exact (all − filtered) instead of a sampled rate.
  if (p === 1 && parsed.totalCount != null) {
    if (filtered) filteredTotal = parsed.totalCount; else stockTotal = parsed.totalCount;
  }
  const cards = parsed.cards.map(c => ({ booli_id: c.booli_id, published: c.published, isNewBuild: c.isNewConstruction }));
  return { status: 200, cards };
}

// Swappable so --selftest can drive the whole pipeline against a synthetic in-memory pool.
let pageFetcher = realFetchPage;
const fetchPageResult = (p, filtered = false) => pageFetcher(p, filtered);

function pctOfPool(n) { return stockTotal ? (100 * n / stockTotal) : 0; }
function round(x) { return Math.round(x); }

// ---- --probe: 1-call live sanity check before committing to the full run ----
async function probe() {
  const r = await fetchPageResult(1);
  if (r.cards == null) { console.error(`PROBE FAIL: page 1 status ${r.status}`); process.exit(1); }
  const ages = r.cards.filter(c => c.published != null).map(c => cardAgeDays(c.published, NOW_SEC).toFixed(1));
  console.log(`PROBE ok: stockTotal=${stockTotal} page1 cards=${r.cards.length} ` +
    `undated=${r.cards.filter(c => c.published == null).length} ` +
    `newbuild=${r.cards.filter(c => c.isNewBuild).length}`);
  console.log(`  page1 ages(d): ${ages.slice(0, 10).join(', ')}`);
  console.log(`  expected pages ≈ ${stockTotal ? Math.ceil(stockTotal / r.cards.length) : '?'} @ ${r.cards.length}/page`);
  console.log(`Oxylabs: ${JSON.stringify(getOxylabsStats())}`);
}

// ---- Stage 1: pre-flight calibration (page-size stability + duplicate rate) ----
async function preflight(memo) {
  console.log('\n===== PRE-FLIGHT CALIBRATION =====');
  const sizes = [];
  const idCounts = new Map();
  let sampledCards = 0, sampledUndated = 0;
  for (const p of PREFLIGHT_PAGES) {
    const r = await fetchPageResult(p);
    if (r.cards == null) { errorPages++; log('WARN', `preflight page ${p} status ${r.status} — skipped`); continue; }
    memo.set(p, r.cards);                       // reused by binary-search
    sizes.push(r.cards.length);
    sampledCards += r.cards.length;
    for (const c of r.cards) {
      if (c.published == null) sampledUndated++;
      if (c.booli_id != null) idCounts.set(c.booli_id, (idCounts.get(c.booli_id) || 0) + 1);
    }
    log('INFO', `page ${p}: ${r.cards.length} cards`);
  }
  const nonEmpty = sizes.filter(v => v > 0);              // an empty deep sample isn't a page-size sample
  const min = Math.min(...nonEmpty), max = Math.max(...nonEmpty);
  const modal = nonEmpty.slice().sort((a, b) =>
    nonEmpty.filter(v => v === a).length - nonEmpty.filter(v => v === b).length).pop();
  const dupIds = [...idCounts.values()].filter(v => v > 1).length;
  const pageSize = modal || DEFAULT_PAGE_SIZE;
  if (min !== max) log('WARN', `page size NOT constant across preflight: min=${min} max=${max} modal=${modal}`);
  console.log(`  page-size: min=${min} max=${max} modal=${modal} → using ${pageSize}`);
  console.log(`  cross-page duplicate booli_ids: ${dupIds} (of ${idCounts.size} distinct)`);
  return { pageSize, min, max, modal, dupIds, sampledCards, sampledUndated };
}

// ---- Stage 2: binary-search estimate (the candidate) ----
// `filtered` selects which stream to bisect (all listings vs isNewConstruction=0); `poolTotal`
// is that stream's own headline total (defaults to the all-listings stockTotal so the bake-off
// call site is unchanged). Each stream must be given its OWN memo — the two streams re-paginate
// independently, so page 12 of one is not page 12 of the other.
async function binarySearch(memo, pageSize, lastPage, { filtered = false, poolTotal = null } = {}) {
  console.log(`\n===== BINARY-SEARCH ESTIMATE${filtered ? ' (2ND-HAND: isNewConstruction=0)' : ''} =====`);
  const total = poolTotal != null ? poolTotal : stockTotal;
  const cumulative = {};
  const fetchPage = async (p) => {
    if (memo.has(p)) return memo.get(p);
    const r = await fetchPageResult(p, filtered);
    const cards = r.cards || [];
    if (r.cards == null) { errorPages++; log('WARN', `probe page ${p}${filtered ? ' (2nd-hand)' : ''} status ${r.status} → treated empty`); }
    memo.set(p, cards);
    return cards;
  };
  for (const C of EDGES) {
    const r = await findCrossoverPage({ fetchPage, cutoffDays: C, nowSec: NOW_SEC, lo: 1, hi: lastPage, pageSize, memo, logger: log });
    cumulative[C] = r.cumulativeYounger;
  }
  // Undated rate from every page we've actually seen (preflight + probes) → standalone est.
  let seenCards = 0, seenUndated = 0;
  for (const cards of memo.values()) for (const c of cards) { seenCards++; if (c.published == null) seenUndated++; }
  const undatedRate = seenCards ? seenUndated / seenCards : 0;
  const undatedEst = round(total * undatedRate);
  // Buckets = successive differences; >24mo = undated-free residual.
  const datedBase = total - undatedEst;
  const buckets = [
    cumulative[30],
    cumulative[90] - cumulative[30],
    cumulative[180] - cumulative[90],
    cumulative[365] - cumulative[180],
    cumulative[548] - cumulative[365],
    cumulative[730] - cumulative[548],
    datedBase - cumulative[730],
  ];
  console.log(`  cumulative: ${EDGES.map(C => `${C}d=${cumulative[C]}`).join(' ')}`);
  console.log(`  undatedRate=${(undatedRate * 100).toFixed(2)}% → undated_est=${undatedEst}`);
  return { buckets, cumulative, undatedEst, undatedRate };
}

const { bucketsToObject, gateTotalDrift, gateErrorPages, evaluateGates } = require('../lib/age-census');

// Estimate-only path used by the monthly job: preflight + binary-search, NO full census —
// run TWICE, once over all listings and once over the isNewConstruction=0 stream, so the
// second-hand histogram is measured rather than left null. ~110 calls vs the bake-off's
// ~1,023. The census stage stays available via the default CLI for method revalidation; it is
// never on the monthly path (and it, like --probe, still walks the unfiltered stream only).
// NOTE: run() deliberately takes NO nowSec. It used to accept one, but it was never plumbed
// into preflight/binarySearch (both read the module-level NOW_SEC directly), so the parameter
// silently did nothing while the selftest passed a value and believed it had taken effect.
// A dead knob that looks live is worse than no knob; the module-level NOW_SEC is the single
// clock for the whole run, which is also what makes the two stages comparable.
async function run({ logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  errorPages = 0;
  // Per-run state, reset together. stockTotal is module-level and is re-derived from page 1 by
  // realFetchPage; without this reset a second in-process run() whose page 1 failed would
  // silently inherit the PREVIOUS run's pool total and report it as this run's n_total.
  stockTotal = null;
  filteredTotal = null;
  const memo = new Map();
  const pf = await preflight(memo);
  const lastPage = stockTotal ? Math.ceil(stockTotal / pf.pageSize) : MAX_PAGES;
  const bs = await binarySearch(memo, pf.pageSize, lastPage);
  const bands = bs.buckets.map(v => Math.max(0, Math.round(v)));

  // ---- Second pass: the SAME bisection against the new-build-excluded stream. ----
  // Page 1 first, on its own, because that is where the filtered headline total lives — and
  // that total is both the denominator of this pass and (subtracted from the unfiltered one)
  // the EXACT new-build count. Without it there is no second basis, so the pass is skipped
  // and the pool degrades to the old all-listings-only row rather than reporting a guess.
  const memoFiltered = new Map();
  const p1f = await fetchPageResult(1, true);
  if (p1f.cards == null) { errorPages++; log('WARN', `2nd-hand page 1 status ${p1f.status} → treated empty`); }
  memoFiltered.set(1, p1f.cards || []);

  let bucketsSecondhand = null, nNewbuild = null, secondhandNote = null;
  if (filteredTotal == null) {
    secondhandNote = 'second-hand pass skipped: the isNewConstruction=0 stream returned no headline total on page 1';
    log('WARN', secondhandNote);
  } else if (filteredTotal > stockTotal) {
    // A filtered pool LARGER than the unfiltered one means the filter was not applied (Booli
    // silently ignores params it does not recognise) or the two page-1 fetches straddled a
    // pool change. Either way the "exclusion" is not one — refuse to publish it as second-hand.
    secondhandNote = `second-hand pass rejected: filtered total ${filteredTotal} exceeds unfiltered ${stockTotal} — the isNewConstruction=0 filter did not apply`;
    log('WARN', secondhandNote);
  } else {
    // max(1, …) so a degenerate all-new-build pool (filteredTotal 0) bisects the single empty
    // page and yields all-zero bands, rather than falling back to a 1,200-page safety cap.
    const lastPageFiltered = Math.max(1, Math.ceil(filteredTotal / pf.pageSize));
    const bsf = await binarySearch(memoFiltered, pf.pageSize, lastPageFiltered, { filtered: true, poolTotal: filteredTotal });
    const bandsFiltered = bsf.buckets.map(v => Math.max(0, Math.round(v)));
    bucketsSecondhand = bucketsToObject(bandsFiltered, bsf.undatedEst);
    nNewbuild = stockTotal - filteredTotal;      // EXACT: two headline totals, not a sample
    logger('INFO', `run() 2nd-hand bands=${JSON.stringify(bandsFiltered)} filteredTotal=${filteredTotal} newbuild=${nNewbuild}`);
  }

  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;   // covers BOTH passes
  const gates = [
    gateErrorPages({ errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: stockTotal, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  const notes = [];
  if (!ev.passed) notes.push(`gates failed: ${ev.failures.join(', ')}`);
  if (secondhandNote) notes.push(secondhandNote);
  logger('INFO', `run() bands=${JSON.stringify(bands)} undated=${bs.undatedEst} calls=${oxCalls} gates=${ev.passed ? 'ok' : ev.failures.join(',')}`);
  return {
    platform: 'booli', pool: 'premarket', method: 'binary-search',
    nTotal: stockTotal, nUndated: bs.undatedEst,
    nNewbuild,
    newbuildSampled: false, newbuildSampleN: null,
    buckets: bucketsToObject(bands, bs.undatedEst),
    bucketsSecondhand,
    muni: [],
    oxCalls, errorPages, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed',
    notes: notes.length ? notes.join('; ') : null,
  };
}

// ---- Stage 3: full census (ground truth) ----
async function census(pageSize) {
  console.log('\n===== FULL CENSUS =====');
  const buckets = new Array(EDGES.length + 1).fill(0);
  const newbuild = new Array(EDGES.length + 1).fill(0);
  const seen = new Set();
  let undated = 0, distinct = 0, rawCards = 0, pagesWithCards = 0, errorPages = 0, pagesWalked = 0;
  const expectedLast = stockTotal ? Math.ceil(stockTotal / pageSize) : MAX_PAGES;
  const walkTo = Math.min(expectedLast + 10, MAX_PAGES);
  for (let p = 1; p <= walkTo; p++) {
    const r = await fetchPageResult(p);                     // fresh fetch (independent of memo)
    pagesWalked = p;
    if (r.cards == null) { errorPages++; log('WARN', `census page ${p} status ${r.status} — coverage gap, continuing`); continue; }
    if (r.cards.length === 0) { log('INFO', `census reached empty page ${p} — stop`); break; }
    rawCards += r.cards.length; pagesWithCards++;
    for (const c of r.cards) {
      if (c.booli_id != null) { if (seen.has(c.booli_id)) continue; seen.add(c.booli_id); }
      distinct++;
      if (c.published == null) { undated++; continue; }
      const k = bandIndex(cardAgeDays(c.published, NOW_SEC), EDGES);
      buckets[k]++; if (c.isNewBuild) newbuild[k]++;
    }
    if (p % 100 === 0) log('INFO', `…page ${p}, distinct=${distinct}`);
    if (p === walkTo) log('WARN', `census hit walk cap ${walkTo} before an empty page — pool may exceed estimate`);
  }
  const meanCardsPerPage = pagesWithCards ? rawCards / pagesWithCards : 0;
  console.log(`  pages=${pagesWalked} errorPages=${errorPages} distinct=${distinct} undated=${undated} mean/page=${meanCardsPerPage.toFixed(2)}`);
  console.log(`  stock_total - distinct = ${stockTotal - distinct} (drift/coverage)`);
  return { buckets, newbuild, undated, distinct, pagesWalked, errorPages, meanCardsPerPage, datedTotal: buckets.reduce((a, b) => a + b, 0) };
}

// ---- Comparison + PASS/FAIL ----
function compare(censusRes, bs) {
  const absTol = 0.01 * stockTotal;                     // 1 percentage-point of pool
  const rows = [];
  let allPass = true;
  for (let k = 0; k < LABELS.length; k++) {
    const c = censusRes.buckets[k];
    const b = bs.buckets[k];
    const abs = b - c;
    const share = c / stockTotal;
    const rel = c > 0 ? abs / c : null;
    const relApplies = share >= 0.01;
    const pass = Math.abs(abs) <= absTol && (!relApplies || Math.abs(rel) <= 0.10);
    if (!pass) allPass = false;
    rows.push({ label: LABELS[k], census: c, binary: b, abs, rel, sharePct: 100 * share, pass });
  }
  return { rows, allPass, absTol };
}

function fmtPct(x) { return (x == null ? 'n/a' : (x * 100).toFixed(1) + '%'); }

function buildMd(dateStr, pf, bs, censusRes, cmp, oxTotal, timings) {
  const L = [];
  L.push(`# Booli pre-market age penetration — census vs binary-search — ${dateStr}`, '');
  L.push(`National pre-market pool (\`upcomingSale=1\`). Age = days since Booli publish date. ` +
    `Stock total (headline): **${stockTotal.toLocaleString()}**.`, '');
  L.push(`## Census histogram (ground truth)`, '');
  L.push(`| Bucket | Count | % of pool | Cumulative % | of which new-build |`);
  L.push(`|---|--:|--:|--:|--:|`);
  let cum = 0;
  for (let k = 0; k < LABELS.length; k++) {
    cum += censusRes.buckets[k];
    L.push(`| ${LABELS[k]} | ${censusRes.buckets[k].toLocaleString()} | ${pctOfPool(censusRes.buckets[k]).toFixed(1)}% | ${pctOfPool(cum).toFixed(1)}% | ${censusRes.newbuild[k]} |`);
  }
  L.push(`| _undated_ | ${censusRes.undated.toLocaleString()} | ${pctOfPool(censusRes.undated).toFixed(1)}% | — | — |`);
  L.push(`| **dated total** | **${censusRes.datedTotal.toLocaleString()}** | | | ${censusRes.newbuild.reduce((a, b) => a + b, 0)} new-build |`, '');
  L.push(`## Bake-off: binary-search vs census`, '');
  L.push(`| Bucket | Census | Binary-search | Abs err | Rel err | Pool share | Verdict |`);
  L.push(`|---|--:|--:|--:|--:|--:|:--:|`);
  for (const r of cmp.rows) {
    L.push(`| ${r.label} | ${r.census.toLocaleString()} | ${r.binary.toLocaleString()} | ${r.abs >= 0 ? '+' : ''}${r.abs} | ${r.rel == null ? 'n/a' : (r.rel * 100).toFixed(1) + '%'} | ${r.sharePct.toFixed(1)}% | ${r.pass ? '✅' : '❌'} |`);
  }
  L.push(`| _undated_ | ${censusRes.undated} | ${bs.undatedEst} (est) | ${bs.undatedEst - censusRes.undated} | — | — | (excluded) |`, '');
  L.push(`**Acceptance:** every age bucket within ±1pp of pool (±${Math.round(cmp.absTol)}) AND ≤10% rel on ≥1%-share buckets.`);
  L.push('', `## VERDICT: ${cmp.allPass ? '✅ PASS — binary-search reproduces the census within tolerance' : '❌ FAIL — binary-search misses tolerance in ≥1 bucket'}`, '');
  if (cmp.allPass) {
    L.push(`**Recommendation:** adopt binary-search going forward — ~${Math.round(oxTotal.census / Math.max(1, oxTotal.binary + oxTotal.preflight))}× cheaper (${oxTotal.binary + oxTotal.preflight} vs ${oxTotal.census} calls) at bucket accuracy within tolerance.`);
  } else {
    const worst = cmp.rows.filter(r => !r.pass).map(r => `${r.label} (${r.abs >= 0 ? '+' : ''}${r.abs})`).join(', ');
    L.push(`**Recommendation:** keep the census — binary-search misses in: ${worst}.`);
  }
  L.push('', `## Coverage & quality`, '');
  L.push(`- Census: ${censusRes.pagesWalked} pages walked, ${censusRes.errorPages} error/gap pages, ${censusRes.distinct.toLocaleString()} distinct ids, drift \`stock−distinct\`=${stockTotal - censusRes.distinct}.`);
  L.push(`- Page size: preflight min/max/modal ${pf.min}/${pf.max}/${pf.modal}; census mean ${censusRes.meanCardsPerPage.toFixed(2)}/page; cross-page dup ids ${pf.dupIds}.`);
  L.push(`- Undated: census exact ${censusRes.undated}; binary-search rate ${(bs.undatedRate * 100).toFixed(2)}% → est ${bs.undatedEst}.`);
  L.push(`- Oxylabs calls: preflight ${oxTotal.preflight} + binary ${oxTotal.binary} + census ${oxTotal.census} = **${oxTotal.total}**.`);
  L.push(`- Timings: preflight ${timings.preflight}s, binary ${timings.binary}s, census ${timings.census}s.`);
  L.push('', `_Both methods share one clock (NOW). Binary-search ran first, census immediately after; pool drift over the run ≈ ${stockTotal - censusRes.distinct} listings. New-builds ~0.6% of pool. Booli national via validated \`upcomingSale=1\`._`);
  return L.join('\n');
}

// Offline end-to-end integration test — drives preflight+binary+census+compare+buildMd
// against a synthetic in-memory pool (no network). Verifies the census reproduces the
// known truth exactly, binary-search lands within tolerance, and the report renders.
async function selftest() {
  const assert = require('assert');
  const PAGE = 35, N = 3000;                 // synthetic pool of 3000 listings, 35/page
  const CLOCK = NOW_SEC;
  // card i: age = i*1.3 days (ascending, globally sorted); every 200th undated; ~1% new-build.
  const ageOf = (i) => i * 1.3;
  const pub = (i) => (i % 200 === 0) ? null : CLOCK - Math.round(ageOf(i) * DAY);
  // Two streams over ONE pool, exactly as the site serves them: the all-listings stream and
  // the isNewConstruction=0 stream, which is the same list with the new-builds dropped and the
  // remainder RE-PAGINATED (so page p of one is not page p of the other) and its own headline
  // total. Age order is preserved by the filter, which is what lets the same bisection run.
  const ALL = [];
  for (let i = 0; i < N; i++) ALL.push({ booli_id: String(i), published: pub(i), isNewBuild: i % 97 === 0 });
  const FILTERED = ALL.filter(c => !c.isNewBuild);
  const cleanFetch = async (p, filtered = false) => {
    // Mirror realFetchPage: page 1 is where each stream's headline total comes from. run()
    // resets both per run, so the synthetic fetcher has to supply them the same way.
    const src = filtered ? FILTERED : ALL;
    if (p === 1) { if (filtered) filteredTotal = src.length; else stockTotal = src.length; }
    const start = (p - 1) * PAGE;
    if (start >= src.length) return { status: 200, cards: [] };
    return { status: 200, cards: src.slice(start, start + PAGE) };
  };
  pageFetcher = cleanFetch;
  stockTotal = N;
  // Ground truth computed directly.
  const truth = new Array(EDGES.length + 1).fill(0); let truthUndated = 0;
  for (let i = 0; i < N; i++) {
    const pv = pub(i);
    if (pv == null) { truthUndated++; continue; }
    truth[bandIndex(cardAgeDays(pv, CLOCK), EDGES)]++;
  }
  const memo = new Map();
  const pf = await preflight(memo);
  const bs = await binarySearch(memo, pf.pageSize, Math.ceil(N / pf.pageSize));
  const censusRes = await census(pf.pageSize);
  const cmp = compare(censusRes, bs);
  // Census must equal truth exactly.
  for (let k = 0; k < truth.length; k++) assert.strictEqual(censusRes.buckets[k], truth[k], `census bucket ${k}: ${censusRes.buckets[k]} != truth ${truth[k]}`);
  assert.strictEqual(censusRes.undated, truthUndated, 'census undated mismatch');
  assert.strictEqual(censusRes.distinct, N, 'census distinct mismatch');
  // Binary-search buckets should all be within the ±1pp tolerance on this clean pool.
  assert.ok(cmp.allPass, 'binary-search unexpectedly FAILED on clean synthetic pool: ' + JSON.stringify(cmp.rows.filter(r => !r.pass)));
  // Report must render without throwing.
  const md = buildMd('SELFTEST', pf, bs, censusRes, cmp, { preflight: 12, binary: 15, census: 90, total: 117 }, { preflight: 1, binary: 1, census: 2 });
  assert.ok(md.includes('VERDICT'), 'md missing verdict');
  console.log(`\nSELFTEST PASS — census==truth (${N} listings), binary-search within tolerance, report renders.`);

  // --- run() estimate-only contract (monthly job path) ---
  // A deliberately stale pool total: run() must reset it and re-derive from page 1, so a second
  // in-process call can never report the previous run's total as its own.
  stockTotal = 999999; filteredTotal = 888888;
  const res = await run({ logger: () => {} });
  assert.strictEqual(res.nTotal, N, `run() must reset stockTotal and re-derive it from page 1, got ${res.nTotal}`);
  assert.strictEqual(res.platform, 'booli');
  assert.strictEqual(res.pool, 'premarket');
  assert.strictEqual(res.method, 'binary-search');
  const BAND_KEYS = ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24'];
  assert.deepStrictEqual(Object.keys(res.buckets), [...BAND_KEYS, 'undated']);
  const bandSum = BAND_KEYS.reduce((a, k) => a + res.buckets[k], 0);
  assert.ok(Math.abs(bandSum + res.buckets.undated - res.nTotal) <= 1, `bands+undated ${bandSum + res.buckets.undated} must reconcile to nTotal ${res.nTotal}`);
  assert.ok(res.muni.length === 0, 'Booli is national-only — no muni rows');
  assert.strictEqual(res.errorPages, 0, 'clean synthetic pool must report zero error pages');
  assert.ok(res.gates.some(g => g.name === 'error_pages'), 'gate list must include an error_pages gate');
  console.log('SELFTEST PASS — run() estimate contract holds.');

  // --- 2nd-hand basis: the SAME bisection over the isNewConstruction=0 stream ---
  // The filtered pass must produce a real histogram (not null), it must be a SUBSET of the
  // all-listings one band by band (the filtered stream is the same pool minus some cards, so
  // no band can grow), and the new-build count must be the exact difference of the two
  // headline totals — never a sampled rate.
  assert.ok(res.bucketsSecondhand != null, 'the isNewConstruction=0 pass must yield a 2nd-hand histogram');
  assert.deepStrictEqual(Object.keys(res.bucketsSecondhand), [...BAND_KEYS, 'undated']);
  assert.strictEqual(res.newbuildSampled, false, 'the new-build count is now exact, not sampled');
  assert.strictEqual(res.newbuildSampleN, null, 'an exact count has no sample size');
  assert.strictEqual(res.nNewbuild, N - FILTERED.length,
    `nNewbuild must be allTotal − filteredTotal (${N} − ${FILTERED.length}), got ${res.nNewbuild}`);
  assert.strictEqual(filteredTotal, FILTERED.length, 'the filtered pass must read its own headline total from ITS page 1');
  for (const k of BAND_KEYS) {
    assert.ok(res.bucketsSecondhand[k] <= res.buckets[k],
      `2nd-hand band ${k} (${res.bucketsSecondhand[k]}) must not exceed the all-listings band (${res.buckets[k]})`);
  }
  const shSum = BAND_KEYS.reduce((a, k) => a + res.bucketsSecondhand[k], 0) + res.bucketsSecondhand.undated;
  assert.ok(Math.abs(shSum - FILTERED.length) <= 1,
    `2nd-hand bands+undated ${shSum} must reconcile to the FILTERED total ${FILTERED.length}, not the pool total`);
  assert.strictEqual(res.notes, null, `a clean two-pass run has nothing to note: ${res.notes}`);
  console.log(`SELFTEST PASS — 2nd-hand pass exact: nNewbuild=${res.nNewbuild}, 2nd-hand bands ⊆ all bands, reconciles to ${FILTERED.length}.`);

  // --- filteredTotal unavailable → degrade to the old all-listings row, never guess ---
  pageFetcher = async (p, filtered = false) => (filtered && p === 1)
    ? { status: 503, cards: null }
    : cleanFetch(p, filtered);
  const resNoSh = await run({ logger: () => {} });
  pageFetcher = cleanFetch;
  assert.strictEqual(resNoSh.bucketsSecondhand, null, 'no filtered total → no 2nd-hand claim');
  assert.strictEqual(resNoSh.nNewbuild, null, 'no filtered total → no new-build count, not a fabricated 0');
  assert.strictEqual(resNoSh.nTotal, N, 'the all-listings pass must still stand on its own');
  assert.ok(/second-hand pass skipped/.test(resNoSh.notes || ''), `the skip must be stated: ${resNoSh.notes}`);
  console.log('SELFTEST PASS — a missing filtered total degrades honestly.');

  // --- error_pages counter must actually count real fetch failures, not just default to 0 ---
  const cleanFetcher = pageFetcher;
  let brokenPageHit = false;
  pageFetcher = async (p, filtered = false) => {
    if (p === 2 && !filtered) { brokenPageHit = true; return { status: 500, cards: null }; }   // persistent non-200 → error page
    return cleanFetcher(p, filtered);
  };
  const resErr = await run({ logger: () => {} });
  pageFetcher = cleanFetcher;
  assert.ok(brokenPageHit, 'synthetic broken-page fetcher was never invoked for page 2 — test setup is wrong');
  assert.ok(resErr.errorPages >= 1, `injecting one non-200 page must raise errorPages above 0, got ${resErr.errorPages}`);
  // The selftest's synthetic pageFetcher bypasses lib/scrape-http entirely, so oxCalls (real
  // Oxylabs call count) is always 0 here — gateErrorPages short-circuits to a pass on `!oxCalls`
  // regardless of errorPages (see lib/age-census.js), so its *detail text* can't be asserted
  // against here. Prove the gate itself reacts correctly to a real errorPages/oxCalls pair by
  // calling it directly with the count run() just produced plus a plausible non-zero oxCalls.
  const directGate = gateErrorPages({ errorPages: resErr.errorPages, oxCalls: 60, maxPct: 2 });
  assert.strictEqual(directGate.passed, false, `1+ error page(s) out of 60 calls must fail the 2% gate: ${directGate.detail}`);
  console.log(`SELFTEST PASS — run() errorPages wired to real fetch failures (errorPages=${resErr.errorPages}).`);

  // --- errorPages must accumulate across BOTH passes, not just the first ---
  // The failure is injected ONLY on the filtered stream (filtered && p===43), so any count at
  // all proves the second pass's failures are being tallied. Page 43 is the first bisection
  // probe of the filtered stream (range [1,85] → mid 43) and nothing else touches it on that
  // stream; the unfiltered pass runs completely clean, so the expected total is exactly 1.
  let filteredPageHit = false;
  pageFetcher = async (p, filtered = false) => {
    if (filtered && p === 43) { filteredPageHit = true; return { status: 500, cards: null }; }
    return cleanFetcher(p, filtered);
  };
  const resErr2 = await run({ logger: () => {} });
  pageFetcher = cleanFetcher;
  assert.ok(filteredPageHit, 'the injected 2nd-hand-stream failure (page 43) was never queried — test setup is wrong');
  assert.strictEqual(resErr2.errorPages, 1,
    `a failure on the 2nd-hand pass alone must raise errorPages to exactly 1, got ${resErr2.errorPages} — the counter must span both passes`);
  console.log('SELFTEST PASS — errorPages accumulates across both passes.');
}

async function main() {
  if (process.argv.includes('--selftest')) { await selftest(); return; }
  if (process.argv.includes('--probe')) { resetOxylabsStats(); await probe(); return; }
  if (process.argv.includes('--estimate')) {
    if (process.env.SCRAPE_FORCE_OXYLABS !== '1') {
      console.error('Refusing to run un-proxied. Set SCRAPE_FORCE_OXYLABS=1.');
      process.exit(1);
    }
    console.log(JSON.stringify(await run({}), null, 2));
    return;
  }

  if (process.env.SCRAPE_FORCE_OXYLABS !== '1') {
    console.error('Refusing to run the full census un-proxied. Set SCRAPE_FORCE_OXYLABS=1 (or use --probe).');
    process.exit(1);
  }
  resetOxylabsStats();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const memo = new Map();
  const callsAt = () => { const s = getOxylabsStats(); return s.oxylabsCallCount + s.directSuccessCount; };
  const now = () => Math.floor(Date.now() / 1000);

  const t0 = now();
  const pf = await preflight(memo);
  const cPre = callsAt();
  const tPre = now();

  const lastPage = stockTotal ? Math.ceil(stockTotal / pf.pageSize) : MAX_PAGES;
  const bs = await binarySearch(memo, pf.pageSize, lastPage);
  const cBin = callsAt();
  const tBin = now();

  const censusRes = await census(pf.pageSize);
  const cCen = callsAt();
  const tCen = now();

  const cmp = compare(censusRes, bs);
  const oxTotal = { preflight: cPre, binary: cBin - cPre, census: cCen - cBin, total: cCen };
  const timings = { preflight: tPre - t0, binary: tBin - tPre, census: tCen - tBin };

  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const payload = {
    snapshot_date: dateStr, now_sec: NOW_SEC, stock_total: stockTotal, edges_days: EDGES, labels: LABELS,
    preflight: pf, binary_search: bs, census: censusRes, comparison: cmp,
    oxylabs_calls: oxTotal, timings_sec: timings,
  };
  // Write raw JSON FIRST so a formatting bug in buildMd can never destroy a ~982-call result.
  fs.writeFileSync(path.join(OUT_DIR, `booli-age-census-${dateStr}.json`), JSON.stringify(payload, null, 2));
  const md = buildMd(dateStr, pf, bs, censusRes, cmp, oxTotal, timings);
  fs.writeFileSync(path.join(OUT_DIR, `booli-age-census-${dateStr}.md`), md);

  console.log(`\n${md}`);
  console.log(`\nOxylabs total: ${JSON.stringify(getOxylabsStats())}`);
  console.log(`Artifact -> ${OUT_DIR}/booli-age-census-${dateStr}.{json,md}`);
}

module.exports = { run };
if (require.main === module) main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
