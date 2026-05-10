'use strict';

// probe-oxylabs.js — validate the Oxylabs Web Scraper API against Hemnet
// before committing to integrate it into lib/hemnet-fetch.js.
//
// Submits a small batch of Hemnet URLs (mix of search pages and detail pages,
// including ones that just 403'd directly via curl) through Oxylabs'
// realtime endpoint, then verifies the returned HTML contains the same
// __NEXT_DATA__ shape we already parse.
//
// Reads OXYLABS_USERNAME / OXYLABS_PASSWORD from .env (already gitignored).
// Does NOT touch lib/hemnet-fetch.js — stays outside Phase 8's protected
// files. This script is purely diagnostic.
//
// Usage (from hemnet-cohort-tracker/):
//   node scripts/probe-oxylabs.js
//
// Pass criteria:
//   - >= 6 of 8 probes return HTTP 200 with parseable __NEXT_DATA__
//   - >= 1 search page yields >= 10 ListingCards
//   - >= 1 detail page yields ActivePropertyListing with streetAddress + postCode
//   - The previously-403'ing URL bostad/21686679 returns successfully

require('dotenv').config();

const https = require('https');

const ENDPOINT = 'https://realtime.oxylabs.io/v1/queries';
const USERNAME = process.env.OXYLABS_USERNAME;
const PASSWORD = process.env.OXYLABS_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('FATAL: OXYLABS_USERNAME and/or OXYLABS_PASSWORD missing from .env');
  process.exit(1);
}

const PROBES = [
  // Search pages (the path Phase 8 search-page failures hit hardest)
  { url: 'https://www.hemnet.se/bostader?location_ids[]=17951&sort=NEWEST&page=1', kind: 'search', muni: 'Järfälla', page: 1 },
  { url: 'https://www.hemnet.se/bostader?location_ids[]=17884&sort=NEWEST&page=2', kind: 'search', muni: 'Borås',    page: 2 },
  { url: 'https://www.hemnet.se/bostader?location_ids[]=18043&sort=NEWEST&page=3', kind: 'search', muni: 'Landskrona', page: 3 },
  { url: 'https://www.hemnet.se/bostader?location_ids[]=17865&sort=NEWEST&page=1', kind: 'search', muni: 'Ale',      page: 1 },
  // Detail pages — including the one that persistently 403'd in isolation
  { url: 'https://www.hemnet.se/bostad/21703513', kind: 'detail', tag: 'known-good (Kalvshällavägen 42)' },
  { url: 'https://www.hemnet.se/bostad/21708066', kind: 'detail', tag: 'Upplands-Bro probe (curl-failed)' },
  { url: 'https://www.hemnet.se/bostad/21686679', kind: 'detail', tag: 'Håbo probe (PERSISTENT-403 in isolation)' },
  { url: 'https://www.hemnet.se/bostad/21430153', kind: 'detail', tag: 'Göteborg probe (no-active-listing)' },
];

function postOxylabs(url) {
  const body = JSON.stringify({
    source: 'universal',
    url,
    geo_location: 'Sweden',
    user_agent_type: 'desktop',
  });
  const auth = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: auth,
        },
        timeout: 90_000,
      },
      (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return resolve({ ok: false, oxStatus: res.statusCode, body: txt.slice(0, 500) });
          }
          try {
            const json = JSON.parse(txt);
            const result = (json.results && json.results[0]) || null;
            if (!result) return resolve({ ok: false, reason: 'no results[0]', body: txt.slice(0, 500) });
            resolve({
              ok: true,
              oxStatus: 200,
              targetStatus: result.status_code,
              html: result.content || '',
              ms: result.created_at && result.updated_at ? null : null,
            });
          } catch (e) {
            resolve({ ok: false, reason: 'json-parse', err: e.message, body: txt.slice(0, 500) });
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

function extractApolloState(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) return { ok: false, reason: 'no __NEXT_DATA__' };
  let next;
  try {
    next = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, reason: 'json-parse-next-data', err: e.message };
  }
  const apollo = next.props && next.props.pageProps && next.props.pageProps.__APOLLO_STATE__;
  if (!apollo || typeof apollo !== 'object') return { ok: false, reason: 'no apollo state' };
  return { ok: true, apollo };
}

function summarizeSearch(apollo) {
  // ListingCard objects have __typename: 'PropertyListingCard' or 'ListingCard' depending on schema.
  // Be permissive — find any keys that look like cards with streetAddress.
  const cards = [];
  for (const v of Object.values(apollo)) {
    if (v && typeof v === 'object' && v.__typename && /Listing/.test(v.__typename) && v.streetAddress) {
      cards.push({ id: v.id, addr: v.streetAddress });
    }
  }
  return { cardCount: cards.length, sample: cards.slice(0, 3) };
}

function summarizeDetail(apollo) {
  let active = null;
  for (const v of Object.values(apollo)) {
    if (v && typeof v === 'object' && v.__typename === 'ActivePropertyListing') {
      active = v;
      break;
    }
  }
  if (!active) return { hasActive: false };
  return {
    hasActive: true,
    id: active.id,
    streetAddress: active.streetAddress,
    postCode: active.postCode,
    timesViewed: active.timesViewed,
  };
}

(async () => {
  console.log(`Probing Oxylabs Web Scraper API with ${PROBES.length} Hemnet URLs...\n`);
  let pass = 0;
  let fail = 0;
  const results = [];

  for (const p of PROBES) {
    const t0 = Date.now();
    process.stdout.write(`[${p.kind.padEnd(6)}] ${p.url.slice(0, 90).padEnd(90)} ... `);
    let res;
    try {
      res = await postOxylabs(p.url);
    } catch (e) {
      console.log(`FAIL (req error: ${e.message})`);
      fail++;
      results.push({ ...p, ok: false, reason: 'req-error', err: e.message });
      continue;
    }
    const ms = Date.now() - t0;

    if (!res.ok) {
      console.log(`FAIL (oxStatus=${res.oxStatus} ${res.reason || ''}, ${ms}ms)`);
      fail++;
      results.push({ ...p, ok: false, oxStatus: res.oxStatus, reason: res.reason, snippet: (res.body || '').slice(0, 200), ms });
      continue;
    }
    if (res.targetStatus !== 200) {
      console.log(`FAIL (targetStatus=${res.targetStatus}, ${ms}ms)`);
      fail++;
      results.push({ ...p, ok: false, targetStatus: res.targetStatus, ms });
      continue;
    }
    const ext = extractApolloState(res.html);
    if (!ext.ok) {
      console.log(`FAIL (parse: ${ext.reason}, ${ms}ms)`);
      fail++;
      results.push({ ...p, ok: false, reason: ext.reason, ms });
      continue;
    }
    if (p.kind === 'search') {
      const s = summarizeSearch(ext.apollo);
      console.log(`OK (cards=${s.cardCount}, ${ms}ms)`);
      results.push({ ...p, ok: true, ...s, ms });
    } else {
      const s = summarizeDetail(ext.apollo);
      if (!s.hasActive) {
        console.log(`OK-but-no-active (${ms}ms) — listing may legitimately be inactive`);
      } else {
        console.log(`OK (${s.streetAddress} / postCode=${s.postCode} / views=${s.timesViewed}, ${ms}ms)`);
      }
      results.push({ ...p, ok: true, ...s, ms });
    }
    pass++;
  }

  console.log('');
  console.log('---------------------------------------------------------------');
  console.log(`oxylabs probe: ${pass} pass, ${fail} fail (of ${PROBES.length})`);
  const avgMs = Math.round(
    results.filter((r) => r.ms != null).reduce((a, r) => a + r.ms, 0) /
      Math.max(1, results.filter((r) => r.ms != null).length),
  );
  console.log(`average per-request latency: ${avgMs}ms`);
  console.log('---------------------------------------------------------------');

  // Headline checks
  const searches = results.filter((r) => r.kind === 'search' && r.ok);
  const details = results.filter((r) => r.kind === 'detail' && r.ok);
  const big = searches.find((r) => (r.cardCount || 0) >= 10);
  const detail = details.find((r) => r.hasActive && r.streetAddress && r.postCode != null);
  const persistent403 = results.find((r) => r.url.includes('21686679'));

  console.log(`>= 1 search yielded >= 10 cards:           ${big ? `YES (${big.cardCount} cards from ${big.muni} p${big.page})` : 'NO'}`);
  console.log(`>= 1 detail yielded ActivePropertyListing: ${detail ? `YES (${detail.streetAddress} ${detail.postCode})` : 'NO'}`);
  console.log(`bostad/21686679 (persistent-403):          ${persistent403 && persistent403.ok ? 'YES — Oxylabs got it' : 'NO'}`);

  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('UNEXPECTED:', e);
  process.exit(1);
});
