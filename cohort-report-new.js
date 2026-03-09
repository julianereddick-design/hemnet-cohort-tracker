const { createClient } = require('./db');

// --- Stat helpers (from cohort-views-report.js) ---

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

function fmtNum(v) {
  if (v === null || v === undefined) return '\u2014';
  return String(Math.round(v));
}

function fmtRatio(v) {
  if (v === null || v === undefined || v === '\u2014') return '\u2014';
  return typeof v === 'number' ? v.toFixed(1) : String(v);
}

// --- CLI parsing ---

const args = process.argv.slice(2);
const pairFlagIdx = args.indexOf('--pair');

async function run() {
  const client = createClient();
  await client.connect();

  try {
    if (pairFlagIdx !== -1) {
      const pairId = parseInt(args[pairFlagIdx + 1], 10);
      if (isNaN(pairId)) {
        console.log('Usage: node cohort-report-new.js --pair <pair_id>');
        return;
      }
      await runPairDetail(client, pairId);
    } else {
      const cohortId = args[0] || null;
      await runAggregate(client, cohortId);
    }
  } finally {
    await client.end();
  }
}

// --- Aggregate report (REPT-01 + REPT-02) ---

async function runAggregate(client, requestedCohortId) {
  // Resolve cohort
  let cohortId = requestedCohortId;
  if (!cohortId) {
    const latest = await client.query('SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1');
    if (latest.rows.length === 0) {
      console.log('No cohorts found.');
      return;
    }
    cohortId = latest.rows[0].cohort_id;
  }

  // Verify cohort exists
  const cohortInfo = await client.query('SELECT * FROM cohorts WHERE cohort_id = $1', [cohortId]);
  if (cohortInfo.rows.length === 0) {
    console.log(`Cohort ${cohortId} not found.`);
    return;
  }
  const cohort = cohortInfo.rows[0];

  // Fetch all view data (new schema -- no cohort_id, day, booli_delta, hemnet_delta on cohort_daily_views)
  const viewsRes = await client.query(`
    SELECT dv.pair_id, dv.date::text AS date, dv.booli_views, dv.hemnet_views,
           cp.county, cp.booli_listed::text AS booli_listed
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
    ORDER BY dv.pair_id, dv.date
  `, [cohortId]);

  if (viewsRes.rows.length === 0) {
    console.log(`No view data for cohort ${cohortId}.`);
    return;
  }

  // Build pairDateMap: { pair_id: { date: { booli_views, hemnet_views, county } } }
  const pairDateMap = {};
  for (const r of viewsRes.rows) {
    if (!pairDateMap[r.pair_id]) pairDateMap[r.pair_id] = {};
    pairDateMap[r.pair_id][r.date] = {
      booli_views: r.booli_views,
      hemnet_views: r.hemnet_views,
      county: r.county,
    };
  }

  // Compute incrementals for consecutive dates
  const incrementals = []; // { pair_id, date, booli_incr, hemnet_incr, county }
  const qualityIssues = {
    negativeHemnet: [],
    negativeBooli: [],
    zeroDays: [],
    missingDates: [], // { pair_id, missing: [date_strings] }
  };

  const DAY_MS = 86400000;

  for (const pairId of Object.keys(pairDateMap)) {
    const dateMap = pairDateMap[pairId];
    const dates = Object.keys(dateMap).sort();

    // Check for missing dates (gaps)
    const missingForPair = [];
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const curr = new Date(dates[i]);
      const gapDays = Math.round((curr - prev) / DAY_MS);
      if (gapDays > 1) {
        // Fill in missing date strings
        for (let g = 1; g < gapDays; g++) {
          const missing = new Date(prev.getTime() + g * DAY_MS);
          missingForPair.push(missing.toISOString().slice(0, 10));
        }
      }
    }
    if (missingForPair.length > 0) {
      qualityIssues.missingDates.push({ pair_id: pairId, missing: missingForPair });
    }

    // Compute incrementals
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const curr = new Date(dates[i]);
      const gapDays = Math.round((curr - prev) / DAY_MS);

      // Only compute for consecutive dates
      if (gapDays !== 1) continue;

      const prevData = dateMap[dates[i - 1]];
      const currData = dateMap[dates[i]];

      // Skip if views are NULL (dropped listings)
      if (currData.booli_views === null || currData.hemnet_views === null) continue;
      if (prevData.booli_views === null || prevData.hemnet_views === null) continue;

      const booli_incr = currData.booli_views - prevData.booli_views;
      const hemnet_incr = currData.hemnet_views - prevData.hemnet_views;

      incrementals.push({
        pair_id: pairId,
        date: dates[i],
        booli_incr,
        hemnet_incr,
        county: currData.county,
      });

      // Track quality issues
      if (hemnet_incr < 0) {
        qualityIssues.negativeHemnet.push({ pair_id: pairId, date: dates[i], value: hemnet_incr });
      }
      if (booli_incr < 0) {
        qualityIssues.negativeBooli.push({ pair_id: pairId, date: dates[i], value: booli_incr });
      }
      if (hemnet_incr === 0 && booli_incr === 0) {
        qualityIssues.zeroDays.push({ pair_id: pairId, date: dates[i] });
      }
    }
  }

  // Get date range
  const allDates = [...new Set(incrementals.map(r => r.date))].sort();
  const pairCount = Object.keys(pairDateMap).length;

  // Header
  console.log(`\n=== Cohort Report: ${cohortId} ===`);
  console.log(`Week: ${cohort.week_start.toISOString().slice(0, 10)} to ${cohort.week_end.toISOString().slice(0, 10)}`);
  console.log(`Pairs: ${pairCount}`);
  if (allDates.length > 0) {
    console.log(`Incremental date range: ${allDates[0]} to ${allDates[allDates.length - 1]}`);
  }

  // Aggregate table
  console.log(`\n--- Daily Incremental Views (median/mean across pairs) ---\n`);
  console.log(
    'Date'.padStart(12) +
    'Pairs'.padStart(7) +
    'H Med'.padStart(8) +
    'B Med'.padStart(8) +
    'M/M'.padStart(8) +
    'H Mean'.padStart(8) +
    'B Mean'.padStart(8) +
    'Mn/Mn'.padStart(8)
  );
  console.log('-'.repeat(67));

  // Group by date
  const byDate = {};
  for (const r of incrementals) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  for (const date of allDates) {
    const rows = byDate[date];
    const hVals = rows.map(r => r.hemnet_incr);
    const bVals = rows.map(r => r.booli_incr);
    const hMed = median(hVals);
    const bMed = median(bVals);
    const hMean = mean(hVals);
    const bMean = mean(bVals);
    const medRatio = bMed > 0 ? (hMed / bMed).toFixed(1) + 'x' : '\u2014';
    const meanRatio = bMean > 0 ? (hMean / bMean).toFixed(1) + 'x' : '\u2014';

    console.log(
      date.padStart(12) +
      String(rows.length).padStart(7) +
      fmtNum(hMed).padStart(8) +
      fmtNum(bMed).padStart(8) +
      String(medRatio).padStart(8) +
      fmtNum(hMean).padStart(8) +
      fmtNum(bMean).padStart(8) +
      String(meanRatio).padStart(8)
    );
  }

  // Data Quality section (REPT-02)
  console.log(`\n\n=== Data Quality ===\n`);

  // Negative incrementals
  console.log(`Negative Hemnet incrementals: ${qualityIssues.negativeHemnet.length}`);
  if (qualityIssues.negativeHemnet.length > 0) {
    const worst = qualityIssues.negativeHemnet.sort((a, b) => a.value - b.value)[0];
    console.log(`  Worst: pair ${worst.pair_id} on ${worst.date} = ${worst.value}`);
  }

  console.log(`Negative Booli incrementals: ${qualityIssues.negativeBooli.length}`);
  if (qualityIssues.negativeBooli.length > 0) {
    const worst = qualityIssues.negativeBooli.sort((a, b) => a.value - b.value)[0];
    console.log(`  Worst: pair ${worst.pair_id} on ${worst.date} = ${worst.value}`);
  }

  // Zero-incremental days
  const zeroPairs = new Set(qualityIssues.zeroDays.map(z => z.pair_id));
  console.log(`\nZero-incremental days (both H and B = 0): ${qualityIssues.zeroDays.length} occurrences across ${zeroPairs.size} pairs`);

  // Missing dates
  console.log(`\nPairs with date gaps: ${qualityIssues.missingDates.length}`);
  if (qualityIssues.missingDates.length > 0) {
    const showMax = Math.min(5, qualityIssues.missingDates.length);
    for (let i = 0; i < showMax; i++) {
      const m = qualityIssues.missingDates[i];
      const dates = m.missing.length <= 3
        ? m.missing.join(', ')
        : `${m.missing.slice(0, 3).join(', ')} (+${m.missing.length - 3} more)`;
      console.log(`  Pair ${m.pair_id}: missing ${dates}`);
    }
    if (qualityIssues.missingDates.length > showMax) {
      console.log(`  ... and ${qualityIssues.missingDates.length - showMax} more pairs`);
    }
  }
}

// --- Per-pair detail (REPT-04) ---

async function runPairDetail(client, pairId) {
  const res = await client.query(`
    SELECT dv.date::text AS date, dv.booli_views, dv.hemnet_views,
           cp.booli_id, cp.hemnet_id, cp.county, cp.booli_listed::text AS booli_listed
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE dv.pair_id = $1
    ORDER BY dv.date
  `, [pairId]);

  if (res.rows.length === 0) {
    console.log(`Pair ${pairId} not found.`);
    return;
  }

  const info = res.rows[0];
  const DAY_MS = 86400000;

  console.log(`\n=== Pair ${pairId} Detail ===`);
  console.log(`Booli ID: ${info.booli_id}, Hemnet ID: ${info.hemnet_id}`);
  console.log(`County: ${info.county}, Listed: ${info.booli_listed}`);

  console.log('');
  console.log(
    'Date'.padStart(12) +
    'Day'.padStart(5) +
    'B Views'.padStart(9) +
    'H Views'.padStart(9) +
    'B Incr'.padStart(8) +
    'H Incr'.padStart(8)
  );
  console.log('-'.repeat(51));

  const listedDate = new Date(info.booli_listed);

  for (let i = 0; i < res.rows.length; i++) {
    const r = res.rows[i];
    const rowDate = new Date(r.date);
    const day = Math.round((rowDate - listedDate) / DAY_MS);

    let bIncr = '\u2014';
    let hIncr = '\u2014';

    if (i > 0) {
      const prev = res.rows[i - 1];
      const prevDate = new Date(prev.date);
      const gap = Math.round((rowDate - prevDate) / DAY_MS);

      if (gap === 1 && r.booli_views !== null && prev.booli_views !== null
          && r.hemnet_views !== null && prev.hemnet_views !== null) {
        bIncr = String(r.booli_views - prev.booli_views);
        hIncr = String(r.hemnet_views - prev.hemnet_views);
      } else if (gap > 1) {
        bIncr = '[gap]';
        hIncr = '[gap]';
      }
    }

    const bViews = r.booli_views !== null ? String(r.booli_views) : '\u2014';
    const hViews = r.hemnet_views !== null ? String(r.hemnet_views) : '\u2014';

    console.log(
      r.date.padStart(12) +
      String(day).padStart(5) +
      bViews.padStart(9) +
      hViews.padStart(9) +
      bIncr.padStart(8) +
      hIncr.padStart(8)
    );
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
