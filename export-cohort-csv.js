const { createClient } = require('./db');
const fs = require('fs');

async function run() {
  const client = createClient();
  await client.connect();

  // Determine cohort ID: use argv[2] or fall back to latest cohort
  let cohortId = process.argv[2];
  if (!cohortId) {
    const latestRes = await client.query(`
      SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1
    `);
    if (latestRes.rows.length === 0) {
      console.error('No cohorts found in database');
      await client.end();
      process.exit(1);
    }
    cohortId = latestRes.rows[0].cohort_id;
    console.log(`No cohort specified, using latest: ${cohortId}`);
  }

  // Get all dates for this cohort (sorted) -- JOIN through cohort_pairs
  const datesRes = await client.query(`
    SELECT DISTINCT dv.date::text AS date
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
    ORDER BY date
  `, [cohortId]);
  const dates = datesRes.rows.map(r => r.date);

  // Get all pairs with info
  const pairsRes = await client.query(`
    SELECT id, booli_id, hemnet_id, county, booli_listed::text AS booli_listed
    FROM cohort_pairs
    WHERE cohort_id = $1
    ORDER BY county, id
  `, [cohortId]);

  // Get all daily view data -- JOIN through cohort_pairs
  const viewsRes = await client.query(`
    SELECT dv.pair_id, dv.date::text AS date, dv.booli_views, dv.hemnet_views
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
  `, [cohortId]);

  // Index views by pair_id + date
  const viewMap = {};
  for (const v of viewsRes.rows) {
    viewMap[`${v.pair_id}_${v.date}`] = v;
  }

  // Compute incremental views per pair (day-over-day change for consecutive dates)
  const incrMap = {};
  for (const pair of pairsRes.rows) {
    // Collect this pair's dates in sorted order
    const pairDates = dates.filter(d => viewMap[`${pair.id}_${d}`]);
    for (let i = 1; i < pairDates.length; i++) {
      const prev = viewMap[`${pair.id}_${pairDates[i - 1]}`];
      const curr = viewMap[`${pair.id}_${pairDates[i]}`];

      // Check dates are consecutive (1 day apart)
      const prevDate = new Date(pairDates[i - 1]);
      const currDate = new Date(pairDates[i]);
      const diffDays = (currDate - prevDate) / (1000 * 60 * 60 * 24);

      if (diffDays === 1 && curr.hemnet_views != null && prev.hemnet_views != null
          && curr.booli_views != null && prev.booli_views != null) {
        incrMap[`${pair.id}_${pairDates[i]}`] = {
          hemnet_incr: curr.hemnet_views - prev.hemnet_views,
          booli_incr: curr.booli_views - prev.booli_views,
        };
      }
    }
  }

  // Build CSV header: 4 columns per date (raw H, raw B, incremental H, incremental B)
  const headerParts = ['pair_id', 'booli_id', 'hemnet_id', 'county', 'booli_listed'];
  for (const d of dates) {
    headerParts.push(`H_${d}`);
    headerParts.push(`B_${d}`);
    headerParts.push(`H_incr_${d}`);
    headerParts.push(`B_incr_${d}`);
  }

  const lines = [headerParts.join(',')];

  for (const pair of pairsRes.rows) {
    const row = [
      pair.id,
      pair.booli_id,
      pair.hemnet_id,
      `"${pair.county}"`,
      pair.booli_listed,
    ];

    for (const d of dates) {
      const v = viewMap[`${pair.id}_${d}`];
      const incr = incrMap[`${pair.id}_${d}`];
      row.push(v ? (v.hemnet_views ?? '') : '');
      row.push(v ? (v.booli_views ?? '') : '');
      row.push(incr ? incr.hemnet_incr : '');
      row.push(incr ? incr.booli_incr : '');
    }

    lines.push(row.join(','));
  }

  const outFile = `cohort-${cohortId}-views.csv`;
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.log(`Wrote ${pairsRes.rows.length} pairs x ${dates.length} dates to ${outFile}`);
  console.log(`Dates: ${dates[0]} to ${dates[dates.length - 1]}`);

  await client.end();
}

module.exports = { run };

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
