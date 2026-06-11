// hemnet-locations.js — municipality string -> Hemnet location_id resolver.
//
// Cache hit: synchronously read JSON, return id, no DB, no network.
// Cache miss: SELECT one active cohort listing in that municipality from
// cohort_pairs, fetchDetail it via lib/hemnet-fetch, read the resolved
// Apollo Location's id (whose fullName must end in " kommun"), persist
// the new entry back to lib/hemnet-locations.json, return the id.
//
// Harvester reuses opts.client if supplied (so Phase 7/8 callers running
// inside cron-wrapper.runJob can share their client); otherwise opens a
// fresh client via db.js#createClient and closes it on exit.
//
// Optional logger threaded through. Lib stays silent without one.

'use strict';

const fs = require('fs');
const path = require('path');
const { fetchDetail } = require('./hemnet-fetch');
const { createClient } = require('../db');

const CACHE_PATH = path.join(__dirname, 'hemnet-locations.json');

function noopLogger() {}

// Sync read of the cache file. Returns {} if file missing or empty.
// Throws (with file name) on JSON parse error so a corrupt file is loud.
function loadCache() {
  let raw;
  try {
    raw = fs.readFileSync(CACHE_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('not an object');
  } catch (err) {
    throw new Error(
      `hemnet-locations: failed to parse ${CACHE_PATH}: ${err && err.message}`,
    );
  }
}

function saveCache(obj) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// Resolve a municipality string to its Hemnet location_id.
// Cache-first; harvester runs only on miss.
async function getLocationId(municipality, opts = {}) {
  if (typeof municipality !== 'string') {
    throw new Error('hemnet-locations: municipality must be a string');
  }
  const trimmed = municipality.trim();
  if (trimmed.length === 0) {
    throw new Error('hemnet-locations: empty municipality');
  }

  const cache = loadCache();
  if (cache[trimmed] != null) {
    return cache[trimmed];
  }

  // Cache miss → harvester
  const log = opts.logger || noopLogger;
  const ownsClient = !opts.client;
  const client = opts.client || createClient();
  if (ownsClient) {
    await client.connect();
  }

  try {
    const probeRow = await client.query(
      "SELECT cp.hemnet_id FROM cohort_pairs cp " +
      "JOIN cohorts c ON c.cohort_id = cp.cohort_id " +
      "WHERE cp.municipality = $1 AND cp.dropped_hemnet_on IS NULL " +
      "AND cp.removed_at IS NULL " +
      "ORDER BY c.week_start DESC LIMIT 1",
      [trimmed],
    );

    if (probeRow.rows.length === 0) {
      throw new Error(
        `hemnet-locations: no cohort listing found for municipality "${trimmed}"`,
      );
    }

    const probeId = probeRow.rows[0].hemnet_id;
    const detail = await fetchDetail(probeId, { logger: log });
    if (detail.status !== 'active') {
      throw new Error(
        `hemnet-locations: probe listing ${probeId} for "${trimmed}" came back ${detail.status} (${detail.reason || 'unknown'})`,
      );
    }

    // LIBC-01 (Phase 8.5): the previous strict-equality check on
    //   muni.fullName === `${trimmed} kommun` aborted on every Swedish genitive
    //   form ("Stockholms kommun", "Trollhättans kommun", "Båstads kommun",
    //   "Kungälvs kommun", etc) and was masked in v1.0/v1.1 only because the 8
    //   cached munis happened to be ones without genitive -s. Phase 8 wet-run on
    //   dense metro munis exposed it. We now trust the parsed muni.id directly;
    //   the parseInt finite-check below remains the load-bearing safety net.
    const muni = detail.listing && detail.listing.municipality;

    const id = parseInt(muni && muni.id, 10);
    if (!Number.isFinite(id)) {
      throw new Error(
        `hemnet-locations: non-numeric Location id "${muni && muni.id}" for "${trimmed}"`,
      );
    }

    // Re-read cache before write to avoid clobbering any concurrent additions.
    const fresh = loadCache();
    fresh[trimmed] = id;
    saveCache(fresh);
    log('INFO', `resolved municipality "${trimmed}" -> Location:${id}`);
    return id;
  } finally {
    if (ownsClient) {
      try { await client.end(); } catch (_) { /* best effort */ }
    }
  }
}

module.exports = { getLocationId, loadCache };

// ---------------------------------------------------------------------------
// --smoke self-test — pure-function; no live network, no DB.
// Run with: node lib/hemnet-locations.js --smoke
//
// Gated on `require.main === module` so consumer `--smoke` (e.g.
// `node hemnet-targeted-match.js --smoke`) is NOT hijacked by this block's
// process.exit. Mirrors lib/booli-fetch.js's smoke gate exactly.
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // Pure helper extracted from the harvester so smoke does NOT need DB/network.
  // Mirrors the patched parseInt logic at the cache-miss path above.
  function parseMuniIdFromDetail(detail) {
    const muni = detail && detail.listing && detail.listing.municipality;
    const id = parseInt(muni && muni.id, 10);
    if (!Number.isFinite(id)) {
      throw new Error(`non-numeric Location id "${muni && muni.id}"`);
    }
    return id;
  }

  // Four genitive-form fixtures per D-12. Each fixture supplies a numeric-string
  // id and a genitive fullName; the harvester must accept all of them post-LIBC-01.
  const genitiveCases = [
    { name: 'Stockholm',   fixture: { listing: { municipality: { id: '17744', fullName: 'Stockholms kommun'   } } } },
    { name: 'Trollhättan', fixture: { listing: { municipality: { id: '18036', fullName: 'Trollhättans kommun' } } } },
    { name: 'Båstad',      fixture: { listing: { municipality: { id: '17923', fullName: 'Båstads kommun'      } } } },
    { name: 'Kungälv',     fixture: { listing: { municipality: { id: '18039', fullName: 'Kungälvs kommun'     } } } },
  ];
  for (const c of genitiveCases) {
    check(`genitive: ${c.name} (fullName="${c.fixture.listing.municipality.fullName}") resolves to numeric id`, () => {
      const id = parseMuniIdFromDetail(c.fixture);
      assert.strictEqual(typeof id, 'number', 'id is not a number');
      assert.ok(Number.isFinite(id), 'id is not finite');
    });
  }

  // Defensive: non-numeric id must still throw (D-03 safety net).
  check('safety-net: non-numeric muni.id throws', () => {
    assert.throws(() => parseMuniIdFromDetail(
      { listing: { municipality: { id: 'not-a-number', fullName: 'Anywhere kommun' } } },
    ), /non-numeric Location id/);
  });

  // Defensive: missing municipality throws.
  check('safety-net: missing municipality throws', () => {
    assert.throws(() => parseMuniIdFromDetail({ listing: {} }), /non-numeric Location id/);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
