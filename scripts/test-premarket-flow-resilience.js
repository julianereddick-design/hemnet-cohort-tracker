// scripts/test-premarket-flow-resilience.js
// Offline regression test for the fault-tolerance of the pre-market flow walk.
// The 2026-07-20 incident: a single transient Oxylabs 613 on Hemnet /kommande page 3
// threw all the way up and lost the entire weekly datapoint (see deep-dive in the
// premarket-flow-measure runbook). walkFlow/sampleDepth must now TOLERATE a page whose
// fetchPage rejects — skip it, count it, keep walking — and only ABORT when failures
// exceed a data-quality floor.
//
// Run: node scripts/test-premarket-flow-resilience.js
// Exit 0 on pass, 1 on any failure. Output: "PASS: N/M" or "FAIL: ...".

'use strict';

const { walkFlow, sampleDepth, retryFetch, validatePremarketRun } = require('../lib/premarket-flow');

const DAY = 86400;
const NOW = 1_752_000_000; // fixed clock (arbitrary, ~2025); avoids Date.now()
const WINDOW = 7;
const inWindow = { published: NOW - 1 * DAY, isNewBuild: false };   // fresh 2nd-hand add
const oldCard = { published: NOW - 30 * DAY, isNewBuild: false };   // outside 7d window

let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e && e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Build a fetchPage from a map of page->result, where a result can be an array of
// cards, the string 'THROW' (simulates a transient fetch failure), or [] (end of pages).
function makeFetcher(pages) {
  return async (p) => {
    const r = pages[p];
    if (r === 'THROW') throw new Error(`simulated transient failure page ${p}`);
    return r || [];
  };
}

async function main() {
  // 1. A throwing page in the middle is skipped; the walk continues and counts later pages.
  await test('walkFlow skips a throwing page and keeps counting', async () => {
    const fetchPage = makeFetcher({
      1: [inWindow, inWindow],   // 2 adds
      2: 'THROW',                // transient failure
      3: [inWindow],             // 1 add — must still be counted
      4: [],                     // end
    });
    const r = await walkFlow({ fetchPage, nowSec: NOW, windowDays: WINDOW, maxPages: 80 });
    assert(r.addsSecondhand === 3, `expected 3 adds across the failure, got ${r.addsSecondhand}`);
  });

  // 2. The number of failed pages is reported so validate()/artifacts can flag degradation.
  await test('walkFlow reports failedPages count', async () => {
    const fetchPage = makeFetcher({ 1: [inWindow], 2: 'THROW', 3: [] });
    const r = await walkFlow({ fetchPage, nowSec: NOW, windowDays: WINDOW, maxPages: 80 });
    assert(r.failedPages === 1, `expected failedPages=1, got ${r.failedPages}`);
  });

  // 3. Too many failures = genuinely broken feed → abort (do NOT persist a garbage undercount).
  await test('walkFlow aborts when failures exceed maxFailedPages', async () => {
    const fetchPage = makeFetcher({ 1: 'THROW', 2: 'THROW', 3: 'THROW' });
    let threw = false;
    try {
      await walkFlow({ fetchPage, nowSec: NOW, windowDays: WINDOW, maxPages: 80, maxFailedPages: 1 });
    } catch (_) { threw = true; }
    assert(threw, 'expected walkFlow to throw once failures exceeded maxFailedPages');
  });

  // 4. A legitimately EMPTY page (end of pagination) is NOT a failure — it stops the walk cleanly.
  await test('walkFlow treats empty page as end-of-pages, not a failure', async () => {
    const fetchPage = makeFetcher({ 1: [inWindow], 2: [] });
    const r = await walkFlow({ fetchPage, nowSec: NOW, windowDays: WINDOW, maxPages: 80 });
    assert(r.failedPages === 0, `empty page must not count as failure, got failedPages=${r.failedPages}`);
    assert(r.addsSecondhand === 1, `expected 1 add, got ${r.addsSecondhand}`);
  });

  // 5. sampleDepth tolerates a throwing page (composition estimate is non-critical).
  await test('sampleDepth skips a throwing page without throwing', async () => {
    const fetchPage = makeFetcher({ 1: [inWindow, oldCard], 100: 'THROW', 300: [oldCard] });
    const out = await sampleDepth({ fetchPage, pageNumbers: [1, 100, 300], nowSec: NOW });
    assert(Array.isArray(out), 'sampleDepth should return an array');
    assert(out.length === 2, `expected 2 successful samples (100 skipped), got ${out.length}`);
  });

  // 6. retryFetch rides out a transient failure and returns the eventual value (no throw).
  await test('retryFetch recovers a page that fails then succeeds', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls < 3) throw new Error('613'); return ['ok']; };
    const sleeps = [];
    const r = await retryFetch(fn, { attempts: 3, backoffMs: [10, 20], sleep: async (ms) => sleeps.push(ms) });
    assert(JSON.stringify(r) === JSON.stringify(['ok']), `expected recovered value, got ${JSON.stringify(r)}`);
    assert(calls === 3, `expected 3 attempts, got ${calls}`);
    assert(sleeps.length === 2, `expected 2 backoff sleeps, got ${sleeps.length}`);
  });

  // 7. retryFetch rethrows when every attempt fails (so the walk's skip-tolerance can count it).
  await test('retryFetch rethrows after exhausting attempts', async () => {
    const fn = async () => { throw new Error('persistent 613'); };
    let threw = false;
    try {
      await retryFetch(fn, { attempts: 3, backoffMs: [1, 1], sleep: async () => {} });
    } catch (e) { threw = /613/.test(e.message); }
    assert(threw, 'expected retryFetch to rethrow the underlying error after all attempts');
  });

  // 8. validate: a fully clean run (both platforms persisted, no skipped pages) → no alert.
  await test('validatePremarketRun returns null on a clean run', async () => {
    const w = validatePremarketRun({ persisted: ['hemnet', 'booli'], failed: [], failedPages: { hemnet: 0, booli: 0 } });
    assert(w == null, `expected null, got ${JSON.stringify(w)}`);
  });

  // 9. validate: one platform failed entirely (partial persist) → warning naming it.
  await test('validatePremarketRun warns when a platform failed', async () => {
    const w = validatePremarketRun({ persisted: ['booli'], failed: ['hemnet'], failedPages: { booli: 0 } });
    assert(typeof w === 'string' && /hemnet/.test(w), `expected warning naming hemnet, got ${JSON.stringify(w)}`);
  });

  // 10. validate: both platforms persisted but pages were skipped → warning (degraded but usable).
  await test('validatePremarketRun warns on skipped pages', async () => {
    const w = validatePremarketRun({ persisted: ['hemnet', 'booli'], failed: [], failedPages: { hemnet: 2, booli: 0 } });
    assert(typeof w === 'string' && /2/.test(w), `expected warning mentioning skipped pages, got ${JSON.stringify(w)}`);
  });

  if (fail === 0) {
    console.log(`PASS: ${pass}/${pass + fail}`);
    process.exit(0);
  } else {
    console.log(`FAIL: ${fail}/${pass + fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
