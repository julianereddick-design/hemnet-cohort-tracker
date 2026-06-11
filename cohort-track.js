const { runJob } = require('./cron-wrapper');

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T00:00:00');
  const b = new Date(dateStrB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

async function main(client, log) {
  const today = new Date().toISOString().slice(0, 10);

  // 2026-05-15: aligned all cohort windows at 8 weeks. Outer sweep = 56 (8-week
  // tracking horizon) + 7 (week-span) = 63 days. Was 44 days (= 30 + 14 buffer).
  const cohorts = await client.query(`
    SELECT cohort_id, week_start FROM cohorts
    WHERE week_start >= CURRENT_DATE - INTERVAL '63 days'
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
  const perCohortNull = []; // { cohortId, tracked, nullBooli, nullHemnet }

  for (const cohort of cohorts.rows) {
    const pairs = await client.query(`
      SELECT cp.id, cp.booli_id, cp.hemnet_id,
             cp.dropped_booli_on, cp.dropped_hemnet_on,
             cp.drop_streak_booli, cp.drop_streak_hemnet,
             cp.booli_listed::text AS booli_listed
      FROM cohort_pairs cp
      WHERE cp.cohort_id = $1
        AND cp.removed_at IS NULL
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
      // 2026-05-15: per-pair tracking horizon widened 30 → 56 days (8 weeks)
      // to match the refresh window in Jobs A/D. Eliminates the Days 31-84
      // "refresh-but-don't-track" dead zone that wasted Oxylabs calls on
      // pairs whose time-series was no longer being written.
      const dayNum = daysBetween(pair.booli_listed, today);
      if (dayNum < 0 || dayNum > 56) {
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
          // D-11: threshold halved from 10 to 5 to compensate for cohort-track
          // moving from twice-daily to every-2-days (Plan 09-03 / D-07). Time-to-drop
          // stays at ~10 calendar days (5 runs * ~2 days/run).
          if (newStreak >= 5) {
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
          // D-11: threshold halved from 10 to 5 to compensate for cohort-track
          // moving from twice-daily to every-2-days (Plan 09-03 / D-07). Time-to-drop
          // stays at ~10 calendar days (5 runs * ~2 days/run).
          if (newStreak >= 5) {
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

    // Track per-cohort null rates
    if (tracked > 0) {
      perCohortNull.push({
        cohortId: cohort.cohort_id,
        tracked,
        nullBooli,
        nullHemnet,
      });
      // Newest = last in ordered list
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

  // 10-03: fetch the previous completed cohort-track run's perCohortNull so validate()
  // can do a week-over-week delta check. Current row is status='running' so filtering
  // on success|warning selects the prior completed run. Best-effort — on lookup failure
  // we fall back to absolute-threshold-only alerting.
  let priorPerCohortNull = [];
  try {
    const prior = await client.query(
      `SELECT result_summary FROM cron_job_log
        WHERE script_name = 'cohort-track' AND status IN ('success', 'warning')
        ORDER BY id DESC LIMIT 1`
    );
    if (prior.rows[0] && prior.rows[0].result_summary) {
      const rs = typeof prior.rows[0].result_summary === 'string'
        ? JSON.parse(prior.rows[0].result_summary)
        : prior.rows[0].result_summary;
      priorPerCohortNull = Array.isArray(rs.perCohortNull) ? rs.perCohortNull : [];
    }
  } catch (err) {
    log('WARN', `Prior cohort-track lookup failed (delta check disabled this run): ${err.message}`);
  }

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
    perCohortNull,
    priorPerCohortNull,
  };
}

// 10-03 retarget: scope cohort-level null-view alerting to the most recent 4 cohorts
// (rolling window) AND cohortId >= MIN_COHORT_ID. Older cohorts naturally accumulate
// null Booli/Hemnet views as listings drop off the active feeds — that decay is
// structural, not a refresh outage. Cohorts before W20 were also caught in the
// pre-cutover broken-scraper period and have permanently-bad baselines, so they
// stay silent regardless of where the rolling window lands. Once W22+ ships,
// MIN_COHORT_ID becomes naturally moot (the rolling window excludes pre-W20).
// Within scope, fire on EITHER:
//   - absolute null rate > 50% (preserved from prior contract — catches a broken
//     fresh cohort even on its first run where there's no prior delta), OR
//   - jump > 10pp vs the previous cohort-track run for the same cohort (catches
//     genuine breakage that doesn't push past 50% — e.g. 25% → 40%).
const ALERT_WEEKS_WINDOW = 4;
const ALERT_MIN_COHORT_ID = '2026-W20';
const ABSOLUTE_NULL_THRESHOLD = 0.50;
const DELTA_NULL_THRESHOLD = 0.10;

function validateCohortTrack(summary) {
  if (summary.totalTracked === 0 && summary.cohortsTracked > 0) {
    return `0 pairs tracked across ${summary.cohortsTracked} active cohort(s) — expected hundreds`;
  }
  if (!Array.isArray(summary.perCohortNull) || summary.perCohortNull.length === 0) {
    return null;
  }

  // perCohortNull is appended in cohorts-query order (ORDER BY week_start ASC),
  // so the tail of the array is the newest cohorts.
  const inWindow = summary.perCohortNull.slice(-ALERT_WEEKS_WINDOW);
  const scoped = inWindow.filter(c => c.cohortId >= ALERT_MIN_COHORT_ID);
  if (scoped.length === 0) return null;

  const priorByCohort = new Map(
    (Array.isArray(summary.priorPerCohortNull) ? summary.priorPerCohortNull : [])
      .map(c => [c.cohortId, c])
  );

  const warnings = [];
  for (const c of scoped) {
    for (const [metricKey, label] of [['nullBooli', 'Booli'], ['nullHemnet', 'Hemnet']]) {
      if (c.tracked === 0) continue;
      const currRate = c[metricKey] / c.tracked;
      if (currRate > ABSOLUTE_NULL_THRESHOLD) {
        warnings.push(`${c.cohortId}: ${Math.round(currRate * 100)}% null ${label} (${c[metricKey]}/${c.tracked})`);
        continue;
      }
      const prior = priorByCohort.get(c.cohortId);
      if (prior && prior.tracked > 0) {
        const priorRate = prior[metricKey] / prior.tracked;
        const delta = currRate - priorRate;
        if (delta > DELTA_NULL_THRESHOLD) {
          warnings.push(`${c.cohortId}: null ${label} jumped +${Math.round(delta * 100)}pp (${Math.round(priorRate * 100)}% → ${Math.round(currRate * 100)}%)`);
        }
      }
    }
  }

  if (warnings.length > 0) return warnings.join('; ');
  return null;
}

module.exports = { validateCohortTrack };

if (require.main === module) {
  runJob({
    scriptName: 'cohort-track',
    main,
    validate: validateCohortTrack,
  });
}
