#!/usr/bin/env node
/**
 * compare-xlsx.js — assert two workbooks are equivalent, cell by cell.
 *
 * Written to make the exceljs streaming-writer conversion safe. Swapping
 * `new Workbook()` + `writeFile()` for `stream.xlsx.WorkbookWriter` changes HOW
 * the file is produced, and the only acceptable outcome is that WHAT it produces
 * is unchanged. "It opened in Excel and looked fine" is not evidence: the parts
 * most likely to break in streaming — frozen panes, autoFilter, merged header
 * bands, column widths, per-cell numFmt — are exactly the parts a human skim
 * does not check.
 *
 *   node scripts/compare-xlsx.js baseline.xlsx candidate.xlsx
 *   node scripts/compare-xlsx.js --smoke
 *
 * Exit 0 = equivalent. Exit 1 = differences (printed, capped). Formula cells are
 * compared on the FORMULA, not the cached result: exceljs does not evaluate, so
 * results are absent or stale in both files and comparing them proves nothing.
 */
'use strict';

const ExcelJS = require('exceljs');

const MAX_DIFFS = 40;

// exceljs represents a cell value several ways depending on type. Normalise to a
// comparable primitive so an incidental representation change is not reported as
// a data change — and so a real one still is.
function normValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    // Formula cells: compare the formula text. `result` is exceljs's cached value,
    // which it never computes itself — comparing it would compare two nulls.
    if (v.formula !== undefined) return `=${v.formula}`;
    if (v.sharedFormula !== undefined) return `=shared:${v.sharedFormula}`;
    if (v.richText) return v.richText.map((t) => t.text).join('');
    // Hyperlink BEFORE text: a link cell carries both, and two cells with the same
    // display text but different URLs must not compare equal. This repo requires
    // export links to be full clickable URLs, so a silently changed href is exactly
    // the regression this tool has to catch.
    if (v.hyperlink !== undefined) return `link:${v.hyperlink}|${v.text ?? ''}`;
    if (v.text !== undefined) return String(v.text);
    if (v instanceof Date) return v.toISOString();
    if (v.error !== undefined) return `err:${v.error}`;
  }
  return v;
}

// Styles compare structurally. JSON.stringify is order-sensitive, so sort keys.
function stable(o) {
  if (o == null) return null;
  if (typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(stable);
  const out = {};
  for (const k of Object.keys(o).sort()) {
    if (o[k] !== undefined) out[k] = stable(o[k]);
  }
  return out;
}
const sig = (o) => JSON.stringify(stable(o));

function compareSheets(a, b, diffs) {
  const push = (msg) => { if (diffs.length < MAX_DIFFS) diffs.push(msg); };
  const name = a.name;

  if (a.name !== b.name) push(`sheet name: "${a.name}" vs "${b.name}"`);
  if (a.rowCount !== b.rowCount) push(`[${name}] rowCount: ${a.rowCount} vs ${b.rowCount}`);
  if (a.columnCount !== b.columnCount) push(`[${name}] columnCount: ${a.columnCount} vs ${b.columnCount}`);

  // Frozen panes and autoFilter are the two most likely streaming casualties:
  // both live in the sheet XML and must be declared before rows are flushed.
  if (sig(a.views) !== sig(b.views)) push(`[${name}] views (frozen panes): ${sig(a.views)} vs ${sig(b.views)}`);
  if (sig(a.autoFilter) !== sig(b.autoFilter)) push(`[${name}] autoFilter: ${sig(a.autoFilter)} vs ${sig(b.autoFilter)}`);

  const maxCol = Math.max(a.columnCount, b.columnCount);
  for (let c = 1; c <= maxCol; c++) {
    const wa = a.getColumn(c).width, wb = b.getColumn(c).width;
    if (wa !== wb) push(`[${name}] col ${c} width: ${wa} vs ${wb}`);
  }

  const maxRow = Math.max(a.rowCount, b.rowCount);
  let cellsChecked = 0;
  for (let r = 1; r <= maxRow; r++) {
    const ra = a.getRow(r), rb = b.getRow(r);
    const cols = Math.max(ra.cellCount, rb.cellCount, maxCol);
    for (let c = 1; c <= cols; c++) {
      const ca = ra.getCell(c), cb = rb.getCell(c);
      const va = normValue(ca.value), vb = normValue(cb.value);
      if (va !== vb) push(`[${name}] ${ca.address} value: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`);
      if ((ca.numFmt || null) !== (cb.numFmt || null)) push(`[${name}] ${ca.address} numFmt: ${ca.numFmt} vs ${cb.numFmt}`);
      if (sig(ca.fill) !== sig(cb.fill)) push(`[${name}] ${ca.address} fill differs`);
      if (sig(ca.font) !== sig(cb.font)) push(`[${name}] ${ca.address} font differs`);
      cellsChecked++;
    }
  }
  return cellsChecked;
}

async function compare(fileA, fileB) {
  const [wa, wb] = [new ExcelJS.Workbook(), new ExcelJS.Workbook()];
  await wa.xlsx.readFile(fileA);
  await wb.xlsx.readFile(fileB);

  const diffs = [];
  const na = wa.worksheets.map((w) => w.name);
  const nb = wb.worksheets.map((w) => w.name);
  if (sig(na) !== sig(nb)) diffs.push(`worksheets: ${sig(na)} vs ${sig(nb)}`);

  let cells = 0;
  for (const sheetA of wa.worksheets) {
    const sheetB = wb.getWorksheet(sheetA.name);
    if (!sheetB) { diffs.push(`sheet "${sheetA.name}" missing from candidate`); continue; }
    cells += compareSheets(sheetA, sheetB, diffs);
  }
  return { diffs, cells, sheets: na.length };
}

async function main() {
  const [fileA, fileB] = process.argv.slice(2);
  if (!fileA || !fileB) {
    console.error('usage: node scripts/compare-xlsx.js <baseline.xlsx> <candidate.xlsx>');
    process.exit(2);
  }
  const { diffs, cells, sheets } = await compare(fileA, fileB);
  console.log(`compared ${sheets} sheet(s), ${cells.toLocaleString()} cells`);
  if (!diffs.length) { console.log('EQUIVALENT — no differences'); process.exit(0); }
  console.log(`\n${diffs.length >= MAX_DIFFS ? `first ${MAX_DIFFS}` : diffs.length} difference(s):`);
  for (const d of diffs) console.log('  ' + d);
  process.exit(1);
}

module.exports = { normValue, sig, compare };

// ---------------------------------------------------------------
//   node scripts/compare-xlsx.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`  FAIL ${n}: ${e.message}`); } };

  check('primitives pass through', () => {
    assert.strictEqual(normValue(42), 42);
    assert.strictEqual(normValue('x'), 'x');
    assert.strictEqual(normValue(null), null);
  });

  // The important one: exceljs never evaluates formulas, so `result` is null or
  // stale in BOTH files. Comparing results would compare two nulls and pass a
  // conversion that silently changed every formula.
  check('formula cells compare on the formula, not the cached result', () => {
    assert.strictEqual(normValue({ formula: 'SUM(A1:A9)', result: 10 }), '=SUM(A1:A9)');
    assert.strictEqual(normValue({ formula: 'SUM(A1:A9)', result: 999 }), '=SUM(A1:A9)');
    assert.notStrictEqual(normValue({ formula: 'SUM(A1:A9)' }), normValue({ formula: 'SUM(A1:A8)' }));
  });

  check('rich text flattens to its text', () => {
    assert.strictEqual(normValue({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  });

  check('hyperlink cells compare on the URL, not just the display text', () => {
    const a = normValue({ hyperlink: 'https://www.hemnet.se/bostad/1', text: 'listing' });
    const b = normValue({ hyperlink: 'https://www.hemnet.se/bostad/2', text: 'listing' });
    assert.notStrictEqual(a, b, 'same text + different URL must NOT compare equal');
    assert.ok(a.includes('https://www.hemnet.se/bostad/1'));
  });

  check('style signature ignores key order but not values', () => {
    assert.strictEqual(sig({ a: 1, b: 2 }), sig({ b: 2, a: 1 }));
    assert.notStrictEqual(sig({ a: 1 }), sig({ a: 2 }));
  });

  check('undefined keys do not create false differences', () => {
    assert.strictEqual(sig({ a: 1, b: undefined }), sig({ a: 1 }));
  });

  check('nested style objects compare structurally', () => {
    const f1 = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0000' } };
    const f2 = { pattern: 'solid', fgColor: { argb: 'FF0000' }, type: 'pattern' };
    assert.strictEqual(sig(f1), sig(f2));
    assert.notStrictEqual(sig(f1), sig({ ...f1, fgColor: { argb: '00FF00' } }));
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

if (require.main === module && !process.argv.includes('--smoke')) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}
