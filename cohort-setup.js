const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  console.log('Connected. Creating cohort tables...\n');

  // 1. Cohorts — one row per weekly cohort
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohorts (
      cohort_id TEXT PRIMARY KEY,           -- e.g. "2026-W10"
      week_start DATE NOT NULL,             -- Monday
      week_end DATE NOT NULL,               -- Sunday
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('  Created: cohorts');

  // 2. Cohort pairs — matched Booli+Hemnet listings in each cohort
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohort_pairs (
      id SERIAL PRIMARY KEY,
      cohort_id TEXT NOT NULL REFERENCES cohorts(cohort_id),
      booli_id BIGINT NOT NULL,
      hemnet_id BIGINT NOT NULL,
      street_address TEXT NOT NULL,
      postcode INTEGER NOT NULL,
      municipality TEXT NOT NULL,
      county TEXT NOT NULL,
      booli_listed DATE NOT NULL,
      hemnet_listed DATE NOT NULL,
      booli_views_day0 INTEGER NOT NULL DEFAULT 0,
      hemnet_views_day0 INTEGER NOT NULL DEFAULT 0,
      dropped_booli_on DATE,                -- date Booli listing went inactive
      dropped_hemnet_on DATE,               -- date Hemnet listing went inactive
      UNIQUE(cohort_id, booli_id, hemnet_id)
    )
  `);
  console.log('  Created: cohort_pairs');

  // 3. Daily view snapshots — one row per pair per date
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohort_daily_views (
      id SERIAL PRIMARY KEY,
      pair_id INTEGER NOT NULL REFERENCES cohort_pairs(id),
      date DATE NOT NULL,
      booli_views INTEGER,
      hemnet_views INTEGER,
      UNIQUE(pair_id, date)
    )
  `);
  console.log('  Created: cohort_daily_views');

  // 4. Unmatched log — Booli listings that didn't match to Hemnet
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohort_unmatched (
      id SERIAL PRIMARY KEY,
      cohort_id TEXT NOT NULL REFERENCES cohorts(cohort_id),
      booli_id BIGINT NOT NULL,
      title TEXT,
      street_address TEXT,
      postcode INTEGER,
      municipality TEXT,
      county TEXT,
      listed DATE,
      times_viewed INTEGER
    )
  `);
  console.log('  Created: cohort_unmatched');

  console.log('\nDone. All tables ready.');
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
