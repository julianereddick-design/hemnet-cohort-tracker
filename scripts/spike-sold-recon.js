'use strict';

// spike-sold-recon.js — Stage 0 recon gate for the Booli-sold → Hemnet-sold
// matching spike. Fetches live sold pages, dumps raw HTML + Apollo state, and
// prints a schema sketch so we can build parsers against the REAL structure
// (the SoldProperty Apollo shape, the title-transfer signal, broker presence,
// Hemnet /salda card shape + whether narrowed filters are accepted).
//
// Read-only. Forced through Oxylabs. Cheap (≤ a handful of live calls; reruns
// replay from cache). Run: node scripts/spike-sold-recon.js

process.env.SCRAPE_FORCE_OXYLABS = '1';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  cachedFetch, extractApollo, extractNextData, assertOxyUsed, procStats,
  ROOT, ensureDir, writeJson, stdoutLogger,
} = require('./spike-common');

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
  let res;
  try {
    res = await cachedFetch(url, { logger: log });
  } catch (e) {
    log('ERROR', `fetch failed: ${e.message}`);
    return { label, url, error: e.message };
  }
  log('INFO', `status ${res.status} fromCache=${res.fromCache} htmlLen=${res.html.length}`);
  const safe = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  fs.writeFileSync(path.join(RECON_DIR, `${safe}.html`), res.html);

  if (res.status === 404 || !res.html) {
    return { label, url, status: res.status, note: 'no-html-or-404' };
  }

  let apollo = null, nextData = null;
  try {
    const ex = extractApollo(res.html);
    apollo = ex.apollo; nextData = ex.nextData;
  } catch (e) {
    log('WARN', `extractApollo failed: ${e.message} — dumping nextData attempt`);
    try { nextData = extractNextData(res.html); } catch (_) {}
  }

  if (nextData) writeJson(path.join(RECON_DIR, `${safe}.nextdata.json`), nextData);
  if (apollo) writeJson(path.join(RECON_DIR, `${safe}.apollo.json`), apollo);

  const summary = { label, url, status: res.status, hasApollo: !!apollo };
  if (apollo) {
    summary.typenames = typenameHistogram(apollo);
    summary.rootQueryFields = rootQueryFields(apollo);
    summary.transferScan = keywordScan(apollo, [
      'lagfart', 'gåva', 'gava', 'arv', 'byte', 'källa', 'kalla', 'source',
      'slutpris', 'soldprice', 'sold', 'mäklare', 'maklare', 'broker', 'agent',
      'transfer', 'priceType', 'saleType', 'såld', 'sald',
    ]);
    log('INFO', `typenames: ${JSON.stringify(summary.typenames)}`);
    log('INFO', `rootQuery fields: ${summary.rootQueryFields.length}`);
    for (const f of summary.rootQueryFields.slice(0, 8)) log('INFO', `  RQ ${f.field} :: ${f.shape}`);
    log('INFO', `transfer/broker keyword hits: ${summary.transferScan.length} (see recon json)`);
  } else {
    // No apollo — record a visible-text snippet to see what the page is.
    summary.textSnippet = res.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400);
    log('WARN', `no apollo. text: ${summary.textSnippet}`);
  }
  return summary;
}

async function main() {
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

  writeJson(path.join(RECON_DIR, '_recon-summary.json'), results);
  log('INFO', `\n=== procStats: ${JSON.stringify(procStats())} ===`);
  try { log('INFO', `transport-assert: ${JSON.stringify(assertOxyUsed())}`); }
  catch (e) { log('ERROR', `transport-assert FAILED: ${e.message}`); process.exitCode = 2; }
  log('INFO', `recon artifacts in ${RECON_DIR}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
