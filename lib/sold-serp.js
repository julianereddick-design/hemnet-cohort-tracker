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

// null/undefined/'' are UNKNOWN (not 0) — Number(null)===0 would otherwise read a
// missing fee/area as a real 0 and reject every real match.
function num(x) { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }

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

// Parse a Hemnet Money value. askingPrice carries {amount, formatted}; fee (avgift)
// carries ONLY {formatted: "4 852 kr"} (no amount), so fall back to parsing the string.
function parseMoney(m) {
  if (m == null) return null;
  if (typeof m === 'object') return num(m.amount) != null ? num(m.amount) : parseFormattedNum(m.formatted);
  return num(m);
}

// Floor embedded in a Hemnet apartment address suffix: "Frejgatan 53, 2 tr" -> 2.
function floorFromAddress(s) {
  const m = s && String(s).match(/,\s*(\d+)\s*tr\b/i);
  return m ? Number(m[1]) : null;
}

// Does this /bostad URL's slug belong to the given municipality? Hemnet slugs embed
// "<kommun>-kommun" (".../stockholms-kommun-...", ".../kungalvs-kommun-..."). Used to keep
// BROADENED queries (which drop the muni term) from matching a same-named street in a
// different kommun. Unknown muni → don't gate.
function slugMatchesMunicipality(url, muni) {
  const m = slugifyAddr(muni);
  if (!m) return true;
  return new RegExp(m + 's?-kommun').test(String(url).toLowerCase());
}

// Ordered SERP query variants, precise-FIRST. Later variants drop the (sometimes wrong /
// over-specific) descriptive-area term, then the municipality, to recover listings the
// full query's phrasing or index coverage didn't surface. Deduped; broadened variants are
// only consulted when earlier ones yield no verified match (see findHemnetListingByAddress).
function buildQueries(record) {
  const addr = record.street_address;
  const area = record.descriptive_area || '';
  const muni = record.municipality || '';
  return [...new Set([
    ['hemnet', addr, area, muni].filter(Boolean).join(' '),
    ['hemnet', addr, muni].filter(Boolean).join(' '),
    ['hemnet', addr].filter(Boolean).join(' '),
  ])];
}

// Find the Active OR Deactivated* property-listing node carrying a street address.
// Prefer the node whose id matches listingId; else the first address-bearing node.
function parseListingNode(apollo, listingId) {
  if (!apollo || typeof apollo !== 'object') return null;
  let best = null;
  for (const [k, v] of Object.entries(apollo)) {
    if (!/PropertyListing:/.test(k)) continue;
    if (!v || typeof v !== 'object' || !v.streetAddress) continue;
    const broRef = v.broker && v.broker.__ref ? apollo[v.broker.__ref] : null;
    const agRef = v.brokerAgency && v.brokerAgency.__ref ? apollo[v.brokerAgency.__ref] : null;
    const node = {
      key: k,
      typename: v.__typename || null,
      id: v.id != null ? String(v.id) : null,
      streetAddress: v.streetAddress,
      livingArea: num(v.livingArea) != null ? num(v.livingArea) : parseFormattedNum(v.formattedLivingArea),
      rooms: num(v.numberOfRooms) != null ? num(v.numberOfRooms)
        : (num(v.rooms) != null ? num(v.rooms) : parseFormattedNum(v.formattedNumberOfRooms)),
      askingPrice: parseMoney(v.askingPrice),
      fee: parseMoney(v.fee), // monthly avgift — apartments carry {formatted} only (no amount)
      postCode: typeof v.postCode === 'string' ? v.postCode : (v.postCode != null ? String(v.postCode) : null),
      floor: floorFromAddress(v.streetAddress),
      brokerName: broRef ? (broRef.name || broRef.fullName || null) : null,
      agencyName: agRef ? (agRef.name || null) : null,
      housingForm: v.housingForm ? (v.housingForm.name || v.housingForm.symbol || null) : null,
      district: typeof v.area === 'string' ? v.area : null,
      labels: Array.isArray(v.labels) ? v.labels.map((l) => l && l.identifier).filter(Boolean) : [],
      isSold: v.isSold === true,
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

  const muni = record.municipality || null;
  const cap = opts.maxFetch != null ? opts.maxFetch : 4; // TOTAL /bostad fetch budget across variants
  const isHouse = opts.family === 'HOUSE';
  const aptAreaTol = opts.areaPct != null ? opts.areaPct : Math.max(AREA_AGREE_PCT, 0.10); // ~10% (apt unit disambig)
  const villaAreaTol = opts.villaAreaTol != null ? opts.villaAreaTol : 0.35;                // wide sanity guard only
  const recArea = num(record.living_area);
  const recRooms = num(record.rooms);
  // Booli fee (avgift). Path A (apt fee-mismatch) already set record.rent; otherwise it's
  // null and we fetch it LAZILY — once, only after an exact-address candidate is in hand.
  let booliFee = num(record.rent);
  let feeFetchTried = false;

  // SERP recall hardening: precise→broad query variants, escalating ONLY when earlier ones
  // yield no VERIFIED match. DEFAULT-OFF (serpVariants=1, full query only) — the broadening
  // added 0 recall in the 2026-06-18 residue test while costing extra calls on misses; opt
  // in with serpVariants>1 if a future window shows phrasing/index misses. Candidates dedup
  // by listing id across variants.
  const maxVariants = opts.serpVariants != null ? Math.max(1, opts.serpVariants) : 1;
  const queries = buildQueries(record).slice(0, maxVariants);
  const seenIds = new Set();
  let fetches = 0;
  let anyCandidate = false;
  let resolvedAny = null;
  let bostadSeen = 0;
  let serpErr = null;

  for (let qi = 0; qi < queries.length && fetches < cap; qi++) {
    let organic;
    try { organic = await serp(queries[qi], { logger: log, reserve: opts.reserve }); }
    catch (e) {
      if (e && (e.code === 'OXY_CEILING' || e.name === 'CeilingError')) throw e; // ceiling must propagate
      serpErr = e.message; continue; // a failed variant must not abort the others
    }

    // New exact-address candidates from this variant. Broadened variants (qi>0) also require
    // the kommun to match in the slug, so dropping the muni term can't pull another city.
    const cands = [];
    for (const u of organic) {
      if (!/hemnet\.se\/bostad\//i.test(u)) continue;
      bostadSeen++;
      if (!slugMatchesAddress(u, addr)) continue;
      if (qi > 0 && muni && !slugMatchesMunicipality(u, muni)) continue;
      const id = listingIdFromUrl(u);
      if (id) { if (seenIds.has(id)) continue; seenIds.add(id); }
      cands.push(u);
    }
    if (!cands.length) continue;
    anyCandidate = true;

    for (const url of cands) {
      if (fetches >= cap) break;
      let res;
      try { res = await fetcher(url); fetches++; }
      catch (e) { if (e && (e.code === 'OXY_CEILING' || e.name === 'CeilingError')) throw e; continue; }
      if (!res || res.status !== 200) continue;
      const apollo = extractNextData(res.html)?.props?.pageProps?.__APOLLO_STATE__;
      const node = parseListingNode(apollo, listingIdFromUrl(url));
      if (!node) continue;
      if (!resolvedAny) resolvedAny = url;

      const addrOk = normAddr(node.streetAddress) === normAddr(addr);
      if (!addrOk) continue; // slug already exact-matched; guards normAddr edge cases
      const areaDiff = (node.livingArea != null && recArea != null)
        ? Math.abs(node.livingArea - recArea) / recArea : null;
      const roomsOk = (node.rooms != null && recRooms != null)
        ? Math.round(node.rooms) === Math.round(recRooms) : null;
      const state = node.active ? 'active' : (node.labels.includes('SOLD') ? 'sold' : 'deactivated');
      const verifiedBase = { addrOk, areaDiff, roomsOk };

      if (isHouse) {
        // VILLA: exact street address is a (near-)unique key → accept on address alone.
        // Reject ONLY if living area is GROSSLY off (a different structure). biarea/boarea
        // reporting gaps between Booli & Hemnet make a tight band a self-inflicted miss, so
        // the guard is wide; villa room counts also diverge across platforms → not gated.
        if (areaDiff != null && areaDiff > villaAreaTol) continue;
        return { found: true, url, listingId: node.id, node, verified: { ...verifiedBase, gate: 'villa-address' }, state, query: queries[qi] };
      }

      // APARTMENT: one address+entrance holds many units → need a unit signal. Strongest
      // is the monthly fee/avgift (same signal /salda uses as fee-exact). Booli rent vs
      // Hemnet fee: exact → confirm; known-but-different → reject as a different unit.
      // Fall back to living-area/rooms corroboration when fee is missing on either side.
      const areaOk = areaDiff != null ? areaDiff <= aptAreaTol : null;
      // Lazy Booli-rent fetch: only now (an exact-address candidate with a fee to check),
      // once per record. So no-match apt booli_only never trigger the extra Booli call.
      if (booliFee == null && node.fee != null && !feeFetchTried && typeof opts.fetchBooliFee === 'function') {
        feeFetchTried = true;
        try { booliFee = num(await opts.fetchBooliFee()); }
        catch (e) { if (e && (e.code === 'OXY_CEILING' || e.name === 'CeilingError')) throw e; }
      }
      const feeOk = (node.fee != null && booliFee != null) ? Math.abs(node.fee - booliFee) <= 2 : null;
      if (roomsOk === false) continue;     // different unit
      if (feeOk === false) continue;       // fees known & differ → different unit
      if (feeOk === true) {
        return { found: true, url, listingId: node.id, node, verified: { ...verifiedBase, areaOk, feeOk, gate: 'apt-fee-exact' }, state, query: queries[qi] };
      }
      const corroborated = areaOk === true || roomsOk === true;
      if (corroborated) {
        return { found: true, url, listingId: node.id, node, verified: { ...verifiedBase, areaOk, feeOk, gate: 'apt-corroborated' }, state, query: queries[qi] };
      }
    }
  }
  if (anyCandidate) return { found: false, reason: 'unverified', resolved: resolvedAny, queriesTried: queries.length };
  if (serpErr && bostadSeen === 0) return { found: false, reason: 'serp-error', error: serpErr };
  return { found: false, reason: 'no-exact-slug', serp_bostad: bostadSeen, queriesTried: queries.length };
}

module.exports = {
  slugifyAddr,
  slugMatchesAddress,
  slugMatchesMunicipality,
  buildQueries,
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
      'Broker:9': { name: 'Benjamin Karlsson' },
      'DeactivatedPropertyListing:21733498': {
        __typename: 'DeactivatedPropertyListing', id: '21733498', streetAddress: 'Frejgatan 53, 2 tr',
        area: 'Harestad', livingArea: 141, numberOfRooms: 6,
        askingPrice: { amount: 4495000 }, fee: { formatted: '4 852 kr' }, // fee carries NO amount
        broker: { __ref: 'Broker:9' }, postCode: '113 49',
        housingForm: { name: 'Villa', symbol: 'HOUSE' },
        labels: [{ identifier: 'REMOVED' }], isSold: true,
      },
    };
    // BrokerAgency:1 lacks "PropertyListing:" so is skipped; the listing node is found.
    const n = parseListingNode(apollo, '21733498');
    assert.strictEqual(n.livingArea, 141);
    assert.strictEqual(n.rooms, 6);
    assert.strictEqual(n.askingPrice, 4495000);
    assert.strictEqual(n.fee, 4852, 'fee parsed from {formatted} (no amount)');
    assert.strictEqual(n.floor, 2, 'floor extracted from "..., 2 tr" suffix');
    assert.strictEqual(n.brokerName, 'Benjamin Karlsson');
    assert.strictEqual(n.postCode, '113 49');
    assert.strictEqual(n.isSold, true);
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

    // Seed the SERP cache so the multi-variant loop never hits the network in --smoke.
    fs.mkdirSync(SERP_CACHE_DIR, { recursive: true });
    const _seeded = [];
    const seedQuery = (q, urls) => {
      const f = path.join(SERP_CACHE_DIR, crypto.createHash('sha1').update(q).digest('hex') + '.json');
      fs.writeFileSync(f, JSON.stringify({ query: q, urls })); _seeded.push(f);
    };
    const seedAll = (recObj, urls) => buildQueries(recObj).forEach((q) => seedQuery(q, urls));

    const rec = { street_address: 'Västra Röd 295', descriptive_area: 'Harestad', municipality: 'Kungälv', living_area: 141, rooms: 6 };
    seedAll(rec, [
      'https://www.hemnet.se/bostad/villa-5rum-harestad-kungalvs-kommun-vastra-rod-210-16732243', // neighbour
      'https://www.hemnet.se/bostad/villa-6rum-harestad-kungalvs-kommun-vastra-rod-295-21733498', // target
    ]);

    const fakeFetch = async (url) => ({ status: 200, html: htmlOf({}) });
    const r = await findHemnetListingByAddress(rec, { family: 'HOUSE', fetch: fakeFetch });
    check('bridge finds exact-address villa, accepts on address (villa gate)', () => {
      assert.strictEqual(r.found, true);
      assert.strictEqual(r.listingId, '21733498');
      assert.strictEqual(r.verified.addrOk, true);
      assert.strictEqual(r.verified.gate, 'villa-address');
    });

    // VILLA gate loosening: area differs 15% (141 vs 120, biarea/boarea gap) → STILL found
    // (this was previously rejected as "unverified" under the tight 10% gate).
    const fakeFetchArea120 = async () => ({ status: 200, html: htmlOf({ livingArea: 120 }) });
    const rVilla = await findHemnetListingByAddress(rec, { family: 'HOUSE', fetch: fakeFetchArea120 });
    check('villa: 15% area diff now matches on address (loosened gate)', () => {
      assert.strictEqual(rVilla.found, true);
      assert.strictEqual(rVilla.listingId, '21733498');
    });

    // VILLA sanity guard still rejects a grossly-different structure (141 vs 60 = 57% off)
    const fakeFetchArea60 = async () => ({ status: 200, html: htmlOf({ livingArea: 60 }) });
    const rGross = await findHemnetListingByAddress(rec, { family: 'HOUSE', fetch: fakeFetchArea60 });
    check('villa: gross area mismatch (57%) still rejected by sanity guard', () => {
      assert.strictEqual(rGross.found, false);
    });

    // same address but rooms differ on both sides → reject (different APARTMENT unit; gate unchanged)
    const fakeFetchWrongRooms = async () => ({ status: 200, html: htmlOf({ numberOfRooms: 2, livingArea: 45 }) });
    const r2 = await findHemnetListingByAddress({ ...rec, rooms: 6, living_area: 141 }, { family: 'APARTMENT', fetch: fakeFetchWrongRooms });
    check('apartment rejects same-address different-unit (rooms+area differ)', () => {
      assert.strictEqual(r2.found, false);
    });

    // --- APARTMENT fee gate (Booli rent vs Hemnet avgift) ---
    const aptApollo = (over) => ({ props: { pageProps: { __APOLLO_STATE__: {
      'DeactivatedPropertyListing:99': Object.assign({
        __typename: 'DeactivatedPropertyListing', id: '99', streetAddress: 'Åkergatan 10C',
        livingArea: 81.5, numberOfRooms: 4, fee: { formatted: '3 895 kr' }, askingPrice: { amount: 3895000 },
        labels: [{ identifier: 'REMOVED' }],
      }, over) } } } });
    const aptHtml = (over) => '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(aptApollo(over)) + '</script>';
    const aptRec = { street_address: 'Åkergatan 10C', descriptive_area: 'Centralt', municipality: 'Kungälv', living_area: 81.5, rooms: 4, rent: 3895 };
    seedAll(aptRec, ['https://www.hemnet.se/bostad/lagenhet-4rum-centralt-kungalvs-kommun-akergatan-10c-99']);

    const rFee = await findHemnetListingByAddress(aptRec, { family: 'APARTMENT', fetch: async () => ({ status: 200, html: aptHtml({}) }) });
    check('apartment fee-exact (rent 3895 == avgift 3895) → confirmed', () => {
      assert.strictEqual(rFee.found, true);
      assert.strictEqual(rFee.verified.gate, 'apt-fee-exact');
      assert.strictEqual(rFee.verified.feeOk, true);
    });

    // fee known on both but DIFFERENT (a different unit at the same address) → reject,
    // even though area & rooms happen to match.
    const rFeeBad = await findHemnetListingByAddress({ ...aptRec, rent: 5200 }, { family: 'APARTMENT', fetch: async () => ({ status: 200, html: aptHtml({}) }) });
    check('apartment fee mismatch (rent 5200 != avgift 3895) → rejected as different unit', () => {
      assert.strictEqual(rFeeBad.found, false);
    });

    // LAZY fee fetch: record.rent is null → bridge calls opts.fetchBooliFee ONCE, only
    // because an exact-address candidate was found, then fee-matches.
    let lazyCalls = 0;
    const rLazy = await findHemnetListingByAddress(
      { ...aptRec, rent: null },
      { family: 'APARTMENT', fetch: async () => ({ status: 200, html: aptHtml({}) }), fetchBooliFee: async () => { lazyCalls++; return 3895; } });
    check('apartment lazy fee: fetchBooliFee called once (candidate found) → fee-exact', () => {
      assert.strictEqual(rLazy.found, true);
      assert.strictEqual(rLazy.verified.gate, 'apt-fee-exact');
      assert.strictEqual(lazyCalls, 1, 'Booli fee fetched exactly once');
    });

    // LAZY fee fetch must NOT fire when the SERP returns no exact-address candidate
    // (this is the cost-saver: no Booli call for apt booli_only with no /bostad match).
    let lazyCalls2 = 0;
    const noCandRec = { street_address: 'Saknadgatan 1', descriptive_area: 'X', municipality: 'Kungälv', living_area: 50, rooms: 2, rent: null };
    seedAll(noCandRec, ['https://www.hemnet.se/bostad/lagenhet-2rum-kungalvs-kommun-annangatan-7-555']);
    const rNoCand = await findHemnetListingByAddress(noCandRec,
      { family: 'APARTMENT', fetch: async () => ({ status: 200, html: aptHtml({}) }), fetchBooliFee: async () => { lazyCalls2++; return 3895; } });
    check('apartment lazy fee: NOT fetched when no exact-address candidate', () => {
      assert.strictEqual(rNoCand.found, false);
      assert.strictEqual(rNoCand.reason, 'no-exact-slug');
      assert.strictEqual(lazyCalls2, 0, 'no Booli call when nothing to verify');
    });

    // SERP RECALL HARDENING: the full query (V1) returns only a neighbour; the broadened
    // variant (V2, area dropped) surfaces the target → recovered (a MISS before hardening).
    const hardRec = { street_address: 'Klippvägen 7', descriptive_area: 'WrongArea', municipality: 'Kungälv', living_area: 90, rooms: 4 };
    const hqs = buildQueries(hardRec);
    seedQuery(hqs[0], ['https://www.hemnet.se/bostad/villa-4rum-kungalvs-kommun-klippvagen-9-111']); // V1: neighbour only → no candidate
    hqs.slice(1).forEach((q) => seedQuery(q, ['https://www.hemnet.se/bostad/villa-4rum-kungalvs-kommun-klippvagen-7-222'])); // V2/V3: target
    const hardHtml = '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: {
      'DeactivatedPropertyListing:222': { __typename: 'DeactivatedPropertyListing', id: '222', streetAddress: 'Klippvägen 7', livingArea: 90, numberOfRooms: 4, labels: [{ identifier: 'REMOVED' }] },
    } } } }) + '</script>';
    const rHard = await findHemnetListingByAddress(hardRec, { family: 'HOUSE', serpVariants: 3, fetch: async () => ({ status: 200, html: hardHtml }) });
    check('SERP hardening: V1 misses (neighbour only), broadened variant recovers the target', () => {
      assert.strictEqual(rHard.found, true);
      assert.strictEqual(rHard.listingId, '222');
      assert.strictEqual(rHard.query, hqs[1], 'matched via the broadened (area-dropped) query');
    });

    // muni guard: on a BROADENED variant (muni term dropped), a same-named street in
    // another kommun must be filtered by the slug's "<kommun>-kommun" — so it never even
    // becomes a candidate (reason stays no-exact-slug, not unverified-after-fetch).
    const muniRec = { street_address: 'Storgatan 5', descriptive_area: 'Z', municipality: 'Kungälv', living_area: 70, rooms: 3 };
    const mqs = buildQueries(muniRec);
    seedQuery(mqs[0], []); // V1 (has muni in query): empty
    mqs.slice(1).forEach((q) => seedQuery(q, ['https://www.hemnet.se/bostad/lagenhet-3rum-goteborgs-kommun-storgatan-5-333'])); // broadened: wrong kommun
    const rMuni = await findHemnetListingByAddress(muniRec, { family: 'APARTMENT', serpVariants: 3, fetch: async () => ({ status: 200, html: hardHtml }) });
    check('SERP hardening: muni guard filters same-address in a different kommun', () => {
      assert.strictEqual(rMuni.found, false);
      assert.strictEqual(rMuni.reason, 'no-exact-slug', 'wrong-kommun url filtered before fetch');
    });

    // cleanup all seeded smoke cache files
    for (const f of _seeded) { try { fs.unlinkSync(f); } catch (_) {} }

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((e) => { console.error('SMOKE uncaught', e); process.exit(1); });
}
