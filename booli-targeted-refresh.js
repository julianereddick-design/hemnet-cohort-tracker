// booli-targeted-refresh.js — Job D. Every-cycle refresh of times_viewed +
// is_active for every active matched-pair Booli URL (last 8 weeks, not dropped).
//
// Pair-only filter: SELECT joins cohort_pairs → booli_listing on booli_id and
// takes the URL column for fetchBooliDetail. Unmatched booli_listing rows are
// ignored (those are leftover discovery rows and don't need view tracking).
//
// Wrapped by cron-wrapper.runJob — failures hit Slack and cron_job_log.
// Concurrency 8 + 100-300ms jitter. Target ~155 min wall time on full ~8k-pair
// set at 09-1.5's empirical ~52 details/min @ conc 8 (extrapolated from 13/min
// @ conc 2). 240-min JOB_BUDGET_MS gives ~85 min margin.
//
// Behavior locked by .planning/phases/09-production-cutover-self-hosted-scraper-launch/
// 09-02-PLAN.md (D-01..D-05 phase decisions + D-15..D-19 plan-level replan).
// Critical correctness items:
//   - UPDATE on active sets times_viewed + is_active + crawled + days_listed (D-03)
//   - UPDATE on 404 / inactive sets is_active=false ONLY — preserves times_viewed (D-03)
//   - Defensive INSERT fallback if UPDATE finds 0 rows (D-04) — mirrors Job A
//   - Plan 09-01 hardening baked in: JOB_BUDGET_MS = 240 * 60 * 1000, per-iteration
//     try/catch with err.stack capture, validate() warning branches for budgetExceeded
//     and workerErrors > 0
//   - D-15 sizing: concurrency 8 (NOT 2 — Plan 09-01 conc-2 hardening lock deliberately
//     relaxed for both refresh jobs; paid Oxylabs Advanced retired the diagnostic need)

'use strict';

const { runJob } = require('./cron-wrapper');
const {
  fetchBooliDetail,
  getOxylabsStats,
  resetOxylabsStats,
} = require('./lib/booli-fetch');

// Phase 9 / D-15: hard wall-clock budget for the per-detail-fetch worker pool.
// Inherited from Plan 09-01's hardened pattern (booli-targeted-discovery.js
// Task 2 Edit 1), sized for the Oxylabs-only steady state confirmed by 09-1.5
// (paid Oxylabs Advanced, ~5 sec/call). At conc 8 (D-15), ~8k pairs takes
// ~155 min wall-clock; 240 min gives ~85 min margin. Fits the new parallel
// cron grid (D-17): 14:00 → 18:00 UTC window before cohort-track at 22:00.
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
// Field mapping (Booli parsed listing -> two refresh-targeted columns)
// ---------------------------------------------------------------
// Unlike Job A's shapeListingForDb, Job D writes ONLY the refresh-time
// columns. Discovery-time columns (title, street_address, county,
// municipality, postcode) are owned by Job C's UPSERT and would race the
// every-cycle refresh if Job D touched them.
//
// Phase 9 follow-up (post-Django-decommission): Job D also refreshes the
// matching-strategy fields (price, rooms, living_area, object_type) on every
// cycle. Coalesced UPDATE: only overwrite a non-null parsed value over the
// existing column to avoid silently nulling fields if Booli's Apollo state is
// briefly malformed. Backfills the 2026-05-15 broken-Django rows within
// 1-2 cron cycles.
//
// Plan 10-02 (e) 2026-05-26: agent_id is no longer written (see SQL call sites
// at line 164 + 196 — both pass literal null). The shape function below still
// reads Booli's agentId for honesty / documentation, but production SQL
// discards it. Closes 09-2.5 #6.
function shapeBooliForUpdate(listing) {
  const l = listing || {};
  return {
    times_viewed:
      l.timesViewed != null ? l.timesViewed : null,
    published_at_seconds:
      l.published != null ? l.published : null,
    price:      l.price      != null ? l.price      : null,
    rooms:      l.rooms      != null ? l.rooms      : null,
    livingArea: l.livingArea != null ? l.livingArea : null,
    objectType: l.objectType != null ? l.objectType : null,
    agentId:    l.agentId    != null ? l.agentId    : null,
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
// Per-pair worker
// ---------------------------------------------------------------

async function processOne(pair, client, log, dryRun, summary) {
  const { booli_id, url } = pair;
  let result;
  try {
    result = await fetchBooliDetail(url, { logger: log });
  } catch (err) {
    log('ERROR', `booli_id=${booli_id} url=${url} fetch error: ${err && err.message}`);
    summary.errors++;
    bucket(summary, '(unknown)').errors++;
    return; // leave existing booli_listing row UNTOUCHED
  }

  summary.fetched++;

  if (result.status === 'active') {
    const listing = result.listing;
    summary.parsed++;
    summary.activeCount++;
    const countyKey = (listing && listing.county) || '(unknown)';
    bucket(summary, countyKey).active++;

    if (!dryRun) {
      const shaped = shapeBooliForUpdate(listing);
      // UPDATE the booli_listing row for this booli_id (D-03).
      const upd = await client.query(
        `UPDATE booli_listing
            SET times_viewed = $1,
                is_active    = true,
                crawled      = NOW(),
                days_listed  = (CURRENT_DATE - listed)::int,
                price        = COALESCE($3, price),
                rooms        = COALESCE($4, rooms),
                living_area  = COALESCE($5, living_area),
                object_type  = COALESCE($6, object_type),
                agent_id     = COALESCE($7, agent_id)
          WHERE booli_id = $2
         RETURNING booli_id`,
        [
          shaped.times_viewed,    // $1
          booli_id,                // $2
          shaped.price,            // $3
          shaped.rooms,            // $4
          shaped.livingArea,       // $5
          shaped.objectType,       // $6
          null,                    // $7 — Plan 10-02 (e): agent_id no longer written
        ],
      );
      if (upd.rowCount > 0) {
        summary.rowsUpdated += upd.rowCount;
      } else {
        // Defensive INSERT fallback (D-04). cohort_pairs.booli_id should always
        // have a backing booli_listing row (cohort-create.js guarantees this),
        // but the safety net mirrors Job A symmetry and costs ~15 lines.
        try {
          await client.query(
            `INSERT INTO booli_listing
               (id, url, booli_id, is_active, listed, crawled, times_viewed,
                title, street_address, county, municipality, district,
                postcode, currency, days_listed, is_pre_market,
                price, rooms, living_area, object_type, agent_id)
             VALUES
               (nextval('booli_listing_id_seq'), $1, $2, true,
                to_timestamp($3)::date, NOW(), $4,
                '', '', '', '', '', NULL, 'SEK',
                GREATEST(0, (CURRENT_DATE - to_timestamp($3)::date)::int), false,
                $5, $6, $7, $8, $9)
             ON CONFLICT (url) DO NOTHING`,
            [
              url,                          // $1
              booli_id,                     // $2
              shaped.published_at_seconds,  // $3
              shaped.times_viewed,          // $4
              shaped.price,                 // $5
              shaped.rooms,                 // $6
              shaped.livingArea,            // $7
              shaped.objectType,            // $8
              null,                         // $9 — Plan 10-02 (e): agent_id no longer written
            ],
          );
          summary.rowsInserted++;
        } catch (insErr) {
          log('ERROR',
            `defensive-insert-failed booli_id=${booli_id} url=${url}: ${insErr && insErr.message}`,
          );
          // Swallow — this is defense-in-depth, not the primary path.
        }
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
    // Preserve times_viewed; only flip is_active (D-03).
    const upd = await client.query(
      `UPDATE booli_listing
          SET is_active = false
        WHERE booli_id = $1
       RETURNING booli_id`,
      [booli_id],
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

  // Reset per-run Oxylabs counters before any fetch.
  resetOxylabsStats();

  // D-02 SELECT (LOCKED): pair-only JOIN to booli_listing for URL.
  // 8-week lookback (D-05) + dropped_booli_on IS NULL pair-only filter (D-01).
  const pairsRes = await client.query(`
    SELECT DISTINCT cp.booli_id, bl.url
    FROM cohort_pairs cp
    JOIN cohorts c ON c.cohort_id = cp.cohort_id
    JOIN booli_listing bl ON bl.booli_id = cp.booli_id
    WHERE c.week_start >= CURRENT_DATE - INTERVAL '8 weeks'
      AND cp.dropped_booli_on IS NULL
      AND cp.removed_at IS NULL
    ORDER BY cp.booli_id
  `);
  let pairs = pairsRes.rows;
  if (limit != null) pairs = pairs.slice(0, limit);

  log('INFO', `Refreshing ${pairs.length} booli_id(s)${dryRun ? ' (DRY RUN)' : ''}`);

  // Pre-allocate summary so all keys are present even when 0 rows returned.
  const summary = {
    totalIds: pairs.length,
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
    // Plan 09-01 hardening (D-15 sizing):
    budgetExceeded: false,
    workerErrors: 0,
  };

  // Hand-rolled worker pool, concurrency 8 + 100-300ms jitter (D-15).
  // INHERITS Plan 09-01's hardened pattern: budget check at top of each
  // iteration, per-iteration try/catch capturing err.stack so any rejection
  // is logged, counted in summary.workerErrors, and continues instead of
  // crashing the run.
  const queue = pairs.slice();
  let processedCount = 0;

  async function worker() {
    while (queue.length) {
      // Plan 09-01 wall-clock budget check (D-15 — 240 min).
      if ((Date.now() - startMs) >= JOB_BUDGET_MS) {
        summary.budgetExceeded = true;
        log('WARN', `job-budget-exceeded ms=${Date.now() - startMs} remaining-queue=${queue.length} — draining`);
        queue.length = 0;
        break;
      }
      const pair = queue.shift();
      if (pair == null) break;
      try {
        await sleep(jitter());
        await processOne(pair, client, log, dryRun, summary);
        processedCount++;
        if (processedCount % 50 === 0) {
          log(
            'INFO',
            `processed ${processedCount}/${pairs.length} (active: ${summary.activeCount}, ` +
            `inactive: ${summary.inactiveCount + summary.removed404}, errors: ${summary.errors})`,
          );
        }
      } catch (workerErr) {
        const detail = String(
          (workerErr && workerErr.stack) ||
          (workerErr && workerErr.message) ||
          JSON.stringify(workerErr),
        );
        summary.workerErrors++;
        log('ERROR',
          `worker-uncaught booli_id=${pair && pair.booli_id} url=${pair && pair.url} err=${detail}`,
        );
      }
    }
  }
  // D-15: 8-worker idiom (NOT Promise.all([worker(), worker()])).
  await Promise.all(Array.from({ length: 8 }, () => worker()));

  summary.durationMs = Date.now() - startMs;

  const _oxStats = getOxylabsStats();
  summary.oxylabsCallCount = _oxStats.oxylabsCallCount;
  summary.oxylabsFailureCount = _oxStats.oxylabsFailureCount;
  summary.oxylabsFallbackRate = _oxStats.oxylabsFallbackRate;

  log('INFO', `Final: ${JSON.stringify(summary)}`);
  return summary;
}

// ---------------------------------------------------------------
// validate(summary) — seven-branch contract (D-01 four + 09-01 two + Oxylabs)
// ---------------------------------------------------------------

function validate(summary) {
  if (summary.totalIds === 0) {
    return 'no active cohort booli_ids returned — query may be wrong or all cohorts dropped';
  }
  if (summary.parsed === 0 && !summary.dryRun) {
    return '0 listings parsed — Booli pipeline may be down';
  }
  if (summary.totalIds > 0 && (summary.errors / summary.totalIds) > 0.05) {
    const pct = ((summary.errors / summary.totalIds) * 100).toFixed(1);
    return `high error rate: ${summary.errors}/${summary.totalIds} (${pct}%)`;
  }
  // Plan 10-02 (a): removed the `oxylabsFallbackRate > 0.30` warning. Post-09-1.5
  // steady state is 100% Oxylabs fallback for Booli; this threshold fired every cycle
  // as cosmetic noise. The rate is still recorded in summary as a reporting field —
  // dashboards/queries can surface it. Genuine API health is still covered by the
  // `oxylabsFailureCount / oxylabsCallCount > 0.10` branch below.
  if (summary.oxylabsCallCount > 0 &&
      summary.oxylabsFailureCount / summary.oxylabsCallCount > 0.10) {
    const pct = ((summary.oxylabsFailureCount / summary.oxylabsCallCount) * 100).toFixed(1);
    return `Oxylabs failures: ${summary.oxylabsFailureCount}/${summary.oxylabsCallCount} (${pct}%) — check API status or credit balance`;
  }
  // Plan 09-01 hardening branches (D-15 sizing):
  if (summary.budgetExceeded === true) {
    return `job budget exceeded (${JOB_BUDGET_MS}ms); ${summary.rowsUpdated + summary.rowsInserted} writes before drain`;
  }
  if (summary.workerErrors > 0) {
    return `worker-level errors caught: ${summary.workerErrors} (inspect 'worker-uncaught booli_id=' log lines for stack)`;
  }
  return null;
}

// ---------------------------------------------------------------
// --smoke: pure-function self-test of shapeBooliForUpdate + parseArgs.
// No DB, no network. Exits 0 on pass, 1 on fail.
// ---------------------------------------------------------------
if (process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- shapeBooliForUpdate ---
  check('shape: timesViewed + published populated', () => {
    const got = shapeBooliForUpdate({ timesViewed: 1234, published: 1714521600 });
    assert.strictEqual(got.times_viewed, 1234);
    assert.strictEqual(got.published_at_seconds, 1714521600);
  });
  check('shape: both null', () => {
    const got = shapeBooliForUpdate({ timesViewed: null, published: null });
    assert.strictEqual(got.times_viewed, null);
    assert.strictEqual(got.published_at_seconds, null);
  });
  check('shape: zero values pass through (NOT clobbered to null)', () => {
    const got = shapeBooliForUpdate({ timesViewed: 0, published: 1 });
    assert.strictEqual(got.times_viewed, 0);
    assert.strictEqual(got.published_at_seconds, 1);
  });
  check('shape: empty object defensive', () => {
    const got = shapeBooliForUpdate({});
    assert.strictEqual(got.times_viewed, null);
    assert.strictEqual(got.published_at_seconds, null);
  });
  check('shape: integer round-trip', () => {
    const got = shapeBooliForUpdate({ timesViewed: 5, published: 2 });
    assert.strictEqual(got.times_viewed, 5);
    assert.strictEqual(got.published_at_seconds, 2);
  });
  // Phase 9 follow-up — new Hemnet-matching fields pass through
  check('shape: price/rooms/livingArea/objectType/agentId populated', () => {
    const got = shapeBooliForUpdate({
      timesViewed: 10, published: 1,
      price: 4250000, rooms: 2.5, livingArea: 65, objectType: 'Lägenhet', agentId: 64,
    });
    assert.strictEqual(got.price, 4250000);
    assert.strictEqual(got.rooms, 2.5);
    assert.strictEqual(got.livingArea, 65);
    assert.strictEqual(got.objectType, 'Lägenhet');
    assert.strictEqual(got.agentId, 64);
  });
  check('shape: missing matching fields → null (not crash)', () => {
    const got = shapeBooliForUpdate({ timesViewed: 10, published: 1 });
    assert.strictEqual(got.price, null);
    assert.strictEqual(got.rooms, null);
    assert.strictEqual(got.livingArea, null);
    assert.strictEqual(got.objectType, null);
    assert.strictEqual(got.agentId, null);
  });

  // --- parseArgs ---
  check('args: --dry-run', () => {
    const r = parseArgs(['node', 'script.js', '--dry-run']);
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.limit, null);
  });
  check('args: --limit positional', () => {
    const r = parseArgs(['node', 'script.js', '--limit', '100']);
    assert.strictEqual(r.limit, 100);
  });
  check('args: --limit=N equals form', () => {
    const r = parseArgs(['node', 'script.js', '--limit=50']);
    assert.strictEqual(r.limit, 50);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

runJob({ scriptName: 'booli-targeted-refresh', main, validate });
