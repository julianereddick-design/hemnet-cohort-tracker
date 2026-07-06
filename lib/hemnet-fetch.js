// hemnet-fetch.js — Hemnet site-specific parsers. HTTP/Oxylabs/retry plumbing
// lives in lib/scrape-http.js (Phase 8 refactor). Public surface unchanged from
// Phase 7.1: callers continue to import fetchDetail / fetchSearch / extractNextData
// / parseActiveListing / parseListingCards / resolveRef / getOxylabsStats / resetOxylabsStats.
//
// Behavior locked by .planning/phases/06-scraping-core-location-cache/06-CONTEXT.md
// + .planning/phases/07.1-oxylabs-fetch-hardening/07.1-CONTEXT.md (lib lineage).

'use strict';

const {
  getWithRetry,
  extractNextData,
  getOxylabsStats,
  resetOxylabsStats,
} = require('./scrape-http');

function noopLogger() {}

// Resolve an Apollo {__ref: "Type:id"} pointer (or a bare "Type:id" string)
// against a flat Apollo state. Returns null on miss (never throws).
function resolveRef(apolloState, ref) {
  if (!apolloState || ref == null) return null;
  let key = null;
  if (typeof ref === 'string') {
    key = ref;
  } else if (typeof ref === 'object' && typeof ref.__ref === 'string') {
    key = ref.__ref;
  } else {
    return null;
  }
  const v = apolloState[key];
  return v == null ? null : v;
}

// Defensive coercion for nested Money/value objects. Returns finite number
// or null. Accepts plain numbers, numeric strings, and Apollo Money objects
// shaped like {amount: 2245000} or {value: ...}.
function coerceNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // Try JSON-style first; fall back to digits-only for "2 245 000 kr".
    const direct = Number(v);
    if (Number.isFinite(direct)) return direct;
    const digits = v.replace(/[^\d.-]/g, '');
    if (digits.length === 0) return null;
    const parsed = Number(digits);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof v === 'object') {
    if (typeof v.amount === 'number' && Number.isFinite(v.amount)) return v.amount;
    if (typeof v.value === 'number' && Number.isFinite(v.value)) return v.value;
    if (typeof v.amount === 'string') return coerceNumber(v.amount);
    if (typeof v.value === 'string') return coerceNumber(v.value);
  }
  return null;
}

// Surface housingForm as a string (Hemnet exposes it as an object with .name).
function coerceHousingForm(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.name === 'string') return v.name;
  return null;
}

// Build a {id, fullName} pair from a resolved Apollo Location entry.
// If the entry is missing, return {id: null, fullName: null}.
function shapeLocation(loc) {
  if (!loc || typeof loc !== 'object') return { id: null, fullName: null };
  return {
    id: loc.id != null ? String(loc.id) : null,
    fullName: typeof loc.fullName === 'string' ? loc.fullName : null,
  };
}

// Parse the ActivePropertyListing entry for a given hemnetId.
// Returns:
//   { status: 'active', listing }
//   { status: 'inactive', reason: 'no-active-listing' | 'removed-before-showing' }
function parseActiveListing(apolloState, hemnetId, opts = {}) {
  const log = (opts && opts.logger) || noopLogger;
  if (!apolloState || typeof apolloState !== 'object') {
    return { status: 'inactive', reason: 'no-active-listing' };
  }
  const id = String(hemnetId);
  const entry = apolloState[`ActivePropertyListing:${id}`];
  if (!entry) {
    return { status: 'inactive', reason: 'no-active-listing' };
  }
  if (entry.removedBeforeShowing === true) {
    return { status: 'inactive', reason: 'removed-before-showing' };
  }

  const muniRef = entry.municipality;
  const countyRef = entry.county;
  const muniLoc = muniRef ? resolveRef(apolloState, muniRef) : null;
  const countyLoc = countyRef ? resolveRef(apolloState, countyRef) : null;
  if (muniRef && !muniLoc) {
    log('WARN', `municipality ref unresolved for listing ${id}: ${JSON.stringify(muniRef)}`);
  }
  if (countyRef && !countyLoc) {
    log('WARN', `county ref unresolved for listing ${id}: ${JSON.stringify(countyRef)}`);
  }

  const listing = {
    id: entry.id != null ? String(entry.id) : id,
    streetAddress: typeof entry.streetAddress === 'string' ? entry.streetAddress : null,
    postCode: typeof entry.postCode === 'string' ? entry.postCode : (entry.postCode != null ? String(entry.postCode) : null),
    publishedAt: coerceNumber(entry.publishedAt),
    timesViewed: coerceNumber(entry.timesViewed),
    daysOnHemnet: coerceNumber(entry.daysOnHemnet),
    isUpcoming: entry.isUpcoming === true,
    housingForm: coerceHousingForm(entry.housingForm),
    askingPrice: coerceNumber(entry.askingPrice),
    livingArea: coerceNumber(entry.livingArea),
    municipality: shapeLocation(muniLoc),
    county: shapeLocation(countyLoc),
  };

  return { status: 'active', listing };
}

// Iterate every ListingCard:* in the Apollo state and shape it.
// Returns an array in iteration order.
function parseListingCards(apolloState) {
  if (!apolloState || typeof apolloState !== 'object') return [];
  const cards = [];
  for (const key of Object.keys(apolloState)) {
    if (!key.startsWith('ListingCard:')) continue;
    const entry = apolloState[key];
    if (!entry || typeof entry !== 'object') continue;
    cards.push({
      id: entry.id != null ? String(entry.id) : key.slice('ListingCard:'.length),
      streetAddress: typeof entry.streetAddress === 'string' ? entry.streetAddress : null,
      locationDescription: typeof entry.locationDescription === 'string' ? entry.locationDescription : null,
      publishedAt: coerceNumber(entry.publishedAt),
      housingForm: coerceHousingForm(entry.housingForm),
      askingPrice: coerceNumber(entry.askingPrice),
      upcoming: entry.upcoming === true,
      newConstruction: entry.newConstruction === true,
    });
  }
  return cards;
}

// Public: fetch a Hemnet detail page and parse it.
// Returns:
//   { status: 'active', listing }
//   { status: 'inactive', reason: '404' | 'no-active-listing' | 'removed-before-showing' }
// Throws on persistent fetch error or missing __NEXT_DATA__ tag.
async function fetchDetail(hemnetId, opts = {}) {
  const log = opts.logger || noopLogger;
  const targetUrl = `https://www.hemnet.se/bostad/${hemnetId}`;
  const res = await getWithRetry(targetUrl, opts);
  if (res.status === 404) {
    log('INFO', `${hemnetId} 404 -> inactive`);
    return { status: 'inactive', reason: '404' };
  }
  const data = extractNextData(res.html);
  const apolloState =
    data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apolloState) {
    throw new Error(`hemnet-fetch: no __APOLLO_STATE__ in detail for ${hemnetId}`);
  }
  return parseActiveListing(apolloState, hemnetId, { logger: log });
}

// Public: fetch a Hemnet search-results page and parse the cards.
// Returns { cards, totalPages? }. Throws on 404 (search pages should never
// 404 for a valid location_id) or any persistent fetch error.
async function fetchSearch(locationId, opts = {}) {
  const page = opts.page != null ? opts.page : 1;
  const sort = opts.sort != null ? opts.sort : 'NEWEST';
  // Spike confirmed literal `[]` works; native fetch will percent-encode if needed.
  const targetUrl = `https://www.hemnet.se/bostader?location_ids[]=${locationId}&sort=${sort}&page=${page}`;
  const res = await getWithRetry(targetUrl, opts);
  if (res.status === 404) {
    throw new Error(
      `hemnet-fetch: search returned 404 for location_id=${locationId} page=${page} — unexpected`,
    );
  }
  const data = extractNextData(res.html);
  const apolloState =
    data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apolloState) {
    throw new Error(
      `hemnet-fetch: no __APOLLO_STATE__ in search for location_id=${locationId} page=${page}`,
    );
  }
  const cards = parseListingCards(apolloState);

  // Best-effort totalPages: scan ROOT_QUERY for a search result with totalPages.
  let totalPages;
  const root = apolloState.ROOT_QUERY;
  if (root && typeof root === 'object') {
    for (const key of Object.keys(root)) {
      const v = root[key];
      if (v && typeof v === 'object' && typeof v.totalPages === 'number') {
        totalPages = v.totalPages;
        break;
      }
    }
  }

  return totalPages != null ? { cards, totalPages } : { cards };
}

// Public: fetch a Hemnet search-results page whose URL the caller has already
// constructed with arbitrary discriminator filters (price_min, price_max,
// rooms_min, rooms_max, item_types[], etc.) on top of the mandatory
// location_ids[]= param. Returns { cards } in the same shape as fetchSearch.
//
// Introduced by Plan 09-2.5 (Task 7 — Job B narrowed-search rewrite, D-26..D-29).
// Sibling of fetchSearch, NOT a replacement — fetchSearch's two-arg
// (locationId, opts) signature stays backwards-compatible for any non-Job-B
// callers.
//
// Throws on 404 (search pages should never 404 for any valid location_id)
// or any persistent fetch error. parseListingCards swallows missing/empty
// Apollo state by returning [] — that's the "narrowed search produced zero
// candidates" path and is normal in Job B usage.
async function fetchSearchFiltered(targetUrl, opts = {}) {
  if (typeof targetUrl !== 'string' || targetUrl.length === 0) {
    throw new Error('hemnet-fetch: fetchSearchFiltered requires a non-empty URL string');
  }
  const res = await getWithRetry(targetUrl, opts);
  if (res.status === 404) {
    throw new Error(`hemnet-fetch: filtered search returned 404 for ${targetUrl} — unexpected`);
  }
  const data = extractNextData(res.html);
  const apolloState =
    data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apolloState) {
    throw new Error(`hemnet-fetch: no __APOLLO_STATE__ in filtered search for ${targetUrl}`);
  }
  const cards = parseListingCards(apolloState);
  return { cards };
}

module.exports = {
  fetchDetail,
  fetchSearch,
  fetchSearchFiltered,
  extractNextData,         // re-exported pass-through from scrape-http
  parseActiveListing,
  parseListingCards,
  resolveRef,
  // Phase 7.1: Oxylabs fallback observability (re-exported pass-through from scrape-http).
  getOxylabsStats,
  resetOxylabsStats,
};

// ---------------------------------------------------------------------------
// --smoke self-test (pure-function; no live network, no DB).
// Run with: node lib/hemnet-fetch.js --smoke
// Gated on require.main so requiring this module never triggers it.
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('parseListingCards: empty apollo returns []', () => {
    assert.deepStrictEqual(parseListingCards({}), []);
  });
  check('parseListingCards: newConstruction surfaced true', () => {
    const apollo = { 'ListingCard:1': { id: 1, streetAddress: 'X', publishedAt: 100, upcoming: true, newConstruction: true } };
    const cards = parseListingCards(apollo);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].newConstruction, true);
    assert.strictEqual(cards[0].upcoming, true);
    assert.strictEqual(cards[0].publishedAt, 100);
  });
  check('parseListingCards: newConstruction defaults false when absent', () => {
    const apollo = { 'ListingCard:2': { id: 2, streetAddress: 'Y', publishedAt: 200, upcoming: false } };
    const cards = parseListingCards(apollo);
    assert.strictEqual(cards[0].newConstruction, false);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
