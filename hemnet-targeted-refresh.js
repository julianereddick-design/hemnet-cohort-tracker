// hemnet-targeted-refresh.js — Job A. Daily refresh of times_viewed + is_active
// for every active cohort hemnet_id (last 12 weeks, not dropped).
//
// Wrapped by cron-wrapper.runJob — failures hit Slack and cron_job_log.
// Concurrency 2 + 100-300ms jitter. Target ~33-51 min wall time on full set.
//
// Behavior locked by .planning/phases/07-daily-targeted-refresh-job-a/07-01-PLAN.md
// and 07-CONTEXT.md. Critical correctness items:
//   - UPDATE all matching rows (no LIMIT 1) — fixes hemnet_listingv2 duplicate-row issue
//   - county column stores SHORT form ('Stockholms', not 'Stockholms län')
//   - municipality column stores SHORT form ('Järfälla', not 'Järfälla kommun')
//   - publishedAt is Unix seconds — cast via to_timestamp($N)::date

'use strict';

const { runJob } = require('./cron-wrapper');
const { fetchDetail } = require('./lib/hemnet-fetch');

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

  // 1. Locked cohort-id SELECT (REFR-01).
  const idsRes = await client.query(`
    SELECT DISTINCT cp.hemnet_id
    FROM cohort_pairs cp
    JOIN cohorts c ON c.cohort_id = cp.cohort_id
    WHERE c.week_start >= CURRENT_DATE - INTERVAL '12 weeks'
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
  };

  // 3. Hand-rolled worker pool, concurrency 2, 100-300ms jitter per dispatch.
  const queue = ids.slice();
  let processedCount = 0;

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      if (id == null) break;
      await sleep(jitter());
      await processOne(id, client, log, dryRun, summary);
      processedCount++;
      if (processedCount % 50 === 0) {
        log(
          'INFO',
          `processed ${processedCount}/${ids.length} (active: ${summary.activeCount}, inactive: ${summary.inactiveCount + summary.removed404}, errors: ${summary.errors})`,
        );
      }
    }
  }

  await Promise.all([worker(), worker()]);

  summary.durationMs = Date.now() - startMs;
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
  return null;
}

runJob({ scriptName: 'hemnet-targeted-refresh', main, validate });
