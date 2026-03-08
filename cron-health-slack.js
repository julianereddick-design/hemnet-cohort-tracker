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
    case 'cohort-track':
      return `tracked=${summary.totalTracked || 0} cohorts=${summary.cohortsTracked || 0}`;
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
