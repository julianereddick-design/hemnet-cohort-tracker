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

  // Phase 9 follow-up (post-Django-decommission): capture price, rooms,
  // living_area, object_type, agent_id directly from Booli's Apollo state so
  // (a) Metabase reports don't regress when Django stops writing these fields,
  // and (b) Job B can use them as targeted Hemnet search filters.
  //
  // Price/rooms/livingArea are FormattedValue objects with shape:
  //   { __typename:'FormattedValue', raw:NUM, value:STR, unit:STR, formatted:STR }
  // We read `.raw` (the numeric value). Coerce to null on any deviation.
  const listPriceRaw =
    listing.listPrice && typeof listing.listPrice.raw === 'number'
      ? listing.listPrice.raw
      : null;
  const roomsRaw =
    listing.rooms && typeof listing.rooms.raw === 'number' ? listing.rooms.raw : null;
  const livingAreaRaw =
    listing.livingArea && typeof listing.livingArea.raw === 'number'
      ? listing.livingArea.raw
      : null;
  const objectTypeStr =
    typeof listing.objectType === 'string' && listing.objectType.length > 0
      ? listing.objectType
      : null;

  // agent_id: Booli exposes the broker chain via Listing.source.__ref →
  // 'Source:N'. Look up that Source object and use its `id` (string) parsed to
  // int. Semantics differ from Django's old agent_id (Django captured an
  // individual-agent id from a different field/endpoint); this captures the
  // broker chain id. Null on any miss.
  let agentIdInt = null;
  if (listing.source && typeof listing.source === 'object' && typeof listing.source.__ref === 'string') {
    const src = apolloState[listing.source.__ref];
    if (src && typeof src === 'object' && src.id != null) {
      const n = parseInt(String(src.id), 10);
      if (Number.isFinite(n)) agentIdInt = n;
    }
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
      // Phase 9 follow-up — see comment block above for source paths.
      price: listPriceRaw,
      rooms: roomsRaw,
      livingArea: livingAreaRaw,
      objectType: objectTypeStr,
      agentId: agentIdInt,
    },
  };
}

// V2 cards dropped the absolute `published` timestamp and now state a RELATIVE
// age in Swedish prose. Observed vocabulary (Booli, 2026-09-21, areaIds=2 pages
// 1/3/6): 'Inkommet idag', 'Inkommet igår', 'N dagar på Booli', 'En månad på
// Booli', 'N månader på Booli'. 'Under försäljning' carries NO age — it marks
// project/new-construction tiles.
//
// Returns whole days, or null when the string is not an age we recognise.
// null is the safe answer: booli-targeted-discovery skips a card whose
// `published` is null rather than mis-windowing it.
//
// Month/year buckets are deliberately coarse (30/365). Everything past ~7 days
// is outside every caller's window anyway — the precision that matters is 0-7,
// and that range is expressed in exact days.
function parseDisplayDateToAgeDays(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();

  if (/^inkommet\s+idag$/.test(s)) return 0;
  if (/^inkommet\s+ig[åa]r$/.test(s)) return 1;

  let m = s.match(/^(\d+)\s+dagar?\s+p[åa]\s+booli$/);
  if (m) return parseInt(m[1], 10);

  if (/^en\s+m[åa]nad\s+p[åa]\s+booli$/.test(s)) return 30;
  m = s.match(/^(\d+)\s+m[åa]nader\s+p[åa]\s+booli$/);
  if (m) return parseInt(m[1], 10) * 30;

  if (/^ett\s+[åa]r\s+p[åa]\s+booli$/.test(s)) return 365;
  m = s.match(/^(\d+)\s+[åa]r\s+p[åa]\s+booli$/);
  if (m) return parseInt(m[1], 10) * 365;

  return null;
}

// Parse a Booli search page's __NEXT_DATA__ Apollo state into an ORDERED array
// of search-result cards.
//
// Booli migrated this API on 2026-09-13/14: `searchForSale(...).result` holding
// `Listing:<id>` refs became `searchForSaleV2(...).items({"queryContext":"SERP"})`
// holding `ListableProperty:{...}` refs. `totalCount` survived unchanged, which
// is why market-totals-daily stayed green while every enumeration job went dark.
// Both shapes are handled so old fixtures still parse and a rollback is safe.
//
// CRITICAL, unchanged from spike 002: read the ordered result array, never
// Object.values(apollo) — that mixes cross-sell strips into the page's results.
//
// CRITICAL, new in V2: the page carries TWO searchForSaleV2 nodes — the real
// one and a `forceNewConstruction:true` strip. On 2026-09-21 page 3 the strip
// held listings 18 days to 6 months old next to a genuine page of 1-day-old
// results. Taking the wrong node silently fills the cohort with stale new-builds,
// so we select the node WITHOUT forceNewConstruction.
//
// Returns: { cards: [...], totalCount } where totalCount is the overall pool size
// for this search (used for sanity / cost estimation; optional).
//
// opts.nowSec: injectable clock (seconds) — V2 ages are relative, so the derived
//   `published` depends on now. Defaults to the current time.
function parseBooliSearchCards(apolloState, opts = {}) {
  if (!apolloState || typeof apolloState !== 'object') return { cards: [] };

  const root = apolloState.ROOT_QUERY;
  if (!root || typeof root !== 'object') return { cards: [] };

  const nowSec = opts.nowSec != null ? opts.nowSec : Math.floor(Date.now() / 1000);

  // Collect every candidate node, then prefer the non-new-construction one.
  // The key embeds serialized args, so match by prefix — 'searchForSale' still
  // prefixes 'searchForSaleV2'.
  const candidates = [];
  for (const key of Object.keys(root)) {
    if (!key.startsWith('searchForSale')) continue;
    const v = root[key];
    if (!v || typeof v !== 'object') continue;

    // V1: `.result`. V2: a field whose NAME carries args, e.g.
    // `items({"queryContext":"SERP"})` — match by prefix, not equality.
    let refs = null;
    let shape = null;
    if (Array.isArray(v.result)) {
      refs = v.result;
      shape = 'v1';
    } else {
      const itemsField = Object.keys(v).find(
        (f) => f === 'items' || f.startsWith('items('),
      );
      if (itemsField && Array.isArray(v[itemsField])) {
        refs = v[itemsField];
        shape = 'v2';
      }
    }
    if (!refs) continue;
    candidates.push({ key, node: v, refs, shape });
  }
  if (!candidates.length) return { cards: [] };

  const chosen =
    candidates.find((c) => c.key.indexOf('forceNewConstruction') === -1) || candidates[0];

  const { node: searchResult, refs, shape } = chosen;
  const totalCount = typeof searchResult.totalCount === 'number' ? searchResult.totalCount : null;

  const cards = [];
  for (const ref of refs) {
    const key = (ref && typeof ref === 'object' && typeof ref.__ref === 'string') ? ref.__ref : null;
    if (!key) continue;
    const listing = apolloState[key];
    if (!listing || typeof listing !== 'object') continue;

    if (shape === 'v1') {
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
        isNewConstruction: listing.isNewConstruction === true,
      });
      continue;
    }

    // ---- V2 ----
    if (listing.__typename !== 'ListableProperty') continue;

    // originId is 'listing:<booli_id>' for real listings and 'project:<id>' for
    // new-construction tiles. Only listings are trackable: a project tile has no
    // listingId, so it cannot be fetched, upserted or paired.
    const originId = typeof listing.originId === 'string' ? listing.originId : '';
    if (!originId.startsWith('listing:')) continue;

    const tp = (listing.tracking && listing.tracking.properties) || {};
    const ageDays = parseDisplayDateToAgeDays(listing.displayDate);

    cards.push({
      booli_id:
        listing.listingId != null ? String(listing.listingId)
          : (tp.booli_id != null ? String(tp.booli_id) : null),
      // V2 SERP cards no longer carry residenceId. Only the sold pipeline reads
      // residence_id, and it takes it from the DETAIL page (parseBooliListing),
      // so nothing downstream regresses.
      residence_id: null,
      // tracking.properties.url is absolute; listing.url is relative
      // ('/annons/<id>'). fetchBooliDetail accepts either.
      url: typeof tp.url === 'string' ? tp.url
        : (typeof listing.url === 'string' ? listing.url : null),
      streetAddress: typeof listing.title === 'string' ? listing.title : null,
      published: ageDays == null ? null : nowSec - (ageDays * 86400),
      upcomingSale: tp.upcoming_sale === true,
      objectType: typeof listing.objectType === 'string' ? listing.objectType : null,
      // V2 dropped the per-card isNewConstruction boolean, but `saleType` carries
      // the same information and separates perfectly. Measured 2026-09-21 over
      // four live pages (for-sale p1/p3/p6 + pre-market p1), using the
      // forceNewConstruction node as a LABELLED positive set:
      //   normal node                     → saleType 'succession'     140/140
      //   forceNewConstruction node       → saleType 'newConstruction' 140/140
      // primaryStatus.key repeats it on the new-build side, so accept either.
      //
      // This must not be hardcoded false: premarket-flow-measure derives
      // `addsSecondhand` as (dated-in-window MINUS new-builds), so a blind false
      // counts new-builds as second-hand and INFLATES Booli's pre-market flow —
      // the exact direction that would overturn the "stock 4x but flow ~parity"
      // finding. Reading the real signal is correct whether or not new-builds
      // actually appear in the node we select.
      isNewConstruction:
        listing.saleType === 'newConstruction'
        || !!(listing.primaryStatus && listing.primaryStatus.key === 'newConstruction'),
    });
  }

  // A non-empty result array that maps to zero cards means the shape moved under
  // us again. Returning { cards: [] } is what let the 2026-09-13 migration run
  // silently for a week: booli-targeted-discovery reported success on an empty
  // crawl and only a tier-1 assertion noticed. Fail loudly instead. An EMPTY
  // refs array is the legitimate end-of-results and stays quiet.
  if (refs.length > 0 && cards.length === 0) {
    throw new Error(
      `booli-fetch: search node '${chosen.key.slice(0, 60)}' held ${refs.length} refs but ` +
      'mapped 0 cards — Booli search shape drift; parseBooliSearchCards needs updating',
    );
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
  // Thread the caller's clock through: V2 ages are RELATIVE, so a card's derived
  // `published` must be measured against the same `nowSec` the caller compares it
  // to. walkCountySearch builds its 7-day cutoff from its own nowSec — letting
  // the parser default to Date.now() would compare two slightly different clocks.
  return parseBooliSearchCards(apolloState, { nowSec: opts.nowSec });
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
  parseDisplayDateToAgeDays,
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
        objectType: 'Lägenhet',
        listPrice:   { __typename: 'FormattedValue', raw: 4250000, value: '4 250 000', unit: 'kr', formatted: '4 250 000 kr' },
        rooms:       { __typename: 'FormattedValue', raw: 2.5, value: '2.5', unit: 'rum', formatted: '2.5 rum' },
        livingArea:  { __typename: 'FormattedValue', raw: 65, value: '65', unit: 'm²', formatted: '65 m²' },
        source:      { __ref: 'Source:64' },
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
      'Source:64': { __typename: 'Source', id: '64', name: 'Länsförsäkringar Fastighetsförmedling', type: 'Broker' },
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
    // Phase 9 follow-up — new fields from Apollo state
    assert.strictEqual(r.listing.price, 4250000);
    assert.strictEqual(r.listing.rooms, 2.5);
    assert.strictEqual(r.listing.livingArea, 65);
    assert.strictEqual(r.listing.objectType, 'Lägenhet');
    assert.strictEqual(r.listing.agentId, 64);
  });
  check('detail: missing FormattedValue fields → price/rooms/livingArea/agentId null (not crash)', () => {
    const apollo = {
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: false },
    };
    const r = parseBooliListing(apollo);
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.listing.price, null);
    assert.strictEqual(r.listing.rooms, null);
    assert.strictEqual(r.listing.livingArea, null);
    assert.strictEqual(r.listing.objectType, null);
    assert.strictEqual(r.listing.agentId, null);
  });
  check('detail: source __ref points to missing Source object → agentId null', () => {
    const apollo = {
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: false, source: { __ref: 'Source:NOPE' } },
    };
    const r = parseBooliListing(apollo);
    assert.strictEqual(r.listing.agentId, null);
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

  // --- parseBooliSearchCards: isNewConstruction (additive field) ---
  check('search: isNewConstruction surfaced true', () => {
    const apollo = {
      'ROOT_QUERY': { 'searchForSale({"input":{"areaIds":[2],"page":1}})': { result: [{ __ref: 'Listing:1' }] } },
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: true, isNewConstruction: true },
    };
    const r = parseBooliSearchCards(apollo);
    assert.strictEqual(r.cards[0].isNewConstruction, true);
  });
  check('search: isNewConstruction defaults false when absent', () => {
    const apollo = {
      'ROOT_QUERY': { 'searchForSale({"input":{"areaIds":[2],"page":1}})': { result: [{ __ref: 'Listing:1' }] } },
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: true },
    };
    const r = parseBooliSearchCards(apollo);
    assert.strictEqual(r.cards[0].isNewConstruction, false);
  });

  // ---------------------------------------------------------------
  //   searchForSaleV2 — the 2026-09-13/14 Booli migration
  //   Fixtures mirror the live payload captured 2026-09-21 (areaIds=2,
  //   pages 1/3/6). See parseBooliSearchCards' header for the shape change.
  // ---------------------------------------------------------------
  const NOW = 1758400000;               // fixed clock; V2 ages are relative
  const DAY = 86400;
  const ITEMS = 'items({"queryContext":"SERP"})';

  // Every displayDate string actually observed on Booli, plus the shapes that
  // must NOT be mistaken for an age.
  check('displayDate: the observed Swedish vocabulary maps to day ages', () => {
    assert.strictEqual(parseDisplayDateToAgeDays('Inkommet idag'), 0);
    assert.strictEqual(parseDisplayDateToAgeDays('Inkommet igår'), 1);
    assert.strictEqual(parseDisplayDateToAgeDays('2 dagar på Booli'), 2);
    assert.strictEqual(parseDisplayDateToAgeDays('5 dagar på Booli'), 5);
    assert.strictEqual(parseDisplayDateToAgeDays('18 dagar på Booli'), 18);
    assert.strictEqual(parseDisplayDateToAgeDays('En månad på Booli'), 30);
    assert.strictEqual(parseDisplayDateToAgeDays('4 månader på Booli'), 120);
  });
  check('displayDate: an unrecognised string is null, never 0', () => {
    // 'Under försäljning' marks project tiles and carries NO age. Returning 0
    // would make a months-old new-build look listed today and pull it into the
    // 7-day cohort window.
    assert.strictEqual(parseDisplayDateToAgeDays('Under försäljning'), null);
    assert.strictEqual(parseDisplayDateToAgeDays(''), null);
    assert.strictEqual(parseDisplayDateToAgeDays(null), null);
    assert.strictEqual(parseDisplayDateToAgeDays('2026-09-20'), null);
  });

  function v2Card(id, displayDate, extra) {
    return Object.assign({
      __typename: 'ListableProperty',
      originId: `listing:${id}`,
      listingId: String(id),
      title: `Gatan ${id}`,
      url: `/annons/${id}`,
      objectType: 'Lägenhet',
      displayDate,
      tracking: { properties: {
        booli_id: id, url: `https://www.booli.se/annons/${id}`, upcoming_sale: false,
      } },
    }, extra || {});
  }

  check('searchV2: items(...) is read and mapped like the old .result', () => {
    const apollo = {
      ROOT_QUERY: {
        'searchForSaleV2({"input":{"areaIds":[2],"page":1}})': {
          totalCount: 59958,
          [ITEMS]: [{ __ref: 'ListableProperty:a' }, { __ref: 'ListableProperty:b' }],
        },
      },
      'ListableProperty:a': v2Card(6274528, 'Inkommet idag'),
      'ListableProperty:b': v2Card(6275857, '3 dagar på Booli'),
    };
    const r = parseBooliSearchCards(apollo, { nowSec: NOW });
    assert.strictEqual(r.cards.length, 2);
    assert.strictEqual(r.totalCount, 59958);
    assert.strictEqual(r.cards[0].booli_id, '6274528');
    assert.strictEqual(r.cards[0].streetAddress, 'Gatan 6274528');
    assert.strictEqual(r.cards[0].url, 'https://www.booli.se/annons/6274528');
    assert.strictEqual(r.cards[0].upcomingSale, false);
    assert.strictEqual(r.cards[0].published, NOW, 'listed today → age 0');
    assert.strictEqual(r.cards[1].published, NOW - 3 * DAY, '3 dagar → 3 days back');
  });

  check('searchV2: order is preserved (the cutoff terminator depends on it)', () => {
    const apollo = {
      ROOT_QUERY: { 'searchForSaleV2({"page":1})': {
        [ITEMS]: [{ __ref: 'ListableProperty:x' }, { __ref: 'ListableProperty:y' }],
      } },
      'ListableProperty:x': v2Card(11, 'Inkommet idag'),
      'ListableProperty:y': v2Card(22, 'Inkommet igår'),
    };
    const r = parseBooliSearchCards(apollo, { nowSec: NOW });
    assert.deepStrictEqual(r.cards.map(c => c.booli_id), ['11', '22']);
  });

  // The trap that would silently poison the cohort: on 2026-09-21 page 3 the
  // forceNewConstruction strip held 18-day to 6-month-old tiles beside a
  // genuine page of 1-day-old results.
  check('searchV2: the forceNewConstruction node is NOT the one selected', () => {
    const apollo = {
      ROOT_QUERY: {
        'searchForSaleV2({"forceNewConstruction":true,"input":{"page":3}})': {
          totalCount: 1497, [ITEMS]: [{ __ref: 'ListableProperty:old' }],
        },
        'searchForSaleV2({"input":{"page":3}})': {
          totalCount: 59958, [ITEMS]: [{ __ref: 'ListableProperty:new' }],
        },
      },
      'ListableProperty:old': v2Card(999, 'En månad på Booli'),
      'ListableProperty:new': v2Card(111, 'Inkommet igår'),
    };
    const r = parseBooliSearchCards(apollo, { nowSec: NOW });
    assert.strictEqual(r.cards.length, 1);
    assert.strictEqual(r.cards[0].booli_id, '111', 'the real result node must win');
    assert.strictEqual(r.totalCount, 59958);
  });

  check('searchV2: project: tiles are excluded — only listing: is trackable', () => {
    const apollo = {
      ROOT_QUERY: { 'searchForSaleV2({"page":1})': {
        [ITEMS]: [{ __ref: 'ListableProperty:p' }, { __ref: 'ListableProperty:l' }],
      } },
      'ListableProperty:p': {
        __typename: 'ListableProperty', originId: 'project:17280',
        title: 'Brunnby Park', displayDate: 'Under försäljning', tracking: { properties: {} },
      },
      'ListableProperty:l': v2Card(6270603, 'Inkommet idag'),
    };
    const r = parseBooliSearchCards(apollo, { nowSec: NOW });
    assert.strictEqual(r.cards.length, 1);
    assert.strictEqual(r.cards[0].booli_id, '6270603');
  });

  // Regression for the week-long silent outage: returning { cards: [] } here is
  // what let booli-targeted-discovery report success on an empty crawl.
  check('searchV2: refs present but nothing mappable THROWS, not empty', () => {
    const apollo = {
      ROOT_QUERY: { 'searchForSaleV3({"page":1})': { [ITEMS]: [{ __ref: 'Whatever:1' }] } },
      'Whatever:1': { __typename: 'SomethingNew', id: 1 },
    };
    assert.throws(
      () => parseBooliSearchCards(apollo, { nowSec: NOW }),
      /shape drift/,
      'a shape change must be loud — silence cost a week of cohorts',
    );
  });
  // premarket-flow-measure computes addsSecondhand as (dated-in-window MINUS
  // new-builds), so a card wrongly marked second-hand inflates Booli's flow.
  check('searchV2: saleType newConstruction marks a new-build', () => {
    const apollo = {
      ROOT_QUERY: { 'searchForSaleV2({"page":1})': { [ITEMS]: [
        { __ref: 'ListableProperty:s' }, { __ref: 'ListableProperty:n' },
      ] } },
      'ListableProperty:s': v2Card(1, 'Inkommet idag', { saleType: 'succession' }),
      'ListableProperty:n': v2Card(2, 'Inkommet idag', {
        saleType: 'newConstruction',
        primaryStatus: { __typename: 'TagWithIcon', key: 'newConstruction' },
      }),
    };
    const r = parseBooliSearchCards(apollo, { nowSec: NOW });
    assert.strictEqual(r.cards[0].isNewConstruction, false, 'succession is second-hand');
    assert.strictEqual(r.cards[1].isNewConstruction, true, 'newConstruction must be flagged');
  });
  check('searchV2: primaryStatus alone is enough to flag a new-build', () => {
    const apollo = {
      ROOT_QUERY: { 'searchForSaleV2({"page":1})': { [ITEMS]: [{ __ref: 'ListableProperty:n' }] } },
      'ListableProperty:n': v2Card(3, 'Inkommet idag', {
        saleType: null, primaryStatus: { key: 'newConstruction' },
      }),
    };
    assert.strictEqual(parseBooliSearchCards(apollo, { nowSec: NOW }).cards[0].isNewConstruction, true);
  });
  check('searchV2: isNewConstruction is a real boolean, never undefined', () => {
    const apollo = {
      ROOT_QUERY: { 'searchForSaleV2({"page":1})': { [ITEMS]: [{ __ref: 'ListableProperty:x' }] } },
      'ListableProperty:x': v2Card(4, 'Inkommet idag', { saleType: null, primaryStatus: null }),
    };
    assert.strictEqual(parseBooliSearchCards(apollo, { nowSec: NOW }).cards[0].isNewConstruction, false);
  });

  check('searchV2: a genuinely empty result page stays quiet', () => {
    const apollo = { ROOT_QUERY: { 'searchForSaleV2({"page":99})': { totalCount: 0, [ITEMS]: [] } } };
    const r = parseBooliSearchCards(apollo, { nowSec: NOW });
    assert.deepStrictEqual(r.cards, [], 'end-of-results is not an error');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
