'use strict';

// spike-common.js — shared infrastructure for the Booli-sold → Hemnet-sold
// matching feasibility spike (plan: i-want-to-run-rippling-dragon).
//
// Provides:
//   - cachedFetch(url): disk-cached, Oxylabs-forced GET with a GLOBAL persisted
//     spend ceiling (MAX_OXY_CALLS, default 4000). Cache hits cost nothing; the
//     ceiling is shared across every stage/rerun via verf-soldspike/cache/_spend.json.
//   - extractApollo(html): __NEXT_DATA__ → props.pageProps.__APOLLO_STATE__.
//   - assertOxyUsed(): hard transport check — aborts if a live fetch happened
//     off-Oxylabs (direct curl) or no Oxylabs call was recorded.
//   - JSON/JSONL seed + checkpoint helpers (DB-free persistence).
//
// IMPORTANT: callers MUST set process.env.SCRAPE_FORCE_OXYLABS = '1' BEFORE
// requiring this module (lib/scrape-http.js reads the flag at module load).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (process.env.SCRAPE_FORCE_OXYLABS !== '1' && process.env.HEMNET_FORCE_OXYLABS !== '1') {
  throw new Error(
    'spike-common: SCRAPE_FORCE_OXYLABS must be set to "1" BEFORE requiring this module',
  );
}

const {
  getWithRetry,
  extractNextData,
  getOxylabsStats,
} = require('../lib/scrape-http');

// ---------------------------------------------------------------
// Paths — a STABLE root (not per-run timestamped) so the cache and spend
// counter are shared across recon / scrape / match / report and survive reruns.
// ---------------------------------------------------------------
const ROOT = path.join(__dirname, '..', process.env.SPIKE_DIR || 'verf-soldspike');
const CACHE_DIR = path.join(ROOT, 'cache');
const SPEND_FILE = path.join(CACHE_DIR, '_spend.json');
const MAX_OXY_CALLS = parseInt(process.env.MAX_OXY_CALLS || '4000', 10);

fs.mkdirSync(CACHE_DIR, { recursive: true });

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

// Per-process counters (for assertOxyUsed + logging).
const _proc = { live: 0, cacheHits: 0, fails: 0 };

class CeilingError extends Error {
  constructor(msg) { super(msg); this.code = 'OXY_CEILING'; }
}

function loadSpend() {
  try { return JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8')); }
  catch (_) { return { liveCalls: 0 }; }
}
function saveSpend(s) {
  fs.writeFileSync(SPEND_FILE, JSON.stringify(s));
}
function spentCalls() { return loadSpend().liveCalls; }
function remainingCalls() { return Math.max(0, MAX_OXY_CALLS - spentCalls()); }

function cacheKey(url) { return crypto.createHash('sha1').update(url).digest('hex'); }

function tsSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function noop() {}

// cachedFetch — returns { status, html, fromCache, url }. Throws CeilingError if
// the global live-call budget is exhausted (only when a live fetch is needed;
// cache hits never hit the ceiling). A 404 is cached as status 404 with empty html.
async function cachedFetch(url, opts = {}) {
  const log = opts.logger || noop;
  const key = cacheKey(url);
  const htmlFile = path.join(CACHE_DIR, key + '.html');
  const metaFile = path.join(CACHE_DIR, key + '.json');

  if (fs.existsSync(metaFile)) {
    _proc.cacheHits++;
    let meta = { status: 200 };
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
    const html = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : '';
    log('CACHE', `hit ${url} (status ${meta.status})`);
    return { status: meta.status, html, fromCache: true, url };
  }

  const spend = loadSpend();
  if (spend.liveCalls >= MAX_OXY_CALLS) {
    throw new CeilingError(
      `Oxylabs ceiling reached: ${spend.liveCalls}/${MAX_OXY_CALLS} live calls — refusing new fetch`,
    );
  }

  // Count the call BEFORE issuing it: a forced-Oxylabs attempt consumes credits
  // whether or not it ultimately succeeds.
  spend.liveCalls += 1;
  saveSpend(spend);
  _proc.live++;
  log('FETCH', `live ${spend.liveCalls}/${MAX_OXY_CALLS} ${url}`);

  let res;
  try {
    res = await getWithRetry(url, { logger: opts.scrapeLog || noop });
  } catch (e) {
    _proc.fails++;
    throw e;
  }

  const html = res.html || '';
  fs.writeFileSync(htmlFile, html);
  fs.writeFileSync(metaFile, JSON.stringify({ status: res.status, url, at: new Date().toISOString() }));
  return { status: res.status, html, fromCache: false, url };
}

// extractApollo — parse __NEXT_DATA__ and return both the raw nextData and the
// Apollo state (props.pageProps.__APOLLO_STATE__), or apollo:null if absent.
function extractApollo(html) {
  const nextData = extractNextData(html);
  const pp = nextData && nextData.props && nextData.props.pageProps;
  const apollo = (pp && pp.__APOLLO_STATE__) || null;
  return { nextData, apollo };
}

// assertOxyUsed — hard transport guard. Only meaningful when ≥1 live fetch
// happened this process. In forced-Oxylabs mode directSuccessCount must stay 0
// and oxylabsCallCount must be >0. Throws on violation.
function assertOxyUsed() {
  if (_proc.live === 0) return { ok: true, skipped: true, ..._proc };
  const s = getOxylabsStats();
  if (s.directSuccessCount > 0) {
    throw new Error(`transport-assert: ${s.directSuccessCount} direct-curl successes recorded — NOT forced through Oxylabs`);
  }
  if (s.oxylabsCallCount === 0) {
    throw new Error('transport-assert: live fetches happened but oxylabsCallCount===0 — Oxylabs path not exercised');
  }
  return { ok: true, oxylabsCallCount: s.oxylabsCallCount, directSuccessCount: s.directSuccessCount, ..._proc };
}

function procStats() { return { ..._proc, spent: spentCalls(), remaining: remainingCalls(), cap: MAX_OXY_CALLS }; }

// ---------------------------------------------------------------
// DB-free persistence helpers
// ---------------------------------------------------------------
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) { return []; }
}

function stdoutLogger(tag) {
  return (level, msg) => {
    if (msg === undefined) { msg = level; level = 'INFO'; }
    console.log(`[${tag}] ${level} ${msg}`);
  };
}

module.exports = {
  ROOT,
  CACHE_DIR,
  MAX_OXY_CALLS,
  CeilingError,
  cachedFetch,
  extractApollo,
  extractNextData,
  assertOxyUsed,
  procStats,
  spentCalls,
  remainingCalls,
  getOxylabsStats,
  ensureDir,
  tsSlug,
  writeJson,
  readJson,
  appendJsonl,
  readJsonl,
  stdoutLogger,
};
