// scripts/probe-serp-verify.js — fetch+verify leg of the search-engine bridge.
//
// WebFetch hits HTTP 403 on Hemnet /bostad pages (bot protection). Production already
// fetches Hemnet via Oxylabs universal (SCRAPE_FORCE_OXYLABS=1). This confirms a SERP-
// discovered /bostad URL for a SOLD property (a) fetches 200 via Oxylabs, and (b) yields
// enough to verify it's the right property (address/area/rooms) and its listing status.
//
//   SCRAPE_FORCE_OXYLABS=1 node scripts/probe-serp-verify.js
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();
const { getWithRetry, extractNextData } = require('../lib/scrape-http');

// SERP-discovered exact-address /bostad URLs from probe-serp-bridge.js
const URLS = [
  { label: 'Västra Röd 295 (villa)', url: 'https://www.hemnet.se/bostad/villa-6rum-harestad-kungalvs-kommun-vastra-rod-295-21733498' },
  { label: 'Åkergatan 10C (apt, fresh id)', url: 'https://www.hemnet.se/bostad/lagenhet-4rum-centralt-kungalvs-kommun-akergatan-10c-21613146' },
];

// Walk the Apollo state for any node carrying a streetAddress + living area/rooms, and
// note whether the listing is Active vs Sold/removed.
function summarize(apollo) {
  const hits = [];
  let active = false, sold = false;
  for (const [k, v] of Object.entries(apollo)) {
    if (!v || typeof v !== 'object') continue;
    if (k.startsWith('ActivePropertyListing:')) active = true;
    if (/Sold|SaleCard|sold/i.test(k)) sold = true;
    if (typeof v.streetAddress === 'string') {
      hits.push({
        node: k,
        streetAddress: v.streetAddress,
        livingArea: v.livingArea ?? v.area ?? null,
        rooms: v.numberOfRooms ?? v.rooms ?? null,
        price: v.askingPrice?.amount ?? v.askingPrice ?? v.sellingPrice?.amount ?? null,
      });
    }
  }
  return { active, sold, hits };
}

(async () => {
  for (const { label, url } of URLS) {
    console.log(`\n=== ${label} ===\n${url}`);
    try {
      const res = await getWithRetry(url, {});
      console.log(`  HTTP status: ${res.status}`);
      if (res.status !== 200) { console.log('  (non-200, skipping parse)'); continue; }
      const data = extractNextData(res.html);
      const apollo = data?.props?.pageProps?.__APOLLO_STATE__;
      if (!apollo) { console.log('  no __APOLLO_STATE__'); continue; }
      const { active, sold, hits } = summarize(apollo);
      console.log(`  listing state: active=${active} sold/removed=${sold}`);
      console.log(`  address-bearing nodes (${hits.length}):`);
      hits.slice(0, 8).forEach((h) =>
        console.log(`    [${h.node}] "${h.streetAddress}" area=${h.livingArea} rooms=${h.rooms} price=${h.price}`));
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }
})();
