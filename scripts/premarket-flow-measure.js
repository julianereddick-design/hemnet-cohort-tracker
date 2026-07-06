'use strict';
// scripts/premarket-flow-measure.js — one-off national pre-market flow & staleness
// measurement (Hemnet vs Booli, second-hand only). Writes premarket_flow_weekly + artifact.
// Run: SCRAPE_FORCE_OXYLABS=1 node scripts/premarket-flow-measure.js
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');
const { parseBooliSearchCards } = require('../lib/booli-fetch');
const { walkFlow, sampleDepth, computeMetrics } = require('../lib/premarket-flow');
const { createClient } = require('../db');

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
  const data = extractNextData(html);
  const apollo = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apollo) throw new Error(`${label}: __APOLLO_STATE__ missing`);
  return apollo;
}

// Platform configs: url(page) → fetch; normalize cards to { published, isNewBuild };
// stock read from page-1 apollo via (prefix, field).
const PLATFORMS = {
  hemnet: {
    url: (p) => `https://www.hemnet.se/kommande/bostader?sort=NEWEST&page=${p}`,
    parse: (apollo) => parseListingCards(apollo).map(c => ({ published: c.publishedAt, isNewBuild: c.newConstruction })),
    stock: (apollo) => pickByPrefix(apollo.ROOT_QUERY, 'searchUpcomingListings', 'total'),
    // Hemnet /kommande pagination is shallow (caps ~page 40-50; page 80+ returns empty).
    // Sample within the reachable depth so the new-build/age estimate isn't computed from
    // just page 1. Booli's pool is far deeper (33k) so it keeps the wide [1..900] spread.
    depthPages: [1, 15, 30, 40],
  },
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
  const fetchPage = async (p) => {
    const res = await getWithRetry(cfg.url(p), { logger: () => {} });
    if (res.status !== 200) { log('WARN', `${name} page ${p} status ${res.status}`); return []; }
    const apollo = apolloRoot(res.html, `${name} p${p}`);
    if (p === 1 && stockTotal == null) stockTotal = cfg.stock(apollo);
    return cfg.parse(apollo);
  };
  const flow = await walkFlow({ fetchPage, nowSec: NOW_SEC, windowDays: WINDOW_DAYS, maxPages: MAX_PAGES, logger: log });
  console.log(`  flow walk: pages=${flow.pagesWalked} adds2nd=${flow.addsSecondhand} newbuildInWindow=${flow.newbuildInWindow}`);
  const depth = await sampleDepth({ fetchPage, pageNumbers: cfg.depthPages, nowSec: NOW_SEC, logger: log });
  for (const d of depth) console.log(`  depth p${d.page}: n=${d.n} newbuild=${(d.newbuildPct * 100).toFixed(0)}% medianAge=${d.medianAgeDays == null ? '-' : d.medianAgeDays.toFixed(0)}d`);
  if (stockTotal == null || typeof stockTotal !== 'number') throw new Error(`${name}: stock total not found on page 1`);
  const metrics = computeMetrics({
    stockTotal, addsSecondhand: flow.addsSecondhand, newbuildInWindow: flow.newbuildInWindow,
    datedInWindow: flow.datedInWindow, depthSample: depth, windowDays: WINDOW_DAYS,
  });
  const oxAfter = getOxylabsStats();
  const oxCalls = (oxAfter.oxylabsCallCount + oxAfter.directSuccessCount) - (oxBefore.oxylabsCallCount + oxBefore.directSuccessCount);
  return { platform: name, ...metrics, pages_walked: flow.pagesWalked, oxylabs_calls: oxCalls, depth };
}

async function main() {
  resetOxylabsStats();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const hemnet = await measurePlatform('hemnet');
  const booli = await measurePlatform('booli');
  const rows = [hemnet, booli];

  // Cross-platform derived share.
  const totalAdds = hemnet.adds_window_secondhand + booli.adds_window_secondhand;
  const premarketShareHemnet = totalAdds > 0 ? hemnet.adds_window_secondhand / totalAdds : null;

  // Persist.
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_TABLE);
    for (const r of rows) {
      await client.query(UPSERT, [
        r.platform, WINDOW_DAYS, r.stock_total, r.stock_secondhand_est,
        r.adds_window_secondhand, r.flow_per_day, r.newbuild_share_window,
        r.newbuild_share_pool_est, r.mean_dwell_days, r.pages_walked, r.oxylabs_calls,
      ]);
      console.log(`upsert ok: platform=${r.platform} adds2nd=${r.adds_window_secondhand} dwell=${r.mean_dwell_days}d`);
    }
  } finally {
    await client.end();
  }

  // Artifact.
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const payload = { snapshot_date: dateStr, window_days: WINDOW_DAYS, premarket_share_hemnet: premarketShareHemnet, rows };
  fs.writeFileSync(path.join(OUT_DIR, `premarket-flow-${dateStr}.json`), JSON.stringify(payload, null, 2));
  const md = [
    `# Pre-market flow — ${dateStr} (window ${WINDOW_DAYS}d, second-hand only, national)`, '',
    `| Platform | Stock (2nd-hand est) | Adds/wk (2nd-hand) | Flow/day | Mean dwell | New-build % (pool) |`,
    `|---|---|---|---|---|---|`,
    ...rows.map(r => `| ${r.platform} | ${r.stock_secondhand_est.toLocaleString()} | ${r.adds_window_secondhand} | ${r.flow_per_day} | ${r.mean_dwell_days == null ? 'n/a' : r.mean_dwell_days + 'd'} | ${(r.newbuild_share_pool_est * 100).toFixed(0)}% |`),
    '',
    `**Hemnet pre-market share of fresh 2nd-hand adds:** ${premarketShareHemnet == null ? 'n/a' : (premarketShareHemnet * 100).toFixed(1) + '%'}`,
    `**Stock ratio (Booli/Hemnet):** ${(booli.stock_secondhand_est / hemnet.stock_secondhand_est).toFixed(2)}× · **Flow ratio (Booli/Hemnet):** ${hemnet.adds_window_secondhand ? (booli.adds_window_secondhand / hemnet.adds_window_secondhand).toFixed(2) : 'n/a'}×`,
    '', `_Flow is a floor (Kommande→FS conversions within the window uncounted; equal bias both platforms). New-build pool share is a depth-sample estimate._`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, `premarket-flow-${dateStr}.md`), md);

  console.log(`\n${md}`);
  console.log(`\nOxylabs calls total: ${JSON.stringify(getOxylabsStats())}`);
  console.log(`Artifact -> ${OUT_DIR}`);
}

main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
