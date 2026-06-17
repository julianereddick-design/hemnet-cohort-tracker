'use strict';

// sold-recon.js — Stage-0 recon CLI for the Booli-sold → Hemnet-sold matching
// pipeline. Lifted from scripts/spike-sold-recon.js (Plan 15-03), rewired to
// lib/sold-transport, and extended for D-04 "sold in advance" keyword discovery.
//
// Fetches Booli /slutpriser list pages AND (optionally) a single /bostad/<id>
// detail page, dumps raw HTML + Apollo state, and prints a schema sketch so we
// can confirm where the "sold in advance" signal lives (D-04 recon gate).
//
// Read-only. Forced through Oxylabs. Cheap (≤ a handful of live calls; reruns
// replay from cache). Run:
//   node scripts/sold-recon.js                     # list pages only
//   node scripts/sold-recon.js --detail 6107381    # + detail page for booliId
//   node scripts/sold-recon.js --url https://www.booli.se/bostad/2265068

// IMPORTANT: SCRAPE_FORCE_OXYLABS must be set BEFORE any lib require — the
// lib/sold-transport load-time guard validates this flag at require time.
process.env.SCRAPE_FORCE_OXYLABS = '1';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  cachedFetch, extractApollo, assertOxyUsed,
  ROOT, ensureDir, writeJson, stdoutLogger,
} = require('../lib/sold-transport');

const RECON_DIR = ensureDir(path.join(ROOT, 'recon'));
const log = stdoutLogger('recon');

// ---------------------------------------------------------------
// Generic Apollo explorers
// ---------------------------------------------------------------

function typenameHistogram(apollo) {
  const hist = {};
  if (!apollo || typeof apollo !== 'object') return hist;
  for (const [k, v] of Object.entries(apollo)) {
    let tn = null;
    if (v && typeof v === 'object' && typeof v.__typename === 'string') tn = v.__typename;
    else if (k.includes(':')) tn = k.split(':')[0];
    else tn = '(root)';
    hist[tn] = (hist[tn] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(hist).sort((a, b) => b[1] - a[1]));
}

function sampleByTypename(apollo, typename, n = 2) {
  const out = [];
  if (!apollo) return out;
  for (const [k, v] of Object.entries(apollo)) {
    const tn = (v && v.__typename) || (k.includes(':') ? k.split(':')[0] : null);
    if (tn === typename) { out.push({ key: k, value: v }); if (out.length >= n) break; }
  }
  return out;
}

// Walk the whole apollo object; collect string values whose value OR key matches
// any keyword. Returns [{path, key, value}] truncated.
function keywordScan(obj, keywords, maxHits = 60) {
  const hits = [];
  const kw = keywords.map((s) => s.toLowerCase());
  function walk(node, p) {
    if (hits.length >= maxHits) return;
    if (node == null) return;
    if (typeof node === 'string') {
      const low = node.toLowerCase();
      if (kw.some((k) => low.includes(k))) hits.push({ path: p, value: node.slice(0, 120) });
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const kl = k.toLowerCase();
      if (kw.some((kw1) => kl.includes(kw1)) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        hits.push({ path: `${p}.${k}`, key: k, value: String(v).slice(0, 120) });
      }
      walk(v, `${p}.${k}`);
      if (hits.length >= maxHits) return;
    }
  }
  walk(obj, '$');
  return hits;
}

// Find ROOT_QUERY search-result fields (keys often look like searchForSale(...),
// searchSold(...), salesByLocation(...) etc.) and print their shape.
function rootQueryFields(apollo) {
  const rq = apollo && apollo.ROOT_QUERY;
  if (!rq) return [];
  return Object.keys(rq).map((k) => {
    const v = rq[k];
    let shape;
    if (Array.isArray(v)) shape = `array[${v.length}]`;
    else if (v && typeof v === 'object') shape = `object{${Object.keys(v).slice(0, 12).join(',')}}`;
    else shape = typeof v;
    return { field: k.slice(0, 140), shape };
  });
}

async function dumpOne(label, url) {
  log('INFO', `--- ${label} ---`);
  log('INFO', `url: ${url}`);

  // Offline-first: if the apollo dump already exists in the recon dir, read it.
  const safe = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const offlineApolloFile = path.join(RECON_DIR, `${safe}.apollo.json`);
  if (fs.existsSync(offlineApolloFile)) {
    log('INFO', `offline cache hit: ${offlineApolloFile}`);
    const apollo = JSON.parse(fs.readFileSync(offlineApolloFile, 'utf8'));
    const summary = buildSummary(label, url, null, apollo);
    log('INFO', `typenames: ${JSON.stringify(summary.typenames)}`);
    log('INFO', `rootQuery fields: ${summary.rootQueryFields.length}`);
    for (const f of summary.rootQueryFields.slice(0, 8)) log('INFO', `  RQ ${f.field} :: ${f.shape}`);
    log('INFO', `keyword hits: ${summary.transferScan.length} (see recon json)`);
    return summary;
  }

  let res;
  try {
    res = await cachedFetch(url, { logger: log });
  } catch (e) {
    log('ERROR', `fetch failed: ${e.message}`);
    return { label, url, error: e.message };
  }
  log('INFO', `status ${res.status} fromCache=${res.fromCache} htmlLen=${res.html.length}`);
  fs.writeFileSync(path.join(RECON_DIR, `${safe}.html`), res.html);

  if (res.status === 404 || !res.html) {
    return { label, url, status: res.status, note: 'no-html-or-404' };
  }

  let apollo = null, nextData = null;
  try {
    const ex = extractApollo(res.html);
    apollo = ex.apollo; nextData = ex.nextData;
  } catch (e) {
    log('WARN', `extractApollo failed: ${e.message}`);
  }

  if (nextData) writeJson(path.join(RECON_DIR, `${safe}.nextdata.json`), nextData);
  if (apollo) writeJson(path.join(RECON_DIR, `${safe}.apollo.json`), apollo);

  const summary = buildSummary(label, url, res.status, apollo);
  if (apollo) {
    log('INFO', `typenames: ${JSON.stringify(summary.typenames)}`);
    log('INFO', `rootQuery fields: ${summary.rootQueryFields.length}`);
    for (const f of summary.rootQueryFields.slice(0, 8)) log('INFO', `  RQ ${f.field} :: ${f.shape}`);
    log('INFO', `keyword hits: ${summary.transferScan.length} (see recon json)`);
  } else {
    const textSnippet = res.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400);
    summary.textSnippet = textSnippet;
    log('WARN', `no apollo. text: ${textSnippet}`);
  }
  return summary;
}

function buildSummary(label, url, status, apollo) {
  const summary = { label, url, status, hasApollo: !!apollo };
  if (apollo) {
    summary.typenames = typenameHistogram(apollo);
    summary.rootQueryFields = rootQueryFields(apollo);
    summary.transferScan = keywordScan(apollo, [
      // Transfer/broker terms (original set)
      'lagfart', 'gåva', 'gava', 'arv', 'byte', 'källa', 'kalla', 'source',
      'slutpris', 'soldprice', 'sold', 'mäklare', 'maklare', 'broker', 'agent',
      'transfer', 'priceType', 'saleType', 'såld', 'sald',
      // D-04 sold-in-advance recon
      'förhand', 'forhand', 'advance', 'pre-market', 'premarket',
      'before viewing', 'innan visning', 'visning', 'kommande', 'upcoming',
      'presale', 'pre-sale', 'förköp', 'forköp',
    ]);
  }
  return summary;
}

// ---------------------------------------------------------------
// Arg parsing for --detail <booliId> / --url <url> mode
// ---------------------------------------------------------------
function parseArgs(argv) {
  const args = { detailBooliId: null, detailUrl: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--detail' && argv[i + 1]) {
      args.detailBooliId = argv[i + 1];
      i++;
    } else if (argv[i] === '--url' && argv[i + 1]) {
      args.detailUrl = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Standard list-page recon targets
  const targets = [
    // Booli sold — Stockholm county (areaIds=2 is the known county id used by Booli jobs).
    ['booli-sold-stockholm-county', 'https://www.booli.se/sok/salda?areaIds=2'],
    // Hemnet sold — bare national page; we'll harvest real location_ids from its area filter.
    ['hemnet-sold-bare', 'https://www.hemnet.se/salda'],
    // Hemnet sold — narrowed-filter probe (guessed Stockholm muni id 17744); confirms whether
    // /salda accepts the same price/rooms/item_types params as /bostader.
    ['hemnet-sold-narrowed-probe', 'https://www.hemnet.se/salda?location_ids%5B%5D=17744&price_min=2000000&price_max=6000000&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt'],
  ];

  const results = [];
  for (const [label, url] of targets) {
    results.push(await dumpOne(label, url));
  }

  // Optional: detail-page recon for D-04 "sold in advance" signal.
  // Prefer offline: if an existing detail dump is present in recon/, use it
  // without a live fetch. Only issue a live /bostad/<id> fetch when needed.
  if (args.detailBooliId || args.detailUrl) {
    let detailLabel, detailUrl;
    if (args.detailUrl) {
      detailLabel = `booli-detail-url`;
      detailUrl = args.detailUrl;
    } else {
      // booliId is the residenceId in the /bostad/<residenceId> URL pattern.
      // The detail-sample in recon/ has residenceId; --detail accepts either.
      detailLabel = `booli-detail-${args.detailBooliId}`;
      detailUrl = `https://www.booli.se/bostad/${args.detailBooliId}`;
    }

    // Check if a matching offline dump already exists (booli-sold-detail-sample.json
    // was captured during the original spike and covers the detail SoldProperty shape).
    const offlineCandidates = [
      path.join(RECON_DIR, 'booli-sold-detail-sample.json'),
      path.join(RECON_DIR, `${detailLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.apollo.json`),
    ];
    const offlineHit = offlineCandidates.find((f) => fs.existsSync(f));
    if (offlineHit) {
      log('INFO', `detail offline hit: ${offlineHit} — skipping live fetch`);
      const sp = JSON.parse(fs.readFileSync(offlineHit, 'utf8'));
      const summary = {
        label: detailLabel,
        url: detailUrl,
        status: null,
        hasApollo: true,
        note: `offline from ${path.basename(offlineHit)}`,
        typenames: { SoldProperty: 1 },
        soldAsUpcomingSale: sp.soldAsUpcomingSale != null ? sp.soldAsUpcomingSale : 'field absent',
        rootQueryFields: [],
        transferScan: keywordScan(sp, [
          'lagfart', 'gåva', 'gava', 'arv', 'byte', 'slutpris', 'sold', 'transfer', 'priceType',
          // D-04 sold-in-advance recon
          'förhand', 'forhand', 'advance', 'pre-market', 'premarket',
          'innan visning', 'visning', 'kommande', 'upcoming', 'presale', 'pre-sale', 'förköp', 'forköp',
        ]),
      };
      log('INFO', `soldAsUpcomingSale = ${summary.soldAsUpcomingSale}`);
      log('INFO', `sold-in-advance keyword hits in detail: ${summary.transferScan.length}`);
      results.push(summary);
    } else {
      // Live fetch — counts against the ceiling (T-15-08 mitigation: at most one).
      log('INFO', `detail page live fetch (no offline dump found): ${detailUrl}`);
      results.push(await dumpOne(detailLabel, detailUrl));
    }
  } else {
    // No --detail flag — check offline detail-sample automatically for the D-04 signal.
    const offlineDetail = path.join(RECON_DIR, 'booli-sold-detail-sample.json');
    if (fs.existsSync(offlineDetail)) {
      log('INFO', `auto-scanning offline detail sample for D-04 signal: ${offlineDetail}`);
      const sp = JSON.parse(fs.readFileSync(offlineDetail, 'utf8'));
      const detailScan = keywordScan(sp, [
        // D-04 sold-in-advance recon
        'förhand', 'forhand', 'advance', 'pre-market', 'premarket',
        'innan visning', 'visning', 'kommande', 'upcoming', 'presale', 'pre-sale', 'förköp', 'forköp',
      ]);
      log('INFO', `D-04 offline detail scan: soldAsUpcomingSale=${sp.soldAsUpcomingSale}, keyword hits=${detailScan.length}`);
      results.push({
        label: 'booli-sold-detail-offline-scan',
        note: 'auto scan of offline detail sample',
        soldAsUpcomingSale: sp.soldAsUpcomingSale,
        transferScan: detailScan,
      });
    }
  }

  writeJson(path.join(RECON_DIR, '_recon-summary.json'), results);
  log('INFO', `\n=== recon complete. artifacts in ${RECON_DIR} ===`);
  try { log('INFO', `transport-assert: ${JSON.stringify(assertOxyUsed())}`); }
  catch (e) { log('ERROR', `transport-assert FAILED: ${e.message}`); process.exitCode = 2; }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
