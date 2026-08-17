require('dotenv').config();
const { createClient } = require('./db');
const { postMessage } = require('./lib/slack-post');
const { runReporter } = require('./cron-wrapper');
const { JOBS } = require('./lib/job-registry');
const { runAssertions } = require('./lib/job-assertions');
const { buildLiveness } = require('./lib/job-liveness');

// FETCH_DAYS must cover the longest gap between two fires of any registered job.
// The monthly age census is the widest at 31 days, so a shorter window would put
// a healthy monthly job's last run outside this query and read it as "never ran".
const FETCH_DAYS = 34;

// The liveness check — "did it fire at all?" — used to live here behind a
// hardcoded SCRIPTS = ['cohort-track','cohort-create','age-census-monthly'] and a
// frequency-keyed WINDOW_HOURS map. It now lives in lib/job-liveness.js and is
// derived from lib/job-registry.js, so all ~21 scheduled Node jobs are covered
// rather than 3. The two false alarms the WINDOW_HOURS map existed to fix (weekly
// `cohort-create` warning on the six non-Mondays; every-2-days `cohort-track`
// warning on alternate days because its last run was ~29h old at the 03:00 check)
// are pinned as smoke checks there, phrased against lastExpectedFire instead of a
// lookback window. `notBefore` moved to the registry entry.

function summarizeResult(scriptName, summary) {
  if (!summary) return '';
  switch (scriptName) {
    case 'cohort-track': {
      let s = `tracked=${summary.totalTracked || 0} cohorts=${summary.cohortsTracked || 0}`;
      if (summary.totalNullBooli || summary.totalNullHemnet) {
        s += ` null_b=${summary.totalNullBooli || 0} null_h=${summary.totalNullHemnet || 0}`;
      }
      return s;
    }
    case 'cohort-create':
      if (summary.skipped) return `skipped (${summary.cohortId} exists)`;
      return `${summary.cohortId} matched=${summary.matched || 0} rate=${summary.matchRate || '-'}`;
    case 'age-census-monthly': {
      // Summary shape from scripts/age-census-monthly.js: { runDate, pools:[{platform,
      // pool, status, nTotal}], persisted, failed:[key], gateFailed:[key] }.
      const persisted = summary.persisted != null ? summary.persisted : '?';
      let s = `${persisted}/4 pools persisted`;
      if (summary.gateFailed && summary.gateFailed.length) s += ` gate_failed=${summary.gateFailed.join(',')}`;
      if (summary.failed && summary.failed.length) s += ` failed=${summary.failed.join(',')}`;
      return s;
    }
    default:
      return '';
  }
}

async function run() {
  const client = createClient();
  await client.connect();

  const rows = await client.query(`
    SELECT script_name, started_at, duration_ms, status, error_message, result_summary
    FROM cron_job_log
    WHERE started_at >= NOW() - INTERVAL '1 day' * $1
    ORDER BY started_at DESC
  `, [FETCH_DAYS]);

  const now = new Date();

  // ---------------------------------------------------------------
  // LIVENESS (Phase 3.1) — "did it fire at all?"
  //
  // The one question event-driven alerting structurally cannot answer: a job
  // that never started never reached cron-wrapper, so nothing alerted. Derived
  // from the registry, so adding a job monitors it. See lib/job-liveness.js for
  // the anchoring rules and the false alarms they exist to prevent.
  // ---------------------------------------------------------------
  const liveness = buildLiveness(JOBS, { now, rows: rows.rows, summarize: summarizeResult });
  const issues = [...liveness.issues];
  const lines = [':satellite_antenna:  *Liveness* (did each scheduled job fire?)', ...liveness.lines];

  // cohort-track anomaly: a run can succeed having tracked nothing at all, which
  // no liveness or status check can see — it is a result-shape fault.
  const trackRow = liveness.results.find(r => r.job === 'cohort-track');
  const trackSummary = trackRow && trackRow.lastRow && trackRow.lastRow.result_summary;
  if (trackSummary && trackSummary.totalTracked === 0 && trackSummary.cohortsTracked > 0) {
    issues.push(`cohort-track: 0 pairs tracked with ${trackSummary.cohortsTracked} active cohorts`);
  }

  // ---------------------------------------------------------------
  // ASSERTIONS (Phase 3) — "did the work actually produce output?"
  //
  // Exit code 0 is not evidence of work done. Each tier-1 job asserts on its own
  // output, evaluated against last_expected_fire + grace — NEVER against a
  // calendar period, because this digest runs at 03:00 and most jobs fire later.
  // Jobs in flight inside their duration budget are skipped, not failed.
  // ---------------------------------------------------------------
  const assertions = await runAssertions(client, JOBS, { now, rows: rows.rows });
  if (assertions.length > 0) {
    lines.push('');
    lines.push(':dart:  *Assertions* (tier 1 — did the data actually arrive?)');
    for (const a of assertions) {
      if (a.skipped) {
        lines.push(`      :heavy_minus_sign: ${a.job} — skipped: ${a.reason}`);
        continue;
      }
      lines.push(`      ${a.ok ? ':white_check_mark:' : ':x:'} ${a.job} — ${a.detail}`);
      if (!a.ok) issues.push(`${a.job} assertion FAILED: ${a.detail}`);
    }
  }

  // ---------------------------------------------------------------
  // CROSS-CUTTING CHECKS — these belong to NO single job and must keep an
  // explicit slot here. A registry-shaped rewrite that iterates jobs would
  // otherwise drop them as "not registry-shaped", and they are the only
  // detectors for their respective failures:
  //   * zero-growth  — the only detector for a SUCCESSFUL but degraded scrape
  //   * newest-cohort canary — the fix for the age-decay false alarms; its
  //     comment records the measured decay curve and why a flat all-cohort
  //     threshold was wrong. Losing that comment re-introduces the bug.
  // ---------------------------------------------------------------

  // Check cohort view growth — flag if most pairs had zero incremental views
  const growthRes = await client.query(`
    WITH latest_two AS (
      SELECT dv.pair_id, dv.date, dv.booli_views, dv.hemnet_views,
             ROW_NUMBER() OVER (PARTITION BY dv.pair_id ORDER BY dv.date DESC) AS rn
      FROM cohort_daily_views dv
      JOIN cohort_pairs cp ON cp.id = dv.pair_id
      JOIN cohorts c ON c.cohort_id = cp.cohort_id
      WHERE c.week_start >= CURRENT_DATE - INTERVAL '63 days'
        AND cp.removed_at IS NULL
        AND dv.booli_views IS NOT NULL
        AND dv.hemnet_views IS NOT NULL
    )
    SELECT
      COUNT(*) AS total_pairs,
      COUNT(*) FILTER (
        WHERE curr.booli_views = prev.booli_views
          AND curr.hemnet_views = prev.hemnet_views
      ) AS zero_growth_pairs
    FROM latest_two curr
    JOIN latest_two prev ON prev.pair_id = curr.pair_id AND prev.rn = 2
    WHERE curr.rn = 1
      AND curr.date - prev.date = 1
  `);

  if (growthRes.rows.length > 0 && growthRes.rows[0].total_pairs > 0) {
    const { total_pairs, zero_growth_pairs } = growthRes.rows[0];
    const zeroPct = Math.round((zero_growth_pairs / total_pairs) * 100);
    lines.push('');
    lines.push(`:bar_chart:  *View Growth Check*  —  ${zero_growth_pairs}/${total_pairs} pairs (${zeroPct}%) had zero growth`);
    if (zeroPct >= 80) {
      issues.push(`Stale view data: ${zeroPct}% of pairs had zero incremental views — scrapers may be down`);
    }
  }

  // Check per-cohort null view rates
  const nullViewRes = await client.query(`
    SELECT
      cp.cohort_id,
      COUNT(*) AS total_pairs,
      COUNT(*) FILTER (WHERE hemnet_views IS NULL) AS null_hemnet,
      COUNT(*) FILTER (WHERE booli_views IS NULL) AS null_booli
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    JOIN cohorts c ON c.cohort_id = cp.cohort_id
    WHERE c.week_start >= CURRENT_DATE - INTERVAL '63 days'
      AND cp.removed_at IS NULL
      AND dv.date = (SELECT MAX(date) FROM cohort_daily_views)
    GROUP BY cp.cohort_id
    ORDER BY cp.cohort_id
  `);

  if (nullViewRes.rows.length > 0) {
    lines.push('');
    lines.push(`:mag:  *View Data Quality* (latest data)`);
    const lastIdx = nullViewRes.rows.length - 1;
    for (let i = 0; i < nullViewRes.rows.length; i++) {
      const r = nullViewRes.rows[i];
      const bPct = Math.round((r.null_booli / r.total_pairs) * 100);
      const hPct = Math.round((r.null_hemnet / r.total_pairs) * 100);
      const canary = (i === lastIdx) ? '  ← canary' : '';
      // No per-cohort warning marker and no issue is raised off these rows. A high null
      // rate on an OLD cohort is not a fault: a null means the listing had no active row
      // when cohort-track asked, i.e. the ad is gone — sold, withdrawn or expired. Cohorts
      // therefore decay monotonically with age (measured 2026-08-17: 7% at 14d, 25% at 21d,
      // 33% at 28d, 41% at 42d, 52% at 56d, 64% at 63d), so ANY flat threshold is crossed by
      // every cohort eventually and the alert never stops. cohort-track.js already settled
      // this — see its "10-03 retarget" (line ~292), which scopes null-view alerting to the
      // most recent 4 cohorts and additionally requires a >10pp jump vs the same cohort's
      // previous run. This block used to re-implement the check with neither refinement,
      // and so re-fired exactly the alarms that retarget existed to silence.
      //
      // Two further reasons the numbers here were not trustworthy as an alert: the query
      // filters on `removed_at IS NULL`, but removed_at is set on only 5 of ~5,200 pairs —
      // the real liveness flags are dropped_booli_on/dropped_hemnet_on, which it ignores;
      // and for cohorts past the 56d tracking window the denominator is a straggler tail
      // (W25 showed n=55 against 672 real pairs).
      //
      // The rows stay — they are useful context, and the canary check below is the live
      // detector: the NEWEST cohort's listings are still on the market, so a high null rate
      // there is a genuine scraper signal rather than market decay.
      lines.push(`      ${r.cohort_id}: ${r.null_booli}/${r.total_pairs} null Booli (${bPct}%), ${r.null_hemnet}/${r.total_pairs} null Hemnet (${hPct}%)${canary}`);
    }

    // Canary check: newest cohort should have low null rates
    const newest = nullViewRes.rows[lastIdx];
    const newestBPct = Math.round((newest.null_booli / newest.total_pairs) * 100);
    const newestHPct = Math.round((newest.null_hemnet / newest.total_pairs) * 100);
    if (newestBPct > 30) issues.push(`Newest cohort ${newest.cohort_id}: ${newestBPct}% null Booli views — scraper may be down`);
    if (newestHPct > 30) issues.push(`Newest cohort ${newest.cohort_id}: ${newestHPct}% null Hemnet views — scraper may be down`);
  }

  await client.end();

  // Build Slack message
  const today = now.toISOString().slice(0, 10);
  const overall = issues.length === 0 ? ':white_check_mark: All healthy' : `:warning: ${issues.length} issue(s)`;

  let message = `*Hemnet Monitor — Daily Health Report*\n${today}  |  ${overall}\n\n${lines.join('\n')}`;

  if (issues.length > 0) {
    message += '\n\n*Issues:*\n' + issues.map(i => `• ${i}`).join('\n');
  }

  // The health monitor must never report success it did not deliver. postMessage
  // RETURNS {ok:false} on a failed delivery rather than throwing, and this script is
  // NOT wrapped by cron-wrapper.runJob — so without this branch a monitor that could
  // not reach Slack still exits 0 printing "All healthy", which is precisely the blind
  // spot it exists to close. The exit code is the only signal available here.
  const result = await postMessage('cron-health-slack', message);
  const summary = issues.length === 0 ? 'All healthy' : `${issues.length} issue(s) flagged`;
  if (result.dryRun) {
    console.log(`${summary} (dry run — not posted)`);
  } else if (result.ok) {
    console.log(summary);
  } else {
    console.error(`${summary} — but the Slack post FAILED on both the bot and the webhook fallback`);
    process.exitCode = 1;
  }
}

// Entry gate. Without this, an unrecognised flag falls straight through to the
// live path and POSTS: dotenv re-injects the token, so unsetting env vars does
// not prevent a post. Same pattern as age-census-report.js. Folds in the
// --dry-run -> SLACK_DRY_RUN mapping that used to run at module load, unguarded
// by require.main (so requiring this file for tests would set it as a side effect).
const ACCEPTED_ARGV = new Set(['--dry-run']);
const USAGE = 'Usage: node cron-health-slack.js [--dry-run]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  }
  if (argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';
  runReporter({ scriptName: 'cron-health-slack', run });
}
