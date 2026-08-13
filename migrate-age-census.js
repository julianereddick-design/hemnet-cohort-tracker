'use strict';
// migrate-age-census.js — creates age_census_run + age_census_muni (idempotent).
// Run manually: node migrate-age-census.js
// Spec: docs/superpowers/specs/2026-08-13-age-penetration-monthly-design.md
//
// One row per (run_date, platform, pool). Written by scripts/age-census-monthly.js.
// buckets_secondhand is NULLABLE: binary-search methods (both Booli pools) cannot
// resolve new-builds per band, so only the muni-partition (Hemnet) pools populate it.
const { createClient } = require('./db');

const CREATE_RUN = `
  CREATE TABLE IF NOT EXISTS age_census_run (
    id                  SERIAL      PRIMARY KEY,
    run_date            DATE        NOT NULL,
    platform            TEXT        NOT NULL,
    pool                TEXT        NOT NULL,
    method              TEXT        NOT NULL,
    n_total             INTEGER     NOT NULL,
    n_newbuild          INTEGER,
    n_newbuild_sampled  BOOLEAN     NOT NULL DEFAULT FALSE,
    n_newbuild_sample_n INTEGER,
    n_undated           INTEGER     NOT NULL,
    buckets             JSONB       NOT NULL,
    buckets_secondhand  JSONB,
    ox_calls            INTEGER     NOT NULL,
    error_pages         INTEGER     NOT NULL DEFAULT 0,
    runtime_s           INTEGER,
    status              TEXT        NOT NULL,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_date, platform, pool)
  )`;

const CREATE_MUNI = `
  CREATE TABLE IF NOT EXISTS age_census_muni (
    id                 SERIAL  PRIMARY KEY,
    run_id             INTEGER NOT NULL REFERENCES age_census_run(id) ON DELETE CASCADE,
    muni_name          TEXT    NOT NULL,
    muni_id            INTEGER NOT NULL,
    headline_n         INTEGER NOT NULL,
    counted_n          INTEGER NOT NULL,
    buckets            JSONB   NOT NULL,
    buckets_secondhand JSONB   NOT NULL,
    UNIQUE (run_id, muni_id)
  )`;

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_RUN);
    await client.query(CREATE_MUNI);
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [['age_census_run', 'age_census_muni']]
    );
    console.log('Tables present:', check.rows.map(r => r.table_name).sort().join(', ') || '(none)');
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
