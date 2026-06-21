require('dotenv').config();

// sold-match-xlsx.js — per-cohort AUDITABLE Excel export over sold_match ⋈ booli_sold.
//
// One workbook per fortnightly cohort (keyed by window_end): every sampled Booli sold property
// with its details, the match verdict, and clickable links to the Booli sold page and (when
// matched) the Hemnet sold page — so any row can be eyeballed and confirmed by hand. Modeled on
// export-hb-ratio-xlsx.js (ExcelJS, hyperlink cells, view-data/<date>/ output served by
// view-data-server.js on :3800).
//
//   node sold-match-xlsx.js                       # latest cohort (max window_end)
//   node sold-match-xlsx.js --window-end 2026-06-22   # a specific cohort window
//   node sold-match-xlsx.js --all                 # every row, all cohorts
//   node sold-match-xlsx.js --smoke               # offline self-test (no DB, builds a fixture workbook)

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { createClient } = require('./db');

// ---------------------------------------------------------------------------
// Pure link/label helpers.
// ---------------------------------------------------------------------------
function booliUrl(r) {
  // Prefer the parser-captured residence_url (exact sold page); fall back to the booli_id.
  if (r.residence_url) {
    return r.residence_url.startsWith('http') ? r.residence_url : `https://www.booli.se${r.residence_url}`;
  }
  return `https://www.booli.se/bostad/${r.booli_id}`;
}
function hemnetUrl(slug, matchMethod) {
  if (!slug) return null;
  // Sold matches come from Hemnet /salda SaleCards (address_key / fee_exact) → /salda/<slug>.
  // Only the SERP bridge (bostad_bridge) yields an active /bostad listing. /bostad 404s for
  // sold properties (verified live 2026-06-19), so default to /salda.
  const base = matchMethod === 'bostad_bridge' ? 'bostad' : 'salda';
  return `https://www.hemnet.se/${base}/${slug}`;
}
// hemnetSearchUrl — for UNMATCHED rows (pending re-check / uncertain): a precise manual-check
// link that surfaces the property's Hemnet page if it exists. Hemnet's own search only resolves
// areas (not street addresses) and blocks scripted access, so this is a search scoped to
// hemnet.se by address + area — the same site:hemnet.se approach the matcher's bridge uses. The
// exact Hemnet /bostad page ranks first when the property IS on Hemnet. Null without an address.
function hemnetSearchUrl(r) {
  const addr = (r.street_address || '').trim();
  const area = (r.descriptive_area || r.municipality || '').trim();
  if (!addr) return null;
  const q = `site:hemnet.se "${addr}" ${area}`.trim();
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
function wasEnrolled(r) {
  return r.was_enrolled === true || r.was_enrolled === 't' || (r.first_unmatched_at != null);
}
// onHemnet — auditable status label per verdict.
function onHemnet(r) {
  switch (r.verdict) {
    case 'matched': return 'YES';
    case 'genuine_non_hemnet': return 'NO (settled)';
    case 'booli_only': return 'pending re-check';
    case 'uncertain': return 'uncertain';
    default: return r.verdict || '';
  }
}
// foundVia — for matched rows, distinguish first-pass vs late re-check resolution.
function foundVia(r) {
  if (r.verdict !== 'matched') return '';
  return wasEnrolled(r) ? 'later (re-check)' : 'first pull';
}

// ---------------------------------------------------------------------------
// buildAuditRows(rows) — PURE. Map DB rows to the flat audit-row shape + links.
// ---------------------------------------------------------------------------
function buildAuditRows(rows) {
  return (rows || []).map((r) => ({
    booli_id: r.booli_id != null ? String(r.booli_id) : '',
    address: r.street_address || '',
    area: r.descriptive_area || '',
    municipality: r.municipality || '',
    type: r.object_type || r.family || '',
    rooms: r.rooms != null ? Number(r.rooms) : null,
    living_area: r.living_area != null ? Number(r.living_area) : null,
    sold_price: r.sold_price != null ? Number(r.sold_price) : null,
    sold_date: r.sold_date || '',
    on_hemnet: onHemnet(r),
    found_via: foundVia(r),
    verdict: r.verdict || '',
    match_method: r.match_method || '',
    window: r.window_end || '',
    booliUrl: booliUrl(r),
    hemnetUrl: hemnetUrl(r.matched_hemnet_slug, r.match_method),
    // For unmatched (pending re-check / uncertain) rows: a site:hemnet.se address search so
    // the row can be hand-checked. Matched rows have the direct link instead.
    hemnetSearch: r.matched_hemnet_slug ? null : hemnetSearchUrl(r),
  }));
}

const COLUMNS = [
  { header: 'Booli ID', key: 'booli_id', width: 12 },
  { header: 'Address', key: 'address', width: 30 },
  { header: 'Area', key: 'area', width: 18 },
  { header: 'Municipality', key: 'municipality', width: 14 },
  { header: 'Type', key: 'type', width: 12 },
  { header: 'Rooms', key: 'rooms', width: 7 },
  { header: 'Living m²', key: 'living_area', width: 9 },
  { header: 'Sold price (kr)', key: 'sold_price', width: 14 },
  { header: 'Sold date', key: 'sold_date', width: 12 },
  { header: 'On Hemnet', key: 'on_hemnet', width: 16 },
  { header: 'Found via', key: 'found_via', width: 15 },
  { header: 'Verdict', key: 'verdict', width: 16 },
  { header: 'Match method', key: 'match_method', width: 14 },
  { header: 'Cohort (window_end)', key: 'window', width: 18 },
  { header: 'Booli link', key: 'booli_link', width: 12 },
  { header: 'Hemnet link', key: 'hemnet_link', width: 12 },
  { header: 'Check on Hemnet', key: 'hemnet_search', width: 16 },
];

// ---------------------------------------------------------------------------
// buildWorkbook(auditRows, meta) — PURE (no DB/network). Returns an ExcelJS.Workbook.
// ---------------------------------------------------------------------------
function buildWorkbook(auditRows, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'sold-match-xlsx';
  const ws = wb.addWorksheet('Sold-match audit');
  ws.columns = COLUMNS;

  // Header styling + freeze.
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + COLUMNS.length)}1` };

  const LINK_FONT = { color: { argb: 'FF1565C0' }, underline: true };
  for (const r of auditRows) {
    const row = ws.addRow({
      booli_id: r.booli_id, address: r.address, area: r.area, municipality: r.municipality,
      type: r.type, rooms: r.rooms, living_area: r.living_area, sold_price: r.sold_price,
      sold_date: r.sold_date, on_hemnet: r.on_hemnet, found_via: r.found_via, verdict: r.verdict,
      match_method: r.match_method, window: r.window,
    });
    if (r.sold_price != null) row.getCell('sold_price').numFmt = '# ##0';
    const bCell = row.getCell('booli_link');
    bCell.value = { text: 'Booli ↗', hyperlink: r.booliUrl };
    bCell.font = LINK_FONT;
    if (r.hemnetUrl) {
      const hCell = row.getCell('hemnet_link');
      hCell.value = { text: 'Hemnet ↗', hyperlink: r.hemnetUrl };
      hCell.font = LINK_FONT;
    }
    if (r.hemnetSearch) {
      const sCell = row.getCell('hemnet_search');
      sCell.value = { text: 'Search Hemnet ↗', hyperlink: r.hemnetSearch };
      sCell.font = LINK_FONT;
    }
  }
  return wb;
}

// outPaths — the workbook path + a stable "latest" copy, under view-data/<runDate>/sold-match/.
function outPaths(runDate, cohortLabel) {
  const dir = path.join(__dirname, 'view-data', runDate, 'sold-match');
  return {
    dir,
    file: path.join(dir, `sold-audit-${cohortLabel}.xlsx`),
  };
}

// ---------------------------------------------------------------------------
// fetchRows(client, opts) — sold_match ⋈ booli_sold, optionally scoped to one cohort window.
// Static columns, parameterized window (T: no interpolation).
// ---------------------------------------------------------------------------
async function fetchRows(client, opts = {}) {
  const cols = `sm.booli_id, sm.verdict, sm.match_method, sm.matched_hemnet_slug,
                (sm.first_unmatched_at IS NOT NULL) AS was_enrolled,
                to_char(sm.window_end, 'YYYY-MM-DD') AS window_end,
                bs.residence_url, bs.street_address, bs.descriptive_area, bs.municipality,
                bs.object_type, bs.family, bs.rooms, bs.living_area, bs.sold_price,
                to_char(bs.sold_date, 'YYYY-MM-DD') AS sold_date`;
  const order = `ORDER BY bs.municipality NULLS LAST, bs.descriptive_area NULLS LAST, sm.booli_id`;
  if (opts.all) {
    const r = await client.query(`SELECT ${cols} FROM sold_match sm LEFT JOIN booli_sold bs ON bs.booli_id = sm.booli_id ${order}`);
    return r.rows;
  }
  const r = await client.query(
    `SELECT ${cols} FROM sold_match sm LEFT JOIN booli_sold bs ON bs.booli_id = sm.booli_id
      WHERE sm.window_end = $1::date ${order}`,
    [opts.windowEnd],
  );
  return r.rows;
}

async function run() {
  const all = process.argv.includes('--all');
  let windowEnd = null;
  const wIdx = process.argv.indexOf('--window-end');
  if (wIdx >= 0 && process.argv[wIdx + 1]) windowEnd = process.argv[wIdx + 1];

  const client = createClient();
  await client.connect();
  let rows;
  let cohortLabel;
  try {
    if (!all && !windowEnd) {
      const m = await client.query(`SELECT to_char(MAX(window_end), 'YYYY-MM-DD') AS w FROM sold_match WHERE window_end IS NOT NULL`);
      windowEnd = m.rows[0] && m.rows[0].w;
      if (!windowEnd) { console.log('No sold_match rows with a window_end — nothing to export.'); return; }
    }
    rows = await fetchRows(client, { all, windowEnd });
    cohortLabel = all ? 'all' : windowEnd;
  } finally {
    await client.end();
  }

  const auditRows = buildAuditRows(rows);
  const runDate = new Date().toISOString().slice(0, 10);
  const { dir, file } = outPaths(runDate, cohortLabel);
  fs.mkdirSync(dir, { recursive: true });
  const wb = buildWorkbook(auditRows, { cohortLabel });
  await wb.xlsx.writeFile(file);

  const matched = auditRows.filter((r) => r.verdict === 'matched').length;
  console.log(`Wrote ${auditRows.length} rows (${matched} on Hemnet) → ${file}`);
}

module.exports = { booliUrl, hemnetUrl, hemnetSearchUrl, onHemnet, foundVia, buildAuditRows, buildWorkbook, COLUMNS };

// ---------------------------------------------------------------------------
// Entry gate: --smoke runs the offline self-test; otherwise run().
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  runSmoke();
} else if (require.main === module) {
  run().catch((err) => { console.error('Error:', err.message); process.exit(1); });
}

// ---------------------------------------------------------------------------
// --smoke — fully offline (no DB, no network). Builds a fixture workbook to a temp path.
// ---------------------------------------------------------------------------
function runSmoke() {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  function fixtureRows() {
    return [
      { booli_id: 4240148, verdict: 'matched', match_method: 'address_key', matched_hemnet_slug: 'villa-6rum-taby-9d-4872888',
        was_enrolled: false, window_end: '2026-06-22', residence_url: '/bostad/4240148', street_address: 'Albert Målares väg 9D',
        descriptive_area: 'Täby kyrkby', municipality: 'Täby', object_type: 'Radhus', family: 'HOUSE', rooms: 4, living_area: 110, sold_price: 7250000, sold_date: '2026-06-12' },
      { booli_id: 5626686, verdict: 'matched', match_method: 'fee_exact', matched_hemnet_slug: 'lagenhet-2rum-ostermalm-21706244',
        was_enrolled: true, window_end: '2026-06-22', residence_url: null, street_address: 'Brahegatan 37',
        descriptive_area: 'Östermalm', municipality: 'Stockholm', object_type: 'Lägenhet', family: 'APARTMENT', rooms: 2, living_area: 58, sold_price: 6100000, sold_date: '2026-06-10' },
      { booli_id: 999001, verdict: 'booli_only', match_method: null, matched_hemnet_slug: null,
        was_enrolled: true, window_end: '2026-06-22', residence_url: '/bostad/999001', street_address: 'Testgatan 1',
        descriptive_area: 'Kungsholmen', municipality: 'Stockholm', object_type: 'Lägenhet', family: 'APARTMENT', rooms: 3, living_area: 72, sold_price: 8200000, sold_date: '2026-06-11' },
    ];
  }

  (async () => {
    // 1. link builders.
    check('booliUrl prefers residence_url, falls back to booli_id', () => {
      assert.strictEqual(booliUrl({ residence_url: '/bostad/4240148', booli_id: 4240148 }), 'https://www.booli.se/bostad/4240148');
      assert.strictEqual(booliUrl({ residence_url: null, booli_id: 555 }), 'https://www.booli.se/bostad/555');
    });
    check('hemnetUrl: /salda for SaleCard matches, /bostad only for bridge, null unmatched', () => {
      assert.strictEqual(hemnetUrl('x-123', 'address_key'), 'https://www.hemnet.se/salda/x-123');
      assert.strictEqual(hemnetUrl('x-123', 'fee_exact'), 'https://www.hemnet.se/salda/x-123');
      assert.strictEqual(hemnetUrl('x-123', 'bostad_bridge'), 'https://www.hemnet.se/bostad/x-123');
      assert.strictEqual(hemnetUrl(null, 'address_key'), null);
    });
    check('hemnetSearchUrl: site:hemnet.se address search, null without address', () => {
      const u = hemnetSearchUrl({ street_address: 'Storgatan 1', descriptive_area: 'Östermalm', municipality: 'Stockholm' });
      assert.ok(u.startsWith('https://www.google.com/search?q='), 'is a search URL');
      assert.ok(/hemnet\.se/.test(decodeURIComponent(u)) && /Storgatan/.test(decodeURIComponent(u)), 'scoped to hemnet.se + has address');
      assert.strictEqual(hemnetSearchUrl({ street_address: '', municipality: 'X' }), null, 'null without address');
    });

    // 2. status labels.
    check('onHemnet/foundVia labels per verdict', () => {
      assert.strictEqual(onHemnet({ verdict: 'matched' }), 'YES');
      assert.strictEqual(onHemnet({ verdict: 'genuine_non_hemnet' }), 'NO (settled)');
      assert.strictEqual(onHemnet({ verdict: 'booli_only' }), 'pending re-check');
      assert.strictEqual(foundVia({ verdict: 'matched', was_enrolled: false }), 'first pull');
      assert.strictEqual(foundVia({ verdict: 'matched', was_enrolled: true }), 'later (re-check)');
      assert.strictEqual(foundVia({ verdict: 'booli_only' }), '');
    });

    // 3. buildAuditRows maps fields + links.
    check('buildAuditRows maps fields, /salda links, and a search link for pending rows', () => {
      const a = buildAuditRows(fixtureRows());
      assert.strictEqual(a.length, 3);
      assert.strictEqual(a[0].booliUrl, 'https://www.booli.se/bostad/4240148');
      assert.strictEqual(a[0].hemnetUrl, 'https://www.hemnet.se/salda/villa-6rum-taby-9d-4872888', 'address_key → /salda');
      assert.strictEqual(a[0].hemnetSearch, null, 'matched row has no search link');
      assert.strictEqual(a[2].hemnetUrl, null, 'booli_only has no direct Hemnet link');
      assert.ok(a[2].hemnetSearch && /hemnet\.se/.test(decodeURIComponent(a[2].hemnetSearch)), 'booli_only has a Check-on-Hemnet search link');
      assert.strictEqual(a[0].on_hemnet, 'YES');
      assert.strictEqual(a[1].found_via, 'later (re-check)');
    });

    // 4. buildWorkbook produces a sheet with header + a row per audit row + hyperlink cells.
    await checkAsync('buildWorkbook builds sheet with headers, rows, hyperlink cells', async () => {
      const wb = buildWorkbook(buildAuditRows(fixtureRows()));
      const ws = wb.getWorksheet('Sold-match audit');
      assert.ok(ws, 'worksheet present');
      assert.strictEqual(ws.getRow(1).getCell(1).value, 'Booli ID', 'header row');
      assert.strictEqual(ws.actualRowCount, 4, '1 header + 3 data rows');
      // Booli link cell is a hyperlink object.
      const bCell = ws.getRow(2).getCell(COLUMNS.findIndex((c) => c.key === 'booli_link') + 1);
      assert.ok(bCell.value && bCell.value.hyperlink && /booli\.se/.test(bCell.value.hyperlink), 'booli hyperlink set');
      // Row 4 (booli_only) has no direct Hemnet hyperlink, but DOES have a Check-on-Hemnet search.
      const hCellEmpty = ws.getRow(4).getCell(COLUMNS.findIndex((c) => c.key === 'hemnet_link') + 1);
      assert.ok(!hCellEmpty.value || !hCellEmpty.value.hyperlink, 'unmatched row has no direct Hemnet link');
      const sCell = ws.getRow(4).getCell(COLUMNS.findIndex((c) => c.key === 'hemnet_search') + 1);
      assert.ok(sCell.value && sCell.value.hyperlink && /hemnet\.se/.test(decodeURIComponent(sCell.value.hyperlink)), 'unmatched row has a search link');
    });

    // 5. workbook writes to disk and is a non-empty .xlsx.
    await checkAsync('workbook writes a non-empty .xlsx file', async () => {
      const wb = buildWorkbook(buildAuditRows(fixtureRows()));
      const dir = path.join(__dirname, 'view-data', '2026-06-18-smoke', 'sold-match');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'sold-audit-smoke.xlsx');
      await wb.xlsx.writeFile(f);
      assert.ok(fs.existsSync(f) && fs.statSync(f).size > 0, 'xlsx written non-empty');
      console.log(`smoke wrote: ${f}`);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
