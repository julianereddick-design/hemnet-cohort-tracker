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

    const expectedFullName = `${trimmed} kommun`;
    const muni = detail.listing && detail.listing.municipality;
    if (!muni || muni.fullName !== expectedFullName) {
      throw new Error(
        `hemnet-locations: harvester for "${trimmed}" did not find expected "${expectedFullName}" in detail page (got "${muni && muni.fullName}")`,
      );
    }

    const id = parseInt(muni.id, 10);
    if (!Number.isFinite(id)) {
      throw new Error(
        `hemnet-locations: non-numeric Location id "${muni.id}" for "${trimmed}"`,
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
