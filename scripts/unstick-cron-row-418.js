// scripts/unstick-cron-row-418.js — one-shot: mark ghost cron_job_log row 418 as killed.
// Safe to re-run (WHERE clause is idempotent — only fires while row is still 'running').

'use strict';

require('dotenv').config();
const { createClient } = require('../db');

async function main() {
  const client = createClient();
  await client.connect();

  const r = await client.query(`
    UPDATE cron_job_log
       SET status = 'killed',
           finished_at = NOW(),
           error_message = 'ghost — SIGHUP killed node 2026-05-18 ~11:21 UTC; no signal handler in cron-wrapper'
     WHERE id = 418
       AND status = 'running'
    RETURNING id, status, started_at, finished_at, error_message
  `);

  if (r.rowCount === 0) {
    console.log('No row updated (id=418 not running, or already cleaned up).');
    const peek = await client.query(`SELECT id, status, started_at, finished_at FROM cron_job_log WHERE id = 418`);
    console.log('Current state:', peek.rows[0] || '(no row with id=418)');
  } else {
    console.log('Updated:');
    console.log(JSON.stringify(r.rows[0], null, 2));
  }

  await client.end();
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
