'use strict';

// spike-booli-sold.js — Stage 1. Scrape Booli SOLD transactions per segment and
// STORE them as a durable seed (verf-soldspike/seed/<segment>.jsonl). Title
// transfers (soldPriceType ∉ {Slutpris, Sista bud}) are flagged but retained.
// Idempotent + resumable: re-runs skip booli_ids already in the seed and replay
// cached pages for free.
//
//   node scripts/spike-booli-sold.js [--segment stockholm-apt|taby-villa] [--target 300] [--max-pages 40]

process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

const path = require('path');
const {
  cachedFetch, extractApollo, ROOT, ensureDir,
  appendJsonl, readJsonl, writeJson, assertOxyUsed, procStats, CeilingError, stdoutLogger,
} = require('./spike-common');
const { SEGMENTS, DEFAULT_TARGET_PER_SEGMENT, READ_TIME_EXCLUDE_DAYS, daysAgoISO } = require('./spike-config');
const { parseBooliSoldCards, booliSoldMeta } = require('./spike-sold-parse');

const log = stdoutLogger('booli-sold');
const SEED_DIR = ensureDir(path.join(ROOT, 'seed'));
// Seed the window ENDING 90 days ago (ratio-eligible + Hemnet-posted).
const MAX_SOLD_DATE = daysAgoISO(READ_TIME_EXCLUDE_DAYS);

function parseArgs(argv) {
  const o = { segment: null, target: DEFAULT_TARGET_PER_SEGMENT, maxPages: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--segment') o.segment = argv[++i];
    else if (a.startsWith('--segment=')) o.segment = a.split('=')[1];
    else if (a === '--target') o.target = parseInt(argv[++i], 10);
    else if (a.startsWith('--target=')) o.target = parseInt(a.split('=')[1], 10);
    else if (a === '--max-pages') o.maxPages = parseInt(argv[++i], 10);
    else if (a.startsWith('--max-pages=')) o.maxPages = parseInt(a.split('=')[1], 10);
  }
  return o;
}

async function scrapeSegment(segKey, seg, target, maxPages) {
  const seedFile = path.join(SEED_DIR, `${segKey}.jsonl`);
  const existing = readJsonl(seedFile);
  const seen = new Set(existing.map((r) => String(r.booli_id)));
  let collected = existing.length;
  log('INFO', `segment=${segKey} (${seg.label}) target=${target} resume-from=${collected} seen`);

  const { areaIds, objectType } = seg.booli;
  let page = 1;
  let totalCount = null;
  let pagesAvail = null;
  let stop = null;

  while (collected < target && page <= maxPages) {
    const url = `https://www.booli.se/slutpriser?areaIds=${areaIds}&objectType=${encodeURIComponent(objectType)}&maxSoldDate=${MAX_SOLD_DATE}&page=${page}`;
    let res;
    try {
      res = await cachedFetch(url, { logger: log });
    } catch (e) {
      if (e instanceof CeilingError) { stop = 'ceiling'; log('WARN', e.message); break; }
      log('ERROR', `page ${page} fetch failed: ${e.message}`); page++; continue;
    }
    if (res.status !== 200) { log('WARN', `page ${page} status ${res.status} — stopping`); stop = `status-${res.status}`; break; }

    let apollo;
    try { ({ apollo } = extractApollo(res.html)); }
    catch (e) { log('ERROR', `page ${page} apollo parse failed: ${e.message}`); page++; continue; }

    const meta = booliSoldMeta(apollo);
    if (meta.totalCount != null) totalCount = meta.totalCount;
    if (meta.pages != null) pagesAvail = meta.pages;

    const cards = parseBooliSoldCards(apollo);
    if (cards.length === 0) { log('INFO', `page ${page} returned 0 cards — end of feed`); stop = 'empty-page'; break; }

    let added = 0;
    for (const c of cards) {
      const id = String(c.booli_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      appendJsonl(seedFile, { ...c, segment: segKey, family: seg.family, scraped_at: new Date().toISOString() });
      collected++; added++;
      if (collected >= target) break;
    }
    log('INFO', `page ${page}: ${cards.length} cards, +${added} new (total ${collected}/${target})`);
    page++;
  }

  const all = readJsonl(seedFile);
  const titleTransfers = all.filter((r) => r.is_title_transfer);
  const byType = {};
  for (const r of all) byType[r.object_type] = (byType[r.object_type] || 0) + 1;
  const bySoldType = {};
  for (const r of all) bySoldType[r.sold_price_type] = (bySoldType[r.sold_price_type] || 0) + 1;

  const summary = {
    segment: segKey, label: seg.label, seedFile: path.relative(ROOT, seedFile),
    maxSoldDate: MAX_SOLD_DATE,
    feedTotalCount: totalCount, feedPages: pagesAvail,
    collected: all.length, target, pagesWalked: page - 1, stoppedBy: stop,
    titleTransfers: titleTransfers.length,
    matchSeed: all.length - titleTransfers.length,
    byObjectType: byType, bySoldPriceType: bySoldType,
  };
  log('INFO', `DONE ${segKey}: ${JSON.stringify(summary)}`);
  return summary;
}

async function main() {
  const { segment, target, maxPages } = parseArgs(process.argv.slice(2));
  const segKeys = segment ? [segment] : Object.keys(SEGMENTS);
  const summaries = [];
  for (const k of segKeys) {
    const seg = SEGMENTS[k];
    if (!seg) { log('ERROR', `unknown segment ${k}`); continue; }
    summaries.push(await scrapeSegment(k, seg, target, maxPages));
  }
  writeJson(path.join(SEED_DIR, '_summary.json'), { at: new Date().toISOString(), procStats: procStats(), segments: summaries });
  log('INFO', `procStats: ${JSON.stringify(procStats())}`);
  try { log('INFO', `transport-assert: ${JSON.stringify(assertOxyUsed())}`); }
  catch (e) { log('ERROR', `transport-assert FAILED: ${e.message}`); process.exitCode = 2; }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
