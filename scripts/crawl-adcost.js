#!/usr/bin/env node
'use strict';
/**
 * crawl-adcost.js — Hemnet ad-cost GraphQL crawler.
 *
 * Uses a PLUGGABLE SESSION PROVIDER (locked decision D1) to load hemnet.se/priser
 * through a residential/managed browser, clear Cloudflare, then do a QUIET in-page
 * fetch('/graphql') — NOT form automation (trips Turnstile per locked decision D2).
 *
 * Default provider: "steel" (Steel.dev validated live in Phase 26).
 * Drop-in seam: "oxylabs-render" stub wired but not yet implemented.
 *
 * Usage:
 *   node scripts/crawl-adcost.js [--smoke] [--provider steel|oxylabs-render]
 *   STEEL_API_KEY=sk_... node scripts/crawl-adcost.js
 *   node scripts/crawl-adcost.js --smoke   # zero network, zero paid calls
 *
 * Output (standalone run): JSON file written to verf-adcost/<timestamp>.json
 *
 * Exit codes:
 *   0 = success (smoke passed / crawl complete)
 *   1 = failure (smoke assertion failed / crawl error)
 *   2 = misconfiguration (missing key etc.)
 *   4 = Cloudflare block on all retries
 *
 * Threat T-27-01: STEEL_API_KEY is read only via envFromDotenv, never logged.
 * Threat T-27-04: sessions.create() is guarded behind the non-smoke run entrypoint only.
 */

const fs = require('fs');
const path = require('path');

const {
  MUNICIPALITIES,
  ASKING_PRICES,
  PRODUCT_CODES,
  GRAPHQL_URL,
  USER_AGENT,
  AUTOCOMPLETE_QUERY,
  PRODUCT_PRICES_QUERY,
  ADCOSTV2_FIELDS,
} = require('./lib/adcost-contract');

const { buildGrid, parseProductPrices, applyBasicSum, toAdCostV2Rows } =
  require('./adcost-parse');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a key from environment or the gitignored .env file.
 * Never echoes the value; never commits it.
 */
function envFromDotenv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const line = txt
      .split(/\r?\n/)
      .find((l) => l.replace(/^\s*export\s+/, '').startsWith(key + '='));
    if (!line) return undefined;
    let v = line.slice(line.indexOf('=') + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    return v;
  } catch (_) {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pluggable session provider (locked decision D1)
// ---------------------------------------------------------------------------

const PROVIDERS = {};

/**
 * Steel.dev provider — VALIDATED (Phase 26 Steel validation).
 * Requires: npm install --no-save steel-sdk playwright-core
 * Env:       STEEL_API_KEY (read via envFromDotenv, never logged)
 */
PROVIDERS['steel'] = {
  name: 'steel',
  async createSession() {
    const STEEL_API_KEY = envFromDotenv('STEEL_API_KEY');
    if (!STEEL_API_KEY) {
      throw new Error(
        'STEEL_API_KEY not set. Get one at https://app.steel.dev/settings/api-keys\n' +
          'Set it in your gitignored .env file as: STEEL_API_KEY=sk_...'
      );
    }
    const m = require('steel-sdk');
    const Steel = m && (m.default || m.Steel || m);
    const { chromium } = require('playwright-core');
    const client = new Steel({ steelAPIKey: STEEL_API_KEY });
    // T-27-04: sessions.create() is called here only; not reachable from --smoke.
    const session = await client.sessions.create({
      useProxy: true,      // residential proxy (required — DC IPs are Cloudflare-blocked)
      solveCaptcha: true,  // managed CAPTCHA solving
      sessionTimeout: 300000,
    });
    const browser = await chromium.connectOverCDP(
      `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`
    );
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    return {
      browser,
      page,
      async release() {
        try { await browser.close(); } catch (_) {}
        try { await client.sessions.release(session.id); } catch (_) {}
      },
    };
  },
};

/**
 * Oxylabs render provider — DROP-IN SEAM (locked decision D1).
 * Wiring: pending Oxylabs support confirmation (26-OXYLABS-INQUIRY.md Q1).
 * Same in-page-fetch code works for all providers; only session differ.
 */
PROVIDERS['oxylabs-render'] = {
  name: 'oxylabs-render',
  async createSession() {
    throw new Error(
      'oxylabs-render adapter not yet wired — drop-in seam per D1.\n' +
        'Pending: Oxylabs support confirmation that render supports execute_javascript result return.\n' +
        'Use --provider steel (validated) until the Oxylabs inquiry resolves.'
    );
  },
};

/**
 * makeSession(provider) → { browser, page, release() }
 * Factory for the pluggable session provider.
 */
async function makeSession(provider) {
  const adapter = PROVIDERS[provider];
  if (!adapter) {
    throw new Error(
      `Unknown provider "${provider}". Available: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return adapter.createSession();
}

// ---------------------------------------------------------------------------
// Retry-on-block wrapper (proven pattern from probe-steel-adcost.js)
// ---------------------------------------------------------------------------

const BLOCK_RE =
  /just a moment|checking your browser|cf-chl|attention required|enable javascript and cookies|verifying you are human/i;
const CLEAR_RE = /Räkna ut priset|Gata eller kommun|Skriv område|Utgångspris|Priser/i;
const MAX_ATTEMPTS = 5;

/**
 * waitForClear(page) → boolean
 * Poll until Cloudflare clears (~48 s per attempt). Returns true if cleared.
 */
async function waitForClear(page) {
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(3000);
    const st = await page
      .evaluate(() => ({
        title: document.title,
        body: document.body ? document.body.innerText.slice(0, 4000) : '',
      }))
      .catch(() => ({ title: '', body: '' }));
    const isBlock = BLOCK_RE.test(st.title) || BLOCK_RE.test(st.body.slice(0, 600));
    const isClear =
      (CLEAR_RE.test(st.body) || (/^Priser/i.test(st.title) && st.body.length > 200)) &&
      !isBlock;
    if (isClear) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// In-page GraphQL helpers (locked decision D2 — no form automation)
// ---------------------------------------------------------------------------

/**
 * inPageFetch(page, query, variables) → parsed JSON response
 * Executes a fetch('/graphql', ...) inside the page context.
 * This looks like the page's own request → does not re-trigger Turnstile.
 */
async function inPageFetch(page, query, variables) {
  return page.evaluate(
    ({ q, v }) =>
      fetch('/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, variables: v }),
      }).then((r) => r.json()),
    { q: query, v: variables }
  );
}

/**
 * resolveLocationId(page, municipality, cache) → string locationId
 * Fires the autocomplete query and returns the locationId for municipality.fullName.
 * Results are cached by fullName to avoid redundant calls.
 */
async function resolveLocationId(page, municipality, cache) {
  if (cache.has(municipality.fullName)) return cache.get(municipality.fullName);
  const res = await inPageFetch(page, AUTOCOMPLETE_QUERY, {
    query: municipality.searchQuery,
    limit: 5,
    types: ['MUNICIPALITY'],
  });
  const hits = (res && res.data && res.data.autocompleteLocations && res.data.autocompleteLocations.hits) || [];
  const hit = hits.find((h) => h.fullName === municipality.fullName);
  if (!hit) throw new Error(`No autocomplete hit for "${municipality.fullName}"`);
  cache.set(municipality.fullName, hit.id);
  return hit.id;
}

// ---------------------------------------------------------------------------
// Main crawl loop
// ---------------------------------------------------------------------------

/**
 * runCrawl(provider) → Array<AdCostV2Row>
 * Opens a session, clears Cloudflare, crawls the full 60-point grid.
 */
async function runCrawl(provider) {
  const grid = buildGrid(MUNICIPALITIES, ASKING_PRICES);
  const crawledISO = new Date().toISOString();
  const allRows = [];
  let sessionHandle = null;
  let callCount = 0;

  try {
    let cleared = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cleared; attempt++) {
      console.log(
        `\n=== Attempt ${attempt}/${MAX_ATTEMPTS}: opening ${provider} session ===`
      );
      sessionHandle = await makeSession(provider);
      const { page, release } = sessionHandle;

      console.log('Navigating to https://www.hemnet.se/priser …');
      await page
        .goto('https://www.hemnet.se/priser', { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch((e) => console.log('  goto:', e.message));

      cleared = await waitForClear(page);

      if (!cleared) {
        console.log(
          `  attempt ${attempt} still challenged; ${
            attempt < MAX_ATTEMPTS ? 'retrying with a fresh session/IP…' : 'no clear after all attempts.'
          }`
        );
        await release();
        sessionHandle = null;
      } else {
        console.log(`Cloudflare CLEARED (attempt ${attempt}). Starting in-page GraphQL fetches…`);
      }
    }

    if (!cleared) {
      console.error(
        `VERDICT: BLOCKED_CF — challenged on all ${MAX_ATTEMPTS} attempts. ` +
          'Try again (IPs are probabilistic) or switch to a different residential provider.'
      );
      process.exit(4);
    }

    const { page, release } = sessionHandle;
    const locationCache = new Map();

    // Crawl the 60-point grid
    const muniSummary = {};
    for (const { municipality, askingPrice } of grid) {
      let locationId;
      try {
        locationId = await resolveLocationId(page, municipality, locationCache);
        if (!locationCache.has(municipality.fullName) || callCount === 0) callCount++;
      } catch (e) {
        console.error(`  autocomplete failed for ${municipality.fullName}: ${e.message}`);
        continue;
      }

      let priceRes;
      try {
        priceRes = await inPageFetch(page, PRODUCT_PRICES_QUERY, {
          locationId,
          askingPrice,
          productCodes: PRODUCT_CODES,
        });
        callCount++;
      } catch (e) {
        console.error(
          `  price fetch failed for ${municipality.fullName} @ ${askingPrice}: ${e.message}`
        );
        continue;
      }

      const parsed = parseProductPrices(priceRes);
      const summed = applyBasicSum(parsed);
      const rows = toAdCostV2Rows(municipality.fullName, askingPrice, summed, crawledISO);
      allRows.push(...rows);

      if (!muniSummary[municipality.fullName]) muniSummary[municipality.fullName] = {};
      for (const r of summed) muniSummary[municipality.fullName][r.code] = r.amount;
    }

    await release();
    sessionHandle = null;

    // Per-muni tier summary
    console.log('\n=== Ad-cost summary (SEK) ===');
    for (const [muni, tiers] of Object.entries(muniSummary)) {
      const line = Object.entries(tiers)
        .map(([k, v]) => `${k}:${v}`)
        .join(' | ');
      console.log(`  ${muni}: ${line}`);
    }
    console.log(
      `\nTotal rows: ${allRows.length} | Steel/session calls: ~${callCount} (${
        locationCache.size
      } munis cached + ${grid.length} price queries)`
    );

    // Write JSON output for Plan 27-02
    const outDir = path.join(process.cwd(), 'verf-adcost');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `adcost-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(outFile, JSON.stringify(allRows, null, 2));
    console.log(`\nOutput written to: ${outFile}`);

    return allRows;
  } finally {
    if (sessionHandle) {
      try { await sessionHandle.release(); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// --smoke: deterministic offline gate (zero network, zero paid calls)
// T-27-04: sessions.create() is NOT reachable from this path.
// ---------------------------------------------------------------------------

function runSmoke() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition, detail) {
    if (condition) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  console.log('\n=== SMOKE: ad-cost crawler offline gate ===\n');

  // --- Test 1: buildGrid ---
  const grid = buildGrid(MUNICIPALITIES, ASKING_PRICES);
  const expectedGridSize = MUNICIPALITIES.length * ASKING_PRICES.length;
  assert(
    `buildGrid: size == ${expectedGridSize} (${MUNICIPALITIES.length} munis × ${ASKING_PRICES.length} prices)`,
    grid.length === expectedGridSize,
    `got ${grid.length}`
  );
  assert(
    'buildGrid: first cell has municipality + askingPrice keys',
    grid.length > 0 && grid[0].municipality && typeof grid[0].askingPrice === 'number',
    grid.length > 0 ? JSON.stringify(grid[0]) : 'empty grid'
  );

  // --- Test 2: parseProductPrices ---
  // Embedded fixture — no network required.
  const fixtureResponse = {
    data: {
      sellerMarketingProductPrices: {
        formattedValidThrough: '2026-07-07',
        prices: PRODUCT_CODES.map((code, i) => ({
          code,
          price: { amount: 1000 * (i + 1), formatted: `${1000 * (i + 1)} kr`, __typename: 'Price' },
          immediatePrice: null,
          __typename: 'PackagePrice',
        })),
        __typename: 'SellerMarketingProductPrices',
      },
    },
  };
  const parsed = parseProductPrices(fixtureResponse);
  assert(
    `parseProductPrices: returns ${PRODUCT_CODES.length} rows`,
    parsed.length === PRODUCT_CODES.length,
    `got ${parsed.length}`
  );
  assert(
    'parseProductPrices: all rows have numeric amount > 0',
    parsed.length > 0 && parsed.every((r) => typeof r.amount === 'number' && r.amount > 0),
    parsed.length > 0 ? JSON.stringify(parsed.map((r) => r.amount)) : 'empty'
  );
  assert(
    'parseProductPrices: all PRODUCT_CODES present',
    parsed.length === PRODUCT_CODES.length &&
      PRODUCT_CODES.every((code) => parsed.some((r) => r.code === code)),
    `got codes: ${parsed.map((r) => r.code).join(',')}`
  );
  // Explicit named checks for the 5 live-verified tiers + 2 others (Task 3 gate)
  for (const tier of ['BASIC', 'PLUS', 'PREMIUM', 'MAX', 'TOPLISTING', 'PAID_REPUBLISH', 'TOPLISTING_5_DAYS']) {
    const row = parsed.find((r) => r.code === tier);
    assert(
      `parseProductPrices: ${tier} present with amount > 0`,
      row !== undefined && typeof row.amount === 'number' && row.amount > 0,
      row ? `amount=${row.amount}` : 'missing'
    );
  }

  // --- Test 3: applyBasicSum ---
  const basicAmount = parsed.find((r) => r.code === 'BASIC') ? parsed.find((r) => r.code === 'BASIC').amount : 0;
  const summed = applyBasicSum(parsed);
  const plusRow = summed.find((r) => r.code === 'PLUS');
  const plusOrig = parsed.find((r) => r.code === 'PLUS');
  const premRow = summed.find((r) => r.code === 'PREMIUM');
  const premOrig = parsed.find((r) => r.code === 'PREMIUM');
  const maxRow = summed.find((r) => r.code === 'MAX');
  const maxOrig = parsed.find((r) => r.code === 'MAX');
  const basicRow = summed.find((r) => r.code === 'BASIC');
  const basicOrig = parsed.find((r) => r.code === 'BASIC');
  const topRow = summed.find((r) => r.code === 'TOPLISTING');
  const topOrig = parsed.find((r) => r.code === 'TOPLISTING');

  assert(
    `applyBasicSum: PLUS increased by BASIC amount (${basicAmount})`,
    plusRow && plusOrig && plusRow.amount === plusOrig.amount + basicAmount,
    `plusOrig=${plusOrig && plusOrig.amount} summed=${plusRow && plusRow.amount}`
  );
  assert(
    `applyBasicSum: PREMIUM increased by BASIC amount`,
    premRow && premOrig && premRow.amount === premOrig.amount + basicAmount,
    `premOrig=${premOrig && premOrig.amount} summed=${premRow && premRow.amount}`
  );
  assert(
    `applyBasicSum: MAX increased by BASIC amount`,
    maxRow && maxOrig && maxRow.amount === maxOrig.amount + basicAmount,
    `maxOrig=${maxOrig && maxOrig.amount} summed=${maxRow && maxRow.amount}`
  );
  assert(
    'applyBasicSum: BASIC unchanged',
    basicRow && basicOrig && basicRow.amount === basicOrig.amount,
    `orig=${basicOrig && basicOrig.amount} after=${basicRow && basicRow.amount}`
  );
  assert(
    'applyBasicSum: TOPLISTING unchanged',
    topRow && topOrig && topRow.amount === topOrig.amount,
    `orig=${topOrig && topOrig.amount} after=${topRow && topRow.amount}`
  );

  // --- Test 4: toAdCostV2Rows ---
  const testMuni = 'Göteborgs kommun';
  const testPrice = 5000000;
  const testISO = '2026-06-30T06:00:00.000Z';
  const v2Rows = toAdCostV2Rows(testMuni, testPrice, summed, testISO);
  assert(
    `toAdCostV2Rows: returns ${PRODUCT_CODES.length} rows`,
    v2Rows.length === PRODUCT_CODES.length,
    `got ${v2Rows.length}`
  );
  const expectedKeySet = new Set(ADCOSTV2_FIELDS);
  const actualKeySet = v2Rows.length > 0 ? new Set(Object.keys(v2Rows[0])) : new Set();
  const keysMatch =
    expectedKeySet.size === actualKeySet.size &&
    [...expectedKeySet].every((k) => actualKeySet.has(k));
  assert(
    `toAdCostV2Rows: keys === ADCOSTV2_FIELDS [${ADCOSTV2_FIELDS.join(',')}]`,
    keysMatch,
    `got keys: ${[...actualKeySet].join(',')}`
  );
  assert(
    'toAdCostV2Rows: property_municipality and property_price set correctly',
    v2Rows.length > 0 &&
      v2Rows[0].property_municipality === testMuni &&
      v2Rows[0].property_price === testPrice,
    v2Rows.length > 0 ? JSON.stringify(v2Rows[0]) : 'empty'
  );
  assert(
    'toAdCostV2Rows: crawled field is ISO string',
    v2Rows.length > 0 && v2Rows[0].crawled === testISO,
    v2Rows.length > 0 ? String(v2Rows[0].crawled) : 'empty'
  );
  assert(
    'toAdCostV2Rows: valid_until is null (not returned by this API path)',
    v2Rows.length > 0 && v2Rows[0].valid_until === null,
    v2Rows.length > 0 ? String(v2Rows[0].valid_until) : 'empty'
  );

  // --- Test 5: both session providers are registered ---
  assert(
    'providers: "steel" adapter is registered',
    typeof PROVIDERS['steel'] === 'object' && typeof PROVIDERS['steel'].createSession === 'function',
    ''
  );
  assert(
    'providers: "oxylabs-render" stub is registered',
    typeof PROVIDERS['oxylabs-render'] === 'object' && typeof PROVIDERS['oxylabs-render'].createSession === 'function',
    ''
  );

  // --- Summary ---
  const total = passed + failed;
  console.log(`\n${failed === 0 ? 'SMOKE OK' : 'SMOKE FAILED'} ${passed}/${total} assertions\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isSmoke = args.includes('--smoke');

if (isSmoke) {
  // Offline gate — zero network, zero paid calls.
  runSmoke();
} else {
  // Production run — opens a real session. Never triggered on require or --smoke.
  const providerArg = args.find((a) => a.startsWith('--provider='));
  const provider = providerArg ? providerArg.slice('--provider='.length) : 'steel';
  console.log(`Starting ad-cost crawl with provider: ${provider}`);
  console.log(`Grid: ${MUNICIPALITIES.length} munis × ${ASKING_PRICES.length} prices = ${MUNICIPALITIES.length * ASKING_PRICES.length} pairs`);
  runCrawl(provider).then(() => process.exit(0)).catch((e) => {
    console.error('Crawl error:', e.message || e);
    process.exit(1);
  });
}
