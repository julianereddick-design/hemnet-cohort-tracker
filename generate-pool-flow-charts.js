const { runJob } = require('./cron-wrapper');
const fs = require('fs');
const path = require('path');

async function main(client, log) {
  // Query all pool data (National) — use to_char to avoid timezone shift
  const poolRes = await client.query(`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date, segment, hemnet_count, booli_count
    FROM listing_gap_weekly
    WHERE region = 'National'
    ORDER BY snapshot_date, segment
  `);

  // Query PM with ≤180 day filter for Chart 4
  const pmRes = await client.query(`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date,
      SUM(booli_pm_count) AS booli_pm,
      SUM(DISTINCT hemnet_fs_count) AS hemnet_fs
    FROM sfpl_region_daily
    WHERE age_bucket IN ('0-7d', '8-14d', '15-28d', '29-90d', '91-180d')
    GROUP BY snapshot_date
    ORDER BY snapshot_date
  `);

  // Also query Hemnet PM per snapshot from listing_gap_weekly
  const hmPmRes = await client.query(`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date, hemnet_count AS hemnet_pm, booli_count AS booli_pm
    FROM listing_gap_weekly
    WHERE region = 'National' AND segment = 'pm'
    ORDER BY snapshot_date
  `);

  // Group pool data by date (snapshot_date is already a string from to_char)
  const byDate = {};
  const dates = [];
  for (const r of poolRes.rows) {
    const d = r.snapshot_date;
    if (!byDate[d]) { byDate[d] = {}; dates.push(d); }
    byDate[d][r.segment] = { h: r.hemnet_count, b: r.booli_count };
  }
  dates.sort();

  // PM ≤180d data by date (from sfpl_region_daily — snapshot_date is a string)
  const pmByDate = {};
  const pmDates = [];
  for (const r of pmRes.rows) {
    const d = r.snapshot_date;
    pmByDate[d] = { booliPm: parseInt(r.booli_pm) };
    pmDates.push(d);
  }

  // Hemnet PM by date (from listing_gap_weekly — snapshot_date is a string)
  const hmPmByDate = {};
  for (const r of hmPmRes.rows) {
    const d = r.snapshot_date;
    hmPmByDate[d] = { h: r.hemnet_pm, b: r.booli_pm };
  }

  // Cleaned dates: exclude Mar 25 (mid-week Booli scraper anomaly, 100% H/B)
  const displayDates = dates.filter(d => d !== '2026-03-25');

  // Chart 1: Pool H/B FS Ratio
  const chart1Dates = displayDates;
  const poolRatio = chart1Dates.map(d => {
    const fs = byDate[d].fs || { h: 0, b: 0 };
    return fs.b > 0 ? +(fs.h / fs.b * 100).toFixed(1) : null;
  });

  // Chart 2: Weekly Net Pool Change — only use clean weekly intervals
  // Start from Mar 30 as baseline, skip Mar 24→30 (Booli scraper glitch in between)
  const changeDates = displayDates.filter(d => d >= '2026-03-30');
  const hFsChange = [];
  const bFsChange = [];
  const changeLabels = [];
  for (let i = 1; i < changeDates.length; i++) {
    const prev = byDate[changeDates[i - 1]].fs || { h: 0, b: 0 };
    const curr = byDate[changeDates[i]].fs || { h: 0, b: 0 };
    changeLabels.push(changeDates[i]);
    hFsChange.push(curr.h - prev.h);
    bFsChange.push(curr.b - prev.b);
  }

  // Chart 3a: Hemnet FS / (Booli FS + PM) — SFPL effectiveness
  const hFsVsBooliTotal = displayDates.map(d => {
    const fs = byDate[d].fs || { h: 0, b: 0 };
    const pm = byDate[d].pm || { h: 0, b: 0 };
    const booliTotal = fs.b + pm.b;
    return booliTotal > 0 ? +(fs.h / booliTotal * 100).toFixed(1) : null;
  });

  // Chart 3b: Booli PM / Booli FS
  const booliPmVsFs = displayDates.map(d => {
    const fs = byDate[d].fs || { h: 0, b: 0 };
    const pm = byDate[d].pm || { h: 0, b: 0 };
    return fs.b > 0 ? +(pm.b / fs.b * 100).toFixed(1) : null;
  });

  // Chart 4: PM Gap Ratio = H PM / B PM (≤180d)
  const chart4Dates = displayDates.filter(d => hmPmByDate[d] && pmByDate[d]);
  const pmRatio = chart4Dates.map(d => {
    const hPm = hmPmByDate[d].h;
    const bPm = pmByDate[d].booliPm;
    return bPm > 0 ? +(hPm / bPm * 100).toFixed(1) : null;
  });

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
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 1400px; margin: 0 auto; }
    .wide { grid-column: 1 / -1; }
    .card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 14px; font-weight: 600; margin-bottom: 4px; color: #1a1a2e; }
    .card .desc { font-size: 12px; color: #888; margin-bottom: 12px; }
    canvas { width: 100% !important; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Hemnet vs Booli — National</h1>
  <div class="subtitle">Updated ${today} &middot; Data from listing_gap_weekly + sfpl_region_daily</div>

  <div class="grid">
    <div class="card">
      <h2>1. Pool Market Share (H/B FS Ratio)</h2>
      <div class="desc">Hemnet FS / Booli FS active listings (&#8804;360d). Above 100% = Hemnet has more.</div>
      <canvas id="chart1"></canvas>
    </div>
    <div class="card">
      <h2>2. Weekly Net Pool Change</h2>
      <div class="desc">Week-on-week change in FS pool. Leading indicator of share shift.</div>
      <canvas id="chart2"></canvas>
    </div>
    <div class="card">
      <h2>3a. SFPL Test — Hemnet FS / Booli Total</h2>
      <div class="desc">Hemnet FS / (Booli FS + PM). Rising = SFPL converting PM sellers to Hemnet FS.</div>
      <canvas id="chart3a"></canvas>
    </div>
    <div class="card">
      <h2>3b. Booli PM / Booli FS Ratio</h2>
      <div class="desc">Booli PM as % of Booli FS. Falling = pre-market shrinking relative to for-sale.</div>
      <canvas id="chart3b"></canvas>
    </div>
    <div class="card">
      <h2>4. Pre-Market Gap (Partnership Test)</h2>
      <div class="desc">Hemnet PM / Booli PM (&#8804;180d only). Rising = Hemnet closing the pre-market gap.</div>
      <canvas id="chart4"></canvas>
    </div>
  </div>

  <script>
    const fmt = (d) => { const dt = new Date(d); return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

    const blue = '#2563eb';
    const orange = '#f59e0b';
    const green = '#10b981';
    const red = '#ef4444';

    // Chart 1: Pool H/B Ratio (excl Mar 24)
    new Chart(document.getElementById('chart1'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(chart1Dates)}.map(fmt),
        datasets: [{
          label: 'H/B FS Ratio %',
          data: ${JSON.stringify(poolRatio)},
          borderColor: blue,
          backgroundColor: blue + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        }]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: { title: { display: true, text: 'H/B %' }, suggestedMin: 80, suggestedMax: 100 }
        }
      }
    });

    // Chart 2: Net Pool Change (excl unreliable weeks)
    new Chart(document.getElementById('chart2'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(changeLabels)}.map(fmt),
        datasets: [
          { label: 'Hemnet FS', data: ${JSON.stringify(hFsChange)}, backgroundColor: blue },
          { label: 'Booli FS', data: ${JSON.stringify(bFsChange)}, backgroundColor: orange },
        ]
      },
      options: {
        plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { y: { title: { display: true, text: 'Net Change' } } }
      }
    });

    // Chart 3a: Hemnet FS / (Booli FS + PM)
    new Chart(document.getElementById('chart3a'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(displayDates)}.map(fmt),
        datasets: [{
          label: 'H FS / (B FS + B PM) %',
          data: ${JSON.stringify(hFsVsBooliTotal)},
          borderColor: blue,
          backgroundColor: blue + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        }]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: { title: { display: true, text: '%' } }
        }
      }
    });

    // Chart 3b: Booli PM / Booli FS
    new Chart(document.getElementById('chart3b'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(displayDates)}.map(fmt),
        datasets: [{
          label: 'Booli PM / Booli FS %',
          data: ${JSON.stringify(booliPmVsFs)},
          borderColor: orange,
          backgroundColor: orange + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        }]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: { title: { display: true, text: '%' } }
        }
      }
    });

    // Chart 4: PM Gap (≤180d)
    new Chart(document.getElementById('chart4'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(chart4Dates)}.map(fmt),
        datasets: [{
          label: 'H PM / B PM (≤180d) %',
          data: ${JSON.stringify(pmRatio)},
          borderColor: green,
          backgroundColor: green + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        }]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: { title: { display: true, text: 'H/B PM %' }, suggestedMin: 15, suggestedMax: 30 }
        }
      }
    });
  </script>
</body>
</html>`;

  const outDir = path.join(__dirname, 'view-data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'pool-flow-dashboard.html');
  fs.writeFileSync(outPath, html);
  log('INFO', `Dashboard written to ${outPath}`);

  return { dates: dates.length, chartDataPoints: poolRatio.length };
}

runJob({
  scriptName: 'generate-pool-flow-charts',
  main,
  validate: (summary) => {
    if (summary.dates < 2) return 'Need at least 2 data points for charts';
    return null;
  },
});
