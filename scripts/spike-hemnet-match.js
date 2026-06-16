'use strict';

// spike-hemnet-match.js — Stage 2 + Stage 3. For each Booli sold seed record
// (title transfers excluded), run an individual NARROWED Hemnet /salda search
// (cohort-build pattern: location + price±5% + rooms + item_type), confirm the
// match, and adjudicate with the Phase 14 verdict model.
//
//   Houses: street address is a (near-)unique key -> address + area + price
//           confirms (CONFIRMED_MATCH). Reuses adjudicatePair for divergence.
//   Apartments: address is NOT a unit key -> escalate (fetch Booli detail for
//           the monthly fee) and require a unit-level signal (fee-exact) per the
//           Phase 14 identity model. No fee match -> UNCERTAIN (the kill-signal).
//           (dHash/vision unavailable: Booli sold pages serve no photos.)
//
// Stage 3: each Booli-only record gets a stricter/fuzzier recall search to split
//   match-miss (recall gap) from genuine Hemnet-bypass.
//
//   node scripts/spike-hemnet-match.js [--segment ..] [--limit N] [--conc 6]

process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

const path = require('path');
const {
  cachedFetch, extractApollo, ROOT, ensureDir,
  appendJsonl, readJsonl, writeJson, assertOxyUsed, procStats, CeilingError, stdoutLogger, remainingCalls,
} = require('./spike-common');
const { SEGMENTS, PRICE_BAND, SOLD_DATE_WINDOW_DAYS, AREA_AGREE_PCT, PRICE_AGREE_PCT } = require('./spike-config');
const { parseHemnetSaleCards, hemnetSalesMeta, parseBooliSoldDetail } = require('./spike-sold-parse');
const { normStreet, computeDeltas, pctDiff } = require('../lib/spotcheck-evidence');
const { adjudicatePair } = require('../lib/spotcheck-adjudicate');
const { booliObjectTypeToHemnet } = require('../lib/booli-to-hemnet-mapping');

const log = stdoutLogger('match');
const MATCH_DIR = ensureDir(path.join(ROOT, 'match'));
const DAY = 86400;
// Pagination depth for the per-record search. Older records sit deeper under the
// NEWEST sort, so historical windows need more (env SPIKE_MAX_PAGES).
const MAX_SEARCH_PAGES = parseInt(process.env.SPIKE_MAX_PAGES || '5', 10);

function parseArgs(argv) {
  const o = { segment: null, limit: null, conc: 6, ceilingFloor: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--segment') o.segment = argv[++i];
    else if (a.startsWith('--segment=')) o.segment = a.split('=')[1];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a.startsWith('--limit=')) o.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--conc') o.conc = parseInt(argv[++i], 10);
    else if (a.startsWith('--conc=')) o.conc = parseInt(a.split('=')[1], 10);
  }
  return o;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return 80 + Math.random() * 160; }
function booliSoldUnix(d) { const t = Date.parse(`${d}T00:00:00Z`); return Number.isFinite(t) ? Math.floor(t / 1000) : null; }

// Building-level address key. Hemnet appends a floor/unit suffix to APARTMENT
// addresses ("Rindögatan 28, 3 tr", "Hägerstensvägen 130, vån 3.") that Booli
// omits, so exact street equality fails. Take the part before the first comma →
// street + house-number (incl letter, e.g. "27A"). This matches the BUILDING;
// the unit is then disambiguated by fee/area/price (Phase 14 model).
function normAddr(s) {
  if (s == null) return null;
  // Take the part before the first comma / slash / " och " (Hemnet floor suffix,
  // dual-corner addresses "X 10 / Y 6", and "58 och 58A").
  let t = String(s).split(',')[0].split('/')[0].split(/\s+och\s+/i)[0];
  t = normStreet(t);
  if (t == null) return null;
  // Merge a space between house number and a single trailing unit letter:
  // "norrskensvägen 1 c" -> "norrskensvägen 1c", "vasavägen 21 e" -> "21e".
  t = t.replace(/(\d+)\s+([a-zåäö])(?=\s|$)/g, '$1$2');
  return t;
}

// Build a narrowed Hemnet /salda search URL for one Booli seed record.
function buildHemnetSoldUrl(booli, seg, opts = {}) {
  const p = new URLSearchParams();
  p.append('location_ids[]', String(seg.hemnet.locationId));
  const band = opts.priceBand != null ? opts.priceBand : PRICE_BAND;
  if (booli.sold_price != null && Number.isFinite(Number(booli.sold_price))) {
    const v = Number(booli.sold_price);
    p.append('price_min', String(Math.floor(v * (1 - band))));
    p.append('price_max', String(Math.ceil(v * (1 + band))));
  }
  if (!opts.dropRooms && booli.rooms != null && Number.isFinite(Number(booli.rooms))) {
    const r = Math.round(Number(booli.rooms));
    p.append('rooms_min', String(r));
    p.append('rooms_max', String(r));
  }
  // Living-area band keeps the sold result set under Hemnet's 50-card page cap
  // (e.g. 2453 → 24 for a Stockholm 3-room flat) so a real match can't be missed
  // off page 1. Living area is near-invariant for a unit.
  if (!opts.dropArea && booli.living_area != null && Number.isFinite(Number(booli.living_area))) {
    const areaBand = opts.areaBand != null ? opts.areaBand : 0.07;
    const a = Number(booli.living_area);
    p.append('living_area_min', String(Math.floor(a * (1 - areaBand))));
    p.append('living_area_max', String(Math.ceil(a * (1 + areaBand))));
  }
  const itemType = seg.family === 'APARTMENT' ? (seg.hemnet.itemType || 'bostadsratt') : booliObjectTypeToHemnet(booli.object_type);
  if (!opts.dropItemType && itemType) p.append('item_types[]', itemType);
  return `https://www.hemnet.se/salda?${p.toString()}`;
}

// Within-run search cache (URL -> SaleCard[]). Mirrors the cohort job dedup.
const searchCache = new Map();
const searchInFlight = new Map();
async function searchSold(url) {
  if (searchCache.has(url)) return searchCache.get(url);
  if (searchInFlight.has(url)) return searchInFlight.get(url);
  const promise = (async () => {
    try {
      const res = await cachedFetch(url, { logger: () => {} });
      if (res.status !== 200) { searchCache.set(url, []); return []; }
      const { apollo } = extractApollo(res.html);
      const cards = parseHemnetSaleCards(apollo);
      searchCache.set(url, cards);
      return cards;
    } finally { searchInFlight.delete(url); }
  })();
  searchInFlight.set(url, promise);
  return promise;
}

// Paginate a narrowed /salda search (NEWEST sort) until the Booli address is
// found, a non-full page appears (feed exhausted within filters), or we have
// paged past the sold-date window (older than the match could possibly be).
// Returns { cards, pages, complete } — complete=false only if maxPages ran out
// while pages were still full AND we had not yet passed the window (rare for the
// recent seed; flagged so it never reads as a confident Booli-only).
async function searchSoldPaged(booli, seg, windowDays, maxPages, opts = {}) {
  const baseUrl = buildHemnetSoldUrl(booli, seg, opts);
  const bUnix = booliSoldUnix(booli.sold_date);
  const bAddr = normAddr(booli.street_address);
  const all = [];
  let complete = false;
  let page = 1;
  for (; page <= maxPages; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
    const cards = await searchSold(url);
    if (cards.length === 0) { complete = true; break; }
    all.push(...cards);
    if (cards.some((c) => normAddr(c.street_address) === bAddr)) { complete = true; break; }
    if (cards.length < 50) { complete = true; break; } // last page within filters
    const oldest = Math.min(...cards.map((c) => (c.sold_at != null ? c.sold_at : Infinity)));
    if (bUnix != null && oldest < bUnix - windowDays * DAY) { complete = true; break; } // paged past window
  }
  return { cards: all, pages: page, complete };
}

// Address + sold-date-window candidate filter.
function addrCandidates(booli, cards, windowDays) {
  const bStreet = normAddr(booli.street_address);
  const bUnix = booliSoldUnix(booli.sold_date);
  return cards.filter((c) => {
    if (!c.street_address || normAddr(c.street_address) !== bStreet) return false;
    if (bUnix != null && c.sold_at != null && Math.abs(c.sold_at - bUnix) > windowDays * DAY) return false;
    return true;
  });
}

function deltasFor(booli, card) {
  return computeDeltas(
    { price: booli.sold_price, living_area: booli.living_area, object_type: booli.object_type, street_address: booli.street_address, postcode: null },
    { asking_price: card.final_price, living_area: card.living_area, housing_form: card.housing_form, street_address: card.street_address, post_code: null },
  );
}

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

function cardBrief(c) {
  return c ? { card_id: c.card_id, listing_id: c.listing_id, slug: c.slug, detail_url: c.detail_url, street_address: c.street_address, final_price: c.final_price, living_area: c.living_area, rooms: c.rooms, fee: c.fee, sold_at: c.sold_at, broker_name: c.broker_name, broker_agency: c.broker_agency } : null;
}

// Core per-record matcher. Returns a result record (does not write).
async function matchOne(booli, seg) {
  // Houses are uniquely keyed by street address, so the search can be LOOSE
  // (Täby density is low → no 50-cap risk): wider price/area, no rooms/item_type
  // — this avoids missing matches on Booli↔Hemnet rooms/subtype quirks. Apartments
  // stay TIGHT (dense buildings need rooms+area+item_type to stay under the cap).
  const searchOpts = seg.family === 'HOUSE'
    ? { priceBand: 0.10, areaBand: 0.15, dropRooms: true, dropItemType: true }
    : {};
  const url = buildHemnetSoldUrl(booli, seg, searchOpts);
  let cards, complete, pages;
  try { ({ cards, complete, pages } = await searchSoldPaged(booli, seg, SOLD_DATE_WINDOW_DAYS, MAX_SEARCH_PAGES, searchOpts)); }
  catch (e) { if (e instanceof CeilingError) throw e; return { booli_id: booli.booli_id, segment: booli.segment, verdict: 'ERROR', source: 'search-failed', reason: e.message, search_url: url }; }

  const cardsSeen = cards.length;
  const capHit = !complete; // pagination ran out while still full + within window → incomplete
  const cands = addrCandidates(booli, cards, SOLD_DATE_WINDOW_DAYS);

  const base = {
    booli_id: booli.booli_id, segment: booli.segment, family: seg.family,
    booli: { street_address: booli.street_address, object_type: booli.object_type, sold_price: booli.sold_price, sold_date: booli.sold_date, living_area: booli.living_area, rooms: booli.rooms, floor: booli.floor, sold_price_type: booli.sold_price_type, residence_url: booli.residence_url, municipality: booli.municipality },
    search_url: url, cards_seen: cardsSeen, search_pages: pages, incomplete: capHit, addr_candidates: cands.length,
  };

  if (cands.length === 0) {
    return { ...base, verdict: 'BOOLI_ONLY', source: 'no-address-candidate', reason: `0 address matches among ${cardsSeen} narrowed cards${capHit ? ' (INCOMPLETE — pagination exhausted)' : ''}` };
  }

  const chosen = pickBest(booli, cands);
  const deltas = deltasFor(booli, chosen);

  if (seg.family === 'HOUSE') {
    // Address is a (near-)unique key for houses → address + area + price confirms.
    const record = { deltas, photos: { hemnet_gallery: [], booli_gallery: [] }, hemnet_unit: {}, booli_unit: {} };
    const areaOk = deltas.area_pct_diff != null && deltas.area_pct_diff <= AREA_AGREE_PCT;
    const priceOk = deltas.price_pct_diff != null && deltas.price_pct_diff <= PRICE_AGREE_PCT;
    if (cands.length === 1 && areaOk && priceOk) {
      return { ...base, verdict: 'CONFIRMED_MATCH', source: 'house-address+area+price', reason: `unique address; area Δ${(deltas.area_pct_diff*100).toFixed(1)}% price Δ${(deltas.price_pct_diff*100).toFixed(1)}%`, deltas, hemnet: cardBrief(chosen), multi_candidate: false };
    }
    // Divergence or multiple address matches → let the Phase 14 model speak.
    const adj = adjudicatePair(record);
    return { ...base, verdict: adj.verdict === 'CONFIRMED_MATCH' ? 'UNCERTAIN' : adj.verdict, source: adj.source, reason: adj.reason + (cands.length > 1 ? ` (+${cands.length} address matches)` : ''), deltas, hemnet: cardBrief(chosen), multi_candidate: cands.length > 1 };
  }

  // APARTMENT: need a unit-level signal (fee-exact). Escalate to Booli detail.
  let detail = null;
  if (booli.residence_url) {
    try {
      const r = await cachedFetch('https://www.booli.se' + booli.residence_url, { logger: () => {} });
      if (r.status === 200) { const { apollo } = extractApollo(r.html); detail = parseBooliSoldDetail(apollo); }
    } catch (e) { if (e instanceof CeilingError) throw e; /* detail optional */ }
  }
  const booliRent = detail ? detail.rent : null;

  // Prefer a fee-exact candidate when the Booli fee is known.
  let feeChosen = chosen;
  if (booliRent != null) {
    const feeMatch = cands.find((c) => c.fee != null && Math.abs(c.fee - booliRent) === 0);
    if (feeMatch) feeChosen = feeMatch;
  }
  const aptDeltas = deltasFor(booli, feeChosen);
  const record = {
    deltas: aptDeltas,
    photos: { hemnet_gallery: [], booli_gallery: [] }, // no photos available for sold
    hemnet_unit: { fee: feeChosen.fee != null ? feeChosen.fee : null },
    booli_unit: { rent: booliRent, floor: booli.floor != null ? booli.floor : null },
  };
  const adj = adjudicatePair(record);
  return {
    ...base, verdict: adj.verdict, source: adj.source, reason: adj.reason,
    deltas: aptDeltas, hemnet: cardBrief(feeChosen),
    multi_candidate: cands.length > 1,
    fee: { booli_rent: booliRent, hemnet_fee: feeChosen.fee, exact: booliRent != null && feeChosen.fee != null && booliRent === feeChosen.fee, delta: (booliRent != null && feeChosen.fee != null) ? feeChosen.fee - booliRent : null },
    broker: detail ? { agent_id: detail.agent_id, agency_id: detail.agency_id } : null,
  };
}

// Stage 3: fuzzy recall on a Booli-only record. Loosen price band (±20%), drop
// rooms + item_type. If a same-street sold card surfaces in a wider date window,
// it's a MATCH-MISS (recall gap); else GENUINE-BYPASS.
async function recallOne(booli, seg) {
  // Maximally loose net (always looser than BOTH primary variants) so it truly
  // stress-tests a Booli-only: wide price (±30%) + area (±25%), drop rooms +
  // item_type, wide date window, paginated. A same-building hit here = match-miss
  // (our narrowing missed it); nothing here = genuine Hemnet-absence.
  const opts = { priceBand: 0.30, areaBand: 0.25, dropRooms: true, dropItemType: true };
  const url = buildHemnetSoldUrl(booli, seg, opts);
  let cards;
  try { ({ cards } = await searchSoldPaged(booli, seg, 45, Math.max(6, MAX_SEARCH_PAGES), opts)); }
  catch (e) { if (e instanceof CeilingError) throw e; return { recall: 'error', reason: e.message }; }
  const cands = addrCandidates(booli, cards, 45);
  if (cands.length > 0) {
    const best = pickBest(booli, cands);
    const d = deltasFor(booli, best);
    return { recall: 'match-miss', recall_url: url, recall_cards_seen: cards.length, recall_candidates: cands.length, hemnet: cardBrief(best), recall_deltas: d };
  }
  return { recall: 'genuine-bypass', recall_url: url, recall_cards_seen: cards.length, recall_candidates: 0 };
}

async function runSegment(segKey, seg, limit, conc) {
  const seedFile = path.join(ROOT, 'seed', `${segKey}.jsonl`);
  const resultsFile = path.join(MATCH_DIR, `${segKey}.results.jsonl`);
  const seed = readJsonl(seedFile);
  const done = new Set(readJsonl(resultsFile).map((r) => String(r.booli_id)));

  // Title transfers are excluded from matching (recorded separately for accounting).
  let queue = seed.filter((r) => !r.is_title_transfer && !done.has(String(r.booli_id)));
  if (limit != null) queue = queue.slice(0, limit);
  log('INFO', `segment=${segKey} seed=${seed.length} title-transfers=${seed.filter((r) => r.is_title_transfer).length} to-process=${queue.length} (resume skipped ${done.size})`);

  let stopped = null;
  let idx = 0;
  async function worker(wid) {
    while (idx < queue.length) {
      if (stopped) return;
      if (remainingCalls() <= 40) { stopped = 'ceiling-floor'; log('WARN', `approaching ceiling (${remainingCalls()} left) — draining`); return; }
      const booli = queue[idx++];
      try {
        await sleep(jitter());
        let result = await matchOne(booli, seg);
        if (result.verdict === 'BOOLI_ONLY') {
          const rec = await recallOne(booli, seg);
          result = { ...result, ...rec };
        }
        appendJsonl(resultsFile, { ...result, at: new Date().toISOString() });
        if ((idx) % 25 === 0) log('INFO', `${segKey} ${idx}/${queue.length} processed (spent~${procStats().spent})`);
      } catch (e) {
        if (e instanceof CeilingError) { stopped = 'ceiling'; log('WARN', `CEILING hit: ${e.message}`); return; }
        appendJsonl(resultsFile, { booli_id: booli.booli_id, segment: segKey, verdict: 'ERROR', reason: String(e && e.message), at: new Date().toISOString() });
        log('ERROR', `booli_id=${booli.booli_id}: ${e && e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, conc) }, (_, i) => worker(i)));

  // Tally.
  const results = readJsonl(resultsFile);
  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  const recallTally = {};
  for (const r of results) if (r.recall) recallTally[r.recall] = (recallTally[r.recall] || 0) + 1;
  const summary = { segment: segKey, family: seg.family, seed: seed.length, processed: results.length, stoppedBy: stopped, verdicts: tally, recall: recallTally };
  log('INFO', `DONE ${segKey}: ${JSON.stringify(summary)}`);
  return summary;
}

async function main() {
  const { segment, limit, conc } = parseArgs(process.argv.slice(2));
  const segKeys = segment ? [segment] : Object.keys(SEGMENTS);
  const summaries = [];
  for (const k of segKeys) {
    const seg = SEGMENTS[k];
    if (!seg) { log('ERROR', `unknown segment ${k}`); continue; }
    summaries.push(await runSegment(k, seg, limit, conc));
  }
  writeJson(path.join(MATCH_DIR, '_summary.json'), { at: new Date().toISOString(), procStats: procStats(), segments: summaries });
  log('INFO', `procStats: ${JSON.stringify(procStats())}`);
  try { log('INFO', `transport-assert: ${JSON.stringify(assertOxyUsed())}`); }
  catch (e) { log('ERROR', `transport-assert FAILED: ${e.message}`); process.exitCode = 2; }
}

module.exports = { buildHemnetSoldUrl, addrCandidates, deltasFor, matchOne, recallOne };

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}
