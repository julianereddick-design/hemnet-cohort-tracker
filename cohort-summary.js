const { createClient } = require('./db');

async function run() {
  const c = createClient();
  await c.connect();

  const r = await c.query(`
    SELECT
      cdv.day,
      count(*) as pairs,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cdv.hemnet_delta))::numeric, 0) AS hemnet_median,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cdv.booli_delta))::numeric, 0) AS booli_median,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY cdv.hemnet_delta::float / cdv.booli_delta
      ) FILTER (WHERE cdv.booli_delta > 0 AND cdv.hemnet_delta > 0))::numeric, 2) AS median_ratio
    FROM cohort_daily_views cdv
    WHERE cdv.cohort_id = '2026-W09'
      AND cdv.hemnet_delta IS NOT NULL
      AND cdv.booli_delta IS NOT NULL
    GROUP BY cdv.day
    ORDER BY cdv.day
  `);

  console.log('Cohort 2026-W09 — View Accumulation by Day');
  console.log('Day | Pairs | Hemnet Med | Booli Med | Median H/B');
  console.log('----|-------|------------|-----------|----------');
  for (const row of r.rows) {
    console.log(
      String(row.day).padStart(3) + ' | ' +
      String(row.pairs).padStart(5) + ' | ' +
      String(row.hemnet_median).padStart(10) + ' | ' +
      String(row.booli_median).padStart(9) + ' | ' +
      String(row.median_ratio || 'N/A').padStart(9)
    );
  }

  await c.end();
}

run().catch(e => { console.error(e); process.exit(1); });
