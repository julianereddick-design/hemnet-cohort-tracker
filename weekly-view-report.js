require('dotenv').config();
const { execSync } = require('child_process');
const { createClient } = require('./db');
const { postMessage } = require('./lib/slack-post');

const MIN_DAYS = 5; // cohorts need at least 5 days of data for meaningful charts
const SKIP_COHORTS = ['2026-W09', '2026-W10', '2026-W11']; // low data quality

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
    WHERE cp.removed_at IS NULL
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
  const serverPort = process.env.VIEW_SERVER_PORT || 3800;
  const serverHost = process.env.VIEW_SERVER_HOST;

  if (serverHost) {
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

    // postMessage RETURNS {ok:false} on a failed delivery — it does not throw — so the
    // catch below never sees a transport failure. Branch on result.ok or a lost report
    // is logged as "sent". This script is not wrapped by cron-wrapper.runJob, so the
    // exit code is the only signal that anything went wrong.
    try {
      const result = await postMessage('weekly-view-report', message);
      if (result.dryRun) {
        console.log('Dry run — no Slack notification sent');
      } else if (result.ok) {
        console.log('Slack notification sent');
      } else {
        console.error('Slack post failed on both the bot and the webhook fallback');
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`Slack failed: ${err.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log('Skipping Slack (VIEW_SERVER_HOST not set)');
  }

  console.log('\nDone.');
}

// Entry gate. Without this, an unrecognised flag falls straight through to the
// live path and POSTS: dotenv re-injects the token, so unsetting env vars does
// not prevent a post. Same pattern as age-census-report.js.
const ACCEPTED_ARGV = new Set(['--dry-run']);
const USAGE = 'Usage: node weekly-view-report.js [--dry-run]';

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
