// migrate-premarket-quality.js — creates premarket_quality_weekly (idempotent).
// Run manually: node migrate-premarket-quality.js
// Spec: docs/superpowers/specs/2026-08-13-premarket-quality-weekly-design.md
//
// One row per snapshot_date. Written by scripts/premarket-quality-measure.js,
// read by premarket-flow-weekly-report.js and joined against premarket_flow_weekly
// on snapshot_date to place Hemnet's total on Booli's quality ladder.
const { createClient } = require('./db');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS premarket_quality_weekly (
    snapshot_date      DATE        NOT NULL PRIMARY KEY,
    window_days        INTEGER     NOT NULL,
    n_total            INTEGER     NOT NULL,
    n_high             INTEGER     NOT NULL,
    n_mid_high         INTEGER     NOT NULL,
    n_mid_sell         INTEGER     NOT NULL,
    n_mid_fish         INTEGER     NOT NULL,
    n_other            INTEGER     NOT NULL,
    n_low              INTEGER     NOT NULL,
    pct_interior       NUMERIC     NOT NULL,
    pct_price          NUMERIC     NOT NULL,
    pct_avm_shown      NUMERIC     NOT NULL,
    pct_viewing        NUMERIC     NOT NULL,
    n_ambiguous        INTEGER     NOT NULL,
    n_resolved         INTEGER     NOT NULL,
    n_unknown_labels   INTEGER     NOT NULL,
    pages_walked       INTEGER     NOT NULL,
    oxylabs_calls      INTEGER     NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_TABLE);
    console.log('Created table: premarket_quality_weekly');
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'premarket_quality_weekly'
        ORDER BY ordinal_position`
    );
    console.log(`Columns (${check.rows.length}): ${check.rows.map(r => r.column_name).join(', ')}`);
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
