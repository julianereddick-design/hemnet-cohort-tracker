'use strict';

// sold-serp.js — Search-engine bridge: find a Hemnet /bostad listing for a sold Booli
// property BY ADDRESS, for the booli_only residue (no priced /salda match). A sold
// listing leaves Hemnet's OWN search within days, but its /bostad page stays live and
// search-indexed — so a Sweden-geolocated SERP recovers it retroactively. Validated
// 2026-06-17 (memory: project_sold_match_serp_bridge_validated). Three legs:
//   1) SERP   — Oxylabs google_search (geo=Sweden, google.se) for "hemnet <addr> <area> <muni>"
//   2) FILTER — keep only /bostad URLs whose slug ends with the EXACT street address
//               (rejects same-street neighbours the SERP also returns)
//   3) VERIFY — fetch the /bostad page (Oxylabs; WebFetch gets 403), parse the Active OR
//               Deactivated* listing node, confirm address + living-area (+ rooms) match.
//
// Sold listings live under Deactivated*PropertyListing Apollo nodes (NOT
// ActivePropertyListing) — parseActiveListing in hemnet-fetch returns no-active-listing
// for them, so this module carries its own parseListingNode.
//
// IMPORTANT: set process.env.SCRAPE_FORCE_OXYLABS = '1' BEFORE requiring (scrape-http
// reads it at load). The SERP leg also needs OXYLABS_USERNAME/OXYLABS_PASSWORD.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { getWithRetry, extractNextData } = require('./scrape-http');
const { normAddr } = require('./sold-addr');
const { AREA_AGREE_PCT } = require('./sold-config');

const OXYLABS_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries';
const SERP_TIMEOUT_MS = 90_000;
const SERP_CACHE_DIR = path.join(__dirname, '..', process.env.SPIKE_DIR || 'verf-soldspike', 'serp-cache');

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

// "141 m²" / "3,5 rum" → 141 / 3.5
function parseFormattedNum(s) {
  if (s == null) return null;
  const m = String(s).replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(',', '.')) : null;
}

// Transliterate a Swedish address into the Hemnet slug token form:
//   "Västra Röd 295" -> "vastra-rod-295", "Åkergatan 10C" -> "akergatan-10c"
function slugifyAddr(s) {
  if (s == null) return null;
  return String(s)
    .toLowerCase()
    .replace(/å|ä/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e').replace(/ü/g, 'u').replace(/ø/g, 'o')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// listing id = trailing -<digits> of a /bostad slug URL
function listingIdFromUrl(url) {
  const m = String(url).match(/-(\d+)\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

// Does this /bostad URL's slug correspond to the EXACT street address?
// slug = "/bostad/<type>-<rooms>-<...location...>-<street>-<number>-<listingId>"
// Require the slug core (minus the trailing -<id>) to END WITH the slugified address,
// so "...-vastra-rod-295" matches "Västra Röd 295" but "...-vastra-rod-210" does not.
function slugMatchesAddress(url, address) {
  const a = slugifyAddr(address);
  if (!a) return false;
  const m = String(url).match(/\/bostad\/([a-z0-9-]+?)-(\d+)\/?(?:[?#].*)?$/i);
  if (!m) return false;
  const core = m[1];
  return core === a || core.endsWith('-' + a);
}

// Find the Active OR Deactivated* property-listing node carrying a street address.
// Prefer the node whose id matches listingId; else the first address-bearing node.
function parseListingNode(apollo, listingId) {
  if (!apollo || typeof apollo !== 'object') return null;
  let best = null;
  for (const [k, v] of Object.entries(apollo)) {
    if (!/PropertyListing:/.test(k)) continue;
    if (!v || typeof v !== 'object' || !v.streetAddress) continue;
    const ap = v.askingPrice;
    const fee = v.fee;
    const node = {
      key: k,
      typename: v.__typename || null,
      id: v.id != null ? String(v.id) : null,
      streetAddress: v.streetAddress,
      livingArea: num(v.livingArea) != null ? num(v.livingArea) : parseFormattedNum(v.formattedLivingArea),
      rooms: num(v.numberOfRooms) != null ? num(v.numberOfRooms)
        : (num(v.rooms) != null ? num(v.rooms) : parseFormattedNum(v.formattedNumberOfRooms)),
      askingPrice: ap && typeof ap === 'object' ? num(ap.amount) : num(ap),
      fee: fee && typeof fee === 'object' ? num(fee.amount) : num(fee),
      housingForm: v.housingForm ? (v.housingForm.name || v.housingForm.symbol || null) : null,
      district: typeof v.area === 'string' ? v.area : null,
      labels: Array.isArray(v.labels) ? v.labels.map((l) => l && l.identifier).filter(Boolean) : [],
      active: /^ActivePropertyListing/.test(v.__typename || ''),
    };
    if (listingId && node.id === String(listingId)) return node;
    if (!best) best = node;
  }
  return best;
}

// Oxylabs google_search SERP (geo=Sweden, google.se). Disk-cached by query so reruns
// and smokes cost nothing. Returns an array of organic result URLs.
// opts.reserve: optional async () => void — reserve one Oxylabs call against the live
//   ceiling BEFORE a cache-miss POST (pass sold-transport.reserveOxylabsCall in prod so
//   the SERP leg counts against MAX_OXY_CALLS / the DB ceiling). Throws CeilingError to abort.
async function serp(query, opts = {}) {
  const log = opts.logger || (() => {});
  fs.mkdirSync(SERP_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(SERP_CACHE_DIR, crypto.createHash('sha1').update(query).digest('hex') + '.json');
  if (fs.existsSync(cacheFile)) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).urls || []; } catch (_) { /* refetch */ }
  }
  // Live call ahead — reserve against the ceiling (cache hits above never reach here).
  if (typeof opts.reserve === 'function') await opts.reserve();
  return await new Promise((resolve, reject) => {
    const username = process.env.OXYLABS_USERNAME;
    const password = process.env.OXYLABS_PASSWORD;
    if (!username || !password) return reject(new Error('OXYLABS creds missing'));
    const body = JSON.stringify({
      source: 'google_search', query, domain: 'se', geo_location: 'Sweden', locale: 'sv-se', parse: true,
    });
    const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const req = https.request(OXYLABS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: auth },
      timeout: SERP_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`serp api-non-200 ${res.statusCode}`));
        let json; try { json = JSON.parse(txt); } catch { return reject(new Error('serp parse-error')); }
        const urls = new Set();
        try {
          const organic = json?.results?.[0]?.content?.results?.organic || [];
          for (const o of organic) if (o && o.url) urls.add(o.url);
        } catch (_) { /* fall through to raw scan */ }
        // raw-text fallback: catch /bostad URLs the structured path missed
        for (const u of (txt.match(/https?:\/\/www\.hemnet\.se\/bostad\/[a-z0-9-]+/gi) || [])) urls.add(u);
        const arr = [...urls];
        try { fs.writeFileSync(cacheFile, JSON.stringify({ query, urls: arr, at: new Date().toISOString() })); } catch (_) {}
        log('SERP', `${query} -> ${arr.length} urls`);
        resolve(arr);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('serp timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// findHemnetListingByAddress — the full bridge for one Booli sold record.
// record: { street_address, descriptive_area, municipality, living_area, rooms, ... }
// opts:  { family, logger, fetch (url->{status,html}, default getWithRetry), maxFetch,
//          areaPct, reserve (async ()=>void: reserve the SERP call against the ceiling) }
// Returns { found, url?, listingId?, node?, verified?, reason? }.
async function findHemnetListingByAddress(record, opts = {}) {
  const log = opts.logger || (() => {});
  const fetcher = opts.fetch || ((url) => getWithRetry(url, { logger: () => {} }));
  const addr = record && record.street_address;
  if (!addr) return { found: false, reason: 'no-address' };

  const query = ['hemnet', addr, record.descriptive_area || '', record.municipality || '']
    .filter(Boolean).join(' ');
  let organic;
  try { organic = await serp(query, { logger: log, reserve: opts.reserve }); }
  catch (e) {
    if (e && (e.code === 'OXY_CEILING' || e.name === 'CeilingError')) throw e;  // ceiling must propagate
    return { found: false, reason: 'serp-error', error: e.message };
  }

  // exact-address /bostad candidates (dedup by listing id)
  const cands = [];
  const seen = new Set();
  let bostadSeen = 0;
  for (const u of organic) {
    if (!/hemnet\.se\/bostad\//i.test(u)) continue;
    bostadSeen++;
    if (!slugMatchesAddress(u, addr)) continue;
    const id = listingIdFromUrl(u);
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    cands.push(u);
  }
  if (cands.length === 0) return { found: false, reason: 'no-exact-slug', serp_bostad: bostadSeen };

  const cap = opts.maxFetch != null ? opts.maxFetch : 3;
  const areaTol = opts.areaPct != null ? opts.areaPct : Math.max(AREA_AGREE_PCT, 0.10);
  const recArea = num(record.living_area);
  const recRooms = num(record.rooms);
  let resolvedAny = null;

  for (const url of cands.slice(0, cap)) {
    let res;
    try { res = await fetcher(url); }
    catch (e) { if (e && (e.code === 'OXY_CEILING' || e.name === 'CeilingError')) throw e; continue; }
    if (!res || res.status !== 200) continue;
    const apollo = extractNextData(res.html)?.props?.pageProps?.__APOLLO_STATE__;
    const node = parseListingNode(apollo, listingIdFromUrl(url));
    if (!node) continue;
    if (!resolvedAny) resolvedAny = url;

    const addrOk = normAddr(node.streetAddress) === normAddr(addr);
    const areaOk = node.livingArea != null && recArea != null
      ? Math.abs(node.livingArea - recArea) / recArea <= areaTol : null;
    const roomsOk = node.rooms != null && recRooms != null
      ? Math.round(node.rooms) === Math.round(recRooms) : null;

    // Identity (Phase-14 model): exact address (unit signal) + ≥1 corroborating
    // (living-area within tol, or rooms equal). Reject a same-address different unit
    // (rooms known on both and differ).
    if (addrOk && roomsOk === false) continue;
    const corroborated = areaOk === true || roomsOk === true;
    if (addrOk && corroborated) {
      return {
        found: true, url, listingId: node.id, node,
        verified: { addrOk, areaOk, roomsOk },
        state: node.active ? 'active' : (node.labels.includes('SOLD') ? 'sold' : 'deactivated'),
      };
    }
  }
  return { found: false, reason: 'unverified', candidates: cands.length, resolved: resolvedAny };
}

module.exports = {
  slugifyAddr,
  slugMatchesAddress,
  listingIdFromUrl,
  parseListingNode,
  serp,
  findHemnetListingByAddress,
};

// ---------------------------------------------------------------------------
// Inline smoke — node lib/sold-serp.js --smoke   (offline: pure helpers only)
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  check('slugifyAddr transliterates å/ä/ö and spaces', () => {
    assert.strictEqual(slugifyAddr('Västra Röd 295'), 'vastra-rod-295');
    assert.strictEqual(slugifyAddr('Åkergatan 10C'), 'akergatan-10c');
    assert.strictEqual(slugifyAddr('Östra Porten 47'), 'ostra-porten-47');
  });
  check('slugMatchesAddress accepts exact, rejects same-street neighbour', () => {
    const hit = 'https://www.hemnet.se/bostad/villa-6rum-harestad-kungalvs-kommun-vastra-rod-295-21733498';
    const neigh = 'https://www.hemnet.se/bostad/villa-5rum-harestad-kungalvs-kommun-vastra-rod-210-16732243';
    assert.strictEqual(slugMatchesAddress(hit, 'Västra Röd 295'), true);
    assert.strictEqual(slugMatchesAddress(neigh, 'Västra Röd 295'), false);
  });
  check('slugMatchesAddress handles apt entrance letter', () => {
    const u = 'https://www.hemnet.se/bostad/lagenhet-4rum-centralt-kungalvs-kommun-akergatan-10c-21613146';
    assert.strictEqual(slugMatchesAddress(u, 'Åkergatan 10C'), true);
    assert.strictEqual(slugMatchesAddress(u, 'Åkergatan 10'), false);
  });
  check('listingIdFromUrl extracts trailing id', () => {
    assert.strictEqual(listingIdFromUrl('https://www.hemnet.se/bostad/villa-...-vastra-rod-295-21733498'), '21733498');
  });
  check('parseListingNode reads Deactivated node (Money askingPrice, formatted area)', () => {
    const apollo = {
      'BrokerAgency:1': { streetAddress: 'Gymnasiegatan 2' }, // decoy (no listing key)
      'DeactivatedPropertyListing:21733498': {
        __typename: 'DeactivatedPropertyListing', id: '21733498', streetAddress: 'Västra Röd 295',
        area: 'Harestad', livingArea: 141, numberOfRooms: 6,
        askingPrice: { amount: 4495000 }, fee: null,
        housingForm: { name: 'Villa', symbol: 'HOUSE' },
        labels: [{ identifier: 'REMOVED' }],
      },
    };
    // BrokerAgency:1 lacks "PropertyListing:" so is skipped; the listing node is found.
    const n = parseListingNode(apollo, '21733498');
    assert.strictEqual(n.streetAddress, 'Västra Röd 295');
    assert.strictEqual(n.livingArea, 141);
    assert.strictEqual(n.rooms, 6);
    assert.strictEqual(n.askingPrice, 4495000);
    assert.strictEqual(n.housingForm, 'Villa');
    assert.strictEqual(n.active, false);
  });
  check('parseListingNode prefers id match over first', () => {
    const apollo = {
      'DeactivatedPropertyListing:111': { __typename: 'DeactivatedPropertyListing', id: '111', streetAddress: 'A 1' },
      'DeactivatedPropertyListing:222': { __typename: 'DeactivatedPropertyListing', id: '222', streetAddress: 'B 2' },
    };
    assert.strictEqual(parseListingNode(apollo, '222').streetAddress, 'B 2');
  });

  // findHemnetListingByAddress with injected serp + fetch (no network)
  (async () => {
    const apolloOf = (over) => ({ props: { pageProps: { __APOLLO_STATE__: {
      'DeactivatedPropertyListing:21733498': Object.assign({
        __typename: 'DeactivatedPropertyListing', id: '21733498', streetAddress: 'Västra Röd 295',
        livingArea: 141, numberOfRooms: 6, askingPrice: { amount: 4495000 }, labels: [{ identifier: 'REMOVED' }],
      }, over) } } } });
    const htmlOf = (over) => '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(apolloOf(over)) + '</script>';

    // monkeypatch serp via module cache: write a cache file the real serp() will read
    const rec = { street_address: 'Västra Röd 295', descriptive_area: 'Harestad', municipality: 'Kungälv', living_area: 141, rooms: 6 };
    const q = ['hemnet', rec.street_address, rec.descriptive_area, rec.municipality].join(' ');
    fs.mkdirSync(SERP_CACHE_DIR, { recursive: true });
    const cf = path.join(SERP_CACHE_DIR, crypto.createHash('sha1').update(q).digest('hex') + '.json');
    fs.writeFileSync(cf, JSON.stringify({ query: q, urls: [
      'https://www.hemnet.se/bostad/villa-5rum-harestad-kungalvs-kommun-vastra-rod-210-16732243', // neighbour
      'https://www.hemnet.se/bostad/villa-6rum-harestad-kungalvs-kommun-vastra-rod-295-21733498', // target
    ] }));

    const fakeFetch = async (url) => ({ status: 200, html: htmlOf({}) });
    const r = await findHemnetListingByAddress(rec, { family: 'HOUSE', fetch: fakeFetch });
    check('bridge finds exact-address listing, verifies area/rooms', () => {
      assert.strictEqual(r.found, true);
      assert.strictEqual(r.listingId, '21733498');
      assert.strictEqual(r.verified.addrOk, true);
      assert.strictEqual(r.verified.areaOk, true);
    });

    // same address but rooms differ on both sides → reject (different unit)
    const fakeFetchWrongRooms = async () => ({ status: 200, html: htmlOf({ numberOfRooms: 2, livingArea: 45 }) });
    const r2 = await findHemnetListingByAddress({ ...rec, rooms: 6, living_area: 141 }, { family: 'APARTMENT', fetch: fakeFetchWrongRooms });
    check('bridge rejects same-address different-unit (rooms+area differ)', () => {
      assert.strictEqual(r2.found, false);
    });

    // no exact-slug candidate (only neighbour) → not found
    const q2 = ['hemnet', 'Myrebackavägen 133', 'Kareby', 'Kungälv'].join(' ');
    const cf2 = path.join(SERP_CACHE_DIR, crypto.createHash('sha1').update(q2).digest('hex') + '.json');
    fs.writeFileSync(cf2, JSON.stringify({ query: q2, urls: [
      'https://www.hemnet.se/bostad/villa-5rum-kareby-kungalvs-kommun-myrebackavagen-99-12345678',
    ] }));
    const r3 = await findHemnetListingByAddress({ street_address: 'Myrebackavägen 133', descriptive_area: 'Kareby', municipality: 'Kungälv', living_area: 150, rooms: 5 }, { fetch: fakeFetch });
    check('bridge returns no-exact-slug when only neighbours indexed', () => {
      assert.strictEqual(r3.found, false);
      assert.strictEqual(r3.reason, 'no-exact-slug');
    });

    // cleanup smoke cache files
    for (const f of [cf, cf2]) { try { fs.unlinkSync(f); } catch (_) {} }

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((e) => { console.error('SMOKE uncaught', e); process.exit(1); });
}
