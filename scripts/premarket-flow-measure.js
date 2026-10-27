'use strict';
// scripts/premarket-flow-measure.js — weekly national pre-market flow & staleness
// measurement (Hemnet vs Booli, second-hand only). Writes premarket_flow_weekly + artifact.
// Runs Mondays via cron (see deploy-instructions.md); wrapped by cron-wrapper.runJob so a
// failure/degradation fires a Slack alert and lands in cron_job_log (the 2026-07-20 run
// died silently on a transient Oxylabs 613 and lost the datapoint — this is the fix).
// Run manually: SCRAPE_FORCE_OXYLABS=1 node scripts/premarket-flow-measure.js
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md
// Offline test: node scripts/premarket-flow-measure.js --selftest
//
// Hemnet side, rebuilt 2026-10-28 (it failed every week from 2026-10-12):
//   - /kommande/bostader now renders a mixed for-sale + pre-market list and
//     searchUpcomingListings is gone. Pages are /till-salu?upcoming=ONLY, read with
//     parseSearchPage (the page's own result list; the old reader also took the
//     "recommendations" Hemnet pads short pages with).
//   - Hemnet orders by day, then package within the day. Since free (MINIMAL, 2026-10-20)
//     and aggregated (~2026-10-27) listings, the 7-day window nationally sits at or past the
//     2,500-result clamp, so the walk is split by property type (7 national walks) and
//     de-duplicated.
//   - Adds and the depth sample count only listing types comparable with history
//     (lib/age-census NEW_LISTING_TYPES excluded). Adds per type go to the artifact.
//   - Stock: Hemnet's own pre-market count includes every type and nothing weekly can
//     remove them, so stock_total = Hemnet's count x the comparable share measured by the
//     latest monthly census (verf-flow-probe/age-census-hemnet-premarket-*.json). With no
//     census on disk the Hemnet side fails loudly rather than store an inflated stock.
//   See docs/handover/CHANGELOG.md, 2026-10-28.
//
// Resilience (2026-07-20 incident, defense-in-depth):
//   L1 retryFetch  — outer per-page retry rides out a transient 613 the transport missed.
//   L2 walkFlow    — skips a page that still fails (counts it), aborts only past maxFailedPages.
//   L3 per-platform isolation + partial persist — one platform failing never discards the other.
//   L4 cron-wrapper — a full failure = [FAILURE] Slack; a degraded run = [WARNING] via validate().
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractApolloState, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseSearchPage } = require('../lib/hemnet-fetch');
const { NEW_LISTING_TYPES } = require('../lib/age-census');
const { parseBooliSearchCards } = require('../lib/booli-fetch');
const { walkFlow, sampleDepth, computeMetrics, retryFetch, validatePremarketRun, countWindowSecondhand, pageEntirelyOld } = require('../lib/premarket-flow');
const { runJob } = require('../cron-wrapper');

// Per-platform tolerance for pages that fail every retry before the walk aborts (L2).
// Hemnet walks ~23 pages, Booli ~65; 5 lets a couple of transient blips slip through as a
// tiny undercount while still catching a genuinely broken feed.
const MAX_FAILED_PAGES = 5;
// Outer per-page retry (L1): total attempts + backoff-before-retry ladder (ms). Longer than
// the transport's single 3s wait so a transient block has time to clear.
const PAGE_RETRY = { attempts: 3, backoffMs: [5000, 15000] };

const NOW_SEC = Math.floor(Date.now() / 1000);
const WINDOW_DAYS = 7;
const MAX_PAGES = 80;
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS premarket_flow_weekly (
    snapshot_date DATE NOT NULL, platform TEXT NOT NULL, window_days INTEGER NOT NULL,
    stock_total INTEGER NOT NULL, stock_secondhand_est INTEGER NOT NULL,
    adds_window_secondhand INTEGER NOT NULL, flow_per_day NUMERIC NOT NULL,
    newbuild_share_window NUMERIC NOT NULL, newbuild_share_pool_est NUMERIC NOT NULL,
    mean_dwell_days NUMERIC, pages_walked INTEGER NOT NULL, oxylabs_calls INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (snapshot_date, platform)
  )`;
const UPSERT = `
  INSERT INTO premarket_flow_weekly
    (snapshot_date, platform, window_days, stock_total, stock_secondhand_est,
     adds_window_secondhand, flow_per_day, newbuild_share_window,
     newbuild_share_pool_est, mean_dwell_days, pages_walked, oxylabs_calls)
  VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (snapshot_date, platform) DO UPDATE SET
    window_days=EXCLUDED.window_days, stock_total=EXCLUDED.stock_total,
    stock_secondhand_est=EXCLUDED.stock_secondhand_est,
    adds_window_secondhand=EXCLUDED.adds_window_secondhand, flow_per_day=EXCLUDED.flow_per_day,
    newbuild_share_window=EXCLUDED.newbuild_share_window,
    newbuild_share_pool_est=EXCLUDED.newbuild_share_pool_est,
    mean_dwell_days=EXCLUDED.mean_dwell_days, pages_walked=EXCLUDED.pages_walked,
    oxylabs_calls=EXCLUDED.oxylabs_calls, created_at=NOW()`;

// Read a ROOT_QUERY total by call-name prefix (mirrors market-totals-daily pickByPrefix).
function pickByPrefix(root, prefix, field) {
  if (!root || typeof root !== 'object') return undefined;
  for (const k of Object.keys(root)) {
    if (k.startsWith(prefix)) { const n = root[k]; if (n && typeof n === 'object') return n[field]; }
  }
  return undefined;
}
function apolloRoot(html, label) {
  return extractApolloState(html, label);
}

// Platform configs: url(page) → fetch; normalize cards to { published, isNewBuild };
// stock read from page-1 apollo via (prefix, field).
const PLATFORMS = {
  booli: {
    url: (p) => `https://www.booli.se/sok/till-salu?upcomingSale=1&page=${p}`,
    parse: (apollo) => parseBooliSearchCards(apollo).cards.map(c => ({ published: c.published, isNewBuild: c.isNewConstruction })),
    stock: (apollo) => pickByPrefix(apollo.ROOT_QUERY, 'searchForSale', 'totalCount'),
    depthPages: [1, 100, 300, 600, 900],
  },
};

async function measurePlatform(name) {
  const cfg = PLATFORMS[name];
  console.log(`\n===== ${name.toUpperCase()} =====`);
  const oxBefore = getOxylabsStats();
  let stockTotal = null;
  // L1: wrap each page fetch in retryFetch so a transient Oxylabs 613 (which the transport's
  // single 3s retry can miss) gets escalating outer retries before the walk gives up on it.
  const fetchPage = (p) => retryFetch(async () => {
    const res = await getWithRetry(cfg.url(p), { logger: () => {} });
    if (res.status !== 200) { log('WARN', `${name} page ${p} status ${res.status}`); return []; }
    const apollo = apolloRoot(res.html, `${name} p${p}`);
    if (p === 1 && stockTotal == null) stockTotal = cfg.stock(apollo);
    return cfg.parse(apollo);
  }, { ...PAGE_RETRY, logger: log });
  const flow = await walkFlow({ fetchPage, nowSec: NOW_SEC, windowDays: WINDOW_DAYS, maxPages: MAX_PAGES, maxFailedPages: MAX_FAILED_PAGES, logger: log });
  console.log(`  flow walk: pages=${flow.pagesWalked} adds2nd=${flow.addsSecondhand} newbuildInWindow=${flow.newbuildInWindow} failedPages=${flow.failedPages}`);
  const depth = await sampleDepth({ fetchPage, pageNumbers: cfg.depthPages, nowSec: NOW_SEC, logger: log });
  for (const d of depth) console.log(`  depth p${d.page}: n=${d.n} newbuild=${(d.newbuildPct * 100).toFixed(0)}% medianAge=${d.medianAgeDays == null ? '-' : d.medianAgeDays.toFixed(0)}d`);
  if (stockTotal == null || typeof stockTotal !== 'number') throw new Error(`${name}: stock total not found on page 1`);
  const metrics = computeMetrics({
    stockTotal, addsSecondhand: flow.addsSecondhand, newbuildInWindow: flow.newbuildInWindow,
    datedInWindow: flow.datedInWindow, depthSample: depth, windowDays: WINDOW_DAYS,
  });
  const oxAfter = getOxylabsStats();
  const oxCalls = (oxAfter.oxylabsCallCount + oxAfter.directSuccessCount) - (oxBefore.oxylabsCallCount + oxBefore.directSuccessCount);
  return { platform: name, ...metrics, pages_walked: flow.pagesWalked, failed_pages: flow.failedPages, oxylabs_calls: oxCalls, depth };
}

// ---- Hemnet (see header) ----
const HEMNET_BASE = 'https://www.hemnet.se/till-salu?upcoming=ONLY';
// item_types tokens; together they cover every listing (verified 2026-10-27, Stockholm).
const HEMNET_TYPES = ['bostadsratt', 'villa', 'radhus', 'fritidshus', 'gard', 'tomt', 'other'];
const HEMNET_DEPTH_PAGES = [1, 15, 30, 40];
const HEMNET_MAX_PAGES = 50;                      // the 2,500-result clamp
const hemnetUrl = (type, p) => `${HEMNET_BASE}${type ? `&item_types[]=${type}` : ''}&page=${p}`;
const comparable = (c) => !NEW_LISTING_TYPES.has(c.activePackage);
const toFlowCard = (c) => ({ published: c.publishedAt, isNewBuild: c.newConstruction });

// Default page getter: one search page, parsed; throws so retryFetch / the walk can count it.
async function getHemnetPage(url) {
  return retryFetch(async () => {
    const res = await getWithRetry(url, { logger: () => {} });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const pg = parseSearchPage(apolloRoot(res.html, 'hemnet'));
    if (!pg) throw new Error('no result list on page');
    if (pg.search.upcoming !== 'ONLY') throw new Error(`upcoming applied as ${pg.search.upcoming}`);
    return pg;
  }, { ...PAGE_RETRY, logger: log });
}

// Latest monthly census share: comparable listings / every listing Hemnet counts.
function loadCensusShare(dir = OUT_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(x => /^age-census-hemnet-premarket-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort(); } catch (_) {}
  for (const f of files.reverse()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.status === 'ok' && j.allTypes && j.allTypes.nAll > 0) {
        return { share: j.nTotal / j.allTypes.nAll, file: f, nTotal: j.nTotal, nAll: j.allTypes.nAll };
      }
    } catch (_) {}
  }
  return null;
}

async function measureHemnet({ getPage = getHemnetPage, nowSec = NOW_SEC, census = loadCensusShare(), logger = log } = {}) {
  console.log('\n===== HEMNET =====');
  if (!census) throw new Error('hemnet: no gate-passed Hemnet pre-market census on disk to give the comparable share of stock — run the monthly age census first');
  const oxBefore = getOxylabsStats();
  const seen = new Set();
  const addsByType = {};
  const typeTotals = {};
  const truncated = [];
  let addsSecondhand = 0, newbuildInWindow = 0, datedInWindow = 0, pagesWalked = 0, failedPages = 0;
  const cutoff = nowSec - WINDOW_DAYS * 86400;

  for (const type of HEMNET_TYPES) {
    for (let p = 1; p <= HEMNET_MAX_PAGES; p++) {
      let pg;
      try { pg = await getPage(hemnetUrl(type, p)); }
      catch (e) {
        failedPages++;
        logger('WARN', `hemnet ${type} p${p} failed (${failedPages}/${MAX_FAILED_PAGES} tolerated): ${e.message}`);
        if (failedPages > MAX_FAILED_PAGES) throw new Error(`hemnet: ${failedPages} page failures exceed ${MAX_FAILED_PAGES}`);
        continue;
      }
      pagesWalked++;
      if (p === 1) typeTotals[type] = pg.total;
      if (!pg.cards.length) break;
      const fresh = pg.cards.filter(c => !seen.has(c.id));
      fresh.forEach(c => seen.add(c.id));
      for (const c of fresh) if (c.publishedAt != null && c.publishedAt >= cutoff) {
        const t = c.activePackage || 'UNKNOWN';
        addsByType[t] = (addsByType[t] || 0) + 1;
      }
      const w = countWindowSecondhand(fresh.filter(comparable).map(toFlowCard), { nowSec, windowDays: WINDOW_DAYS });
      addsSecondhand += w.addsSecondhand; newbuildInWindow += w.newbuildInWindow; datedInWindow += w.datedInWindow;
      // Old-ness is judged on EVERY card: a page of only aggregated listings is not an end.
      if (pageEntirelyOld(pg.cards.map(toFlowCard), { nowSec, windowDays: WINDOW_DAYS })) break;
      if (pg.offset + pg.limit >= pg.total) break;
      if (p === HEMNET_MAX_PAGES) { truncated.push(type); logger('WARN', `hemnet ${type} hit the 2,500 clamp inside the window — adds undercounted`); }
    }
  }

  // National page 1 carries the stock; depth pages give the new-build share (comparable cards).
  const depth = [];
  let stockAll = null;
  for (const page of HEMNET_DEPTH_PAGES) {
    try {
      const pg = await getPage(hemnetUrl(null, page));
      if (page === 1) stockAll = pg.total;
      const cards = pg.cards.filter(comparable).map(toFlowCard);
      if (cards.length) depth.push(...(await sampleDepth({ fetchPage: async () => cards, pageNumbers: [page], nowSec, logger })));
    } catch (e) { logger('WARN', `hemnet depth page ${page} failed, skipping: ${e.message}`); }
  }
  if (typeof stockAll !== 'number') throw new Error('hemnet: stock total not found on page 1');
  const typeSum = Object.values(typeTotals).reduce((a, b) => a + b, 0);
  if (Math.abs(typeSum - stockAll) > 0.01 * stockAll) logger('WARN', `hemnet property types sum to ${typeSum}, national count ${stockAll} — some listings may sit outside every type`);

  const stockTotal = Math.round(stockAll * census.share);
  const metrics = computeMetrics({ stockTotal, addsSecondhand, newbuildInWindow, datedInWindow, depthSample: depth, windowDays: WINDOW_DAYS });
  const oxAfter = getOxylabsStats();
  const oxCalls = (oxAfter.oxylabsCallCount + oxAfter.directSuccessCount) - (oxBefore.oxylabsCallCount + oxBefore.directSuccessCount);
  console.log(`  hemnet: stock all types ${stockAll} x comparable share ${census.share.toFixed(3)} (${census.file}) = ${stockTotal}; adds2nd=${addsSecondhand}; adds by type ${JSON.stringify(addsByType)}`);
  return {
    platform: 'hemnet', ...metrics, pages_walked: pagesWalked, failed_pages: failedPages, oxylabs_calls: oxCalls, depth,
    hemnet_all_types: { stock_all: stockAll, comparable_share: census.share, census_file: census.file, adds_by_type: addsByType, type_totals: typeTotals, truncated },
  };
}

// main(client, log) — invoked by cron-wrapper.runJob. Returns a result summary consumed by
// validatePremarketRun to decide the Slack alert level. `client` is the connected pg client.
async function main(client, log = console.log) {
  resetOxylabsStats();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // L3: measure each platform in isolation — one failing must not abort the other, and
  // whatever succeeds is still persisted. A platform that throws is recorded, not fatal
  // (unless BOTH fail → we throw below → cron-wrapper [FAILURE]).
  const rows = [];
  const failed = [];
  const failedPages = {};
  for (const name of ['hemnet', 'booli']) {
    try {
      const r = name === 'hemnet' ? await measureHemnet() : await measurePlatform(name);
      rows.push(r);
      failedPages[name] = r.failed_pages;
    } catch (e) {
      log('ERROR', `${name} measurement failed — skipping this platform: ${e && e.message}`);
      failed.push(name);
    }
  }
  if (rows.length === 0) {
    throw new Error(`all platforms failed (${failed.join(', ')}) — nothing to persist`);
  }

  // Persist whatever we have (partial row is fine — the report renders "?" per-platform).
  await client.query(CREATE_TABLE);
  const persisted = [];
  for (const r of rows) {
    await client.query(UPSERT, [
      r.platform, WINDOW_DAYS, r.stock_total, r.stock_secondhand_est,
      r.adds_window_secondhand, r.flow_per_day, r.newbuild_share_window,
      r.newbuild_share_pool_est, r.mean_dwell_days, r.pages_walked, r.oxylabs_calls,
    ]);
    persisted.push(r.platform);
    console.log(`upsert ok: platform=${r.platform} adds2nd=${r.adds_window_secondhand} dwell=${r.mean_dwell_days}d failedPages=${r.failed_pages}`);
  }

  // Cross-platform derived share/ratios — only when BOTH platforms are present this run.
  const byPlat = Object.fromEntries(rows.map(r => [r.platform, r]));
  const hemnet = byPlat.hemnet, booli = byPlat.booli;
  const premarketShareHemnet = (hemnet && booli && (hemnet.adds_window_secondhand + booli.adds_window_secondhand) > 0)
    ? hemnet.adds_window_secondhand / (hemnet.adds_window_secondhand + booli.adds_window_secondhand)
    : null;

  // Artifact.
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const payload = { snapshot_date: dateStr, window_days: WINDOW_DAYS, premarket_share_hemnet: premarketShareHemnet, persisted, failed, rows };
  fs.writeFileSync(path.join(OUT_DIR, `premarket-flow-${dateStr}.json`), JSON.stringify(payload, null, 2));
  const ratioLine = (hemnet && booli)
    ? `**Stock ratio (Booli/Hemnet):** ${(booli.stock_secondhand_est / hemnet.stock_secondhand_est).toFixed(2)}× · **Flow ratio (Booli/Hemnet):** ${hemnet.adds_window_secondhand ? (booli.adds_window_secondhand / hemnet.adds_window_secondhand).toFixed(2) : 'n/a'}×`
    : `_Ratios omitted — partial run (persisted: ${persisted.join(', ')}; failed: ${failed.join(', ') || 'none'})._`;
  const md = [
    `# Pre-market flow — ${dateStr} (window ${WINDOW_DAYS}d, second-hand only, national)`, '',
    `| Platform | Stock (2nd-hand est) | Adds/wk (2nd-hand) | Flow/day | Mean dwell | New-build % (pool) |`,
    `|---|---|---|---|---|---|`,
    ...rows.map(r => `| ${r.platform} | ${r.stock_secondhand_est.toLocaleString()} | ${r.adds_window_secondhand} | ${r.flow_per_day} | ${r.mean_dwell_days == null ? 'n/a' : r.mean_dwell_days + 'd'} | ${(r.newbuild_share_pool_est * 100).toFixed(0)}% |`),
    '',
    `**Hemnet pre-market share of fresh 2nd-hand adds:** ${premarketShareHemnet == null ? 'n/a' : (premarketShareHemnet * 100).toFixed(1) + '%'}`,
    ratioLine,
    '', `_Flow is a floor (Kommande→FS conversions within the window uncounted; equal bias both platforms). New-build pool share is a depth-sample estimate._`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, `premarket-flow-${dateStr}.md`), md);

  console.log(`\n${md}`);
  console.log(`\nOxylabs calls total: ${JSON.stringify(getOxylabsStats())}`);
  console.log(`Artifact -> ${OUT_DIR}`);

  // Consumed by validatePremarketRun (cron-wrapper validate) → clean=success, degraded=warning.
  return { persisted, failed, failedPages };
}

// L4: cron-wrapper gives us cron_job_log rows + Slack alerts. A throw from main() (both
// platforms dead) → [FAILURE]; validatePremarketRun flags a partial/degraded run → [WARNING];
// a fully clean run stays silent. The crontab still invokes this file directly (`node
// scripts/premarket-flow-measure.js`), per the runJob-direct-require contract — no cron change.
module.exports = { measureHemnet, loadCensusShare, hemnetUrl };

// Only when run directly: requiring this file (or passing --selftest) must never start the
// paid, DB-writing job. Until 2026-10-28 runJob ran at load, so any `node <file> --flag` was live.
if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest().catch(e => { console.error(e); process.exit(1); });
  else runJob({ scriptName: 'premarket-flow-measure', main, validate: validatePremarketRun });
}

// ---- offline self-test: synthetic pages, no network, no DB ----
async function selftest() {
  const assert = require('assert');
  const NOW = 2000000000, D = 86400;
  // Synthetic national pre-market: per type, cards newest-first by day.
  const mk = (id, ageDays, pkg, nb = false) => ({ id: String(id), publishedAt: NOW - ageDays * D, activePackage: pkg, newConstruction: nb, upcoming: true });
  const byType = {
    bostadsratt: [...Array.from({ length: 120 }, (_, i) => mk('a' + i, i * 0.1, i % 3 ? 'PREMIUM' : 'AGGREGATED')),
      ...Array.from({ length: 40 }, (_, i) => mk('ao' + i, 30 + i, 'BASIC'))],
    villa: [mk('v1', 1, 'MINIMAL'), mk('v2', 2, 'PLUS'), mk('v3', 3, 'NC_PREMIUM_PROJECT', true), mk('v4', 20, 'PREMIUM')],
  };
  const national = Object.values(byType).flat().sort((a, b) => b.publishedAt - a.publishedAt);
  const page = (cards, p) => ({ total: cards.length, offset: (p - 1) * 50, limit: 50, search: { upcoming: 'ONLY' }, cards: cards.slice((p - 1) * 50, p * 50) });
  const calls = [];
  const getPage = async (url) => {
    calls.push(url);
    const p = Number(url.match(/page=(\d+)/)[1]);
    const t = (url.match(/item_types\[\]=(\w+)/) || [])[1];
    return page(t ? (byType[t] || []) : national, p);
  };
  const census = { share: 0.5, file: 'age-census-hemnet-premarket-2026-11-01.json' };
  const r = await measureHemnet({ getPage, nowSec: NOW, census, logger: () => {} });
  // In the 7-day window (age <= 7.0d, inclusive as in countWindowSecondhand): bostadsratt i<=70 -> 71 cards,
  // AGGREGATED (i%3==0) 24, comparable 47.
  // villa: v1 MINIMAL excluded, v2 PLUS is a 2nd-hand add, v3 is new-build.
  assert.strictEqual(r.adds_window_secondhand, 48, `comparable 2nd-hand adds, got ${r.adds_window_secondhand}`);
  assert.strictEqual(r.hemnet_all_types.adds_by_type.AGGREGATED, 24);
  assert.strictEqual(r.hemnet_all_types.adds_by_type.MINIMAL, 1);
  assert.strictEqual(r.hemnet_all_types.stock_all, national.length);
  assert.strictEqual(r.stock_total, Math.round(national.length * 0.5), 'stock scaled by the census comparable share');
  assert.ok(!calls.some(u => /bostadsratt.*page=4/.test(u)), 'walk stops once a page is entirely older than the window');
  assert.ok(calls.every(u => u.startsWith('https://www.hemnet.se/till-salu?upcoming=ONLY')), 'only the new URL');
  // No census on disk -> fail loudly, never store an inflated stock.
  await assert.rejects(() => measureHemnet({ getPage, nowSec: NOW, census: null, logger: () => {} }), /no gate-passed Hemnet pre-market census/);
  // The census reader picks the newest GATE-PASSED file.
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmf-'));
  fs.writeFileSync(path.join(tmp, 'age-census-hemnet-premarket-2026-11-01.json'), JSON.stringify({ status: 'ok', nTotal: 7000, allTypes: { nAll: 28000 } }));
  fs.writeFileSync(path.join(tmp, 'age-census-hemnet-premarket-2026-12-01.json'), JSON.stringify({ status: 'gate_failed', nTotal: 1, allTypes: { nAll: 2 } }));
  assert.strictEqual(loadCensusShare(tmp).share, 0.25, 'a gate-failed month is skipped');
  assert.strictEqual(loadCensusShare(path.join(tmp, 'nope')), null);
  console.log('selftest: premarket-flow-measure Hemnet side PASS');
}

