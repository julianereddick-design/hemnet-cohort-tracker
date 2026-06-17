'use strict';

// sold-fetch-hemnet.js — Per-property Hemnet /salda SaleCard search.
// Productionised from scripts/spike-hemnet-match.js (Phase 15-05).
//
// Provides:
//   buildHemnetSoldUrl(booli, seg, opts = {})
//     — Builds a narrowed Hemnet /salda search URL (location + price ± band +
//       living_area band + rooms + item_type) for one Booli seed record.
//       House opts (wider band, drop rooms + item_type) vs apartment opts (tight).
//   searchSoldPaged(booli, seg, windowDays, maxPages, opts = {})
//     — Paginates the narrowed /salda search with early-stop on: address found,
//       short page (last page within filters), or sold-date window exceeded.
//       Returns { cards, pages, complete }. NO per-card detail fetch.
//   searchOptsFor(seg)
//     — Returns the recommended opts for a segment based on seg.family.
//
// IMPORTANT: callers MUST set process.env.SCRAPE_FORCE_OXYLABS = '1' BEFORE
// requiring this module (lib/sold-transport.js enforces this at load time).

const {
  cachedFetch,
  extractApollo,
  CeilingError,
  remainingCalls,
} = require('./sold-transport');
const { parseHemnetSaleCards } = require('./sold-parse');
const { normAddr } = require('./sold-addr');
const { PRICE_BAND } = require('./sold-config');
const { booliObjectTypeToHemnet } = require('./booli-to-hemnet-mapping');

const DAY = 86400; // seconds per day

// Convert a Booli sold_date string ("YYYY-MM-DD") to a Unix timestamp (seconds).
// Returns null on parse failure.
function booliSoldUnix(d) {
  if (d == null) return null;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// ---------------------------------------------------------------------------
// buildHemnetSoldUrl — Builds a narrowed Hemnet /salda search URL.
//
// Filter logic:
//   - location_ids[] from seg.hemnet.locationId (always)
//   - price_min/price_max banded by opts.priceBand (default PRICE_BAND = 5%)
//     when booli.sold_price is a finite number
//   - rooms_min/rooms_max = round(booli.rooms) UNLESS opts.dropRooms
//   - living_area_min/max banded by opts.areaBand (default 0.07) UNLESS
//     opts.dropArea or booli.living_area is not finite
//   - item_types[]: APARTMENT → seg.hemnet.itemType; HOUSE → booliObjectTypeToHemnet
//     UNLESS opts.dropItemType
// ---------------------------------------------------------------------------
function buildHemnetSoldUrl(booli, seg, opts) {
  const o = opts || {};
  const p = new URLSearchParams();
  p.append('location_ids[]', String(seg.hemnet.locationId));

  const band = o.priceBand != null ? o.priceBand : PRICE_BAND;
  if (booli.sold_price != null && Number.isFinite(Number(booli.sold_price))) {
    const v = Number(booli.sold_price);
    p.append('price_min', String(Math.floor(v * (1 - band))));
    p.append('price_max', String(Math.ceil(v * (1 + band))));
  }

  if (!o.dropRooms && booli.rooms != null && Number.isFinite(Number(booli.rooms))) {
    const r = Math.round(Number(booli.rooms));
    p.append('rooms_min', String(r));
    p.append('rooms_max', String(r));
  }

  if (!o.dropArea && booli.living_area != null && Number.isFinite(Number(booli.living_area))) {
    const areaBand = o.areaBand != null ? o.areaBand : 0.07;
    const a = Number(booli.living_area);
    p.append('living_area_min', String(Math.floor(a * (1 - areaBand))));
    p.append('living_area_max', String(Math.ceil(a * (1 + areaBand))));
  }

  if (!o.dropItemType) {
    const itemType = seg.family === 'APARTMENT'
      ? (seg.hemnet.itemType || 'bostadsratt')
      : booliObjectTypeToHemnet(booli.object_type);
    if (itemType) p.append('item_types[]', itemType);
  }

  return `https://www.hemnet.se/salda?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Within-run search cache.
// Deduplicates concurrent same-URL searches (mirrors the cohort job dedup).
// CeilingError propagates; non-200 is cached as [].
// ---------------------------------------------------------------------------
const searchCache = new Map();
const searchInFlight = new Map();

async function searchSold(url) {
  if (searchCache.has(url)) return searchCache.get(url);
  if (searchInFlight.has(url)) return searchInFlight.get(url);

  const promise = (async () => {
    try {
      const res = await cachedFetch(url, { logger: function () {} });
      if (res.status !== 200) {
        searchCache.set(url, []);
        return [];
      }
      const { apollo } = extractApollo(res.html);
      const cards = parseHemnetSaleCards(apollo);
      searchCache.set(url, cards);
      return cards;
    } finally {
      searchInFlight.delete(url);
    }
  })();

  searchInFlight.set(url, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// searchSoldPaged — Paginates a narrowed /salda search with early-stop.
//
// Early-stop conditions (complete = true):
//   1. Empty page (feed exhausted within filters)
//   2. Any card's normAddr matches the Booli address (found!)
//   3. Short page (< 50 cards) — last page within filters
//   4. Oldest card sold_at is older than bUnix - windowDays*DAY (past window)
//
// Cost-ceiling draining (T-15-15):
//   - If remainingCalls() <= 40 before fetching a page, stop draining and
//     return partial with complete=false, stopReason='ceiling-floor'
//   - CeilingError from cachedFetch is caught; returns cleanly with
//     complete=false, stopReason='ceiling'
//
// Returns { cards, pages, complete, stopReason }. NO per-card detail fetch.
// ---------------------------------------------------------------------------
async function searchSoldPaged(booli, seg, windowDays, maxPages, opts) {
  const o = opts || {};
  const baseUrl = buildHemnetSoldUrl(booli, seg, o);
  const bUnix = booliSoldUnix(booli.sold_date);
  const bAddr = normAddr(booli.street_address);
  const all = [];
  let complete = false;
  let stopReason = null;
  let page = 1;

  for (; page <= maxPages; page++) {
    // Drain guard: stop before hitting the hard ceiling.
    if (remainingCalls() <= 40) {
      stopReason = 'ceiling-floor';
      break;
    }

    const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
    let cards;
    try {
      cards = await searchSold(url);
    } catch (e) {
      if (e instanceof CeilingError) {
        stopReason = 'ceiling';
        break;
      }
      throw e;
    }

    // Early-stop 1: empty page
    if (cards.length === 0) {
      complete = true;
      break;
    }

    all.push(...cards);

    // Early-stop 2: address found in this page
    if (cards.some((c) => normAddr(c.street_address) === bAddr)) {
      complete = true;
      break;
    }

    // Early-stop 3: short page (last page within filters)
    if (cards.length < 50) {
      complete = true;
      break;
    }

    // Early-stop 4: oldest card is past the sold-date window
    const oldest = Math.min(...cards.map((c) => (c.sold_at != null ? c.sold_at : Infinity)));
    if (bUnix != null && oldest < bUnix - windowDays * DAY) {
      complete = true;
      break;
    }
  }

  return { cards: all, pages: page, complete, stopReason };
}

// ---------------------------------------------------------------------------
// searchOptsFor — House vs apartment search opts (critical match-rate design).
//
//   HOUSE      — wider bands, no rooms/item_type filter (street address is a
//                near-unique key; loose search avoids Booli↔Hemnet rooms/subtype
//                quirks; Täby density is low so 50-cap is not a risk)
//   APARTMENT  — tight opts (dense buildings need rooms+area+item_type to stay
//                under the 50-card page cap)
// ---------------------------------------------------------------------------
function searchOptsFor(seg) {
  if (seg.family === 'HOUSE') {
    return { priceBand: 0.10, areaBand: 0.15, dropRooms: true, dropItemType: true };
  }
  return {}; // APARTMENT: tight (defaults: priceBand=0.05, areaBand=0.07, rooms+item_type included)
}

module.exports = {
  buildHemnetSoldUrl,
  searchSoldPaged,
  searchOptsFor,
  // searchSold is internal; exported for advanced callers (e.g. Phase 17 orchestrator)
  searchSold,
  booliSoldUnix,
};

// ---------------------------------------------------------------------------
// Inline smoke test — node lib/sold-fetch-hemnet.js --smoke
// Offline only: unit-tests buildHemnetSoldUrl. No network calls.
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // Minimal test fixtures
  const aptSeg = {
    family: 'APARTMENT',
    hemnet: { locationId: 18031, itemType: 'bostadsratt' },
    booli: { areaIds: 1, objectType: 'Lägenhet' },
  };
  const houseSeg = {
    family: 'HOUSE',
    hemnet: { locationId: 17793, itemType: null },
    booli: { areaIds: 20, objectType: 'Hus' },
  };
  const aptBooli = {
    booli_id: 'apt-1', object_type: 'Lägenhet',
    sold_price: 3000000, rooms: 2, living_area: 55, sold_date: '2025-12-01',
    street_address: 'Storgatan 5',
  };
  const houseBooli = {
    booli_id: 'house-1', object_type: 'Villa',
    sold_price: 5000000, rooms: 5, living_area: 130, sold_date: '2025-11-01',
    street_address: 'Villavägen 10',
  };

  // APARTMENT: tight — should contain item_types[] and rooms params
  check('apt URL contains location_ids[]', () => {
    const url = buildHemnetSoldUrl(aptBooli, aptSeg, {});
    assert.ok(url.includes('location_ids%5B%5D=18031') || url.includes('location_ids[]=18031'),
      `URL does not contain location_ids[]=18031: ${url}`);
  });
  check('apt URL contains item_types[]=bostadsratt', () => {
    const url = buildHemnetSoldUrl(aptBooli, aptSeg, {});
    assert.ok(url.includes('item_types%5B%5D=bostadsratt') || url.includes('item_types[]=bostadsratt'),
      `URL does not contain item_types[]=bostadsratt: ${url}`);
  });
  check('apt URL contains rooms_min and rooms_max', () => {
    const url = buildHemnetSoldUrl(aptBooli, aptSeg, {});
    assert.ok(url.includes('rooms_min=2') && url.includes('rooms_max=2'),
      `URL missing rooms params: ${url}`);
  });
  check('apt URL contains living_area_min and living_area_max (default 0.07 band)', () => {
    const url = buildHemnetSoldUrl(aptBooli, aptSeg, {});
    // 55 * (1-0.07) = 51.15 → floor = 51; 55 * (1+0.07) = 58.85 → ceil = 59
    assert.ok(url.includes('living_area_min=51') && url.includes('living_area_max=59'),
      `URL missing living_area params: ${url}`);
  });
  check('apt URL price band default PRICE_BAND (5%)', () => {
    const url = buildHemnetSoldUrl(aptBooli, aptSeg, {});
    // 3000000 * 0.95 = 2850000; 3000000 * 1.05 = 3150000
    assert.ok(url.includes('price_min=2850000') && url.includes('price_max=3150000'),
      `URL missing correct price params: ${url}`);
  });
  check('apt URL starts with https://www.hemnet.se/salda?', () => {
    const url = buildHemnetSoldUrl(aptBooli, aptSeg, {});
    assert.ok(url.startsWith('https://www.hemnet.se/salda?'), `URL wrong base: ${url}`);
  });

  // HOUSE (dropRooms + dropItemType + wider bands via searchOptsFor)
  const houseOpts = searchOptsFor(houseSeg);
  check('searchOptsFor HOUSE returns dropRooms=true', () => {
    assert.strictEqual(houseOpts.dropRooms, true);
  });
  check('searchOptsFor HOUSE returns dropItemType=true', () => {
    assert.strictEqual(houseOpts.dropItemType, true);
  });
  check('searchOptsFor HOUSE returns priceBand=0.10', () => {
    assert.strictEqual(houseOpts.priceBand, 0.10);
  });
  check('searchOptsFor HOUSE returns areaBand=0.15', () => {
    assert.strictEqual(houseOpts.areaBand, 0.15);
  });
  check('searchOptsFor APARTMENT returns {} (tight defaults)', () => {
    const o = searchOptsFor(aptSeg);
    assert.ok(typeof o === 'object' && o.dropRooms == null && o.dropItemType == null,
      `Expected empty opts for APARTMENT: ${JSON.stringify(o)}`);
  });
  check('house URL omits rooms params (dropRooms)', () => {
    const url = buildHemnetSoldUrl(houseBooli, houseSeg, houseOpts);
    assert.ok(!url.includes('rooms_min') && !url.includes('rooms_max'),
      `URL should not contain rooms params: ${url}`);
  });
  check('house URL omits item_types[] (dropItemType)', () => {
    const url = buildHemnetSoldUrl(houseBooli, houseSeg, houseOpts);
    assert.ok(!url.includes('item_types'),
      `URL should not contain item_types: ${url}`);
  });
  check('house URL uses wider price band (10%)', () => {
    const url = buildHemnetSoldUrl(houseBooli, houseSeg, houseOpts);
    // 5000000 * 0.90 = 4500000; 5000000 * 1.10 = 5500000
    assert.ok(url.includes('price_min=4500000') && url.includes('price_max=5500000'),
      `URL missing wider price band params: ${url}`);
  });
  check('house URL uses wider area band (15%)', () => {
    const url = buildHemnetSoldUrl(houseBooli, houseSeg, houseOpts);
    // 130 * (1-0.15) = 110.5 → floor = 110; 130 * (1+0.15) = 149.5 → ceil = 150
    assert.ok(url.includes('living_area_min=110') && url.includes('living_area_max=150'),
      `URL missing wider area band params: ${url}`);
  });

  // Edge cases
  check('no price when sold_price null', () => {
    const b = { ...aptBooli, sold_price: null };
    const url = buildHemnetSoldUrl(b, aptSeg, {});
    assert.ok(!url.includes('price_min') && !url.includes('price_max'),
      `URL should not contain price params: ${url}`);
  });
  check('no rooms when rooms null', () => {
    const b = { ...aptBooli, rooms: null };
    const url = buildHemnetSoldUrl(b, aptSeg, {});
    assert.ok(!url.includes('rooms_min') && !url.includes('rooms_max'),
      `URL should not contain rooms params: ${url}`);
  });
  check('no area when living_area null', () => {
    const b = { ...aptBooli, living_area: null };
    const url = buildHemnetSoldUrl(b, aptSeg, {});
    assert.ok(!url.includes('living_area_min') && !url.includes('living_area_max'),
      `URL should not contain area params: ${url}`);
  });
  check('booliSoldUnix: valid date returns epoch', () => {
    const t = booliSoldUnix('2025-12-01');
    assert.ok(Number.isFinite(t) && t > 0, `Expected finite positive epoch: ${t}`);
  });
  check('booliSoldUnix: null returns null', () => {
    assert.strictEqual(booliSoldUnix(null), null);
  });

  // Export shape
  check('buildHemnetSoldUrl is exported as function', () => {
    assert.strictEqual(typeof buildHemnetSoldUrl, 'function');
  });
  check('searchSoldPaged is exported as function', () => {
    assert.strictEqual(typeof searchSoldPaged, 'function');
  });
  check('searchOptsFor is exported as function', () => {
    assert.strictEqual(typeof searchOptsFor, 'function');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
