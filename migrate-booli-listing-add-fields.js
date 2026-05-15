// migrate-booli-listing-add-fields.js — Phase 9 follow-up migration.
//
// Background: Django was populating booli_listing.price and booli_listing.agent_id
// daily until 2026-05-15 when it dropped to 1/610 rows (decommission underway).
// Our self-hosted Job C / Job D do not currently capture price, rooms, sqm,
// object_type, or agent_id. To enable the Job B targeted-Hemnet-search strategy
// (filter Hemnet by Booli's price + rooms + object_type), we capture these
// fields directly from Booli's Apollo state going forward.
//
// price and agent_id columns already exist. This migration adds:
//   - rooms        NUMERIC(3,1) NULL   — Booli sometimes has 2.5 etc
//   - object_type  VARCHAR(40)  NULL   — Swedish form e.g. 'Lägenhet','Villa'
//   - living_area  NUMERIC(6,1) NULL   — m² (Booli reports as int but allow .5)
//
// All NULL-able. No backfill — old rows stay NULL, new Job C inserts and Job D
// updates populate them going forward. Idempotent (ADD COLUMN IF NOT EXISTS).
//
// Run manually:
//   node migrate-booli-listing-add-fields.js

'use strict';

const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  console.log('Connected. Adding booli_listing fields for Booli→Hemnet matching enrichment...\n');

  await client.query(`
    ALTER TABLE booli_listing
      ADD COLUMN IF NOT EXISTS rooms        NUMERIC(3,1) NULL,
      ADD COLUMN IF NOT EXISTS object_type  VARCHAR(40)  NULL,
      ADD COLUMN IF NOT EXISTS living_area  NUMERIC(6,1) NULL
  `);
  console.log('  Added: rooms        NUMERIC(3,1) NULL');
  console.log('  Added: object_type  VARCHAR(40)  NULL');
  console.log('  Added: living_area  NUMERIC(6,1) NULL');

  // Verify by reading back the schema
  const r = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'booli_listing'
      AND column_name IN ('rooms','object_type','living_area','price','agent_id')
    ORDER BY column_name
  `);
  console.log('\nVerify:');
  for (const row of r.rows) {
    console.log('  ' + row.column_name.padEnd(14) + ' ' + row.data_type.padEnd(20) + ' nullable=' + row.is_nullable);
  }

  console.log('\nDone.');
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
