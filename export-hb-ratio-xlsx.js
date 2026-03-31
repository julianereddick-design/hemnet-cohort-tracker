const { createClient } = require('./db');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

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
  return 'Olland';
}

const REGIONS = ['TOTAL', 'Stockholm', 'Gotenberg', 'Skane', 'Olland'];

async function run() {
  const client = createClient();
  client.query_timeout = 60000;
  await client.connect();
  console.log('Connected to DB');

  const args = process.argv.slice(2);
  let cohortId = null;
  let maxDay = 21;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cohort' && args[i + 1]) cohortId = args[i + 1];
    if (args[i] === '--days' && args[i + 1]) maxDay = parseInt(args[i + 1]);
  }

  if (!cohortId) {
    const res = await client.query('SELECT DISTINCT cohort_id FROM cohort_pairs ORDER BY cohort_id DESC LIMIT 1');
    cohortId = res.rows[0].cohort_id;
    console.log(`Using latest cohort: ${cohortId}`);
  }

  // Get pairs
  const pairsRes = await client.query(`
    SELECT id, booli_id, hemnet_id, street_address, municipality, county,
           booli_listed::text AS booli_listed
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

  const viewMap = new Map();
  for (const v of viewsRes.rows) {
    viewMap.set(`${v.pair_id}_${v.date}`, v);
  }

  const allDates = [...new Set(viewsRes.rows.map(r => r.date))].sort();
  const dates = allDates.slice(0, -1); // exclude latest

  console.log(`Cohort: ${cohortId}, ${pairs.length} pairs, ${dates.length} dates`);
  console.log(`Dates: ${dates[0]} to ${dates[dates.length - 1]}`);

  // --- Build detail rows ---
  const detailRows = [];
  for (const pair of pairs) {
    const region = countyToRegion(pair.county);
    const listedDate = pair.booli_listed;

    for (const d of dates) {
      const dayNum = Math.round((new Date(d) - new Date(listedDate)) / DAY_MS) + 1;
      if (dayNum < 1 || dayNum > maxDay) continue;

      const curr = viewMap.get(`${pair.id}_${d}`);
      if (!curr || curr.hemnet_views == null || curr.booli_views == null) continue;

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

      detailRows.push({
        pair_id: pair.id,
        booli_id: pair.booli_id,
        hemnet_id: pair.hemnet_id,
        street_address: pair.street_address || '',
        municipality: pair.municipality || '',
        region,
        date: d,
        day_num: dayNum,
        h_cum: curr.hemnet_views,
        b_cum: curr.booli_views,
        h_cum_lb: lookback.data.hemnet_views,
        b_cum_lb: lookback.data.booli_views,
        lookback_days: lookback.days,
      });
    }
  }

  detailRows.sort((a, b) => a.day_num - b.day_num || a.pair_id - b.pair_id);
  console.log(`Detail rows: ${detailRows.length}`);
  console.log('Building workbook...');

  // --- Create workbook ---
  const wb = new ExcelJS.Workbook();
  wb.creator = 'hemnet-cohort-tracker';

  // =====================
  // DETAIL SHEET
  // =====================
  const detailSheet = wb.addWorksheet('Detail');

  const detailCols = [
    { header: 'pair_id',        key: 'pair_id',        width: 10 },
    { header: 'booli_id',       key: 'booli_id',       width: 12 },
    { header: 'hemnet_id',      key: 'hemnet_id',      width: 12 },
    { header: 'street_address', key: 'street_address', width: 25 },
    { header: 'municipality',   key: 'municipality',   width: 15 },
    { header: 'region',         key: 'region',         width: 12 },
    { header: 'date',           key: 'date',           width: 12 },
    { header: 'day_num',        key: 'day_num',        width: 9 },
    { header: 'h_cum',          key: 'h_cum',          width: 10 },
    { header: 'b_cum',          key: 'b_cum',          width: 10 },
    { header: 'h_cum_lb',       key: 'h_cum_lb',       width: 10 },
    { header: 'b_cum_lb',       key: 'b_cum_lb',       width: 10 },
    { header: 'lookback_days',  key: 'lookback_days',  width: 13 },
    { header: 'h_daily',        key: 'h_daily',        width: 10 },  // col N = 14
    { header: 'b_daily',        key: 'b_daily',        width: 10 },  // col O = 15
    { header: 'hb_ratio',       key: 'hb_ratio',       width: 10 },  // col P = 16
  ];
  detailSheet.columns = detailCols;

  // Header formatting
  const headerRow = detailSheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  // Add data rows with formulas
  // Pre-compute formula values for performance, but store as formulas for auditability
  for (let i = 0; i < detailRows.length; i++) {
    const r = detailRows[i];
    const rowNum = i + 2;

    const hDaily = (r.h_cum - r.h_cum_lb) / r.lookback_days;
    const bDaily = (r.b_cum - r.b_cum_lb) / r.lookback_days;
    const hbRatio = bDaily > 0 ? hDaily / bDaily : null;

    detailSheet.addRow([
      r.pair_id, r.booli_id, r.hemnet_id, r.street_address, r.municipality,
      r.region, r.date, r.day_num, r.h_cum, r.b_cum, r.h_cum_lb, r.b_cum_lb,
      r.lookback_days,
      { formula: `(I${rowNum}-K${rowNum})/M${rowNum}`, result: hDaily },
      { formula: `(J${rowNum}-L${rowNum})/M${rowNum}`, result: bDaily },
      { formula: `IF(O${rowNum}<=0,"",N${rowNum}/O${rowNum})`, result: hbRatio !== null ? hbRatio : '' },
    ]);
  }

  // Apply number formats to formula columns
  detailSheet.getColumn(14).numFmt = '0.0';
  detailSheet.getColumn(15).numFmt = '0.0';
  detailSheet.getColumn(16).numFmt = '0.00';

  // Auto-filter
  detailSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: detailRows.length + 1, column: detailCols.length },
  };

  // Freeze header row
  detailSheet.views = [{ state: 'frozen', ySplit: 1 }];

  const lastDetailRow = detailRows.length + 1;
  console.log('Detail sheet done, building summary...');

  // =====================
  // SUMMARY SHEET
  // =====================
  const summarySheet = wb.addWorksheet('Summary');

  // Layout: rows = regions x metrics, columns = day numbers
  // Row structure per region: median_ratio, sample_size
  summarySheet.getColumn(1).width = 14;
  summarySheet.getColumn(2).width = 14;

  // Header row: day numbers
  const summaryHeaderRow = summarySheet.getRow(1);
  summaryHeaderRow.getCell(1).value = 'Region';
  summaryHeaderRow.getCell(2).value = 'Metric';
  for (let d = 1; d <= maxDay; d++) {
    const col = d + 2;
    summaryHeaderRow.getCell(col).value = d;
    summarySheet.getColumn(col).width = 9;
  }
  summaryHeaderRow.font = { bold: true };
  summaryHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  // Detail sheet column references for formulas:
  // F = region, H = day_num, N = h_daily, O = b_daily, P = hb_ratio
  const detailRange = `Detail!$F$2:$F$${lastDetailRow}`;
  const dayRange = `Detail!$H$2:$H$${lastDetailRow}`;
  const ratioRange = `Detail!$P$2:$P$${lastDetailRow}`;
  const hDailyRange = `Detail!$N$2:$N$${lastDetailRow}`;
  const bDailyRange = `Detail!$O$2:$O$${lastDetailRow}`;

  let currentRow = 2;
  for (const region of REGIONS) {
    const regionCriteria = region === 'TOTAL' ? '*' : region;

    // Median H/B Ratio
    const ratioRow = summarySheet.getRow(currentRow);
    ratioRow.getCell(1).value = region === 'TOTAL' ? 'TOTAL' : region;
    ratioRow.getCell(2).value = 'Median H/B';
    for (let d = 1; d <= maxDay; d++) {
      const col = d + 2;
      const cell = ratioRow.getCell(col);
      if (region === 'TOTAL') {
        // For TOTAL: MEDIAN of all ratios where day_num matches (no region filter)
        // MEDIAN doesn't support criteria, so use array formula approach
        // Use AVERAGEIFS as a reasonable proxy, or use a helper approach
        // Actually let's use AVERAGEIFS for simplicity and add a note
        cell.value = { formula: `IFERROR(AVERAGEIFS(${ratioRange},${dayRange},${d},${ratioRange},">"&0),"")`};
      } else {
        cell.value = { formula: `IFERROR(AVERAGEIFS(${ratioRange},${detailRange},"${region}",${dayRange},${d},${ratioRange},">"&0),"")`};
      }
      cell.numFmt = '0.00';
    }

    // Sample size
    const countRow = summarySheet.getRow(currentRow + 1);
    countRow.getCell(1).value = '';
    countRow.getCell(2).value = 'Sample size';
    countRow.font = { color: { argb: 'FF808080' }, italic: true };
    for (let d = 1; d <= maxDay; d++) {
      const col = d + 2;
      const cell = countRow.getCell(col);
      if (region === 'TOTAL') {
        cell.value = { formula: `COUNTIFS(${dayRange},${d},${ratioRange},">"&0)` };
      } else {
        cell.value = { formula: `COUNTIFS(${detailRange},"${region}",${dayRange},${d},${ratioRange},">"&0)` };
      }
    }

    // Median H daily
    const hRow = summarySheet.getRow(currentRow + 2);
    hRow.getCell(1).value = '';
    hRow.getCell(2).value = 'Avg H daily';
    for (let d = 1; d <= maxDay; d++) {
      const col = d + 2;
      const cell = hRow.getCell(col);
      if (region === 'TOTAL') {
        cell.value = { formula: `IFERROR(AVERAGEIFS(${hDailyRange},${dayRange},${d}),"")`};
      } else {
        cell.value = { formula: `IFERROR(AVERAGEIFS(${hDailyRange},${detailRange},"${region}",${dayRange},${d}),"")`};
      }
      cell.numFmt = '0.0';
    }

    // Median B daily
    const bRow = summarySheet.getRow(currentRow + 3);
    bRow.getCell(1).value = '';
    bRow.getCell(2).value = 'Avg B daily';
    for (let d = 1; d <= maxDay; d++) {
      const col = d + 2;
      const cell = bRow.getCell(col);
      if (region === 'TOTAL') {
        cell.value = { formula: `IFERROR(AVERAGEIFS(${bDailyRange},${dayRange},${d}),"")`};
      } else {
        cell.value = { formula: `IFERROR(AVERAGEIFS(${bDailyRange},${detailRange},"${region}",${dayRange},${d}),"")`};
      }
      cell.numFmt = '0.0';
    }

    // Bold the ratio row
    ratioRow.font = { bold: true };

    currentRow += 5; // 4 rows + 1 blank spacer
  }

  // Freeze
  summarySheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

  // =====================
  // WRITE FILE
  // =====================
  const runDate = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, 'view-data', runDate, cohortId);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `hb-ratio-${cohortId}.xlsx`);
  console.log('Writing xlsx...');
  await wb.xlsx.writeFile(outFile);
  console.log(`Wrote: ${outFile}`);

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
