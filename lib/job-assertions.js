'use strict';

// lib/job-assertions.js
//
// "Exit code 0" is not evidence of work done. Incident 3: downloadImage never
// settled, the worker never returned, the event loop drained, and node exited 0
// with main() still pending — skipping ALL write-back. Only a check on the
// job's OUTPUT catches that.
//
// Every assertion here is phrased against `lastFire` — the moment the job
// SHOULD last have fired (lib/job-cron.js) — and never against a calendar
// period. The digest runs at 03:00 UTC, so "a market_totals row for today"
// would fail every single day for a job that fires at 08:30. A --smoke check
// greps this file for calendar-period SQL to keep that true.
//
// Column choices verified against the live DB on 2026-08-17:
//   * `crawled` is the live refresh timestamp on hemnet_listingv2 / booli_listing.
//     `updated` froze in April 2026 and must NOT be used.
//   * `cohorts` has no `matched` column — pair counts come from cohort_pairs.
//   * `cohort_pairs` has no created_at, so hemnet-targeted-match and
//     booli-targeted-discovery use time-boxed `crawled` PROXIES (documented per
//     assertion). Those two are the weakest assertions here.
//
//   node lib/job-assertions.js --smoke

const { lastExpectedFire } = require('./job-cron');

const GRACE_MIN = 15;   // breathing room on top of expectedDurationMin

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
}

const ok = (detail) => ({ ok: true, detail });
const bad = (detail) => ({ ok: false, detail });

const ASSERTIONS = {
  // cohort-create — builds the week's cohort from that week's new listings.
  // NB the cohort_id lags the calendar week by one (built from the completed
  // week), so assert on created_at, not on the cohort's name.
  async cohortCreated(client, { lastFire }) {
    const r = await client.query(
      `SELECT c.cohort_id,
              (SELECT count(*)::int FROM cohort_pairs p WHERE p.cohort_id = c.cohort_id) AS pairs
         FROM cohorts c WHERE c.created_at >= $1 ORDER BY c.created_at DESC LIMIT 1`, [lastFire]);
    if (!r.rows.length) return bad('no cohorts row created since the last expected run');
    const { cohort_id, pairs } = r.rows[0];
    return pairs > 0 ? ok(`${cohort_id} with ${pairs} pairs`)
                     : bad(`${cohort_id} created but has 0 pairs`);
  },

  // market-totals-daily — 4 rows (site x segment). Also require at least one
  // total to differ from the prior day: 4 identical rows means a frozen scrape,
  // which writes successfully and is otherwise invisible.
  async marketTotalsDay(client, { lastFire }) {
    const r = await client.query(
      `WITH d AS (SELECT $1::date AS day)
       SELECT (SELECT count(*)::int FROM market_totals WHERE day = (SELECT day FROM d)) AS n_rows,
              (SELECT count(*)::int FROM market_totals mt
                 JOIN market_totals p ON p.site = mt.site AND p.segment = mt.segment
                                     AND p.day = (SELECT day FROM d) - 1
                WHERE mt.day = (SELECT day FROM d) AND mt.total <> p.total) AS n_changed,
              (SELECT count(*)::int FROM market_totals WHERE day = (SELECT day FROM d) - 1) AS n_prior`,
      [lastFire]);
    const { n_rows, n_changed, n_prior } = r.rows[0];
    if (n_rows !== 4) return bad(`${n_rows}/4 market_totals rows for that day`);
    if (n_prior > 0 && n_changed === 0) return bad('4 rows written but every total identical to the prior day — frozen scrape');
    return ok(`4/4 rows, ${n_changed} changed vs prior day`);
  },

  async premarketFlowWeek(client, { lastFire }) {
    const r = await client.query(
      `SELECT count(DISTINCT platform)::int AS platforms, count(*)::int AS n
         FROM premarket_flow_weekly WHERE snapshot_date >= $1::date`, [lastFire]);
    const { platforms, n } = r.rows[0];
    return platforms >= 2 ? ok(`${n} rows across ${platforms} platforms`)
                          : bad(`only ${platforms}/2 platforms (${n} rows) since the last expected run`);
  },

  async premarketQualityWeek(client, { lastFire }) {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM premarket_quality_weekly WHERE snapshot_date >= $1::date`, [lastFire]);
    const { n } = r.rows[0];
    return n >= 1 ? ok(`${n} row(s)`) : bad('no premarket_quality_weekly row since the last expected run');
  },

  async ageCensusMonth(client, { lastFire }) {
    const r = await client.query(
      `SELECT count(DISTINCT pool)::int AS pools, count(*)::int AS n
         FROM age_census_run WHERE run_date >= $1::date`, [lastFire]);
    const { pools, n } = r.rows[0];
    return pools >= 4 ? ok(`${pools}/4 pools (${n} rows)`) : bad(`${pools}/4 pools since the last expected run`);
  },

  // cohort-track — view counters are cumulative so the LEVEL survives a miss,
  // but the interval increment is lost, and incremental view rate is the metric.
  // The denominator MUST be scoped to the 56-day tracking window. cohort-track
  // only tracks cohorts inside that window, so counting every active pair ever
  // (11,992 on 2026-08-17 vs 3,749 in-window) makes a healthy run read as 38%
  // and alerts forever — the standing-noise failure this design exists to stop.
  // Anchored on lastFire rather than CURRENT_DATE so the window moves with the
  // run being judged, not with the moment the digest happens to execute.
  async cohortTrackViews(client, { lastFire }) {
    const r = await client.query(
      `SELECT (SELECT count(*)::int FROM cohort_daily_views WHERE date >= $1::date) AS n_views,
              (SELECT count(*)::int FROM cohort_pairs cp
                 JOIN cohorts c ON c.cohort_id = cp.cohort_id
                WHERE cp.removed_at IS NULL
                  AND (cp.dropped_booli_on IS NULL OR cp.dropped_hemnet_on IS NULL)
                  AND c.week_start >= $1::date - 56) AS n_active`, [lastFire]);
    const { n_views, n_active } = r.rows[0];
    if (n_active === 0) return ok('no active pairs to track');
    const pct = Math.round((n_views / n_active) * 100);
    return n_views >= n_active * 0.8
      ? ok(`${n_views}/${n_active} active pairs tracked (${pct}%)`)
      : bad(`only ${n_views}/${n_active} active pairs tracked (${pct}%)`);
  },

  async hemnetRefreshRecent(client, { lastFire }) {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM hemnet_listingv2 WHERE crawled >= $1`, [lastFire]);
    const { n } = r.rows[0];
    return n > 0 ? ok(`${n} listings re-crawled`) : bad('no hemnet_listingv2 rows crawled since the last expected run');
  },

  async booliRefreshRecent(client, { lastFire }) {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM booli_listing WHERE crawled >= $1`, [lastFire]);
    const { n } = r.rows[0];
    return n > 0 ? ok(`${n} listings re-crawled`) : bad('no booli_listing rows crawled since the last expected run');
  },

  // PROXY: booli_listing has no created_at, so we cannot count "new" rows
  // directly. Discovery is the only job running Sun 22:00 (refresh runs 14:00),
  // so crawls inside a 6h window after its fire are attributable to it.
  async booliDiscoveryRecent(client, { lastFire }) {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM booli_listing
        WHERE crawled >= $1 AND crawled < $1 + INTERVAL '6 hours'`, [lastFire]);
    const { n } = r.rows[0];
    return n > 0 ? ok(`${n} listings crawled in the discovery window`)
                 : bad('no booli_listing rows crawled in the 6h discovery window');
  },

  // PROXY: cohort_pairs has no created_at, so match growth is not directly
  // measurable. The match job fetches Hemnet pages, so crawls in a 4h window
  // after its fire stand in for it.
  async hemnetMatchRecent(client, { lastFire }) {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM hemnet_listingv2
        WHERE crawled >= $1 AND crawled < $1 + INTERVAL '4 hours'`, [lastFire]);
    const { n } = r.rows[0];
    return n > 0 ? ok(`${n} listings crawled in the match window`)
                 : bad('no hemnet_listingv2 rows crawled in the 4h match window');
  },

  // cohort-spotcheck-gate — a zero-suspects run is a legitimate outcome that
  // creates no review rows, so accept it when the log says so explicitly.
  async spotcheckGateRan(client, { lastFire }) {
    const r = await client.query(
      `SELECT (SELECT count(*)::int FROM spotcheck_review WHERE created_at >= $1) AS n_reviews,
              (SELECT result_summary FROM cron_job_log
                WHERE script_name = 'cohort-spotcheck-gate' AND started_at >= $1
                  AND status IN ('success','warning') ORDER BY id DESC LIMIT 1) AS summary`, [lastFire]);
    const { n_reviews, summary } = r.rows[0];
    if (n_reviews > 0) return ok(`${n_reviews} review row(s) created`);
    if (summary && Number(summary.uncertain || 0) === 0 && Number(summary.confirmedMismatch || 0) === 0) {
      return ok('explicit zero-suspects result');
    }
    return bad('no spotcheck_review rows and no explicit zero-suspects result');
  },

  // sold-match-batch — parity aware, BOTH directions. On an even ISO week
  // require new rows; across any 3-week span require at least one non-skipped
  // run, so a stuck even-week gate cannot hide as "correctly skipped" forever.
  async soldMatchFortnight(client, { lastFire }) {
    const even = isoWeek(lastFire) % 2 === 0;
    const r = await client.query(
      `SELECT (SELECT count(*)::int FROM sold_match WHERE created_at >= $1) AS n_recent,
              (SELECT count(*)::int FROM cron_job_log
                WHERE script_name = 'sold-match-batch'
                  AND started_at >= NOW() - INTERVAL '21 days'
                  AND status IN ('success','warning')) AS n_runs_3w`, [lastFire]);
    const { n_recent, n_runs_3w } = r.rows[0];
    if (even && n_recent === 0) return bad('even ISO week but no new sold_match rows');
    if (n_runs_3w < 1) return bad('no non-skipped sold-match-batch run in 3 weeks');
    return ok(`${n_recent} new row(s); ${n_runs_3w} run(s) in 3 weeks`);
  },

  // The ad-cost crawler runs on a DIFFERENT droplet and writes no log row here,
  // so a DB assertion is the only possible monitor for it.
  //
  // The window is 40 days, not 8. The scrape moved from weekly to MONTHLY on
  // 2026-08-17 (`0 2 1 * *` UTC, celery-beat on the price droplet). An 8-day window
  // against a monthly job is red for roughly three weeks in every four — a standing
  // false alarm, which is exactly the noise this alerting design exists to escape.
  // 40 days covers a 31-day month plus slack while still catching a genuinely dead
  // crawler within about a week of the month it missed.
  //
  // Completeness is asserted too, not just presence. The 2026-08-02 (42 rows) and
  // 2026-08-09 (35 rows) runs died after the first municipality: rows landed, so a
  // count>0 test passed while the grid was 90% empty. A run is only healthy if it
  // covers all 10 municipalities.
  async adCostMonth(client) {
    const r = await client.query(
      `SELECT (crawled AT TIME ZONE 'UTC')::date AS d,
              count(DISTINCT property_municipality_id)::int AS munis,
              count(DISTINCT (property_municipality_id, property_price, ad_type))::int AS cells
         FROM hemnet_adcostv2
        WHERE crawled >= NOW() - INTERVAL '40 days'
        GROUP BY 1 ORDER BY 1 DESC`);
    if (!r.rows.length) {
      return bad('no hemnet_adcostv2 rows in 40 days — the crawler droplet may be down');
    }
    const complete = r.rows.find(x => x.munis === 10 && x.cells === 420);
    if (!complete) {
      const t = r.rows[0];
      return bad(`no complete grid in 40 days — newest run ${t.d.toISOString ? t.d.toISOString().slice(0, 10) : t.d} `
        + `covered ${t.munis}/10 municipalities, ${t.cells}/420 cells`);
    }
    const d = complete.d.toISOString ? complete.d.toISOString().slice(0, 10) : String(complete.d);
    return ok(`complete grid ${d} (420/420 cells, 10 munis)`);
  },
};

// shouldEvaluate(rec, { lastFire, now, lastRow })
// Four skip rules, each preventing a specific false alarm.
function shouldEvaluate(rec, { lastFire, now, lastRow }) {
  if (!rec.assert) return { evaluate: false, reason: 'no assertion' };
  if (!lastFire) return { evaluate: false, reason: 'no expected fire yet' };

  // 1. Deployed but not yet due. age_census_run is EMPTY today and first fires
  //    2026-09-01; without this the assertion is red from the moment it ships,
  //    which is the standing-noise failure this design exists to avoid.
  if (rec.notBefore && now.toISOString().slice(0, 10) < rec.notBefore) {
    return { evaluate: false, reason: `deployed, not yet due (${rec.notBefore})` };
  }

  const budgetMs = (rec.expectedDurationMin || 15) * 60 * 1000;

  // 2. In flight inside its duration budget — the spec's acceptance case: a
  //    digest on the 1st with the age census mid-run must raise no issue.
  //    Bounded by the budget so a genuine orphan cannot hide here forever.
  if (lastRow && lastRow.status === 'running') {
    const age = now - new Date(lastRow.started_at);
    if (age <= budgetMs) return { evaluate: false, reason: 'in flight' };
  }

  // 3. Too soon: a 3h job has not failed 5 minutes after it started.
  if (now - lastFire < budgetMs + GRACE_MIN * 60 * 1000) {
    return { evaluate: false, reason: 'too soon after the expected fire' };
  }

  return { evaluate: true };
}

// runAssertions(client, jobs, { now, rows }) — rows are recent cron_job_log
// rows, newest first, used to find each job's latest row.
async function runAssertions(client, jobs, { now, rows = [] }) {
  const results = [];
  for (const [job, rec] of Object.entries(jobs)) {
    if (rec.tier !== 1) continue;
    if (!rec.cron && !rec.external) continue;
    // An external job (the ad-cost crawler, on another droplet) has no cron here
    // and writes no log row, so the cron-timing skip rules cannot apply. Its
    // assertion is self-contained over a rolling window.
    const lastFire = rec.cron ? lastExpectedFire(rec.cron, now) : null;
    const lastRow = rows.find(r => r.script_name === job) || null;
    const decision = rec.external
      ? (rec.notBefore && now.toISOString().slice(0, 10) < rec.notBefore
          ? { evaluate: false, reason: `deployed, not yet due (${rec.notBefore})` }
          : { evaluate: true })
      : shouldEvaluate(rec, { lastFire, now, lastRow });
    if (!decision.evaluate) {
      results.push({ job, ok: true, skipped: true, reason: decision.reason, detail: decision.reason });
      continue;
    }
    const fn = ASSERTIONS[rec.assert];
    if (!fn) {
      results.push({ job, ok: false, skipped: false, detail: `assertion "${rec.assert}" is not defined` });
      continue;
    }
    try {
      const res = await fn(client, { lastFire, now });
      results.push({ job, ok: res.ok, skipped: false, detail: res.detail, lastFire });
    } catch (err) {
      // A broken assertion must never take the whole digest down with it.
      results.push({ job, ok: false, skipped: false, detail: `assertion errored: ${err.message}` });
    }
  }
  return results;
}

module.exports = { ASSERTIONS, shouldEvaluate, runAssertions, isoWeek, GRACE_MIN };

// ---------------------------------------------------------------
//   node lib/job-assertions.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { ASSERTIONS, shouldEvaluate, runAssertions } = module.exports;
  const { JOBS } = require('./job-registry');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };
  const checkA = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  check('every tier-1 job names an assertion that exists', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.tier !== 1) continue;
      assert.ok(rec.assert, `tier-1 job ${job} has no assert name`);
      assert.strictEqual(typeof ASSERTIONS[rec.assert], 'function',
        `${job} names assertion "${rec.assert}" which does not exist`);
    }
  });

  check('no tier-2 job carries an assertion — tier 2 is digest-only', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.tier === 2) assert.ok(!rec.assert, `${job} is tier 2 but names an assertion`);
    }
  });

  const now = new Date('2026-09-01T03:00:00Z');

  check('skip: a job deployed but not yet due', () => {
    const rec = { assert: 'ageCensusMonth', notBefore: '2026-09-02', expectedDurationMin: 240 };
    const r = shouldEvaluate(rec, { lastFire: new Date('2026-09-01T02:00:00Z'), now, lastRow: null });
    assert.strictEqual(r.evaluate, false);
    assert.match(r.reason, /not yet due/i);
  });

  // The acceptance case from the spec: a full digest on the 1st of a month with
  // the age census MID-FLIGHT must raise no issue.
  check('skip: a job still running inside its duration budget', () => {
    const rec = { assert: 'ageCensusMonth', expectedDurationMin: 240 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-09-01T02:00:00Z'), now,
      lastRow: { status: 'running', started_at: '2026-09-01T02:00:00Z' },
    });
    assert.strictEqual(r.evaluate, false);
    assert.match(r.reason, /in flight/i);
  });

  // Isolates the in-flight rule from the too-soon rule: budget 30min means the
  // 60min since lastFire clears the too-soon threshold (30+15), so the only
  // thing that could skip here is the stale `running` row — and it must not.
  check('evaluate: a job whose running row has blown its budget is NOT skipped', () => {
    const rec = { assert: 'ageCensusMonth', expectedDurationMin: 30 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-09-01T02:00:00Z'), now,
      lastRow: { status: 'running', started_at: '2026-08-31T02:00:00Z' },
    });
    assert.strictEqual(r.evaluate, true, 'an orphan must not hide behind "in flight" forever');
  });

  check('skip: too soon after the expected fire', () => {
    const rec = { assert: 'marketTotalsDay', expectedDurationMin: 10 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-09-01T02:55:00Z'), now, lastRow: null,
    });
    assert.strictEqual(r.evaluate, false);
    assert.match(r.reason, /too soon/i);
  });

  check('evaluate: well after the expected fire with a finished row', () => {
    const rec = { assert: 'marketTotalsDay', expectedDurationMin: 10 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-08-31T08:30:00Z'), now,
      lastRow: { status: 'success', started_at: '2026-08-31T08:30:00Z' },
    });
    assert.strictEqual(r.evaluate, true);
  });

  check('every assertion is phrased against lastFire, never a calendar period', () => {
    const fs = require('fs');
    const src = fs.readFileSync(__filename, 'utf8');
    const body = src.slice(src.indexOf('const ASSERTIONS'), src.indexOf('function shouldEvaluate'))
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))   // prose may DISCUSS the trap; SQL may not use it
      .join('\n');
    assert.ok(!/CURRENT_DATE|NOW\(\)::date|date_trunc\('week', *NOW/i.test(body),
      'an assertion is phrased against a calendar period — that fails every day at 03:00');
  });

  (async () => {
    await checkA('runAssertions skips tier-2 jobs entirely', async () => {
      const fakeClient = { query: async () => { throw new Error('no assertion should query here'); } };
      const res = await runAssertions(fakeClient, {
        'sold-match-report': { tier: 2, cron: '0 11 * * 1', expectedDurationMin: 15 },
      }, { now, rows: [] });
      assert.deepStrictEqual(res, [], 'tier 2 is digest-only; it has no assertion');
    });

    await checkA('a failing assertion is reported, not thrown', async () => {
      const fakeClient = { query: async () => ({ rows: [{ n_rows: 3, n_changed: 1, n_prior: 4 }] }) };
      const res = await runAssertions(fakeClient, {
        'market-totals-daily': {
          tier: 1, cron: '30 8 * * *', expectedDurationMin: 10, assert: 'marketTotalsDay',
        },
      }, { now, rows: [] });
      assert.strictEqual(res.length, 1);
      assert.strictEqual(res[0].ok, false, '3 of 4 rows must be caught');
      assert.match(res[0].detail, /3\/4/);
    });

    await checkA('a throwing assertion becomes a failure, never an unhandled rejection', async () => {
      const fakeClient = { query: async () => { throw new Error('relation does not exist'); } };
      const res = await runAssertions(fakeClient, {
        'market-totals-daily': {
          tier: 1, cron: '30 8 * * *', expectedDurationMin: 10, assert: 'marketTotalsDay',
        },
      }, { now, rows: [] });
      assert.strictEqual(res[0].ok, false);
      assert.match(res[0].detail, /relation does not exist/);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
