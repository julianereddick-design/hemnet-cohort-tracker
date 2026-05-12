// booli-fetch.js — Booli site-specific parsers + fetchers. HTTP transport
// (curl shellout + Oxylabs fallback + retry envelope + __NEXT_DATA__ extractor)
// lives in lib/scrape-http.js. This module only knows about Booli's Apollo
// state shape (Area_V3 geographic entries, nested InfoPoint pageviews counter,
// ROOT_QUERY.searchForSale ordered ref array).
//
// Validated by:
//   .planning/spikes/001-booli-detail-page-schema/ — detail page schema (6/6 fixtures)
//   .planning/spikes/002-booli-search-discovery/ — search page sort/pagination/PM filter
//
// Behavior locked by .planning/phases/08-weekly-targeted-match-job-b/08-CONTEXT.md
// D-10 (parsed fields), D-11 (synthesized defaults — applied by booli-targeted-discovery,
// NOT here), D-12 (nullable fields), D-13 (id sequence — applied by upstream UPSERT).
//
// Pure CommonJS. No new npm deps.

'use strict';

const {
  getWithRetry,
  extractNextData,
  getOxylabsStats,
  resetOxylabsStats,
} = require('./scrape-http');

function noopLogger() {}

// Parse Booli's `published` field, which on BOTH search-result cards and detail
// pages is served as a string in the form 'YYYY-MM-DD HH:MM:SS' (local Swedish
// time per Booli's frontend). Spike 001 captured fixture data that suggested a
// Unix-seconds number, but live 2026-05-12 inspection shows the wire format is
// the string. We accept both for defensive forward-compat:
//   - number: assumed to already be Unix seconds (legacy / fixture path)
//   - string in 'YYYY-MM-DD HH:MM:SS' form: parsed as UTC (good-enough for the
//     7-day cutoff; the local-vs-UTC drift is at most a few hours and the
//     cutoff is in days)
//   - anything else: null
// Returns a number (Unix seconds) or null.
function parsePublishedToUnix(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    // Match 'YYYY-MM-DD HH:MM:SS' (space or T separator).
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      // Treat as UTC. The 7-day cutoff is a coarse filter; sub-day timezone
      // drift is harmless for our purpose.
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      return Math.floor(ms / 1000);
    }
    // Match 'YYYY-MM-DD' (date-only) — treat midnight UTC.
    const md = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (md) {
      const ms = Date.UTC(+md[1], +md[2] - 1, +md[3]);
      return Math.floor(ms / 1000);
    }
  }
  return null;
}

// Parse a Booli detail page's __NEXT_DATA__ Apollo state into the cohort
// minimum-viable field set. The Listing object is keyed by `Listing:<id>` in
// Apollo. Geographic fields live in Area_V3 entries filtered by `type`.
// times_viewed lives in a nested InfoPoint with key:'pageviews', extracted
// via regex on the markdown displayText.
//
// Returns:
//   { status: 'active', listing }   on success
//   { status: 'inactive', reason }  if Listing object missing or shape invalid
function parseBooliListing(apolloState, opts = {}) {
  const log = (opts && opts.logger) || noopLogger;
  if (!apolloState || typeof apolloState !== 'object') {
    return { status: 'inactive', reason: 'no-apollo-state' };
  }

  // Find the Listing object — keyed by `Listing:<id>`. Detail pages have one
  // canonical Listing entry; spike 001 confirmed first-match-by-typename is
  // correct on 6/6 fixtures.
  let listing = null;
  let listingKey = null;
  for (const key of Object.keys(apolloState)) {
    if (!key.startsWith('Listing:')) continue;
    const candidate = apolloState[key];
    if (!candidate || typeof candidate !== 'object') continue;
    if (candidate.__typename !== 'Listing') continue;
    listing = candidate;
    listingKey = key;
    break;
  }
  if (!listing) return { status: 'inactive', reason: 'no-listing-object' };

  // Geographic fields — walk Area_V3 entries by type.
  // Spike 001 confirmed exactly one of each type per detail page.
  const areas = { postcode: null, municipality: null, county: null };
  for (const v of Object.values(apolloState)) {
    if (!v || typeof v !== 'object') continue;
    if (v.__typename !== 'Area_V3' || typeof v.type !== 'string') continue;
    if (areas[v.type] == null && typeof v.name === 'string') areas[v.type] = v.name;
  }

  // Page views — nested InfoPoint with key:'pageviews' inside
  // Listing.displayAttributes.infoSections[].content.infoPoints[]. Recursive walk
  // with cycle guard (spike 001 found this is 3 levels deep; top-level iteration misses it).
  let timesViewed = null;
  const seen = new Set();
  (function findPageviews(o) {
    if (!o || typeof o !== 'object' || seen.has(o) || timesViewed !== null) return;
    seen.add(o);
    if (o.__typename === 'InfoPoint' && o.key === 'pageviews') {
      const md = (o.displayText && typeof o.displayText.markdown === 'string') ? o.displayText.markdown : '';
      const m = md.match(/\*\*(\d+)\*\*/);
      if (m) timesViewed = parseInt(m[1], 10);
      return;
    }
    if (Array.isArray(o)) {
      for (const v of o) findPageviews(v);
    } else {
      for (const v of Object.values(o)) findPageviews(v);
    }
  })(apolloState);

  if (timesViewed == null) {
    log('WARN', `parseBooliListing: pageviews InfoPoint not found for ${listingKey}`);
    // Don't fail — let caller decide. Many Booli listings have it; if missing,
    // it's a parser correctness signal, not a fatal error.
  }

  // Postcode: Booli stores as string "41704" — cast to int (D-10).
  let postcodeInt = null;
  if (typeof areas.postcode === 'string' && /^\d+$/.test(areas.postcode)) {
    postcodeInt = parseInt(areas.postcode, 10);
  }

  return {
    status: 'active',
    listing: {
      booli_id: listing.id != null ? String(listing.id) : null,
      residence_id: listing.residenceId != null ? String(listing.residenceId) : null,
      url: typeof listing.url === 'string' ? listing.url : null,  // canonical — do NOT construct
      streetAddress: typeof listing.streetAddress === 'string' ? listing.streetAddress : null,
      postcode: postcodeInt,
      municipality: areas.municipality,
      county: areas.county,      // WITH ' län' suffix per D-10
      // Booli wire format is 'YYYY-MM-DD HH:MM:SS' string on both search and
      // detail pages. parsePublishedToUnix returns Unix seconds. Older spike
      // fixtures show a number — handled identically.
      published: parsePublishedToUnix(listing.published),
      isPreMarket: listing.upcomingSale === true,
      timesViewed: timesViewed,
    },
  };
}

// Parse a Booli search page's __NEXT_DATA__ Apollo state into an ORDERED array
// of search-result cards. CRITICAL: read from ROOT_QUERY.searchForSale(...).result
// — iterating Object.values(apollo) returns cross-sell strips mixed with the
// current page's results (spike 002 found 70 listings of which ~35 were cross-sell).
//
// Returns: { cards: [...], totalCount } where totalCount is the overall pool size
// for this search (used for sanity / cost estimation; optional).
function parseBooliSearchCards(apolloState) {
  if (!apolloState || typeof apolloState !== 'object') return { cards: [] };

  // Find ROOT_QUERY.searchForSale(<args>).result — the result key includes the
  // serialized args (e.g. `searchForSale({"input":{"areaIds":[2],"page":1}})`),
  // so we scan ROOT_QUERY keys for any starting with 'searchForSale'.
  const root = apolloState.ROOT_QUERY;
  if (!root || typeof root !== 'object') return { cards: [] };

  let searchResult = null;
  for (const key of Object.keys(root)) {
    if (!key.startsWith('searchForSale')) continue;
    const v = root[key];
    if (v && typeof v === 'object' && Array.isArray(v.result)) {
      searchResult = v;
      break;
    }
  }
  if (!searchResult) return { cards: [] };

  const refs = searchResult.result;
  const totalCount = typeof searchResult.totalCount === 'number' ? searchResult.totalCount : null;

  const cards = [];
  for (const ref of refs) {
    const key = (ref && typeof ref === 'object' && typeof ref.__ref === 'string') ? ref.__ref : null;
    if (!key) continue;
    const listing = apolloState[key];
    if (!listing || typeof listing !== 'object') continue;
    if (listing.__typename !== 'Listing') continue;

    cards.push({
      booli_id: listing.id != null ? String(listing.id) : null,
      residence_id: listing.residenceId != null ? String(listing.residenceId) : null,
      url: typeof listing.url === 'string' ? listing.url : null,
      streetAddress: typeof listing.streetAddress === 'string' ? listing.streetAddress : null,
      // Booli wire format is 'YYYY-MM-DD HH:MM:SS' string. Older fixtures show
      // a Unix-seconds number — handle both via parsePublishedToUnix.
      published: parsePublishedToUnix(listing.published),
      upcomingSale: listing.upcomingSale === true,
      objectType: typeof listing.objectType === 'string' ? listing.objectType : null,
    });
  }

  return totalCount != null ? { cards, totalCount } : { cards };
}

// Public: fetch a Booli search page and parse the ordered card array.
// areaId: one of 2 (Stockholm), 23 (VG), 64 (Skåne), 118 (Uppsala).
// opts.page: 1-based (default 1).
// opts.logger: cron-wrapper log function.
//
// CRITICAL: do NOT include any sort= parameter — spike 002 proved any sort=*
// flips Booli's server to ascending=true (oldest-first). Default sort (no param)
// is newest-first.
//
// Returns: { cards, totalCount? }.
// Throws on persistent fetch error, missing __NEXT_DATA__, missing __APOLLO_STATE__.
async function fetchBooliSearch(areaId, opts = {}) {
  const page = opts.page != null ? opts.page : 1;
  const log = opts.logger || noopLogger;
  // Per D-08 + spike 002: NO sort param. Use simple `?areaIds=X&page=N`.
  const targetUrl = `https://www.booli.se/sok/till-salu?areaIds=${areaId}&page=${page}`;
  const res = await getWithRetry(targetUrl, opts);
  if (res.status === 404) {
    // Search pages should never 404 for a valid areaId.
    throw new Error(
      `booli-fetch: search returned 404 for areaId=${areaId} page=${page} — unexpected`,
    );
  }
  const data = extractNextData(res.html);
  const apolloState =
    data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apolloState) {
    throw new Error(
      `booli-fetch: no __APOLLO_STATE__ in search for areaId=${areaId} page=${page}`,
    );
  }
  return parseBooliSearchCards(apolloState);
}

// Public: fetch a Booli detail page and parse the listing.
// listingUrl: full URL from a search card — server-provided (Listing.url).
//   May be either flavor: '/annons/<annons_id>' or '/bostad/<residence_id>'.
//   Per spike 002 we MUST use the server-supplied URL — do NOT construct.
//
// Returns:
//   { status: 'active', listing }    on success
//   { status: 'inactive', reason: '404' | 'no-apollo-state' | 'no-listing-object' }
// Throws on persistent fetch error or missing __NEXT_DATA__.
async function fetchBooliDetail(listingUrl, opts = {}) {
  const log = opts.logger || noopLogger;
  // listingUrl may be relative; if so, prepend the Booli origin.
  let absoluteUrl = listingUrl;
  if (typeof listingUrl === 'string' && listingUrl.startsWith('/')) {
    absoluteUrl = `https://www.booli.se${listingUrl}`;
  }

  const res = await getWithRetry(absoluteUrl, opts);
  if (res.status === 404) {
    log('INFO', `${absoluteUrl} 404 -> inactive`);
    return { status: 'inactive', reason: '404' };
  }
  const data = extractNextData(res.html);
  const apolloState =
    data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apolloState) {
    throw new Error(`booli-fetch: no __APOLLO_STATE__ in detail for ${absoluteUrl}`);
  }
  return parseBooliListing(apolloState, { logger: log });
}

module.exports = {
  fetchBooliSearch,
  fetchBooliDetail,
  parseBooliSearchCards,
  parseBooliListing,
  parsePublishedToUnix,
  // Phase 7.1: shared Oxylabs stats — pass-through from scrape-http (same module-level
  // state as lib/hemnet-fetch.js's getOxylabsStats — see D-05).
  getOxylabsStats,
  resetOxylabsStats,
};

// ---------------------------------------------------------------------------
// --smoke self-test (pure-function; no live network, no DB).
// Run with: node lib/booli-fetch.js --smoke
//
// IMPORTANT: gate on `require.main === module` so this block ONLY runs when
// the file is invoked directly, NOT when it's required by booli-targeted-discovery.js
// (which has its own smoke block and would otherwise be hijacked by this one's
// process.exit at the bottom).
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- parsePublishedToUnix (string-vs-number tolerance) ---
  check('parsePublished: Unix seconds number passes through', () => {
    assert.strictEqual(parsePublishedToUnix(1714521600), 1714521600);
  });
  check('parsePublished: YYYY-MM-DD HH:MM:SS string → Unix seconds (UTC)', () => {
    // 2026-05-12 07:21:10 UTC = 1778660470
    const expected = Math.floor(Date.UTC(2026, 4, 12, 7, 21, 10) / 1000);
    assert.strictEqual(parsePublishedToUnix('2026-05-12 07:21:10'), expected);
  });
  check('parsePublished: ISO T-separator also accepted', () => {
    const expected = Math.floor(Date.UTC(2026, 4, 12, 7, 21, 10) / 1000);
    assert.strictEqual(parsePublishedToUnix('2026-05-12T07:21:10'), expected);
  });
  check('parsePublished: date-only string → midnight UTC', () => {
    const expected = Math.floor(Date.UTC(2026, 4, 12) / 1000);
    assert.strictEqual(parsePublishedToUnix('2026-05-12'), expected);
  });
  check('parsePublished: garbage → null', () => {
    assert.strictEqual(parsePublishedToUnix(null), null);
    assert.strictEqual(parsePublishedToUnix(undefined), null);
    assert.strictEqual(parsePublishedToUnix('not a date'), null);
    assert.strictEqual(parsePublishedToUnix({}), null);
  });

  // --- parseBooliSearchCards ---
  check('search: empty apollo returns empty cards', () => {
    const r = parseBooliSearchCards({});
    assert.strictEqual(r.cards.length, 0);
  });
  check('search: missing ROOT_QUERY returns empty cards', () => {
    const r = parseBooliSearchCards({ 'Listing:1': { __typename: 'Listing', id: 1 } });
    assert.strictEqual(r.cards.length, 0);
  });
  check('search: ROOT_QUERY.searchForSale().result is read in order', () => {
    const apollo = {
      'ROOT_QUERY': {
        'searchForSale({"input":{"areaIds":[2],"page":1}})': {
          result: [
            { __ref: 'Listing:100' },
            { __ref: 'Listing:101' },
          ],
          totalCount: 13113,
        },
      },
      'Listing:100': { __typename: 'Listing', id: 100, residenceId: 200, url: '/bostad/200', streetAddress: 'A 1', published: 1714521600, upcomingSale: false, objectType: 'house' },
      'Listing:101': { __typename: 'Listing', id: 101, residenceId: null, url: '/annons/101', streetAddress: 'B 2', published: 1714000000, upcomingSale: true, objectType: 'apartment' },
      'Listing:999': { __typename: 'Listing', id: 999, residenceId: 888, url: '/bostad/888', streetAddress: 'CROSS-SELL', published: 1700000000, upcomingSale: false }, // cross-sell — must NOT appear in cards
    };
    const r = parseBooliSearchCards(apollo);
    assert.strictEqual(r.cards.length, 2);
    assert.strictEqual(r.cards[0].booli_id, '100');
    assert.strictEqual(r.cards[0].upcomingSale, false);
    assert.strictEqual(r.cards[1].booli_id, '101');
    assert.strictEqual(r.cards[1].upcomingSale, true);
    assert.strictEqual(r.totalCount, 13113);
  });

  // --- parseBooliListing ---
  check('detail: empty apollo returns inactive', () => {
    const r = parseBooliListing({});
    assert.strictEqual(r.status, 'inactive');
  });
  check('detail: missing Listing returns inactive/no-listing-object', () => {
    const r = parseBooliListing({ 'Area_V3:2': { __typename: 'Area_V3', type: 'county', name: 'Stockholms län' } });
    assert.strictEqual(r.status, 'inactive');
    assert.strictEqual(r.reason, 'no-listing-object');
  });
  check('detail: full parse extracts all fields incl. postcode int + pageviews regex', () => {
    const apollo = {
      'Listing:6113019': {
        __typename: 'Listing',
        id: 6113019,
        residenceId: 99999,
        url: 'https://www.booli.se/bostad/99999',
        streetAddress: 'Kvillegatan 1',
        published: 1714521600,
        upcomingSale: false,
        objectType: 'apartment',
        displayAttributes: {
          infoSections: [{
            content: {
              infoPoints: [
                { __typename: 'InfoPoint', key: 'pageviews', displayText: { markdown: 'Bostaden har **55** sidvisningar' } },
                { __typename: 'InfoPoint', key: 'something-else', displayText: { markdown: 'irrelevant' } },
              ],
            },
          }],
        },
      },
      'Area_V3:23': { __typename: 'Area_V3', type: 'county', name: 'Västra Götalands län' },
      'Area_V3:22': { __typename: 'Area_V3', type: 'municipality', name: 'Göteborg' },
      'Area_V3:861373': { __typename: 'Area_V3', type: 'postcode', name: '41704' },
    };
    const r = parseBooliListing(apollo);
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.listing.booli_id, '6113019');
    assert.strictEqual(r.listing.residence_id, '99999');
    assert.strictEqual(r.listing.url, 'https://www.booli.se/bostad/99999');
    assert.strictEqual(r.listing.streetAddress, 'Kvillegatan 1');
    assert.strictEqual(r.listing.postcode, 41704);            // INT cast from string
    assert.strictEqual(r.listing.municipality, 'Göteborg');
    assert.strictEqual(r.listing.county, 'Västra Götalands län');  // WITH ' län' suffix
    assert.strictEqual(r.listing.published, 1714521600);
    assert.strictEqual(r.listing.isPreMarket, false);
    assert.strictEqual(r.listing.timesViewed, 55);
  });
  check('detail: upcomingSale=true → isPreMarket=true', () => {
    const apollo = {
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: true },
    };
    const r = parseBooliListing(apollo);
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.listing.isPreMarket, true);
  });
  check('detail: missing pageviews InfoPoint -> timesViewed null (not crash)', () => {
    const apollo = {
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: false, displayAttributes: { infoSections: [] } },
    };
    const r = parseBooliListing(apollo);
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.listing.timesViewed, null);
  });
  check('search: card.published as string is parsed to Unix seconds', () => {
    const apollo = {
      'ROOT_QUERY': {
        'searchForSale({"input":{"areaIds":[2],"page":1}})': {
          result: [{ __ref: 'Listing:1' }],
        },
      },
      'Listing:1': {
        __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X',
        published: '2026-05-12 07:21:10', upcomingSale: false,
      },
    };
    const r = parseBooliSearchCards(apollo);
    assert.strictEqual(r.cards.length, 1);
    assert.strictEqual(r.cards[0].published, Math.floor(Date.UTC(2026, 4, 12, 7, 21, 10) / 1000));
  });
  check('detail: listing.published as string is parsed to Unix seconds', () => {
    const apollo = {
      'Listing:1': {
        __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X',
        published: '2026-05-12 07:21:10', upcomingSale: false,
      },
    };
    const r = parseBooliListing(apollo);
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.listing.published, Math.floor(Date.UTC(2026, 4, 12, 7, 21, 10) / 1000));
  });
  check('detail: postcode non-numeric string -> postcode null (not crash)', () => {
    const apollo = {
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: false },
      'Area_V3:1': { __typename: 'Area_V3', type: 'postcode', name: 'BAD_DATA' },
    };
    const r = parseBooliListing(apollo);
    assert.strictEqual(r.listing.postcode, null);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
