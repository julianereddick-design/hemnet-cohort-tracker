const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();

  try {
    const res = await client.query(`
      SELECT
        'booli' AS source,
        COUNT(*) AS pairs_checked,
        COUNT(*) FILTER (WHERE today.booli_views != yesterday.booli_views) AS views_changed,
        COUNT(*) FILTER (WHERE today.booli_views = yesterday.booli_views) AS views_same
      FROM cohort_daily_views today
      JOIN cohort_daily_views yesterday ON today.pair_id = yesterday.pair_id
        AND today.date = yesterday.date + 1
      WHERE today.date = CURRENT_DATE
        AND today.booli_views IS NOT NULL
        AND yesterday.booli_views IS NOT NULL
      UNION ALL
      SELECT
        'hemnet' AS source,
        COUNT(*) AS pairs_checked,
        COUNT(*) FILTER (WHERE today.hemnet_views != yesterday.hemnet_views) AS views_changed,
        COUNT(*) FILTER (WHERE today.hemnet_views = yesterday.hemnet_views) AS views_same
      FROM cohort_daily_views today
      JOIN cohort_daily_views yesterday ON today.pair_id = yesterday.pair_id
        AND today.date = yesterday.date + 1
      WHERE today.date = CURRENT_DATE
        AND today.hemnet_views IS NOT NULL
        AND yesterday.hemnet_views IS NOT NULL
    `);

    console.log('\n=== Data Freshness Check ===\n');

    let allFresh = true;

    for (const row of res.rows) {
      const pairsChecked = parseInt(row.pairs_checked, 10);
      const viewsChanged = parseInt(row.views_changed, 10);
      const viewsSame = parseInt(row.views_same, 10);
      const changeRate = pairsChecked > 0
        ? ((viewsChanged / pairsChecked) * 100).toFixed(1)
        : '0.0';

      console.log(`${row.source.toUpperCase()}:`);
      console.log(`  Pairs checked:  ${pairsChecked}`);
      console.log(`  Views changed:  ${viewsChanged} (${changeRate}%)`);
      console.log(`  Views same:     ${viewsSame}`);
      console.log('');

      if (pairsChecked === 0 || viewsChanged / pairsChecked <= 0.5) {
        allFresh = false;
      }
    }

    if (allFresh) {
      console.log('FRESH -- source data is updating');
      process.exit(0);
    } else {
      console.log('WARNING -- source data may be stale');
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
