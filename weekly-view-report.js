require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createClient } = require('./db');
const { postMessage } = require('./lib/slack-post');
const { runReporter } = require('./cron-wrapper');

// --dry-run renders the post instead of sending it, as docs/handover/04 §1 promises for
// every reporter. Until 2026-11-03 this script ignored the flag and posted for real.
if (process.argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';

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

  const serverPort = process.env.VIEW_SERVER_PORT || 3800;
  const serverHost = process.env.VIEW_SERVER_HOST;

  // 3b. Like-for-like views (lib/views-like-for-like.js): ALWAYS the CSV and the workbook
  // in the pack AND the block in the Slack post — the scorecard bot reads the CSV or the
  // post; people check numbers in the workbook. A failure here is reported in the post
  // rather than stopping the rest of the report.
  let lflBlock;
  try {
    const lfl = require('./lib/views-like-for-like');
    const c = createClient();
    await c.connect();
    let weekly, intervals;
    try {
      const { pairs, readings } = await lfl.loadInputs(c);
      weekly = lfl.computeWeekly(pairs, readings, { before: today });
      ({ intervals } = lfl.classifyIntervals(pairs, readings, { before: today }));
    } finally {
      await c.end();
    }
    const dir = path.join(__dirname, 'view-data', today);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'views-like-for-like.csv'), lfl.toCsv(weekly), 'utf8');
    await lfl.writeWorkbook(path.join(dir, 'views-like-for-like.xlsx'), weekly, intervals);
    console.log(`Like-for-like views: ${dir}/views-like-for-like.{csv,xlsx} (${weekly.length} weeks, ${intervals.length} home-steps)`);
    const link = (f) => (serverHost ? `<http://${serverHost}:${serverPort}/view-data/${today}/${f}|${f}>` : f);
    lflBlock = lfl.slackBlock(weekly, today, `${link('views-like-for-like.csv')} · per-home workbook ${link('views-like-for-like.xlsx')}`);
  } catch (err) {
    console.error(`Like-for-like views failed: ${err.message}`);
    lflBlock = `*Views, like-for-like*: not available this week (${err.message}).`;
    process.exitCode = 1;
  }

  // 3c. Share of Booli's new homes with a paid Hemnet ad (lib/paid-coverage.js) — the
  // companion to the paid-only H%: how many sellers still pay. Same failure rule as 3b.
  let coverageBlock;
  try {
    const cov = require('./lib/paid-coverage');
    const c = createClient();
    await c.connect();
    let rows;
    try {
      rows = cov.computeCoverage(await cov.loadInputs(c));
    } finally {
      await c.end();
    }
    const dir = path.join(__dirname, 'view-data', today);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paid-share.csv'), cov.toCsv(rows), 'utf8');
    fs.writeFileSync(path.join(dir, 'paid-share.html'), cov.buildHtml(rows, today), 'utf8');
    console.log(`Paid share: ${dir}/paid-share.{csv,html} (${rows.length} cohorts)`);
    const link = (f) => (serverHost ? `<http://${serverHost}:${serverPort}/view-data/${today}/${f}|${f}>` : f);
    coverageBlock = cov.slackLine(rows, `${link('paid-share.html')} · ${link('paid-share.csv')}`);
  } catch (err) {
    console.error(`Paid share failed: ${err.message}`);
    coverageBlock = `*Sellers paying for Hemnet*: not available this week (${err.message}).`;
    process.exitCode = 1;
  }

  // 4. Slack notification
  if (serverHost) {
    const chartUrl = `http://${serverHost}:${serverPort}/view-data/${today}/cross-cohort-hpct.html`;
    const cohortLinks = exportedCohorts.map(id =>
      `<http://${serverHost}:${serverPort}/view-data/${today}/${id}/charts.html|${id}>`
    ).join('  ');

    const message = [
      `:bar_chart: *Weekly Cohort View Report — ${today}*`,
      `Cohorts: ${exportedCohorts.join(', ')}`,
      ``,
      `<${chartUrl}|:chart_with_upwards_trend: Cross-Cohort H% Chart> (paid Hemnet ads only)`,
      `Per-cohort charts: ${cohortLinks}`,
      ``,
      lflBlock,
      ``,
      coverageBlock,
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
  runReporter({ scriptName: 'weekly-view-report', run });
}
