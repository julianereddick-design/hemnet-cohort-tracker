// hemnet-targeted-refresh.js — Job A. Every-cycle refresh of times_viewed + is_active
// for every active cohort hemnet_id (last 8 weeks, not dropped).
// 2026-05-15: lookback narrowed 12 → 8 weeks to align with the per-pair tracking
// horizon in cohort-track.js (also 56 days). Eliminates the Days 31-84 dead zone.
//
// Plan 09-02 (D-16) retrofit (2026-05-15): brought to symmetric hardening with Job D
// (booli-targeted-refresh.js). Adds JOB_BUDGET_MS = 240 * 60 * 1000 wall-clock budget,
// bumps concurrency 2 → 8 (D-15 sizing), wraps worker iteration in try/catch capturing
// err.stack (logs `worker-uncaught hemnet_id=...`), counts into summary.workerErrors,
// and adds two new validate() branches (budgetExceeded + workerErrors). Pre-staged for
// the Hemnet-flips-to-Oxylabs contingency (today Hemnet allows direct curl so workers
// will be ~80% idle — harmless). D-17 amends D-06 to run Job A in parallel with Job D
// at `0 14 */2 * *` (Plan 09-03 owns the crontab edit).
//
// Wrapped by cron-wrapper.runJob — failures hit Slack and cron_job_log.
// Concurrency 8 + 100-300ms jitter. Target ~10-20 min direct-curl steady state today;
// ~155 min wall-clock if Hemnet flips to Oxylabs (fits the 240-min budget).
//
// Behavior locked by .planning/phases/07-daily-targeted-refresh-job-a/07-01-PLAN.md
// and 07-CONTEXT.md (original) + 09-02-PLAN.md D-16 (retrofit). Critical correctness:
//   - UPDATE all matching rows (no LIMIT 1) — fixes hemnet_listingv2 duplicate-row issue
//   - county column stores SHORT form ('Stockholms', not 'Stockholms län')
//   - municipality column stores SHORT form ('Järfälla', not 'Järfälla kommun')
//   - publishedAt is Unix seconds — cast via to_timestamp($N)::date

'use strict';

const { runJob } = require('./cron-wrapper');
const {
  fetchDetail,
  getOxylabsStats,
  resetOxylabsStats,
} = require('./lib/hemnet-fetch');

// Phase 9 / D-16 retrofit: hard wall-clock budget for the per-detail-fetch worker pool.
// Mirrors booli-targeted-refresh.js (Job D) and booli-targeted-discovery.js (Plan 09-01).
// Sized for the Oxylabs-only steady-state contingency (D-15). Today Hemnet allows direct
// curl so the budget is mostly unused; tomorrow if Hemnet flips to Oxylabs, ~8k pairs at
// conc 8 → ~155 min wall-clock fits the 240-min budget. Pre-staged.
const JOB_BUDGET_MS = 240 * 60 * 1000; // 240 minutes

// ---------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------

function parseArgs(argv) {
  let limit = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--limit') {
      const next = argv[i + 1];
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) {
        limit = n;
        i++;
      }
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { limit, dryRun };
}

// ---------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return 100 + Math.random() * 200; }

// ---------------------------------------------------------------
// Field mapping (Apollo listing -> hemnet_listingv2 column tuple)
// ---------------------------------------------------------------

function shapeListingForDb(listing) {
  const muniRaw = listing && listing.municipality && listing.municipality.fullName;
  const countyRaw = listing && listing.county && listing.county.fullName;

  const municipality =
    typeof muniRaw === 'string' ? muniRaw.replace(/\s+kommun$/i, '') : null;
  const county =
    typeof countyRaw === 'string' ? countyRaw.replace(/\s+län$/i, '') : null;

  return {
    times_viewed: listing.timesViewed != null ? listing.timesViewed : null,
    is_pre_market: listing.isUpcoming === true,
    street_address: listing.streetAddress != null ? listing.streetAddress : null,
    postcode: listing.postCode != null ? listing.postCode : null,
    municipality,
    county,
    published_at_seconds: listing.publishedAt != null ? listing.publishedAt : null,
  };
}

// ---------------------------------------------------------------
// per-county summary helpers
// ---------------------------------------------------------------

function bucket(summary, key) {
  const k = key || '(unknown)';
  if (!summary.perCounty[k]) {
    summary.perCounty[k] = { active: 0, inactive: 0, errors: 0 };
  }
  return summary.perCounty[k];
}

// ---------------------------------------------------------------
// Per-id worker
// ---------------------------------------------------------------

async function processOne(id, client, log, dryRun, summary) {
  let result;
  try {
    result = await fetchDetail(id, { logger: log });
  } catch (err) {
    log('ERROR', `id=${id} fetch error: ${err && err.message}`);
    summary.errors++;
    bucket(summary, '(unknown)').errors++;
    return; // leave existing hemnet_listingv2 row UNTOUCHED
  }

  summary.fetched++;

  if (result.status === 'active') {
    const listing = result.listing;
    summary.parsed++;
    summary.activeCount++;
    const countyKey =
      (listing.county && listing.county.fullName) || '(unknown)';
    bucket(summary, countyKey).active++;

    if (!dryRun) {
      const shaped = shapeListingForDb(listing);
      // UPDATE every row that matches this hemnet_id — duplicate-row fix.
      const upd = await client.query(
        `UPDATE hemnet_listingv2
            SET times_viewed   = $1,
                is_active      = true,
                is_pre_market  = $2,
                street_address = $3,
                postcode       = $4,
                municipality   = $5,
                county         = $6,
                listed         = to_timestamp($7)::date
          WHERE hemnet_id = $8
         RETURNING hemnet_id`,
        [
          shaped.times_viewed,
          shaped.is_pre_market,
          shaped.street_address,
          shaped.postcode,
          shaped.municipality,
          shaped.county,
          shaped.published_at_seconds,
          id,
        ],
      );
      if (upd.rowCount > 0) {
        summary.rowsUpdated += upd.rowCount;
      } else {
        // No existing row — INSERT defensively so cohort-create.js can match Mon.
        await client.query(
          `INSERT INTO hemnet_listingv2
             (hemnet_id, times_viewed, is_active, is_pre_market, street_address,
              postcode, municipality, county, listed)
           VALUES ($1, $2, true, $3, $4, $5, $6, $7, to_timestamp($8)::date)`,
          [
            id,
            shaped.times_viewed,
            shaped.is_pre_market,
            shaped.street_address,
            shaped.postcode,
            shaped.municipality,
            shaped.county,
            shaped.published_at_seconds,
          ],
        );
        summary.rowsInserted++;
      }
    }
    return;
  }

  // result.status === 'inactive'
  if (result.reason === '404') {
    summary.removed404++;
  } else {
    summary.inactiveCount++;
  }
  bucket(summary, '(unknown)').inactive++;

  if (!dryRun) {
    // Preserve times_viewed; only flip is_active. Update ALL matching rows.
    // If 0 rows match, do NOTHING — there's no existing row to mark inactive
    // and we have no full payload to insert.
    const upd = await client.query(
      `UPDATE hemnet_listingv2
          SET is_active = false
        WHERE hemnet_id = $1
       RETURNING hemnet_id`,
      [id],
    );
    if (upd.rowCount > 0) summary.rowsUpdated += upd.rowCount;
  }
}

// ---------------------------------------------------------------
// main()
// ---------------------------------------------------------------

async function main(client, log) {
  const { limit, dryRun } = parseArgs(process.argv);
  const startMs = Date.now();

  // Phase 7.1: reset per-run Oxylabs counters before any fetch.
  resetOxylabsStats();

  // 1. Locked cohort-id SELECT (REFR-01; lookback revised to 8 weeks 2026-05-15
  // per the cohort-window alignment — see header comment + 09-CONTEXT.md D-05).
  const idsRes = await client.query(`
    SELECT DISTINCT cp.hemnet_id
    FROM cohort_pairs cp
    JOIN cohorts c ON c.cohort_id = cp.cohort_id
    WHERE c.week_start >= CURRENT_DATE - INTERVAL '8 weeks'
      AND cp.dropped_hemnet_on IS NULL
    ORDER BY cp.hemnet_id
  `);
  let ids = idsRes.rows.map((r) => r.hemnet_id);
  if (limit != null) ids = ids.slice(0, limit);

  log('INFO', `Refreshing ${ids.length} hemnet_id(s)${dryRun ? ' (DRY RUN)' : ''}`);

  // 2. Pre-allocate summary so all keys are present even when 0 ids returned.
  const summary = {
    totalIds: ids.length,
    fetched: 0,
    parsed: 0,
    errors: 0,
    activeCount: 0,
    inactiveCount: 0,
    removed404: 0,
    rowsUpdated: 0,
    rowsInserted: 0,
    durationMs: 0,
    perCounty: {},
    dryRun: !!dryRun,
    limited: limit != null ? limit : null,
    // Plan 09-02 D-16 retrofit — symmetric to Job D's hardening:
    budgetExceeded: false,
    workerErrors: 0,
  };

  // 3. Hand-rolled worker pool, concurrency 8 (D-15 sizing, D-16 retrofit),
  //    100-300ms jitter per dispatch. Plan 09-01 hardened pattern: budget
  //    check at top of each iteration, per-iteration try/catch capturing
  //    err.stack so any rejection is logged, counted in summary.workerErrors,
  //    and continues instead of crashing the run.
  const queue = ids.slice();
  let processedCount = 0;

  async function worker() {
    while (queue.length) {
      // Plan 09-01 wall-clock budget check (D-16 retrofit, D-15 sizing — 240 min).
      if ((Date.now() - startMs) >= JOB_BUDGET_MS) {
        summary.budgetExceeded = true;
        log('WARN', `job-budget-exceeded ms=${Date.now() - startMs} remaining-queue=${queue.length} — draining`);
        queue.length = 0;
        break;
      }
      const id = queue.shift();
      if (id == null) break;
      try {
        await sleep(jitter());
        await processOne(id, client, log, dryRun, summary);
        processedCount++;
        if (processedCount % 50 === 0) {
          log(
            'INFO',
            `processed ${processedCount}/${ids.length} (active: ${summary.activeCount}, inactive: ${summary.inactiveCount + summary.removed404}, errors: ${summary.errors})`,
          );
        }
      } catch (workerErr) {
        // Plan 09-01 defense in depth (D-16 retrofit). processOne already
        // try/catches internally — this is the safety net for ANYTHING that
        // escapes (sync throws from sleep/jitter, pool-shared client.query
        // rejections that bubble past inner handlers, parser sync throws).
        // Count it, log the FULL stack trace, continue. Do NOT re-throw.
        const detail = String(
          (workerErr && workerErr.stack) ||
          (workerErr && workerErr.message) ||
          JSON.stringify(workerErr),
        );
        summary.workerErrors++;
        log('ERROR',
          `worker-uncaught hemnet_id=${id} err=${detail}`,
        );
      }
    }
  }

  // D-15: 8-worker idiom (NOT Promise.all([worker(), worker()])).
  await Promise.all(Array.from({ length: 8 }, () => worker()));

  summary.durationMs = Date.now() - startMs;

  // Phase 7.1: Oxylabs fallback usage stats from lib/hemnet-fetch.js.
  const _oxStats = getOxylabsStats();
  summary.oxylabsCallCount = _oxStats.oxylabsCallCount;
  summary.oxylabsFailureCount = _oxStats.oxylabsFailureCount;
  summary.oxylabsFallbackRate = _oxStats.oxylabsFallbackRate;

  log('INFO', `Final: ${JSON.stringify(summary)}`);
  return summary;
}

// ---------------------------------------------------------------
// validate(summary) — REFR-06 four-branch contract
// ---------------------------------------------------------------

function validate(summary) {
  if (summary.totalIds === 0) {
    return 'no active cohort hemnet_ids returned — query may be wrong or all cohorts dropped';
  }
  if (summary.parsed === 0 && !summary.dryRun) {
    return '0 listings parsed — Hemnet pipeline may be down or Cloudflare hardened';
  }
  if (summary.totalIds > 0 && (summary.errors / summary.totalIds) > 0.05) {
    const pct = ((summary.errors / summary.totalIds) * 100).toFixed(1);
    return `high error rate: ${summary.errors}/${summary.totalIds} (${pct}%)`;
  }
  // Phase 7.1: surface degraded direct-curl health early.
  if (summary.oxylabsFallbackRate > 0.30) {
    const pct = (summary.oxylabsFallbackRate * 100).toFixed(1);
    return `high Oxylabs fallback rate: ${pct}% — direct curl path degraded; investigate Cloudflare changes`;
  }
  if (summary.oxylabsCallCount > 0 &&
      summary.oxylabsFailureCount / summary.oxylabsCallCount > 0.10) {
    const pct = ((summary.oxylabsFailureCount / summary.oxylabsCallCount) * 100).toFixed(1);
    return `Oxylabs failures: ${summary.oxylabsFailureCount}/${summary.oxylabsCallCount} (${pct}%) — check API status or credit balance`;
  }
  // Plan 09-02 D-16 retrofit — symmetric to Job D's validate() (Plan 09-01 hardening):
  if (summary.budgetExceeded === true) {
    return `job budget exceeded (${JOB_BUDGET_MS}ms); ${summary.rowsUpdated + summary.rowsInserted} writes before drain`;
  }
  if (summary.workerErrors > 0) {
    return `worker-level errors caught: ${summary.workerErrors} (inspect 'worker-uncaught hemnet_id=' log lines for stack)`;
  }
  return null;
}

// ---------------------------------------------------------------
// --smoke: pure-function self-test of shapeListingForDb. No DB,
// no network. Used by Task 2 verify. Exits 0 on pass, 1 on fail.
// ---------------------------------------------------------------
if (process.argv.includes('--smoke')) {
  const assert = require('assert');
  const cases = [
    {
      in: {
        municipality: { fullName: 'Järfälla kommun' },
        county: { fullName: 'Stockholms län' },
        streetAddress: 'Filarvägen 3',
        postCode: '17671',
        timesViewed: 1234,
        isUpcoming: false,
        publishedAt: 1714521600,
      },
      out: {
        municipality: 'Järfälla',
        county: 'Stockholms',
        street_address: 'Filarvägen 3',
        postcode: '17671',
        times_viewed: 1234,
        is_pre_market: false,
        published_at_seconds: 1714521600,
      },
    },
    {
      in: {
        municipality: { fullName: 'Göteborgs kommun' },
        county: { fullName: 'Västra Götalands län' },
        streetAddress: 'X',
        postCode: '40000',
        timesViewed: 0,
        isUpcoming: true,
        publishedAt: 1,
      },
      out: { municipality: 'Göteborgs', county: 'Västra Götalands' },
    },
    {
      in: {
        municipality: { fullName: null },
        county: { fullName: null },
        streetAddress: null,
        postCode: null,
        timesViewed: null,
        isUpcoming: false,
        publishedAt: null,
      },
      out: { municipality: null, county: null },
    },
    {
      in: {
        municipality: { fullName: 'Malmö kommun' },
        county: { fullName: 'Skåne län' },
        streetAddress: 'Y',
        postCode: '20000',
        timesViewed: 5,
        isUpcoming: false,
        publishedAt: 2,
      },
      out: { municipality: 'Malmö', county: 'Skåne' },
    },
    {
      in: {
        municipality: { fullName: 'Uppsala kommun' },
        county: { fullName: 'Uppsala län' },
        streetAddress: 'Z',
        postCode: '75000',
        timesViewed: 10,
        isUpcoming: false,
        publishedAt: 3,
      },
      out: { municipality: 'Uppsala', county: 'Uppsala' },
    },
  ];
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    try {
      const got = shapeListingForDb(c.in);
      for (const k of Object.keys(c.out)) {
        assert.strictEqual(
          got[k],
          c.out[k],
          `field ${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(c.out[k])}`,
        );
      }
      pass++;
    } catch (e) {
      console.error(`SMOKE FAIL: ${e.message}`);
      fail++;
    }
  }
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

runJob({ scriptName: 'hemnet-targeted-refresh', main, validate });
