const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const glob = require('glob');

const SEC2_START = 8; // Column where cumulative views begin (col H)
const SKIP_COHORTS = ['2026-W09', '2026-W10', '2026-W11']; // low data quality

const REGIONS = ['Total', 'Stockholm', 'Gotenberg', 'Skane', 'Olland'];
const REGION_LABELS = {
  Total: 'TOTAL',
  Stockholm: 'Stockholm',
  Gotenberg: 'Gotenberg',
  Skane: 'Skane',
  Olland: 'Olland (350k pop County)',
};

const COHORT_COLORS = [
  '#1565C0', // blue
  '#E65100', // orange
  '#2E7D32', // green
  '#AD1457', // magenta
  '#6A1B9A', // purple
  '#00838F', // teal
  '#FF8F00', // amber
  '#37474F', // blue-grey
];


async function parseXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet('Workings');

  // Extract cohort ID from filename (hb-ratio-2026-W12.xlsx -> 2026-W12)
  const match = path.basename(filePath).match(/hb-ratio-([\w-]+)\.xlsx/);
  const cohortId = match ? match[1] : path.basename(filePath, '.xlsx');

  // Parse date columns from row 2 headers
  const row2 = ws.getRow(2);
  const dates = [];
  for (let c = SEC2_START; ; c += 2) {
    const val = row2.getCell(c).value;
    if (!val || typeof val !== 'string' || !val.startsWith('H_')) break;
    dates.push(val.replace('H_', ''));
  }

  if (dates.length === 0) {
    console.warn(`  No date columns found in ${filePath}, skipping`);
    return null;
  }

  // Find last data row (scan col 1 for 'AGGREGATION')
  let lastDataRow = 3;
  for (let r = 3; r < 10000; r++) {
    const val = ws.getRow(r).getCell(1).value;
    if (val === 'AGGREGATION') { lastDataRow = r - 1; break; }
    // Also stop if we hit a completely empty row after some data
    if (r > 10 && val === null) {
      const nextVal = ws.getRow(r + 1).getCell(1).value;
      if (nextVal === 'AGGREGATION' || nextVal === null) { lastDataRow = r - 1; break; }
    }
    lastDataRow = r;
  }

  // Read per-pair data
  const pairs = [];
  for (let r = 3; r <= lastDataRow; r++) {
    const row = ws.getRow(r);
    const region = row.getCell(6).value; // Col F = region
    if (!region) continue;

    const cumH = [];
    const cumB = [];
    for (let d = 0; d < dates.length; d++) {
      const hCol = SEC2_START + d * 2;
      const bCol = SEC2_START + d * 2 + 1;
      const hVal = row.getCell(hCol).value;
      const bVal = row.getCell(bCol).value;
      cumH.push(typeof hVal === 'number' ? hVal : null);
      cumB.push(typeof bVal === 'number' ? bVal : null);
    }

    pairs.push({ region, cumH, cumB });
  }

  console.log(`  ${cohortId}: ${pairs.length} pairs, ${dates.length} dates (${dates[0]} to ${dates[dates.length - 1]})`);

  return { cohortId, dates, pairs };
}

function computeHPct(cohortData) {
  const { cohortId, dates, pairs } = cohortData;
  const result = {}; // region -> date -> hPct

  for (const region of REGIONS) {
    result[region] = {};

    for (let d = 2; d < dates.length; d++) {
      const hIncrVals = [];
      const bIncrVals = [];

      for (const pair of pairs) {
        if (region !== 'Total' && pair.region !== region) continue;

        // Include flag H: both current and 2-day-back must be positive numbers
        const hCurr = pair.cumH[d];
        const hBack = pair.cumH[d - 2];
        const flagH = (hCurr != null && hCurr > 0 && hBack != null && hBack > 0) ? 1 : 0;

        // Include flag B: same logic
        const bCurr = pair.cumB[d];
        const bBack = pair.cumB[d - 2];
        const flagB = (bCurr != null && bCurr > 0 && bBack != null && bBack > 0) ? 1 : 0;

        // Incremental with MAX(0) floor
        if (flagH) {
          hIncrVals.push(Math.max(0, (hCurr - hBack) / 2));
        }
        if (flagB) {
          bIncrVals.push(Math.max(0, (bCurr - bBack) / 2));
        }
      }

      // Need at least 3 included pairs for both H and B
      if (hIncrVals.length < 3 || bIncrVals.length < 3) continue;

      const hMean = hIncrVals.reduce((a, b) => a + b, 0) / hIncrVals.length;
      const bMean = bIncrVals.reduce((a, b) => a + b, 0) / bIncrVals.length;

      if (hMean + bMean > 0) {
        result[region][dates[d]] = Math.round(hMean / (hMean + bMean) * 1000) / 10;
      }
    }
  }

  return result;
}

function buildHtml(allCohortResults, unionDates) {
  const chartLabels = unionDates.map(d => d.slice(5)); // MM-DD
  const labelsJson = JSON.stringify(chartLabels);
  const cohortIds = allCohortResults.map(r => r.cohortId);

  const charts = [];
  for (const region of REGIONS) {
    const datasets = [];
    for (let ci = 0; ci < allCohortResults.length; ci++) {
      const { cohortId, hPct } = allCohortResults[ci];
      const data = unionDates.map(d => hPct[region][d] ?? null);
      const color = COHORT_COLORS[ci % COHORT_COLORS.length];

      datasets.push(JSON.stringify({
        label: cohortId,
        data,
        borderColor: color,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        spanGaps: true,
      }));
    }
    charts.push({ region, regionLabel: REGION_LABELS[region], datasets });
  }

  const runDate = new Date().toISOString().slice(0, 10);

  const canvases = charts.map((c, i) =>
    `<div class="chart-container"><canvas id="chart${i}"></canvas></div>`
  ).join('\n');

  const scripts = charts.map((c, i) => `
new Chart(document.getElementById("chart${i}"), {
  type: "line",
  data: { labels: ${labelsJson}, datasets: [${c.datasets.join(',')}] },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      title: { display: true, text: "Hemnet % of Total Incremental Daily Views — ${c.regionLabel}", font: { size: 16 }, align: "start" },
      legend: { position: "top", align: "start", labels: { usePointStyle: true, boxWidth: 30 } }
    },
    scales: {
      x: { title: { display: false }, grid: { display: false } },
      y: { min: 0, title: { display: false }, grid: { color: "#eee" }, ticks: { callback: function(v) { return v + "%"; } } }
    }
  }
});`).join('\n');

  return `<!DOCTYPE html>
<html><head>
<title>Cross-Cohort H% Analysis</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"><\/script>
<style>
body { font-family: Arial, sans-serif; margin: 30px; background: #fff; color: #333; max-width: 1060px; }
.chart-container { width: 1000px; height: 420px; margin-bottom: 40px; }
h1 { font-size: 22px; margin-bottom: 5px; }
.subtitle { color: #666; font-size: 14px; margin-bottom: 30px; }
.notes { margin-top: 20px; padding: 20px 24px; background: #f8f8f8; border-left: 3px solid #1565C0; font-size: 13px; line-height: 1.7; }
.notes h3 { margin: 0 0 10px 0; font-size: 14px; color: #333; }
.notes ul { margin: 6px 0; padding-left: 20px; }
.notes li { margin-bottom: 4px; }
.notes code { background: #e8e8e8; padding: 1px 4px; border-radius: 2px; font-size: 12px; }
</style></head><body>
<h1>Cross-Cohort Analysis: Hemnet % of Incremental Views</h1>
<div class="subtitle">Generated ${runDate} | Cohorts: ${cohortIds.join(', ')} | Dates: ${unionDates[0]} to ${unionDates[unionDates.length - 1]}</div>
${canvases}
<div class="notes">
<h3>Methodology</h3>
<ul>
<li><strong>Data source:</strong> Per-pair cumulative view data from each cohort's <code>hb-ratio-*.xlsx</code> workbook.</li>
<li><strong>Include criteria:</strong> A pair-date is included only if both the current date and 2 dates prior have positive cumulative views (replicates the Section 3 flags in the xlsx).</li>
<li><strong>Daily incremental:</strong> <code>max(0, (cumulative_today - cumulative_2_days_ago) / 2)</code> for both Hemnet and Booli. Negative deltas are floored to zero.</li>
<li><strong>Hemnet % of Total:</strong> <code>mean(H_incremental) / (mean(H_incremental) + mean(B_incremental)) &times; 100</code> per region per date. Minimum 3 included pairs required.</li>
<li><strong>Regions:</strong> Stockholm, Gotenberg (V&auml;stra G&ouml;talands), Skane (Sk&aring;ne), Olland (all other counties). TOTAL includes all regions.</li>
</ul></div>
<script>
${scripts}
<\/script></body></html>`;
}

async function run() {
  // Determine export date directory
  const args = process.argv.slice(2);
  let exportDate = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) exportDate = args[i + 1];
  }

  const baseDir = path.join(__dirname, 'view-data', exportDate);
  if (!fs.existsSync(baseDir)) {
    console.error(`Export directory not found: ${baseDir}`);
    console.error('Run the cohort xlsx exports first, or use --date YYYY-MM-DD');
    process.exit(1);
  }

  // Find all hb-ratio xlsx files, excluding low-quality cohorts
  const pattern = path.join(baseDir, '*', 'hb-ratio-*.xlsx').replace(/\\/g, '/');
  const files = glob.sync(pattern).sort().filter(f => {
    const match = path.basename(f).match(/hb-ratio-([\w-]+)\.xlsx/);
    return match && !SKIP_COHORTS.includes(match[1]);
  });

  if (files.length === 0) {
    console.error(`No hb-ratio-*.xlsx files found in ${baseDir}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} xlsx files in ${baseDir}:`);

  // Parse all xlsx files
  const allCohorts = [];
  for (const f of files) {
    const data = await parseXlsx(f);
    if (data) allCohorts.push(data);
  }

  if (allCohorts.length === 0) {
    console.error('No valid cohort data found');
    process.exit(1);
  }

  // Compute H% for each cohort
  const allResults = allCohorts.map(c => ({
    cohortId: c.cohortId,
    hPct: computeHPct(c),
  }));

  // Build union date axis
  const allDatesSet = new Set();
  for (const c of allCohorts) {
    for (const d of c.dates) allDatesSet.add(d);
  }
  const unionDates = [...allDatesSet].sort();

  // Generate HTML
  const html = buildHtml(allResults, unionDates);
  const outFile = path.join(baseDir, 'cross-cohort-hpct.html');
  fs.writeFileSync(outFile, html, 'utf8');

  console.log(`\nWrote: ${outFile}`);
  console.log(`Cohorts: ${allResults.map(r => r.cohortId).join(', ')}`);
  console.log(`Date range: ${unionDates[0]} to ${unionDates[unionDates.length - 1]} (${unionDates.length} dates)`);
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
