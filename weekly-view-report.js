require('dotenv').config();
const { execSync } = require('child_process');
const https = require('https');
const { createClient } = require('./db');

const MIN_DAYS = 5; // cohorts need at least 5 days of data for meaningful charts
const SKIP_COHORTS = ['2026-W09', '2026-W10', '2026-W11']; // low data quality

async function sendSlack(webhookUrl, message) {
  const payload = JSON.stringify({ text: message });
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
  const today = new Date().toISOString().slice(0, 10);
  console.log(`=== Weekly View Report — ${today} ===\n`);

  // 1. Find all cohorts with enough data
  const client = createClient();
  await client.connect();

  const res = await client.query(`
    SELECT cp.cohort_id,
           COUNT(DISTINCT cdv.date) AS days_tracked,
           COUNT(*) FILTER (WHERE cp.dropped_booli_on IS NULL OR cp.dropped_hemnet_on IS NULL) AS active_pairs
    FROM cohort_pairs cp
    JOIN cohort_daily_views cdv ON cdv.pair_id = cp.id
    GROUP BY cp.cohort_id
    HAVING COUNT(DISTINCT cdv.date) >= $1
    ORDER BY cp.cohort_id
  `, [MIN_DAYS]);

  await client.end();

  const cohorts = res.rows.filter(c => !SKIP_COHORTS.includes(c.cohort_id));
  console.log(`Found ${cohorts.length} cohorts with >= ${MIN_DAYS} days of data:`);
  for (const c of cohorts) {
    console.log(`  ${c.cohort_id}: ${c.days_tracked} days, ${c.active_pairs} active pairs`);
  }
  console.log('');

  // 2. Export xlsx for each cohort
  const exportedCohorts = [];
  for (const c of cohorts) {
    console.log(`Exporting ${c.cohort_id}...`);
    try {
      const output = execSync(
        `node export-hb-ratio-xlsx.js --cohort ${c.cohort_id}`,
        { cwd: __dirname, timeout: 300000, encoding: 'utf8' }
      );
      console.log(output);
      exportedCohorts.push(c.cohort_id);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  if (exportedCohorts.length === 0) {
    console.error('No cohorts exported successfully');
    process.exit(1);
  }

  // 3. Run cross-cohort chart
  console.log('Generating cross-cohort chart...');
  try {
    const output = execSync(
      `node export-cross-cohort-chart.js --date ${today}`,
      { cwd: __dirname, timeout: 300000, encoding: 'utf8' }
    );
    console.log(output);
  } catch (err) {
    console.error(`Cross-cohort chart failed: ${err.message}`);
  }

  // 4. Slack notification
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const serverPort = process.env.VIEW_SERVER_PORT || 3800;
  const serverHost = process.env.VIEW_SERVER_HOST;

  if (webhookUrl && serverHost) {
    const chartUrl = `http://${serverHost}:${serverPort}/view-data/${today}/cross-cohort-hpct.html`;
    const cohortLinks = exportedCohorts.map(id =>
      `<http://${serverHost}:${serverPort}/view-data/${today}/${id}/charts.html|${id}>`
    ).join('  ');

    const message = [
      `:bar_chart: *Weekly Cohort View Report — ${today}*`,
      `Cohorts: ${exportedCohorts.join(', ')}`,
      ``,
      `<${chartUrl}|:chart_with_upwards_trend: Cross-Cohort H% Chart>`,
      `Per-cohort charts: ${cohortLinks}`,
    ].join('\n');

    try {
      await sendSlack(webhookUrl, message);
      console.log('Slack notification sent');
    } catch (err) {
      console.error(`Slack failed: ${err.message}`);
    }
  } else {
    if (!webhookUrl) console.log('Skipping Slack (SLACK_WEBHOOK_URL not set)');
    if (!serverHost) console.log('Skipping Slack (VIEW_SERVER_HOST not set)');
  }

  console.log('\nDone.');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
