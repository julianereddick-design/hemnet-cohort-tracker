// migrate-booli-listing-drop-agent-fk.js — Phase 9 follow-up migration.
//
// Background: 2026-05-15 dry-run surfaced 139 worker errors (~9% of 1531 enrichment
// fetches) all the same FK violation:
//
//   booli_listing_agent_id_9a6480c3_fk_booli_agent_id
//
// Root cause: the constraint requires every booli_listing.agent_id value to exist
// as booli_agent.id. Django historically populated both tables together, so the
// FK held. The new self-hosted Job C / Job D capture Booli's Source.id (broker
// chain id) per Plan 09-2.5 D-22 — different semantic from Django's value, and
// not present in booli_agent. The FK now rejects ~9% of UPDATEs/INSERTs from
// Job C and Job D, which would Slack-alert as 'warning' on every cron cycle
// (cron-wrapper escalates summary.workerErrors > 0).
//
// 09-2.5 #3 carry-forward already flagged the semantic divergence as a Metabase
// rebuild item; the FK itself was protecting against a Django-era invariant
// that no longer applies. Drop it.
//
// Idempotent (DROP CONSTRAINT IF EXISTS).
//
// Run manually:
//   node migrate-booli-listing-drop-agent-fk.js

'use strict';

const { createClient } = require('./db');

const CONSTRAINT_NAME = 'booli_listing_agent_id_9a6480c3_fk_booli_agent_id';

async function run() {
  const client = createClient();
  await client.connect();
  console.log('Connected. Dropping booli_listing.agent_id FK constraint...\n');

  // Show pre-state so a re-run is observable.
  const pre = await client.query(
    `SELECT conname
       FROM pg_constraint
      WHERE conrelid = 'booli_listing'::regclass
        AND conname = $1`,
    [CONSTRAINT_NAME],
  );
  console.log(`  Pre-state: constraint ${pre.rowCount > 0 ? 'PRESENT' : 'ABSENT'}`);

  await client.query(
    `ALTER TABLE booli_listing DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`,
  );
  console.log(`  Dropped:   ${CONSTRAINT_NAME}`);

  // Verify post-state.
  const post = await client.query(
    `SELECT conname
       FROM pg_constraint
      WHERE conrelid = 'booli_listing'::regclass
        AND conname = $1`,
    [CONSTRAINT_NAME],
  );
  console.log(`  Post-state: constraint ${post.rowCount > 0 ? 'STILL PRESENT (unexpected)' : 'ABSENT ✓'}`);

  // Surrounding context: list any FKs still on agent_id (sanity).
  const r = await client.query(`
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'booli_listing'::regclass
       AND contype = 'f'
       AND conname ILIKE '%agent_id%'
  `);
  console.log(`\nRemaining agent_id FK constraints on booli_listing: ${r.rowCount}`);
  for (const row of r.rows) {
    console.log(`  ${row.conname}: ${row.def}`);
  }

  console.log('\nDone.');
  await client.end();
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
