'use strict';
// scripts/probe-hemnet-kommande-partition.js — feasibility probe for a Hemnet Kommande
// age-penetration census by partition (county vs municipality) to sidestep Hemnet's
// newest-first pagination cap. Answers: (1) does location_ids[] filter /kommande?
// (2) where's the national pagination cap? (3) is the biggest partition under the cap?
// (4) what are the county location_ids? Read-only; ~7 Oxylabs calls.
//
//   SCRAPE_FORCE_OXYLABS=1 node scripts/probe-hemnet-kommande-partition.js
require('dotenv').config();

const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Targets: [label, url]. Add a &location_ids[]= to filter to a partition.
const NAT = (p) => `https://www.hemnet.se/kommande/bostader?sort=NEWEST&page=${p}`;
const LOC = (id, p) => `https://www.hemnet.se/kommande/bostader?location_ids[]=${id}&sort=NEWEST&page=${p}`;

const TARGETS = [
  ['national p1', NAT(1), true],   // true → dump location nodes to find county ids
  ['national p50', NAT(50), false],
  ['national p70', NAT(70), false],
  ['Stockholm MUNI(18031) p1', LOC(18031, 1), false], // biggest single muni → metro breach proxy
  ['Göteborg MUNI(17920) p1', LOC(17920, 1), false],
  ['Alingsås MUNI(17866) p1', LOC(17866, 1), false],  // small muni
  ['Alingsås MUNI(17866) p6', LOC(17866, 6), false],  // expect empty → muni paginates to true end
];

function apolloFrom(html) {
  const data = extractNextData(html);
  const a = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!a) throw new Error('__APOLLO_STATE__ missing');
  return a;
}
function pickTotal(apollo) {
  const root = apollo.ROOT_QUERY || {};
  for (const k of Object.keys(root)) {
    if (k.startsWith('searchUpcomingListings')) { const n = root[k]; if (n && typeof n === 'object') return n.total; }
  }
  return undefined;
}
function ageStats(cards) {
  const ages = cards.filter(c => c.publishedAt != null).map(c => (NOW - c.publishedAt) / DAY).sort((a, b) => a - b);
  if (!ages.length) return { n: 0 };
  return { n: ages.length, min: ages[0].toFixed(1), med: ages[Math.floor(ages.length / 2)].toFixed(1), max: ages[ages.length - 1].toFixed(1) };
}
// Scan apollo for location nodes (counties/municipalities) to harvest county ids.
function dumpLocations(apollo) {
  const out = [];
  for (const [key, node] of Object.entries(apollo)) {
    if (!node || typeof node !== 'object') continue;
    const t = node.__typename || '';
    if (/County|Municipality|Region|Area|District|Location/i.test(key) || /County|Municipality|Region/i.test(t)) {
      out.push({ key, typename: t, id: node.id, name: node.fullName || node.name });
    }
  }
  return out;
}

async function main() {
  resetOxylabsStats();
  for (const [label, url, dump] of TARGETS) {
    try {
      const res = await getWithRetry(url, { logger: () => {} });
      if (res.status !== 200) { console.log(`\n### ${label}: HTTP ${res.status}`); continue; }
      const apollo = apolloFrom(res.html);
      const cards = parseListingCards(apollo);
      const total = pickTotal(apollo);
      const nb = cards.filter(c => c.newConstruction).length;
      const a = ageStats(cards);
      console.log(`\n### ${label}`);
      console.log(`  total(searchUpcomingListings)=${total}  cards=${cards.length}  newbuild=${nb}  ages(d) min/med/max=${a.n ? `${a.min}/${a.med}/${a.max}` : 'none'}`);
      if (cards.length) console.log(`  sample: ${cards.slice(0, 2).map(c => `"${c.streetAddress || c.locationDescription || '?'}"`).join(' | ')}`);
      if (dump) {
        const locs = dumpLocations(apollo);
        const counties = locs.filter(l => /County/i.test(l.typename) || /County/i.test(l.key));
        console.log(`  location nodes: ${locs.length} (counties: ${counties.length})`);
        for (const c of counties.slice(0, 30)) console.log(`    COUNTY id=${c.id} name=${c.name} [${c.typename}]`);
        if (!counties.length) {
          console.log(`  (no County-typed nodes; sample of all location-ish nodes:)`);
          for (const l of locs.slice(0, 20)) console.log(`    ${l.key} id=${l.id} name=${l.name} [${l.typename}]`);
        }
      }
    } catch (e) {
      console.log(`\n### ${label}: ERROR ${e.message}`);
    }
  }
  console.log(`\nOxylabs: ${JSON.stringify(getOxylabsStats())}`);
}
main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
