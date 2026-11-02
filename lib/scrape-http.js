// scrape-http.js — Shared HTTP transport for Hemnet + Booli scraping. Holds the
// curl --http1.1 shellout (Cloudflare-bypass), Oxylabs Web Scraper API fallback,
// __NEXT_DATA__ extractor, retry envelope, and module-level Oxylabs stats
// counters. Site-specific parsers (lib/hemnet-fetch.js, lib/booli-fetch.js)
// consume this module — they do not implement their own HTTP layer.
//
// Phase 8 refactor of the original lib/hemnet-fetch.js HTTP core. Public
// surface and behavior are unchanged from Phase 7.1; only the file location
// has moved. _oxStats counters are module-level (singleton) — both Hemnet and
// Booli callers see combined oxylabsCallCount/oxylabsFailureCount/directSuccessCount.
//
// Environment overrides:
//   SCRAPE_FORCE_OXYLABS=1   — skip direct curl, route every call through Oxylabs
//   HEMNET_FORCE_OXYLABS=1   — backwards-compat alias for the same flag
//
// Pure CommonJS. No new npm deps.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

// ---------------------------------------------------------------
// Phase 7.1: Oxylabs Web Scraper API fallback configuration.
// Direct curl path runs first; if it exhausts MAX_ATTEMPTS on
// 403/429/5xx, we transparently retry via Oxylabs (1 internal retry).
// SCRAPE_FORCE_OXYLABS=1 (or HEMNET_FORCE_OXYLABS=1 alias) skips direct
// entirely and routes every call through Oxylabs — used by the
// verification probe.
// ---------------------------------------------------------------
const OXYLABS_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries';
const OXYLABS_TIMEOUT_MS = 90_000;
const OXYLABS_MAX_ATTEMPTS = 2; // initial + 1 retry
const FORCE_OXYLABS =
  process.env.SCRAPE_FORCE_OXYLABS === '1' ||
  process.env.HEMNET_FORCE_OXYLABS === '1';

let _oxStats = {
  oxylabsCallCount: 0,
  oxylabsFailureCount: 0,
  directSuccessCount: 0,
};

function resetOxylabsStats() {
  _oxStats = {
    oxylabsCallCount: 0,
    oxylabsFailureCount: 0,
    directSuccessCount: 0,
  };
}

function getOxylabsStats() {
  const total = _oxStats.oxylabsCallCount + _oxStats.directSuccessCount;
  const oxylabsFallbackRate = total > 0 ? _oxStats.oxylabsCallCount / total : 0;
  return {
    oxylabsCallCount: _oxStats.oxylabsCallCount,
    oxylabsFailureCount: _oxStats.oxylabsFailureCount,
    directSuccessCount: _oxStats.directSuccessCount,
    oxylabsFallbackRate,
  };
}

// NOTE: Accept-Encoding is intentionally omitted. `curl --compressed`
// already negotiates compression (gzip/deflate/br/zstd) and handles
// decompression. Setting an explicit -H Accept-Encoding alongside
// --compressed caused intermittent curl error 61 ("Unrecognized content
// encoding type") on responses where Hemnet returned brotli — discovered
// during Phase 7 dry-run on id 18013004. Removing the manual header
// resolved it without affecting Cloudflare bypass.
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
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

// Internal: single Oxylabs Web Scraper API invocation. Returns { status, html }
// on success (status === 200 with parseable __NEXT_DATA__ HTML, or status === 404
// passthrough). Throws structured errors (err.code set) on any failure so the
// fallback wrapper can categorize and decide whether to retry.
//
// Failure codes:
//   OXYLABS_NO_CREDS      - OXYLABS_USERNAME or OXYLABS_PASSWORD missing
//   OXYLABS_API_NON_200   - Oxylabs API itself returned non-200
//   OXYLABS_PARSE         - Oxylabs response body was not valid JSON
//   OXYLABS_NO_CONTENT    - JSON shape lacked results[0]
//   OXYLABS_TARGET_NON_200 - target URL (the Hemnet page) returned non-2xx (and not 404)
//   OXYLABS_NO_NEXT_DATA  - HTML returned but no __NEXT_DATA__ tag
//   OXYLABS_NET           - low-level network/timeout error
function fetchViaOxylabs(targetUrl) {
  return new Promise((resolve, reject) => {
    const username = process.env.OXYLABS_USERNAME;
    const password = process.env.OXYLABS_PASSWORD;
    if (!username || !password) {
      const err = new Error('oxylabs: missing-credentials');
      err.code = 'OXYLABS_NO_CREDS';
      return reject(err);
    }
    // Phase 9 / Plan 09-1.5 (D-14): paid-plan request shape. See
    // scripts/oxylabs-plan-shortlist.md for plan selection rationale and
    // verf09-1-5-logs/chosen-plan.txt for the active values.
    // Active config: plan=B (Advanced $249/mo), source=universal, render=none, premium=false.
    const body = JSON.stringify({
      source: 'universal',
      url: targetUrl,
      geo_location: 'Sweden',
      user_agent_type: 'desktop',
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
        timeout: OXYLABS_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            const err = new Error(
              `oxylabs: api-non-200 status=${res.statusCode} body=${txt.slice(0, 300)}`,
            );
            err.code = 'OXYLABS_API_NON_200';
            return reject(err);
          }
          let json;
          try {
            json = JSON.parse(txt);
          } catch (_) {
            const err = new Error('oxylabs: parse-error');
            err.code = 'OXYLABS_PARSE';
            return reject(err);
          }
          const result = json && Array.isArray(json.results) && json.results[0];
          if (!result) {
            const err = new Error('oxylabs: no-content');
            err.code = 'OXYLABS_NO_CONTENT';
            return reject(err);
          }
          const targetStatus = result.status_code;
          if (targetStatus === 404) {
            return resolve({ status: 404, html: '' });
          }
          if (typeof targetStatus !== 'number' || targetStatus < 200 || targetStatus >= 300) {
            const err = new Error(`oxylabs: target-non-200 status=${targetStatus}`);
            err.code = 'OXYLABS_TARGET_NON_200';
            return reject(err);
          }
          const html = result.content || '';
          if (!hasParseablePayload(html)) {
            const err = new Error('oxylabs: no-next-data');
            err.code = 'OXYLABS_NO_NEXT_DATA';
            return reject(err);
          }
          resolve({ status: 200, html });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => {
      const err = new Error(`oxylabs: ${e && e.message ? e.message : 'unknown'}`);
      err.code = 'OXYLABS_NET';
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

// Wraps fetchViaOxylabs with: 1 internal retry, module-level counter accounting,
// structured logging. Increments oxylabsCallCount once per fallback invocation
// (regardless of internal retries). Increments oxylabsFailureCount once if both
// attempts fail. Returns { status, html } on success; throws the final Oxylabs
// error on failure (caller decides whether to surface or substitute with the
// original direct-curl error).
async function fallbackViaOxylabs(targetUrl, opts, lastStatus) {
  const log = (opts && opts.logger) || noopLogger;
  _oxStats.oxylabsCallCount++;
  log(
    'INFO',
    `oxylabs-fallback url=${targetUrl} direct-status=${lastStatus != null ? lastStatus : 'none'} attempt=1`,
  );
  const t0 = Date.now();
  try {
    const res = await fetchViaOxylabs(targetUrl);
    log('INFO', `oxylabs-fallback-success url=${targetUrl} ms=${Date.now() - t0}`);
    return res;
  } catch (e1) {
    const reason1 = (e1 && e1.code) || 'unknown';
    log('WARN', `oxylabs-fallback-failed url=${targetUrl} reason=${reason1} attempt=1`);
    // CONFIG-03: sleep before retry on 613-class transient errors (OXYLABS_API_NON_200 =
    // Oxylabs API itself non-200, e.g. credit-limit HTTP 613; OXYLABS_TARGET_NON_200 =
    // target page returned non-2xx). Prevents tight-loop hammering on transient blocks.
    const transient = reason1 === 'OXYLABS_API_NON_200' || reason1 === 'OXYLABS_TARGET_NON_200';
    if (transient) {
      log('INFO', `oxylabs-fallback-backoff url=${targetUrl} reason=${reason1} sleep=3000ms`);
      await sleep(3000);
    }
    // 1 retry.
    try {
      const res = await fetchViaOxylabs(targetUrl);
      log(
        'INFO',
        `oxylabs-fallback-success url=${targetUrl} ms=${Date.now() - t0} attempt=2`,
      );
      return res;
    } catch (e2) {
      _oxStats.oxylabsFailureCount++;
      const reason2 = (e2 && e2.code) || 'unknown';
      log('WARN', `oxylabs-fallback-failed url=${targetUrl} reason=${reason2} attempt=2`);
      throw e2;
    }
  }
}

// Internal: single curl invocation. Returns { status, html } where html may
// be empty on non-2xx. Rejects only on curl process error (e.g. binary
// missing, network completely unreachable) — HTTP errors come back via the
// status code, not as exceptions, so the retry layer above can decide.
function curlOnce(targetUrl) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `scrape-http-${process.pid}-${crypto.randomBytes(8).toString('hex')}.html`,
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
        return reject(new Error(`scrape-http: curl returned non-numeric status "${stdout}"`));
      }
      resolve({ status, html });
    });
  });
}

// Public: GET a URL with exponential backoff on 429/5xx and network errors.
// On success returns { status, html }. On 404 returns { status: 404 } without
// retrying. Throws after MAX_ATTEMPTS persistent failures — UNLESS the failure
// is fallback-eligible (403/429/5xx) AND Oxylabs credentials are configured,
// in which case it transparently retries via the Oxylabs Web Scraper API.
//
// SCRAPE_FORCE_OXYLABS=1 (or HEMNET_FORCE_OXYLABS=1 alias) short-circuits the
// direct path entirely.
async function getWithRetry(targetUrl, opts = {}) {
  const log = opts.logger || noopLogger;

  // Phase 7.1: Force-Oxylabs short-circuit. Skip direct curl entirely.
  // A debug knob to deterministically exercise the fallback path. In force
  // mode, missing credentials surface as an immediate hard error (no graceful
  // degradation).
  if (FORCE_OXYLABS) {
    try {
      return await fallbackViaOxylabs(targetUrl, opts, null);
    } catch (e) {
      const reason = e && e.message ? e.message : 'unknown';
      const isMissing = e && e.code === 'OXYLABS_NO_CREDS';
      throw new Error(
        `scrape-http: ${targetUrl} oxylabs forced-mode failed after ${OXYLABS_MAX_ATTEMPTS} attempts: ${isMissing ? 'missing-credentials' : reason}`,
      );
    }
  }

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
        // Phase 7.1: count successful direct-curl returns for fallback-rate denominator.
        _oxStats.directSuccessCount++;
        return { status: res.status, html: res.html };
      }
      // Other non-2xx, non-404, non-retryable: surface body for debugging
      throw new Error(
        `scrape-http: ${targetUrl} returned ${res.status}: ${(res.html || '').slice(0, 200)}`,
      );
    } catch (err) {
      // Non-retryable errors thrown above are caught here too — re-throw
      // immediately if the message identifies a non-transient HTTP status.
      if (err && typeof err.message === 'string' && err.message.startsWith('scrape-http: ') && err.message.includes('returned ') && !err.message.includes('returned 5') && !err.message.includes('returned 429')) {
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

  // Phase 7.1: direct path exhausted. If the final failure was 403/429/5xx
  // (fallback-eligible) AND Oxylabs credentials are present, attempt the
  // Oxylabs Web Scraper API as a transparent fallback. On Oxylabs success →
  // return its { status, html } as if direct had succeeded. On Oxylabs failure
  // (after 1 internal retry) → fall through and throw the ORIGINAL direct-curl
  // error (callers' error categorization is built around the original message).
  const fallbackEligible =
    lastStatus === 403 ||
    lastStatus === 429 ||
    (typeof lastStatus === 'number' && lastStatus >= 500 && lastStatus < 600);
  if (fallbackEligible) {
    const hasCreds = !!process.env.OXYLABS_USERNAME && !!process.env.OXYLABS_PASSWORD;
    if (!hasCreds) {
      log(
        'WARN',
        `oxylabs-fallback-skipped reason=missing-credentials url=${targetUrl}`,
      );
    } else {
      try {
        return await fallbackViaOxylabs(targetUrl, opts, lastStatus);
      } catch (_) {
        // Fall through to throw the ORIGINAL direct-curl error below.
      }
    }
  }

  const detail = lastStatus
    ? `HTTP ${lastStatus}`
    : (lastErr && lastErr.message) || 'unknown error';
  log('ERROR', `${targetUrl} failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
  throw new Error(
    `scrape-http: ${targetUrl} failed after ${MAX_ATTEMPTS} attempts: ${detail}`,
  );
}

// Extract and JSON.parse the <script id="__NEXT_DATA__"> payload.
// Returns the parsed object (NOT the Apollo state — caller pulls
// props.pageProps.__APOLLO_STATE__ themselves so this stays general).
// Throws if the tag is missing. JSON.parse errors propagate (SyntaxError).
function extractNextData(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('scrape-http: extractNextData received empty input');
  }
  const m = html.match(NEXT_DATA_RE);
  if (!m) {
    throw new Error('scrape-http: __NEXT_DATA__ script tag not found');
  }
  return JSON.parse(m[1]);
}

// Booli moved from the Next.js Pages Router to the App Router on 2026-09-21,
// so `__NEXT_DATA__` no longer exists. The same data now arrives in the React
// Server Components "flight" payload: one or more
//   self.__next_f.push([1,"<a JSON string literal>"])
// calls whose concatenated text holds the serialized tree, including the Apollo
// cache under "initialApolloState". Hemnet is still Pages Router, so this is a
// SIBLING of extractNextData, never a replacement for it.
const FLIGHT_PUSH_RE = /self\.__next_f\.push\(\[\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;

// sliceBalanced(text, openIdx) — return the substring of the JSON object or
// array starting at openIdx, honouring strings and escapes so a brace inside a
// string value cannot end the scan early. Returns null if it never closes.
function sliceBalanced(text, openIdx) {
  const open = text[openIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

// flightText(html) — concatenate every push payload into the flight stream.
function flightText(html) {
  let out = '';
  let m;
  FLIGHT_PUSH_RE.lastIndex = 0;
  while ((m = FLIGHT_PUSH_RE.exec(html)) !== null) {
    try { out += JSON.parse(m[1]); } catch (_) { /* a chunk we cannot decode is skipped */ }
  }
  return out;
}

// extractFlightData(html) — the App Router counterpart of extractNextData.
// Returns the Apollo cache object (the same normalised {ROOT_QUERY, ...} shape
// the Pages Router served under props.pageProps.__APOLLO_STATE__) so existing
// parsers keep working. Throws loudly rather than returning an empty object:
// a silent {} would read downstream as "no listings", which is how the previous
// Booli outage stayed invisible for a week.
function extractFlightData(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('scrape-http: extractFlightData received empty input');
  }
  const flight = flightText(html);
  if (!flight) {
    throw new Error('scrape-http: no self.__next_f flight payload found');
  }
  const key = '"initialApolloState":';
  const at = flight.indexOf(key);
  if (at === -1) {
    throw new Error('scrape-http: flight payload carries no initialApolloState');
  }
  const braceAt = flight.indexOf('{', at + key.length);
  const body = braceAt === -1 ? null : sliceBalanced(flight, braceAt);
  if (!body) {
    throw new Error('scrape-http: initialApolloState did not close — truncated flight payload');
  }
  return JSON.parse(body);
}

// extractFlightEntities(html) — App Router DETAIL pages dropped the Apollo cache
// entirely: no initialApolloState, no ROOT_QUERY, no __ref, just a denormalised
// nested tree. Rebuild the flat `Typename:id` map the old normalised cache had,
// so consumers that address data by Apollo key (parseBooliListing looks up
// `Listing:<id>` by key prefix and scans Object.values for Area_V3) keep working
// with no change. Objects without an id get a positional key, which is fine:
// nothing addresses those by name.
function extractFlightEntities(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('scrape-http: extractFlightEntities received empty input');
  }
  const flight = flightText(html);
  if (!flight) {
    throw new Error('scrape-http: no self.__next_f flight payload found');
  }
  const out = {};
  const seen = new Set();
  let anon = 0;
  const visit = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { for (const v of o) visit(v); return; }
    if (typeof o.__typename === 'string') {
      const id = (o.id !== undefined && o.id !== null) ? String(o.id) : `@${anon++}`;
      const key = `${o.__typename}:${id}`;
      if (!(key in out)) out[key] = o;
    }
    for (const v of Object.values(o)) visit(v);
  };
  // Flight rows are `<id>:<json>` lines; some carry React component payloads
  // with the data nested inside. Parse whatever parses and walk it all.
  for (const line of flight.split(String.fromCharCode(10))) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const body = line.slice(at + 1).trim();
    if (!body || (body[0] !== '{' && body[0] !== '[')) continue;
    try { visit(JSON.parse(body)); } catch (_) { /* partial row, skip */ }
  }
  if (Object.keys(out).length === 0) {
    throw new Error('scrape-http: flight payload held no __typename entities');
  }
  return out;
}
// ---------------------------------------------------------------
// Hemnet moved to the App Router on ~2026-10-30 and, unlike Booli, ships no
// Apollo cache at all: no initialApolloState, no ROOT_QUERY. Search pages carry
// the result node (ListingResultsCombined / SoldListingResults, cards inline) and,
// separately, the React props of the result list holding the query variables
// (`variables: { searchParams, offset, sort }`). extractFlightSearchState rebuilds
// the OLD Pages Router shape from those two pieces, so parseSearchTotals,
// parseSearchPage, parseSearchIncludes, the census filter check and the sold
// parsers keep working unchanged:
//   ROOT_QUERY.search["listings({limit,offset,search,sort})"] = { total, cards:[{__ref}], ... }
//   ROOT_QUERY["searchSales({...})"]                         = { total, cards:[{__ref}], ... }
//   "ListingCard:<id>" / "SaleCard:<id>"                     = the card objects
// See docs/handover/CHANGELOG.md 2026-11-03.
// ---------------------------------------------------------------

// Hemnet's page size. The old listings key carried it as `limit`; parseSearchPage
// needs limit > 0 to tell the result list from the count-only keys.
const HEMNET_PAGE_SIZE = 50;

// flightRows(flight) — { rowId: parsedJson } for every `<id>:<json>` row that parses.
function flightRows(flight) {
  const rows = {};
  for (const line of flight.split(String.fromCharCode(10))) {
    // [\s\S], not `.`: listing descriptions carry U+2028/U+2029, which `.` does not match
    // (Gnosjö pre-market, 2026-11-02, failed the census on exactly that).
    const m = /^([0-9a-f]+):([[{][\s\S]*)$/.exec(line);
    if (!m) continue;
    try { rows[m[1]] = JSON.parse(m[2]); } catch (_) { /* partial row, skip */ }
  }
  return rows;
}

// resolveFlightValue(rows, v) — follow RSC references inside a value we need as
// data. "$1f" is row 1f; "$1f:props:children:0:x" walks that path, where "props"
// on a React element tuple ["$", type, key, props] means its 4th slot. "$undefined"
// means absent; "$$x" is the literal string "$x". Any other "$…" form (lazy, promise,
// date…) is not plain data, so it throws rather than passing a marker on as a value.
function resolveFlightValue(rows, v, depth = 0) {
  if (depth > 20) throw new Error('scrape-http: flight reference chain too deep');
  if (Array.isArray(v)) return v.map((x) => resolveFlightValue(rows, x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = resolveFlightValue(rows, x, depth + 1);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  if (typeof v !== 'string' || v[0] !== '$') return v;
  if (v === '$undefined') return undefined;
  if (v.startsWith('$$')) return v.slice(1);
  if (!FLIGHT_REF_RE.test(v)) throw new Error(`scrape-http: unsupported flight reference ${v.slice(0, 40)}`);
  return resolveFlightValue(rows, followFlightRef(rows, v, depth), depth + 1);
}

const FLIGHT_REF_RE = /^\$([0-9a-f]+)((?::[^:]+)*)$/;

// followFlightRef(rows, ref) — the raw value a "$<row>[:path]" reference points at.
// Only the steps of the path are dereferenced; the React trees walked through on the
// way hold markers that are not data and are never resolved.
function followFlightRef(rows, ref, depth = 0) {
  if (depth > 20) throw new Error('scrape-http: flight reference chain too deep');
  const m = FLIGHT_REF_RE.exec(ref);
  if (!(m[1] in rows)) throw new Error(`scrape-http: flight reference to missing row ${m[1]}`);
  let cur = rows[m[1]];
  for (const seg of m[2].split(':').slice(1)) {
    while (typeof cur === 'string' && FLIGHT_REF_RE.test(cur)) cur = followFlightRef(rows, cur, depth + 1);
    if (Array.isArray(cur) && cur[0] === '$' && seg === 'props') cur = cur[3];
    else if (cur != null && typeof cur === 'object') cur = cur[seg];
    else throw new Error(`scrape-http: flight reference ${ref.slice(0, 60)} does not resolve`);
  }
  return cur;
}

// Walk every parsed row, calling visit(obj) on each plain object once.
function walkFlight(rows, visit) {
  const seen = new Set();
  const stack = Object.values(rows);
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    if (!Array.isArray(o)) visit(o);
    for (const x of Array.isArray(o) ? o : Object.values(o)) if (x && typeof x === 'object') stack.push(x);
  }
}

// One result node of `typename`, or null. The same node can be serialised twice
// (data + props); identical copies are fine, two different totals are not.
function pickResultNode(rows, typename) {
  const found = [];
  walkFlight(rows, (o) => {
    if (o.__typename === typename && typeof o.total === 'number' && Array.isArray(o.cards)) found.push(o);
  });
  if (found.length === 0) return null;
  const totals = new Set(found.map((n) => n.total));
  if (totals.size > 1) {
    throw new Error(`scrape-http: ${found.length} ${typename} nodes with different totals (${[...totals].join(' vs ')})`);
  }
  return found[0];
}

// The result list's query variables, references resolved. Exactly one distinct
// `variables.searchParams` per page, or it throws.
function pickSearchVariables(rows) {
  const found = new Map();
  walkFlight(rows, (o) => {
    const v = o.variables;
    if (v && typeof v === 'object' && v.searchParams && typeof v.searchParams === 'object') {
      found.set(JSON.stringify(v), v);
    }
  });
  if (found.size !== 1) {
    throw new Error(`scrape-http: expected one result-list variables block, found ${found.size}`);
  }
  return resolveFlightValue(rows, [...found.values()][0]);
}

// Hoist the inline cards of a result node into "<Typename>:<id>" entries and
// return the node with __ref pointers in their place, as Apollo stored it.
function normaliseCards(state, node, field) {
  if (!Array.isArray(node[field])) return node[field];
  return node[field].map((c) => {
    if (!c || typeof c !== 'object' || c.id == null || typeof c.__typename !== 'string') return c;
    const key = `${c.__typename}:${c.id}`;
    state[key] = c;
    return { __ref: key };
  });
}

// extractFlightSearchState(html) — the Apollo-shaped state of a Hemnet App Router
// search page (/till-salu, /bostader, /salda). Throws when the page has no result
// node, or a for-sale result node without its query variables: a filter we
// cannot see is a filter we cannot check.
function extractFlightSearchState(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('scrape-http: extractFlightSearchState received empty input');
  }
  const flight = flightText(html);
  if (!flight) throw new Error('scrape-http: no self.__next_f flight payload found');
  const rows = flightRows(flight);
  const state = { ROOT_QUERY: { __typename: 'Query' } };

  const listings = pickResultNode(rows, 'ListingResultsCombined');
  if (listings) {
    const vars = pickSearchVariables(rows);
    const args = { limit: HEMNET_PAGE_SIZE, offset: vars.offset || 0, search: vars.searchParams };
    if (vars.sort) args.sort = vars.sort;
    const node = Object.assign({}, listings, {
      cards: normaliseCards(state, listings, 'cards'),
      recommendations: normaliseCards(state, listings, 'recommendations'),
    });
    state.ROOT_QUERY.search = { __typename: 'Search', [`listings(${JSON.stringify(args)})`]: node };
  }

  const sales = pickResultNode(rows, 'SoldListingResults');
  if (sales) {
    // Sold readers only match the `searchSales(` prefix; the args are informational.
    const node = Object.assign({}, sales, { cards: normaliseCards(state, sales, 'cards') });
    state.ROOT_QUERY[`searchSales(${JSON.stringify({ limit: HEMNET_PAGE_SIZE })})`] = node;
  }

  if (!listings && !sales) {
    throw new Error('scrape-http: flight payload carries no initialApolloState and no search result node');
  }
  return state;
}

// extractDetailState(html) — the `Typename:id` entity map of a listing DETAIL page,
// whichever router served it: Pages Router __APOLLO_STATE__, or the App Router
// flight entities (Hemnet since ~2026-10-30; some Hemnet pages, e.g. sold
// listings, were still Pages Router on 2026-11-03). Throws when neither parses.
function extractDetailState(html, label) {
  if (typeof html === 'string' && html.includes('self.__next_f')) {
    return extractFlightEntities(html);
  }
  const data = extractNextData(html);
  const st = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!st) {
    throw new Error(`scrape-http: __APOLLO_STATE__ missing for ${label || 'page'}`);
  }
  return st;
}

// hasParseablePayload(html) — does this page carry data we can extract?
// Pages Router embeds __NEXT_DATA__; App Router streams self.__next_f. Booli
// moved to the latter on 2026-09-21, Hemnet on ~2026-10-30. Accepting EITHER
// keeps the junk-page guard (a challenge or error page has neither) while no
// longer rejecting a perfectly good App Router response.
function hasParseablePayload(html) {
  if (typeof html !== 'string' || html.length === 0) return false;
  return html.includes('__NEXT_DATA__') || html.includes('self.__next_f');
}
// extractApolloState(html, label) — the one call every SEARCH-page consumer
// should use. Returns the normalised Apollo cache whichever router served the
// page, so a site migrating (Booli did, 2026-09-21; Hemnet ~2026-10-30) needs no
// change at the call site. Throws rather than returning null: a caller that
// silently treats a missing state as 'no results' is how the previous outage
// went unnoticed for a week.
//
// App Router pages: Booli still ships its Apollo cache (initialApolloState);
// Hemnet does not, so its state is rebuilt by extractFlightSearchState.
function extractApolloState(html, label) {
  if (typeof html === 'string' && html.includes('self.__next_f')) {
    if (flightText(html).includes('"initialApolloState":')) return extractFlightData(html);
    return extractFlightSearchState(html);
  }
  const data = extractNextData(html);
  const st = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!st) {
    throw new Error(`scrape-http: __APOLLO_STATE__ missing for ${label || 'page'}`);
  }
  return st;
}
module.exports = {
  getWithRetry,
  extractNextData,
  extractFlightData,
  extractFlightEntities,
  extractFlightSearchState,
  extractApolloState,
  extractDetailState,
  hasParseablePayload,
  flightText,
  resolveFlightValue,
  getOxylabsStats,
  resetOxylabsStats,
};

// ---------------------------------------------------------------
//   node lib/scrape-http.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { extractFlightData, extractFlightEntities } = module.exports;
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fail++; console.error(`SMOKE FAIL [${name}]: ${e.message}`); }
  };

  check('extractFlightData pulls initialApolloState out of a flight payload', () => {
    const inner = '1:["$","$L1e",null,{"initialApolloState":{"ROOT_QUERY":{"__typename":"Query"}}}]';
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(inner)}])</script></html>`;
    const out = extractFlightData(html);
    assert.ok(out.ROOT_QUERY, 'ROOT_QUERY must be recovered from the flight payload');
    assert.strictEqual(out.ROOT_QUERY.__typename, 'Query');
  });


  check('extractFlightData concatenates multiple pushes before parsing', () => {
    // The flight stream is chunked; an object can straddle two pushes.
    const a = '1:["$","$L1e",null,{"initialApolloState":{"ROOT_QUERY":{"__typen';
    const b = 'ame":"Query","totalCount":42}}}]';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(a)}])</script>` +
                 `<script>self.__next_f.push([2,${JSON.stringify(b)}])</script>`;
    const out = extractFlightData(html);
    assert.strictEqual(out.ROOT_QUERY.totalCount, 42,
      'an object split across two pushes must still parse');
  });

  check('extractFlightData is not fooled by braces inside string values', () => {
    const inner = '1:[{"initialApolloState":{"ROOT_QUERY":{"label":"a } brace","n":7}}}]';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
    const out = extractFlightData(html);
    assert.strictEqual(out.ROOT_QUERY.n, 7, 'a } inside a string must not end the object');
    assert.strictEqual(out.ROOT_QUERY.label, 'a } brace');
  });

  check('extractFlightData THROWS on a Pages Router page rather than returning {}', () => {
    // The previous Booli outage stayed invisible for a week because a parser
    // returned an empty result instead of failing. Silence is the bug.
    const html = '<html><script id="__NEXT_DATA__">{"props":{}}</script></html>';
    assert.throws(() => extractFlightData(html), /flight payload/i,
      'no flight payload must be loud, never an empty object');
  });

  check('extractFlightData THROWS when the payload carries no initialApolloState', () => {
    const inner = '1:["$","$L1e",null,{"somethingElse":{}}]';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
    assert.throws(() => extractFlightData(html), /initialApolloState/i);
  });

  check('extractFlightData THROWS on a truncated object rather than guessing', () => {
    const inner = '1:[{"initialApolloState":{"ROOT_QUERY":{"a":1}';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
    assert.throws(() => extractFlightData(html), /did not close|truncated/i);
  });

  check('extractFlightEntities normalises a denormalised detail tree', () => {
    // App Router detail pages dropped the Apollo cache: no initialApolloState,
    // no __ref. Rebuild a `Typename:id` map so parseBooliListing, which looks up
    // `Listing:<id>` by key prefix, keeps working unchanged.
    const row = {
      __typename: 'Listing', id: '6193653',
      area: { __typename: 'Area_V3', type: 'county', name: 'Uppsala' },
      info: [{ __typename: 'InfoPoint', key: 'pageviews',
               displayText: { __typename: 'DisplayText', markdown: 'har **538** sidvisningar' } }],
    };
    const inner = '1:' + JSON.stringify([row]);
    const html = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
    const ents = extractFlightEntities(html);
    assert.ok(ents['Listing:6193653'], 'the Listing must be keyed Listing:<id>');
    assert.strictEqual(ents['Listing:6193653'].__typename, 'Listing');
    const areas = Object.values(ents).filter(v => v && v.__typename === 'Area_V3');
    assert.strictEqual(areas.length, 1, 'nested Area_V3 must be hoisted to the top level');
    assert.strictEqual(areas[0].name, 'Uppsala');
  });

  check('hasParseablePayload accepts BOTH routers and rejects a junk page', () => {
    const { hasParseablePayload } = module.exports;
    assert.strictEqual(hasParseablePayload('<script id="__NEXT_DATA__">{}</script>'), true,
      'Pages Router (Hemnet) must still pass');
    assert.strictEqual(hasParseablePayload('<script>self.__next_f.push([1,"x"])</script>'), true,
      'App Router (Booli since 2026-09-21) must pass');
    assert.strictEqual(hasParseablePayload('<html>Just a moment...</html>'), false,
      'a page with neither payload is junk and must still be rejected loudly');
    assert.strictEqual(hasParseablePayload(''), false);
  });

  check('extractApolloState handles both routers from one call site', () => {
    const { extractApolloState } = module.exports;
    const payload = { props: { pageProps: { __APOLLO_STATE__: { ROOT_QUERY: { a: 1 } } } } };
    const pages = `<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`;
    assert.strictEqual(extractApolloState(pages, 'x').ROOT_QUERY.a, 1, 'Pages Router (Hemnet)');
    const inner = '1:[{"initialApolloState":{"ROOT_QUERY":{"b":2}}}]';
    const app = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
    assert.strictEqual(extractApolloState(app, 'x').ROOT_QUERY.b, 2, 'App Router (Booli)');
    assert.throws(() => extractApolloState('<html>nothing</html>', 'x'),
      'a page with neither shape must throw, never return an empty state');
  });

  // --- Hemnet App Router (~2026-10-30): no Apollo cache, state rebuilt from the page ---
  const { resolveFlightValue, extractFlightSearchState, extractDetailState, extractApolloState } = module.exports;
  const flightPage = (rows) => rows.map((r) =>
    `<script>self.__next_f.push([1,${JSON.stringify(r + String.fromCharCode(10))}])</script>`).join('');

  check('resolveFlightValue follows row + element-props paths, drops $undefined, unescapes $$', () => {
    const rows = {
      '5': ['$', '$L9', null, { searchParams: { groups: ['APARTMENTS'] } }],
      '6': '$5',
    };
    const v = resolveFlightValue(rows, {
      a: '$5:props:searchParams:groups', b: '$undefined', c: '$$literal', d: 7, e: '$6:props:searchParams',
    });
    assert.deepStrictEqual(v, { a: ['APARTMENTS'], c: '$literal', d: 7, e: { groups: ['APARTMENTS'] } });
  });
  check('resolveFlightValue THROWS on a non-data marker or a missing row', () => {
    assert.throws(() => resolveFlightValue({}, '$L1e'), /unsupported flight reference/);
    assert.throws(() => resolveFlightValue({}, '$7f:props'), /missing row/);
  });

  const resultsRow = (total, cards) =>
    '1:' + JSON.stringify({ __typename: 'ListingResultsCombined', total, cards, recommendations: [] });
  const varsRow = (sp, offset = 0) =>
    '2:' + JSON.stringify(['$', '$L6e', null, { variables: { searchParams: sp, sort: 'NEWEST_DAY_AND_PACKAGE', offset } }]);

  check('extractFlightSearchState rebuilds the listings key, resolving pointer args', () => {
    const html = flightPage([
      '3:' + JSON.stringify({ housingFormGroups: ['APARTMENTS'] }),
      resultsRow(1076, [{ __typename: 'ListingCard', id: '11', upcoming: false }]),
      varsRow({ locationIds: ['17920'], housingFormGroups: '$3:housingFormGroups', upcoming: 'EXCLUDE', minimal: 'INCLUDE' }, 50),
    ]);
    const st = extractFlightSearchState(html);
    const keys = Object.keys(st.ROOT_QUERY.search).filter((k) => k.startsWith('listings('));
    assert.strictEqual(keys.length, 1);
    const args = JSON.parse(keys[0].slice('listings('.length, -1));
    assert.deepStrictEqual(args, { limit: 50, offset: 50, search: {
      locationIds: ['17920'], housingFormGroups: ['APARTMENTS'], upcoming: 'EXCLUDE', minimal: 'INCLUDE' },
      sort: 'NEWEST_DAY_AND_PACKAGE' });
    const node = st.ROOT_QUERY.search[keys[0]];
    assert.strictEqual(node.total, 1076);
    assert.deepStrictEqual(node.cards, [{ __ref: 'ListingCard:11' }]);
    assert.strictEqual(st['ListingCard:11'].upcoming, false);
  });
  check('extractFlightSearchState THROWS on a result list without its variables', () => {
    // A filter we cannot see is a filter we cannot check — never assume it applied.
    assert.throws(() => extractFlightSearchState(flightPage([resultsRow(5, [])])), /variables block/);
  });
  check('extractFlightSearchState THROWS on two result nodes that disagree', () => {
    const html = flightPage([resultsRow(5, []), '4:' + JSON.stringify([JSON.parse(resultsRow(6, []).slice(2))]), varsRow({})]);
    assert.throws(() => extractFlightSearchState(html), /different totals/);
  });
  check('extractFlightSearchState THROWS on a page with no result node at all', () => {
    assert.throws(() => extractFlightSearchState(flightPage(['1:{"a":1}'])), /no search result node/);
  });

  const { loadHemnetPage } = require('../test-fixtures/hemnet-approuter');
  check('real 2026-11-03 /till-salu?upcoming=EXCLUDE: one listings key, total 62802, 50 cards', () => {
    const st = extractApolloState(loadHemnetPage('till-salu-exclude'), 'x');
    const keys = Object.keys(st.ROOT_QUERY.search).filter((k) => k.startsWith('listings('));
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(st.ROOT_QUERY.search[keys[0]].total, 62802);
    assert.strictEqual(st.ROOT_QUERY.search[keys[0]].cards.length, 50);
    assert.strictEqual(JSON.parse(keys[0].slice(9, -1)).search.upcoming, 'EXCLUDE');
  });
  check('a row holding U+2028 in a listing description still parses (Gnosjö, 2026-11-02)', () => {
    const st = extractApolloState(loadHemnetPage('till-salu-only-gnosjo-u2028'), 'x');
    const k = Object.keys(st.ROOT_QUERY.search).find((x) => x.startsWith('listings('));
    assert.strictEqual(st.ROOT_QUERY.search[k].total, 7);
    assert.strictEqual(st.ROOT_QUERY.search[k].cards.length, 7);
    const html = flightPage([resultsRow(1, [{ __typename: 'ListingCard', id: '1', description: 'a b' }]), varsRow({})]);
    assert.strictEqual(extractFlightSearchState(html)['ListingCard:1'].description, 'a b');
  });
  check('real 2026-11-03 /salda: searchSales node with 50 SaleCards', () => {
    const st = extractApolloState(loadHemnetPage('salda-goteborg-apartments-2rooms'), 'x');
    const k = Object.keys(st.ROOT_QUERY).find((x) => x.startsWith('searchSales('));
    assert.strictEqual(st.ROOT_QUERY[k].total, 30446);
    assert.strictEqual(st.ROOT_QUERY[k].cards.filter((r) => st[r.__ref].__typename === 'SaleCard').length, 50);
  });
  check('extractDetailState reads both routers (Hemnet rollout was mixed on 2026-11-03)', () => {
    const app = extractDetailState(loadHemnetPage('bostad-22055372-minimal'), 'x');
    assert.strictEqual(app['ActivePropertyListing:22055372'].timesViewed, 319);
    const pages = extractDetailState(loadHemnetPage('bostad-sold-pages-router'), 'x');
    assert.ok(Object.keys(pages).some((k) => k.startsWith('SoldPropertyListing:')));
    assert.throws(() => extractDetailState('<html>Just a moment...</html>', 'x'), /__NEXT_DATA__/);
  });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
