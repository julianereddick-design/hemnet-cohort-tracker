// scripts/check-hemnet-match-w20.js — monitor probe for Plan 09-2.6 Task 5 W20 recovery run.
// Returns latest cron_job_log row for hemnet-targeted-match since 2026-05-18 11:00 UTC,
// plus current W20 cohort_pairs count and hemnet_listingv2 writes since 11:00 UTC.

'use strict';

require('dotenv').config();
const { createClient } = require('../db');

async function main() {
  const client = createClient();
  await client.connect();

  console.log('=== Latest hemnet-targeted-match cron_job_log (since 2026-05-18 21:00 UTC, job 419 window) ===');
  const cron = await client.query(`
    SELECT id, script_name, status, started_at, finished_at,
           duration_ms,
           LEFT(COALESCE(error_message, ''), 300) AS err,
           result_summary
      FROM cron_job_log
     WHERE script_name = 'hemnet-targeted-match'
       AND started_at >= '2026-05-18 21:00:00+00'
     ORDER BY started_at DESC
     LIMIT 1
  `);
  if (cron.rows.length === 0) {
    console.log('  (NO ROWS — job may not have started yet)');
  } else {
    const r = cron.rows[0];
    const dur = r.duration_ms != null ? (r.duration_ms / 1000 / 60).toFixed(1) + 'min' : 'n/a';
    console.log(`  id:           ${r.id}`);
    console.log(`  status:       ${r.status}`);
    console.log(`  started_at:   ${r.started_at.toISOString()}`);
    console.log(`  finished_at:  ${r.finished_at ? r.finished_at.toISOString() : '(still running)'}`);
    console.log(`  duration:     ${dur}`);
    if (r.err) console.log(`  err:          ${r.err}`);
    if (r.result_summary) {
      console.log(`  result_summary:`);
      console.log('    ' + JSON.stringify(r.result_summary, null, 2).split('\n').join('\n    '));
    }

    const nowMs = Date.now();
    const startedMs = r.started_at.getTime();
    const ageHrs = ((nowMs - startedMs) / 3600000).toFixed(2);
    console.log(`  age_hours:    ${ageHrs}`);
  }

  console.log('\n=== hemnet_listingv2 INSERT writes since 21:14:51 UTC (NOTE: misses UPDATEs to existing rows — undercount) ===');
  const writes = await client.query(`
    SELECT COUNT(*)::int AS writes
      FROM hemnet_listingv2
     WHERE crawled >= '2026-05-18 21:14:51+00'
  `);
  const writesCount = writes.rows[0].writes;
  console.log(`  writes (INSERTs only): ${writesCount}`);
  if (cron.rows.length > 0) {
    const minsRunning = (Date.now() - cron.rows[0].started_at.getTime()) / 60000;
    const ratePerMin = minsRunning > 0 ? (writesCount / minsRunning).toFixed(2) : 'n/a';
    console.log(`  rate:                  ${ratePerMin} writes/min over ${minsRunning.toFixed(1)} min`);
    console.log(`  NOTE: true match count is in the log file as 'match booli_id=' lines, not here.`);
  }

  console.log('\n=== W20 cohort_pairs count ===');
  const w20 = await client.query(`
    SELECT COUNT(*)::int AS pairs FROM cohort_pairs WHERE cohort_id = '2026-W20'
  `);
  console.log(`  pairs: ${w20.rows[0].pairs}`);

  await client.end();
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
