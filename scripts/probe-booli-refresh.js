// scripts/probe-booli-refresh.js — VERF-09-2 manual probe for Job D.
//
// Picks 5 active cohort booli_ids (newest cohorts first), fetches each
// via lib/booli-fetch's fetchBooliDetail, and validates parser correctness
// against the booli_listing row. Mirrors scripts/probe-hemnet-fetch.js
// structure swapped to the Booli side.
//
// Pass criteria for each booli_id (any one of):
//   A) Live active + parser-correct (timesViewed is non-negative int,
//      listing.url and listing.county present) → PASS
//   B) Live inactive + DB inactive → PASS (both agree)
//   C) Live inactive + DB active → STALE (informational; Job D's first
//      run after deploy will reconcile — that's the point of Phase 9)
// Hard fail:
//   - Parser exception or persistent fetch error after retries
//   - Live active but listing.url or listing.timesViewed is malformed
//
// 1.5 second sleep between requests to stay polite.
// Read-only. Not wired to cron. Run manually:
//   cd hemnet-cohort-tracker && node scripts/probe-booli-refresh.js

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { fetchBooliDetail } = require('../lib/booli-fetch');
const { createClient } = require('../db');

function logger(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] probe: ${msg}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Pick up to `n` candidate (booli_id, url) pairs from active cohorts.
// Mirrors Job D's main() SELECT shape but with random ordering for variety.
async function pickProbePairs(client, n) {
  // DISTINCT ON dedupes by booli_id (a listing can recur across cohort weeks);
  // inner ORDER BY keeps the newest-week row per booli_id; outer randomizes for
  // variety. Two-stage form is required because SELECT DISTINCT + ORDER BY
  // random() rejects non-SELECT-list expressions in Postgres.
  const r = await client.query(
    `SELECT booli_id, url, db_views, db_active
     FROM (
       SELECT DISTINCT ON (cp.booli_id)
         cp.booli_id,
         bl.url,
         bl.times_viewed AS db_views,
         bl.is_active AS db_active,
         c.week_start
       FROM cohort_pairs cp
       JOIN cohorts c ON c.cohort_id = cp.cohort_id
       JOIN booli_listing bl ON bl.booli_id = cp.booli_id
       WHERE c.week_start >= CURRENT_DATE - INTERVAL '8 weeks'
         AND cp.dropped_booli_on IS NULL
       ORDER BY cp.booli_id, c.week_start DESC
     ) sub
     ORDER BY random()
     LIMIT $1`,
    [n],
  );
  return r.rows;
}

async function probeOne(client, pair) {
  const { booli_id, url, db_views, db_active } = pair;

  const live = await fetchBooliDetail(url, { logger });
  const liveActive = live.status === 'active';
  const liveListing = liveActive ? live.listing : null;
  const liveViews = liveListing && typeof liveListing.timesViewed === 'number'
    ? liveListing.timesViewed
    : null;
  const liveCounty = liveListing ? liveListing.county : null;
  const liveUrl = liveListing ? liveListing.url : null;

  const dbViews = db_views != null ? Number(db_views) : null;
  const dbActive = db_active === true;

  let viewsDriftPct = null;
  if (dbViews != null && dbViews > 0 && liveViews != null) {
    viewsDriftPct = ((liveViews - dbViews) / dbViews) * 100;
  } else if (dbViews === 0 && liveViews === 0) {
    viewsDriftPct = 0;
  }

  // Verdict logic mirrors probe-hemnet-fetch.js but Booli-specific.
  let verdict;
  if (liveActive) {
    const parserOk =
      typeof liveViews === 'number' && Number.isInteger(liveViews) && liveViews >= 0 &&
      typeof liveUrl === 'string' && liveUrl.length > 0 &&
      typeof liveCounty === 'string' && liveCounty.length > 0;
    verdict = parserOk ? 'PASS' : 'FAIL';
  } else if (!dbActive) {
    verdict = 'PASS';
  } else {
    verdict = 'STALE';
  }

  return {
    booli_id,
    url,
    dbActive,
    liveActive,
    dbViews,
    liveViews,
    viewsDriftPct,
    liveCounty,
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
    const pairs = await pickProbePairs(client, n);
    if (pairs.length < n) {
      logger('WARN', `picked only ${pairs.length}/${n} probe pairs — proceeding`);
    }

    const results = [];
    for (let i = 0; i < pairs.length; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      try {
        const r = await probeOne(client, pairs[i]);
        results.push(r);
      } catch (err) {
        logger('ERROR', `probe of booli_id=${pairs[i].booli_id} threw: ${err && err.message}`);
        results.push({
          booli_id: pairs[i].booli_id,
          url: pairs[i].url,
          dbActive: null, liveActive: null, dbViews: null, liveViews: null,
          viewsDriftPct: null, liveCounty: null,
          verdict: 'FAIL', liveReason: `error: ${err && err.message}`,
        });
      }
    }

    console.log('');
    console.log(
      fmt('booli_id', 10),
      fmt('verdict', 8),
      fmt('live', 10),
      fmt('views_drift', 14),
      fmt('county', 24),
    );
    console.log('-'.repeat(74));
    for (const r of results) {
      const liveCol = r.liveActive ? 'active' : (r.liveReason || 'inactive');
      const driftCol = r.liveActive ? fmtDrift(r.viewsDriftPct) : '-';
      const countyCol = r.liveCounty || '-';
      console.log(
        fmt(String(r.booli_id), 10),
        fmt(r.verdict, 8),
        fmt(liveCol, 10),
        fmt(driftCol, 14),
        fmt(countyCol, 24),
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
