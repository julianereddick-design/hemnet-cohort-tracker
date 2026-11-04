require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('./db');
const { postMessage } = require('./lib/slack-post');
const { runReporter } = require('./cron-wrapper');
const TV = require('./lib/tier-views');

// tier-views-report.js — monthly (1st, 07:20 UTC): Hemnet views by ad tier for comparable
// homes, and the free-to-paid upgrade rate. Method: lib/tier-views.js. Reports the month
// before the run date; recomputes every month from 2026-11 so the CSV is the full history.
// Files: view-data/<date>/tier-views/tier-views.{csv,xlsx} + upgrades.csv, served on :3800.
//
//   node tier-views-report.js --dry-run          (renders the post, writes the files)
//   REPORT_DATE=2026-12-01 node tier-views-report.js --dry-run

async function main() {
  const runDate = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  const d = new Date(`${runDate}T00:00:00Z`);
  d.setUTCDate(0);                                    // last day of the previous month
  const month = d.toISOString().slice(0, 7);

  const client = createClient();
  let inputs;
  try {
    await client.connect();
    inputs = await TV.loadInputs(client);
  } finally {
    await client.end();
  }
  const homes = TV.homeRates(inputs.pairs, inputs.readings, { before: runDate }).filter(h => h.month <= month);
  const rows = TV.summarise(homes);
  const upgrades = TV.upgradeRates(inputs.ads, runDate);

  const dir = path.join(__dirname, 'view-data', runDate, 'tier-views');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tier-views.csv'), TV.toCsv(rows, TV.CSV_COLUMNS), 'utf8');
  fs.writeFileSync(path.join(dir, 'upgrades.csv'), TV.toCsv(upgrades, TV.UPGRADE_COLUMNS), 'utf8');
  await TV.writeWorkbook(path.join(dir, 'tier-views.xlsx'), rows, upgrades, homes);
  console.log(`Tier views: ${dir} (${homes.length} homes, ${rows.length} month×tier rows, ${upgrades.length} upgrade months)`);

  const host = process.env.VIEW_SERVER_HOST;
  const port = process.env.VIEW_SERVER_PORT || 3800;
  const link = (f) => (host ? `<http://${host}:${port}/view-data/${runDate}/tier-views/${f}|${f}>` : f);
  const text = TV.slackMessage({
    month, rows, upgrades,
    links: `${link('tier-views.xlsx')} · ${link('tier-views.csv')} · ${link('upgrades.csv')}`,
  });
  console.log(text);

  // postMessage RETURNS {ok:false} on a failed delivery — it does not throw. Branch on
  // result.ok; the exit code is the only signal that anything went wrong.
  try {
    const result = await postMessage('tier-views-report', text);
    if (result.dryRun) {
      console.log('Dry run — no Slack notification sent');
    } else if (result.ok) {
      console.log('Posted to Slack.');
    } else {
      console.error('Slack post failed on both the bot and the webhook fallback');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Slack failed: ${err.message}`);
    process.exitCode = 1;
  }
}

// Entry gate: an unrecognised flag must not fall through to the live path and post.
const ACCEPTED_ARGV = new Set(['--dry-run']);
const USAGE = 'Usage: node tier-views-report.js [--dry-run]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  }
  if (argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';
  runReporter({ scriptName: 'tier-views-report', run: main });
}
