// migrate-cohort-pairs-soft-delete.js
//
// Phase 13.1 (D-11 reversal, operator decision 2026-06-11): pair "removal" is a
// soft-delete UPDATE, never a hard DELETE. The old hard-delete path was doubly
// broken: cohort_daily_views.pair_id FK (no CASCADE) rolled back the txn for any
// tracked pair, and spotcheck_removed_pairs doesn't capture the NOT NULL columns
// needed to re-INSERT. Soft-delete sidesteps the FK, preserves the full row and
// its view history, and recovery is:
//   UPDATE cohort_pairs SET removed_at=NULL, removed_reason=NULL, removed_by=NULL WHERE id=<pair_id>;
//
// Idempotent (IF NOT EXISTS); safe to re-run. Run once on the droplet:
//   node migrate-cohort-pairs-soft-delete.js

const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  console.log('Connected. Running schema migration...\n');

  await client.query(`
    ALTER TABLE cohort_pairs
      ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS removed_reason TEXT,
      ADD COLUMN IF NOT EXISTS removed_by TEXT
  `);
  console.log('  Added: removed_at     (TIMESTAMPTZ, NULL = active pair)');
  console.log('  Added: removed_reason (TEXT)');
  console.log('  Added: removed_by     (TEXT)');

  const r = await client.query(
    `SELECT COUNT(*)::int AS total, COUNT(removed_at)::int AS removed FROM cohort_pairs`
  );
  console.log(`\ncohort_pairs: ${r.rows[0].total} rows, ${r.rows[0].removed} soft-removed`);

  console.log('\nDone. Schema migration complete.');
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
