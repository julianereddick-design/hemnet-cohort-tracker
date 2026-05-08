// scripts/verf03-snapshot.js — VERF-03 pre/post snapshot helper.
//
// Runs the same DISTINCT cohort-id query the refresh job uses, then for
// each of the first 20 ids reads MAX(times_viewed) WHERE is_active=true
// from hemnet_listingv2 and BOOL_OR(is_active). Prints a table and a
// one-line summary.
//
// Run twice — once before VERF-03 wet-run, once after. Compare visually:
// the 17 active ids should jump up (DB was stale ~2 weeks); the 3
// inactive ids should flip to db_active=false.
//
// Read-only.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('../db');

async function main() {
  const client = createClient();
  await client.connect();
  try {
    const r = await client.query(
      "SELECT cp.hemnet_id, " +
      "       MAX(h.times_viewed) AS db_views, " +
      "       BOOL_OR(h.is_active) AS db_active " +
      "FROM cohort_pairs cp " +
      "JOIN cohorts c ON c.cohort_id = cp.cohort_id " +
      "LEFT JOIN hemnet_listingv2 h ON h.hemnet_id = cp.hemnet_id AND h.is_active = true " +
      "WHERE c.week_start >= CURRENT_DATE - INTERVAL '12 weeks' " +
      "  AND cp.dropped_hemnet_on IS NULL " +
      "GROUP BY cp.hemnet_id " +
      "ORDER BY cp.hemnet_id " +
      "LIMIT 20",
    );

    const rows = r.rows.map((row) => ({
      hemnet_id: row.hemnet_id,
      db_views: row.db_views,
      db_active: row.db_active,
    }));

    console.table(rows);

    const active = rows.filter((x) => x.db_active === true).length;
    const inactive = rows.filter((x) => x.db_active !== true).length;
    const totalViews = rows.reduce((acc, x) => acc + (Number(x.db_views) || 0), 0);
    console.log(`\nSummary: ${rows.length} ids | ${active} active | ${inactive} inactive | total views: ${totalViews}`);
  } finally {
    try { await client.end(); } catch (_) { /* best effort */ }
  }
}

main().catch((err) => {
  console.error('SNAPSHOT FATAL:', err && err.message);
  process.exit(1);
});
