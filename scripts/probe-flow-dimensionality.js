'use strict';

// probe-flow-dimensionality.js — One-off exploration probe.
//
// GOAL (Julian, 2026-07-06): can we get a cheap *marginal* market-share signal
// for Hemnet vs Booli — e.g. "how many listings were ADDED in the last N days" —
// WITHOUT walking the whole inventory? Stock ratios are contaminated by Booli's
// aged pre-market backlog; flow (recent additions) should be a cleaner read.
//
// Both sites' search cards carry a per-listing publish date + a pre-market flag,
// sorted newest-first (Hemnet sort=NEWEST; Booli default no-sort). So we can walk
// only the newest pages until we cross a date cutoff and COUNT recent additions.
//
// This probe measures, for three streams:
//   1. Hemnet FS        https://www.hemnet.se/bostader?sort=NEWEST
//   2. Hemnet Kommande  https://www.hemnet.se/kommande/bostader?sort=NEWEST
//   3. Booli (FS+PM)    https://www.booli.se/sok/till-salu   (national, no areaId)
//
// For each: pool total (stock, 1 req), per-card publish-date density → add-rate,
// exact counts in last 7d / 30d (walking newest pages until cutoff, capped), and
// the age distribution of the pre-market pool (to quantify Booli's "aged inventory").
//
// Cost: <= 3 streams * MAX_PAGES requests via Oxylabs. Trivial spend.
//
// Run:  SCRAPE_FORCE_OXYLABS=1 node scripts/probe-flow-dimensionality.js

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');
const { parseBooliSearchCards } = require('../lib/booli-fetch');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const MAX_PAGES = 6;                 // per stream; bounds cost
const STOP_AGE_DAYS = 45;            // stop walking once oldest card on a page is older than this
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
fs.mkdirSync(OUT_DIR, { recursive: true });

function noop() {}
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

// --- total extractors (read stock counts off ROOT_QUERY) ---
function hemnetTotals(apollo) {
  const out = {};
  const root = apollo && apollo.ROOT_QUERY;
  if (!root) return out;
  for (const k of Object.keys(root)) {
    const v = root[k];
    if (!v || typeof v !== 'object') continue;
    if (k.startsWith('searchForSaleListings') && typeof v.total === 'number') out.forSale = v.total;
    if (k.startsWith('searchUpcomingListings') && typeof v.total === 'number') out.upcoming = v.total;
    if (k.startsWith('searchSales') && typeof v.total === 'number') out.sold = v.total;
  }
  return out;
}
function booliTotals(apollo) {
  const out = {};
  const root = apollo && apollo.ROOT_QUERY;
  if (!root) return out;
  for (const k of Object.keys(root)) {
    if (!k.startsWith('searchForSale')) continue;
    const v = root[k];
    if (v && typeof v === 'object') {
      if (typeof v.totalCount === 'number') out.totalCount = v.totalCount;
      const f = v.facets && v.facets.forSaleType;
      if (f) { out.forSaleFacet = f.forSale; out.upcomingFacet = f.upcomingSale; }
    }
  }
  return out;
}

function apolloOf(html) {
  const data = extractNextData(html);
  return data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
}

// Summarize a set of {published, pre} card records.
function summarize(name, cards, totals) {
  const withDate = cards.filter((c) => c.published != null).map((c) => c.published);
  withDate.sort((a, b) => b - a); // newest first
  const ages = withDate.map((p) => (NOW - p) / DAY);
  const n = withDate.length;
  const fmt = (s) => new Date(s * 1000).toISOString().slice(0, 10);
  const last7 = withDate.filter((p) => p >= NOW - 7 * DAY).length;
  const last30 = withDate.filter((p) => p >= NOW - 30 * DAY).length;
  const newest = n ? fmt(withDate[0]) : '-';
  const oldest = n ? fmt(withDate[n - 1]) : '-';
  const spanDays = n > 1 ? (withDate[0] - withDate[n - 1]) / DAY : 0;
  const ratePerDay = spanDays > 0 ? n / spanDays : null;
  const medianAge = n ? ages[Math.floor(n / 2)].toFixed(1) : '-';
  return { name, totals, nCards: cards.length, nDated: n, newest, oldest, spanDays: +spanDays.toFixed(2), ratePerDay: ratePerDay ? +ratePerDay.toFixed(1) : null, last7, last30, medianAge };
}

async function fetchPage(url) {
  const t0 = Date.now();
  const res = await getWithRetry(url, { logger: noop });
  const ms = Date.now() - t0;
  if (res.status !== 200) { log('WARN', `${url} -> status ${res.status} (${ms}ms)`); return null; }
  const apollo = apolloOf(res.html);
  if (!apollo) { log('WARN', `${url} -> no apollo state (${ms}ms)`); return null; }
  return { apollo, ms };
}

// Walk newest-first pages, collecting cards, stop when oldest card exceeds STOP_AGE.
async function walkStream({ name, urlFor, parse, totalsFn }) {
  console.log(`\n===== ${name} =====`);
  const all = [];
  let totals = null;
  let pages = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = urlFor(p);
    const r = await fetchPage(url);
    pages++;
    if (!r) break;
    if (p === 1 && totalsFn) totals = totalsFn(r.apollo);
    const cards = parse(r.apollo);
    console.log(`  page ${p}: ${cards.length} cards (${r.ms}ms)`);
    if (cards.length === 0) break;
    all.push(...cards);
    const dated = cards.filter((c) => c.published != null).map((c) => c.published).sort((a, b) => a - b);
    const oldestAge = dated.length ? (NOW - dated[0]) / DAY : 0;
    if (oldestAge > STOP_AGE_DAYS) { console.log(`  (oldest card ${oldestAge.toFixed(1)}d > ${STOP_AGE_DAYS}d cutoff — stop)`); break; }
  }
  fs.writeFileSync(path.join(OUT_DIR, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`),
    JSON.stringify({ totals, cards: all }, null, 2));
  return { all, totals, pages };
}

(async () => {
  console.log(`probe-flow-dimensionality — NOW=${new Date(NOW * 1000).toISOString()} MAX_PAGES=${MAX_PAGES}`);

  // Stream 1: Hemnet FS (national, newest-first)
  const hFS = await walkStream({
    name: 'Hemnet FS',
    urlFor: (p) => `https://www.hemnet.se/bostader?sort=NEWEST&page=${p}`,
    parse: (a) => parseListingCards(a).map((c) => ({ published: c.publishedAt, pre: c.upcoming, form: c.housingForm })),
    totalsFn: hemnetTotals,
  });

  // Stream 2: Hemnet Kommande (national, newest-first)
  const hPM = await walkStream({
    name: 'Hemnet Kommande',
    urlFor: (p) => `https://www.hemnet.se/kommande/bostader?sort=NEWEST&page=${p}`,
    parse: (a) => parseListingCards(a).map((c) => ({ published: c.publishedAt, pre: c.upcoming, form: c.housingForm })),
    totalsFn: hemnetTotals,
  });

  // Stream 3: Booli national (FS + PM interleaved; split by upcomingSale flag)
  const bAll = await walkStream({
    name: 'Booli All',
    urlFor: (p) => `https://www.booli.se/sok/till-salu?page=${p}`,
    parse: (a) => parseBooliSearchCards(a).cards.map((c) => ({ published: c.published, pre: c.upcomingSale, form: c.objectType })),
    totalsFn: booliTotals,
  });

  // ---- Summaries ----
  console.log('\n\n================ SUMMARY ================');
  const rows = [
    summarize('Hemnet FS', hFS.all, hFS.totals),
    summarize('Hemnet Kommande', hPM.all, hPM.totals),
    summarize('Booli ALL', bAll.all, bAll.totals),
    summarize('Booli FS-only', bAll.all.filter((c) => !c.pre), bAll.totals),
    summarize('Booli PM-only', bAll.all.filter((c) => c.pre), bAll.totals),
  ];
  for (const r of rows) {
    console.log(`\n${r.name}`);
    console.log(`  pool total (stock): ${JSON.stringify(r.totals)}`);
    console.log(`  cards walked: ${r.nCards} (dated ${r.nDated}) | newest ${r.newest} .. oldest ${r.oldest} | span ${r.spanDays}d`);
    console.log(`  add-rate (from walked span): ${r.ratePerDay == null ? 'n/a' : r.ratePerDay + '/day → ~' + Math.round(r.ratePerDay * 30) + '/mo'}`);
    console.log(`  exact counts among walked cards: last7d=${r.last7}  last30d=${r.last30}  medianAge=${r.medianAge}d`);
  }

  const ox = getOxylabsStats();
  console.log(`\nOxylabs calls: ${JSON.stringify(ox)}`);
  console.log(`Raw dumps -> ${OUT_DIR}`);
})().catch((e) => { console.error('UNEXPECTED', e); process.exit(1); });
