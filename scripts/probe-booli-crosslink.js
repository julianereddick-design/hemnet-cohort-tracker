// scripts/probe-booli-crosslink.js
//
// SPIKE (Phase 14 discussion, 2026-06-11): does a Booli /annons/<id> detail
// page expose (a) any cross-link/reference to the matching Hemnet listing, and
// (b) unit-level identity fields (monthly fee / floor / apartment number) in
// its __NEXT_DATA__ Apollo payload?
//
// Usage:
//   node scripts/probe-booli-crosslink.js --ids 6005229,6096383,6153069
//   node scripts/probe-booli-crosslink.js --dir verf-spotcheck-2026-W23-20260610-131907 --limit 5
//
// Reads booli_ids either from --ids or from a spot-check artifact JSON in --dir.
// Fetches via lib/scrape-http getWithRetry (direct curl → Oxylabs fallback).
// No DB access. Prints a per-listing report + a summary verdict.

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats } = require('../lib/scrape-http');

function parseArgs(argv) {
  const out = { ids: [], dir: null, limit: 5 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ids') out.ids = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 5;
  }
  return out;
}

// Walk any JSON structure; collect dotted paths whose key or string value
// matches the predicate. Caps results to keep output readable.
function findMatches(node, test, prefix = '', hits = [], cap = 40) {
  if (hits.length >= cap || node == null) return hits;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findMatches(v, test, `${prefix}[${i}]`, hits, cap));
    return hits;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (test(k, null)) hits.push({ path: p, key: k, value: summarize(v) });
      if (typeof v === 'string' && test(null, v)) hits.push({ path: p, key: k, value: summarize(v) });
      findMatches(v, test, p, hits, cap);
      if (hits.length >= cap) break;
    }
  }
  return hits;
}

function summarize(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? null : (s.length > 160 ? s.slice(0, 160) + '…' : s);
}

const HEMNET_RE = /hemnet/i;
// Unit-level identity field candidates (key-name match, case-insensitive)
const UNIT_KEY_RE = /(rent|monthlyfee|fee|avgift|floor|vaning|våning|apartmentnumber|lghnr|energyclass|agency|agent|source)/i;

(async () => {
  const args = parseArgs(process.argv);
  let ids = args.ids;

  if (!ids.length && args.dir) {
    const jsonFile = fs.readdirSync(args.dir).find(f => f.startsWith('spotcheck-') && f.endsWith('.json'));
    if (!jsonFile) throw new Error(`no spotcheck-*.json in ${args.dir}`);
    const artifact = JSON.parse(fs.readFileSync(path.join(args.dir, jsonFile), 'utf8'));
    ids = (artifact.pairs || []).map(p => String(p.booli_id)).slice(0, args.limit);
  }
  if (!ids.length) throw new Error('no booli ids — pass --ids or --dir');

  console.log(`probe-booli-crosslink: ${ids.length} listing(s)\n`);
  let hemnetAnywhere = 0;
  const unitFieldTally = {};

  for (const id of ids) {
    const url = `https://www.booli.se/annons/${id}`;
    let res;
    try {
      res = await getWithRetry(url, { label: `booli-${id}` });
    } catch (e) {
      console.log(`-- ${url}\n   FETCH FAILED: ${e.message}\n`);
      continue;
    }
    if (res.status === 404 || !res.html) {
      console.log(`-- ${url}\n   status=${res.status} (removed/no body)\n`);
      continue;
    }

    const rawHemnetCount = (res.html.match(/hemnet/gi) || []).length;
    let nextData = null;
    try { nextData = extractNextData(res.html); } catch (_) { /* fall through */ }

    console.log(`-- ${url}  status=${res.status} htmlLen=${res.html.length} raw "hemnet" count=${rawHemnetCount}`);

    if (rawHemnetCount > 0) {
      hemnetAnywhere++;
      // Show contexts from raw HTML (catches non-JSON references too)
      const ctxRe = /.{0,80}hemnet.{0,80}/gi;
      const ctxs = res.html.match(ctxRe) || [];
      ctxs.slice(0, 5).forEach(c => console.log(`   HEMNET CTX: …${c.replace(/\s+/g, ' ')}…`));
    }

    if (nextData) {
      const hemnetHits = findMatches(nextData, (k, v) => (k && HEMNET_RE.test(k)) || (v && HEMNET_RE.test(v)));
      hemnetHits.forEach(h => console.log(`   HEMNET JSON: ${h.path} = ${h.value}`));

      const unitHits = findMatches(nextData, (k) => k != null && UNIT_KEY_RE.test(k));
      const seen = new Set();
      for (const h of unitHits) {
        if (seen.has(h.key)) continue;
        seen.add(h.key);
        unitFieldTally[h.key] = (unitFieldTally[h.key] || 0) + 1;
        console.log(`   UNIT FIELD: ${h.key} = ${h.value}  (${h.path})`);
      }
    } else {
      console.log('   (no __NEXT_DATA__ extracted)');
    }
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log(`listings with ANY hemnet reference: ${hemnetAnywhere}/${ids.length}`);
  console.log('unit-level field keys seen (listings count):');
  Object.entries(unitFieldTally).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));
  console.log(`oxylabs stats: ${JSON.stringify(getOxylabsStats())}`);
})().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
