// scripts/probe-hemnet-fetch.js — VERF-01 manual probe.
//
// Picks 5 active cohort hemnet_ids (newest cohorts first), fetches each
// via lib/hemnet-fetch, and compares postCode / is_active / times_viewed
// against hemnet_listingv2. Mirrors cohort-track.js:153's duplicate-row
// aggregation pattern: MAX(times_viewed) WHERE is_active = true.
//
// Hard-pass requires: status match (live active <-> DB is_active),
// postCode exact match (after .trim()), times_viewed within ±20%.
// streetAddress mismatch is logged but NOT a hard fail.
//
// Read-only. Not wired to cron. Run manually:
//   cd hemnet-cohort-tracker && node scripts/probe-hemnet-fetch.js

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { fetchDetail } = require('../lib/hemnet-fetch');
const { createClient } = require('../db');

function logger(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] probe: ${msg}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Pick up to `n` candidate hemnet_ids that have at least one active row in
// hemnet_listingv2. Over-fetches by 2x to allow filtering. Returns the
// surviving array (may be shorter than `n`).
async function pickProbeIds(client, n) {
  const candRes = await client.query(
    "SELECT cp.hemnet_id FROM cohort_pairs cp " +
    "JOIN cohorts c ON c.cohort_id = cp.cohort_id " +
    "WHERE cp.dropped_hemnet_on IS NULL " +
    "ORDER BY c.week_start DESC, random() LIMIT $1",
    [n * 2],
  );

  const ids = [];
  for (const row of candRes.rows) {
    if (ids.length >= n) break;
    // MAX(times_viewed) WHERE is_active = true — duplicate-row aggregation
    // (mirrors cohort-track.js:153). NULL means no active row exists.
    const r = await client.query(
      "SELECT BOOL_OR(is_active) AS is_active FROM hemnet_listingv2 WHERE hemnet_id = $1",
      [row.hemnet_id],
    );
    if (r.rows.length > 0 && r.rows[0].is_active === true) {
      ids.push(row.hemnet_id);
    }
  }
  return ids;
}

// Fetch one id live and compare against the latest active hemnet_listingv2 row.
async function probeOne(client, id) {
  const dbRes = await client.query(
    "SELECT MAX(times_viewed)::float AS times_viewed, " +
    "       MAX(postcode) AS postcode, " +
    "       MAX(street_address) AS street_address, " +
    "       BOOL_OR(is_active) AS is_active " +
    "FROM hemnet_listingv2 WHERE hemnet_id = $1 AND is_active = true",
    [id],
  );
  const dbRow = dbRes.rows[0] || {};

  const live = await fetchDetail(id, { logger });

  const dbActive = dbRow.is_active === true;
  const liveActive = live.status === 'active';
  const livePostcode = liveActive && live.listing && live.listing.postCode
    ? String(live.listing.postCode).trim()
    : null;
  const dbPostcode = dbRow.postcode != null ? String(dbRow.postcode).trim() : null;
  const liveViews = liveActive && live.listing && typeof live.listing.timesViewed === 'number'
    ? live.listing.timesViewed
    : null;
  const dbViews = dbRow.times_viewed != null ? Number(dbRow.times_viewed) : null;
  const liveAddr = liveActive && live.listing && live.listing.streetAddress
    ? String(live.listing.streetAddress).trim().toLowerCase()
    : null;
  const dbAddr = dbRow.street_address != null
    ? String(dbRow.street_address).trim().toLowerCase()
    : null;

  const statusMatch = dbActive === liveActive;
  const postcodeMatch = dbPostcode != null && livePostcode != null && dbPostcode === livePostcode;
  let viewsDriftPct = null;
  let viewsWithinTolerance = false;
  if (dbViews != null && dbViews > 0 && liveViews != null) {
    viewsDriftPct = ((liveViews - dbViews) / dbViews) * 100;
    viewsWithinTolerance = Math.abs(viewsDriftPct) <= 20;
  } else if (dbViews === 0 && liveViews === 0) {
    viewsDriftPct = 0;
    viewsWithinTolerance = true;
  } else if (dbViews === 0 && liveViews != null && liveViews <= 5) {
    // Both effectively new — accept small absolute drift when dbViews is 0.
    viewsDriftPct = 0;
    viewsWithinTolerance = true;
  }

  const addressMatch = dbAddr != null && liveAddr != null && dbAddr === liveAddr;

  // Hard pass: status, postCode, times_viewed within ±20%.
  // streetAddress is a soft check (Hemnet sometimes normalises whitespace).
  const hardPass = statusMatch && postcodeMatch && viewsWithinTolerance;

  return {
    id,
    dbActive,
    liveActive,
    dbPostcode,
    livePostcode,
    postcodeMatch,
    dbViews,
    liveViews,
    viewsDriftPct,
    viewsWithinTolerance,
    addressMatch,
    hardPass,
    liveReason: liveActive ? null : (live.reason || 'unknown'),
  };
}

function fmt(v, w) {
  const s = v == null ? '-' : String(v);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function fmtDrift(pct) {
  if (pct == null) return '-';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

async function main() {
  const client = createClient();
  await client.connect();
  logger('INFO', 'Connected to DB');

  try {
    const n = 5;
    const ids = await pickProbeIds(client, n);
    if (ids.length < n) {
      logger('WARN', `picked only ${ids.length}/${n} probe ids — proceeding`);
    }

    const results = [];
    for (const id of ids) {
      try {
        const r = await probeOne(client, id);
        results.push(r);
      } catch (err) {
        logger('ERROR', `probe of ${id} threw: ${err && err.message}`);
        results.push({
          id, dbActive: null, liveActive: null,
          dbPostcode: null, livePostcode: null, postcodeMatch: false,
          dbViews: null, liveViews: null, viewsDriftPct: null,
          viewsWithinTolerance: false, addressMatch: false, hardPass: false,
          liveReason: `error: ${err && err.message}`,
        });
      }
    }

    // Render per-id table.
    console.log('');
    console.log(
      fmt('hemnet_id', 12),
      fmt('status', 16),
      fmt('postCode', 14),
      fmt('views_drift', 14),
      fmt('address', 8),
    );
    console.log('-'.repeat(70));
    for (const r of results) {
      const statusCol = r.liveActive
        ? (r.dbActive ? 'active=active' : 'active!=db_inactive')
        : (r.dbActive ? `${r.liveReason || 'inactive'}!=db_active` : `${r.liveReason || 'inactive'}=inactive`);
      const postcodeCol = r.postcodeMatch
        ? `OK ${r.livePostcode || ''}`
        : `MISMATCH live=${r.livePostcode}/db=${r.dbPostcode}`;
      const driftCol = `${fmtDrift(r.viewsDriftPct)}${r.viewsWithinTolerance ? ' OK' : ' BAD'}`;
      const addrCol = r.addressMatch ? 'OK' : 'DIFF';
      console.log(
        fmt(String(r.id), 12),
        fmt(statusCol, 16),
        fmt(postcodeCol, 14),
        fmt(driftCol, 14),
        fmt(addrCol, 8),
      );
    }
    console.log('');

    const passed = results.filter((r) => r.hardPass).length;
    const total = results.length;
    const summary = `SUMMARY: ${passed === total && total > 0 ? 'PASSED' : 'FAILED'} ${passed}/${total}`;
    logger('INFO', summary);

    process.exit(passed === total && total > 0 ? 0 : 1);
  } finally {
    try { await client.end(); } catch (_) { /* best effort */ }
  }
}

main().catch((err) => {
  console.error('PROBE FATAL:', err && err.message);
  process.exit(1);
});
