'use strict';

// lib/weekly-pack.js — the weekly data pack attached under the Monday views report (2026-11-09).
// GrokBot builds the team's weekly deliverable from Slack: it reads these attachments
// directly (it cannot see the Decade shared drive, and the :3800 links are not reachable for
// it). So the pack is plain data plus a short method note, all in the report's thread:
//
//   cross-cohort-hpct.csv   H% per cohort x region x date (export-cross-cohort-chart.js)
//   views-like-for-like.csv weekly like-for-like H% (lib/views-like-for-like.js)
//   paid-share.csv          share of Booli's new homes with a paid Hemnet ad (lib/paid-coverage.js)
//   market-totals.csv       daily listing totals, last 8 weeks (written here)
//   weekly-pack.xlsx        the four above as sheets + a Method sheet (written here)
//   methodology.md          what each file is, definitions, known breaks (written here)
//
// A CSV that is missing this week (its step failed) is left out and named in the note.
//
//   node lib/weekly-pack.js --smoke    (offline)

const fs = require('fs');
const path = require('path');

const SOURCES = [
  { file: 'cross-cohort-hpct.csv', sheet: 'H% by cohort' },
  { file: 'views-like-for-like.csv', sheet: 'Views like-for-like' },
  { file: 'paid-share.csv', sheet: 'Sellers paying' },
  { file: 'market-totals.csv', sheet: 'Market totals' },
];
const MARKET_SERIES = [
  ['hemnet', 'till_salu'], ['hemnet', 'till_salu_excl_newbuild'], ['hemnet', 'kommande'],
  ['booli', 'till_salu'], ['booli', 'kommande'],
];

// Dated breaks a reader of the series must know about. Newest first; add new ones here.
const KNOWN_BREAKS = [
  '2026-11-06: Hemnet\'s for-sale total started counting every unit of a new-build project (~+6,200 overnight). ' +
    'Compare over time with hemnet_till_salu_excl_newbuild (recorded from 2026-11-09), not hemnet_till_salu.',
  '2026-10-30 to 2026-11-02: Hemnet view counts were not readable (site change). Views over those days are counted ' +
    'in the next reading, but day-by-day detail is missing; like-for-like weeks leave those intervals out.',
  '2026-10-27: Hemnet began showing AGGREGATED listings (copied from agency sites, no view counter); its totals jumped ' +
    '(for sale ~47k to ~63k, coming soon ~7.6k to ~27k).',
  '2026-10-20: Hemnet launched free (MINIMAL) ads. From 2026-11-04 the views series uses paid Hemnet ads only; ' +
    'earlier cohorts were all paid, so the series stays like-for-like.',
];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Minimal RFC-4180 parser: quoted fields, doubled quotes, commas/newlines inside quotes.
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

// Wide daily table: one row per day, one column per site_segment.
function marketTotalsCsv(rows) {
  const cols = MARKET_SERIES.map(([s, g]) => `${s}_${g}`);
  const byDay = new Map();
  for (const r of rows) {
    const k = `${r.site}_${r.segment}`;
    if (!cols.includes(k)) continue;
    if (!byDay.has(r.day)) byDay.set(r.day, {});
    byDay.get(r.day)[k] = r.total;
  }
  const days = [...byDay.keys()].sort();
  return [['day', ...cols].join(','), ...days.map(d => [d, ...cols.map(c => csvCell(byDay.get(d)[c]))].join(','))].join('\n') + '\n';
}

async function loadMarketTotals(client, runDate) {
  const r = await client.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, site, segment, total
       FROM market_totals WHERE day > $1::date - 56 AND day <= $1::date ORDER BY day`, [runDate]);
  return r.rows;
}

function methodology(runDate, present, missing) {
  const has = (f) => present.includes(f);
  const L = [
    `# Hemnet weekly data pack — ${runDate}`,
    '',
    'Source: Decade Partners Hemnet cohort tracker (scrapes of Hemnet and Booli). All figures are for the four tracked',
    'regions (Stockholm, Västra Götaland, Skåne, Uppsala) unless the file says national.',
    '',
    '## Files',
  ];
  if (has('cross-cohort-hpct.csv')) L.push('- **cross-cohort-hpct.csv** — Hemnet share of views (H%) for each weekly cohort, by region and reading date. Columns: cohort_id, region, date, h_pct.');
  if (has('views-like-for-like.csv')) L.push('- **views-like-for-like.csv** — one row per week: H% on the same homes over the same days (hpct_paid is the headline), views per listing per day, and how many homes and readings went in.');
  if (has('paid-share.csv')) L.push('- **paid-share.csv** — per cohort: Booli\'s new homes, and how many were on Hemnet with a paid ad, a free ad, or not found (pct_paid, pct_free, pct_not_matched).');
  if (has('market-totals.csv')) L.push('- **market-totals.csv** — national listing totals per day, last 8 weeks: Hemnet and Booli, for sale (till_salu) and coming soon (kommande), plus Hemnet for sale excluding new builds.');
  L.push('- **weekly-pack.xlsx** — the same tables as sheets, plus this note.');
  if (missing.length) L.push('', `Not in this week's pack (that step failed; it is flagged in the report): ${missing.join(', ')}.`);
  L.push(
    '',
    '## Definitions',
    '- **Cohort** — homes newly listed for sale on Booli in one ISO week, matched to the same home on Hemnet (same address and postcode, listed within 7 days). Tracked for views every 2 days.',
    '- **H% (Hemnet share of views)** — Hemnet views ÷ (Hemnet + Booli views) on the same homes over the same days. Booli is the yardstick: it shows how much interest the same home draws elsewhere.',
    '- **Paid Hemnet ads only** — from 4 Nov 2026 the views figures use homes whose Hemnet ad is paid (Basic, Plus, Premium, Max, new-build). Free ads (since 20 Oct 2026) are left out so the series compares with history.',
    '- **Like-for-like** — counts only the steps between two readings where both sites were read; steps across outages or Hemnet re-publishes are left out.',
    '- **Sellers paying (paid-share)** — of Booli\'s new homes each week, the share with a paid Hemnet ad. Falling = more sellers using free ads or not listing on Hemnet.',
    '',
    '## Known breaks in the series',
    ...KNOWN_BREAKS.map(b => `- ${b}`),
  );
  return L.join('\n') + '\n';
}

// buildPack({ dir, runDate, client }) -> { files: [{ path, title }], missing: [...] }
async function buildPack({ dir, runDate, client }) {
  fs.mkdirSync(dir, { recursive: true });
  let marketError = null;
  try {
    fs.writeFileSync(path.join(dir, 'market-totals.csv'), marketTotalsCsv(await loadMarketTotals(client, runDate)), 'utf8');
  } catch (e) { marketError = e.message; }
  const present = SOURCES.map(s => s.file).filter(f => fs.existsSync(path.join(dir, f)));
  const missing = SOURCES.map(s => s.file).filter(f => !present.includes(f));
  const note = methodology(runDate, present, missing);
  fs.writeFileSync(path.join(dir, 'methodology.md'), note, 'utf8');

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const m = wb.addWorksheet('Method');
  m.getColumn(1).width = 140;
  for (const line of note.split('\n')) m.addRow([line.replace(/\*\*/g, '')]);
  for (const s of SOURCES) {
    if (!present.includes(s.file)) continue;
    const rows = parseCsv(fs.readFileSync(path.join(dir, s.file), 'utf8'));
    const ws = wb.addWorksheet(s.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
    rows.forEach((r, i) => ws.addRow(i === 0 ? r : r.map(v => (v !== '' && isFinite(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? Number(v) : v))));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach(c => { c.width = 16; });
  }
  await wb.xlsx.writeFile(path.join(dir, 'weekly-pack.xlsx'));

  const files = [
    { path: path.join(dir, 'methodology.md'), title: 'Method note' },
    { path: path.join(dir, 'weekly-pack.xlsx'), title: 'Weekly pack (all tables)' },
    ...present.map(f => ({ path: path.join(dir, f), title: f })),
  ];
  return { files, missing, marketError };
}

module.exports = { buildPack, parseCsv, marketTotalsCsv, methodology, KNOWN_BREAKS, SOURCES };

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const os = require('os');
  let pass = 0, fail = 0;
  const check = async (n, fn) => { try { await fn(); pass++; console.log(`  PASS  ${n}`); } catch (e) { fail++; console.error(`  FAIL  ${n}: ${e.message}`); } };
  (async () => {
    await check('parseCsv handles quotes, doubled quotes, CRLF', async () => {
      assert.deepStrictEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n1,\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['1', '']]);
    });
    await check('marketTotalsCsv: wide by day, unknown segments ignored, gaps blank', async () => {
      const csv = marketTotalsCsv([
        { day: '2026-11-08', site: 'hemnet', segment: 'till_salu', total: 69719 },
        { day: '2026-11-09', site: 'hemnet', segment: 'till_salu', total: 69468 },
        { day: '2026-11-09', site: 'hemnet', segment: 'till_salu_excl_newbuild', total: 60442 },
        { day: '2026-11-09', site: 'hemnet', segment: 'something_else', total: 1 },
      ]);
      const lines = csv.trim().split('\n');
      assert.strictEqual(lines[0], 'day,hemnet_till_salu,hemnet_till_salu_excl_newbuild,hemnet_kommande,booli_till_salu,booli_kommande');
      assert.strictEqual(lines[1], '2026-11-08,69719,,,,');
      assert.strictEqual(lines[2], '2026-11-09,69468,60442,,,');
    });
    await check('buildPack: files present are attached, a missing one is named, workbook written', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
      fs.writeFileSync(path.join(dir, 'views-like-for-like.csv'), 'week_start,hpct_paid,flag\n2026-11-02,60.8,"a, b"\n');
      fs.writeFileSync(path.join(dir, 'cross-cohort-hpct.csv'), 'cohort_id,region,date,h_pct\n2026-W43,Total,2026-11-03,61.2\n');
      const client = { query: async () => ({ rows: [{ day: '2026-11-09', site: 'booli', segment: 'till_salu', total: 58000 }] }) };
      const r = await buildPack({ dir, runDate: '2026-11-09', client });
      const names = r.files.map(f => path.basename(f.path));
      assert.deepStrictEqual(names, ['methodology.md', 'weekly-pack.xlsx', 'cross-cohort-hpct.csv', 'views-like-for-like.csv', 'market-totals.csv']);
      assert.deepStrictEqual(r.missing, ['paid-share.csv']);
      const note = fs.readFileSync(path.join(dir, 'methodology.md'), 'utf8');
      assert.match(note, /Not in this week's pack .*paid-share\.csv/);
      assert.match(note, /2026-11-06: Hemnet's for-sale total/);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(path.join(dir, 'weekly-pack.xlsx'));
      assert.deepStrictEqual(wb.worksheets.map(w => w.name), ['Method', 'H% by cohort', 'Views like-for-like', 'Market totals']);
      const v = wb.getWorksheet('Views like-for-like');
      assert.strictEqual(v.getRow(2).getCell(2).value, 60.8, 'numbers stored as numbers');
      assert.strictEqual(v.getRow(2).getCell(1).value, '2026-11-02', 'dates stay text');
      assert.strictEqual(v.getRow(2).getCell(3).value, 'a, b', 'quoted cell parsed');
    });
    await check('buildPack: a market_totals failure leaves that file out, never throws', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
      const r = await buildPack({ dir, runDate: '2026-11-09', client: { query: async () => { throw new Error('db down'); } } });
      assert.strictEqual(r.marketError, 'db down');
      assert.ok(r.missing.includes('market-totals.csv'));
    });
    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
