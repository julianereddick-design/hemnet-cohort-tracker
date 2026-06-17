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
          if (!html.includes('__NEXT_DATA__')) {
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

module.exports = {
  getWithRetry,
  extractNextData,
  getOxylabsStats,
  resetOxylabsStats,
};
