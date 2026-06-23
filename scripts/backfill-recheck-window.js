require('dotenv').config();
// scripts/backfill-recheck-window.js — ONE-TIME cleanup for incident defect #5.
//
// A set of booli_only rows were enrolled under the OBSOLETE 28-day recheck window (before commit
// b79c945 widened it to 182d). The widening does NOT retro-stamp recheck_until, so those rows carry
// recheck_until = first_unmatched_at + 28d and would be SETTLED to genuine_non_hemnet ~5 months
// early — far inside the 182-day policy chosen for villa slutpris-lag (9–15 months). That biases the
// first-ever settle output high (they settle first). This extends them to the current window.
//
// Target predicate: verdict='booli_only' AND (recheck_until::date - first_unmatched_at::date) = the
// OLD window (28d) — i.e. rows whose window is shorter than the current RECHECK_WINDOW_DAYS. New
// recheck_until = first_unmatched_at + RECHECK_WINDOW_DAYS (read from lib/sold-config, currently 182).
//
// SAFE: DRY-RUN by default. Pass `--apply` to write inside a transaction. Idempotent (a second run
// finds nothing, because the rows then carry the full window). NO Oxylabs. Does NOT touch verdict,
// next_recheck_at, or any already-correct 182d row.
//
//   node scripts/backfill-recheck-window.js          # dry-run (preview only)
//   node scripts/backfill-recheck-window.js --apply  # write (transaction)

const { createClient } = require('../db');
const { RECHECK_WINDOW_DAYS } = require('../lib/sold-config');

async function main() {
  const apply = process.argv.includes('--apply');
  const W = RECHECK_WINDOW_DAYS; // 182
  const client = createClient();
  await client.connect();
  try {
    // Preview: every distinct short window among enrolled booli_only rows (anything < W).
    const preview = await client.query(
      `SELECT (recheck_until::date - first_unmatched_at::date) AS win_days,
              to_char(min(first_unmatched_at), 'YYYY-MM-DD') AS min_fu,
              to_char(max(first_unmatched_at), 'YYYY-MM-DD') AS max_fu,
              to_char(min(recheck_until), 'YYYY-MM-DD') AS cur_min_until,
              to_char(min(first_unmatched_at) + ($1::int * INTERVAL '1 day'), 'YYYY-MM-DD') AS new_until_min,
              count(*) AS n
         FROM sold_match
        WHERE verdict = 'booli_only'
          AND first_unmatched_at IS NOT NULL
          AND recheck_until IS NOT NULL
          AND (recheck_until::date - first_unmatched_at::date) < $1::int
        GROUP BY 1 ORDER BY 1`,
      [W],
    );

    console.log(`recheck-window backfill — ${apply ? 'APPLY' : 'DRY-RUN'}  (target window = ${W} days)\n`);
    if (!preview.rows.length) {
      console.log(`Nothing to backfill — all enrolled booli_only rows already carry a >= ${W}-day window.`);
      return;
    }
    let total = 0;
    console.log('cur_window | first_unmatched (min..max) | cur recheck_until -> new (>= min)   |    n');
    console.log('-----------+----------------------------+-------------------------------------+-----');
    for (const r of preview.rows) {
      total += Number(r.n);
      console.log(`${String(r.win_days).padStart(7)}d   | ${r.min_fu}..${r.max_fu}       | `
        + `${r.cur_min_until} -> ${r.new_until_min}            | ${String(r.n).padStart(4)}`);
    }
    console.log(`\nTotal rows to extend to ${W}-day window: ${total}`);

    if (!apply) {
      console.log('\nDRY-RUN only — no rows changed. Re-run with --apply to write.');
      return;
    }

    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE sold_match
          SET recheck_until = first_unmatched_at + ($1::int * INTERVAL '1 day')
        WHERE verdict = 'booli_only'
          AND first_unmatched_at IS NOT NULL
          AND recheck_until IS NOT NULL
          AND (recheck_until::date - first_unmatched_at::date) < $1::int`,
      [W],
    );
    await client.query('COMMIT');
    console.log(`\nAPPLIED: ${res.rowCount} rows extended to a ${W}-day recheck window (committed). `
      + 'Re-run dry to confirm 0 remain. (next_recheck_at unchanged — drain cadence preserved.)');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('ERROR — rolled back:', e && e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
