const { createClient } = require('./db');

const COHORT_ID = process.argv[2] || '2026-W09';

async function run() {
  const client = createClient();
  await client.connect();

  // Verify cohort exists
  const cohort = await client.query('SELECT * FROM cohorts WHERE cohort_id = $1', [COHORT_ID]);
  if (cohort.rows.length === 0) {
    console.log(`Cohort ${COHORT_ID} not found.`);
    await client.end();
    return;
  }
  console.log(`Backfilling cohort ${COHORT_ID}\n`);

  // Get all pairs (use ::text to avoid JS timezone mangling of DATE columns)
  const pairs = await client.query(`
    SELECT id, booli_id, hemnet_id, booli_listed::text as booli_listed
    FROM cohort_pairs
    WHERE cohort_id = $1
  `, [COHORT_ID]);

  console.log(`Found ${pairs.rows.length} pairs`);

  // Step 1: Clear existing daily views for this cohort
  const deleted = await client.query(
    'DELETE FROM cohort_daily_views WHERE cohort_id = $1',
    [COHORT_ID]
  );
  console.log(`Cleared ${deleted.rowCount} existing daily_views rows\n`);

  // Step 2: Batch-fetch all historical snapshots for all pairs
  const booliIds = pairs.rows.map(p => p.booli_id);
  const hemnetIds = pairs.rows.map(p => p.hemnet_id);

  // Booli: last snapshot per (booli_id, calendar day in Stockholm time)
  const booliSnaps = await client.query(`
    SELECT DISTINCT ON (booli_id, snap_date)
      booli_id,
      (history_date AT TIME ZONE 'Europe/Stockholm')::date::text AS snap_date,
      times_viewed
    FROM booli_historicallisting
    WHERE booli_id = ANY($1)
    ORDER BY booli_id, snap_date, history_date DESC
  `, [booliIds]);

  console.log(`Booli snapshots: ${booliSnaps.rows.length}`);

  // Hemnet: last snapshot per (hemnet_id, calendar day in Stockholm time)
  const hemnetSnaps = await client.query(`
    SELECT DISTINCT ON (hemnet_id, snap_date)
      hemnet_id,
      (history_date AT TIME ZONE 'Europe/Stockholm')::date::text AS snap_date,
      times_viewed
    FROM hemnet_historicallistingv2
    WHERE hemnet_id = ANY($1)
    ORDER BY hemnet_id, snap_date, history_date DESC
  `, [hemnetIds]);

  console.log(`Hemnet snapshots: ${hemnetSnaps.rows.length}\n`);

  // Index snapshots by id
  const booliByListing = {};
  for (const s of booliSnaps.rows) {
    if (!booliByListing[s.booli_id]) booliByListing[s.booli_id] = [];
    booliByListing[s.booli_id].push({ date: s.snap_date, views: s.times_viewed });
  }

  const hemnetByListing = {};
  for (const s of hemnetSnaps.rows) {
    if (!hemnetByListing[s.hemnet_id]) hemnetByListing[s.hemnet_id] = [];
    hemnetByListing[s.hemnet_id].push({ date: s.snap_date, views: s.times_viewed });
  }

  // Step 3: Process each pair
  let totalRows = 0;
  let pairsWithData = 0;

  // Collect all inserts for batch
  const insertValues = [];
  const day0Updates = []; // { pairId, booliDay0, hemnetDay0 }

  for (const pair of pairs.rows) {
    const listedDate = pair.booli_listed; // string like "2026-02-27"

    const booliSnapsForPair = (booliByListing[pair.booli_id] || [])
      .filter(s => s.date >= listedDate)
      .sort((a, b) => a.date.localeCompare(b.date));

    const hemnetSnapsForPair = (hemnetByListing[pair.hemnet_id] || [])
      .filter(s => s.date >= listedDate)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (booliSnapsForPair.length === 0 && hemnetSnapsForPair.length === 0) continue;

    // Day 0 views = earliest snapshot on or after listed date
    const booliDay0 = booliSnapsForPair.length > 0 ? booliSnapsForPair[0].views : 0;
    const hemnetDay0 = hemnetSnapsForPair.length > 0 ? hemnetSnapsForPair[0].views : 0;

    day0Updates.push({ pairId: pair.id, booliDay0, hemnetDay0 });

    // Collect all unique days from both platforms
    const allDays = new Set();
    for (const s of booliSnapsForPair) allDays.add(s.date);
    for (const s of hemnetSnapsForPair) allDays.add(s.date);

    // Index snapshots by date for quick lookup
    const booliByDate = {};
    for (const s of booliSnapsForPair) booliByDate[s.date] = s.views;
    const hemnetByDate = {};
    for (const s of hemnetSnapsForPair) hemnetByDate[s.date] = s.views;

    for (const snapDate of allDays) {
      const dayNum = daysBetween(listedDate, snapDate);
      if (dayNum < 0 || dayNum > 30) continue;

      const booliViews = booliByDate[snapDate] ?? null;
      const hemnetViews = hemnetByDate[snapDate] ?? null;

      const booliDelta = booliViews !== null ? Math.max(0, booliViews - booliDay0) : null;
      const hemnetDelta = hemnetViews !== null ? Math.max(0, hemnetViews - hemnetDay0) : null;

      insertValues.push([
        COHORT_ID, pair.id, dayNum, snapDate,
        booliViews, hemnetViews, booliDelta, hemnetDelta,
      ]);
      totalRows++;
    }

    pairsWithData++;
  }

  // Step 4: Update cohort_pairs day0 values
  console.log(`Updating day0 views for ${day0Updates.length} pairs...`);
  for (const u of day0Updates) {
    await client.query(
      'UPDATE cohort_pairs SET booli_views_day0 = $1, hemnet_views_day0 = $2 WHERE id = $3',
      [u.booliDay0, u.hemnetDay0, u.pairId]
    );
  }

  // Step 5: Batch insert daily views (chunks of 500)
  console.log(`Inserting ${totalRows} daily_views rows...`);
  const CHUNK = 500;
  for (let i = 0; i < insertValues.length; i += CHUNK) {
    const chunk = insertValues.slice(i, i + CHUNK);
    const placeholders = [];
    const params = [];
    for (let j = 0; j < chunk.length; j++) {
      const offset = j * 8;
      placeholders.push(
        `($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}::date, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8})`
      );
      params.push(...chunk[j]);
    }
    await client.query(`
      INSERT INTO cohort_daily_views
        (cohort_id, pair_id, day, date, booli_views, hemnet_views, booli_delta, hemnet_delta)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (pair_id, date) DO NOTHING
    `, params);
  }

  console.log(`\nDone. ${pairsWithData} pairs with data, ${totalRows} daily_views rows inserted.`);

  // Step 6: Summary stats
  const daySummary = await client.query(`
    SELECT day, COUNT(*) as cnt,
           COUNT(booli_delta) as booli_cnt,
           COUNT(hemnet_delta) as hemnet_cnt
    FROM cohort_daily_views
    WHERE cohort_id = $1
    GROUP BY day ORDER BY day
  `, [COHORT_ID]);

  console.log('\nRows per day:');
  console.log('Day'.padStart(4) + 'Total'.padStart(7) + 'Booli'.padStart(7) + 'Hemnet'.padStart(7));
  for (const r of daySummary.rows) {
    console.log(
      String(r.day).padStart(4) +
      String(r.cnt).padStart(7) +
      String(r.booli_cnt).padStart(7) +
      String(r.hemnet_cnt).padStart(7)
    );
  }

  await client.end();
}

function daysBetween(dateStrA, dateStrB) {
  // Both are "YYYY-MM-DD" strings, compute difference in days
  const a = new Date(dateStrA + 'T00:00:00');
  const b = new Date(dateStrB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
