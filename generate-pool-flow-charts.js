const { runJob } = require('./cron-wrapper');
const fs = require('fs');
const path = require('path');

async function main(client, log) {
  // Query all pool data — all regions
  const poolRes = await client.query(`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date, region, segment, hemnet_count, booli_count
    FROM listing_gap_weekly
    ORDER BY snapshot_date, region, segment
  `);

  // Query PM ≤180d per region from sfpl_region_daily
  const pmRes = await client.query(`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date, region,
      SUM(booli_pm_count) AS booli_pm
    FROM sfpl_region_daily
    WHERE age_bucket IN ('0-7d', '8-14d', '15-28d', '29-90d', '91-180d')
    GROUP BY snapshot_date, region
    ORDER BY snapshot_date, region
  `);

  // Build data structure: { region: { date: { fs: {h,b}, pm: {h,b}, pm180: {b} } } }
  const allData = {};
  const allDates = new Set();

  for (const r of poolRes.rows) {
    const region = r.region;
    const d = r.snapshot_date;
    allDates.add(d);
    if (!allData[region]) allData[region] = {};
    if (!allData[region][d]) allData[region][d] = {};
    allData[region][d][r.segment] = { h: r.hemnet_count, b: r.booli_count };
  }

  // Add PM ≤180d data
  // Also compute National PM ≤180d by summing regions
  const pm180ByDateRegion = {};
  for (const r of pmRes.rows) {
    const d = r.snapshot_date;
    const region = r.region;
    if (!pm180ByDateRegion[d]) pm180ByDateRegion[d] = {};
    pm180ByDateRegion[d][region] = parseInt(r.booli_pm);
  }

  // Merge PM ≤180d into allData and compute National
  for (const d of Object.keys(pm180ByDateRegion)) {
    const regions = pm180ByDateRegion[d];
    let nationalPm180 = 0;
    for (const [region, booliPm] of Object.entries(regions)) {
      if (allData[region] && allData[region][d]) {
        allData[region][d].pm180 = { b: booliPm };
      }
      nationalPm180 += booliPm;
    }
    if (allData['National'] && allData['National'][d]) {
      allData['National'][d].pm180 = { b: nationalPm180 };
    }
  }

  const dates = [...allDates].sort();
  const regions = ['National', 'Stockholm', 'VG', 'Rest'];
  const today = new Date().toISOString().slice(0, 10);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hemnet vs Booli — Pool & Flow Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a2e; padding: 24px; }
    .header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 4px; }
    h1 { font-size: 22px; font-weight: 600; }
    select { font-size: 16px; padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; background: #fff; }
    .subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 1400px; margin: 0 auto; }
    .card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 14px; font-weight: 600; margin-bottom: 4px; color: #1a1a2e; }
    .card .desc { font-size: 12px; color: #888; margin-bottom: 12px; }
    canvas { width: 100% !important; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>Hemnet vs Booli —</h1>
    <select id="regionSelect">
      <option value="National">National</option>
      <option value="Stockholm">Stockholm</option>
      <option value="VG">V&auml;stra G&ouml;taland</option>
      <option value="Rest">Rest of Sweden</option>
    </select>
  </div>
  <div class="subtitle">Updated ${today} &middot; Data from listing_gap_weekly + sfpl_region_daily</div>

  <div class="grid">
    <div class="card">
      <h2>1. Pool Market Share (H/B FS Ratio)</h2>
      <div class="desc">Hemnet's share of for-sale listings relative to Booli. Declining = market share erosion.</div>
      <canvas id="chart1"></canvas>
    </div>
    <div class="card">
      <h2>2. Weekly Net Pool Change</h2>
      <div class="desc">Weekly net change in for-sale pool. Shows whether platforms are growing in step. Note: true new listing flow is hard to isolate given classification differences between platforms.</div>
      <canvas id="chart2"></canvas>
    </div>
    <div class="card">
      <h2>3a. SFPL Test &mdash; Hemnet FS / Booli Total</h2>
      <div class="desc">SFPL effectiveness: Hemnet FS as a share of total Booli supply (FS + PM). Rising = SFPL is shifting sellers away from pre-market toward for-sale on Hemnet.</div>
      <canvas id="chart3a"></canvas>
    </div>
    <div class="card">
      <h2>3b. SFPL Test &mdash; Booli PM / Booli FS</h2>
      <div class="desc">SFPL from Booli's perspective: is pre-market shrinking as a share of Booli's for-sale pool? Falling = fewer sellers choosing pre-market.</div>
      <canvas id="chart3b"></canvas>
    </div>
    <div class="card">
      <h2>4. Pre-Market Gap (Strategic Partnerships)</h2>
      <div class="desc">Strategic partnerships: is Hemnet gaining pre-market share? Compares Hemnet PM to Booli PM (&le;180d). Expect slow movement &mdash; partnerships take time to build pipeline.</div>
      <canvas id="chart4"></canvas>
    </div>
  </div>

  <script>
    const ALL_DATA = ${JSON.stringify(allData)};
    const ALL_DATES = ${JSON.stringify(dates)};

    const fmt = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const blue = '#2563eb', orange = '#f59e0b', green = '#10b981';

    const charts = {};

    function renderCharts(region) {
      // Destroy existing
      Object.values(charts).forEach(c => c.destroy());

      const data = ALL_DATA[region] || {};
      const dates = ALL_DATES.filter(d => data[d]);
      // Exclude Mar 25 anomaly
      const displayDates = dates.filter(d => d !== '2026-03-25');

      // Chart 1: H/B FS ratio
      const poolRatio = displayDates.map(d => {
        const fs = data[d]?.fs || { h: 0, b: 0 };
        return fs.b > 0 ? +(fs.h / fs.b * 100).toFixed(1) : null;
      });

      charts.c1 = new Chart(document.getElementById('chart1'), {
        type: 'line',
        data: {
          labels: displayDates.map(fmt),
          datasets: [{ label: 'H/B FS %', data: poolRatio, borderColor: blue, backgroundColor: blue + '20', fill: true, tension: 0.3, pointRadius: 4 }]
        },
        options: { plugins: { legend: { display: false } }, scales: { y: { title: { display: true, text: 'H/B %' }, suggestedMin: 80, suggestedMax: 100 } } }
      });

      // Chart 2: Net pool change (skip first unreliable interval)
      const changeDates = displayDates.filter(d => d >= '2026-03-30');
      const changeLabels = [], hChg = [], bChg = [];
      for (let i = 1; i < changeDates.length; i++) {
        const prev = data[changeDates[i-1]]?.fs || { h: 0, b: 0 };
        const curr = data[changeDates[i]]?.fs || { h: 0, b: 0 };
        changeLabels.push(changeDates[i]);
        hChg.push(curr.h - prev.h);
        bChg.push(curr.b - prev.b);
      }

      charts.c2 = new Chart(document.getElementById('chart2'), {
        type: 'bar',
        data: {
          labels: changeLabels.map(fmt),
          datasets: [
            { label: 'Hemnet FS', data: hChg, backgroundColor: blue },
            { label: 'Booli FS', data: bChg, backgroundColor: orange },
          ]
        },
        options: { plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } }, scales: { y: { title: { display: true, text: 'Net Change' } } } }
      });

      // Chart 3a: H FS / (B FS + B PM)
      const sfpl = displayDates.map(d => {
        const fs = data[d]?.fs || { h: 0, b: 0 };
        const pm = data[d]?.pm || { h: 0, b: 0 };
        const total = fs.b + pm.b;
        return total > 0 ? +(fs.h / total * 100).toFixed(1) : null;
      });

      charts.c3a = new Chart(document.getElementById('chart3a'), {
        type: 'line',
        data: {
          labels: displayDates.map(fmt),
          datasets: [{ label: 'H FS / (B FS+PM) %', data: sfpl, borderColor: blue, backgroundColor: blue + '20', fill: true, tension: 0.3, pointRadius: 4 }]
        },
        options: { plugins: { legend: { display: false } }, scales: { y: { title: { display: true, text: '%' } } } }
      });

      // Chart 3b: B PM / B FS
      const pmFs = displayDates.map(d => {
        const fs = data[d]?.fs || { h: 0, b: 0 };
        const pm = data[d]?.pm || { h: 0, b: 0 };
        return fs.b > 0 ? +(pm.b / fs.b * 100).toFixed(1) : null;
      });

      charts.c3b = new Chart(document.getElementById('chart3b'), {
        type: 'line',
        data: {
          labels: displayDates.map(fmt),
          datasets: [{ label: 'B PM / B FS %', data: pmFs, borderColor: orange, backgroundColor: orange + '20', fill: true, tension: 0.3, pointRadius: 4 }]
        },
        options: { plugins: { legend: { display: false } }, scales: { y: { title: { display: true, text: '%' } } } }
      });

      // Chart 4: H PM / B PM (≤180d)
      const pm180Dates = displayDates.filter(d => data[d]?.pm && data[d]?.pm180);
      const pmGap = pm180Dates.map(d => {
        const hPm = data[d].pm.h;
        const bPm = data[d].pm180.b;
        return bPm > 0 ? +(hPm / bPm * 100).toFixed(1) : null;
      });

      charts.c4 = new Chart(document.getElementById('chart4'), {
        type: 'line',
        data: {
          labels: pm180Dates.map(fmt),
          datasets: [{ label: 'H PM / B PM (≤180d) %', data: pmGap, borderColor: green, backgroundColor: green + '20', fill: true, tension: 0.3, pointRadius: 4 }]
        },
        options: { plugins: { legend: { display: false } }, scales: { y: { title: { display: true, text: 'H/B PM %' }, suggestedMin: 15, suggestedMax: 30 } } }
      });
    }

    // Initial render
    renderCharts('National');

    // Dropdown handler
    document.getElementById('regionSelect').addEventListener('change', (e) => {
      renderCharts(e.target.value);
    });
  </script>
</body>
</html>`;

  const outDir = path.join(__dirname, 'view-data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'pool-flow-dashboard.html');
  fs.writeFileSync(outPath, html);
  log('INFO', `Dashboard written to ${outPath}`);

  return { dates: dates.length, regions: regions.length };
}

runJob({
  scriptName: 'generate-pool-flow-charts',
  main,
  validate: (summary) => {
    if (summary.dates < 2) return 'Need at least 2 data points for charts';
    return null;
  },
});
