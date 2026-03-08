const { runJob } = require('./cron-wrapper');

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T00:00:00');
  const b = new Date(dateStrB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

async function main(client, log) {
  const today = new Date().toISOString().slice(0, 10);

  const cohorts = await client.query(`
    SELECT cohort_id, week_start FROM cohorts
    WHERE week_start >= CURRENT_DATE - INTERVAL '44 days'
    ORDER BY week_start
  `);

  if (cohorts.rows.length === 0) {
    log('INFO', 'No active cohorts to track.');
    return { cohortsTracked: 0, totalTracked: 0, totalDroppedBooli: 0, totalDroppedHemnet: 0 };
  }

  log('INFO', `Tracking ${cohorts.rows.length} active cohort(s) for ${today}`);

  let totalTracked = 0;
  let totalDroppedBooli = 0;
  let totalDroppedHemnet = 0;

  for (const cohort of cohorts.rows) {
    const pairs = await client.query(`
      SELECT cp.id, cp.booli_id, cp.hemnet_id,
             cp.booli_views_day0, cp.hemnet_views_day0,
             cp.dropped_booli_on, cp.dropped_hemnet_on,
             cp.booli_listed::text AS booli_listed
      FROM cohort_pairs cp
      WHERE cp.cohort_id = $1
    `, [cohort.cohort_id]);

    let tracked = 0;
    let droppedBooli = 0;
    let droppedHemnet = 0;

    for (const pair of pairs.rows) {
      const dayNum = daysBetween(pair.booli_listed, today);
      if (dayNum < 0 || dayNum > 30) continue;

      const exists = await client.query(
        'SELECT 1 FROM cohort_daily_views WHERE pair_id = $1 AND date = $2',
        [pair.id, today]
      );
      if (exists.rows.length > 0) continue;

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
          await client.query(
            'UPDATE cohort_pairs SET dropped_booli_on = $1 WHERE id = $2',
            [today, pair.id]
          );
          droppedBooli++;
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
        }
      }

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
        ON CONFLICT (pair_id, date) DO NOTHING
      `, [cohort.cohort_id, pair.id, dayNum, today, booliViews, hemnetViews, booliDelta, hemnetDelta]);

      tracked++;
    }

    log('INFO', `${cohort.cohort_id}: tracked ${tracked} pairs` +
      (droppedBooli ? `, ${droppedBooli} Booli dropped` : '') +
      (droppedHemnet ? `, ${droppedHemnet} Hemnet dropped` : ''));

    totalTracked += tracked;
    totalDroppedBooli += droppedBooli;
    totalDroppedHemnet += droppedHemnet;
  }

  log('INFO', `Done. Tracked ${totalTracked} pairs total.`);
  if (totalDroppedBooli || totalDroppedHemnet) {
    log('INFO', `Dropped: ${totalDroppedBooli} Booli, ${totalDroppedHemnet} Hemnet`);
  }

  return {
    cohortsTracked: cohorts.rows.length,
    totalTracked,
    totalDroppedBooli,
    totalDroppedHemnet,
  };
}

runJob({
  scriptName: 'cohort-track',
  main,
  validate: (summary) => {
    if (summary.totalTracked === 0 && summary.cohortsTracked > 0) {
      return `0 pairs tracked across ${summary.cohortsTracked} active cohort(s) — expected hundreds`;
    }
    return null;
  },
});
