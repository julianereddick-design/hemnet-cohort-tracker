const { createClient } = require('./db');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

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

// Convert 1-based column number to Excel letter (1=A, 27=AA, etc.)
function colLetter(n) {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

async function run() {
  const client = createClient();
  client.query_timeout = 60000;
  await client.connect();
  console.log('Connected to DB');

  // Parse CLI args
  const args = process.argv.slice(2);
  let cohortId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cohort' && args[i + 1]) cohortId = args[i + 1];
  }

  if (!cohortId) {
    const res = await client.query('SELECT DISTINCT cohort_id FROM cohort_pairs ORDER BY cohort_id DESC LIMIT 1');
    cohortId = res.rows[0].cohort_id;
    console.log(`Using latest cohort: ${cohortId}`);
  }

  // Query pairs
  const pairsRes = await client.query(`
    SELECT id, booli_id, hemnet_id, street_address, municipality, county,
           booli_listed::text AS booli_listed
    FROM cohort_pairs
    WHERE cohort_id = $1
    ORDER BY county, municipality, id
  `, [cohortId]);
  const pairs = pairsRes.rows;
  console.log(`Cohort: ${cohortId}, ${pairs.length} pairs`);

  // Query all views
  const viewsRes = await client.query(`
    SELECT dv.pair_id, dv.date::text AS date, dv.booli_views, dv.hemnet_views
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
  `, [cohortId]);

  // Build view lookup: pair_id -> date -> {hemnet_views, booli_views}
  const viewMap = new Map();
  for (const v of viewsRes.rows) {
    viewMap.set(`${v.pair_id}_${v.date}`, v);
  }

  // Build date list (sorted, exclude latest as it may be incomplete)
  const allDates = [...new Set(viewsRes.rows.map(r => r.date))].sort();
  const dates = allDates.slice(0, -1);
  console.log(`Dates: ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} dates, latest excluded)`);

  // =====================
  // COLUMN LAYOUT
  // =====================
  // Section 1: Metadata (A-F = cols 1-6)
  const META_COLS = 6;
  // Section 2: Cumulative views (after blank col)
  const SEC2_START = META_COLS + 2; // col 8 (H) — col 7 is blank separator
  const dateColCount = dates.length * 2; // H + B per date
  // Section 3: Flags (after blank col)
  const SEC3_START = SEC2_START + dateColCount + 1; // +1 for blank separator
  // Section 4: Incrementals (after blank col)
  const SEC4_START = SEC3_START + dateColCount + 1;

  console.log(`Layout: Sec2 starts col ${SEC2_START}, Sec3 col ${SEC3_START}, Sec4 col ${SEC4_START}`);
  console.log(`Total columns: ${SEC4_START + dateColCount - 1}`);

  // =====================
  // BUILD WORKBOOK
  // =====================
  const wb = new ExcelJS.Workbook();
  wb.creator = 'hemnet-cohort-tracker';
  const ws = wb.addWorksheet('Workings');

  const lastDataRow = pairs.length + 2; // row 1=section headers, row 2=col headers, data starts row 3
  const HEADER_FILL_BLUE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  const HEADER_FILL_ORANGE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
  const HEADER_FILL_GREEN = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };

  // =====================
  // ROW 1: Section headers
  // =====================
  const row1 = ws.getRow(1);
  row1.font = { bold: true, size: 11 };

  // Section 2 header
  ws.mergeCells(1, SEC2_START, 1, SEC2_START + dateColCount - 1);
  row1.getCell(SEC2_START).value = 'Cumulative Views';
  row1.getCell(SEC2_START).fill = HEADER_FILL_BLUE;

  // Section 3 header
  ws.mergeCells(1, SEC3_START, 1, SEC3_START + dateColCount - 1);
  row1.getCell(SEC3_START).value = 'Include? (2-day lookback exists)';
  row1.getCell(SEC3_START).fill = HEADER_FILL_ORANGE;

  // Section 4 header
  ws.mergeCells(1, SEC4_START, 1, SEC4_START + dateColCount - 1);
  row1.getCell(SEC4_START).value = 'Daily Incrementals (2-day avg)';
  row1.getCell(SEC4_START).fill = HEADER_FILL_GREEN;

  // =====================
  // ROW 2: Column headers
  // =====================
  const row2 = ws.getRow(2);
  row2.font = { bold: true };

  // Section 1: metadata headers
  // A=pair_id, B=booli_id(hidden), C=hemnet_id(hidden), D=street_address, E=county(hidden), F=region(hidden)
  const metaHeaders = ['pair_id', 'booli_id', 'hemnet_id', 'street_address', 'county', 'region'];
  const metaWidths = [10, 12, 12, 25, 18, 12];
  const hiddenCols = [2, 3, 5, 6]; // B, C, E, F
  for (let i = 0; i < metaHeaders.length; i++) {
    row2.getCell(i + 1).value = metaHeaders[i];
    row2.getCell(i + 1).fill = HEADER_FILL_BLUE;
    ws.getColumn(i + 1).width = metaWidths[i];
    if (hiddenCols.includes(i + 1)) ws.getColumn(i + 1).hidden = true;
  }

  // Section 2: date headers (H_date, B_date alternating)
  for (let d = 0; d < dates.length; d++) {
    const hCol = SEC2_START + d * 2;
    const bCol = SEC2_START + d * 2 + 1;
    row2.getCell(hCol).value = `H_${dates[d]}`;
    row2.getCell(bCol).value = `B_${dates[d]}`;
    row2.getCell(hCol).fill = HEADER_FILL_BLUE;
    row2.getCell(bCol).fill = HEADER_FILL_BLUE;
    ws.getColumn(hCol).width = 10;
    ws.getColumn(bCol).width = 10;
  }

  // Section 3: flag headers (echo Section 2 headers via formula)
  for (let d = 0; d < dates.length; d++) {
    const hColSec2 = SEC2_START + d * 2;
    const bColSec2 = SEC2_START + d * 2 + 1;
    const hColSec3 = SEC3_START + d * 2;
    const bColSec3 = SEC3_START + d * 2 + 1;
    row2.getCell(hColSec3).value = { formula: `${colLetter(hColSec2)}2` };
    row2.getCell(bColSec3).value = { formula: `${colLetter(bColSec2)}2` };
    row2.getCell(hColSec3).fill = HEADER_FILL_ORANGE;
    row2.getCell(bColSec3).fill = HEADER_FILL_ORANGE;
    ws.getColumn(hColSec3).width = 10;
    ws.getColumn(bColSec3).width = 10;
  }

  // Section 4: incremental headers (echo Section 2 headers via formula)
  for (let d = 0; d < dates.length; d++) {
    const hColSec2 = SEC2_START + d * 2;
    const bColSec2 = SEC2_START + d * 2 + 1;
    const hColSec4 = SEC4_START + d * 2;
    const bColSec4 = SEC4_START + d * 2 + 1;
    row2.getCell(hColSec4).value = { formula: `${colLetter(hColSec2)}2` };
    row2.getCell(bColSec4).value = { formula: `${colLetter(bColSec2)}2` };
    row2.getCell(hColSec4).fill = HEADER_FILL_GREEN;
    row2.getCell(bColSec4).fill = HEADER_FILL_GREEN;
    ws.getColumn(hColSec4).width = 10;
    ws.getColumn(bColSec4).width = 10;
  }

  // =====================
  // DATA ROWS (row 3 onward)
  // =====================
  for (let p = 0; p < pairs.length; p++) {
    const pair = pairs[p];
    const r = p + 3; // Excel row number
    const row = ws.getRow(r);
    const region = countyToRegion(pair.county);

    // Section 1: metadata (static values)
    row.getCell(1).value = pair.id;
    row.getCell(2).value = pair.booli_id;
    row.getCell(3).value = pair.hemnet_id;
    row.getCell(4).value = pair.street_address || '';
    row.getCell(5).value = pair.county || '';
    row.getCell(6).value = region;

    // Section 2: cumulative views (static values)
    for (let d = 0; d < dates.length; d++) {
      const v = viewMap.get(`${pair.id}_${dates[d]}`);
      const hCol = SEC2_START + d * 2;
      const bCol = SEC2_START + d * 2 + 1;
      // Write value or leave blank (null)
      if (v && v.hemnet_views != null) row.getCell(hCol).value = v.hemnet_views;
      if (v && v.booli_views != null) row.getCell(bCol).value = v.booli_views;
    }

    // Section 3: inclusion flags (formulas)
    for (let d = 0; d < dates.length; d++) {
      const hColSec2 = colLetter(SEC2_START + d * 2);       // current H
      const bColSec2 = colLetter(SEC2_START + d * 2 + 1);   // current B
      const hColSec3 = SEC3_START + d * 2;
      const bColSec3 = SEC3_START + d * 2 + 1;

      if (d < 2) {
        // No 2-day lookback available for first 2 dates
        row.getCell(hColSec3).value = 0;
        row.getCell(bColSec3).value = 0;
      } else {
        const hCol2back = colLetter(SEC2_START + (d - 2) * 2);     // H 2 dates back
        const bCol2back = colLetter(SEC2_START + (d - 2) * 2 + 1); // B 2 dates back
        row.getCell(hColSec3).value = { formula: `IF(AND(${hColSec2}${r}>0,${hCol2back}${r}>0),1,0)` };
        row.getCell(bColSec3).value = { formula: `IF(AND(${bColSec2}${r}>0,${bCol2back}${r}>0),1,0)` };
      }
    }

    // Section 4: incremental daily views (formulas)
    for (let d = 0; d < dates.length; d++) {
      const hColSec4 = SEC4_START + d * 2;
      const bColSec4 = SEC4_START + d * 2 + 1;

      if (d < 2) {
        // No 2-day lookback available
        row.getCell(hColSec4).value = 0;
        row.getCell(bColSec4).value = 0;
      } else {
        const hCurr = colLetter(SEC2_START + d * 2);
        const bCurr = colLetter(SEC2_START + d * 2 + 1);
        const h2back = colLetter(SEC2_START + (d - 2) * 2);
        const b2back = colLetter(SEC2_START + (d - 2) * 2 + 1);
        const hFlag = colLetter(SEC3_START + d * 2);
        const bFlag = colLetter(SEC3_START + d * 2 + 1);

        row.getCell(hColSec4).value = { formula: `MAX(0,(${hCurr}${r}-${h2back}${r})/2)*${hFlag}${r}` };
        row.getCell(bColSec4).value = { formula: `MAX(0,(${bCurr}${r}-${b2back}${r})/2)*${bFlag}${r}` };
        row.getCell(hColSec4).numFmt = '0.0';
        row.getCell(bColSec4).numFmt = '0.0';
      }
    }

    row.commit();
  }

  // =====================
  // FREEZE & FILTER
  // =====================
  ws.views = [{ state: 'frozen', xSplit: META_COLS, ySplit: 2 }];
  ws.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: lastDataRow, column: SEC4_START + dateColCount - 1 },
  };

  // =====================
  // AGGREGATION (summary rows below data)
  // =====================
  const REGIONS = ['Stockholm', 'Gotenberg', 'Skane', 'Olland', 'Total'];
  const HEADER_FILL_PURPLE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5F5' } };

  // Range references for formulas (data rows only)
  const regionRange = `$F$3:$F$${lastDataRow}`;  // region column (col F)

  // Section header row
  const aggHeaderRow = lastDataRow + 2;
  const aggHeader = ws.getRow(aggHeaderRow);
  aggHeader.getCell(1).value = 'AGGREGATION';
  aggHeader.getCell(1).font = { bold: true, size: 12 };

  // Column sub-headers for the aggregation area (echo incremental date headers)
  const aggSubHeaderRow = aggHeaderRow + 1;
  const aggSubHeader = ws.getRow(aggSubHeaderRow);
  aggSubHeader.getCell(1).value = 'Region';
  aggSubHeader.getCell(4).value = 'Metric';
  aggSubHeader.font = { bold: true };
  for (let d = 0; d < dates.length; d++) {
    const hCol = SEC4_START + d * 2;
    const bCol = SEC4_START + d * 2 + 1;
    aggSubHeader.getCell(hCol).value = { formula: `${colLetter(hCol)}2` };
    aggSubHeader.getCell(bCol).value = { formula: `${colLetter(bCol)}2` };
    aggSubHeader.getCell(hCol).fill = HEADER_FILL_PURPLE;
    aggSubHeader.getCell(bCol).fill = HEADER_FILL_PURPLE;
  }

  let curRow = aggSubHeaderRow + 1;

  // Store row references for H/B ratio calculations
  const meanRows = {};
  const medianRows = {};

  for (const region of REGIONS) {
    const isTotal = region === 'Total';
    const regionLabel = region;

    // --- Row 1: Count (n) ---
    const countRow = ws.getRow(curRow);
    countRow.getCell(1).value = regionLabel;
    countRow.getCell(1).font = { bold: true };
    countRow.getCell(4).value = 'Count (n)';
    countRow.font = { color: { argb: 'FF808080' }, italic: true };
    countRow.getCell(1).font = { bold: true };

    for (let d = 0; d < dates.length; d++) {
      const hFlag = colLetter(SEC3_START + d * 2);
      const bFlag = colLetter(SEC3_START + d * 2 + 1);
      const hFlagRange = `${hFlag}$3:${hFlag}$${lastDataRow}`;
      const bFlagRange = `${bFlag}$3:${bFlag}$${lastDataRow}`;
      const hCol = SEC4_START + d * 2;
      const bCol = SEC4_START + d * 2 + 1;

      if (isTotal) {
        countRow.getCell(hCol).value = { formula: `COUNTIFS(${hFlagRange},1)` };
        countRow.getCell(bCol).value = { formula: `COUNTIFS(${bFlagRange},1)` };
      } else {
        countRow.getCell(hCol).value = { formula: `COUNTIFS(${hFlagRange},1,${regionRange},"${region}")` };
        countRow.getCell(bCol).value = { formula: `COUNTIFS(${bFlagRange},1,${regionRange},"${region}")` };
      }
    }
    curRow++;

    // --- Row 2: Mean ---
    const meanRow = ws.getRow(curRow);
    meanRows[region] = curRow;
    meanRow.getCell(1).value = '';
    meanRow.getCell(4).value = 'Mean';
    meanRow.font = { bold: true };

    for (let d = 0; d < dates.length; d++) {
      const hInc = colLetter(SEC4_START + d * 2);
      const bInc = colLetter(SEC4_START + d * 2 + 1);
      const hFlag = colLetter(SEC3_START + d * 2);
      const bFlag = colLetter(SEC3_START + d * 2 + 1);
      const hIncRange = `${hInc}$3:${hInc}$${lastDataRow}`;
      const bIncRange = `${bInc}$3:${bInc}$${lastDataRow}`;
      const hFlagRange = `${hFlag}$3:${hFlag}$${lastDataRow}`;
      const bFlagRange = `${bFlag}$3:${bFlag}$${lastDataRow}`;
      const hCol = SEC4_START + d * 2;
      const bCol = SEC4_START + d * 2 + 1;

      if (isTotal) {
        meanRow.getCell(hCol).value = { formula: `IFERROR(AVERAGEIFS(${hIncRange},${hFlagRange},1),"")` };
        meanRow.getCell(bCol).value = { formula: `IFERROR(AVERAGEIFS(${bIncRange},${bFlagRange},1),"")` };
      } else {
        meanRow.getCell(hCol).value = { formula: `IFERROR(AVERAGEIFS(${hIncRange},${hFlagRange},1,${regionRange},"${region}"),"")` };
        meanRow.getCell(bCol).value = { formula: `IFERROR(AVERAGEIFS(${bIncRange},${bFlagRange},1,${regionRange},"${region}"),"")` };
      }
      meanRow.getCell(hCol).numFmt = '0.0';
      meanRow.getCell(bCol).numFmt = '0.0';
    }
    curRow++;

    // --- Row 3: Median ---
    const medianRow = ws.getRow(curRow);
    medianRows[region] = curRow;
    medianRow.getCell(1).value = '';
    medianRow.getCell(4).value = 'Median';

    for (let d = 0; d < dates.length; d++) {
      const hInc = colLetter(SEC4_START + d * 2);
      const bInc = colLetter(SEC4_START + d * 2 + 1);
      const hFlag = colLetter(SEC3_START + d * 2);
      const bFlag = colLetter(SEC3_START + d * 2 + 1);
      const hIncRange = `${hInc}$3:${hInc}$${lastDataRow}`;
      const bIncRange = `${bInc}$3:${bInc}$${lastDataRow}`;
      const hFlagRange = `${hFlag}$3:${hFlag}$${lastDataRow}`;
      const bFlagRange = `${bFlag}$3:${bFlag}$${lastDataRow}`;
      const hCol = SEC4_START + d * 2;
      const bCol = SEC4_START + d * 2 + 1;

      // MEDIAN(FILTER(...)) with _xlfn._xlws. prefix for ExcelJS compatibility
      if (isTotal) {
        medianRow.getCell(hCol).value = { formula: `IFERROR(MEDIAN(_xlfn._xlws.FILTER(${hIncRange},${hFlagRange}=1)),"")` };
        medianRow.getCell(bCol).value = { formula: `IFERROR(MEDIAN(_xlfn._xlws.FILTER(${bIncRange},${bFlagRange}=1)),"")` };
      } else {
        medianRow.getCell(hCol).value = { formula: `IFERROR(MEDIAN(_xlfn._xlws.FILTER(${hIncRange},(${hFlagRange}=1)*(${regionRange}="${region}"))),"")` };
        medianRow.getCell(bCol).value = { formula: `IFERROR(MEDIAN(_xlfn._xlws.FILTER(${bIncRange},(${bFlagRange}=1)*(${regionRange}="${region}"))),"")` };
      }
      medianRow.getCell(hCol).numFmt = '0.0';
      medianRow.getCell(bCol).numFmt = '0.0';
    }
    curRow++;

    // --- Row 4: H/B Ratio (Mean) ---
    const hbMeanRow = ws.getRow(curRow);
    hbMeanRow.getCell(1).value = '';
    hbMeanRow.getCell(4).value = 'H/B Ratio (Mean)';
    hbMeanRow.font = { bold: true };

    for (let d = 0; d < dates.length; d++) {
      const hCol = SEC4_START + d * 2;
      const bCol = SEC4_START + d * 2 + 1;
      const mr = meanRows[region];
      const hMeanRef = `${colLetter(hCol)}${mr}`;
      const bMeanRef = `${colLetter(bCol)}${mr}`;
      // Put ratio in the H column position, leave B blank
      hbMeanRow.getCell(hCol).value = { formula: `IFERROR(${hMeanRef}/${bMeanRef},"")` };
      hbMeanRow.getCell(hCol).numFmt = '0.00';
    }
    curRow++;

    // --- Row 5: H/B Ratio (Median) ---
    const hbMedianRow = ws.getRow(curRow);
    hbMedianRow.getCell(1).value = '';
    hbMedianRow.getCell(4).value = 'H/B Ratio (Median)';

    for (let d = 0; d < dates.length; d++) {
      const hCol = SEC4_START + d * 2;
      const bCol = SEC4_START + d * 2 + 1;
      const mr = medianRows[region];
      const hMedRef = `${colLetter(hCol)}${mr}`;
      const bMedRef = `${colLetter(bCol)}${mr}`;
      hbMedianRow.getCell(hCol).value = { formula: `IFERROR(${hMedRef}/${bMedRef},"")` };
      hbMedianRow.getCell(hCol).numFmt = '0.00';
    }
    curRow++;

    // --- Row 6: H % of Total (Mean) ---
    const hPctMeanRow = ws.getRow(curRow);
    hPctMeanRow.getCell(1).value = '';
    hPctMeanRow.getCell(4).value = 'H % of Total (Mean)';
    hPctMeanRow.font = { bold: true };

    for (let d = 0; d < dates.length; d++) {
      const hCol = SEC4_START + d * 2;
      const bCol = SEC4_START + d * 2 + 1;
      const mr = meanRows[region];
      const hRef = `${colLetter(hCol)}${mr}`;
      const bRef = `${colLetter(bCol)}${mr}`;
      hPctMeanRow.getCell(hCol).value = { formula: `IFERROR(${hRef}/(${hRef}+${bRef}),"")` };
      hPctMeanRow.getCell(hCol).numFmt = '0.0%';
    }
    curRow++;

    // --- Row 7: H % of Total (Median) ---
    const hPctMedianRow = ws.getRow(curRow);
    hPctMedianRow.getCell(1).value = '';
    hPctMedianRow.getCell(4).value = 'H % of Total (Median)';

    for (let d = 0; d < dates.length; d++) {
      const hCol = SEC4_START + d * 2;
      const bCol = SEC4_START + d * 2 + 1;
      const mr = medianRows[region];
      const hRef = `${colLetter(hCol)}${mr}`;
      const bRef = `${colLetter(bCol)}${mr}`;
      hPctMedianRow.getCell(hCol).value = { formula: `IFERROR(${hRef}/(${hRef}+${bRef}),"")` };
      hPctMedianRow.getCell(hCol).numFmt = '0.0%';
    }
    curRow++;

    // Blank spacer row
    curRow++;
  }

  console.log(`Aggregation rows: ${aggHeaderRow} to ${curRow - 1}`);

  // =====================
  // COMPUTE CHART DATA (2-day methodology, same as Excel)
  // =====================
  function median(arr) {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Build per-region, per-date arrays of daily incrementals
  // regionDateData[region][dateIdx] = { hVals: [], bVals: [], ratioVals: [] }
  const chartRegions = ['TOTAL', 'Stockholm', 'Gotenberg', 'Skane', 'Olland'];
  const regionDateData = {};
  for (const reg of chartRegions) regionDateData[reg] = {};

  for (const pair of pairs) {
    const region = countyToRegion(pair.county);

    for (let d = 2; d < dates.length; d++) {
      const curr = viewMap.get(`${pair.id}_${dates[d]}`);
      const back = viewMap.get(`${pair.id}_${dates[d - 2]}`);
      if (!curr || !back) continue;
      if (curr.hemnet_views == null || curr.booli_views == null) continue;
      if (back.hemnet_views == null || back.booli_views == null) continue;
      if (curr.hemnet_views <= 0 || back.hemnet_views <= 0) continue;
      if (curr.booli_views <= 0 || back.booli_views <= 0) continue;

      const hDaily = (curr.hemnet_views - back.hemnet_views) / 2;
      const bDaily = (curr.booli_views - back.booli_views) / 2;
      if (bDaily <= 0) continue;

      const ratio = hDaily / bDaily;
      if (ratio < 0 || ratio > 20) continue; // outlier filter

      for (const reg of [region, 'TOTAL']) {
        if (!regionDateData[reg][d]) regionDateData[reg][d] = { hVals: [], bVals: [], ratioVals: [] };
        regionDateData[reg][d].hVals.push(hDaily);
        regionDateData[reg][d].bVals.push(bDaily);
        regionDateData[reg][d].ratioVals.push(ratio);
      }
    }
  }

  // Build chart series
  const REGION_STYLES = {
    TOTAL:     { color: '#1565C0', dash: [],     width: 3 },
    Stockholm: { color: '#E65100', dash: [8, 4], width: 2 },
    Gotenberg: { color: '#2E7D32', dash: [8, 4], width: 2 },
    Skane:     { color: '#90CAF9', dash: [2, 2], width: 2 },
    Olland:    { color: '#AD1457', dash: [2, 2], width: 2 },
  };
  const REGION_LABELS = {
    TOTAL: 'TOTAL', Stockholm: 'Stockholm', Gotenberg: 'Gotenberg',
    Skane: 'Skane', Olland: 'Olland (350k pop County)',
  };

  // Date labels for x-axis (only dates with possible data, i.e. d >= 2)
  const chartDates = dates.slice(2);
  const chartLabels = chartDates.map(d => d.slice(5)); // MM-DD

  function buildSeries(regionKey, valueExtractor, minSample = 3) {
    return chartDates.map((_, i) => {
      const di = i + 2; // index into dates array
      const data = regionDateData[regionKey][di];
      if (!data) return null;
      const vals = valueExtractor(data);
      return vals.length >= minSample ? Math.round(median(vals) * 100) / 100 : null;
    });
  }

  function makeDataset(regionKey, data, style) {
    return JSON.stringify({
      label: REGION_LABELS[regionKey],
      data: data,
      borderColor: style.color,
      borderWidth: style.width,
      borderDash: style.dash,
      pointRadius: 0,
      tension: 0.3,
      spanGaps: true
    });
  }

  // =====================
  // WRITE FILES
  // =====================
  const runDate = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, 'view-data', runDate, cohortId);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Excel
  const outFile = path.join(outDir, `hb-ratio-${cohortId}.xlsx`);
  console.log('Writing xlsx...');
  await wb.xlsx.writeFile(outFile);
  console.log(`Wrote: ${outFile}`);

  // Build chart data
  const ratioSeries = {};
  const hPctSeries = {};
  for (const r of chartRegions) {
    ratioSeries[r] = buildSeries(r, d => d.ratioVals);
    hPctSeries[r] = chartDates.map((_, i) => {
      const di = i + 2;
      const dd = regionDateData[r][di];
      if (!dd) return null;
      const pctVals = [];
      for (let j = 0; j < dd.hVals.length; j++) {
        const h = dd.hVals[j];
        const b = dd.bVals[j];
        if (h + b > 0) pctVals.push(h / (h + b));
      }
      return pctVals.length >= 3 ? Math.round(median(pctVals) * 1000) / 10 : null;
    });
  }

  const ratioDatasets = chartRegions.map(r => makeDataset(r, ratioSeries[r], REGION_STYLES[r]));

  // H % of total based on sum of all incremental views (not median of per-pair ratios)
  const hPctTotalSeries = {};
  for (const r of chartRegions) {
    hPctTotalSeries[r] = chartDates.map((_, i) => {
      const di = i + 2;
      const dd = regionDateData[r][di];
      if (!dd || dd.hVals.length < 3) return null;
      const sumH = dd.hVals.reduce((a, b) => a + b, 0);
      const sumB = dd.bVals.reduce((a, b) => a + b, 0);
      return sumH + sumB > 0 ? Math.round(sumH / (sumH + sumB) * 1000) / 10 : null;
    });
  }
  const hPctDatasets = chartRegions.map(r => makeDataset(r, hPctTotalSeries[r], REGION_STYLES[r]));

  const labelsJson = JSON.stringify(chartLabels);
  const ratioDs = '[' + ratioDatasets.join(',') + ']';
  const hPctDs = '[' + hPctDatasets.join(',') + ']';

  const combinedHtml = [
    '<!DOCTYPE html>',
    '<html><head>',
    '<title>Cohort Analysis - ' + cohortId + '</title>',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"><\/script>',
    '<style>',
    'body { font-family: Arial, sans-serif; margin: 30px; background: #fff; color: #333; max-width: 1060px; }',
    '.chart-container { width: 1000px; height: 420px; margin-bottom: 40px; }',
    'h1 { font-size: 22px; margin-bottom: 5px; }',
    '.subtitle { color: #666; font-size: 14px; margin-bottom: 30px; }',
    '.notes { margin-top: 20px; padding: 20px 24px; background: #f8f8f8; border-left: 3px solid #1565C0; font-size: 13px; line-height: 1.7; }',
    '.notes h3 { margin: 0 0 10px 0; font-size: 14px; color: #333; }',
    '.notes ul { margin: 6px 0; padding-left: 20px; }',
    '.notes li { margin-bottom: 4px; }',
    '.notes code { background: #e8e8e8; padding: 1px 4px; border-radius: 2px; font-size: 12px; }',
    '</style></head><body>',
    '<h1>Cohort Analysis: ' + cohortId + '</h1>',
    '<div class="subtitle">Generated ' + runDate + ' | ' + pairs.length + ' pairs | ' + dates.length + ' dates (' + dates[0] + ' to ' + dates[dates.length - 1] + ')</div>',
    '<div class="chart-container"><canvas id="ratioChart"></canvas></div>',
    '<div class="chart-container"><canvas id="hPctChart"></canvas></div>',
    '<div class="notes">',
    '<h3>Methodology</h3>',
    '<ul>',
    '<li><strong>Data source:</strong> Cumulative view counts scraped daily from Hemnet and Booli for matched listing pairs in cohort ' + cohortId + '.</li>',
    '<li><strong>Daily incremental:</strong> For each pair on each date, the daily view rate is calculated as <code>(cumulative_today - cumulative_2_days_ago) / 2</code>. Both Hemnet and Booli use this 2-day average to keep the comparison window consistent (Booli\'s scraper only updates view counts every other day).</li>',
    '<li><strong>Inclusion criteria:</strong> A pair-date is included only if both the current date and 2 dates prior have non-null, non-zero cumulative views for that platform.</li>',
    '<li><strong>H/B Ratio:</strong> Per-pair ratio = Hemnet daily views / Booli daily views. Pairs with Booli daily &le; 0 or ratio &gt; 20 are excluded as outliers. Chart shows the <strong>median</strong> ratio across all included pairs per region per date (minimum 3 pairs required).</li>',
    '<li><strong>Hemnet % of Total:</strong> Sum of all included Hemnet daily incrementals / Sum of all included (Hemnet + Booli) daily incrementals, by region per date. This is the aggregate share based on <strong>total views</strong>, not a median of per-pair percentages.</li>',
    '<li><strong>Regions:</strong> Stockholm, Gotenberg (V&auml;stra G&ouml;talands), Skane (Sk&aring;ne), Olland (all other counties). TOTAL includes all regions.</li>',
    '</ul></div>',
    '<script>',
    'new Chart(document.getElementById("ratioChart"), {',
    '  type: "line",',
    '  data: { labels: ' + labelsJson + ', datasets: ' + ratioDs + ' },',
    '  options: {',
    '    responsive: true, maintainAspectRatio: false,',
    '    plugins: {',
    '      title: { display: true, text: "Ratio of Hemnet\'s incremental daily views to Booli \\u2014 ' + cohortId + '", font: { size: 16 }, align: "start" },',
    '      legend: { position: "top", align: "start", labels: { usePointStyle: true, boxWidth: 30 } }',
    '    },',
    '    scales: {',
    '      x: { title: { display: false }, grid: { display: false } },',
    '      y: { min: 0, title: { display: false }, grid: { color: "#eee" } }',
    '    }',
    '  }',
    '});',
    'new Chart(document.getElementById("hPctChart"), {',
    '  type: "line",',
    '  data: { labels: ' + labelsJson + ', datasets: ' + hPctDs + ' },',
    '  options: {',
    '    responsive: true, maintainAspectRatio: false,',
    '    plugins: {',
    '      title: { display: true, text: "Hemnet % of Total Incremental Daily Views \\u2014 ' + cohortId + '", font: { size: 16 }, align: "start" },',
    '      legend: { position: "top", align: "start", labels: { usePointStyle: true, boxWidth: 30 } }',
    '    },',
    '    scales: {',
    '      x: { title: { display: false }, grid: { display: false } },',
    '      y: { min: 0, title: { display: false }, grid: { color: "#eee" }, ticks: { callback: function(v) { return v + "%"; } } }',
    '    }',
    '  }',
    '});',
    '<\/script></body></html>'
  ].join('\n');

  const chartFile = path.join(outDir, 'charts.html');
  fs.writeFileSync(chartFile, combinedHtml, 'utf8');
  console.log('Charts: ' + chartFile);

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
