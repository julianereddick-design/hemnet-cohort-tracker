const { createClient } = require('../db');

(async () => {
  const c = createClient();
  await c.connect();
  const r = await c.query(`
    SELECT cp.cohort_id,
           COUNT(DISTINCT cp.id) AS pairs,
           MIN(dv.date)::text AS first_date,
           MAX(dv.date)::text AS last_date,
           COUNT(DISTINCT dv.date) AS tracked_dates
    FROM cohort_pairs cp
    LEFT JOIN cohort_daily_views dv ON dv.pair_id = cp.id
    GROUP BY cp.cohort_id
    ORDER BY cp.cohort_id
  `);
  console.table(r.rows);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
