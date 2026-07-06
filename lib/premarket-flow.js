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
async function walkFlow({ fetchPage, nowSec, windowDays, maxPages, logger = noop }) {
  let addsSecondhand = 0, newbuildInWindow = 0, datedInWindow = 0, pagesWalked = 0;
  const cardsAll = [];
  for (let p = 1; p <= maxPages; p++) {
    const cards = await fetchPage(p);
    pagesWalked = p;
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
  return { addsSecondhand, newbuildInWindow, datedInWindow, pagesWalked, cards: cardsAll };
}

// Sample specific pages spread across pool depth to estimate composition.
async function sampleDepth({ fetchPage, pageNumbers, nowSec, logger = noop }) {
  const out = [];
  for (const page of pageNumbers) {
    const cards = await fetchPage(page);
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

module.exports = {
  DAY, cardAgeDays, countWindowSecondhand, pageEntirelyOld,
  walkFlow, sampleDepth, poolNewbuildShare, computeMetrics,
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

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
