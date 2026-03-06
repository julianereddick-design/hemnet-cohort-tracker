const { createClient } = require('./db');

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const MIN_PAIRS = 30;

async function run() {
  const client = createClient();
  await client.connect();

  // Which cohort to report on? Default: most recent, or pass as CLI arg
  const argCohort = process.argv[2];
  let cohortId;

  if (argCohort) {
    cohortId = argCohort;
  } else {
    const latest = await client.query('SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1');
    if (latest.rows.length === 0) {
      console.log('No cohorts found.');
      await client.end();
      return;
    }
    cohortId = latest.rows[0].cohort_id;
  }

  console.log(`\n=== Cohort Report: ${cohortId} ===\n`);

  // Get cohort info
  const cohortInfo = await client.query('SELECT * FROM cohorts WHERE cohort_id = $1', [cohortId]);
  if (cohortInfo.rows.length === 0) {
    console.log(`Cohort ${cohortId} not found.`);
    await client.end();
    return;
  }
  const cohort = cohortInfo.rows[0];
  console.log(`Week: ${cohort.week_start.toISOString().slice(0, 10)} to ${cohort.week_end.toISOString().slice(0, 10)}`);

  // Get all pairs with their county
  const pairs = await client.query(`
    SELECT cp.id, cp.county, cp.booli_views_day0, cp.hemnet_views_day0,
           cp.dropped_booli_on, cp.dropped_hemnet_on
    FROM cohort_pairs cp
    WHERE cp.cohort_id = $1
  `, [cohortId]);

  console.log(`Total matched pairs: ${pairs.rows.length}\n`);

  // County breakdown
  const countyCount = {};
  for (const p of pairs.rows) {
    countyCount[p.county] = (countyCount[p.county] || 0) + 1;
  }
  console.log('Pairs by county:');
  for (const [county, cnt] of Object.entries(countyCount).sort((a, b) => b[1] - a[1])) {
    const flag = cnt < MIN_PAIRS ? ' (below minimum)' : '';
    console.log(`  ${county}: ${cnt}${flag}`);
  }

  // Get all daily view data
  const views = await client.query(`
    SELECT dv.pair_id, dv.day, dv.booli_delta, dv.hemnet_delta, cp.county
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE dv.cohort_id = $1
      AND dv.booli_delta IS NOT NULL
      AND dv.hemnet_delta IS NOT NULL
    ORDER BY dv.day
  `, [cohortId]);

  // Group by day and level (county + "Total")
  const levels = ['Total', ...Object.keys(countyCount).sort()];
  const maxDay = views.rows.reduce((m, r) => Math.max(m, r.day), 0);

  console.log('\n--- View Accumulation Summary ---\n');

  for (const level of levels) {
    // Check minimum pairs
    if (level !== 'Total' && (countyCount[level] || 0) < MIN_PAIRS) continue;

    console.log(`\n[${level}]`);
    console.log(
      'Day'.padStart(4) +
      'Pairs'.padStart(7) +
      'H Med'.padStart(8) +
      'B Med'.padStart(8) +
      'Ratio'.padStart(8) +
      'H Mean'.padStart(8) +
      'B Mean'.padStart(8) +
      'H P75'.padStart(8) +
      'B P75'.padStart(8)
    );
    console.log('-'.repeat(67));

    for (let d = 0; d <= maxDay; d++) {
      const dayRows = views.rows.filter(r =>
        r.day === d && (level === 'Total' || r.county === level)
      );
      if (dayRows.length === 0) continue;

      const hDeltas = dayRows.map(r => r.hemnet_delta);
      const bDeltas = dayRows.map(r => r.booli_delta);

      const hMed = median(hDeltas);
      const bMed = median(bDeltas);
      const ratio = bMed > 0 ? (hMed / bMed).toFixed(1) : '—';

      console.log(
        String(d).padStart(4) +
        String(dayRows.length).padStart(7) +
        String(Math.round(hMed)).padStart(8) +
        String(Math.round(bMed)).padStart(8) +
        String(ratio).padStart(8) +
        String(Math.round(mean(hDeltas))).padStart(8) +
        String(Math.round(mean(bDeltas))).padStart(8) +
        String(Math.round(percentile(hDeltas, 75))).padStart(8) +
        String(Math.round(percentile(bDeltas, 75))).padStart(8)
      );
    }
  }

  // Match rate
  const unmatchedCount = await client.query(
    'SELECT COUNT(*) as cnt FROM cohort_unmatched WHERE cohort_id = $1', [cohortId]
  );
  const totalBooli = pairs.rows.length + Number(unmatchedCount.rows[0].cnt);
  console.log(`\n--- Match Rate ---`);
  console.log(`  Booli listings: ${totalBooli}`);
  console.log(`  Matched: ${pairs.rows.length} (${((pairs.rows.length / totalBooli) * 100).toFixed(1)}%)`);
  console.log(`  Unmatched: ${unmatchedCount.rows[0].cnt}`);

  // Dropped listings
  const droppedBooli = pairs.rows.filter(p => p.dropped_booli_on).length;
  const droppedHemnet = pairs.rows.filter(p => p.dropped_hemnet_on).length;
  if (droppedBooli || droppedHemnet) {
    console.log(`\n--- Dropped Listings ---`);
    console.log(`  Booli: ${droppedBooli}`);
    console.log(`  Hemnet: ${droppedHemnet}`);
  }

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
