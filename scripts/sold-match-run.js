process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/sold-match-run.js — Phase 17 config-driven sold-match runner.
//
// RED scaffold (TDD): functions are stubs; the --smoke block below asserts the
// Task-1 behaviors and is EXPECTED TO FAIL until the GREEN implementation lands.

const fs = require('fs');
const path = require('path');
const { createClient } = require('../db');
const { cachedFetch, CeilingError, stdoutLogger, remainingCalls, setSpendClient } = require('../lib/sold-transport');
const { isTitleTransfer, PRICE_AGREE_PCT, AREA_AGREE_PCT, SOLD_DATE_WINDOW_DAYS, READ_TIME_EXCLUDE_DAYS, daysAgoISO } = require('../lib/sold-config');
const { fetchBooliSoldPage, fetchBooliDetail, extractResidenceId } = require('../lib/sold-fetch-booli');
const { searchSoldPaged, searchOptsFor, booliSoldUnix } = require('../lib/sold-fetch-hemnet');
const { upsertBooliSold, upsertHemnetSold, persistVerdictForRecord } = require('../lib/sold-store');
const { adjudicatePair } = require('../lib/spotcheck-adjudicate');
const { computeDeltas, pctDiff } = require('../lib/spotcheck-evidence');
const { normAddr } = require('../lib/sold-addr');

// --- STUBS (RED) ---
function loadSegments() { return {}; }
function validateDate() { return false; }
function parseArgs() { return {}; }
function addrCandidates() { return []; }
function pickBest() { return null; }
function cardBrief() { return undefined; }

module.exports = { loadSegments, validateDate, parseArgs, addrCandidates, pickBest, cardBrief };

if (require.main === module) {
  if (process.argv.includes('--smoke')) {
    runSmoke();
  } else {
    console.error('FATAL not implemented');
    process.exit(1);
  }
}

function runSmoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('loadSegments returns stockholm-apt (APARTMENT) and taby-villa (HOUSE)', () => {
    const segs = loadSegments();
    assert.ok(segs['stockholm-apt'], 'stockholm-apt present');
    assert.strictEqual(segs['stockholm-apt'].family, 'APARTMENT');
    assert.ok(segs['taby-villa'], 'taby-villa present');
    assert.strictEqual(segs['taby-villa'].family, 'HOUSE');
  });

  check('parseArgs honors --segment/--min-sold-date/--max-sold-date/--conc', () => {
    const a = parseArgs(['--segment', 'taby-villa', '--min-sold-date', '2026-01-01', '--max-sold-date', '2026-02-01', '--conc', '4']);
    assert.strictEqual(a.segment, 'taby-villa');
    assert.strictEqual(a.minSoldDate, '2026-01-01');
    assert.strictEqual(a.maxSoldDate, '2026-02-01');
    assert.strictEqual(a.conc, 4);
  });

  check('default window: minSoldDate < maxSoldDate (monthly, CONFIG-02)', () => {
    const maxSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS);
    const minSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS + 30);
    assert.ok(minSoldDate < maxSoldDate, `${minSoldDate} should be < ${maxSoldDate}`);
  });

  check('validateDate rejects malformed dates (ASVS V5)', () => {
    assert.strictEqual(validateDate('2026-13-99'), false);
    assert.strictEqual(validateDate('notadate'), false);
    assert.strictEqual(validateDate('2026-01-01'), true);
  });

  check('parseArgs throws on malformed --min-sold-date', () => {
    assert.throws(() => parseArgs(['--min-sold-date', '2026-13-99']), /invalid --min-sold-date/);
  });

  check('cardBrief(null) === null; cardBrief({slug,final_price}) has slug', () => {
    assert.strictEqual(cardBrief(null), null);
    const b = cardBrief({ slug: 'x', final_price: 1 });
    assert.strictEqual(b.slug, 'x');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
