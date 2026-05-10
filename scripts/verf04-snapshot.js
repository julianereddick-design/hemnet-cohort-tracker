'use strict';

// VERF-04 helper: snapshot W15 hemnet_listingv2 row count + latest
// hemnet-targeted-match cron_job_log row. Used pre/post the dry-run to
// confirm the dry-run guardrail (count must not change) and that the
// cron_job_log row was written.
//
// Run from inside hemnet-cohort-tracker/:
//   node scripts/verf04-snapshot.js          # pre or post snapshot
//   node scripts/verf04-snapshot.js --post   # alias; identical output, just labelled

const { createClient } = require('../db');

const W15_START = '2026-04-13';
const W15_END = '2026-04-19';
const label = process.argv.includes('--post') ? 'POST' : 'PRE';

(async () => {
  const c = createClient();
  await c.connect();
  try {
    const cnt = await c.query(
      `SELECT COUNT(*)::int AS n FROM hemnet_listingv2
        WHERE listed >= $1::date AND listed <= $2::date`,
      [W15_START, W15_END],
    );
    console.log(`${label}: hemnet_listingv2 rows in W15 (${W15_START}..${W15_END}): ${cnt.rows[0].n}`);

    const log = await c.query(
      `SELECT id, script_name, status, started_at, finished_at,
              duration_ms, error_message, result_summary
         FROM cron_job_log
        WHERE script_name = 'hemnet-targeted-match'
        ORDER BY id DESC LIMIT 1`,
    );
    if (log.rows.length === 0) {
      console.log('cron_job_log: no row yet for hemnet-targeted-match');
    } else {
      console.log('cron_job_log latest row:');
      console.log(JSON.stringify(log.rows[0], null, 2));
    }
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
