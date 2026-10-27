// migrate-hemnet-listing-format.js — listing-format tracking for Hemnet (2026-10-27).
//
//   node migrate-hemnet-listing-format.js          apply (idempotent)
//   node migrate-hemnet-listing-format.js --down   revert: drops the columns and the history table
//
// Why: Hemnet launched a free tier (package MINIMAL) on 2026-10-20 and is adding
// aggregated listings from agency websites. The views reports need to tell paid,
// free and aggregated listings apart. hemnet-targeted-refresh.js fills these on
// every refresh, and works unchanged with or without them (it checks first), so
// apply/revert order relative to a code deploy doesn't matter.
// See docs/handover/CHANGELOG.md, 2026-10-27.
const { createClient } = require('./db');

const UP = [
  `ALTER TABLE hemnet_listingv2
     ADD COLUMN IF NOT EXISTS active_package   TEXT,
     ADD COLUMN IF NOT EXISTS is_teaser        BOOLEAN,
     ADD COLUMN IF NOT EXISTS listing_typename TEXT,
     ADD COLUMN IF NOT EXISTS is_project       BOOLEAN,
     ADD COLUMN IF NOT EXISTS is_project_unit  BOOLEAN,
     ADD COLUMN IF NOT EXISTS format_seen_at   TIMESTAMPTZ`,
  // One row per change in a listing's format (first sighting included), so a
  // listing moving paid -> free, or upgrading, is visible with its date.
  `CREATE TABLE IF NOT EXISTS hemnet_listing_format_history (
     hemnet_id        BIGINT      NOT NULL,
     observed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
     active_package   TEXT,
     is_teaser        BOOLEAN,
     listing_typename TEXT,
     is_project       BOOLEAN,
     is_project_unit  BOOLEAN,
     PRIMARY KEY (hemnet_id, observed_at)
   )`,
];

const DOWN = [
  `DROP TABLE IF EXISTS hemnet_listing_format_history`,
  `ALTER TABLE hemnet_listingv2
     DROP COLUMN IF EXISTS active_package,
     DROP COLUMN IF EXISTS is_teaser,
     DROP COLUMN IF EXISTS listing_typename,
     DROP COLUMN IF EXISTS is_project,
     DROP COLUMN IF EXISTS is_project_unit,
     DROP COLUMN IF EXISTS format_seen_at`,
];

async function run() {
  const down = process.argv.includes('--down');
  const client = createClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const sql of down ? DOWN : UP) await client.query(sql);
    await client.query('COMMIT');
    console.log(down ? 'listing-format tracking removed' : 'listing-format tracking ready');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { UP, DOWN };
