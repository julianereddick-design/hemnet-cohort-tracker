const { createClient } = require('./db');
const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;

// --- Stat helpers ---

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

// --- Region mapping ---

function normalizeCounty(name) {
  if (!name) return '';
  return name.replace(/ län$/, '').trim();
}

function countyToRegion(county) {
  const norm = normalizeCounty(county);
  if (norm === 'Stockholms') return 'Stockholm';
  if (norm === 'Skåne') return 'Skane';
  if (norm === 'Västra Götalands') return 'VG';
  return 'Rest';
}

const REGIONS = ['Total', 'Stockholm', 'Skane', 'VG', 'Rest'];
const METRICS = ['H_median', 'B_median', 'H_mean', 'B_mean'];

// --- Rolling 7-day lookback ---

function findLookback(viewMap, pairId, dateStr) {
  const dateMs = new Date(dateStr).getTime();
  for (const offset of [7, 6, 8, 5, 9]) {
    const lookbackDate = new Date(dateMs - offset * DAY_MS).toISOString().slice(0, 10);
    const v = viewMap.get(`${pairId}_${lookbackDate}`);
    if (v && v.hemnet_views != null && v.booli_views != null) {
      return { data: v, days: offset };
    }
  }
  return null;
}

// --- CSV helpers ---

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(outDir, filename, lines) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, filename);
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  return outFile;
}

function fmtNum(v) {
  if (v === null || v === undefined) return '';
  return Number(v.toFixed(1));
}

// --- Main ---

async function run() {
  const client = createClient();
  await client.connect();

  // Parse args
  const args = process.argv.slice(2);
  let cohortId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cohort' && args[i + 1]) cohortId = args[i + 1];
  }

  // Default to latest cohort
  if (!cohortId) {
    const res = await client.query('SELECT DISTINCT cohort_id FROM cohort_pairs ORDER BY cohort_id DESC LIMIT 1');
    if (res.rows.length === 0) { console.error('No cohorts found'); process.exit(1); }
    cohortId = res.rows[0].cohort_id;
    console.log(`Using latest cohort: ${cohortId}`);
  }

  // Get all dates for this cohort (sorted)
  const datesRes = await client.query(`
    SELECT DISTINCT dv.date::text AS date
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
    ORDER BY date
  `, [cohortId]);
  const allDates = datesRes.rows.map(r => r.date);

  if (allDates.length === 0) { console.error(`No data for cohort ${cohortId}`); process.exit(1); }

  // Exclude the most recent date (tracker may not have finished running)
  const dates = allDates.slice(0, -1);
  if (dates.length === 0) { console.error(`Only 1 date for cohort ${cohortId}, nothing to export after excluding latest`); process.exit(1); }
  console.log(`Excluding latest date ${allDates[allDates.length - 1]} (may be incomplete)`);

  // Get all pairs
  const pairsRes = await client.query(`
    SELECT id, booli_id, hemnet_id, street_address, municipality, county
    FROM cohort_pairs
    WHERE cohort_id = $1
    ORDER BY county, municipality, id
  `, [cohortId]);
  const pairs = pairsRes.rows;

  // Get all view data
  const viewsRes = await client.query(`
    SELECT dv.pair_id, dv.date::text AS date, dv.booli_views, dv.hemnet_views
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
  `, [cohortId]);

  // Build viewMap
  const viewMap = new Map();
  for (const v of viewsRes.rows) {
    viewMap.set(`${v.pair_id}_${v.date}`, v);
  }

  // Map pair IDs to regions
  const pairRegionMap = new Map();
  for (const pair of pairs) {
    pairRegionMap.set(pair.id, countyToRegion(pair.county));
  }

  // --- Compute per-pair incrementals ---
  // Hemnet: 1-day delta (updates daily)
  // Booli: 2-day delta / 2 (scraper only updates views every other day)
  // incrMap: Map<"pairId_date", { h: number, b: number }>
  const incrMap = new Map();
  for (const pair of pairs) {
    const pairDates = dates.filter(d => viewMap.has(`${pair.id}_${d}`));
    for (let i = 1; i < pairDates.length; i++) {
      const prevDate = new Date(pairDates[i - 1]);
      const currDate = new Date(pairDates[i]);
      const gap = Math.round((currDate - prevDate) / DAY_MS);
      if (gap !== 1) continue;

      const curr = viewMap.get(`${pair.id}_${pairDates[i]}`);
      const prev1 = viewMap.get(`${pair.id}_${pairDates[i - 1]}`);

      // Hemnet: 1-day delta
      let h = null;
      if (curr.hemnet_views != null && prev1.hemnet_views != null) {
        h = curr.hemnet_views - prev1.hemnet_views;
      }

      // Booli: 2-day lookback for daily average (scraper updates every other day)
      let b = null;
      if (i >= 2) {
        const prev2Date = new Date(pairDates[i - 2]);
        const gap2 = Math.round((currDate - prev2Date) / DAY_MS);
        if (gap2 === 2) {
          const prev2 = viewMap.get(`${pair.id}_${pairDates[i - 2]}`);
          if (curr.booli_views != null && prev2.booli_views != null) {
            b = (curr.booli_views - prev2.booli_views) / 2;
          }
        }
      }

      if (h !== null || b !== null) {
        incrMap.set(`${pair.id}_${pairDates[i]}`, { h, b });
      }
    }
  }

  // --- Compute per-pair rolling 7-day daily averages ---
  // roll7Map: Map<"pairId_date", { h: number, b: number }>
  const roll7Map = new Map();
  for (const pair of pairs) {
    for (const d of dates) {
      const curr = viewMap.get(`${pair.id}_${d}`);
      if (!curr || curr.hemnet_views == null || curr.booli_views == null) continue;

      const lb = findLookback(viewMap, pair.id, d);
      if (!lb) continue;

      roll7Map.set(`${pair.id}_${d}`, {
        h: (curr.hemnet_views - lb.data.hemnet_views) / lb.days,
        b: (curr.booli_views - lb.data.booli_views) / lb.days,
      });
    }
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, 'view-data', runDate, cohortId);

  // === File A: Per-Pair Cumulative ===
  const headerA = ['pair_id', 'booli_id', 'hemnet_id', 'street_address', 'municipality', 'county'];
  for (const d of dates) { headerA.push(`H_${d}`, `B_${d}`); }
  const linesA = [headerA.join(',')];
  for (const pair of pairs) {
    const row = [pair.id, pair.booli_id, pair.hemnet_id, escapeCsv(pair.street_address), escapeCsv(pair.municipality), escapeCsv(pair.county)];
    for (const d of dates) {
      const v = viewMap.get(`${pair.id}_${d}`);
      row.push(v ? (v.hemnet_views ?? '') : '');
      row.push(v ? (v.booli_views ?? '') : '');
    }
    linesA.push(row.join(','));
  }
  const fileA = writeCsv(outDir, `cumulative.csv`, linesA);

  // === File B: Per-Pair Incremental Daily ===
  // H = 1-day delta, B = 2-day daily average (Booli scraper updates every other day)
  const headerB = ['pair_id', 'booli_id', 'hemnet_id', 'street_address', 'municipality', 'county'];
  for (const d of dates) { headerB.push(`H_incr_${d}`, `B_incr_${d}`); }
  const linesB = [headerB.join(',')];
  for (const pair of pairs) {
    const row = [pair.id, pair.booli_id, pair.hemnet_id, escapeCsv(pair.street_address), escapeCsv(pair.municipality), escapeCsv(pair.county)];
    for (const d of dates) {
      const incr = incrMap.get(`${pair.id}_${d}`);
      row.push(incr != null && incr.h != null ? incr.h : '');
      row.push(incr != null && incr.b != null ? fmtNum(incr.b) : '');
    }
    linesB.push(row.join(','));
  }
  const fileB = writeCsv(outDir, `incremental.csv`, linesB);

  // === File C: Per-Pair Rolling 7-Day Daily Average ===
  const headerC = ['pair_id', 'booli_id', 'hemnet_id', 'street_address', 'municipality', 'county'];
  for (const d of dates) { headerC.push(`H_7d_${d}`, `B_7d_${d}`); }
  const linesC = [headerC.join(',')];
  for (const pair of pairs) {
    const row = [pair.id, pair.booli_id, pair.hemnet_id, escapeCsv(pair.street_address), escapeCsv(pair.municipality), escapeCsv(pair.county)];
    for (const d of dates) {
      const r7 = roll7Map.get(`${pair.id}_${d}`);
      row.push(r7 != null ? fmtNum(r7.h) : '');
      row.push(r7 != null ? fmtNum(r7.b) : '');
    }
    linesC.push(row.join(','));
  }
  const fileC = writeCsv(outDir, `rolling-7d.csv`, linesC);

  // === File D: Combined Cohort Aggregate (1-day incr on top, 7-day rolling below) ===
  const aggIncrLines = buildAggregate('1d', dates, pairs, incrMap, pairRegionMap);
  const aggRollLines = buildAggregate('7d', dates, pairs, roll7Map, pairRegionMap);
  // Merge: header from 1d, then 1d data rows, blank separator, 7d header + data rows
  const aggCombined = [
    ...aggIncrLines,
    '',
    ...aggRollLines,
  ];
  const fileD = writeCsv(outDir, `aggregate.csv`, aggCombined);

  // === Console summary ===
  const regionCounts = {};
  for (const pair of pairs) {
    const region = countyToRegion(pair.county);
    regionCounts[region] = (regionCounts[region] || 0) + 1;
  }

  console.log(`\nCohort: ${cohortId}`);
  console.log(`Dates: ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} dates)`);
  console.log(`Pairs: ${pairs.length}`);
  console.log(`Regions: ${REGIONS.slice(1).map(r => `${r} (${regionCounts[r] || 0})`).join(', ')}`);
  console.log('');
  console.log(`Wrote: ${fileA}`);
  console.log(`Wrote: ${fileB}`);
  console.log(`Wrote: ${fileC}`);
  console.log(`Wrote: ${fileD}`);

  // Data quality
  let negCount = 0;
  let zeroCount = 0;
  for (const [, v] of incrMap) {
    if ((v.h != null && v.h < 0) || (v.b != null && v.b < 0)) negCount++;
    if (v.h === 0 && v.b === 0) zeroCount++;
  }
  console.log(`\nData quality: ${negCount} negative incrementals, ${zeroCount} zero-delta entries`);
  console.log(`Note: Booli incrementals use 2-day avg (scraper updates every other day)`);

  await client.end();
}

// --- Build aggregate CSV lines (used for both Files D and E) ---

function buildAggregate(label, dates, pairs, dataMap, pairRegionMap) {
  const header = ['region', 'metric (' + label + ')', ...dates];
  const lines = [header.join(',')];

  for (const region of REGIONS) {
    // Collect values per date for this region
    const dateValues = {}; // date -> { hVals: [], bVals: [] }
    for (const d of dates) {
      dateValues[d] = { hVals: [], bVals: [] };
    }

    for (const pair of pairs) {
      const pairRegion = pairRegionMap.get(pair.id);
      if (region !== 'Total' && pairRegion !== region) continue;

      for (const d of dates) {
        const val = dataMap.get(`${pair.id}_${d}`);
        if (val == null) continue;
        // Exclude pairs where both H and B are 0
        if (val.h === 0 && val.b === 0) continue;
        if (val.h != null) dateValues[d].hVals.push(val.h);
        if (val.b != null) dateValues[d].bVals.push(val.b);
      }
    }

    // Build 4 rows for this region
    for (const metric of METRICS) {
      const row = [region, metric];
      for (const d of dates) {
        const dv = dateValues[d];
        let val;
        if (metric === 'H_median') val = median(dv.hVals);
        else if (metric === 'B_median') val = median(dv.bVals);
        else if (metric === 'H_mean') val = mean(dv.hVals);
        else if (metric === 'B_mean') val = mean(dv.bVals);
        row.push(fmtNum(val));
      }
      lines.push(row.join(','));
    }
  }

  return lines;
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
