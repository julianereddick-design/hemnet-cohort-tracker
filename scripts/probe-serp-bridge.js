// scripts/probe-serp-bridge.js — Search-engine-bridge feasibility probe (2026-06-17).
//
// Question (from memory sold-match-recency-listing, option (b) SEARCH-ENGINE BRIDGE):
// A sold Booli property's Hemnet /bostad listing is removed from Hemnet's OWN search
// within days, but the /bostad page stays live by direct URL (search-indexed). Can a
// production-realistic SERP — Oxylabs google_search, geo=Sweden — retrieve that /bostad
// URL from just the address? This is the RETROACTIVE recall test the WebSearch tool
// (US-only index) failed (1/7 recent listings).
//
// For each test address: POST source=google_search to Oxylabs realtime, parse organic
// results, and report whether ANY hemnet.se/bostad URL surfaced (and which).
//
//   node scripts/probe-serp-bridge.js
//
// Cost: ~1 Oxylabs SERP call per address (parse=true). Read-only; writes no DB rows.

require('dotenv').config();
const https = require('https');

const OXYLABS_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries';
const TIMEOUT_MS = 90_000;

// gt = ground-truth from operator manual check (memory sold-match-recency-listing):
//   on-hemnet  → confirmed present as a /bostad listing (lag false-positive)
//   unknown    → not manually adjudicated
const TESTS = [
  // --- recent Kungälv villas (sold Jun 4-16) ---
  { label: 'Västra Röd 295 (villa, Harestad)', query: 'hemnet Västra Röd 295 Harestad Kungälv', gt: 'on-hemnet' },
  { label: 'Ranneberg 182 (villa, Romelanda)', query: 'hemnet Ranneberg 182 Romelanda Kungälv', gt: 'on-hemnet' },
  { label: 'Nygatan 42 (radhus, Marstrand)', query: 'hemnet Nygatan 42 Marstrand Kungälv', gt: 'unknown' },
  { label: 'Flateby 562 (villa, Kärna)', query: 'hemnet Flateby 562 Kärna Kungälv', gt: 'unknown' },
  { label: 'Myrebackavägen 133 (villa, Kareby)', query: 'hemnet Myrebackavägen 133 Kareby Kungälv', gt: 'unknown' },
  { label: 'Västra Röd 340 (villa, Harestad)', query: 'hemnet Västra Röd 340 Harestad Kungälv', gt: 'unknown' },
  // --- recent Kungälv apts operator confirmed on-Hemnet ---
  { label: 'Östra Porten 47 (apt)', query: 'hemnet Östra Porten 47 Kungälv', gt: 'on-hemnet' },
  { label: 'Åkergatan 10C (apt)', query: 'hemnet Åkergatan 10C Kungälv', gt: 'on-hemnet' },
];

function serp(query) {
  return new Promise((resolve, reject) => {
    const username = process.env.OXYLABS_USERNAME;
    const password = process.env.OXYLABS_PASSWORD;
    if (!username || !password) return reject(new Error('OXYLABS creds missing in .env'));
    const body = JSON.stringify({
      source: 'google_search',
      query,
      domain: 'se',
      geo_location: 'Sweden',
      locale: 'sv-se',
      parse: true,
    });
    const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const req = https.request(
      OXYLABS_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: auth,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`api-non-200 ${res.statusCode}: ${txt.slice(0, 200)}`));
          let json;
          try { json = JSON.parse(txt); } catch { return reject(new Error('parse-error')); }
          resolve({ json, raw: txt });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Pull every hemnet.se/bostad URL out of the organic results (structured), with a
// raw-text fallback in case the parsed shape differs.
function extractBostad(json, raw) {
  const urls = new Set();
  try {
    const organic = json?.results?.[0]?.content?.results?.organic || [];
    for (const o of organic) if (o?.url) urls.add(o.url);
  } catch { /* fall through to raw scan */ }
  const bostad = [...urls].filter((u) => /hemnet\.se\/bostad\//.test(u));
  // raw fallback: catch /bostad URLs anywhere in the payload the structured path missed
  const rawHits = (raw.match(/https?:\/\/www\.hemnet\.se\/bostad\/[a-z0-9-]+/gi) || []);
  for (const u of rawHits) if (!bostad.includes(u)) bostad.push(u);
  return { allOrganic: [...urls], bostad: [...new Set(bostad)] };
}

(async () => {
  console.log('=== SERP bridge probe (Oxylabs google_search, geo=Sweden, google.se) ===\n');
  let found = 0;
  const summary = [];
  for (const t of TESTS) {
    process.stdout.write(`[${t.gt.padEnd(9)}] ${t.label}\n  q="${t.query}"\n`);
    try {
      const { json, raw } = await serp(t.query);
      const { allOrganic, bostad } = extractBostad(json, raw);
      if (bostad.length) {
        found++;
        console.log(`  -> /bostad HIT (${bostad.length}):`);
        bostad.slice(0, 6).forEach((u) => console.log(`       ${u}`));
      } else {
        console.log(`  -> NO /bostad URL. organic top:`);
        allOrganic.slice(0, 4).forEach((u) => console.log(`       ${u}`));
      }
      summary.push({ label: t.label, gt: t.gt, hit: bostad.length > 0, bostad });
    } catch (e) {
      console.log(`  -> ERROR: ${e.message}`);
      summary.push({ label: t.label, gt: t.gt, hit: false, error: e.message });
    }
    console.log('');
  }
  console.log('=== SUMMARY ===');
  console.log(`/bostad found: ${found}/${TESTS.length}`);
  const pos = summary.filter((s) => s.gt === 'on-hemnet');
  const posHit = pos.filter((s) => s.hit).length;
  console.log(`known-positive recall: ${posHit}/${pos.length}`);
  for (const s of summary) {
    console.log(`  ${s.hit ? 'HIT ' : 'miss'} [${s.gt}] ${s.label}${s.error ? ' (' + s.error + ')' : ''}`);
  }
})();
