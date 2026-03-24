const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  console.log('Connected. Running schema migration...\n');

  await client.query(`
    ALTER TABLE cohort_pairs
      ADD COLUMN IF NOT EXISTS drop_streak_hemnet INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS drop_streak_booli INTEGER NOT NULL DEFAULT 0
  `);
  console.log('  Added: drop_streak_hemnet (INTEGER NOT NULL DEFAULT 0)');
  console.log('  Added: drop_streak_booli  (INTEGER NOT NULL DEFAULT 0)');

  console.log('\nDone. Schema migration complete.');
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
