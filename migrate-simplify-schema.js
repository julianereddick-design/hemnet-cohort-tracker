const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  console.log('Connected. Simplifying cohort_daily_views schema...\n');

  // 1. Drop FK constraint on cohort_id (must go before dropping the column)
  await client.query(`
    ALTER TABLE cohort_daily_views
    DROP CONSTRAINT IF EXISTS cohort_daily_views_cohort_id_fkey
  `);
  console.log('  Dropped constraint: cohort_daily_views_cohort_id_fkey');

  // 2. Drop redundant columns (IF EXISTS for idempotency)
  const columnsToDrop = ['cohort_id', 'day', 'booli_delta', 'hemnet_delta'];
  for (const col of columnsToDrop) {
    await client.query(`
      ALTER TABLE cohort_daily_views DROP COLUMN IF EXISTS ${col}
    `);
    console.log(`  Dropped column: ${col}`);
  }

  // 3. Verify UNIQUE constraint on (pair_id, date) exists
  const indexResult = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'cohort_daily_views'
  `);
  console.log('\n  Indexes on cohort_daily_views:');
  for (const row of indexResult.rows) {
    console.log(`    ${row.indexname}: ${row.indexdef}`);
  }

  // 4. Verify final column set
  const colResult = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'cohort_daily_views'
    ORDER BY ordinal_position
  `);
  const columns = colResult.rows.map(r => r.column_name);
  console.log(`\n  Final columns: ${columns.join(', ')}`);

  const expected = ['id', 'pair_id', 'date', 'booli_views', 'hemnet_views', 'created_at'];
  const match = JSON.stringify(columns) === JSON.stringify(expected);
  console.log(`  Schema matches target: ${match}`);

  if (!match) {
    console.error('  WARNING: Column set does not match expected target!');
    console.error(`  Expected: ${expected.join(', ')}`);
    console.error(`  Got: ${columns.join(', ')}`);
  }

  console.log('\nMigration complete.');
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
