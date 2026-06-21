require('dotenv').config();

// scripts/export-sold-match.js — reusable, READ-ONLY export of sold_match verdicts to
// xlsx + csv, with CLICKABLE full-URL links (Booli / Hemnet / Check-on-Hemnet search).
//
// Unlike the cron reporting trio (sold-match-report/-xlsx/-trend-chart), which filter
// `WHERE window_end >= <lookback>` and therefore silently drop rows written with a NULL
// window_end, this tool selects by created_at date(s) — so it surfaces EVERY run including
// historical ones whose window_end was not populated. It writes NO DB rows (one SELECT).
//
// Link columns reuse the canonical builders in sold-match-xlsx.js (single source of truth):
//   booli_link       — full https://www.booli.se/... (every row; /bostad/<booli_id> fallback)
//   hemnet_link      — full https://www.hemnet.se/salda|bostad/<slug> (matched rows)
//   check_on_hemnet  — site:hemnet.se "<addr>" <area> Google search (unmatched rows)
//
// Sheets: Records (all rows + links), Uncertain (the unmatched rows for manual check),
//         Summary (region x type with on-Hemnet / non-Hemnet rates).
//
//   node scripts/export-sold-match.js --date 2026-06-20
//   node scripts/export-sold-match.js --since 2026-06-01 --until 2026-06-30 [--out <dir>]
//   node scripts/export-sold-match.js --smoke      # offline self-test (no DB, no network)

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('../db');
const { booliUrl, hemnetUrl, hemnetSearchUrl } = require('../sold-match-xlsx');

const panel = require('../config/sold-panel.json');
const MUNI_REGION = {};
for (const m of (panel.munis || [])) MUNI_REGION[m.name] = m.region || 'Unknown';

// ---------------------------------------------------------------------------
// validateDate / parseArgs — accept only real YYYY-MM-DD (ASVS V5; same check as the runner).
// ---------------------------------------------------------------------------
function validateDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
}

function parseArgs(argv) {
  const o = { date: null, since: null, until: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') o.date = argv[++i];
    else if (a.startsWith('--date=')) o.date = a.split('=')[1];
    else if (a === '--since') o.since = argv[++i];
    else if (a.startsWith('--since=')) o.since = a.split('=')[1];
    else if (a === '--until') o.until = argv[++i];
    else if (a.startsWith('--until=')) o.until = a.split('=')[1];
    else if (a === '--out') o.out = argv[++i];
    else if (a.startsWith('--out=')) o.out = a.split('=')[1];
  }
  for (const [k, v] of [['--date', o.date], ['--since', o.since], ['--until', o.until]]) {
    if (v != null && !validateDate(v)) throw new Error(`invalid ${k}: ${v} (expected YYYY-MM-DD)`);
  }
  return o;
}

// ---------------------------------------------------------------------------
// csvCell — RFC-4180 escaping (quote when the value contains a comma, quote, or newline).
// ---------------------------------------------------------------------------
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// buildRows — map DB rows to the flat export shape + clickable links. PURE given rows.
// ---------------------------------------------------------------------------
function buildRows(dbRows) {
  return dbRows.map((r) => {
    const muniTok = (r.segment || '').split(':')[0];
    const famTok = (r.segment || '').split(':')[1];
    const ev = r.evidence && typeof r.evidence === 'object' ? r.evidence : {};
    const mc = ev.matched_card || {};
    const matched = r.verdict === 'matched';
    return {
      booli_id: r.booli_id != null ? String(r.booli_id) : '',
      region: MUNI_REGION[muniTok] || 'Unknown',
      municipality: r.municipality || muniTok || '',
      type: r.family || famTok || '',
      verdict: r.verdict || '',
      on_hemnet: matched ? 1 : 0,
      match_method: r.match_method || '',
      booli_address: r.street_address || '',
      descriptive_area: r.descriptive_area || '',
      sold_date: r.sold_date ? (r.sold_date instanceof Date ? r.sold_date.toISOString().slice(0, 10) : String(r.sold_date)) : '',
      sold_price: r.sold_price != null ? Number(r.sold_price) : null,
      living_area: r.living_area != null ? Number(r.living_area) : null,
      rooms: r.rooms != null ? Number(r.rooms) : null,
      hemnet_address: mc.street_address || '',
      hemnet_final_price: mc.final_price != null ? Number(mc.final_price) : null,
      source: ev.source || '',
      booli_link: booliUrl(r),                                      // always
      hemnet_link: matched ? hemnetUrl(r.matched_hemnet_slug, r.match_method) : null, // matched only
      check_on_hemnet: matched ? null : hemnetSearchUrl(r),         // unmatched only
    };
  });
}

// ---------------------------------------------------------------------------
// summarize — region x type buckets with on-Hemnet / non-Hemnet rates. PURE.
// ---------------------------------------------------------------------------
function summarize(rows) {
  const sum = {};
  for (const r of rows) {
    const k = `${r.region}|${r.type || '?'}`;
    sum[k] = sum[k] || { region: r.region, type: r.type || '?', matched: 0, booli_only: 0, uncertain: 0 };
    if (sum[k][r.verdict] != null) sum[k][r.verdict]++;
  }
  return Object.values(sum).map((s) => {
    const tot = s.matched + s.booli_only + s.uncertain;
    const dec = s.matched + s.booli_only;
    return { ...s, total: tot, on_hemnet_pct: tot ? +(s.matched / tot * 100).toFixed(1) : 0, non_hemnet_pct: dec ? +(s.booli_only / dec * 100).toFixed(1) : 0 };
  }).sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// link helper — set a cell to a clickable ExcelJS hyperlink when a url is present.
// ---------------------------------------------------------------------------
function setLink(xrow, key, url, text) {
  if (url) xrow.getCell(key).value = { text, hyperlink: url };
}

async function buildWorkbook(rows) {
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('Records');
  ws.columns = Object.keys(rows[0]).map((k) => ({ header: k, key: k, width: Math.min(30, Math.max(11, k.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => {
    const xr = ws.addRow(r);
    setLink(xr, 'booli_link', r.booli_link, 'Booli');
    setLink(xr, 'hemnet_link', r.hemnet_link, 'Hemnet');
    setLink(xr, 'check_on_hemnet', r.check_on_hemnet, 'Search Hemnet');
  });

  const wsu = wb.addWorksheet('Uncertain');
  wsu.columns = [
    { header: 'booli_id', key: 'booli_id', width: 12 }, { header: 'region', key: 'region', width: 16 },
    { header: 'municipality', key: 'municipality', width: 16 }, { header: 'type', key: 'type', width: 11 },
    { header: 'booli_address', key: 'booli_address', width: 26 }, { header: 'area', key: 'descriptive_area', width: 18 },
    { header: 'sold_price', key: 'sold_price', width: 11 }, { header: 'living_area', key: 'living_area', width: 10 },
    { header: 'rooms', key: 'rooms', width: 7 }, { header: 'booli_link', key: 'booli_link', width: 12 },
    { header: 'check_on_hemnet', key: 'check_on_hemnet', width: 16 },
  ];
  wsu.getRow(1).font = { bold: true };
  rows.filter((r) => r.verdict === 'uncertain').forEach((r) => {
    const xr = wsu.addRow(r);
    setLink(xr, 'booli_link', r.booli_link, 'Booli');
    setLink(xr, 'check_on_hemnet', r.check_on_hemnet, 'Search Hemnet');
  });

  const ws2 = wb.addWorksheet('Summary');
  ws2.columns = [
    { header: 'region', key: 'region', width: 18 }, { header: 'type', key: 'type', width: 12 },
    { header: 'total', key: 'total', width: 8 }, { header: 'matched', key: 'matched', width: 9 },
    { header: 'booli_only', key: 'booli_only', width: 11 }, { header: 'uncertain', key: 'uncertain', width: 10 },
    { header: 'on_hemnet_%', key: 'on_hemnet_pct', width: 12 }, { header: 'non_hemnet_%', key: 'non_hemnet_pct', width: 13 },
  ];
  ws2.getRow(1).font = { bold: true };
  summarize(rows).forEach((s) => ws2.addRow(s));
  const tot = rows.length;
  const m = rows.filter((r) => r.verdict === 'matched').length;
  const bo = rows.filter((r) => r.verdict === 'booli_only').length;
  const un = rows.filter((r) => r.verdict === 'uncertain').length;
  ws2.addRow({});
  ws2.addRow({ region: 'TOTAL', type: 'all', total: tot, matched: m, booli_only: bo, uncertain: un, on_hemnet_pct: tot ? +(m / tot * 100).toFixed(1) : 0, non_hemnet_pct: (m + bo) ? +(bo / (m + bo) * 100).toFixed(1) : 0 });

  return wb;
}

function toCsv(rows) {
  const cols = Object.keys(rows[0]);
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\n');
}

// ---------------------------------------------------------------------------
// main — one read-only SELECT; write xlsx + csv. No DB writes.
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let where; let params; let label;
  if (args.since || args.until) {
    const since = args.since || '2000-01-01';
    const until = args.until || new Date().toISOString().slice(0, 10);
    where = 'sm.created_at::date >= $1::date AND sm.created_at::date <= $2::date';
    params = [since, until];
    label = `${since}_${until}`;
  } else {
    const date = args.date || new Date().toISOString().slice(0, 10);
    if (!validateDate(date)) throw new Error(`invalid --date: ${date}`);
    where = 'sm.created_at::date = $1::date';
    params = [date];
    label = date;
  }

  const outDir = args.out || path.join('view-data', label, 'sold-match');
  const client = createClient();
  await client.connect();
  let rows;
  try {
    const res = await client.query(
      `SELECT sm.booli_id, sm.segment, sm.verdict, sm.match_method, sm.matched_hemnet_slug, sm.evidence,
              bs.street_address, bs.municipality, bs.object_type, bs.family, bs.sold_price, bs.sold_date,
              bs.living_area, bs.rooms, bs.descriptive_area, bs.residence_url
         FROM sold_match sm
         LEFT JOIN booli_sold bs ON bs.booli_id = sm.booli_id
        WHERE ${where}
        ORDER BY sm.segment, sm.verdict, sm.booli_id`,
      params,
    );
    rows = buildRows(res.rows);
  } finally {
    await client.end();
  }

  if (rows.length === 0) {
    console.log(`no sold_match rows for ${label} — nothing written`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `sold-match-national-${label}`);
  const wb = await buildWorkbook(rows);
  await wb.xlsx.writeFile(`${base}.xlsx`);
  fs.writeFileSync(`${base}.csv`, toCsv(rows));

  const m = rows.filter((r) => r.verdict === 'matched').length;
  const bo = rows.filter((r) => r.verdict === 'booli_only').length;
  const un = rows.filter((r) => r.verdict === 'uncertain').length;
  const withBooliAddr = rows.filter((r) => r.booli_address).length;
  console.log(`wrote ${rows.length} records (matched=${m} booli_only=${bo} uncertain=${un}; booli_address ${withBooliAddr}/${rows.length})`);
  console.log(`  ${base}.xlsx`);
  console.log(`  ${base}.csv`);
}

module.exports = { validateDate, parseArgs, csvCell, buildRows, summarize, toCsv };

if (require.main === module) {
  if (process.argv.includes('--smoke')) runSmoke();
  else main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}

// ---------------------------------------------------------------------------
// --smoke — fully offline (no DB, no network). Exercises arg parsing, the pure row/link
// mapping (via the reused sold-match-xlsx builders), summary math, and CSV escaping.
// ---------------------------------------------------------------------------
function runSmoke() {
  const assert = require('assert');
  let pass = 0; let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('validateDate accepts real, rejects malformed', () => {
    assert.strictEqual(validateDate('2026-06-20'), true);
    assert.strictEqual(validateDate('2026-13-99'), false);
    assert.strictEqual(validateDate('notadate'), false);
  });

  check('parseArgs reads --date/--since/--until/--out and throws on bad date', () => {
    const a = parseArgs(['--date', '2026-06-20', '--out', 'x']);
    assert.strictEqual(a.date, '2026-06-20'); assert.strictEqual(a.out, 'x');
    assert.throws(() => parseArgs(['--since', '2026-13-01']), /invalid --since/);
  });

  check('csvCell quotes commas/quotes/newlines', () => {
    assert.strictEqual(csvCell('plain'), 'plain');
    assert.strictEqual(csvCell('a,b'), '"a,b"');
    assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
    assert.strictEqual(csvCell(null), '');
  });

  check('buildRows: matched house -> clickable booli+hemnet links, no search link', () => {
    const [r] = buildRows([{
      booli_id: 11, segment: 'Stockholm:HOUSE', verdict: 'matched', match_method: 'address_key',
      matched_hemnet_slug: 'villa-x-123', evidence: { matched_card: { street_address: 'Testv 1', final_price: 5000000 } },
      street_address: 'Testv 1', municipality: 'Stockholm', family: 'HOUSE', residence_url: '/bostad/999',
    }]);
    assert.strictEqual(r.on_hemnet, 1);
    assert.strictEqual(r.region, 'Stockholm');
    assert.strictEqual(r.booli_link, 'https://www.booli.se/bostad/999');
    assert.strictEqual(r.hemnet_link, 'https://www.hemnet.se/salda/villa-x-123');
    assert.strictEqual(r.check_on_hemnet, null);
  });

  check('buildRows: uncertain apt -> booli fallback link + site:hemnet.se search, no hemnet_link', () => {
    const [r] = buildRows([{
      booli_id: 22, segment: 'Göteborg:APARTMENT', verdict: 'uncertain', match_method: null,
      matched_hemnet_slug: null, evidence: {}, street_address: 'Storgatan 5', descriptive_area: 'Centrum',
      municipality: 'Göteborg', family: 'APARTMENT', residence_url: null,
    }]);
    assert.strictEqual(r.on_hemnet, 0);
    assert.strictEqual(r.booli_link, 'https://www.booli.se/bostad/22'); // fallback when no residence_url
    assert.strictEqual(r.hemnet_link, null);
    assert.ok(r.check_on_hemnet.startsWith('https://www.google.com/search?q='), 'has a search URL');
    assert.ok(/hemnet\.se/.test(decodeURIComponent(r.check_on_hemnet)) && /Storgatan/.test(decodeURIComponent(r.check_on_hemnet)));
  });

  check('summarize: region x type buckets with rates', () => {
    const s = summarize([
      { region: 'Stockholm', type: 'HOUSE', verdict: 'matched' },
      { region: 'Stockholm', type: 'HOUSE', verdict: 'booli_only' },
      { region: 'Stockholm', type: 'HOUSE', verdict: 'uncertain' },
    ]);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].total, 3);
    assert.strictEqual(s[0].on_hemnet_pct, 33.3);
    assert.strictEqual(s[0].non_hemnet_pct, 50); // 1 booli_only of 2 decided
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
