'use strict';
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/hemnet-ad-daily.js — the daily walk of Hemnet's NEWEST ads into the ad registry
// (lib/ad-registry.js). Companion to the weekly full sweep (scripts/hemnet-ad-sweep.js).
//
// Hemnet's /till-salu list (for sale + coming soon together, all of Sweden) is ordered by
// publish DAY, then package (Max first), then time; sort= is ignored. So everything published
// since the last walk sits at the front, and we read pages until a whole page is older than
// the cutoff. Buying a package resets an ad's publishedAt (seen 2026-11-03: old ids such as
// 21385348 at the top as MAX ads published that day), so an aggregated or free ad that is
// upgraded to paid comes back to the top and is caught here the next morning.
//
// NOT caught here: aggregated ads carry the agency's own publish date (one seen 2026-11-03
// said May 2026), so a newly aggregated ad sorts deep in the list. The weekly sweep finds
// those. The daily walk is about paid and free ads, and upgrades.
//
// Pagination stops at 50 pages (2,500 ads). If the window does not fit, we walk for sale and
// coming soon separately (each gets its own 50 pages) and say so in the run's notes.
//
// Cron: daily 05:30 UTC (lib/job-registry.js 'hemnet-ad-daily'). Cost: ~25-30 Oxylabs calls a
// day (dry run 2026-11-03: 2,209 ads published over ~2.2 days = 46 pages).
//
//   node scripts/hemnet-ad-daily.js --smoke     # offline self-test (no DB, no network)
//   node scripts/hemnet-ad-daily.js --dry-run   # live walk, prints counts, writes nothing
//   node scripts/hemnet-ad-daily.js             # live walk into the registry

const MAX_PAGES = 50;
const MAX_LOOKBACK_DAYS = 7;       // past this the weekly sweep is the backstop
const MAX_CONSECUTIVE_ERRORS = 3;

const DAY_MS = 86400000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// Cutoff day: the start of yesterday, or of the last good walk's day if that is further
// back (a missed morning is caught up next time), never more than 7 days back. The walk
// stops CUTOFF_MARGIN_S before that midnight (UTC), because Hemnet's day is Swedish time.
// Measured 2026-11-03: ~1,000 new or renewed ads a day, so a day and a bit is ~25-30 pages.
const CUTOFF_MARGIN_S = 2 * 3600;
function cutoffDay(today, lastGoodRunDate) {
  const t = Date.parse(`${today}T00:00:00Z`);
  let c = t - DAY_MS;
  if (lastGoodRunDate) c = Math.min(c, Date.parse(`${lastGoodRunDate}T00:00:00Z`));
  c = Math.max(c, t - MAX_LOOKBACK_DAYS * DAY_MS);
  return isoDay(c);
}

function pageUrl(page, upcoming) {
  const p = new URLSearchParams();
  if (upcoming) p.append('upcoming', upcoming);
  p.append('page', String(page));
  return `https://www.hemnet.se/till-salu?${p.toString()}`;
}

// Did Hemnet apply what we asked for: no location filter, and the upcoming filter (or none)?
function searchMismatch(search, upcoming) {
  if (!search) return 'no search args on the page';
  if (Array.isArray(search.locationIds) && search.locationIds.length) return `locationIds applied as ${JSON.stringify(search.locationIds)}`;
  const got = search.upcoming == null ? null : search.upcoming;
  if (got !== (upcoming || null)) return `upcoming applied as ${JSON.stringify(got)}, wanted ${JSON.stringify(upcoming || null)}`;
  return null;
}

// Walk one list newest-first until a whole page is older than cutoffSec. PURE apart from
// the injected fetchPage(page, upcoming) -> { status, cards|null, total, search }.
async function walkNewest({ upcoming = null, cutoffSec, fetchPage, logger = () => {} }) {
  const out = { upcoming, cards: [], pages: 0, errorPages: 0, reachedCutoff: false, total: null, aborted: false };
  let consecutive = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    let r;
    try { r = await fetchPage(p, upcoming); } catch (e) { r = { status: `threw: ${e.message}`, cards: null }; }
    out.pages = p;
    if (r.cards == null) {
      out.errorPages++;
      logger('WARN', `${upcoming || 'all'} p${p}: ${r.status} — gap, continuing`);
      if (++consecutive >= MAX_CONSECUTIVE_ERRORS) { out.aborted = true; break; }
      continue;
    }
    consecutive = 0;
    if (p === 1 || out.total == null) out.total = r.total == null ? out.total : r.total;
    if (r.cards.length === 0) { out.reachedCutoff = true; break; }
    out.cards.push(...r.cards);
    const newest = Math.max(...r.cards.map(c => (Number.isFinite(c.publishedAt) ? c.publishedAt : -Infinity)));
    if (newest < cutoffSec) { out.reachedCutoff = true; break; }
  }
  return out;
}

// The whole morning: the combined list first; if it does not reach the cutoff inside 50
// pages, for sale and coming soon separately. PURE apart from fetchPage.
async function walkDay({ cutoffSec, fetchPage, logger = () => {} }) {
  const walks = [await walkNewest({ upcoming: null, cutoffSec, fetchPage, logger })];
  if (!walks[0].reachedCutoff && !walks[0].aborted) {
    logger('WARN', `combined list did not reach the cutoff in ${MAX_PAGES} pages — walking for sale and coming soon separately`);
    walks.push(await walkNewest({ upcoming: 'EXCLUDE', cutoffSec, fetchPage, logger }));
    walks.push(await walkNewest({ upcoming: 'ONLY', cutoffSec, fetchPage, logger }));
  }
  const split = walks.length > 1;
  const used = split ? walks.slice(1) : walks;
  const notes = [];
  const short = used.filter(w => !w.reachedCutoff);
  if (short.length) notes.push(`did not reach the cutoff: ${short.map(w => `${w.upcoming || 'all'}${w.aborted ? ' (aborted after repeated errors)' : ' (50-page limit)'}`).join(', ')} — the weekly sweep picks up the rest`);
  if (split) notes.push('combined list over 50 pages; walked for sale and coming soon separately');
  return {
    cards: walks.flatMap(w => w.cards),
    pages: walks.reduce((a, w) => a + w.pages, 0),
    errorPages: walks.reduce((a, w) => a + w.errorPages, 0),
    complete: short.length === 0,
    aborted: used.some(w => w.aborted),
    notes,
  };
}

async function realFetchPage(page, upcoming) {
  const { getWithRetry, extractApolloState } = require('../lib/scrape-http');
  const { parseSearchPage } = require('../lib/hemnet-fetch');
  const res = await getWithRetry(pageUrl(page, upcoming), { logger: () => {} });
  if (res.status !== 200) return { status: res.status, cards: null };
  const pg = parseSearchPage(extractApolloState(res.html, 'hemnet-ad-daily'));
  if (!pg) return { status: 'no-result-list', cards: null };
  const bad = searchMismatch(pg.search, upcoming);
  if (bad) return { status: `filter-not-applied (${bad})`, cards: null };
  return { status: 200, cards: pg.cards, total: pg.total, search: pg.search };
}

async function main(client, logger = (l, m) => console.log(`  [${l}] ${m}`), { dryRun = false } = {}) {
  const { resetOxylabsStats, getOxylabsStats } = require('../lib/scrape-http');
  const registry = require('../lib/ad-registry');
  const startedAt = new Date();
  const today = isoDay(startedAt);
  let lastGood = null;
  if (client) {
    const r = await client.query(
      `SELECT to_char(max(run_date), 'YYYY-MM-DD') AS d FROM hemnet_ad_sweep_run
        WHERE status IN ('ok', 'warning') AND run_date < $1::date`, [today]);
    lastGood = r.rows[0] && r.rows[0].d;
  }
  const cut = cutoffDay(today, lastGood);
  const cutoffSec = Date.parse(`${cut}T00:00:00Z`) / 1000 - CUTOFF_MARGIN_S;
  logger('INFO', `walking newest ads back to ${cut} (last good walk: ${lastGood || 'none'})`);

  resetOxylabsStats();
  const day = await walkDay({ cutoffSec, fetchPage: realFetchPage, logger });
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;

  const fresh = day.cards.filter(c => Number.isFinite(c.publishedAt) && c.publishedAt >= cutoffSec);
  const summary = {
    runDate: today, cutoff: cut, pages: day.pages, errorPages: day.errorPages, oxCalls,
    cardsSeen: day.cards.length, publishedSinceCutoff: fresh.length, complete: day.complete,
    aborted: day.aborted, notes: day.notes,
  };
  if (dryRun || !client) {
    const byPkg = {};
    for (const c of fresh) byPkg[c.activePackage || 'NONE'] = (byPkg[c.activePackage || 'NONE'] || 0) + 1;
    summary.publishedSinceCutoffByPackage = byPkg;
    summary.dryRun = true;
    return summary;
  }

  const applied = await registry.applyCards(client, day.cards, { seenOn: today, source: 'daily' });
  const status = day.cards.length === 0 || day.aborted ? 'failed' : (day.complete ? 'ok' : 'warning');
  const distinctRows = [...new Map(day.cards.map(c => [String(c.id), registry.shapeCard(c, today)])).values()];
  await registry.recordRun(client, {
    kind: 'daily', runDate: today, status, cardsSeen: applied.cards, distinct: applied.distinct,
    newAds: applied.newAds, changed: applied.changed, upgrades: applied.upgrades, pages: day.pages,
    oxCalls, counts: registry.tierCounts(distinctRows),
    notes: [`cutoff ${cut}`, ...day.notes].join('; '), startedAt,
  });
  return { ...summary, status, newAds: applied.newAds, changed: applied.changed, upgrades: applied.upgrades, distinct: applied.distinct };
}

function validate(s) {
  if (!s) return 'no summary returned';
  if (s.cardsSeen === 0) return { severity: 'failure', message: 'no ads read from Hemnet — the walk is broken' };
  if (s.aborted) return { severity: 'failure', message: `walk aborted after repeated page errors (${s.errorPages} error pages)` };
  if (!s.complete) return `walk incomplete: ${s.notes.join('; ')}`;
  if (s.errorPages > 0) return `${s.errorPages} page(s) failed and were skipped`;
  return null;
}

module.exports = { cutoffDay, pageUrl, searchMismatch, walkNewest, walkDay, validate, main };

const ACCEPTED_ARGV = new Set(['--smoke', '--dry-run']);
const USAGE = 'Usage: node scripts/hemnet-ad-daily.js [--smoke | --dry-run]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  } else if (argv.includes('--smoke')) {
    smoke();
  } else if (argv.includes('--dry-run')) {
    main(null, undefined, { dryRun: true })
      .then(s => console.log(JSON.stringify(s, null, 2)))
      .catch(e => { console.error(e); process.exit(1); });
  } else {
    const { runJob } = require('../cron-wrapper');
    runJob({ scriptName: 'hemnet-ad-daily', main: (client, log) => main(client, log), validate });
  }
}

async function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  const T = (day, h = 12) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`) / 1000;
  const cutoffSec = T('2026-11-02', 0);
  // A synthetic list: `n` ads per day, newest day first, 50 per page.
  const listOf = (days) => days.flatMap(([day, n]) => Array.from({ length: n }, (_, i) => ({ id: `${day}-${i}`, publishedAt: T(day, 12) - i })));
  const fetcherFor = (list, { failPages = [] } = {}) => async (page) => {
    if (failPages.includes(page)) return { status: 503, cards: null };
    return { status: 200, cards: list.slice((page - 1) * 50, page * 50), total: list.length };
  };

  await check('cutoffDay: yesterday, back to the last good walk day after a miss, never past 7 days', () => {
    assert.strictEqual(cutoffDay('2026-11-05', '2026-11-04'), '2026-11-04');
    assert.strictEqual(cutoffDay('2026-11-05', '2026-11-01'), '2026-11-01');
    assert.strictEqual(cutoffDay('2026-11-05', '2026-10-01'), '2026-10-29');
    assert.strictEqual(cutoffDay('2026-11-05', null), '2026-11-04');
  });
  await check('pageUrl and searchMismatch', () => {
    assert.strictEqual(pageUrl(3), 'https://www.hemnet.se/till-salu?page=3');
    assert.strictEqual(pageUrl(1, 'ONLY'), 'https://www.hemnet.se/till-salu?upcoming=ONLY&page=1');
    assert.strictEqual(searchMismatch({ upcoming: null }, null), null);
    assert.strictEqual(searchMismatch({ upcoming: 'ONLY' }, 'ONLY'), null);
    assert.match(searchMismatch({ upcoming: 'EXCLUDE' }, null), /upcoming/);
    assert.match(searchMismatch({ upcoming: null, locationIds: ['17744'] }, null), /locationIds/);
  });
  await check('walkNewest stops on the first page wholly older than the cutoff', async () => {
    const list = listOf([['2026-11-03', 120], ['2026-11-02', 100], ['2026-11-01', 400]]);
    const w = await walkNewest({ cutoffSec, fetchPage: fetcherFor(list) });
    assert.ok(w.reachedCutoff);
    assert.strictEqual(w.pages, 6, '220 fresh ads = pages 1-5 (page 5 mixed), page 6 wholly older');
    assert.ok(w.cards.filter(c => c.publishedAt >= cutoffSec).length === 220, 'every fresh ad read');
  });
  await check('walkNewest: an empty page is the end of the list', async () => {
    const w = await walkNewest({ cutoffSec, fetchPage: fetcherFor(listOf([['2026-11-03', 30]])) });
    assert.ok(w.reachedCutoff);
    assert.strictEqual(w.cards.length, 30);
  });
  await check('walkNewest: a failed page is a gap, three in a row abort', async () => {
    const list = listOf([['2026-11-03', 200], ['2026-11-01', 100]]);
    const w = await walkNewest({ cutoffSec, fetchPage: fetcherFor(list, { failPages: [2] }) });
    assert.strictEqual(w.errorPages, 1);
    assert.ok(w.reachedCutoff);
    const w2 = await walkNewest({ cutoffSec, fetchPage: fetcherFor(list, { failPages: [1, 2, 3] }) });
    assert.ok(w2.aborted && !w2.reachedCutoff);
  });
  await check('walkDay: over 50 pages falls back to two separate walks', async () => {
    const big = listOf([['2026-11-03', 2600], ['2026-11-01', 100]]);
    const half = listOf([['2026-11-03', 1300], ['2026-11-01', 100]]);
    const seen = [];
    const fetchPage = async (page, upcoming) => { seen.push(upcoming || 'all'); return fetcherFor(upcoming ? half : big)(page); };
    const d = await walkDay({ cutoffSec, fetchPage });
    assert.ok(seen.includes('EXCLUDE') && seen.includes('ONLY'));
    assert.ok(d.complete, 'each half fits inside 50 pages');
    assert.match(d.notes.join(' '), /separately/);
  });
  await check('walkDay: still too big after splitting is incomplete, not silent', async () => {
    const huge = listOf([['2026-11-03', 3000], ['2026-11-01', 100]]);
    const d = await walkDay({ cutoffSec, fetchPage: async (p) => fetcherFor(huge)(p) });
    assert.ok(!d.complete);
    assert.match(d.notes.join(' '), /did not reach the cutoff/);
  });
  await check('validate: empty and aborted walks fail, incomplete warns, clean passes', () => {
    assert.strictEqual(validate({ cardsSeen: 0 }).severity, 'failure');
    assert.strictEqual(validate({ cardsSeen: 5, aborted: true, errorPages: 3 }).severity, 'failure');
    assert.match(validate({ cardsSeen: 5, complete: false, notes: ['x'] }), /incomplete/);
    assert.strictEqual(validate({ cardsSeen: 5, complete: true, errorPages: 0, notes: [] }), null);
  });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}
