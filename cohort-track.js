const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();

  const today = new Date().toISOString().slice(0, 10);

  // Find all active cohorts (created within the last 30 days)
  const cohorts = await client.query(`
    SELECT cohort_id, week_start FROM cohorts
    WHERE week_start >= CURRENT_DATE - INTERVAL '37 days'
    ORDER BY week_start
  `);

  if (cohorts.rows.length === 0) {
    console.log('No active cohorts to track.');
    await client.end();
    return;
  }

  console.log(`Tracking ${cohorts.rows.length} active cohort(s) for ${today}\n`);

  let totalTracked = 0;
  let totalDroppedBooli = 0;
  let totalDroppedHemnet = 0;

  for (const cohort of cohorts.rows) {
    const dayNum = Math.floor(
      (new Date(today) - new Date(cohort.week_start)) / 86400000
    );

    // Skip if beyond 30 days
    if (dayNum > 30) {
      console.log(`  ${cohort.cohort_id}: day ${dayNum} > 30, skipping`);
      continue;
    }

    // Get all pairs for this cohort
    const pairs = await client.query(`
      SELECT cp.id, cp.booli_id, cp.hemnet_id,
             cp.booli_views_day0, cp.hemnet_views_day0,
             cp.dropped_booli_on, cp.dropped_hemnet_on
      FROM cohort_pairs cp
      WHERE cp.cohort_id = $1
    `, [cohort.cohort_id]);

    let tracked = 0;
    let droppedBooli = 0;
    let droppedHemnet = 0;

    for (const pair of pairs.rows) {
      // Skip if already tracked for this day
      const exists = await client.query(
        'SELECT 1 FROM cohort_daily_views WHERE pair_id = $1 AND day = $2',
        [pair.id, dayNum]
      );
      if (exists.rows.length > 0) continue;

      // Look up current views
      let booliViews = null;
      let hemnetViews = null;

      if (!pair.dropped_booli_on) {
        const bRes = await client.query(
          'SELECT times_viewed, is_active FROM booli_listing WHERE booli_id = $1',
          [pair.booli_id]
        );
        if (bRes.rows.length > 0 && bRes.rows[0].is_active) {
          booliViews = bRes.rows[0].times_viewed;
        } else {
          // Mark as dropped
          await client.query(
            'UPDATE cohort_pairs SET dropped_booli_on = $1 WHERE id = $2',
            [today, pair.id]
          );
          droppedBooli++;
          // Still record last known views if available
          if (bRes.rows.length > 0) booliViews = bRes.rows[0].times_viewed;
        }
      }

      if (!pair.dropped_hemnet_on) {
        const hRes = await client.query(
          'SELECT times_viewed, is_active FROM hemnet_listingv2 WHERE hemnet_id = $1',
          [pair.hemnet_id]
        );
        if (hRes.rows.length > 0 && hRes.rows[0].is_active) {
          hemnetViews = hRes.rows[0].times_viewed;
        } else {
          await client.query(
            'UPDATE cohort_pairs SET dropped_hemnet_on = $1 WHERE id = $2',
            [today, pair.id]
          );
          droppedHemnet++;
          if (hRes.rows.length > 0) hemnetViews = hRes.rows[0].times_viewed;
        }
      }

      // Compute deltas (views decrease -> set delta to 0)
      let booliDelta = null;
      let hemnetDelta = null;
      if (booliViews !== null) {
        booliDelta = Math.max(0, booliViews - pair.booli_views_day0);
      }
      if (hemnetViews !== null) {
        hemnetDelta = Math.max(0, hemnetViews - pair.hemnet_views_day0);
      }

      await client.query(`
        INSERT INTO cohort_daily_views
          (cohort_id, pair_id, day, date, booli_views, hemnet_views, booli_delta, hemnet_delta)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (pair_id, day) DO NOTHING
      `, [cohort.cohort_id, pair.id, dayNum, today, booliViews, hemnetViews, booliDelta, hemnetDelta]);

      tracked++;
    }

    console.log(`  ${cohort.cohort_id}: day ${dayNum}, tracked ${tracked} pairs` +
      (droppedBooli ? `, ${droppedBooli} Booli dropped` : '') +
      (droppedHemnet ? `, ${droppedHemnet} Hemnet dropped` : ''));

    totalTracked += tracked;
    totalDroppedBooli += droppedBooli;
    totalDroppedHemnet += droppedHemnet;
  }

  console.log(`\nDone. Tracked ${totalTracked} pairs total.`);
  if (totalDroppedBooli || totalDroppedHemnet) {
    console.log(`Dropped: ${totalDroppedBooli} Booli, ${totalDroppedHemnet} Hemnet`);
  }

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
