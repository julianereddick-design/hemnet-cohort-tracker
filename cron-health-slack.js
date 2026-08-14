require('dotenv').config();
const { createClient } = require('./db');
const { postMessage } = require('./lib/slack-post');

const SCRIPTS = ['cohort-track', 'cohort-create', 'age-census-monthly'];

// Each frequency carries its own lookback window, sized to the job's real cadence
// plus a grace margin. Before 2026-08-13 every script was judged against a flat 25h
// window, which produced two standing false alarms: weekly `cohort-create` warned on
// the 6 non-Mondays, and every-2-days `cohort-track` (22:00 UTC on odd days) warned
// on alternate days because its last run was ~29h old when the 03:00 check ran.
//
// `monthly` (added 2026-08-14 for age-census-monthly, which fires 02:00 on the 1st):
// the longest real gap between runs is 31 days, so the window is 33 days — long enough
// that a healthy job is never flagged on the 31st, short enough that a job which stopped
// firing is caught within ~2 days of its missed slot.
const WINDOW_HOURS = { daily: 25, every2days: 50, weekly: 8 * 24, monthly: 33 * 24 };

// FETCH_DAYS must cover the widest window above, or a monthly job's last run falls
// outside the single query below and reads as "never ran".
const FETCH_DAYS = 34;

const EXPECTED = {
  'cohort-track': { frequency: 'every2days', label: 'Every 2 days' },
  'cohort-create': { frequency: 'weekly', label: 'Weekly (Mon)' },
  // `notBefore`: the job is deployed but has never run — its first fire is 02:00 UTC on
  // 2026-09-01 (~3h). Until the day after that, "no runs" is expected, not a fault, so
  // it renders as pending and raises no issue. Delete the key once it has run once.
  'age-census-monthly': { frequency: 'monthly', label: 'Monthly (1st)', notBefore: '2026-09-02' },
};

function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ts) {
  if (!ts) return '-';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

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

  // Widest window is fetched once; each script is then judged against its own
  // frequency window (daily 25h, weekly 8d) so weekly jobs don't false-alarm.
  const cutoff = (frequency) => Date.now() - WINDOW_HOURS[frequency] * 3600 * 1000;

  const byScript = {};
  for (const s of SCRIPTS) byScript[s] = [];
  for (const r of rows.rows) {
    if (!byScript[r.script_name]) continue;
    const spec = EXPECTED[r.script_name];
    if (new Date(r.started_at).getTime() >= cutoff(spec.frequency)) {
      byScript[r.script_name].push(r);
    }
  }

  const issues = [];
  const lines = [];

  for (const scriptName of SCRIPTS) {
    const runs = byScript[scriptName];
    const spec = EXPECTED[scriptName];

    const windowLabel = `last ${WINDOW_HOURS[spec.frequency]}h`;

    if (runs.length === 0) {
      // A job that is deployed but not yet due (see EXPECTED.notBefore) is pending, not
      // broken — flagging it daily until its first fire would train the reader to ignore
      // this report, which is the one failure mode a monitor cannot afford.
      if (spec.notBefore && new Date().toISOString().slice(0, 10) < spec.notBefore) {
        lines.push(`:hourglass_flowing_sand:  *${scriptName}* (${spec.label})  —  deployed, first run due ${spec.notBefore}`);
        continue;
      }
      lines.push(`*${scriptName}* (${spec.label})  —  :warning: No runs in ${windowLabel}`);
      issues.push(`No runs for ${scriptName} in ${windowLabel}`);
      continue;
    }

    const latest = runs[0];
    const icon = latest.status === 'success' ? ':white_check_mark:' :
                 latest.status === 'warning' ? ':warning:' : ':x:';
    const result = summarizeResult(scriptName, latest.result_summary);
    const successCount = runs.filter(r => r.status === 'success').length;
    const failCount = runs.filter(r => r.status === 'failure').length;

    let statusLine = `${successCount}/${runs.length} succeeded`;
    if (failCount > 0) statusLine += `, ${failCount} failed`;

    lines.push(`${icon}  *${scriptName}* (${spec.label})  —  ${statusLine}`);
    lines.push(`      Last: ${formatTimestamp(latest.started_at)}  ${formatDuration(latest.duration_ms)}  ${result}`);

    if (latest.status === 'failure') {
      issues.push(`${scriptName} last run FAILED: ${latest.error_message}`);
    }
    if (latest.status === 'warning') {
      issues.push(`${scriptName} last run WARNING: ${latest.error_message}`);
    }

    // Check each script ran at least once successfully inside its own window
    const hasSuccess = runs.some(r => r.status === 'success');
    if (!hasSuccess) issues.push(`${scriptName}: no successful run in ${windowLabel}`);

    // Check cohort-track result anomalies
    if (scriptName === 'cohort-track') {
      const lastSuccess = runs.find(r => r.status === 'success' && r.result_summary);
      if (lastSuccess && lastSuccess.result_summary.totalTracked === 0 && lastSuccess.result_summary.cohortsTracked > 0) {
        issues.push(`cohort-track: 0 pairs tracked with ${lastSuccess.result_summary.cohortsTracked} active cohorts`);
      }
    }
  }

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
      const warn = (bPct > 50 || hPct > 50) ? '  :warning:' : '';
      const canary = (i === lastIdx) ? '  ← canary' : '';
      lines.push(`      ${r.cohort_id}: ${r.null_booli}/${r.total_pairs} null Booli (${bPct}%), ${r.null_hemnet}/${r.total_pairs} null Hemnet (${hPct}%)${warn}${canary}`);

      if (bPct > 50) issues.push(`Cohort ${r.cohort_id}: ${bPct}% null Booli views`);
      if (hPct > 50) issues.push(`Cohort ${r.cohort_id}: ${hPct}% null Hemnet views`);
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
  const now = new Date().toISOString().slice(0, 10);
  const overall = issues.length === 0 ? ':white_check_mark: All healthy' : `:warning: ${issues.length} issue(s)`;

  let message = `*Hemnet Monitor — Daily Health Report*\n${now}  |  ${overall}\n\n${lines.join('\n')}`;

  if (issues.length > 0) {
    message += '\n\n*Issues:*\n' + issues.map(i => `• ${i}`).join('\n');
  }

  await postMessage('cron-health-slack', message);
  console.log(issues.length === 0 ? 'All healthy' : `${issues.length} issue(s) flagged`);
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
  run().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
