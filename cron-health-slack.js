require('dotenv').config();
const https = require('https');
const { createClient } = require('./db');

const SCRIPTS = ['cohort-track', 'cohort-create', 'sfpl-region-snapshot'];

const EXPECTED = {
  'cohort-track': { frequency: 'daily', label: 'Daily' },
  'cohort-create': { frequency: 'weekly', label: 'Weekly (Mon)' },
  'sfpl-region-snapshot': { frequency: 'daily', label: 'Daily' },
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
    case 'sfpl-region-snapshot':
      return `rows=${summary.rowCount || 0}`;
    default:
      return '';
  }
}

async function sendSlack(webhookUrl, blocks) {
  const payload = JSON.stringify(blocks);
  const parsed = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Slack ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Slack timeout')); });
    req.write(payload);
    req.end();
  });
}

async function run() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('SLACK_WEBHOOK_URL not set in .env');
    process.exit(1);
  }

  const client = createClient();
  await client.connect();

  const rows = await client.query(`
    SELECT script_name, started_at, duration_ms, status, error_message, result_summary
    FROM cron_job_log
    WHERE started_at >= NOW() - INTERVAL '25 hours'
    ORDER BY started_at DESC
  `);

  const byScript = {};
  for (const s of SCRIPTS) byScript[s] = [];
  for (const r of rows.rows) {
    if (byScript[r.script_name]) byScript[r.script_name].push(r);
  }

  const issues = [];
  const lines = [];

  for (const scriptName of SCRIPTS) {
    const runs = byScript[scriptName];
    const spec = EXPECTED[scriptName];

    if (runs.length === 0) {
      lines.push(`*${scriptName}* (${spec.label})  —  :warning: No runs in last 24h`);
      issues.push(`No runs for ${scriptName}`);
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

    // Check daily scripts ran at least once successfully
    if (spec.frequency === 'daily') {
      const hasSuccess = runs.some(r => r.status === 'success');
      if (!hasSuccess) issues.push(`${scriptName}: no successful run in last 24h`);
    }

    // Check cohort-track result anomalies
    if (scriptName === 'cohort-track') {
      const lastSuccess = runs.find(r => r.status === 'success' && r.result_summary);
      if (lastSuccess && lastSuccess.result_summary.totalTracked === 0 && lastSuccess.result_summary.cohortsTracked > 0) {
        issues.push(`cohort-track: 0 pairs tracked with ${lastSuccess.result_summary.cohortsTracked} active cohorts`);
      }
    }

    // Check sfpl row count
    if (scriptName === 'sfpl-region-snapshot') {
      const lastSuccess = runs.find(r => r.status === 'success' && r.result_summary);
      if (lastSuccess && lastSuccess.result_summary.rowCount !== 18) {
        issues.push(`sfpl-region-snapshot: ${lastSuccess.result_summary.rowCount} rows (expected 18)`);
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
      WHERE c.week_start >= CURRENT_DATE - INTERVAL '44 days'
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
    WHERE c.week_start >= CURRENT_DATE - INTERVAL '44 days'
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
      const warn = (bPct > 95 || hPct > 95) ? '  :warning:' : '';
      const canary = (i === lastIdx) ? '  ← canary' : '';
      lines.push(`      ${r.cohort_id}: ${r.null_booli}/${r.total_pairs} null Booli (${bPct}%), ${r.null_hemnet}/${r.total_pairs} null Hemnet (${hPct}%)${warn}${canary}`);

      if (bPct > 95) issues.push(`Cohort ${r.cohort_id}: ${bPct}% null Booli views`);
      if (hPct > 95) issues.push(`Cohort ${r.cohort_id}: ${hPct}% null Hemnet views`);
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

  await sendSlack(webhookUrl, { text: message });
  console.log('Health report sent to Slack');
  console.log(issues.length === 0 ? 'All healthy' : `${issues.length} issue(s) flagged`);
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
