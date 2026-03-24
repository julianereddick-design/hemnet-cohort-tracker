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
    return {
      cohortsTracked: 0,
      totalTracked: 0,
      totalSkipped: 0,
      totalDroppedBooli: 0,
      totalDroppedHemnet: 0,
      totalStreakBooli: 0,
      totalStreakHemnet: 0,
      totalRecoveredBooli: 0,
      totalRecoveredHemnet: 0,
    };
  }

  log('INFO', `Tracking ${cohorts.rows.length} active cohort(s) for ${today}`);

  let totalTracked = 0;
  let totalSkipped = 0;
  let totalDroppedBooli = 0;
  let totalDroppedHemnet = 0;
  let totalStreakBooli = 0;
  let totalStreakHemnet = 0;
  let totalRecoveredBooli = 0;
  let totalRecoveredHemnet = 0;
  let totalNullBooli = 0;
  let totalNullHemnet = 0;
  let newestCohortNullPct = null;

  for (const cohort of cohorts.rows) {
    const pairs = await client.query(`
      SELECT cp.id, cp.booli_id, cp.hemnet_id,
             cp.dropped_booli_on, cp.dropped_hemnet_on,
             cp.drop_streak_booli, cp.drop_streak_hemnet,
             cp.booli_listed::text AS booli_listed
      FROM cohort_pairs cp
      WHERE cp.cohort_id = $1
    `, [cohort.cohort_id]);

    let tracked = 0;
    let skipped = 0;
    let droppedBooli = 0;
    let droppedHemnet = 0;
    let streakIncBooli = 0;
    let streakIncHemnet = 0;
    let recoveredBooli = 0;
    let recoveredHemnet = 0;
    let nullBooli = 0;
    let nullHemnet = 0;

    for (const pair of pairs.rows) {
      const dayNum = daysBetween(pair.booli_listed, today);
      if (dayNum < 0 || dayNum > 30) {
        skipped++;
        continue;
      }

      let booliViews = null;
      let hemnetViews = null;

      // --- Booli processing ---
      if (pair.dropped_booli_on) {
        // RECOVERY PATH: recheck previously dropped pair
        const bRes = await client.query(
          'SELECT times_viewed, is_active FROM booli_listing WHERE booli_id = $1',
          [pair.booli_id]
        );
        if (bRes.rows.length > 0 && bRes.rows[0].is_active) {
          // Listing is active again — clear drop date and resume tracking
          await client.query(
            'UPDATE cohort_pairs SET dropped_booli_on = NULL, drop_streak_booli = 0 WHERE id = $1',
            [pair.id]
          );
          booliViews = bRes.rows[0].times_viewed;
          recoveredBooli++;
        }
        // If still inactive, leave dropped_booli_on as-is
      } else {
        // NORMAL/STREAK PATH
        const bRes = await client.query(
          'SELECT times_viewed, is_active FROM booli_listing WHERE booli_id = $1',
          [pair.booli_id]
        );
        if (bRes.rows.length > 0 && bRes.rows[0].is_active) {
          booliViews = bRes.rows[0].times_viewed;
          if (pair.drop_streak_booli > 0) {
            // Reset streak since listing is active
            await client.query(
              'UPDATE cohort_pairs SET drop_streak_booli = 0 WHERE id = $1',
              [pair.id]
            );
          }
        } else {
          // Listing inactive — increment streak
          const newStreak = pair.drop_streak_booli + 1;
          if (newStreak >= 10) {
            // Threshold reached — mark as dropped
            await client.query(
              'UPDATE cohort_pairs SET dropped_booli_on = $1, drop_streak_booli = 0 WHERE id = $2',
              [today, pair.id]
            );
            droppedBooli++;
          } else {
            await client.query(
              'UPDATE cohort_pairs SET drop_streak_booli = $1 WHERE id = $2',
              [newStreak, pair.id]
            );
            streakIncBooli++;
          }
        }
      }

      // --- Hemnet processing ---
      // CRITICAL: hemnet_listingv2 has duplicate rows per hemnet_id.
      // Use MAX(times_viewed) WHERE is_active=true — NULL result means no active row.
      if (pair.dropped_hemnet_on) {
        // RECOVERY PATH: recheck previously dropped pair
        const hRes = await client.query(
          'SELECT MAX(times_viewed) AS times_viewed FROM hemnet_listingv2 WHERE hemnet_id = $1 AND is_active = true',
          [pair.hemnet_id]
        );
        if (hRes.rows[0].times_viewed !== null) {
          // Listing is active again — clear drop date and resume tracking
          await client.query(
            'UPDATE cohort_pairs SET dropped_hemnet_on = NULL, drop_streak_hemnet = 0 WHERE id = $1',
            [pair.id]
          );
          hemnetViews = hRes.rows[0].times_viewed;
          recoveredHemnet++;
        }
        // If still inactive (NULL result), leave dropped_hemnet_on as-is
      } else {
        // NORMAL/STREAK PATH
        const hRes = await client.query(
          'SELECT MAX(times_viewed) AS times_viewed FROM hemnet_listingv2 WHERE hemnet_id = $1 AND is_active = true',
          [pair.hemnet_id]
        );
        if (hRes.rows[0].times_viewed !== null) {
          hemnetViews = hRes.rows[0].times_viewed;
          if (pair.drop_streak_hemnet > 0) {
            // Reset streak since listing is active
            await client.query(
              'UPDATE cohort_pairs SET drop_streak_hemnet = 0 WHERE id = $1',
              [pair.id]
            );
          }
        } else {
          // Listing inactive — increment streak
          const newStreak = pair.drop_streak_hemnet + 1;
          if (newStreak >= 10) {
            // Threshold reached — mark as dropped
            await client.query(
              'UPDATE cohort_pairs SET dropped_hemnet_on = $1, drop_streak_hemnet = 0 WHERE id = $2',
              [today, pair.id]
            );
            droppedHemnet++;
          } else {
            await client.query(
              'UPDATE cohort_pairs SET drop_streak_hemnet = $1 WHERE id = $2',
              [newStreak, pair.id]
            );
            streakIncHemnet++;
          }
        }
      }

      await client.query(`
        INSERT INTO cohort_daily_views (pair_id, date, booli_views, hemnet_views)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (pair_id, date) DO NOTHING
      `, [pair.id, today, booliViews, hemnetViews]);

      if (booliViews === null) nullBooli++;
      if (hemnetViews === null) nullHemnet++;

      tracked++;
    }

    log('INFO', `${cohort.cohort_id}: tracked ${tracked}, skipped ${skipped} (>30d)` +
      (streakIncBooli ? `, ${streakIncBooli} Booli streak++` : '') +
      (streakIncHemnet ? `, ${streakIncHemnet} Hemnet streak++` : '') +
      (droppedBooli ? `, ${droppedBooli} Booli DROPPED` : '') +
      (droppedHemnet ? `, ${droppedHemnet} Hemnet DROPPED` : '') +
      (recoveredBooli ? `, ${recoveredBooli} Booli RECOVERED` : '') +
      (recoveredHemnet ? `, ${recoveredHemnet} Hemnet RECOVERED` : '') +
      (nullBooli ? `, ${nullBooli} Booli null` : '') +
      (nullHemnet ? `, ${nullHemnet} Hemnet null` : ''));

    totalTracked += tracked;
    totalSkipped += skipped;
    totalDroppedBooli += droppedBooli;
    totalDroppedHemnet += droppedHemnet;
    totalStreakBooli += streakIncBooli;
    totalStreakHemnet += streakIncHemnet;
    totalRecoveredBooli += recoveredBooli;
    totalRecoveredHemnet += recoveredHemnet;
    totalNullBooli += nullBooli;
    totalNullHemnet += nullHemnet;

    // Track newest cohort null rates (last cohort in ordered list = newest)
    if (tracked > 0) {
      newestCohortNullPct = {
        booli: nullBooli / tracked,
        hemnet: nullHemnet / tracked,
      };
    }
  }

  log('INFO', `Done. Tracked: ${totalTracked}, Skipped: ${totalSkipped}` +
    `, Dropped: ${totalDroppedBooli} Booli / ${totalDroppedHemnet} Hemnet` +
    (totalStreakBooli || totalStreakHemnet ? `, Streak++: ${totalStreakBooli} Booli / ${totalStreakHemnet} Hemnet` : '') +
    (totalRecoveredBooli || totalRecoveredHemnet ? `, Recovered: ${totalRecoveredBooli} Booli / ${totalRecoveredHemnet} Hemnet` : '') +
    `, NullViews: ${totalNullBooli} Booli / ${totalNullHemnet} Hemnet`);

  return {
    cohortsTracked: cohorts.rows.length,
    totalTracked,
    totalSkipped,
    totalDroppedBooli,
    totalDroppedHemnet,
    totalStreakBooli,
    totalStreakHemnet,
    totalRecoveredBooli,
    totalRecoveredHemnet,
    totalNullBooli,
    totalNullHemnet,
    newestCohortNullPct,
  };
}

runJob({
  scriptName: 'cohort-track',
  main,
  validate: (summary) => {
    if (summary.totalTracked === 0 && summary.cohortsTracked > 0) {
      return `0 pairs tracked across ${summary.cohortsTracked} active cohort(s) — expected hundreds`;
    }
    if (summary.totalTracked > 0) {
      const warnings = [];
      const booliPct = summary.totalNullBooli / summary.totalTracked;
      const hemnetPct = summary.totalNullHemnet / summary.totalTracked;
      if (booliPct > 0.8) warnings.push(`${Math.round(booliPct * 100)}% of all pairs have null Booli views`);
      if (hemnetPct > 0.8) warnings.push(`${Math.round(hemnetPct * 100)}% of all pairs have null Hemnet views`);
      const nc = summary.newestCohortNullPct;
      if (nc) {
        if (nc.booli > 0.3) warnings.push(`Newest cohort: ${Math.round(nc.booli * 100)}% null Booli views — scraper may be down`);
        if (nc.hemnet > 0.3) warnings.push(`Newest cohort: ${Math.round(nc.hemnet * 100)}% null Hemnet views — scraper may be down`);
      }
      if (warnings.length > 0) return warnings.join('; ');
    }
    return null;
  },
});
