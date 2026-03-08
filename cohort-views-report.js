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

function fmtNum(v) {
  if (v === null || v === undefined) return '—';
  return String(Math.round(v));
}

function fmtRatio(v) {
  if (v === null || v === undefined || v === '—') return '—';
  return typeof v === 'number' ? v.toFixed(1) : String(v);
}

async function run() {
  const client = createClient();
  await client.connect();

  // Resolve cohort
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

  const cohortInfo = await client.query('SELECT * FROM cohorts WHERE cohort_id = $1', [cohortId]);
  if (cohortInfo.rows.length === 0) {
    console.log(`Cohort ${cohortId} not found.`);
    await client.end();
    return;
  }
  const cohort = cohortInfo.rows[0];

  console.log(`\n=== Cohort Views Report: ${cohortId} ===`);
  console.log(`Week: ${cohort.week_start.toISOString().slice(0, 10)} to ${cohort.week_end.toISOString().slice(0, 10)}`);

  // Get pairs + county counts
  const pairsRes = await client.query(`
    SELECT cp.id, cp.county
    FROM cohort_pairs cp
    WHERE cp.cohort_id = $1
  `, [cohortId]);

  console.log(`Total matched pairs: ${pairsRes.rows.length}`);

  const countyCount = {};
  for (const p of pairsRes.rows) {
    countyCount[p.county] = (countyCount[p.county] || 0) + 1;
  }

  console.log('\nPairs by county:');
  for (const [county, cnt] of Object.entries(countyCount).sort((a, b) => b[1] - a[1])) {
    const flag = cnt < MIN_PAIRS ? ' (below minimum)' : '';
    console.log(`  ${county}: ${cnt}${flag}`);
  }

  // Fetch all view data with both day types
  const views = await client.query(`
    SELECT
      dv.pair_id,
      dv.day AS cohort_day,
      (dv.date - cp.booli_listed) AS listing_day,
      dv.booli_delta,
      dv.hemnet_delta,
      cp.county
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE dv.cohort_id = $1
      AND dv.booli_delta IS NOT NULL
      AND dv.hemnet_delta IS NOT NULL
    ORDER BY dv.pair_id, listing_day
  `, [cohortId]);

  const levels = ['Total', ...Object.keys(countyCount).filter(c => countyCount[c] >= MIN_PAIRS).sort()];

  // ========== SECTION 1: Cohort Day View ==========
  printSection1(views.rows, levels, countyCount);

  // ========== SECTION 2: Per-Listing Day View ==========
  printSection2(views.rows, levels, countyCount);

  await client.end();
}

// --- Section 1: Cohort Day (stored `day` column) ---
function printSection1(rows, levels, countyCount) {
  console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SECTION 1: Cohort Day View (days since cohort week_start)        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const maxDay = rows.reduce((m, r) => Math.max(m, r.cohort_day), 0);

  for (const level of levels) {
    console.log(`\n[${level}]`);
    console.log(
      'Day'.padStart(4) +
      'Pairs'.padStart(7) +
      'H Med'.padStart(8) +
      'B Med'.padStart(8) +
      'M/M'.padStart(8) +
      'H Mean'.padStart(8) +
      'B Mean'.padStart(8) +
      'Mn/Mn'.padStart(8)
    );
    console.log('-'.repeat(59));

    for (let d = 0; d <= maxDay; d++) {
      const dayRows = rows.filter(r =>
        r.cohort_day === d && (level === 'Total' || r.county === level)
      );
      if (dayRows.length === 0) continue;

      const hDeltas = dayRows.map(r => r.hemnet_delta);
      const bDeltas = dayRows.map(r => r.booli_delta);
      const hMed = median(hDeltas);
      const bMed = median(bDeltas);
      const hMean = mean(hDeltas);
      const bMean = mean(bDeltas);
      const medRatio = bMed > 0 ? (hMed / bMed).toFixed(1) + 'x' : '—';
      const meanRatio = bMean > 0 ? (hMean / bMean).toFixed(1) + 'x' : '—';

      console.log(
        String(d).padStart(4) +
        String(dayRows.length).padStart(7) +
        fmtNum(hMed).padStart(8) +
        fmtNum(bMed).padStart(8) +
        String(medRatio).padStart(8) +
        fmtNum(hMean).padStart(8) +
        fmtNum(bMean).padStart(8) +
        String(meanRatio).padStart(8)
      );
    }
  }
}

// --- Section 2: Per-Listing Day View (dv.date - cp.booli_listed) ---
function printSection2(rows, levels, countyCount) {
  console.log('\n\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SECTION 2: Per-Listing Day View (days since booli_listed)        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const maxDay = rows.reduce((m, r) => Math.max(m, r.listing_day), 0);

  // --- Table 2a: Cumulative Views ---
  console.log('\n--- Table 2a: Cumulative Views (Days 1-30) ---');

  for (const level of levels) {
    console.log(`\n[${level}]`);
    console.log(
      'Day'.padStart(4) +
      'Pairs'.padStart(7) +
      'H Med'.padStart(8) +
      'B Med'.padStart(8) +
      'M/M'.padStart(8) +
      'H Mean'.padStart(8) +
      'B Mean'.padStart(8) +
      'Mn/Mn'.padStart(8) +
      'H P75'.padStart(8) +
      'B P75'.padStart(8)
    );
    console.log('-'.repeat(75));

    for (let d = 1; d <= Math.min(maxDay, 30); d++) {
      const dayRows = rows.filter(r =>
        r.listing_day === d && (level === 'Total' || r.county === level)
      );
      if (dayRows.length === 0) continue;

      const hDeltas = dayRows.map(r => r.hemnet_delta);
      const bDeltas = dayRows.map(r => r.booli_delta);
      const hMed = median(hDeltas);
      const bMed = median(bDeltas);
      const hMean = mean(hDeltas);
      const bMean = mean(bDeltas);
      const medRatio = bMed > 0 ? (hMed / bMed).toFixed(1) + 'x' : '—';
      const meanRatio = bMean > 0 ? (hMean / bMean).toFixed(1) + 'x' : '—';

      console.log(
        String(d).padStart(4) +
        String(dayRows.length).padStart(7) +
        fmtNum(hMed).padStart(8) +
        fmtNum(bMed).padStart(8) +
        String(medRatio).padStart(8) +
        fmtNum(hMean).padStart(8) +
        fmtNum(bMean).padStart(8) +
        String(meanRatio).padStart(8) +
        fmtNum(percentile(hDeltas, 75)).padStart(8) +
        fmtNum(percentile(bDeltas, 75)).padStart(8)
      );
    }
  }

  // --- Table 2b: Incremental Views ---
  console.log('\n\n--- Table 2b: Incremental Views (Days 2-30) ---');
  console.log('(change from previous day, only for pairs with consecutive-day data)\n');

  // Build per-pair day map for incremental calc
  const pairDayMap = {}; // { pair_id: { listing_day: { hemnet_delta, booli_delta, county } } }
  for (const r of rows) {
    if (!pairDayMap[r.pair_id]) pairDayMap[r.pair_id] = {};
    pairDayMap[r.pair_id][r.listing_day] = {
      hemnet_delta: r.hemnet_delta,
      booli_delta: r.booli_delta,
      county: r.county,
    };
  }

  // Compute incremental values
  // incr[day] = [{ hemnet_incr, booli_incr, county }]
  const incr = {};
  for (const pairId of Object.keys(pairDayMap)) {
    const days = pairDayMap[pairId];
    for (let d = 2; d <= 30; d++) {
      if (days[d] && days[d - 1]) {
        const hIncr = days[d].hemnet_delta - days[d - 1].hemnet_delta;
        const bIncr = days[d].booli_delta - days[d - 1].booli_delta;
        if (!incr[d]) incr[d] = [];
        incr[d].push({ hemnet_incr: hIncr, booli_incr: bIncr, county: days[d].county });
      }
    }
  }

  for (const level of levels) {
    console.log(`\n[${level}]`);
    console.log(
      'Day'.padStart(4) +
      'Pairs'.padStart(7) +
      'H Med'.padStart(8) +
      'B Med'.padStart(8) +
      'M/M'.padStart(8) +
      'H Mean'.padStart(8) +
      'B Mean'.padStart(8) +
      'Mn/Mn'.padStart(8)
    );
    console.log('-'.repeat(59));

    for (let d = 2; d <= 30; d++) {
      if (!incr[d]) continue;
      const dayRows = incr[d].filter(r => level === 'Total' || r.county === level);
      if (dayRows.length === 0) continue;

      const hVals = dayRows.map(r => r.hemnet_incr);
      const bVals = dayRows.map(r => r.booli_incr);
      const hMed = median(hVals);
      const bMed = median(bVals);
      const hMean = mean(hVals);
      const bMean = mean(bVals);
      const medRatio = bMed > 0 ? (hMed / bMed).toFixed(1) + 'x' : '—';
      const meanRatio = bMean > 0 ? (hMean / bMean).toFixed(1) + 'x' : '—';

      console.log(
        String(d).padStart(4) +
        String(dayRows.length).padStart(7) +
        fmtNum(hMed).padStart(8) +
        fmtNum(bMed).padStart(8) +
        String(medRatio).padStart(8) +
        fmtNum(hMean).padStart(8) +
        fmtNum(bMean).padStart(8) +
        String(meanRatio).padStart(8)
      );
    }
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
