// scripts/probe-hemnet-fetch.js — VERF-01 manual probe.
//
// Picks 5 active cohort hemnet_ids (newest cohorts first), fetches each
// via lib/hemnet-fetch, and validates parser correctness against the
// latest active hemnet_listingv2 row. Mirrors cohort-track.js:153's
// duplicate-row aggregation pattern: MAX(times_viewed) WHERE is_active = true.
//
// Pass criteria for each id (any one of):
//   A) Live active + postCode exact match + timesViewed is positive int +
//      municipality.fullName ends with " kommun"
//      → parser is correct; views_drift is informational (DB stale because
//      external scraper has been dead — that's why we're rebuilding).
//   B) Live inactive + DB inactive → both agree, no signal.
//   C) Live inactive + DB active → INFORMATIONAL (DB stale; Phase 7 will
//      reconcile via streak/drop logic). Counted as "stale" not "fail".
// Hard fail:
//   - postCode MISMATCH on a live-active row (real parser bug)
//   - parser exception or persistent fetch error after retries
//   - municipality.fullName does NOT end with " kommun" on a live-active row
// streetAddress comparison is a soft check (Hemnet normalises whitespace).
//
// 1.5 second sleep between requests to stay polite to Cloudflare.
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

  const liveMunicipality = liveActive && live.listing && live.listing.municipality
    ? live.listing.municipality.fullName
    : null;
  const municipalityKommun = typeof liveMunicipality === 'string'
    && liveMunicipality.endsWith(' kommun');

  // Pass logic — see header comment for full criteria.
  // - Active + parser-correct (postCode + kommun + positive views) -> PASS
  // - Inactive + DB inactive -> PASS (both agree)
  // - Inactive + DB active -> STALE (informational, not a fail; expected
  //   while the external scraper is dead — Phase 7 will reconcile)
  // - Active + postCode mismatch -> HARD FAIL (parser bug)
  let verdict;
  if (liveActive) {
    const parserOk = postcodeMatch
      && typeof liveViews === 'number' && Number.isInteger(liveViews) && liveViews >= 0
      && municipalityKommun;
    verdict = parserOk ? 'PASS' : 'FAIL';
  } else if (!dbActive) {
    verdict = 'PASS';
  } else {
    verdict = 'STALE';
  }

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
    liveMunicipality,
    municipalityKommun,
    verdict,
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
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1500)); // pace to avoid Cloudflare
      }
      try {
        const r = await probeOne(client, id);
        results.push(r);
      } catch (err) {
        logger('ERROR', `probe of ${id} threw: ${err && err.message}`);
        results.push({
          id, dbActive: null, liveActive: null,
          dbPostcode: null, livePostcode: null, postcodeMatch: false,
          dbViews: null, liveViews: null, viewsDriftPct: null,
          viewsWithinTolerance: false, addressMatch: false,
          liveMunicipality: null, municipalityKommun: false, verdict: 'FAIL',
          liveReason: `error: ${err && err.message}`,
        });
      }
    }

    // Render per-id table.
    console.log('');
    console.log(
      fmt('hemnet_id', 12),
      fmt('verdict', 8),
      fmt('live', 10),
      fmt('postCode', 16),
      fmt('views_drift', 14),
      fmt('municipality', 22),
    );
    console.log('-'.repeat(86));
    for (const r of results) {
      const liveCol = r.liveActive ? 'active' : (r.liveReason || 'inactive');
      const postcodeCol = r.liveActive
        ? (r.postcodeMatch
            ? `OK ${r.livePostcode || ''}`
            : `MISMATCH ${r.livePostcode || '-'}/${r.dbPostcode || '-'}`)
        : '-';
      const driftCol = r.liveActive
        ? `${fmtDrift(r.viewsDriftPct)}${r.viewsWithinTolerance ? ' fresh' : ' stale'}`
        : '-';
      const munCol = r.liveActive
        ? (r.municipalityKommun ? r.liveMunicipality : `BAD ${r.liveMunicipality || '?'}`)
        : '-';
      console.log(
        fmt(String(r.id), 12),
        fmt(r.verdict, 8),
        fmt(liveCol, 10),
        fmt(postcodeCol, 16),
        fmt(driftCol, 14),
        fmt(munCol, 22),
      );
    }
    console.log('');

    const passed = results.filter((r) => r.verdict === 'PASS').length;
    const stale  = results.filter((r) => r.verdict === 'STALE').length;
    const failed = results.filter((r) => r.verdict === 'FAIL').length;
    const total = results.length;
    const ok = failed === 0 && total > 0;
    const summary = `SUMMARY: ${ok ? 'PASSED' : 'FAILED'} ${passed}/${total} (stale: ${stale}, failed: ${failed})`;
    logger('INFO', summary);

    process.exit(ok ? 0 : 1);
  } finally {
    try { await client.end(); } catch (_) { /* best effort */ }
  }
}

main().catch((err) => {
  console.error('PROBE FATAL:', err && err.message);
  process.exit(1);
});
