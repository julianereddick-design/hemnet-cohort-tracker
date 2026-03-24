const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Connected. Running data repair for date: ${today}\n`);

  // Find all pairs with at least one drop date set
  const dropped = await client.query(`
    SELECT cp.id, cp.cohort_id, cp.booli_id, cp.hemnet_id,
           cp.dropped_booli_on, cp.dropped_hemnet_on
    FROM cohort_pairs cp
    WHERE cp.dropped_hemnet_on IS NOT NULL OR cp.dropped_booli_on IS NOT NULL
  `);

  console.log(`Found ${dropped.rows.length} pairs with drop dates set. Checking source listings...\n`);

  const recovered = {}; // keyed by cohort_id -> { hemnet: N, booli: N }
  let totalChecked = 0;
  let totalRecovered = 0;

  for (const pair of dropped.rows) {
    totalChecked++;
    let recoverHemnet = false;
    let recoverBooli = false;
    let hemnetViews = null;
    let booliViews = null;

    // Check Hemnet source listing
    // Use MAX(times_viewed) WHERE is_active=true to handle duplicate hemnet_id rows
    if (pair.dropped_hemnet_on) {
      const hRes = await client.query(
        'SELECT MAX(times_viewed) AS times_viewed FROM hemnet_listingv2 WHERE hemnet_id = $1 AND is_active = true',
        [pair.hemnet_id]
      );
      if (hRes.rows.length > 0 && hRes.rows[0].times_viewed !== null) {
        recoverHemnet = true;
        hemnetViews = hRes.rows[0].times_viewed;
      }
    }

    // Check Booli source listing
    // Use MAX(times_viewed) WHERE is_active=true to handle any duplicate booli_id rows
    if (pair.dropped_booli_on) {
      const bRes = await client.query(
        'SELECT MAX(times_viewed) AS times_viewed FROM booli_listing WHERE booli_id = $1 AND is_active = true',
        [pair.booli_id]
      );
      if (bRes.rows.length > 0 && bRes.rows[0].times_viewed !== null) {
        recoverBooli = true;
        booliViews = bRes.rows[0].times_viewed;
      }
    }

    if (recoverHemnet || recoverBooli) {
      totalRecovered++;

      // Clear drop dates for recovered sides
      if (recoverHemnet) {
        await client.query(
          'UPDATE cohort_pairs SET dropped_hemnet_on = NULL WHERE id = $1',
          [pair.id]
        );
      }
      if (recoverBooli) {
        await client.query(
          'UPDATE cohort_pairs SET dropped_booli_on = NULL WHERE id = $1',
          [pair.id]
        );
      }

      // Backfill today's view counts (only for recovered sides; other side stays null)
      await client.query(`
        INSERT INTO cohort_daily_views (pair_id, date, booli_views, hemnet_views)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (pair_id, date) DO NOTHING
      `, [pair.id, today, booliViews, hemnetViews]);

      // Accumulate per-cohort recovery counts
      if (!recovered[pair.cohort_id]) {
        recovered[pair.cohort_id] = { hemnet: 0, booli: 0 };
      }
      if (recoverHemnet) recovered[pair.cohort_id].hemnet++;
      if (recoverBooli) recovered[pair.cohort_id].booli++;
    }
  }

  // Report results
  console.log('Repair complete:');
  for (const [cohortId, counts] of Object.entries(recovered).sort()) {
    console.log(`  ${cohortId}: ${counts.hemnet} Hemnet recovered, ${counts.booli} Booli recovered`);
  }
  console.log(`\nTotal pairs checked: ${totalChecked}`);
  console.log(`Total pairs recovered: ${totalRecovered}`);

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
