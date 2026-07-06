'use strict';
// migrate-premarket-flow.js — creates premarket_flow_weekly (idempotent).
// Run manually: node migrate-premarket-flow.js
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md
//
// One row per (snapshot_date, platform). Written by scripts/premarket-flow-measure.js.
// mean_dwell_days is NULLABLE (flow_per_day can be 0 → dwell undefined).
const { createClient } = require('./db');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS premarket_flow_weekly (
    snapshot_date            DATE        NOT NULL,
    platform                 TEXT        NOT NULL,
    window_days              INTEGER     NOT NULL,
    stock_total              INTEGER     NOT NULL,
    stock_secondhand_est     INTEGER     NOT NULL,
    adds_window_secondhand   INTEGER     NOT NULL,
    flow_per_day             NUMERIC     NOT NULL,
    newbuild_share_window    NUMERIC     NOT NULL,
    newbuild_share_pool_est  NUMERIC     NOT NULL,
    mean_dwell_days          NUMERIC,
    pages_walked             INTEGER     NOT NULL,
    oxylabs_calls            INTEGER     NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_date, platform)
  )
`;

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_TABLE);
    console.log('Created table: premarket_flow_weekly');
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1`,
      ['premarket_flow_weekly']
    );
    console.log('Tables present:', check.rows.map(r => r.table_name).join(', ') || '(none)');
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
