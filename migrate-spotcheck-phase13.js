const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS spotcheck_review (
      id             SERIAL PRIMARY KEY,
      pair_id        INTEGER NOT NULL,
      cohort_id      TEXT NOT NULL,
      channel        TEXT NOT NULL,
      ts             TEXT NOT NULL,
      vision_verdict TEXT,
      human_verdict  TEXT,
      reactor        TEXT,
      reason         TEXT,
      adjudicated_at TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(pair_id, cohort_id)
    )
  `);
  console.log('Created table: spotcheck_review');

  await client.query(`
    CREATE TABLE IF NOT EXISTS spotcheck_removed_pairs (
      id             SERIAL PRIMARY KEY,
      pair_id        INTEGER NOT NULL,
      cohort_id      TEXT NOT NULL,
      booli_id       BIGINT NOT NULL,
      hemnet_id      BIGINT NOT NULL,
      vision_verdict TEXT,
      human_verdict  TEXT NOT NULL,
      reactor        TEXT,
      reason         TEXT,
      removed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('Created table: spotcheck_removed_pairs');

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
