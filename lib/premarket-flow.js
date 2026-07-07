'use strict';
// lib/premarket-flow.js — Pure, network-free helpers for the pre-market flow &
// staleness measurement. walkFlow/sampleDepth take an injected async
// fetchPage(pageNum) returning NORMALIZED cards { published:<unix sec|null>, isNewBuild:<bool> }.
// The orchestrator (scripts/premarket-flow-measure.js) supplies platform fetchers.
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md

const DAY = 86400;
function noop() {}

function cardAgeDays(publishedSec, nowSec) {
  return (nowSec - publishedSec) / DAY;
}

// Count second-hand cards inside the window (pure).
function countWindowSecondhand(cards, { nowSec, windowDays }) {
  const cutoff = nowSec - windowDays * DAY;
  let addsSecondhand = 0, newbuildInWindow = 0, datedInWindow = 0;
  for (const c of cards) {
    if (c.published == null || c.published < cutoff) continue;
    datedInWindow++;
    if (c.isNewBuild) newbuildInWindow++;
    else addsSecondhand++;
  }
  return { addsSecondhand, newbuildInWindow, datedInWindow };
}

// True when every DATED card on the page is older than the cutoff (→ stop paging).
// An all-undated page is NOT terminal (returns false).
function pageEntirelyOld(cards, { nowSec, windowDays }) {
  const cutoff = nowSec - windowDays * DAY;
  const dated = cards.filter(c => c.published != null);
  if (dated.length === 0) return false;
  return dated.every(c => c.published < cutoff);
}

// Walk newest-first pages accumulating in-window second-hand counts.
//
// Fault tolerance (2026-07-20 incident): a single transient page fetch failure must NOT
// abort the whole walk. When fetchPage(p) rejects, the page is SKIPPED (counted in
// failedPages) and the walk continues — a one-page undercount with a recorded warning
// beats losing the entire weekly datapoint. Only when failedPages exceeds maxFailedPages
// (the feed is genuinely broken) does the walk abort by throwing, so a badly-undercounted
// number is never silently persisted. A skipped page is distinct from an EMPTY page:
// empty = end of pagination (stop cleanly); failure = error (skip + count, keep going).
async function walkFlow({ fetchPage, nowSec, windowDays, maxPages, maxFailedPages = 5, logger = noop }) {
  let addsSecondhand = 0, newbuildInWindow = 0, datedInWindow = 0, pagesWalked = 0, failedPages = 0;
  const cardsAll = [];
  for (let p = 1; p <= maxPages; p++) {
    pagesWalked = p;
    let cards;
    try {
      cards = await fetchPage(p);
    } catch (err) {
      failedPages++;
      logger('WARN', `walkFlow page ${p} failed (${failedPages}/${maxFailedPages} tolerated): ${err && err.message}`);
      if (failedPages > maxFailedPages) {
        throw new Error(`walkFlow aborted: ${failedPages} page failures exceed maxFailedPages=${maxFailedPages} (last: ${err && err.message})`);
      }
      continue; // skip this page, keep walking — do NOT treat as end-of-pages
    }
    if (!cards || cards.length === 0) break;
    cardsAll.push(...cards);
    const c = countWindowSecondhand(cards, { nowSec, windowDays });
    addsSecondhand += c.addsSecondhand;
    newbuildInWindow += c.newbuildInWindow;
    datedInWindow += c.datedInWindow;
    if (pageEntirelyOld(cards, { nowSec, windowDays })) break;
    if (p === maxPages) {
      logger('WARN', `walkFlow hit maxPages=${maxPages} before window boundary — flow may be truncated (undercount)`);
    }
  }
  return { addsSecondhand, newbuildInWindow, datedInWindow, pagesWalked, failedPages, cards: cardsAll };
}

// Sample specific pages spread across pool depth to estimate composition.
async function sampleDepth({ fetchPage, pageNumbers, nowSec, logger = noop }) {
  const out = [];
  for (const page of pageNumbers) {
    let cards;
    try {
      cards = await fetchPage(page);
    } catch (err) {
      // Depth sampling is a non-critical composition estimate — a failed sample page is
      // skipped, never fatal (unlike the flow walk, which gates on maxFailedPages).
      logger('WARN', `sampleDepth page ${page} failed, skipping: ${err && err.message}`);
      continue;
    }
    if (!cards || cards.length === 0) { logger('WARN', `sampleDepth page ${page} empty`); continue; }
    const dated = cards.filter(c => c.published != null);
    const nb = cards.filter(c => c.isNewBuild).length;
    let medianAgeDays = null;
    if (dated.length) {
      const ages = dated.map(c => cardAgeDays(c.published, nowSec)).sort((a, b) => a - b);
      medianAgeDays = ages[Math.floor(ages.length / 2)];
    }
    out.push({ page, n: cards.length, newbuildPct: cards.length ? nb / cards.length : 0, medianAgeDays });
  }
  return out;
}

// Card-count-weighted mean new-build fraction across the depth sample.
function poolNewbuildShare(depthSample) {
  let num = 0, den = 0;
  for (const s of depthSample) { num += s.newbuildPct * s.n; den += s.n; }
  return den > 0 ? num / den : 0;
}

// ---------------------------------------------------------------------------
// Age-penetration helpers (Booli census vs binary-search bake-off).
// Spec: docs/superpowers/specs/2026-07-07-booli-age-penetration-census-design.md
// Cards here are normalized to { published:<unix sec|null>, isNewBuild:<bool> }.
// ---------------------------------------------------------------------------

// Which age band a card falls in, given ASCENDING day cutoffs `edges`.
// Half-open on the young side: band k = [edges[k-1], edges[k]); band 0 = [0, edges[0]);
// final band = [edges[last], +inf). Returns an index in [0, edges.length].
function bandIndex(ageDays, edges) {
  for (let k = 0; k < edges.length; k++) {
    if (ageDays < edges[k]) return k;
  }
  return edges.length;
}

// Tally a card array into age bands (pure). Undated cards (published == null) are
// counted separately, never forced into a band. `newbuild[k]` counts new-builds in band k.
function bucketByAge(cards, { nowSec, edges }) {
  const nBands = edges.length + 1;
  const buckets = new Array(nBands).fill(0);
  const newbuild = new Array(nBands).fill(0);
  let undated = 0;
  for (const c of cards) {
    if (c.published == null) { undated++; continue; }
    const k = bandIndex(cardAgeDays(c.published, nowSec), edges);
    buckets[k]++;
    if (c.isNewBuild) newbuild[k]++;
  }
  return { buckets, newbuild, undated };
}

// Median age (days) of the DATED cards on a page; null if none dated (pure).
function pageMedianAge(cards, nowSec) {
  const ages = cards.filter(c => c.published != null).map(c => cardAgeDays(c.published, nowSec)).sort((a, b) => a - b);
  if (ages.length === 0) return null;
  return ages[Math.floor(ages.length / 2)];
}

// Count cards STRICTLY younger than a cutoff timestamp, i.e. published > cutoffSec
// (⟺ ageDays < cutoffDays). Strict to match bucketByAge's half-open bands (age < edge),
// so cumulative-younger-than-edge equals the sum of the bands below it (pure).
function countYoungerThan(cards, cutoffSec) {
  let n = 0;
  for (const c of cards) if (c.published != null && c.published > cutoffSec) n++;
  return n;
}

// Binary-search the first page whose MEDIAN age >= cutoffDays (the "crossover" page) on a
// newest-first (age-ascending-with-depth) pool, then refine within that page to estimate
// the cumulative count of listings younger than the cutoff. `fetchPage(p)` returns a
// normalized card array; `memo` (a Map) is shared so probes are never re-fetched (and are
// reused across all cutoffs). Undated probe pages are treated as "not yet older" (search
// deeper) so a sparse undated page can't prematurely stop the search.
async function findCrossoverPage({ fetchPage, cutoffDays, nowSec, lo, hi, pageSize, memo = new Map(), logger = noop }) {
  const cutoffSec = nowSec - cutoffDays * DAY;
  async function getPage(p) {
    if (memo.has(p)) return memo.get(p);
    const c = await fetchPage(p);
    memo.set(p, c);
    return c;
  }
  let a = lo, b = hi;
  while (a < b) {
    const mid = a + Math.floor((b - a) / 2);
    const cards = await getPage(mid);
    const m = pageMedianAge(cards, nowSec);
    if (m == null || m < cutoffDays) a = mid + 1; // crossover is deeper
    else b = mid;                                  // crossover is here-or-shallower
  }
  // The median-crossover page (first page whose MEDIAN age >= cutoff) can sit one page
  // deeper than the page that actually STRADDLES the age=C transition (the boundary can
  // fall in the older half of the preceding page). Refine to the true straddle page by
  // checking the shallower neighbour: if it still holds some younger-than-C cards it
  // contains the transition, so it — not the median page — is where we count. This halves
  // the estimator's inherent ~pageSize bias (exact on a cleanly-sorted pool).
  let straddlePage = a;
  if (straddlePage > lo) {
    const prev = await getPage(straddlePage - 1);
    if (countYoungerThan(prev, cutoffSec) < prev.length) straddlePage -= 1; // prev has some older → boundary is in prev
  }
  const straddleCards = await getPage(straddlePage);
  const youngerOnStraddle = countYoungerThan(straddleCards, cutoffSec);
  const cumulativeYounger = (straddlePage - 1) * pageSize + youngerOnStraddle;
  logger('INFO', `cutoff ${cutoffDays}d -> straddle page ${straddlePage}, cumulativeYounger≈${cumulativeYounger}`);
  return { crossoverPage: a, straddlePage, youngerOnStraddle, cumulativeYounger };
}

// Combine raw counts + depth sample into the stored row fields (pure).
function computeMetrics({ stockTotal, addsSecondhand, newbuildInWindow, datedInWindow, depthSample, windowDays }) {
  const flowPerDay = addsSecondhand / windowDays;
  const newbuildShareWindow = datedInWindow > 0 ? newbuildInWindow / datedInWindow : 0;
  const newbuildSharePool = poolNewbuildShare(depthSample);
  const stockSecondhandEst = Math.round(stockTotal * (1 - newbuildSharePool));
  const meanDwellDays = flowPerDay > 0 ? stockSecondhandEst / flowPerDay : null;
  return {
    stock_total: stockTotal,
    stock_secondhand_est: stockSecondhandEst,
    adds_window_secondhand: addsSecondhand,
    flow_per_day: Number(flowPerDay.toFixed(2)),
    newbuild_share_window: Number(newbuildShareWindow.toFixed(4)),
    newbuild_share_pool_est: Number(newbuildSharePool.toFixed(4)),
    mean_dwell_days: meanDwellDays == null ? null : Number(meanDwellDays.toFixed(1)),
  };
}

// ---------------------------------------------------------------------------
// Fault-tolerance helpers for the measure orchestrator (2026-07-20 incident).
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a single page fetch across transient failures with escalating backoff. This sits
// ABOVE the transport's own retry (lib/scrape-http.js does 2 attempts + one 3s backoff);
// the extra, longer waits here ride out a transient Oxylabs 613 that the transport's short
// retry misses — which is exactly what lost the 2026-07-20 datapoint. `attempts` is the
// total tries; `backoffMs[i]` is the wait BEFORE retry i+1 (last value reused if short).
// Rethrows the final error when all attempts fail, so walkFlow's skip-tolerance can count
// the page rather than the whole run dying. `sleep` is injectable for tests.
async function retryFetch(fn, { attempts = 3, backoffMs = [5000, 15000], sleep = defaultSleep, logger = noop } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const wait = backoffMs[Math.min(i - 1, backoffMs.length - 1)];
        logger('WARN', `retryFetch attempt ${i}/${attempts} failed (${err && err.message}); backing off ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// Decide the cron-wrapper alert level for a completed run (pure). Returns a warning STRING
// when the run was degraded-but-usable (a platform failed entirely so only a partial row was
// persisted, OR some pages were skipped mid-walk), else null for a clean run. Total failure
// (no platform persisted) is signalled by the orchestrator THROWING, which cron-wrapper turns
// into a [FAILURE] alert — validate only covers the survivable-degradation cases → [WARNING].
function validatePremarketRun({ persisted = [], failed = [], failedPages = {} } = {}) {
  const parts = [];
  if (failed.length > 0) {
    parts.push(`${failed.join(', ')} failed — persisted partial (${persisted.join(', ') || 'none'})`);
  }
  const skipped = Object.entries(failedPages).filter(([, n]) => n > 0);
  if (skipped.length > 0) {
    parts.push(`pages skipped: ${skipped.map(([p, n]) => `${p}=${n}`).join(', ')}`);
  }
  return parts.length ? parts.join('; ') : null;
}

module.exports = {
  DAY, cardAgeDays, countWindowSecondhand, pageEntirelyOld,
  walkFlow, sampleDepth, poolNewbuildShare, computeMetrics,
  retryFetch, validatePremarketRun,
  bandIndex, bucketByAge, pageMedianAge, countYoungerThan, findCrossoverPage,
};

// ---------------------------------------------------------------------------
// --smoke self-test (pure; no network). Run: node lib/premarket-flow.js --smoke
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  async function check(name, fn) {
    try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  const NOW = 10 * DAY; // fixed clock: "now" = day 10
  const W = 7;

  (async () => {
    await check('countWindowSecondhand: counts 2nd-hand in window, splits new-build, excludes old', () => {
      const cards = [
        { published: NOW - 1 * DAY, isNewBuild: false }, // in window, 2nd-hand
        { published: NOW - 2 * DAY, isNewBuild: true },  // in window, new-build
        { published: NOW - 9 * DAY, isNewBuild: false }, // older than 7d — excluded
        { published: null,          isNewBuild: false }, // undated — excluded
      ];
      const r = countWindowSecondhand(cards, { nowSec: NOW, windowDays: W });
      assert.strictEqual(r.addsSecondhand, 1);
      assert.strictEqual(r.newbuildInWindow, 1);
      assert.strictEqual(r.datedInWindow, 2);
    });

    await check('pageEntirelyOld: true when all dated cards past cutoff; false otherwise', () => {
      const oldPage = [{ published: NOW - 8 * DAY, isNewBuild: false }, { published: NOW - 20 * DAY, isNewBuild: false }];
      const mixedPage = [{ published: NOW - 1 * DAY, isNewBuild: false }, { published: NOW - 8 * DAY, isNewBuild: false }];
      assert.strictEqual(pageEntirelyOld(oldPage, { nowSec: NOW, windowDays: W }), true);
      assert.strictEqual(pageEntirelyOld(mixedPage, { nowSec: NOW, windowDays: W }), false);
    });

    await check('walkFlow: stops at the first entirely-old page and sums per-listing', async () => {
      const pages = {
        1: [{ published: NOW - 1 * DAY, isNewBuild: false }, { published: NOW - 2 * DAY, isNewBuild: true }],
        2: [{ published: NOW - 6 * DAY, isNewBuild: false }, { published: NOW - 8 * DAY, isNewBuild: false }], // straddles cutoff
        3: [{ published: NOW - 9 * DAY, isNewBuild: false }], // entirely old — should not be reached past its count
      };
      const fetchPage = async (p) => pages[p] || [];
      const r = await walkFlow({ fetchPage, nowSec: NOW, windowDays: W, maxPages: 80 });
      // page1: 1 second-hand + 1 new-build; page2: 1 second-hand in window (6d), then page2 not entirely-old so continue;
      // page3 entirely old → counted 0, then stop.
      assert.strictEqual(r.addsSecondhand, 2);
      assert.strictEqual(r.newbuildInWindow, 1);
      assert.strictEqual(r.pagesWalked, 3);
    });

    await check('sampleDepth + poolNewbuildShare: weighted new-build share across pages', async () => {
      const pages = {
        1:   [{ published: NOW - 1 * DAY, isNewBuild: true }, { published: NOW - 1 * DAY, isNewBuild: false }], // 50% nb
        500: [{ published: NOW - 100 * DAY, isNewBuild: true }, { published: NOW - 200 * DAY, isNewBuild: true }], // 100% nb
      };
      const fetchPage = async (p) => pages[p] || [];
      const s = await sampleDepth({ fetchPage, pageNumbers: [1, 500], nowSec: NOW });
      assert.strictEqual(s.length, 2);
      assert.strictEqual(s[0].newbuildPct, 0.5);
      assert.strictEqual(s[1].newbuildPct, 1);
      // weighted: (0.5*2 + 1*2) / 4 = 0.75
      assert.strictEqual(poolNewbuildShare(s), 0.75);
    });

    await check('computeMetrics: derives flow/day, 2nd-hand stock, dwell', () => {
      const m = computeMetrics({
        stockTotal: 1000, addsSecondhand: 70, newbuildInWindow: 30, datedInWindow: 100,
        depthSample: [{ page: 1, n: 10, newbuildPct: 0.4, medianAgeDays: 5 }], windowDays: 7,
      });
      assert.strictEqual(m.flow_per_day, 10);              // 70/7
      assert.strictEqual(m.newbuild_share_window, 0.3);    // 30/100
      assert.strictEqual(m.newbuild_share_pool_est, 0.4);  // weighted single page
      assert.strictEqual(m.stock_secondhand_est, 600);     // round(1000*0.6)
      assert.strictEqual(m.mean_dwell_days, 60);           // 600/10
    });

    await check('computeMetrics: zero flow → mean_dwell_days null (no divide-by-zero)', () => {
      const m = computeMetrics({
        stockTotal: 500, addsSecondhand: 0, newbuildInWindow: 0, datedInWindow: 0,
        depthSample: [{ page: 1, n: 10, newbuildPct: 0, medianAgeDays: null }], windowDays: 7,
      });
      assert.strictEqual(m.flow_per_day, 0);
      assert.strictEqual(m.mean_dwell_days, null);
    });

    // --- Age-penetration helpers ---
    const EDGES = [30, 90, 180, 365, 548, 730]; // 7 bands + undated

    await check('bandIndex: half-open bands place ages correctly', () => {
      assert.strictEqual(bandIndex(0, EDGES), 0);      // <30
      assert.strictEqual(bandIndex(29.9, EDGES), 0);
      assert.strictEqual(bandIndex(30, EDGES), 1);     // [30,90)
      assert.strictEqual(bandIndex(89, EDGES), 1);
      assert.strictEqual(bandIndex(90, EDGES), 2);
      assert.strictEqual(bandIndex(364, EDGES), 3);
      assert.strictEqual(bandIndex(365, EDGES), 4);
      assert.strictEqual(bandIndex(730, EDGES), 6);    // >=730 → final band
      assert.strictEqual(bandIndex(5000, EDGES), 6);
    });

    await check('bucketByAge: tallies bands, new-build split, undated separately', () => {
      const cards = [
        { published: NOW - 10 * DAY, isNewBuild: false }, // band0
        { published: NOW - 40 * DAY, isNewBuild: true },  // band1, new-build
        { published: NOW - 400 * DAY, isNewBuild: false },// band4 (>365,<548)
        { published: NOW - 800 * DAY, isNewBuild: true }, // band6, new-build
        { published: null, isNewBuild: false },           // undated
      ];
      const r = bucketByAge(cards, { nowSec: NOW, edges: EDGES });
      assert.strictEqual(r.buckets.length, 7);
      assert.strictEqual(r.buckets[0], 1);
      assert.strictEqual(r.buckets[1], 1);
      assert.strictEqual(r.buckets[4], 1);
      assert.strictEqual(r.buckets[6], 1);
      assert.strictEqual(r.undated, 1);
      assert.strictEqual(r.newbuild[1], 1);
      assert.strictEqual(r.newbuild[6], 1);
      assert.strictEqual(r.buckets.reduce((a, b) => a + b, 0), 4); // dated cards only
    });

    await check('pageMedianAge & countYoungerThan: basic correctness', () => {
      const cards = [
        { published: NOW - 5 * DAY, isNewBuild: false },
        { published: NOW - 15 * DAY, isNewBuild: false },
        { published: NOW - 25 * DAY, isNewBuild: false },
        { published: null, isNewBuild: false },
      ];
      assert.strictEqual(pageMedianAge(cards, NOW), 15); // median of {5,15,25}
      assert.strictEqual(pageMedianAge([{ published: null }], NOW), null);
      assert.strictEqual(countYoungerThan(cards, NOW - 20 * DAY), 2); // ages 5,15 younger than 20d
    });

    await check('findCrossoverPage: exact cumulative on a cleanly-sorted pool (with straddle refine)', async () => {
      // Synthetic pool: pageSize 10, card global index i (0-based) has ageDays = i.
      // Ages strictly increase with depth AND within page (globally sorted, newest-first).
      // Page p (1-based) holds ages (p-1)*10 .. p*10-1. True count younger than C = C.
      // The straddle-page refinement makes the estimate EXACT on a cleanly-sorted pool;
      // real-pool within-page fuzz is precisely what the census bake-off will measure.
      const PAGE = 10, LAST = 100;
      const CLOCK = 5000 * DAY; // large fixed clock so published stays positive
      const fetchPage = async (p) => {
        if (p < 1 || p > LAST) return [];
        const out = [];
        for (let j = 0; j < PAGE; j++) {
          const age = (p - 1) * PAGE + j;
          out.push({ published: CLOCK - age * DAY, isNewBuild: false });
        }
        return out;
      };
      const memo = new Map();
      for (const C of [1, 25, 30, 90, 187, 300, 599]) {
        const r = await findCrossoverPage({ fetchPage, cutoffDays: C, nowSec: CLOCK, lo: 1, hi: LAST, pageSize: PAGE, memo });
        assert.strictEqual(r.cumulativeYounger, C, `cutoff ${C}d: got ${r.cumulativeYounger}, want ${C}`);
      }
      // Probe sharing: 7 cutoffs resolved with far fewer than 7×log2(100) fetches.
      assert.ok(memo.size <= 35, `expected shared memo <=35 pages, got ${memo.size}`);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
