// hemnet-fetch.js — Hemnet GET-with-retry, __NEXT_DATA__ parser,
// ActivePropertyListing + ListingCard extractors, Apollo __ref resolver.
//
// Pure CommonJS. HTTP layer shells out to `curl` because Cloudflare
// fingerprints Node's native fetch TLS/HTTP/2 handshake and serves the
// "Just a moment..." challenge — curl with realistic headers passes
// cleanly. curl is universally available on Windows 10+ and Linux.
// No new npm dependencies. Caller passes optional `logger(level, msg)`.
//
// Behavior locked by .planning/phases/06-scraping-core-location-cache/06-CONTEXT.md.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_ATTEMPTS = 3;
const CURL_TIMEOUT_SEC = 30;

function noopLogger() {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Internal: single curl invocation. Returns { status, html } where html may
// be empty on non-2xx. Rejects only on curl process error (e.g. binary
// missing, network completely unreachable) — HTTP errors come back via the
// status code, not as exceptions, so the retry layer above can decide.
function curlOnce(targetUrl) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `hemnet-fetch-${process.pid}-${crypto.randomBytes(8).toString('hex')}.html`,
    );

    const args = [
      '-sS',                  // silent but show errors
      '--compressed',         // accept + decompress gzip/br
      '--http1.1',            // skip HTTP/2 — Cloudflare flags Node's H2 handshake
      '--max-time', String(CURL_TIMEOUT_SEC),
      '-o', tmpFile,          // body to temp file
      '-w', '%{http_code}',   // status code to stdout
    ];
    for (const [k, v] of Object.entries(DEFAULT_HEADERS)) {
      args.push('-H', `${k}: ${v}`);
    }
    args.push(targetUrl);

    execFile('curl', args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      let html = '';
      try {
        html = fs.readFileSync(tmpFile, 'utf8');
      } catch (_) {
        // file may not exist if curl errored before writing
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) { /* best effort */ }
      }

      if (err) {
        // Curl process error (binary missing, DNS, connection refused, etc.)
        return reject(err);
      }
      const status = parseInt(String(stdout).trim(), 10);
      if (!Number.isFinite(status)) {
        return reject(new Error(`hemnet-fetch: curl returned non-numeric status "${stdout}"`));
      }
      resolve({ status, html });
    });
  });
}

// Internal: GET a URL with exponential backoff on 429/5xx and network errors.
// On success returns { status, html }. On 404 returns { status: 404 } without
// retrying. Throws after MAX_ATTEMPTS persistent failures.
async function getWithRetry(targetUrl, opts = {}) {
  const log = opts.logger || noopLogger;

  let lastErr = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await curlOnce(targetUrl);

      if (res.status === 404) {
        return { status: 404 };
      }
      // 403 from Hemnet is the Cloudflare "Just a moment..." challenge —
      // transient and often clears after a backoff. Treat like 429/5xx.
      if (res.status === 403 || res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastStatus = res.status;
        log('WARN', `${targetUrl} returned ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        break;
      }
      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, html: res.html };
      }
      // Other non-2xx, non-404, non-retryable: surface body for debugging
      throw new Error(
        `hemnet-fetch: ${targetUrl} returned ${res.status}: ${(res.html || '').slice(0, 200)}`,
      );
    } catch (err) {
      // Non-retryable errors thrown above are caught here too — re-throw
      // immediately if the message identifies a non-transient HTTP status.
      if (err && typeof err.message === 'string' && err.message.startsWith('hemnet-fetch: ') && err.message.includes('returned ') && !err.message.includes('returned 5') && !err.message.includes('returned 429')) {
        throw err;
      }
      lastErr = err;
      log('WARN', `${targetUrl} fetch error (attempt ${attempt}/${MAX_ATTEMPTS}): ${err && err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
    }
  }

  const detail = lastStatus
    ? `HTTP ${lastStatus}`
    : (lastErr && lastErr.message) || 'unknown error';
  log('ERROR', `${targetUrl} failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
  throw new Error(
    `hemnet-fetch: ${targetUrl} failed after ${MAX_ATTEMPTS} attempts: ${detail}`,
  );
}

// Extract and JSON.parse the <script id="__NEXT_DATA__"> payload.
// Returns the parsed object (NOT the Apollo state — caller pulls
// props.pageProps.__APOLLO_STATE__ themselves so this stays general).
// Throws if the tag is missing. JSON.parse errors propagate (SyntaxError).
function extractNextData(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('hemnet-fetch: extractNextData received empty input');
  }
  const m = html.match(NEXT_DATA_RE);
  if (!m) {
    throw new Error('hemnet-fetch: __NEXT_DATA__ script tag not found');
  }
  return JSON.parse(m[1]);
}

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

module.exports = {
  fetchDetail,
  fetchSearch,
  extractNextData,
  parseActiveListing,
  parseListingCards,
  resolveRef,
};
