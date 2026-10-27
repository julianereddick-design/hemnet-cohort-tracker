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
    active_package: listing.activePackage != null ? listing.activePackage : null,
    is_teaser: listing.isTeaser != null ? listing.isTeaser : null,
    listing_typename: listing.typename != null ? listing.typename : null,
    is_project: listing.isProject != null ? listing.isProject : null,
    is_project_unit: listing.isProjectUnit != null ? listing.isProjectUnit : null,
  };
}

// ---------------------------------------------------------------
// Listing format tracking (2026-10-27)
//
// Hemnet launched a free tier (package MINIMAL) on 2026-10-20 and is about to add
// aggregated listings from agency websites. Both get far less exposure than paid
// listings, so mixing them into the views data would pull Hemnet's share down for
// reasons that have nothing to do with Booli. We record each listing's package and
// type on every refresh, keep a history of changes, and alert the first time a
// value appears that isn't in the lists below.
//
// When the alert fires: look at a listing with the new value, decide how the
// views reports should treat it, then add it here. See docs/handover/CHANGELOG.md.
// ---------------------------------------------------------------

const KNOWN_PACKAGES = new Set([
  'BASIC', 'PLUS', 'PREMIUM', 'MAX',              // paid
  'MINIMAL',                                     // free tier, live 2026-10-20
  'NC_PREMIUM_PROJECT', 'NC_PREMIUM_PROJECT_UNIT', // new-build projects
]);
const KNOWN_TYPENAMES = new Set(['ActivePropertyListing']);

// One statement per listing, separate from SQL_REFRESH_ACTIVE so that the views
// refresh never depends on these columns existing: if the migration hasn't run
// (or was rolled back) the job skips this and carries on exactly as before.
const SQL_REFRESH_FORMAT = `UPDATE hemnet_listingv2
    SET active_package   = $1,
        is_teaser        = $2,
        listing_typename = $3,
        is_project       = $4,
        is_project_unit  = $5,
        format_seen_at   = NOW()
  WHERE hemnet_id = $6`;

// Append a history row only when the format differs from the latest one we hold,
// so the table records changes (paid -> free, upgrades) rather than every refresh.
const SQL_FORMAT_HISTORY = `INSERT INTO hemnet_listing_format_history
     (hemnet_id, active_package, is_teaser, listing_typename, is_project, is_project_unit)
   SELECT $1::bigint, $2::text, $3::boolean, $4::text, $5::boolean, $6::boolean
   WHERE NOT EXISTS (
     SELECT 1 FROM (
       SELECT active_package, is_teaser, listing_typename, is_project, is_project_unit
         FROM hemnet_listing_format_history
        WHERE hemnet_id = $1::bigint
        ORDER BY observed_at DESC LIMIT 1
     ) last
     WHERE last.active_package   IS NOT DISTINCT FROM $2::text
       AND last.is_teaser        IS NOT DISTINCT FROM $3::boolean
       AND last.listing_typename IS NOT DISTINCT FROM $4::text
       AND last.is_project       IS NOT DISTINCT FROM $5::boolean
       AND last.is_project_unit  IS NOT DISTINCT FROM $6::boolean
   )`;

const SQL_FORMAT_READY = `SELECT
    (SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'hemnet_listingv2' AND column_name = 'active_package') = 1
    AND to_regclass('hemnet_listing_format_history') IS NOT NULL AS ready`;

// Tally one parsed listing's format into the run summary.
function tallyFormat(summary, shaped) {
  const pkg = shaped.active_package || '(none)';
  summary.packages[pkg] = (summary.packages[pkg] || 0) + 1;
  if (shaped.is_teaser === true) summary.teaserCount++;
  if (!KNOWN_PACKAGES.has(pkg)) {
    summary.unseenPackages[pkg] = (summary.unseenPackages[pkg] || 0) + 1;
  }
  const tn = shaped.listing_typename || '(none)';
  if (!KNOWN_TYPENAMES.has(tn)) {
    summary.unrecognisedTypes[tn] = (summary.unrecognisedTypes[tn] || 0) + 1;
  }
}

// Plain-English alert text, or null when nothing new appeared. Written to be read
// in Slack without context: what changed, how many listings, what it means.
function formatAlertMessage(summary) {
  const lines = [];
  for (const [pkg, n] of Object.entries(summary.unseenPackages || {})) {
    lines.push(pkg === '(none)'
      ? `${n} tracked listing(s) came back with no package at all. Hemnet may have changed the page.`
      : `New Hemnet package "${pkg}" on ${n} tracked listing(s).`);
  }
  for (const [tn, n] of Object.entries(summary.unrecognisedTypes || {})) {
    lines.push(`${n} tracked listing(s) now use a page type we don't recognise ("${tn}"). ` +
      `Their view counts were not updated.`);
  }
  if (!lines.length) return null;
  return 'Hemnet listing format changed. Check before using views data.\n' + lines.join('\n') +
    '\nNext step: look at one of these listings and decide how the views report should treat it ' +
    '(see docs/handover/CHANGELOG.md, 2026-10-27).';
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
// Write statements
//
// Named constants so the --smoke self-test can assert the contract every write
// path here owes the health report: each one must stamp `crawled`, because
// hemnetRefreshRecent (lib/job-assertions.js) counts
// `hemnet_listingv2 WHERE crawled >= lastFire` to decide this job ran. Leave it
// unstamped and a perfectly healthy run reports as a tier-1 failure — which is
// exactly what happened from the assertion's first fire until 2026-08-19.
//
// Plan 10-02 (g) 2026-05-26: COALESCE-preserve the 5 discovery-metadata fields
// (street_address / postcode / municipality / county / listed), mirroring Plan
// 09-2.5 D-24 on Booli view data (booli-targeted-refresh.js:150-157, which has
// always stamped crawled). Defense in depth: in practice the parser
// short-circuits (errors++) when fetch fails, so this is rarely hit — but a
// transient partial-parse glitch returning null on a metadata field would
// otherwise blank out validated address data.
// times_viewed + is_pre_market unchanged — those are meaningful state updates,
// not parse-derived fields.
// ---------------------------------------------------------------

const SQL_REFRESH_ACTIVE = `UPDATE hemnet_listingv2
    SET times_viewed   = $1,
        crawled        = NOW(),
        is_active      = true,
        is_pre_market  = $2,
        street_address = COALESCE($3, street_address),
        postcode       = COALESCE($4, postcode),
        municipality   = COALESCE($5, municipality),
        county         = COALESCE($6, county),
        listed         = COALESCE(to_timestamp($7)::date, listed)
  WHERE hemnet_id = $8
 RETURNING hemnet_id`;

// ⚠ THIS BRANCH IS DEAD CODE — it cannot succeed, and adding `crawled` below
// does NOT repair it. hemnet_listingv2 has 23 NOT NULL columns without
// defaults; this statement supplies 10 and omits 14 (id, url, type, status,
// title, district, city, price, currency, housing_form, tenure, amenities,
// construction_year, images). Verified 2026-08-19 by executing it inside a
// rolled-back transaction against prod: it throws on `url` before `crawled` is
// ever reached. `crawled` is added here only so the statement is correct on the
// one axis this change is about; making the branch actually work means sourcing
// 14 more fields the refresh payload does not carry, which is a separate job.
// It has never fired in production (rowsInserted has always been 0 — every
// cohort_pairs.hemnet_id has had a listing row), and if it did, the worker-level
// try/catch would count it as workerErrors and skip that listing rather than
// crash the run. That is why the break went unnoticed.
const SQL_REFRESH_INSERT = `INSERT INTO hemnet_listingv2
     (hemnet_id, times_viewed, is_active, is_pre_market, street_address,
      postcode, municipality, county, listed, crawled)
   VALUES ($1, $2, true, $3, $4, $5, $6, $7, to_timestamp($8)::date, NOW())`;

// Preserve times_viewed; only flip is_active. Update ALL matching rows.
// If 0 rows match, do NOTHING — there's no existing row to mark inactive
// and we have no full payload to insert.
const SQL_MARK_INACTIVE = `UPDATE hemnet_listingv2
    SET is_active = false,
        crawled   = NOW()
  WHERE hemnet_id = $1
 RETURNING hemnet_id`;

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
        SQL_REFRESH_ACTIVE,
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
          SQL_REFRESH_INSERT,
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

    // Listing format — counted even in dry runs; written only when the columns exist.
    const shapedFormat = shapeListingForDb(listing);
    tallyFormat(summary, shapedFormat);
    if (!dryRun && summary.formatTracking) {
      const f = [shapedFormat.active_package, shapedFormat.is_teaser, shapedFormat.listing_typename,
        shapedFormat.is_project, shapedFormat.is_project_unit];
      await client.query(SQL_REFRESH_FORMAT, [...f, id]);
      const h = await client.query(SQL_FORMAT_HISTORY, [id, ...f]);
      summary.formatChanges += h.rowCount;
    }
    return;
  }

  // The page holds this listing under a type we don't recognise (see
  // parseActiveListing). Leave the row exactly as it was: marking it inactive would
  // start the drop streak and quietly remove the pair from the views data.
  if (result.status === 'unrecognised') {
    const tn = result.typename || '(unknown)';
    summary.unrecognisedTypes[tn] = (summary.unrecognisedTypes[tn] || 0) + 1;
    log('WARN', `id=${id} unrecognised listing type "${tn}" — row left untouched`);
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
      SQL_MARK_INACTIVE,
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
      AND cp.removed_at IS NULL
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
    // Listing format tracking (2026-10-27).
    formatTracking: false,   // true once migrate-hemnet-listing-format.js has run
    packages: {},            // activePackage -> count of listings parsed this run
    teaserCount: 0,
    unseenPackages: {},      // packages not in KNOWN_PACKAGES -> count
    unrecognisedTypes: {},   // listing types we couldn't read -> count
    formatChanges: 0,        // history rows written (new listing, or package changed)
  };
  summary.formatTracking = (await client.query(SQL_FORMAT_READY)).rows[0].ready === true;
  if (!summary.formatTracking) {
    log('WARN', 'listing-format columns not found — run migrate-hemnet-listing-format.js; tracking skipped');
  }

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
  // Plan 10-02 (a, symmetry): removed the Phase-7.1 `oxylabsFallbackRate > 0.30`
  // warning. Hemnet flipped to 100% Oxylabs over 2026-05-08→2026-05-21 (per memory
  // project_hemnet_flipped_to_oxylabs); the threshold now fires every */2 cycle as
  // cosmetic noise. Rate is still in summary as a reporting field. Real Oxylabs API
  // health is covered by the failure-rate branch below.
  if (summary.oxylabsCallCount > 0 &&
      summary.oxylabsFailureCount / summary.oxylabsCallCount > 0.10) {
    const pct = ((summary.oxylabsFailureCount / summary.oxylabsCallCount) * 100).toFixed(1);
    return `Oxylabs failures: ${summary.oxylabsFailureCount}/${summary.oxylabsCallCount} (${pct}%) — check API status or credit balance`;
  }
  // 2026-10-27: a Hemnet package or listing type we haven't seen before. Keyed, so
  // it follows the re-notify ladder as one incident rather than alerting every run.
  const formatMsg = formatAlertMessage(summary);
  if (formatMsg) {
    return { key: 'hemnet-new-listing-format', severity: 'warning', message: formatMsg };
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
  // Contract with hemnetRefreshRecent (lib/job-assertions.js): that assertion
  // counts `hemnet_listingv2 WHERE crawled >= lastFire` to decide whether this
  // job ran. Every write path must therefore stamp `crawled` — otherwise a run
  // that fetches 5,167 listings and updates 5,203 rows still reports as a
  // tier-1 failure, because nothing it wrote is visible to the check.
  for (const [name, sql] of [
    ['SQL_REFRESH_ACTIVE', SQL_REFRESH_ACTIVE],
    ['SQL_REFRESH_INSERT', SQL_REFRESH_INSERT],
    ['SQL_MARK_INACTIVE', SQL_MARK_INACTIVE],
  ]) {
    try {
      assert.ok(
        /\bcrawled\b/.test(sql),
        `${name} does not write \`crawled\` — hemnetRefreshRecent cannot see this write`,
      );
      pass++;
    } catch (e) {
      console.error(`SMOKE FAIL: ${e.message}`);
      fail++;
    }
  }

  // Listing format tracking (2026-10-27).
  const fmtCheck = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  const newSummary = () => ({ packages: {}, teaserCount: 0, unseenPackages: {}, unrecognisedTypes: {} });
  fmtCheck('known packages (paid + free) raise no alert', () => {
    const s = newSummary();
    for (const p of ['PREMIUM', 'MAX', 'MINIMAL', 'BASIC']) {
      tallyFormat(s, { active_package: p, is_teaser: false, listing_typename: 'ActivePropertyListing' });
    }
    assert.deepStrictEqual(s.packages, { PREMIUM: 1, MAX: 1, MINIMAL: 1, BASIC: 1 });
    assert.strictEqual(formatAlertMessage(s), null);
    assert.strictEqual(validate({ totalIds: 4, parsed: 4, errors: 0, ...s }), null);
  });
  fmtCheck('an unseen package raises a keyed warning in plain English', () => {
    const s = newSummary();
    tallyFormat(s, { active_package: 'AGGREGATED', is_teaser: false, listing_typename: 'ActivePropertyListing' });
    tallyFormat(s, { active_package: 'AGGREGATED', is_teaser: true, listing_typename: 'ActivePropertyListing' });
    assert.strictEqual(s.teaserCount, 1);
    const v = validate({ totalIds: 2, parsed: 2, errors: 0, ...s });
    assert.strictEqual(v.key, 'hemnet-new-listing-format');
    assert.strictEqual(v.severity, 'warning');
    assert.ok(v.message.includes('New Hemnet package "AGGREGATED" on 2 tracked listing(s).'), v.message);
  });
  fmtCheck('a missing package and an unknown page type are both reported', () => {
    const s = newSummary();
    tallyFormat(s, { active_package: null, listing_typename: 'ActivePropertyListing' });
    s.unrecognisedTypes.TeaserListing = 3;
    const m = formatAlertMessage(s);
    assert.ok(m.includes('no package at all'), m);
    assert.ok(m.includes('3 tracked listing(s) now use a page type we don\'t recognise ("TeaserListing")'), m);
  });
  fmtCheck('format SQL is separate from the views update and history is change-only', () => {
    assert.ok(!/active_package/.test(SQL_REFRESH_ACTIVE), 'views update must not depend on the new columns');
    assert.ok(/WHERE NOT EXISTS/.test(SQL_FORMAT_HISTORY));
    assert.ok(/IS NOT DISTINCT FROM/.test(SQL_FORMAT_HISTORY));
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

runJob({ scriptName: 'hemnet-targeted-refresh', main, validate });
