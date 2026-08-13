'use strict';
// scripts/probe-booli-newconstruction-filter.js — does Booli's search honour a
// new-construction query parameter?
//
// WHY THIS MATTERS: the Booli age censuses use a binary search that infers band counts
// from PAGE POSITIONS and never sees ~94% of the listings, so it cannot subtract
// new-builds per band. If the site itself can filter them out, the same binary search
// runs against the filtered stream and yields EXACT second-hand bands at the same cost.
//
// WHY `=1` IS THE REAL TEST: Booli silently ignores unrecognised query params, so a
// `...=0` URL can return the FULL pool while looking filtered — a silent wrong number.
// Asking for new-builds ONLY (`=1`) is unmistakable: a working filter collapses the total
// by ~100x (~370 of ~52,000), an ignored one returns the pool unchanged. A second,
// independent check reads the per-card isNewConstruction flag on the returned page.
//
//   SCRAPE_FORCE_OXYLABS=1 node scripts/probe-booli-newconstruction-filter.js
//
// Cost: 1 call per candidate URL (~8 total). Read-only, no DB writes.
require('dotenv').config();

const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseBooliSearchCards } = require('../lib/booli-fetch');

const BASE = 'https://www.booli.se/sok/till-salu?upcomingSale=0';

// Baseline first, then the discriminating `=1` probes across plausible param spellings,
// then `=0` for the same names. Booli's own params are camelCase (`upcomingSale`), and the
// Apollo card field is `isNewConstruction`, so that spelling is the leading candidate.
const CANDIDATES = [
  { label: 'baseline (no filter)', url: BASE },
  { label: 'isNewConstruction=1', url: `${BASE}&isNewConstruction=1` },
  { label: 'newConstruction=1', url: `${BASE}&newConstruction=1` },
  { label: 'isNewConstruction=true', url: `${BASE}&isNewConstruction=true` },
  { label: 'newProduction=1', url: `${BASE}&newProduction=1` },
  { label: 'isNewConstruction=0', url: `${BASE}&isNewConstruction=0` },
  { label: 'isNewConstruction=false', url: `${BASE}&isNewConstruction=false` },
];

function apolloFrom(html) {
  const d = extractNextData(html);
  const a = d && d.props && d.props.pageProps && d.props.pageProps.__APOLLO_STATE__;
  if (!a) throw new Error('__APOLLO_STATE__ missing');
  return a;
}

async function probeOne({ label, url }) {
  const res = await getWithRetry(url, { logger: () => {} });
  if (res.status !== 200) return { label, url, status: res.status, total: null, cards: null, nb: null };
  const parsed = parseBooliSearchCards(apolloFrom(res.html));
  const nb = parsed.cards.filter(c => c.isNewConstruction).length;
  return { label, url, status: 200, total: parsed.totalCount, cards: parsed.cards.length, nb };
}

async function main() {
  if (process.env.SCRAPE_FORCE_OXYLABS !== '1') {
    console.error('Refusing to run un-proxied. Set SCRAPE_FORCE_OXYLABS=1.');
    process.exit(1);
  }
  resetOxylabsStats();
  console.log('=== Booli new-construction filter probe ===\n');

  const results = [];
  for (const c of CANDIDATES) {
    try {
      const r = await probeOne(c);
      results.push(r);
      console.log(`  ${r.label.padEnd(26)} status=${r.status}  total=${r.total == null ? 'n/a' : r.total}  page1_cards=${r.cards == null ? '-' : r.cards}  of which new-build=${r.nb == null ? '-' : r.nb}`);
    } catch (e) {
      results.push({ ...c, status: 'THREW', error: e.message });
      console.log(`  ${c.label.padEnd(26)} THREW: ${e.message.slice(0, 70)}`);
    }
  }

  const baseline = results[0];
  console.log('\n=== VERDICT ===');
  if (baseline.total == null) {
    console.log('  INCONCLUSIVE — baseline fetch failed, nothing to compare against.');
  } else {
    console.log(`  Baseline pool: ${baseline.total.toLocaleString()} (page-1 new-build cards: ${baseline.nb}/${baseline.cards})`);
    for (const r of results.slice(1)) {
      if (r.total == null) { console.log(`  ${r.label.padEnd(26)} -> no verdict (status ${r.status})`); continue; }
      const ratio = r.total / baseline.total;
      let verdict;
      if (Math.abs(r.total - baseline.total) <= Math.max(5, baseline.total * 0.001)) {
        verdict = 'IGNORED — total unchanged, param has no effect';
      } else if (/=(1|true)$/.test(r.label) && ratio < 0.1) {
        verdict = `WORKS — collapsed to ${(ratio * 100).toFixed(2)}% of the pool (new-builds only)`;
      } else if (/=(0|false)$/.test(r.label) && ratio < 1) {
        verdict = `WORKS — removed ${(baseline.total - r.total).toLocaleString()} listings (${((1 - ratio) * 100).toFixed(2)}%)`;
      } else {
        verdict = `CHANGED the total (${(ratio * 100).toFixed(1)}% of baseline) — inspect before trusting`;
      }
      // Independent cross-check: an exclusion filter that works should leave no new-build
      // cards on page 1; an inclusion filter should leave almost nothing BUT new-builds.
      const flagNote = r.nb == null ? '' : `  [page-1 new-build cards: ${r.nb}/${r.cards}]`;
      console.log(`  ${r.label.padEnd(26)} -> ${verdict}${flagNote}`);
    }
  }
  console.log(`\nOxylabs: ${JSON.stringify(getOxylabsStats())}`);
}

main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
