'use strict';

// sold-fetch-booli.js — Paginated seed fetch for Booli /slutpriser SOLD records.
// Lifted and productionised from scripts/spike-booli-sold.js (Phase 15-04).
//
// Provides:
//   fetchBooliSold(segKey, seg, opts)
//     — Paginated window fetch with idempotent JSONL resume, sold-date early-stop,
//       soldPriceType classification, and recon-gated detail enrichment (D-01).
//       Writes output to verf-soldspike/seeds/<segKey>.jsonl.
//   fetchBooliSoldPage(segKey, seg, opts)
//     — Single-page primitive (no JSONL write). Returns { cards, meta }.
//       Used by Phase 16 to persist directly to the DB.
//
// D-01 detail policy (15-SOLD-IN-ADVANCE-RECON.md, approved 2026-06-17):
//   Default opts.detailScope = 'fee-window' (apartments only, within fee window).
//   opts.detailScope = 'all'    → fetch /bostad/<residenceId> for every record WHERE
//                                  !isTitleTransfer. Gate: caller must pass detailScope
//                                  explicitly; the CLI wrapper (booli-sold.js) refuses
//                                  unless the operator-approval marker is present in the
//                                  RECON doc (spend confirmed). Never the silent default.
//   opts.detailScope = 'none'   → no detail fetches at all.
//   Deed transfers (isTitleTransfer) always stay card-only regardless of detailScope.
//
// IMPORTANT: callers MUST set process.env.SCRAPE_FORCE_OXYLABS = '1' BEFORE
// requiring this module (lib/sold-transport.js enforces this at load time).

const path = require('path');
const {
  cachedFetch,
  extractApollo,
  appendJsonl,
  readJsonl,
  writeJson,
  ensureDir,
  CeilingError,
  stdoutLogger,
  ROOT,
} = require('./sold-transport');
const {
  SEGMENTS,
  DEFAULT_TARGET_PER_SEGMENT,
  READ_TIME_EXCLUDE_DAYS,
  daysAgoISO,
} = require('./sold-config');
const {
  parseBooliSoldCards,
  parseBooliSoldDetail,
  booliSoldMeta,
} = require('./sold-parse');

// Apartment family check — determines whether fee-window detail is applicable.
const APARTMENT_FAMILIES = new Set(['APARTMENT']);

// How many days old a record must be before the fee window is assumed to be
// available on Booli (apartments only). Mirrors the cohort fee-match heuristic.
const FEE_WINDOW_DAYS = 270; // ~9 months back is the practical Booli fee horizon

function noop() {}

// ---------------------------------------------------------------------------
// fetchBooliSoldPage — single-page primitive; no JSONL write.
// Returns { cards, meta } so Phase 16 can persist rows directly to DB.
// ---------------------------------------------------------------------------
async function fetchBooliSoldPage(segKey, seg, opts = {}) {
  const log = opts.logger || noop;
  const {
    page = 1,
    maxSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS),
    minSoldDate = null,
  } = opts;

  const { areaIds, objectType } = seg.booli;
  const dateParams = `&maxSoldDate=${maxSoldDate}` + (minSoldDate ? `&minSoldDate=${minSoldDate}` : '');
  const url = `https://www.booli.se/slutpriser?areaIds=${areaIds}&objectType=${encodeURIComponent(objectType)}${dateParams}&page=${page}`;

  let res;
  try {
    res = await cachedFetch(url, { logger: log });
  } catch (e) {
    if (e instanceof CeilingError) throw e;
    log('ERROR', `fetchBooliSoldPage page=${page} fetch failed: ${e.message}`);
    return { cards: [], meta: { totalCount: null, pages: null } };
  }

  if (res.status !== 200) {
    log('WARN', `fetchBooliSoldPage page=${page} status ${res.status}`);
    return { cards: [], meta: { totalCount: null, pages: null } };
  }

  let apollo;
  try {
    ({ apollo } = extractApollo(res.html));
  } catch (e) {
    log('ERROR', `fetchBooliSoldPage page=${page} apollo parse failed: ${e.message}`);
    return { cards: [], meta: { totalCount: null, pages: null } };
  }

  const meta = booliSoldMeta(apollo);
  const cards = parseBooliSoldCards(apollo);
  return { cards, meta };
}

// ---------------------------------------------------------------------------
// fetchBooliDetail — fetch a single /bostad/<residenceId> detail page.
// Returns the parsed detail object or null (never throws; caller handles null).
// ---------------------------------------------------------------------------
async function fetchBooliDetail(residenceId, opts = {}) {
  const log = opts.logger || noop;
  if (!residenceId) return null;

  const url = `https://www.booli.se/bostad/${residenceId}`;
  let res;
  try {
    res = await cachedFetch(url, { logger: log });
  } catch (e) {
    if (e instanceof CeilingError) throw e;
    log('WARN', `fetchBooliDetail residenceId=${residenceId} fetch failed: ${e.message}`);
    return null;
  }

  if (res.status !== 200) {
    log('WARN', `fetchBooliDetail residenceId=${residenceId} status ${res.status}`);
    return null;
  }

  let apollo;
  try {
    ({ apollo } = extractApollo(res.html));
  } catch (e) {
    log('WARN', `fetchBooliDetail residenceId=${residenceId} apollo parse failed: ${e.message}`);
    return null;
  }

  return parseBooliSoldDetail(apollo);
}

// Extract residenceId from the card's residence_url ("/bostad/<residenceId>").
function extractResidenceId(card) {
  if (!card.residence_url) return null;
  const m = String(card.residence_url).match(/\/bostad\/(\d+)/);
  return m ? m[1] : null;
}

// Determine whether the detail fetch should run for this card given detailScope.
//   'all'        → true for all !isTitleTransfer records
//   'fee-window' → true for APARTMENT records older than FEE_WINDOW_DAYS
//   'none'       → false always
function shouldFetchDetail(card, seg, detailScope, maxSoldDate) {
  if (card.is_title_transfer) return false;       // deed transfers: card-only always
  if (detailScope === 'none') return false;
  if (detailScope === 'all') return true;
  // 'fee-window' default: apartments within the fee window
  if (seg.family !== 'APARTMENT' && !APARTMENT_FAMILIES.has(seg.family)) return false;
  // Fee window check: sold_date older than FEE_WINDOW_DAYS ago
  if (!card.sold_date) return true; // unknown date → attempt (safe)
  const cutoff = daysAgoISO(FEE_WINDOW_DAYS, maxSoldDate);
  return card.sold_date <= cutoff;
}

// ---------------------------------------------------------------------------
// fetchBooliSold — paginated fetch with idempotent JSONL resume.
// ---------------------------------------------------------------------------
// opts:
//   target          {number}   total-row ceiling (default DEFAULT_TARGET_PER_SEGMENT)
//   marketTarget    {number}   market-sale-row ceiling (overrides total if set)
//   maxPages        {number}   hard page limit (default 60)
//   maxSoldDate     {string}   YYYY-MM-DD upper bound (default daysAgoISO(READ_TIME_EXCLUDE_DAYS))
//   minSoldDate     {string}   YYYY-MM-DD lower bound (optional)
//   detailScope     {string}   'fee-window' | 'all' | 'none' (default 'fee-window')
//   logger          {function} (level, msg) => void
//
async function fetchBooliSold(segKey, seg, opts = {}) {
  const log = opts.logger || noop;
  const target = opts.target != null ? opts.target : DEFAULT_TARGET_PER_SEGMENT;
  const marketTarget = opts.marketTarget != null ? opts.marketTarget : null;
  const maxPages = opts.maxPages != null ? opts.maxPages : 60;
  const maxSoldDate = opts.maxSoldDate || daysAgoISO(READ_TIME_EXCLUDE_DAYS);
  const minSoldDate = opts.minSoldDate || null;
  const detailScope = opts.detailScope || 'fee-window';

  const SEED_DIR = ensureDir(path.join(ROOT, 'seeds'));
  const seedFile = path.join(SEED_DIR, `${segKey}.jsonl`);

  // Idempotent resume: read existing records, build seen Set.
  const existing = readJsonl(seedFile);
  const seen = new Set(existing.map((r) => String(r.booli_id)));
  let collected = existing.length;
  let marketCollected = existing.filter((r) => !r.is_title_transfer).length;

  // Stop condition: marketTarget (market-only rows) overrides total target.
  const reached = () => (marketTarget != null ? marketCollected >= marketTarget : collected >= target);

  log('INFO', `segment=${segKey} (${seg.label}) ${marketTarget != null ? `market-target=${marketTarget}` : `target=${target}`} resume-from=${collected} rows (${marketCollected} market) detailScope=${detailScope}`);

  const { areaIds, objectType } = seg.booli;
  let page = 1;
  let totalCount = null;
  let pagesAvail = null;
  let stop = null;
  let detailFetches = 0;
  let detailErrors = 0;

  while (!reached() && page <= maxPages) {
    const dateParams = `&maxSoldDate=${maxSoldDate}` + (minSoldDate ? `&minSoldDate=${minSoldDate}` : '');
    const url = `https://www.booli.se/slutpriser?areaIds=${areaIds}&objectType=${encodeURIComponent(objectType)}${dateParams}&page=${page}`;

    let res;
    try {
      res = await cachedFetch(url, { logger: log });
    } catch (e) {
      if (e instanceof CeilingError) {
        stop = 'ceiling';
        log('WARN', e.message);
        break;
      }
      log('ERROR', `page ${page} fetch failed: ${e.message}`);
      page++;
      continue;
    }

    if (res.status !== 200) {
      log('WARN', `page ${page} status ${res.status} — stopping`);
      stop = `status-${res.status}`;
      break;
    }

    let apollo;
    try {
      ({ apollo } = extractApollo(res.html));
    } catch (e) {
      log('ERROR', `page ${page} apollo parse failed: ${e.message}`);
      page++;
      continue;
    }

    const meta = booliSoldMeta(apollo);
    if (meta.totalCount != null) totalCount = meta.totalCount;
    if (meta.pages != null) pagesAvail = meta.pages;

    const cards = parseBooliSoldCards(apollo);
    if (cards.length === 0) {
      log('INFO', `page ${page} returned 0 cards — end of feed`);
      stop = 'empty-page';
      break;
    }

    let added = 0;
    for (const c of cards) {
      const id = String(c.booli_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Build the enriched record starting from the card.
      const record = {
        ...c,
        segment: segKey,
        family: seg.family,
        scraped_at: new Date().toISOString(),
        // Detail-only fields — set to null initially, populated below if fetched.
        sold_in_advance: null,
        rent: null,
        operating_cost: null,
        construction_year: null,
        agent_id: null,
        agency_id: null,
        tenure_form: null,
      };

      // D-01 detail-fetch gate.
      if (shouldFetchDetail(c, seg, detailScope, maxSoldDate)) {
        const residenceId = extractResidenceId(c);
        if (residenceId) {
          let detail = null;
          try {
            detail = await fetchBooliDetail(residenceId, { logger: log });
            detailFetches++;
          } catch (e) {
            if (e instanceof CeilingError) {
              // Ceiling hit mid-card-loop: write what we have, then stop the page loop.
              appendJsonl(seedFile, record);
              collected++;
              if (!c.is_title_transfer) marketCollected++;
              added++;
              stop = 'ceiling';
              log('WARN', e.message);
              break;
            }
            log('WARN', `fetchBooliDetail residenceId=${residenceId} error: ${e.message}`);
            detailErrors++;
          }

          if (detail) {
            // SoldProperty.soldAsUpcomingSale → sold_in_advance (D-04 finding).
            // parseBooliSoldDetail now extracts this field directly from the Apollo node.
            record.sold_in_advance = detail.sold_in_advance != null
              ? detail.sold_in_advance
              : null;
            // Enrichment fields from the detail page.
            if (detail.rent != null) record.rent = detail.rent;
            if (detail.operating_cost != null) record.operating_cost = detail.operating_cost;
            if (detail.construction_year != null) record.construction_year = detail.construction_year;
            if (detail.agent_id != null) record.agent_id = detail.agent_id;
            if (detail.agency_id != null) record.agency_id = detail.agency_id;
            if (detail.tenure_form != null) record.tenure_form = detail.tenure_form;
          }
        }
      }
      // If stop was set inside the inner for loop (CeilingError mid-detail), break out.
      if (stop === 'ceiling') break;

      appendJsonl(seedFile, record);
      collected++;
      if (!c.is_title_transfer) marketCollected++;
      added++;
      if (reached()) break;
    }

    log('INFO', `page ${page}: ${cards.length} cards, +${added} new (rows=${collected}, market=${marketCollected}${marketTarget != null ? `/${marketTarget}` : ''})`);

    if (stop === 'ceiling') break;
    page++;
  }

  // Read back the final seed to compute summary statistics.
  const all = readJsonl(seedFile);
  const titleTransfers = all.filter((r) => r.is_title_transfer);
  const byType = {};
  for (const r of all) byType[r.object_type] = (byType[r.object_type] || 0) + 1;
  const bySoldType = {};
  for (const r of all) bySoldType[r.sold_price_type] = (bySoldType[r.sold_price_type] || 0) + 1;

  const summary = {
    segment: segKey,
    label: seg.label,
    seedFile: path.relative(ROOT, seedFile),
    maxSoldDate,
    minSoldDate: minSoldDate || null,
    detailScope,
    feedTotalCount: totalCount,
    feedPages: pagesAvail,
    collected: all.length,
    target,
    marketTarget: marketTarget || null,
    pagesWalked: page - 1,
    stoppedBy: stop,
    titleTransfers: titleTransfers.length,
    matchSeed: all.length - titleTransfers.length,
    detailFetches,
    detailErrors,
    byObjectType: byType,
    bySoldPriceType: bySoldType,
  };
  log('INFO', `DONE ${segKey}: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  fetchBooliSold,
  fetchBooliSoldPage,
  fetchBooliDetail,
  extractResidenceId,
};

// ---------------------------------------------------------------------------
// Inline smoke test — node lib/sold-fetch-booli.js --smoke
// Exercises pure logic offline (no network calls, no JSONL writes).
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- shouldFetchDetail ---

  const aptSeg = { family: 'APARTMENT' };
  const houseSeg = { family: 'HOUSE' };

  check('shouldFetchDetail: deed transfer is never fetched (all scope)', () => {
    const card = { is_title_transfer: true, sold_date: '2020-01-01' };
    assert.strictEqual(shouldFetchDetail(card, aptSeg, 'all', '2026-06-17'), false);
  });
  check('shouldFetchDetail: deed transfer is never fetched (fee-window scope)', () => {
    const card = { is_title_transfer: true, sold_date: '2020-01-01' };
    assert.strictEqual(shouldFetchDetail(card, aptSeg, 'fee-window', '2026-06-17'), false);
  });
  check('shouldFetchDetail: all scope fetches non-deed apartment', () => {
    const card = { is_title_transfer: false, sold_date: '2026-01-01' };
    assert.strictEqual(shouldFetchDetail(card, aptSeg, 'all', '2026-06-17'), true);
  });
  check('shouldFetchDetail: all scope fetches non-deed house', () => {
    const card = { is_title_transfer: false, sold_date: '2026-01-01' };
    assert.strictEqual(shouldFetchDetail(card, houseSeg, 'all', '2026-06-17'), true);
  });
  check('shouldFetchDetail: none scope never fetches', () => {
    const card = { is_title_transfer: false, sold_date: '2020-01-01' };
    assert.strictEqual(shouldFetchDetail(card, aptSeg, 'none', '2026-06-17'), false);
  });
  check('shouldFetchDetail: fee-window skips houses', () => {
    const card = { is_title_transfer: false, sold_date: '2020-01-01' };
    assert.strictEqual(shouldFetchDetail(card, houseSeg, 'fee-window', '2026-06-17'), false);
  });
  check('shouldFetchDetail: fee-window fetches old apartment (>270d ago)', () => {
    const card = { is_title_transfer: false, sold_date: '2025-01-01' };
    // maxSoldDate = 2026-03-19 (90d ago); cutoff = 270d before that = 2025-06-22; sold_date 2025-01-01 <= cutoff
    assert.strictEqual(shouldFetchDetail(card, aptSeg, 'fee-window', '2026-03-19'), true);
  });
  check('shouldFetchDetail: fee-window skips recent apartment (<270d ago)', () => {
    // sold_date more recent than the FEE_WINDOW_DAYS cutoff
    const card = { is_title_transfer: false, sold_date: '2026-03-18' };
    // maxSoldDate = 2026-03-19; cutoff = daysAgoISO(270, '2026-03-19') = approx 2025-06-22
    // sold_date 2026-03-18 > cutoff → do NOT fetch
    assert.strictEqual(shouldFetchDetail(card, aptSeg, 'fee-window', '2026-03-19'), false);
  });
  check('shouldFetchDetail: fee-window fetches apt with null sold_date (safe default)', () => {
    const card = { is_title_transfer: false, sold_date: null };
    assert.strictEqual(shouldFetchDetail(card, aptSeg, 'fee-window', '2026-06-17'), true);
  });

  // --- extractResidenceId ---
  check('extractResidenceId: extracts from /bostad/12345', () => {
    assert.strictEqual(extractResidenceId({ residence_url: '/bostad/12345' }), '12345');
  });
  check('extractResidenceId: returns null for null url', () => {
    assert.strictEqual(extractResidenceId({ residence_url: null }), null);
  });
  check('extractResidenceId: returns null for non-matching url', () => {
    assert.strictEqual(extractResidenceId({ residence_url: '/slutpriser/12345' }), null);
  });

  // --- URL construction check (reached() logic stub) ---
  check('reached(): marketTarget path', () => {
    const marketTarget = 5;
    let marketCollected = 3;
    const reached = () => (marketTarget != null ? marketCollected >= marketTarget : false);
    assert.strictEqual(reached(), false);
    marketCollected = 5;
    assert.strictEqual(reached(), true);
  });
  check('reached(): total target path', () => {
    const target = 10;
    let collected = 9;
    const marketTarget = null;
    const reached = () => (marketTarget != null ? false : collected >= target);
    assert.strictEqual(reached(), false);
    collected = 10;
    assert.strictEqual(reached(), true);
  });

  // --- seen-dedup stub ---
  check('seen Set deduplication: skips known booli_id', () => {
    const seen = new Set(['42', '99']);
    const cards = [{ booli_id: 42 }, { booli_id: 100 }];
    const newCards = cards.filter((c) => !seen.has(String(c.booli_id)));
    assert.strictEqual(newCards.length, 1);
    assert.strictEqual(newCards[0].booli_id, 100);
  });

  // --- exports shape ---
  check('module exports fetchBooliSold', () => {
    assert.strictEqual(typeof fetchBooliSold, 'function');
  });
  check('module exports fetchBooliSoldPage', () => {
    assert.strictEqual(typeof fetchBooliSoldPage, 'function');
  });
  check('module exports fetchBooliDetail', () => {
    assert.strictEqual(typeof fetchBooliDetail, 'function');
  });
  check('module exports extractResidenceId', () => {
    assert.strictEqual(typeof extractResidenceId, 'function');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
