const { createClient } = require('./db');
const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;

function normalizeCounty(name) {
  if (!name) return '';
  return name.replace(/ län$/, '').trim();
}

function countyToRegion(county) {
  const norm = normalizeCounty(county);
  if (norm === 'Stockholms') return 'Stockholm';
  if (norm === 'Skåne') return 'Skane';
  if (norm === 'Västra Götalands') return 'Gotenberg';
  if (norm === 'Norrbottens') return 'Norrbotten';
  if (norm === 'Dalarnas') return 'Dalarna';
  return 'Olland';
}

// District overlay drawn ON TOP of the county region (additive, like TOTAL — a pair counts
// toward both its county line and its district line). Östermalm = Stockholm postcodes 11400–11599.
function postcodeToDistrict(postcode) {
  const pc = parseInt(postcode, 10);
  if (Number.isFinite(pc) && pc >= 11400 && pc <= 11599) return 'Ostermalm';
  return null;
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const REGIONS = ['TOTAL', 'Stockholm', 'Gotenberg', 'Skane', 'Olland', 'Norrbotten', 'Dalarna', 'Ostermalm'];

const REGION_STYLES = {
  TOTAL:      { color: '#1565C0', dash: [],       width: 3 },
  Stockholm:  { color: '#E65100', dash: [8, 4],   width: 2 },
  Gotenberg:  { color: '#2E7D32', dash: [8, 4],   width: 2 },
  Skane:      { color: '#90CAF9', dash: [2, 2],   width: 2 },
  Olland:     { color: '#AD1457', dash: [2, 2],   width: 2 },
  Norrbotten: { color: '#00838F', dash: [6, 3],   width: 2 },
  Dalarna:    { color: '#6D4C41', dash: [6, 3],   width: 2 },
  Ostermalm:  { color: '#F9A825', dash: [4, 4],   width: 2 },
};

async function run() {
  const client = createClient();
  await client.connect();

  const args = process.argv.slice(2);
  let cohortId = null;
  let cohortCount = null;   // --cohorts N pools the last N cohorts (for thin regions/districts)
  let maxDay = 21;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cohort' && args[i + 1]) cohortId = args[i + 1];
    if (args[i] === '--cohorts' && args[i + 1]) cohortCount = parseInt(args[i + 1]);
    if (args[i] === '--days' && args[i + 1]) maxDay = parseInt(args[i + 1]);
  }

  // Resolve the set of cohorts to chart. Single cohort by default; --cohorts N pools the
  // most recent N so thin regions (Östermalm, Norrbotten, Dalarna) clear the per-day sample
  // floor. dayNum is relative to each pair's own listing date, so pooling weeks is sound.
  let cohortIds;
  let label;
  if (cohortCount && cohortCount > 0) {
    const res = await client.query(
      'SELECT DISTINCT cohort_id FROM cohort_pairs ORDER BY cohort_id DESC LIMIT $1', [cohortCount]);
    cohortIds = res.rows.map(r => r.cohort_id);
    label = cohortIds.length > 1
      ? `${cohortIds[cohortIds.length - 1]}_to_${cohortIds[0]}`
      : (cohortIds[0] || 'none');
    console.log(`Pooling ${cohortIds.length} cohort(s): ${cohortIds.join(', ')}`);
  } else {
    if (!cohortId) {
      const res = await client.query('SELECT DISTINCT cohort_id FROM cohort_pairs ORDER BY cohort_id DESC LIMIT 1');
      cohortId = res.rows[0].cohort_id;
      console.log(`Using latest cohort: ${cohortId}`);
    }
    cohortIds = [cohortId];
    label = cohortId;
  }

  // Get pairs with listing date and region
  const pairsRes = await client.query(`
    SELECT id, booli_id, hemnet_id, street_address, municipality, county, postcode,
           booli_listed::text AS booli_listed
    FROM cohort_pairs
    WHERE cohort_id = ANY($1::text[])
      AND removed_at IS NULL
  `, [cohortIds]);
  const pairs = pairsRes.rows;

  // Get all view data
  const viewsRes = await client.query(`
    SELECT dv.pair_id, dv.date::text AS date, dv.booli_views, dv.hemnet_views
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = ANY($1::text[])
      AND cp.removed_at IS NULL
    ORDER BY dv.date
  `, [cohortIds]);

  // Build viewMap
  const viewMap = new Map();
  for (const v of viewsRes.rows) {
    viewMap.set(`${v.pair_id}_${v.date}`, v);
  }

  // Get all unique dates sorted
  const allDates = [...new Set(viewsRes.rows.map(r => r.date))].sort();
  // Exclude latest (may be incomplete)
  const dates = allDates.slice(0, -1);

  // For each pair, compute rolling 7-day H and B daily averages per day-number
  // Then compute H/B ratio
  // regionDayData: { region -> { dayNum -> [ratio values] } }
  const regionDayData = {};
  for (const r of REGIONS) regionDayData[r] = {};

  // Detail rows for audit CSV
  const detailRows = [];

  for (const pair of pairs) {
    const region = countyToRegion(pair.county);
    const district = postcodeToDistrict(pair.postcode);  // overlay line (e.g. Östermalm) or null
    const listedDate = pair.booli_listed;

    for (const d of dates) {
      const dayNum = Math.round((new Date(d) - new Date(listedDate)) / DAY_MS) + 1;
      if (dayNum < 1 || dayNum > maxDay) continue;

      const curr = viewMap.get(`${pair.id}_${d}`);
      if (!curr || curr.hemnet_views == null || curr.booli_views == null) continue;

      // Find lookback ~7 days for rolling average
      let lookback = null;
      for (const offset of [7, 6, 8, 5, 9]) {
        const lbDate = new Date(new Date(d).getTime() - offset * DAY_MS).toISOString().slice(0, 10);
        const v = viewMap.get(`${pair.id}_${lbDate}`);
        if (v && v.hemnet_views != null && v.booli_views != null) {
          lookback = { data: v, days: offset };
          break;
        }
      }
      if (!lookback) continue;

      const hDaily = (curr.hemnet_views - lookback.data.hemnet_views) / lookback.days;
      const bDaily = (curr.booli_views - lookback.data.booli_views) / lookback.days;

      const skipped = bDaily <= 0;
      const ratio = skipped ? null : hDaily / bDaily;
      const filtered = ratio !== null && (ratio > 20 || ratio < 0);

      // Detail row for every computed pair (including skipped/filtered)
      detailRows.push({
        pair_id: pair.id,
        booli_id: pair.booli_id,
        hemnet_id: pair.hemnet_id,
        street_address: pair.street_address,
        municipality: pair.municipality,
        region,
        date: d,
        day_num: dayNum,
        h_cum: curr.hemnet_views,
        b_cum: curr.booli_views,
        lookback_days: lookback.days,
        h_daily: Math.round(hDaily * 100) / 100,
        b_daily: Math.round(bDaily * 100) / 100,
        hb_ratio: ratio !== null ? Math.round(ratio * 100) / 100 : '',
        excluded: skipped ? 'b_daily<=0' : filtered ? 'outlier' : '',
      });

      if (skipped || filtered) continue;

      // Add to region, total, and (if applicable) the district overlay line.
      if (!regionDayData[region][dayNum]) regionDayData[region][dayNum] = [];
      regionDayData[region][dayNum].push(ratio);

      if (!regionDayData['TOTAL'][dayNum]) regionDayData['TOTAL'][dayNum] = [];
      regionDayData['TOTAL'][dayNum].push(ratio);

      if (district) {
        if (!regionDayData[district][dayNum]) regionDayData[district][dayNum] = [];
        regionDayData[district][dayNum].push(ratio);
      }
    }
  }

  // Compute median ratio per region per day
  const chartData = {};
  for (const region of REGIONS) {
    chartData[region] = [];
    for (let d = 1; d <= maxDay; d++) {
      const vals = regionDayData[region][d];
      chartData[region].push(vals && vals.length >= 3 ? median(vals) : null);
    }
  }

  // Print summary
  for (const region of REGIONS) {
    const nonNull = chartData[region].filter(v => v !== null);
    if (nonNull.length > 0) {
      const avg = nonNull.reduce((a, b) => a + b, 0) / nonNull.length;
      console.log(`${region}: ${nonNull.length} days, avg ratio ${avg.toFixed(2)}`);
    }
  }

  // Generate HTML
  const dayLabels = Array.from({ length: maxDay }, (_, i) => i + 1);

  const datasets = REGIONS.map(region => {
    const style = REGION_STYLES[region];
    return `{
      label: '${region === 'Olland' ? 'Olland (350k pop County)' : region === 'Ostermalm' ? 'Östermalm (Sthlm district)' : region}',
      data: ${JSON.stringify(chartData[region].map(v => v !== null ? Math.round(v * 100) / 100 : null))},
      borderColor: '${style.color}',
      borderWidth: ${style.width},
      borderDash: [${style.dash.join(',')}],
      pointRadius: 0,
      tension: 0.3,
      spanGaps: true
    }`;
  });

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>H/B Ratio - ${label}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #fff; }
    .chart-container { width: 900px; height: 400px; }
  </style>
</head>
<body>
  <div class="chart-container">
    <canvas id="chart"></canvas>
  </div>
  <script>
    new Chart(document.getElementById('chart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(dayLabels)},
        datasets: [${datasets.join(',\n          ')}]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Views per day delta between HEM and Booli — ${label}',
            font: { size: 16 },
            align: 'start'
          },
          legend: {
            position: 'top',
            align: 'start',
            labels: {
              usePointStyle: true,
              boxWidth: 30
            }
          }
        },
        scales: {
          x: {
            title: { display: false },
            grid: { display: false }
          },
          y: {
            min: 0,
            title: { display: false },
            grid: { color: '#eee' }
          }
        }
      }
    });
  </script>
</body>
</html>`;

  const runDate = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, 'view-data', runDate, label);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'hb-ratio-chart.html');
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`\nChart: ${outFile}`);

  // === Summary CSV (what the chart plots) ===
  const summaryLines = ['day_num,region,median_ratio,sample_size'];
  for (let d = 1; d <= maxDay; d++) {
    for (const region of REGIONS) {
      const vals = regionDayData[region][d];
      if (!vals || vals.length === 0) continue;
      const med = median(vals);
      summaryLines.push(`${d},${region},${Math.round(med * 100) / 100},${vals.length}`);
    }
  }
  const summaryFile = path.join(outDir, 'hb-ratio-summary.csv');
  fs.writeFileSync(summaryFile, summaryLines.join('\n'), 'utf8');
  console.log(`Summary: ${summaryFile}`);

  // === Detail CSV (per-pair audit trail) ===
  function esc(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const detailHeader = 'pair_id,booli_id,hemnet_id,street_address,municipality,region,date,day_num,h_cum,b_cum,lookback_days,h_daily,b_daily,hb_ratio,excluded';
  const detailLines = [detailHeader];
  // Sort by day_num then pair_id for easy browsing
  detailRows.sort((a, b) => a.day_num - b.day_num || a.pair_id - b.pair_id);
  for (const r of detailRows) {
    detailLines.push([
      r.pair_id, r.booli_id, r.hemnet_id, esc(r.street_address), esc(r.municipality),
      r.region, r.date, r.day_num, r.h_cum, r.b_cum, r.lookback_days,
      r.h_daily, r.b_daily, r.hb_ratio, r.excluded
    ].join(','));
  }
  const detailFile = path.join(outDir, 'hb-ratio-detail.csv');
  fs.writeFileSync(detailFile, detailLines.join('\n'), 'utf8');
  console.log(`Detail: ${detailFile} (${detailRows.length} rows)`);

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
