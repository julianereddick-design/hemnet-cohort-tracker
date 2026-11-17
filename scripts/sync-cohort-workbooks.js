#!/usr/bin/env node
// scripts/sync-cohort-workbooks.js — runs on Glenn's PC (Windows Task Scheduler), NOT the droplet.
//
// Copies each weekly cohort's views workbook from the latest Monday report on the droplet
// (view-data/<date>/<cohort>/hb-ratio-<cohort>.xlsx) into the Decade drive, one file per
// cohort, overwritten when a newer run exists: "Cohort 2026-W44 views.xlsx". The Decade drive
// folder syncs to SharePoint through OneDrive; the droplet cannot write there itself.
//
// Safe to run any time and as often as you like: a cohort is copied only when the droplet has a
// newer run than the one last copied (state in .sync-state.json in the folder). A file open in
// Excel cannot be replaced; it is skipped and logged, and the next run picks it up.
//
//   node scripts/sync-cohort-workbooks.js            copy what is new
//   node scripts/sync-cohort-workbooks.js --dry-run  list what would be copied
//   node scripts/sync-cohort-workbooks.js --force    copy every cohort again
//
// Needs the `cohort-droplet` host in ~/.ssh/config (key-based, no prompt). Log:
// %LOCALAPPDATA%\hemnet-cohort-sync\sync.log.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST = 'cohort-droplet';
const REMOTE = '/opt/hemnet-cohort-tracker/view-data';
const DEST = process.env.COHORT_SYNC_DEST ||
  path.join(os.homedir(), 'Decade Partners', 'Investing - Companies', 'Hemnet', 'DATA MASTER', 'WEEKLY COHORT VIEWS');
const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hemnet-cohort-sync');
const STATE = path.join(DEST, '.sync-state.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, 'sync.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (!dryRun) fs.appendFileSync(logFile, line + os.EOL);
}

const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', HOST, cmd], { encoding: 'utf8' });
const destName = (cohort) => `Cohort ${cohort} views.xlsx`;

function main() {
  // Latest dated run folder that holds cohort workbooks, and the workbooks in it.
  const listing = ssh(`cd ${REMOTE} && d=$(ls -d 20??-??-?? | sort | while read x; do ls $x/20??-W??/hb-ratio-*.xlsx >/dev/null 2>&1 && echo $x; done | tail -1) && echo "$d" && ls $d/20??-W??/hb-ratio-*.xlsx`)
    .trim().split('\n');
  const runDate = listing.shift();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate || '')) throw new Error(`no run folder with cohort workbooks on the droplet (got ${JSON.stringify(runDate)})`);
  const cohorts = listing.map(f => (f.match(/(20\d\d-W\d\d)\/hb-ratio-/) || [])[1]).filter(Boolean);

  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const todo = cohorts.filter(c => force || !state[c] || state[c] < runDate || !fs.existsSync(path.join(DEST, destName(c))));
  log(`run ${runDate}: ${cohorts.length} cohort workbooks on the droplet, ${todo.length} to copy${dryRun ? ' (dry run)' : ''}`);
  if (dryRun || !todo.length) { todo.forEach(c => console.log(`  ${c} -> ${destName(c)}`)); return; }

  fs.mkdirSync(DEST, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort-sync-'));
  let copied = 0, failed = 0;
  try {
    for (const c of todo) {
      const src = `${HOST}:${REMOTE}/${runDate}/${c}/hb-ratio-${c}.xlsx`;
      const local = path.join(tmp, `${c}.xlsx`);
      try {
        execFileSync('scp', ['-q', '-o', 'BatchMode=yes', src, local], { stdio: 'pipe' });
        fs.copyFileSync(local, path.join(DEST, destName(c)));   // fails (EBUSY/EPERM) if open in Excel
        state[c] = runDate;
        copied++;
      } catch (err) {
        failed++;
        log(`  ${c}: not copied (${String(err.message || err).split('\n')[0]})${/EBUSY|EPERM/.test(String(err.code || err.message)) ? ' — file open in Excel? next run retries' : ''}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  }
  log(`copied ${copied}, failed ${failed} -> ${DEST}`);
  if (failed) process.exitCode = 1;
}

try { main(); } catch (err) { log(`FAILED: ${err.message.split('\n')[0]}`); process.exitCode = 1; }
