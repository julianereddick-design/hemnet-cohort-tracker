#!/usr/bin/env node
// scripts/verify-cron-job-log.js — Phase 9 / SC-2.
// Prints the last 5 rows per script_name from cron_job_log so an operator can
// confirm each scheduled job is logging. Exit 0 if every expected script has
// at least 1 row in the last 14 days, exit 1 otherwise.
//
// PLAN-TIME-CONFIRMED invocation pattern (Plan 09-03 Task 1 Step A, via
// `grep -l "require('./cron-wrapper')" *.js`): cohort-create.js, cohort-track.js,
// sfpl-region-snapshot.js, hemnet-targeted-refresh.js, hemnet-targeted-match.js,
// booli-targeted-discovery.js, booli-targeted-refresh.js (Plan 09-02 Job D)
// all `require('./cron-wrapper').runJob`. No CLI entry on cron-wrapper itself
// (cron-wrapper.js:143).

'use strict';
require('dotenv').config();
const { createClient } = require('../db');

const EXPECTED_SCRIPTS = [
  'cohort-create',
  'cohort-track',
  'sfpl-region-snapshot',
  'hemnet-targeted-refresh',     // Job A
  'hemnet-targeted-match',       // Job B
  'booli-targeted-discovery',    // Job C
  'booli-targeted-refresh',      // Job D (Plan 09-02)
];

async function main() {
  const client = createClient();
  await client.connect();
  try {
    let missing = [];
    for (const name of EXPECTED_SCRIPTS) {
      const r = await client.query(
        `SELECT id, started_at, finished_at, duration_ms, status, error_message,
                result_summary
         FROM cron_job_log
         WHERE script_name = $1 AND started_at > NOW() - INTERVAL '14 days'
         ORDER BY started_at DESC
         LIMIT 5`,
        [name],
      );
      console.log(`=== ${name} (last ${r.rows.length} rows in 14d) ===`);
      if (r.rows.length === 0) {
        console.log('  NO ROWS — script has not run (or has not been deployed)');
        missing.push(name);
        continue;
      }
      for (const row of r.rows) {
        const summaryKeys = row.result_summary
          ? Object.keys(row.result_summary).slice(0, 8).join(',')
          : '(null)';
        console.log(
          `  id=${row.id} started=${row.started_at && row.started_at.toISOString()} ` +
          `dur=${row.duration_ms}ms status=${row.status} ` +
          `err=${row.error_message ? row.error_message.slice(0, 60) : '-'} ` +
          `summary-keys=${summaryKeys}`,
        );
      }
    }
    if (missing.length) {
      console.error(`\nFAIL: ${missing.length} expected scripts have no rows: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('\nOK: every expected script has at least 1 row in the last 14 days.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
