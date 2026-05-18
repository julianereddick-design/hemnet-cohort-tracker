// scripts/delete-w20-cohort.js — Plan 09-2.6 Task 5 step 5.
// Wipes 2026-W20 from all four cohort tables in one tx. Single-purpose, idempotent on second run.
// WARNING: destructive. Wipes the 441 partial pairs AND ~1 day of cohort_daily_views tracking.

'use strict';

require('dotenv').config();
const { createClient } = require('../db');

async function main() {
  const client = createClient();
  await client.connect();

  // Pre-counts for the audit trail in the summary.
  // cohort_daily_views has no cohort_id column — it links via pair_id → cohort_pairs.id.
  const before = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM cohorts            WHERE cohort_id = '2026-W20') AS cohorts,
      (SELECT COUNT(*)::int FROM cohort_pairs       WHERE cohort_id = '2026-W20') AS pairs,
      (SELECT COUNT(*)::int FROM cohort_unmatched   WHERE cohort_id = '2026-W20') AS unmatched,
      (SELECT COUNT(*)::int FROM cohort_daily_views v
        WHERE v.pair_id IN (SELECT id FROM cohort_pairs WHERE cohort_id = '2026-W20')) AS daily_views
  `);
  console.log('Pre-delete W20 row counts:');
  console.log(`  cohorts:            ${before.rows[0].cohorts}`);
  console.log(`  cohort_pairs:       ${before.rows[0].pairs}`);
  console.log(`  cohort_unmatched:   ${before.rows[0].unmatched}`);
  console.log(`  cohort_daily_views: ${before.rows[0].daily_views}`);

  await client.query('BEGIN');
  try {
    // daily_views must go first (FK depends on cohort_pairs.id)
    const r2 = await client.query(`
      DELETE FROM cohort_daily_views
       WHERE pair_id IN (SELECT id FROM cohort_pairs WHERE cohort_id = '2026-W20')
    `);
    const r1 = await client.query(`DELETE FROM cohort_pairs      WHERE cohort_id = '2026-W20'`);
    const r3 = await client.query(`DELETE FROM cohort_unmatched  WHERE cohort_id = '2026-W20'`);
    const r4 = await client.query(`DELETE FROM cohorts           WHERE cohort_id = '2026-W20'`);
    await client.query('COMMIT');
    console.log('\nDeleted (in one tx):');
    console.log(`  cohort_daily_views: ${r2.rowCount}`);
    console.log(`  cohort_pairs:       ${r1.rowCount}`);
    console.log(`  cohort_unmatched:   ${r3.rowCount}`);
    console.log(`  cohorts:            ${r4.rowCount}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rolled back:', err.message);
    process.exit(1);
  }

  const after = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM cohorts            WHERE cohort_id = '2026-W20') AS cohorts,
      (SELECT COUNT(*)::int FROM cohort_pairs       WHERE cohort_id = '2026-W20') AS pairs,
      (SELECT COUNT(*)::int FROM cohort_unmatched   WHERE cohort_id = '2026-W20') AS unmatched,
      (SELECT COUNT(*)::int FROM cohort_daily_views v
        WHERE v.pair_id IN (SELECT id FROM cohort_pairs WHERE cohort_id = '2026-W20')) AS daily_views
  `);
  console.log('\nPost-delete W20 row counts (should all be 0):');
  console.log(`  cohorts:            ${after.rows[0].cohorts}`);
  console.log(`  cohort_pairs:       ${after.rows[0].pairs}`);
  console.log(`  cohort_unmatched:   ${after.rows[0].unmatched}`);
  console.log(`  cohort_daily_views: ${after.rows[0].daily_views}`);

  await client.end();
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
