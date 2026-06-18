'use strict';
// migrate-sold-recheck-phase18.js — Phase-18 re-check scheduling state (RECHECK-01).
// Run manually: node migrate-sold-recheck-phase18.js
//
// Extends the existing sold_match table (created by migrate-sold-phase16.js, UNIQUE(booli_id))
// with three nullable re-check scheduling columns. Idempotent: each column is guarded by
// ADD COLUMN IF NOT EXISTS, so a re-run is a no-op and never errors. This is additive only —
// no DROP, no ALTER COLUMN, non-destructive (T-18-02 accepted, severity LOW).
//
// The drain loop (Plan 04) and store-layer scheduling helpers (Plan 03) read/write these
// columns; they must exist first.
const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  try {
    // Re-check scheduling columns on sold_match — all TIMESTAMPTZ, all nullable
    // (a matched/uncertain row leaves them null; only booli_only candidates schedule):
    //   first_unmatched_at = when the row first became a booli_only candidate for re-check.
    //   recheck_until      = first_unmatched_at + RECHECK_WINDOW_DAYS (the settle deadline).
    //   next_recheck_at    = when the row is next eligible for a re-check search
    //                        (advances by RECHECK_INTERVAL_DAYS each pass).
    // Each ADD COLUMN IF NOT EXISTS makes a re-run a no-op. Static literal — no interpolation.
    await client.query(`
      ALTER TABLE sold_match
        ADD COLUMN IF NOT EXISTS first_unmatched_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS recheck_until      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS next_recheck_at    TIMESTAMPTZ
    `);
    console.log('Altered table: sold_match (+first_unmatched_at, +recheck_until, +next_recheck_at)');

    // Read-back verify (idiom from migrate-sold-phase16.js:136-142): confirm the three
    // columns exist after the run, so a re-run visibly reports the schema applied.
    // Parameterized $1 — no string interpolation (T-18-01 mitigation).
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sold_match'
           AND column_name = ANY($1::text[])
         ORDER BY column_name`,
      [['first_unmatched_at', 'next_recheck_at', 'recheck_until']]
    );
    console.log('Re-check columns present:', check.rows.map(r => r.column_name).join(', '));
  } finally {
    // WR-01: always release the client, even if the ALTER/SELECT above throws —
    // a leaked connection otherwise lingers until process exit.
    await client.end();
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
