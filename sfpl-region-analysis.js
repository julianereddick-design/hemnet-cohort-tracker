require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

const BUCKET_ORDER = ['0-7d', '8-14d', '15-28d', '29-90d', '91-180d', '181d+'];
const REGIONS = ['Stockholm', 'VG', 'Rest'];

function dailyRatio(data, numFn, denFn) {
  return data.map(d => {
    const den = denFn(d);
    return den > 0 ? numFn(d) / den : null;
  });
}

function rollingRatio(data, numFn, denFn, windowSize = 7) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < windowSize - 1) { result.push(null); continue; }
    let numSum = 0, denSum = 0;
    for (let j = i - windowSize + 1; j <= i; j++) {
      numSum += numFn(data[j]);
      denSum += denFn(data[j]);
    }
    result.push(denSum > 0 ? numSum / denSum : null);
  }
  return result;
}

function fmtPct(v) {
  return v !== null ? (v * 100).toFixed(2) + '%' : '-';
}

async function run() {
  await client.connect();

  const res = await client.query(`
    SELECT snapshot_date::text AS date, region, age_bucket, booli_pm_count, hemnet_fs_count
    FROM sfpl_region_daily
    ORDER BY snapshot_date, region, age_bucket
  `);

  await client.end();

  if (res.rows.length === 0) {
    console.log('No data in sfpl_region_daily yet. Run sfpl-region-snapshot.js first.');
    return;
  }

  // Build daily data: { date -> { region -> { buckets: {bucket->count}, hemnetFS: number } } }
  const dailyMap = {};
  for (const r of res.rows) {
    if (!dailyMap[r.date]) dailyMap[r.date] = {};
    if (!dailyMap[r.date][r.region]) {
      dailyMap[r.date][r.region] = { buckets: {}, hemnetFS: 0 };
    }
    dailyMap[r.date][r.region].buckets[r.age_bucket] = Number(r.booli_pm_count);
    dailyMap[r.date][r.region].hemnetFS = Number(r.hemnet_fs_count);
  }

  const sortedDates = Object.keys(dailyMap).sort();

  // Build flat daily array with per-region and national totals
  const dailyData = sortedDates.map(date => {
    const entry = { date };
    let natHemnet = 0;
    const natBuckets = Object.fromEntries(BUCKET_ORDER.map(b => [b, 0]));

    for (const region of REGIONS) {
      const rd = dailyMap[date][region] || { buckets: {}, hemnetFS: 0 };
      entry[region] = {
        hemnetFS: rd.hemnetFS,
        buckets: Object.fromEntries(BUCKET_ORDER.map(b => [b, rd.buckets[b] || 0])),
      };
      entry[region].booliTotal = BUCKET_ORDER.reduce((s, b) => s + entry[region].buckets[b], 0);
      natHemnet += rd.hemnetFS;
      for (const b of BUCKET_ORDER) natBuckets[b] += entry[region].buckets[b] || 0;
    }

    entry.National = {
      hemnetFS: natHemnet,
      buckets: natBuckets,
      booliTotal: BUCKET_ORDER.reduce((s, b) => s + natBuckets[b], 0),
    };

    return entry;
  });

  const allRegions = [...REGIONS, 'National'];

  // Pre-compute daily and rolling ratios for totals
  const dailyTotalRatios = {};
  const rollingTotalRatios = {};
  for (const region of allRegions) {
    dailyTotalRatios[region] = dailyRatio(dailyData, d => d[region].booliTotal, d => d[region].hemnetFS);
    rollingTotalRatios[region] = rollingRatio(dailyData, d => d[region].booliTotal, d => d[region].hemnetFS);
  }

  // === SECTION A: DAILY (spot) ratios ===

  console.log('\n' + '='.repeat(90));
  console.log('DAILY RATIOS (Booli PM / Hemnet FS — single day)');
  console.log('='.repeat(90));

  // Table A1: Daily total ratio trend
  console.log('\nTable A1: Daily Total Ratio');
  const tableA1 = [];
  for (let i = 0; i < dailyData.length; i++) {
    const row = { Date: dailyData[i].date };
    for (const region of allRegions) {
      row[region] = fmtPct(dailyTotalRatios[region][i]);
    }
    tableA1.push(row);
  }
  console.table(tableA1);

  // Tables A2-A5: Daily per-region by age cohort
  for (const [idx, region] of allRegions.entries()) {
    console.log(`\nTable A${idx + 2}: ${region} Daily Ratio by Age Cohort`);

    const cohortRatios = {};
    for (const bucket of BUCKET_ORDER) {
      cohortRatios[bucket] = dailyRatio(dailyData, d => d[region].buckets[bucket], d => d[region].hemnetFS);
    }

    const table = [];
    for (let i = 0; i < dailyData.length; i++) {
      const row = { Date: dailyData[i].date };
      for (const bucket of BUCKET_ORDER) {
        row[bucket] = fmtPct(cohortRatios[bucket][i]);
      }
      row['Total'] = fmtPct(dailyTotalRatios[region][i]);
      table.push(row);
    }
    console.table(table);
  }

  // === SECTION B: 7-DAY ROLLING ratios ===

  console.log('\n' + '='.repeat(90));
  console.log('7-DAY ROLLING RATIOS (Booli PM / Hemnet FS — pooled 7-day window)');
  console.log('='.repeat(90));

  // Table B1: Rolling total ratio trend
  console.log('\nTable B1: 7-Day Rolling Total Ratio');
  const tableB1 = [];
  for (let i = 0; i < dailyData.length; i++) {
    const anyVal = allRegions.some(r => rollingTotalRatios[r][i] !== null);
    if (!anyVal) continue;
    const row = { Date: dailyData[i].date };
    for (const region of allRegions) {
      row[region] = fmtPct(rollingTotalRatios[region][i]);
    }
    tableB1.push(row);
  }
  if (tableB1.length === 0) {
    console.log('  (Need 7+ days of snapshots for rolling ratios)\n');
  } else {
    console.table(tableB1);
  }

  // Tables B2-B5: Rolling per-region by age cohort
  for (const [idx, region] of allRegions.entries()) {
    console.log(`\nTable B${idx + 2}: ${region} 7-Day Rolling Ratio by Age Cohort`);

    const cohortRatios = {};
    for (const bucket of BUCKET_ORDER) {
      cohortRatios[bucket] = rollingRatio(dailyData, d => d[region].buckets[bucket], d => d[region].hemnetFS);
    }

    const table = [];
    for (let i = 0; i < dailyData.length; i++) {
      if (rollingTotalRatios[region][i] === null) continue;
      const row = { Date: dailyData[i].date };
      for (const bucket of BUCKET_ORDER) {
        row[bucket] = fmtPct(cohortRatios[bucket][i]);
      }
      row['Total'] = fmtPct(rollingTotalRatios[region][i]);
      table.push(row);
    }
    if (table.length === 0) {
      console.log('  (Need 7+ days of snapshots for rolling ratios)\n');
    } else {
      console.table(table);
    }
  }
}

run().catch(err => { console.error('Error:', err.message); client.end(); process.exit(1); });
