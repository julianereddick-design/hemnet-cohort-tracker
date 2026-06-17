process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/sold-match-run.js — Phase 17 config-driven, manually-runnable end-to-end
// sold-match runner. Replaces the throwaway scripts/spike-hemnet-match.js (file-JSONL,
// hard-coded segments) with a clean DB-backed tool.
//
// Per configured segment (config/sold-segments.json) and a rolling sold-date window
// (default ~30-day month ending at READ_TIME_EXCLUDE_DAYS), it:
//   1. seeds booli_sold via fetchBooliSoldPage + upsertBooliSold (page-by-page),
//   2. searches Hemnet /salda per non-deed-transfer record (searchSoldPaged),
//   3. adjudicates: apartments fee-exact (inline fetchBooliDetail rent vs Hemnet fee),
//      villas address+price+area (spike shortcut, match_method=address_key),
//   4. persists a verdict (matched / booli_only / uncertain) via persistVerdictForRecord,
// all under the Phase-16 DB-atomic spend ceiling (setSpendClient) with a bounded
// ~6-worker pool that early-stops on CeilingError. Prints a per-segment summary; writes
// NO report file (D-04). Title transfers never enter sold_match (D-02 gate in the store).
//
//   SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js [--segment ..] [--limit N]
//       [--conc 6] [--min-sold-date YYYY-MM-DD] [--max-sold-date YYYY-MM-DD]
//   SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke   # offline self-test

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

const DAY = 86400;
const MAX_SEARCH_PAGES = parseInt(process.env.SOLD_MATCH_MAX_PAGES || '5', 10);

// ---------------------------------------------------------------------------
// Config loader (D-01) — read segments-as-data, NOT the SEGMENTS const (Pitfall 7).
// ---------------------------------------------------------------------------
function loadSegments() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'sold-segments.json'), 'utf8'),
  );
}

// ---------------------------------------------------------------------------
// validateDate — ASVS V5 (T-17-03): accept only a real YYYY-MM-DD. The format
// regex + Date.parse + ISO round-trip together reject 2026-13-99 (Date.parse
// rolls it over to 2027-…, so the round-trip string differs).
// ---------------------------------------------------------------------------
function validateDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
}

// ---------------------------------------------------------------------------
// CLI args (spike parseArgs, extended for D-02 date args + validation).
// Supports both `--flag value` and `--flag=value`. Throws on a malformed date
// BEFORE any fetch/query (ASVS V5).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { segment: null, limit: null, conc: 6, minSoldDate: null, maxSoldDate: null, smoke: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--segment') o.segment = argv[++i];
    else if (a.startsWith('--segment=')) o.segment = a.split('=')[1];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a.startsWith('--limit=')) o.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--conc') o.conc = parseInt(argv[++i], 10);
    else if (a.startsWith('--conc=')) o.conc = parseInt(a.split('=')[1], 10);
    else if (a === '--min-sold-date') o.minSoldDate = argv[++i];
    else if (a.startsWith('--min-sold-date=')) o.minSoldDate = a.split('=')[1];
    else if (a === '--max-sold-date') o.maxSoldDate = argv[++i];
    else if (a.startsWith('--max-sold-date=')) o.maxSoldDate = a.split('=')[1];
    else if (a === '--smoke') o.smoke = true;
  }
  if (o.minSoldDate != null && !validateDate(o.minSoldDate)) {
    throw new Error(`invalid --min-sold-date: ${o.minSoldDate} (expected YYYY-MM-DD)`);
  }
  if (o.maxSoldDate != null && !validateDate(o.maxSoldDate)) {
    throw new Error(`invalid --max-sold-date: ${o.maxSoldDate} (expected YYYY-MM-DD)`);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Helpers (copied verbatim from the spike).
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return 80 + Math.random() * 160; }

// Address + sold-date-window candidate filter (spike addrCandidates). normAddr is
// the canonical MATCH-02 source (lib/sold-addr.js).
function addrCandidates(booli, cards, windowDays) {
  const bStreet = normAddr(booli.street_address);
  const bUnix = booliSoldUnix(booli.sold_date);
  return cards.filter((c) => {
    if (!c.street_address || normAddr(c.street_address) !== bStreet) return false;
    if (bUnix != null && c.sold_at != null && Math.abs(c.sold_at - bUnix) > windowDays * DAY) return false;
    return true;
  });
}

// Best candidate: nearest sold date, then closest price (spike pickBest).
function pickBest(booli, cands) {
  const bUnix = booliSoldUnix(booli.sold_date);
  return cands.slice().sort((a, b) => {
    const da = bUnix != null && a.sold_at != null ? Math.abs(a.sold_at - bUnix) : 9e9;
    const db = bUnix != null && b.sold_at != null ? Math.abs(b.sold_at - bUnix) : 9e9;
    if (da !== db) return da - db;
    const pa = pctDiff(booli.sold_price, a.final_price) ?? 9;
    const pb = pctDiff(booli.sold_price, b.final_price) ?? 9;
    return pa - pb;
  })[0];
}

// Compact Hemnet-card brief for the evidence JSONB (spike cardBrief). Null-safe.
function cardBrief(c) {
  return c ? {
    card_id: c.card_id, listing_id: c.listing_id, slug: c.slug,
    detail_url: c.detail_url, street_address: c.street_address,
    final_price: c.final_price, living_area: c.living_area,
    rooms: c.rooms, fee: c.fee, sold_at: c.sold_at,
  } : null;
}

// computeDeltas with the runner's booli↔hemnet field mapping (postcode null for sold).
function deltasFor(record, card) {
  return computeDeltas(
    { price: record.sold_price, living_area: record.living_area, object_type: record.object_type, street_address: record.street_address, postcode: null },
    { asking_price: card.final_price, living_area: card.living_area, housing_form: card.housing_form, street_address: card.street_address, post_code: null },
  );
}

// ---------------------------------------------------------------------------
// persistMapped — assemble the D-08 verdict object and persist (D-02 gate inside
// persistVerdictForRecord). evidence is a PLAIN OBJECT — never pre-stringified
// (Pitfall 4; upsertSoldVerdict JSON.stringify's it internally). Returns the
// mapped verdict string for the worker-pool tally.
// ---------------------------------------------------------------------------
async function persistMapped(client, record, verdict, matchMethod, matchedCard, deltas, extraEvidence, segKey, minSoldDate, maxSoldDate, slugCard) {
  const slugSource = slugCard || (verdict === 'matched' ? matchedCard : null);
  const verdictObj = {
    matched_hemnet_slug: slugSource ? (slugSource.slug || null) : null,
    verdict,
    match_method: matchMethod,
    evidence: {
      ...extraEvidence,
      deltas,
      matched_card: matchedCard ? cardBrief(matchedCard) : null,
      window_start: minSoldDate,
      window_end: maxSoldDate,
    },
    segment: segKey,
    window_start: minSoldDate,
    window_end: maxSoldDate,
    adjudicated_at: new Date().toISOString(),
  };
  await persistVerdictForRecord(client, record, verdictObj);
  return verdict;
}

// ---------------------------------------------------------------------------
// matchOne — Hemnet search → address candidates → adjudication → persist verdict.
// Reproduces the spike matchOne with the three Phase-17 divergences:
//   (1) DB persist (persistVerdictForRecord) instead of JSONL,
//   (2) NO recall pass — non-matched emits booli_only (D-03),
//   (3) inline apartment fee via fetchBooliDetail (D-06; seed-time rent is null
//       for the monthly window — Pitfall 3).
// Houses confirm via the address-key shortcut (unique address + agreeing area+price
// → match_method=address_key); apartments confirm via fee-exact through adjudicatePair.
// `deps` lets the offline smoke inject searchSoldPaged / fetchBooliDetail.
// Returns the mapped verdict string ('matched'|'booli_only'|'uncertain') for the tally.
// ---------------------------------------------------------------------------
async function matchOne(client, record, seg, segKey, minSoldDate, maxSoldDate, log, deps = {}) {
  const search = deps.searchSoldPaged || searchSoldPaged;
  const detailFetch = deps.fetchBooliDetail || fetchBooliDetail;
  const opts = searchOptsFor(seg);

  // 1) Per-record narrowed Hemnet /salda search. CeilingError re-throws (worker
  //    catches); any other error → a booli_only verdict tagged search-failed.
  let searchResult;
  try {
    searchResult = await search(record, seg, SOLD_DATE_WINDOW_DAYS, MAX_SEARCH_PAGES, opts);
  } catch (e) {
    if (e instanceof CeilingError) throw e;
    return await persistMapped(client, record, 'booli_only', null, null, null,
      { error: e.message, source: 'search-failed' }, segKey, minSoldDate, maxSoldDate, null);
  }

  const cards = (searchResult && searchResult.cards) || [];
  const cands = addrCandidates(record, cards, SOLD_DATE_WINDOW_DAYS);

  // 2) No same-address candidate → booli_only. NO recall pass (D-03).
  if (cands.length === 0) {
    return await persistMapped(client, record, 'booli_only', null, null, null,
      { source: 'no-address-candidate', addr_candidates: 0, cards_seen: cards.length },
      segKey, minSoldDate, maxSoldDate, null);
  }

  const chosen = pickBest(record, cands);
  const deltas = deltasFor(record, chosen);

  // 3) HOUSE branch — address is a (near-)unique key. Unique address + agreeing
  //    area + price → CONFIRMED match via the spike shortcut (match_method=address_key);
  //    multi-candidate / divergent → let the Phase-14 model speak (CONFIRMED_MATCH
  //    demoted to uncertain, CONFIRMED_MISMATCH → booli_only). Villas have no fee
  //    signal, so they NEVER route through fee-exact.
  if (seg.family === 'HOUSE') {
    const areaOk = deltas.area_pct_diff != null && deltas.area_pct_diff <= AREA_AGREE_PCT;
    const priceOk = deltas.price_pct_diff != null && deltas.price_pct_diff <= PRICE_AGREE_PCT;
    if (cands.length === 1 && areaOk && priceOk) {
      await upsertHemnetSold(client, chosen); // D-07
      return await persistMapped(client, record, 'matched', 'address_key', chosen, deltas, {
        source: 'house-address+area+price',
        reason: `unique address; area Δ${(deltas.area_pct_diff * 100).toFixed(1)}% price Δ${(deltas.price_pct_diff * 100).toFixed(1)}%`,
        addr_candidates: cands.length,
      }, segKey, minSoldDate, maxSoldDate, chosen);
    }
    const adj = adjudicatePair({
      pair_id: record.booli_id, deltas,
      photos: { hemnet_gallery: [], booli_gallery: [] }, // D-05: no photos for sold
      hemnet_unit: {}, booli_unit: {},
    }, {});
    const v = adj.verdict === 'CONFIRMED_MATCH' ? 'uncertain'
      : adj.verdict === 'CONFIRMED_MISMATCH' ? 'booli_only'
        : 'uncertain';
    return await persistMapped(client, record, v, null, null, deltas, {
      source: adj.source, reason: adj.reason, signals: adj.signals, addr_candidates: cands.length,
    }, segKey, minSoldDate, maxSoldDate, null);
  }

  // 4) APARTMENT branch — need a unit-level signal (fee-exact). D-06: seed-time
  //    rent is null for the monthly window, so fetch the Booli detail INLINE.
  let booliRent = null;
  const residenceId = extractResidenceId(record);
  if (residenceId) {
    const detail = await detailFetch(residenceId, { logger: log }); // re-throws CeilingError only
    booliRent = detail ? detail.rent : null;
  }
  // Prefer a fee-exact candidate when the Booli fee is known.
  let feeChosen = chosen;
  if (booliRent != null) {
    const fm = cands.find((c) => c.fee != null && Math.abs(c.fee - booliRent) === 0);
    if (fm) feeChosen = fm;
  }
  const aptDeltas = deltasFor(record, feeChosen);
  const adj = adjudicatePair({
    pair_id: record.booli_id, deltas: aptDeltas,
    photos: { hemnet_gallery: [], booli_gallery: [] }, // D-05: no photos for sold
    hemnet_unit: { fee: feeChosen.fee != null ? feeChosen.fee : null },
    booli_unit: { rent: booliRent, floor: record.floor != null ? record.floor : null },
  }, {});
  const v = adj.verdict === 'CONFIRMED_MATCH' ? 'matched'
    : adj.verdict === 'CONFIRMED_MISMATCH' ? 'booli_only'
      : 'uncertain';
  if (v === 'matched') await upsertHemnetSold(client, feeChosen); // D-07
  return await persistMapped(client, record, v, v === 'matched' ? 'fee_exact' : null,
    v === 'matched' ? feeChosen : null, aptDeltas, {
      source: adj.source, reason: adj.reason, signals: adj.signals, addr_candidates: cands.length,
      fee: { booli_rent: booliRent, hemnet_fee: feeChosen.fee, exact: booliRent != null && feeChosen.fee != null && booliRent === feeChosen.fee },
    }, segKey, minSoldDate, maxSoldDate, v === 'matched' ? feeChosen : null);
}

// ---------------------------------------------------------------------------
// seedSegment — paginate fetchBooliSoldPage; upsert every card into booli_sold;
// collect non-title-transfer cards into the match queue (D-02 split). Respects
// args.limit (stop growing the queue once it reaches limit).
// ---------------------------------------------------------------------------
async function seedSegment(client, segKey, seg, minSoldDate, maxSoldDate, log, limit) {
  const queue = [];
  let page = 1;
  let seeded = 0;
  let transfers = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { cards, meta } = await fetchBooliSoldPage(segKey, seg, {
      page, maxSoldDate, minSoldDate, logger: log,
    });
    for (const card of cards) {
      await upsertBooliSold(client, { ...card, segment: segKey, family: seg.family });
      seeded++;
      if (card.is_title_transfer) { transfers++; continue; }
      if (limit == null || queue.length < limit) queue.push(card);
    }
    if (cards.length === 0 || (meta && meta.pages != null && page >= meta.pages)) break;
    if (limit != null && queue.length >= limit) break;
    page++;
  }
  log('INFO', `seeded ${segKey}: rows=${seeded} title-transfers=${transfers} queued=${queue.length}`);
  return queue;
}

// ---------------------------------------------------------------------------
// runSegment — bounded worker pool (spike). Shared idx + stopped flag; tally from
// the matchOne return string. DB-atomic ceiling drains at remainingCalls() <= 40.
// Prints the D-04 per-segment summary with Oxylabs calls spent.
// ---------------------------------------------------------------------------
async function runSegment(client, segKey, seg, queue, minSoldDate, maxSoldDate, conc, log) {
  let idx = 0;
  let stopped = null;
  const stats = { matched: 0, booli_only: 0, uncertain: 0, error: 0 };
  const callsBefore = remainingCalls();

  async function worker() {
    while (idx < queue.length) {
      if (stopped) return;
      if (remainingCalls() <= 40) { stopped = 'ceiling-floor'; log('WARN', `approaching ceiling (${remainingCalls()} left) — draining`); return; }
      const record = queue[idx++];
      try {
        await sleep(jitter());
        const verdict = await matchOne(client, record, seg, segKey, minSoldDate, maxSoldDate, log);
        if (verdict === 'matched' || verdict === 'booli_only' || verdict === 'uncertain') stats[verdict]++;
        else stats.error++;
      } catch (e) {
        if (e instanceof CeilingError) { stopped = 'ceiling'; log('WARN', `CEILING hit: ${e.message}`); return; }
        stats.error++;
        log('ERROR', `booli_id=${record.booli_id}: ${e && e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, conc) }, () => worker()));

  const total = stats.matched + stats.booli_only + stats.uncertain + stats.error;
  const matchRate = total ? stats.matched / total : 0;
  const spent = Math.max(0, callsBefore - remainingCalls());
  log('INFO', `DONE ${segKey}: adjudicated=${queue.length} matched=${stats.matched} booli_only=${stats.booli_only} uncertain=${stats.uncertain} error=${stats.error} matchRate=${(matchRate * 100).toFixed(1)}% oxylabsSpent=${spent} stoppedBy=${stopped || 'none'}`);
  return { stats, stopped, spent };
}

// ---------------------------------------------------------------------------
// main — DB lifecycle + spend ceiling + per-segment seed→match loop.
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const segments = loadSegments();
  const maxSoldDate = args.maxSoldDate || daysAgoISO(READ_TIME_EXCLUDE_DAYS);          // ~90 days ago
  const minSoldDate = args.minSoldDate || daysAgoISO(READ_TIME_EXCLUDE_DAYS + 30);     // ~120 days ago
  const log = stdoutLogger('sold-match');

  const segKeys = args.segment ? [args.segment] : Object.keys(segments);
  if (args.segment && !segments[args.segment]) {
    throw new Error(`unknown segment: ${args.segment} (config has: ${Object.keys(segments).join(', ')})`);
  }

  log('INFO', `window=${minSoldDate}..${maxSoldDate} segments=${segKeys.join(',')} conc=${args.conc}${args.limit != null ? ` limit=${args.limit}` : ''}`);

  const client = createClient();
  await client.connect();
  setSpendClient(client);   // D-09 / Pitfall 5: DB-atomic ceiling BEFORE any cachedFetch
  try {
    for (const k of segKeys) {
      const seg = segments[k];
      if (!seg) { log('ERROR', `unknown segment ${k} — skipping`); continue; }
      const queue = await seedSegment(client, k, seg, minSoldDate, maxSoldDate, log, args.limit);
      await runSegment(client, k, seg, queue, minSoldDate, maxSoldDate, args.conc, log);
    }
  } finally {
    await client.end();
  }
}

module.exports = { loadSegments, validateDate, parseArgs, addrCandidates, pickBest, cardBrief, deltasFor, persistMapped, matchOne, seedSegment, runSegment };

if (require.main === module) {
  if (process.argv.includes('--smoke')) {
    runSmoke();
  } else {
    main().catch((e) => { console.error('FATAL', e); process.exit(1); });
  }
}

// ---------------------------------------------------------------------------
// --smoke self-test (offline — NO DB, NO network, NO createClient/connect).
//   SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke
// ---------------------------------------------------------------------------
function runSmoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // Mock pg client: records every (sql, params); returns an empty rowset. Offline.
  function mockClient() {
    const queries = [];
    return {
      queries,
      // eslint-disable-next-line no-unused-vars
      async query(sql, params) { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; },
    };
  }
  const sold = (c) => c.queries.filter((q) => /INSERT INTO sold_match/.test(q.sql));
  const hemnet = (c) => c.queries.filter((q) => /INSERT INTO hemnet_sold/.test(q.sql));
  const verdictSlug = (c) => sold(c)[0].params[1]; // $2 matched_hemnet_slug
  const verdictMethod = (c) => sold(c)[0].params[3]; // $4 match_method
  const verdictName = (c) => sold(c)[0].params[2]; // $3 verdict

  // run the async portion, then print + exit.
  (async () => {

  // --- Task 1: scaffold ---
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

  check('parseArgs supports --flag=value form', () => {
    const a = parseArgs(['--segment=stockholm-apt', '--conc=8', '--limit=5']);
    assert.strictEqual(a.segment, 'stockholm-apt');
    assert.strictEqual(a.conc, 8);
    assert.strictEqual(a.limit, 5);
  });

  check('default window: minSoldDate < maxSoldDate (monthly, CONFIG-02)', () => {
    const maxSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS);
    const minSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS + 30);
    assert.ok(minSoldDate < maxSoldDate, `${minSoldDate} should be < ${maxSoldDate}`);
  });

  check('validateDate rejects malformed dates, accepts real ones (ASVS V5)', () => {
    assert.strictEqual(validateDate('2026-13-99'), false);
    assert.strictEqual(validateDate('notadate'), false);
    assert.strictEqual(validateDate('2026-02-30'), false); // rolls over → round-trip differs
    assert.strictEqual(validateDate('2026-01-01'), true);
  });

  check('parseArgs throws on malformed --min-sold-date', () => {
    assert.throws(() => parseArgs(['--min-sold-date', '2026-13-99']), /invalid --min-sold-date/);
  });

  check('parseArgs throws on malformed --max-sold-date', () => {
    assert.throws(() => parseArgs(['--max-sold-date', 'notadate']), /invalid --max-sold-date/);
  });

  check('cardBrief(null) === null; cardBrief({slug,final_price}) has slug', () => {
    assert.strictEqual(cardBrief(null), null);
    const b = cardBrief({ slug: 'x', final_price: 1 });
    assert.strictEqual(b.slug, 'x');
  });

  // --- Task 2: matchOne behaviors (offline, mock client + injected search/detail) ---
  const HOUSE = { family: 'HOUSE', hemnet: { locationId: 17793, itemType: null } };
  const APT = { family: 'APARTMENT', hemnet: { locationId: 18031, itemType: 'bostadsratt' } };
  const WIN = ['2026-01-01', '2026-02-01'];
  const noLog = () => {};

  // A Hemnet candidate card whose address matches the booli record (normAddr equal),
  // sold close in time, with agreeing price+area. final_price/living_area tuned per test.
  function hcard(over) {
    return Object.assign({
      card_id: 'c1', listing_id: 'l1', slug: 'sold-slug-1', detail_url: 'http://h/1',
      street_address: 'Testgatan 1', sold_at: 1767312000, // 2026-01-02
      final_price: 5000000, living_area: 100, rooms: 5, fee: null, housing_form: 'Villa',
    }, over);
  }
  // A Booli record (sold_date near the card; same street).
  function brec(over) {
    return Object.assign({
      booli_id: 1, street_address: 'Testgatan 1', object_type: 'Villa',
      sold_price: 5000000, sold_date: '2026-01-02', living_area: 100, rooms: 5,
      floor: null, residence_url: '/bostad/999', is_title_transfer: false,
      sold_price_type: 'Slutpris',
    }, over);
  }
  const depsWith = (cards, detail) => ({
    searchSoldPaged: async () => ({ cards, pages: 1, complete: true }),
    fetchBooliDetail: async () => detail,
  });

  // 1) HOUSE, unique agreeing address → matched / address_key, slug set
  await checkAsync('house unique address+price+area → matched/address_key', async () => {
    const c = mockClient();
    const v = await matchOne(c, brec({ booli_id: 11 }), HOUSE, 'taby-villa', WIN[0], WIN[1], noLog, depsWith([hcard()]));
    assert.strictEqual(v, 'matched');
    assert.strictEqual(sold(c).length, 1, 'one sold_match upsert');
    assert.strictEqual(verdictName(c), 'matched');
    assert.strictEqual(verdictMethod(c), 'address_key');
    assert.strictEqual(verdictSlug(c), 'sold-slug-1');
    assert.strictEqual(hemnet(c).length, 1, 'matched house persists its Hemnet card (D-07)');
  });

  // 2) HOUSE, no address candidate → booli_only, no recall (D-03)
  await checkAsync('house no candidate → booli_only (no recall)', async () => {
    const c = mockClient();
    const v = await matchOne(c, brec({ booli_id: 12 }), HOUSE, 'taby-villa', WIN[0], WIN[1], noLog,
      depsWith([hcard({ street_address: 'Annangatan 9' })]));
    assert.strictEqual(v, 'booli_only');
    assert.strictEqual(verdictName(c), 'booli_only');
    assert.strictEqual(verdictSlug(c), null);
    assert.strictEqual(hemnet(c).length, 0, 'no Hemnet persist for booli_only');
  });

  // 3) HOUSE, multi-candidate / divergent → uncertain | booli_only (routed to adjudicatePair)
  await checkAsync('house multi-candidate → uncertain or booli_only (not matched)', async () => {
    const c = mockClient();
    const cards = [hcard({ slug: 's-a' }), hcard({ slug: 's-b', card_id: 'c2', sold_at: 1767312000 })];
    const v = await matchOne(c, brec({ booli_id: 13 }), HOUSE, 'taby-villa', WIN[0], WIN[1], noLog, depsWith(cards));
    assert.ok(v === 'uncertain' || v === 'booli_only', `multi-candidate maps to uncertain|booli_only, got ${v}`);
    assert.notStrictEqual(v, 'matched');
  });

  // 4) APARTMENT, fee-exact → matched / fee_exact + upsertHemnetSold (D-06 inline fee)
  await checkAsync('apt fee-exact → matched/fee_exact + Hemnet persist', async () => {
    const c = mockClient();
    const cands = [hcard({ slug: 'apt-1', housing_form: 'Lägenhet', fee: 4500 })];
    const v = await matchOne(c, brec({ booli_id: 14, object_type: 'Lägenhet' }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: 4500 }));
    assert.strictEqual(v, 'matched');
    assert.strictEqual(verdictMethod(c), 'fee_exact');
    assert.strictEqual(verdictSlug(c), 'apt-1');
    assert.strictEqual(hemnet(c).length, 1, 'matched apt persists its Hemnet card (D-07)');
  });

  // 5) APARTMENT, no fee (detail rent null) → uncertain (no false confirm — Pitfall 3)
  await checkAsync('apt no fee (rent null) → uncertain', async () => {
    const c = mockClient();
    const cands = [hcard({ slug: 'apt-2', housing_form: 'Lägenhet', fee: 4500 })];
    const v = await matchOne(c, brec({ booli_id: 15, object_type: 'Lägenhet' }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: null }));
    assert.strictEqual(v, 'uncertain');
    assert.strictEqual(verdictName(c), 'uncertain');
    assert.strictEqual(hemnet(c).length, 0, 'no Hemnet persist when unmatched');
  });

  // 6) Title transfer → zero verdict queries (D-02 gate in persistVerdictForRecord)
  await checkAsync('title transfer → zero verdict queries (D-02)', async () => {
    const c = mockClient();
    const v = await matchOne(c, brec({ booli_id: 16, is_title_transfer: true, sold_price_type: 'Lagfart' }),
      HOUSE, 'taby-villa', WIN[0], WIN[1], noLog, depsWith([hcard()]));
    assert.strictEqual(sold(c).length, 0, 'must issue zero sold_match queries for a title transfer');
    assert.ok(v === 'matched' || v === 'booli_only' || v === 'uncertain', 'returns a verdict string for the tally');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.stack || err}`);
    process.exit(1);
  });
}
