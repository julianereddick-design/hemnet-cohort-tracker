require('dotenv').config();
// scripts/backfill-window-end.js — ONE-TIME cleanup for incident defect #2.
//
// Some old-code sold_match rows have window_end = NULL (the batch path did not pass the sample
// window into matchOne before commit 0089f27). The standard report filters `WHERE window_end >=
// today-21d`, so these NULL rows are SILENTLY DROPPED — inflating the reported booli_only rate
// (they are matched/uncertain, never booli_only). This backfills window_end on exactly those NULL
// rows so they re-enter the report like every other row.
//
// Backfill value, per row: the sample window's max sold date (maxSoldDate) of the sold-match-batch
// run that produced it — looked up from cron_job_log.result_summary.sample.window.maxSoldDate, keyed
// by the run's start date == the row's created_at date. If no batch run matches that date (e.g. rows
// written by a manual national run), it falls back to the row's created_at::date (the sample window
// max is within ~14d of creation; immaterial for a 21-day report window).
//
// SAFE: DRY-RUN by default — prints exactly what it would change and stops. Pass `--apply` to write,
// inside a single transaction. Only ever touches rows where window_end IS NULL (idempotent: a second
// run finds nothing). NO Oxylabs.
//
//   node scripts/backfill-window-end.js            # dry-run (preview only)
//   node scripts/backfill-window-end.js --apply    # write (transaction)

const { createClient } = require('../db');

async function main() {
  const apply = process.argv.includes('--apply');
  const client = createClient();
  await client.connect();
  try {
    // 1. run_date -> maxSoldDate map from the batch run log.
    const runs = await client.query(
      `SELECT (started_at::date)::text AS run_date,
              result_summary->'sample'->'window'->>'maxSoldDate' AS max_sold
         FROM cron_job_log
        WHERE script_name = 'sold-match-batch'
          AND result_summary->'sample'->'window'->>'maxSoldDate' IS NOT NULL`,
    );
    const runMax = new Map();
    for (const r of runs.rows) runMax.set(r.run_date, r.max_sold); // keys are ISO 'YYYY-MM-DD'

    // 2. the NULL-window_end rows, grouped by created date (ISO text), with the proposed value.
    const groups = await client.query(
      `SELECT (created_at::date)::text AS created, verdict, count(*) AS n
         FROM sold_match
        WHERE window_end IS NULL
        GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    if (!groups.rows.length) {
      console.log('Nothing to backfill — no sold_match rows have window_end IS NULL.');
      return;
    }

    let total = 0;
    const plan = new Map(); // createdDate -> proposed window_end
    console.log(`window_end backfill — ${apply ? 'APPLY' : 'DRY-RUN'}\n`);
    console.log('created_date | verdict            |    n | -> window_end');
    console.log('-------------+--------------------+------+--------------');
    for (const g of groups.rows) {
      const created = g.created; // ISO 'YYYY-MM-DD'
      const proposed = runMax.get(created) || created;
      plan.set(created, proposed);
      total += Number(g.n);
      console.log(`${created} | ${String(g.verdict).padEnd(18)} | ${String(g.n).padStart(4)} | ${proposed}`
        + `${runMax.get(created) ? ' (run maxSoldDate)' : ' (fallback: created_at)'}`);
    }
    console.log(`\nTotal rows to backfill: ${total}`);

    if (!apply) {
      console.log('\nDRY-RUN only — no rows changed. Re-run with --apply to write.');
      return;
    }

    // 3. apply, one UPDATE per created-date group, in a single transaction.
    await client.query('BEGIN');
    let updated = 0;
    for (const [created, proposed] of plan) {
      const res = await client.query(
        `UPDATE sold_match SET window_end = $1::date
          WHERE window_end IS NULL AND created_at::date = $2::date`,
        [proposed, created],
      );
      updated += res.rowCount;
    }
    await client.query('COMMIT');
    console.log(`\nAPPLIED: ${updated} rows updated (committed). Re-run dry to confirm 0 remain.`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('ERROR — rolled back:', e && e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
