'use strict';
// adcost-report.js — monthly Slack post for Hemnet's ad pricing (Phase 28).
//
// The scrape runs on the OTHER droplet (price droplet, 02:00 UTC on the 1st, via
// celery-beat) and writes hemnet_adcostv2 in the shared defaultdb. This script does
// the reporting half: it shells out to scripts/adcost-report.py for the numbers and
// the artifacts, renders the post, and publishes it to #hemnet-status.
//
// Reporting rules (locked with the client 2026-08-17 — do not re-litigate):
//  - NO ARPL. The revenue-per-listing weights in data/arpl-baseline.json are a frozen
//    one-off hand-extracted from a gitignored 16MB workbook and never refreshed (the
//    local and droplet copies had already drifted apart). A published monthly number
//    must not rest on that, so the post reports SCRAPED PRICES only. The linked heat
//    map still carries its ARPL block; the Slack post does not.
//  - TWO tables, in the shape of the v6 workbook's county x package matrix: counties
//    down, BASIC/PLUS/PREMIUM/MAX across, a Total column and a TOTAL row.
//      table 1 — vs the fixed December-2025 baseline (2025-12-21, pinned in the Python)
//      table 2 — vs roughly a quarter back
//    This supersedes the earlier "single anchor only" rule, which was locked on the
//    assumption that few cells would move against a fixed baseline. They did not: all
//    420 of 420 already differ from 2025-12-21, and because that anchor never advances
//    the moved set can only grow. A fixed baseline is a cumulative index; it can never
//    answer "what changed lately". Hence the second table.
//  - The quarter table NEVER implies its own length. The 2026-03-16 -> 2026-06-30
//    outage means the 90-day mark can land in a hole, so the heading prints the actual
//    reference date and the actual elapsed days, and only says "quarter" when it is
//    within QUARTER_TOLERANCE_DAYS of one. It self-corrects as monthly data accrues.
//  - Every cell is an EQUAL-WEIGHTED basket (that county's munis x all six price
//    points). Unweighted on purpose — the v6 listing-mix weights were dropped. It is a
//    price index, not a revenue estimate: counties are not scaled by market size.
//  - One basis only. An earlier draft showed a per-product roll-up of median-of-percent
//    changes beside the matrices, which printed BASIC +3.4% under a table saying BASIC
//    +1.8%. Both were right; two numbers under one label is a defect. The add-on block
//    therefore uses the same basket basis as the matrices.
//  - Artifacts are LINKED, never uploaded (that would need files:write). They are
//    written to view-data/<date>/adcost/ and served by view-data-server.js on :3800.
//
// Below the tables: the add-ons (PAID_REPUBLISH / TOPLISTING / TOPLISTING_5_DAYS) are
// not packages and are not in the workbook table, but they do move — TOPLISTING is up
// ~18% on the anchor — so they get one national row per window rather than being
// dropped. Then, when few enough cells moved (<= LIST_MAX), each is named individually;
// otherwise just the single largest mover. "Nothing moved" stays a real result: prices
// are sticky, and between 2026-07-12 and 2026-08-17 only MAX moved at all.
//
// Cron: 07:10 UTC on the 1st, five hours after the 02:00 UTC scrape on the price droplet.
// Self-test: node adcost-report.js --smoke   (offline: no DB, no Python, no Slack)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { postMessage } = require('./lib/slack-post');
const { runReporter } = require('./cron-wrapper');

const PY_SCRIPT = path.join(__dirname, 'scripts', 'adcost-report.py');
const HEATMAP_FILE = 'adcost-heatmap.html';
const XLSX_FILE = 'adcost-all-data.xlsx';

// Above this many moved cells the post switches from a per-cell list to a per-product
// roll-up. 12 lines is about as much as reads comfortably in a Slack code block.
const LIST_MAX = 12;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------
// formatting helpers (pure)
// ---------------------------------------------------------------
function rpad(s, w) { return (String(s) + ' '.repeat(w)).slice(0, w); }
function lpad(s, w) { return (' '.repeat(w) + String(s)).slice(-w); }
function fmtN(n) { return Math.round(Number(n)).toLocaleString('en-US'); }
// U+2212 minus, matching age-census-report.js — a hyphen reads as a bullet in Slack.
function pctSigned(x) { return `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}%`; }
// 5000000 -> "5.0M"; keeps the price-point column narrow and unambiguous.
function fmtPricePoint(p) { return `${(Number(p) / 1e6).toFixed(1)}M`; }

function monthLabel(isoDate) {
  const [y, m] = isoDate.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------
// renderers (pure — no DB, no network, no fs)
// ---------------------------------------------------------------

// "420/420 cells (10 munis × 6 price points × 7 products), scraped 2026-08-17".
// A partial run must LOOK partial on the first line the reader sees, because every
// number below it is then computed over fewer cells than the header implies.
function renderCoverage(report) {
  const g = report.grid;
  const l = report.latest;
  const shape = `${g.municipalities} munis × ${g.price_points} price points × ${g.products} products`;
  let line = `Coverage   ${fmtN(l.cells)}/${fmtN(g.expected_cells)} cells (${shape}), scraped ${l.date}`;
  if (!l.complete) {
    line += `\n           ⚠ PARTIAL — ${l.munis} of ${g.municipalities} municipalities returned data; `
      + `only the ${fmtN(l.cells)} cells actually scraped are compared`;
  }
  return line;
}

function renderMovedCell(c) {
  return '  ' + rpad(c.municipality, 13) + rpad(c.product, 18)
    + rpad('@' + fmtPricePoint(c.price_point), 7)
    + lpad(fmtN(c.from), 8) + ' → ' + lpad(fmtN(c.to), 8)
    + lpad(pctSigned(c.pct), 9);
}

// ---- the two county × package matrices (the shape of the v6 workbook table) ----
const CORE = ['BASIC', 'PLUS', 'PREMIUM', 'MAX'];
const COUNTY_W = 18;
const MCOL_W = 9;

function mcell(p) { return lpad(p == null ? '—' : pctSigned(p), MCOL_W); }

// One matrix: a row per county, a column per package, and a TOTAL row.
// There is deliberately NO Total column. Averaging BASIC..MAX across a county
// would imply a package mix we do not observe: we scrape the RATE CARD, not what
// sellers actually buy, so an equal-weighted cross-package total is a number with
// no referent. The TOTAL row stays — it averages ONE package across municipalities,
// which is a like-for-like basket. (Removed 2026-08-18 at Julian's request.)
// Every cell is the % change in an equal-weighted basket of that county's
// municipalities × all six price points — deliberately unweighted, because the v6
// listing-mix weights were dropped as a frozen one-off.
function renderMatrix(matrix, heading) {
  const L = [heading];
  L.push(rpad('', COUNTY_W) + CORE.map(t => lpad(t, MCOL_W)).join(''));
  for (const r of matrix.rows) {
    L.push(rpad(r.county, COUNTY_W) + CORE.map(t => mcell(r.tiers[t])).join(''));
  }
  L.push(rpad('TOTAL', COUNTY_W) + CORE.map(t => mcell(matrix.total_row[t])).join(''));
  return L;
}

// The heading above each matrix always states the reference date AND how long ago it
// was. The second table is nominally "past quarter", but the 2026-03-16 → 2026-06-30
// outage means the nearest complete snapshot to the 90-day mark can be far off it —
// so the elapsed time is never implied by the word "quarter", it is printed.
function quarterHeading(q) {
  if (!q || !q.ref) return 'Past quarter — unavailable (no earlier complete snapshot)';
  const months = (q.days_back / 30.44).toFixed(1);
  return q.on_target
    ? `Past quarter — vs ${q.ref} (${q.days_back} days)`
    : `Past ${months} months — vs ${q.ref} (${q.days_back} days; the 90-day mark falls inside the scrape outage)`;
}

// The three add-ons, national, one row per reference window. Same basket basis as the
// matrices above so no product ever carries two different numbers in one post.
const ADDONS = ['PAID_REPUBLISH', 'TOPLISTING', 'TOPLISTING_5_DAYS'];
const ADDON_W = 19;

function renderAddons(m) {
  const windows = [m.anchor, m.quarter && m.quarter.ref ? m.quarter : null].filter(Boolean);
  const present = windows.filter(w => w.addons);
  if (!present.length) return [];
  const L = [rpad('Add-ons (national)', COUNTY_W) + ADDONS.map(a => lpad(a, ADDON_W)).join('')];
  for (const w of present) {
    L.push(rpad(`  vs ${w.ref}`, COUNTY_W) + ADDONS.map(a => lpad(
      w.addons[a] == null ? '—' : pctSigned(w.addons[a]), ADDON_W)).join(''));
  }
  return L;
}

// renderReport(report, links) -> the exact Slack message body.
// `report` is scripts/adcost-report.py --json verbatim. Pure and total: every branch
// below is reachable from a real month (first month, nothing moved, a handful moved,
// everything moved, a partial scrape, a stale scrape).
function renderReport(report, links = {}) {
  const L = [];
  L.push(`:moneybag: *Hemnet ad pricing — ${monthLabel(report.latest.date)}*`);
  L.push(renderCoverage(report));

  const moved = report.moved_cells || [];
  const anchor = report.anchor.date;
  L.push(`Changes vs ${anchor}: ${fmtN(report.moved_count)} of ${fmtN(report.compared_cells)} observations moved`);

  // The two headline tables, in the shape of the v6 workbook: county rows, package
  // columns, % change. Table 1 is the fixed December-2025 baseline (cumulative);
  // table 2 is the recent window (what has moved lately). The anchor alone cannot
  // answer "what changed" — against a FIXED baseline the moved set only grows, and
  // all 420 observations already differ from it.
  const m = report.matrices;
  if (m) {
    L.push('```');
    for (const line of renderMatrix(m.anchor, `vs December 2025 baseline — ${m.anchor.ref} (${m.anchor.days_back} days)`)) L.push(line);
    if (m.quarter && m.quarter.ref) {
      L.push('');
      for (const line of renderMatrix(m.quarter, quarterHeading(m.quarter))) L.push(line);
    } else {
      L.push('', quarterHeading(m.quarter));
    }
    L.push('```');
  }

  // Detail beneath the tables. The matrices cover the four packages only — the same
  // four the workbook table shows — so the add-ons get their own compact block, on the
  // SAME basket basis, rather than a median-of-percentages roll-up that would print a
  // second, different number under the same product name.
  const detail = [];
  if (m) detail.push(...renderAddons(m));

  if (report.moved_count === 0) {
    // Not an empty report. Hemnet's prices are sticky, and a month in which nothing
    // moved is a finding — it is why the anchor comparison is worth publishing at all.
    if (detail.length) detail.push('');
    detail.push(`No price changed. All ${fmtN(report.compared_cells)} observations are identical to ${anchor}.`);
  } else if (moved.length <= LIST_MAX) {
    // Few enough to name. In a month where the tables read ~0.0% everywhere, this is
    // what tells the reader exactly which cells moved.
    if (detail.length) detail.push('');
    for (const c of moved) detail.push(renderMovedCell(c));
  }

  if (detail.length) { L.push('```'); for (const d of detail) L.push(d); L.push('```'); }

  // Every warning the Python raised, verbatim. A stale or partial scrape must never
  // be inferable only from a number the reader has to compare against last month.
  for (const w of report.warnings || []) L.push(`⚠ ${w}`);

  const artifacts = [];
  if (links.heatmapUrl) artifacts.push(`<${links.heatmapUrl}|Heat map>`);
  if (links.xlsxUrl) artifacts.push(`<${links.xlsxUrl}|All data (xlsx)>`);
  if (artifacts.length) L.push(artifacts.join('   ·   '));
  else L.push('(artifacts not linked — VIEW_SERVER_HOST is unset)');

  L.push(`Each cell is the % change in an equal-weighted basket (that county's municipalities `
    + `× all six price points) — a price index, not a revenue estimate: counties are not `
    + `scaled by market size. Prices are SEK per ad, net of 25% moms, pay-when-removed; `
    + `% changes are VAT-agnostic. Anchor ${anchor} is a complete 420/420 run.`);
  return L.join('\n');
}

// ---------------------------------------------------------------
// the Python bridge
// ---------------------------------------------------------------
// The numbers and the artifacts come from ONE python invocation, so the post and the
// heat map it links to can never be built from two different DB reads.
function runPython(outDir, reportDate, deps = {}) {
  const spawn = deps.spawn || spawnSync;
  const candidates = process.env.PYTHON_BIN ? [process.env.PYTHON_BIN] : ['python3', 'python'];
  const args = [PY_SCRIPT, '--json', '--out-dir', outDir, '--report-date', reportDate];

  let last = null;
  for (const bin of candidates) {
    const res = spawn(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // ENOENT means this interpreter name does not exist — try the next one. Any other
    // failure is a real failure and must not be retried under a different interpreter.
    if (res.error && res.error.code === 'ENOENT') { last = res; continue; }
    if (res.error) throw new Error(`${bin} failed to start: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`${bin} ${PY_SCRIPT} exited ${res.status}\n${res.stderr || ''}`);
    }
    if (res.stderr) process.stderr.write(res.stderr);
    try {
      return JSON.parse(res.stdout);
    } catch (e) {
      throw new Error(`could not parse the report JSON: ${e.message}\nstdout was:\n${String(res.stdout).slice(0, 2000)}`);
    }
  }
  throw new Error(`no python interpreter found (tried ${candidates.join(', ')}); `
    + `set PYTHON_BIN${last && last.error ? ` — last error: ${last.error.message}` : ''}`);
}

async function main() {
  const reportDate = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, 'view-data', reportDate, 'adcost');
  fs.mkdirSync(outDir, { recursive: true });

  const report = runPython(outDir, reportDate);

  // Same URL scheme as sold-match-report.js / weekly-view-report.js: the artifacts are
  // written under view-data/ and served by view-data-server.js, so they are linked
  // rather than uploaded (uploading would require the files:write scope).
  const host = process.env.VIEW_SERVER_HOST;
  const port = process.env.VIEW_SERVER_PORT || 3800;
  const base = host ? `http://${host}:${port}/view-data/${reportDate}/adcost` : null;
  const links = base
    ? { heatmapUrl: `${base}/${HEATMAP_FILE}`, xlsxUrl: `${base}/${XLSX_FILE}` }
    : {};

  const text = renderReport(report, links);
  console.log(text);

  // The JSON audit trail: what a published month actually contained, without having to
  // re-derive it from the DB later (the scrape has no backfill, so a re-run months from
  // now cannot reconstruct it).
  fs.writeFileSync(path.join(outDir, 'adcost-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'adcost-report.md'), text);

  // postMessage RETURNS {ok:false} on a failed delivery — it does not throw — so the
  // catch below never sees a transport failure. Branch on result.ok or a lost report
  // is logged as "Posted to Slack."
  try {
    const result = await postMessage('adcost-report', text);
    if (result.dryRun) {
      console.log('\nDry run — no Slack notification sent');
    } else if (result.ok) {
      console.log('Posted to Slack.');
    } else {
      console.error('Slack post failed on both the bot and the webhook fallback');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Slack failed: ${err.message}`);
    process.exitCode = 1;
  }
}

// `main` is exported so a dry run can be driven WITHOUT runReporter, which would
// otherwise write a real cron_job_log row into the shared production DB and make the
// health digest believe the scheduled job had run.
module.exports = { renderReport, renderCoverage, renderMatrix, renderAddons, runPython, monthLabel, main };

// ---------------------------------------------------------------
// --smoke self-test (offline: no DB, no Python, no Slack)
// ---------------------------------------------------------------
function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  };

  // The runPython check below clears PYTHON_BIN to exercise the interpreter
  // fall-through; put the operator's value back when the suite ends.
  const savedPythonBin = process.env.PYTHON_BIN;

  // Fixture builder mirroring the real --json shape.
  const cell = (municipality, product, price, from, to) => ({
    municipality, county: 'Stockholms', municipality_id: 193, product,
    price_point: price, from, to, pct: (to / from - 1) * 100,
  });
  const product = (name, moved, compared, med, lo, hi, munisMoved) => ({
    product: name, core: ['BASIC', 'PLUS', 'PREMIUM', 'MAX'].includes(name),
    compared, moved, median_pct: med, min_pct: lo, max_pct: hi,
    munis_moved: munisMoved, munis_compared: 10,
  });
  // A county × package matrix. `vals` maps county -> [basic, plus, premium, max];
  // the Total column and TOTAL row are supplied explicitly so the fixture cannot
  // accidentally re-implement (and thereby validate) the renderer's own arithmetic.
  const matrix = (ref, daysBack, vals, extra = {}) => ({
    ref, days_back: daysBack,
    rows: Object.entries(vals).map(([county, v]) => ({
      county,
      tiers: { BASIC: v[0], PLUS: v[1], PREMIUM: v[2], MAX: v[3] },
      total: v[4], cells: 24,
    })),
    total_row: { BASIC: 3.4, PLUS: 5.2, PREMIUM: 6.1, MAX: -21.6 },
    grand_total: -1.7, cells_compared: 240,
    addons: { PAID_REPUBLISH: 5.4, TOPLISTING: 18.3, TOPLISTING_5_DAYS: 13.6 },
    ...extra,
  });
  const MATRICES = {
    anchor: matrix('2025-12-21', 239, {
      'Hallands': [3.5, 5.2, 6.2, -21.6, -1.7],
      'Stockholms': [3.5, 5.3, 6.2, -21.6, -1.7],
    }),
    quarter: matrix('2026-07-12', 36, {
      'Hallands': [0, 0, 0, -20.0, -5.0],
      'Stockholms': [0, 0, 0, -20.0, -5.0],
    }, {
      target: '2026-05-19', off_target_days: 54, actual_days_back: 36, on_target: false,
      total_row: { BASIC: 0, PLUS: 0, PREMIUM: 0, MAX: -20.0 }, grand_total: -5.0,
      addons: { PAID_REPUBLISH: 0, TOPLISTING: 0, TOPLISTING_5_DAYS: 0 },
    }),
  };

  const base = (over = {}) => ({
    matrices: MATRICES,
    report_date: '2026-09-01',
    anchor: { date: '2025-12-21', cells: 420, expected_cells: 420, munis: 10, complete: true },
    latest: { date: '2026-09-01', cells: 420, expected_cells: 420, munis: 10, complete: true, age_days: 0 },
    prior_complete: { date: '2026-08-17', cells: 420, expected_cells: 420, munis: 10, complete: true },
    grid: { municipalities: 10, price_points: 6, products: 7, expected_cells: 420 },
    price_basis: 'net', compared_cells: 420, moved_count: 0, moved_cells: [],
    products: ['BASIC', 'PLUS', 'PREMIUM', 'MAX', 'PAID_REPUBLISH', 'TOPLISTING', 'TOPLISTING_5_DAYS']
      .map(n => product(n, 0, 60, null, null, null, 0)),
    snapshots_total: 48, warnings: [],
    ...over,
  });

  const LINKS = {
    heatmapUrl: 'http://1.2.3.4:3800/view-data/2026-09-01/adcost/adcost-heatmap.html',
    xlsxUrl: 'http://1.2.3.4:3800/view-data/2026-09-01/adcost/adcost-all-data.xlsx',
  };

  check('the header names the month of the SNAPSHOT, not the day the job ran', () => {
    // If the scrape fails, report_date is September but the newest data is August. The
    // title must follow the data, or the post silently re-publishes August as September.
    const out = renderReport(base({
      report_date: '2026-09-01',
      latest: { date: '2026-08-17', cells: 420, expected_cells: 420, munis: 10, complete: true, age_days: 15 },
    }), LINKS);
    assert.ok(/Hemnet ad pricing — August 2026/.test(out), `title must follow the data: ${out.split('\n')[0]}`);
    assert.ok(!/September/.test(out.split('\n')[0]));
  });

  check('coverage states cells, grid shape and scrape date on one line', () => {
    const out = renderReport(base(), LINKS);
    const line = out.split('\n').find(l => l.startsWith('Coverage'));
    assert.ok(/420\/420 cells/.test(line), line);
    assert.ok(/10 munis × 6 price points × 7 products/.test(line), line);
    assert.ok(/scraped 2026-09-01/.test(line), line);
    assert.ok(!/PARTIAL/.test(out), 'a complete run must not be flagged partial');
  });

  check('CRITICAL: a partial scrape is flagged on the coverage line, not left to be inferred', () => {
    // The 2026-08-02 shape: Steel died after Stockholm, 42 cells / 1 muni. Reporting that
    // as if it were a full grid is the exact failure the client called out.
    const out = renderReport(base({
      latest: { date: '2026-09-01', cells: 42, expected_cells: 420, munis: 1, complete: false, age_days: 0 },
      compared_cells: 42, moved_count: 6,
      moved_cells: [
        cell('Stockholms', 'MAX', 2000000, 15250, 11949),
        cell('Stockholms', 'MAX', 5000000, 20490, 16067),
      ],
      warnings: ['latest snapshot 2026-09-01 is PARTIAL: 42/420 cells across 1 of 10 municipalities — only the cells it does carry are compared'],
    }), LINKS);
    assert.ok(/42\/420 cells/.test(out), 'the real cell count must be the headline figure');
    assert.ok(/PARTIAL/.test(out), 'a partial run must say so');
    assert.ok(/1 of 10 municipalities/.test(out));
    assert.ok(/⚠/.test(out), 'the python warning must reach the post verbatim');
    // and the denominator must be the COMPARED cells, never the full grid
    assert.ok(/of 42 observations moved/.test(out),
      `the denominator must be what was actually compared: ${out}`);
  });

  check('a stale scrape surfaces its warning in the post', () => {
    const out = renderReport(base({
      latest: { date: '2026-08-17', cells: 420, expected_cells: 420, munis: 10, complete: true, age_days: 15 },
      warnings: ['the newest snapshot is 15 days old (2026-08-17) — this month\'s scrape appears not to have landed'],
    }), LINKS);
    assert.ok(/15 days old/.test(out), 'a failed scrape must be visible in the post itself');
  });

  check('"nothing moved" renders as a real result, not an empty section', () => {
    const out = renderReport(base(), LINKS);
    assert.ok(/0 of 420 observations moved/.test(out));
    assert.ok(/No price changed/.test(out), `a sticky month must still say something: ${out}`);
    assert.ok(/identical to 2025-12-21/.test(out));
    assert.ok(!/NaN|undefined|null/.test(out), out);
  });

  check('a handful of movers is listed cell by cell, in the client\'s format', () => {
    const moved = [
      cell('Stockholms', 'MAX', 5000000, 23150, 18146),
      cell('Göteborgs', 'MAX', 5000000, 22683, 18146),
    ];
    const out = renderReport(base({
      moved_count: 2, moved_cells: moved,
      products: base().products.map(p => (p.product === 'MAX'
        ? product('MAX', 2, 60, -21.6, -22.0, -21.2, 2) : p)),
    }), LINKS);
    assert.ok(/Stockholms\s+MAX\s+@5\.0M\s+23,150\s+→\s+18,146\s+−21\.6%/.test(out),
      `per-cell format must match the agreed shape: ${out}`);
    assert.ok(!/median/.test(out), 'the per-product roll-up was removed — it printed a second, different number per product');
  });

  check('no product ever carries two different numbers in one post', () => {
    // The roll-up quoted a median-of-percentages (BASIC +3.4%) while the matrix quotes
    // a basket change (BASIC +1.8%). Both correct, both labelled BASIC — that is a
    // defect, and this locks the fix: add-ons use the SAME basket basis as the matrices.
    const out = renderReport(base({ moved_count: 420, moved_cells: [cell('Stockholms', 'MAX', 5000000, 23150, 18146)] }), LINKS);
    assert.ok(!/median/.test(out), 'no median-of-percentages block may return');
    assert.ok(/Add-ons \(national\)/.test(out), `add-ons must still be visible: ${out}`);
    assert.ok(/PAID_REPUBLISH/.test(out) && /TOPLISTING_5_DAYS/.test(out));
    // one row per reference window, each naming its own date
    assert.ok(/vs 2025-12-21\s+\+5\.4%\s+\+18\.3%\s+\+13\.6%/.test(out), `anchor add-on row: ${out}`);
    assert.ok(/vs 2026-07-12\s+\+0\.0%/.test(out), `quarter add-on row: ${out}`);
  });

  check('CRITICAL: many movers never produce hundreds of per-cell lines', () => {
    // The live 2026-08-17 case: all 420 cells differ from the 2025-12-21 anchor. A
    // per-cell list would be 420 lines in Slack, every month, forever.
    const moved = [];
    for (let i = 0; i < 420; i++) moved.push(cell('Stockholms', 'MAX', 5000000, 23150, 18146));
    const out = renderReport(base({
      moved_count: 420, moved_cells: moved,
      products: [
        product('BASIC', 60, 60, 3.39, -0.47, 3.61, 10),
        product('PLUS', 60, 60, 5.16, 1.67, 5.66, 10),
        product('PREMIUM', 60, 60, 6.14, 3.07, 6.75, 10),
        product('MAX', 60, 60, -21.62, -22.59, -7.19, 10),
        product('PAID_REPUBLISH', 60, 60, 5.44, 5.33, 5.59, 10),
        product('TOPLISTING', 60, 60, 18.31, -1.12, 43.78, 10),
        product('TOPLISTING_5_DAYS', 60, 60, 13.62, -0.82, 42.14, 10),
      ],
    }), LINKS);
    // Bound sized for the real post: two 8-county matrices (~11 lines each) plus the
    // add-on block and footers. The guard exists to catch the 420-line explosion,
    // not to police layout.
    assert.ok(out.split('\n').length < 50, `the post must stay readable: got ${out.split('\n').length} lines`);
    // No individual cells at all when hundreds moved: the per-cell rows are
    // suppressed, and the "Largest single move" line was REMOVED 2026-08-18.
    assert.ok(!out.split('\n').some(l => /^ {2}\S+\s+(BASIC|PLUS|PREMIUM|MAX)\s+@/.test(l)),
      'no per-cell rows may leak in when hundreds moved');
    assert.ok(!/Largest single move/.test(out), 'the largest-mover line must not come back');
    assert.ok(/420 of 420 observations moved/.test(out));
  });

  check('a table of all-zero cells reads as genuinely unchanged, not as missing data', () => {
    // The realistic steady state once monthly data accrues: packages are sticky, so the
    // quarter table is mostly +0.0%. That must be visibly different from "—" (no data).
    const out = renderReport(base(), LINKS);
    const qRow = out.split('\n').filter(l => /^Stockholms/.test(l))[1];
    assert.ok(qRow, 'the quarter table must have its own Stockholms row');
    assert.ok(/\+0\.0%/.test(qRow), `an unchanged cell prints +0.0%: ${qRow}`);
    assert.ok(!/—/.test(qRow), 'unchanged must never render as the missing-data dash');
  });

  check('both artifacts are LINKED, never uploaded, and the post says so when they are missing', () => {
    const withLinks = renderReport(base(), LINKS);
    assert.ok(withLinks.includes(`<${LINKS.heatmapUrl}|Heat map>`), withLinks);
    assert.ok(withLinks.includes(`<${LINKS.xlsxUrl}|All data (xlsx)>`), withLinks);
    assert.ok(/^http:\/\/[^ ]+\/view-data\/2026-09-01\/adcost\//.test(LINKS.heatmapUrl),
      'artifacts must be served from view-data/<date>/adcost/, not exports/');

    const noLinks = renderReport(base(), {});
    assert.ok(/VIEW_SERVER_HOST is unset/.test(noLinks),
      'a missing link must be stated, not silently dropped');
    assert.ok(!/undefined/.test(noLinks));
  });

  check('the post never mentions ARPL, and states the VAT basis of the prices it does quote', () => {
    const moved = [cell('Stockholms', 'MAX', 5000000, 23150, 18146)];
    const out = renderReport(base({ moved_count: 1, moved_cells: moved }), LINKS);
    assert.ok(!/ARPL/i.test(out), 'ARPL was dropped — the weights are a frozen, drifted one-off');
    assert.ok(!/revenue per listing/i.test(out));
    assert.ok(/net of 25% moms/.test(out), 'an absolute price with no VAT basis is ambiguous');
    assert.ok(/VAT-agnostic/.test(out));
  });

  check('both tables render as county rows × package columns, with a TOTAL row and NO Total column', () => {
    const out = renderReport(base(), LINKS);
    assert.ok(/vs December 2025 baseline — 2025-12-21 \(239 days\)/.test(out), out);
    // header row carries the four packages in workbook order, and nothing after MAX
    const hdr = out.split('\n').find(l => /BASIC/.test(l) && /MAX/.test(l));
    assert.ok(hdr, 'a matrix header row must render');
    assert.ok(hdr.indexOf('BASIC') < hdr.indexOf('PLUS')
      && hdr.indexOf('PLUS') < hdr.indexOf('PREMIUM')
      && hdr.indexOf('PREMIUM') < hdr.indexOf('MAX'), `column order must match the workbook: ${hdr}`);
    // The cross-package Total column was REMOVED 2026-08-18: we scrape the rate card,
    // not the package mix, so averaging BASIC..MAX implies a mix we never observe.
    assert.ok(!/Total/.test(hdr), `no cross-package Total column may return: ${hdr}`);
    // a county row, and the TOTAL row — both now end at MAX
    assert.ok(/^Stockholms\s+\+3\.5%\s+\+5\.3%\s+\+6\.2%\s+−21\.6%$/m.test(out),
      `county row shape: ${out}`);
    assert.ok(/^TOTAL\s+\+3\.4%\s+\+5\.2%\s+\+6\.1%\s+−21\.6%$/m.test(out),
      `TOTAL row must render: ${out}`);
    // TWO tables, not one — this is what the single-anchor lock used to forbid
    assert.strictEqual((out.match(/^TOTAL\s/gm) || []).length, 2, 'both matrices must render');
  });

  check('CRITICAL: the quarter table states its real elapsed time when 90 days is unreachable', () => {
    // The 2026-03-16 → 2026-06-30 outage removes the true quarter mark. Labelling a
    // 36-day comparison "past quarter" would silently misstate the period.
    const out = renderReport(base(), LINKS);
    assert.ok(/vs 2026-07-12 \(36 days/.test(out), `the real reference and gap must be printed: ${out}`);
    assert.ok(/Past 1\.2 months/.test(out), 'an off-target window must not be called a quarter');
    assert.ok(/scrape outage/.test(out), 'the reason must be stated, not left as a puzzle');

    // and when it IS a true quarter, it says so plainly
    const onTarget = renderReport(base({
      matrices: { ...MATRICES, quarter: { ...MATRICES.quarter, ref: '2026-09-01', days_back: 91, on_target: true } },
    }), LINKS);
    assert.ok(/Past quarter — vs 2026-09-01 \(91 days\)/.test(onTarget), onTarget);
    assert.ok(!/months/.test(onTarget.split('\n').find(l => /Past quarter/.test(l))));
  });

  check('a missing quarter reference is stated, never silently dropped to one table', () => {
    const out = renderReport(base({ matrices: { anchor: MATRICES.anchor, quarter: { ref: null } } }), LINKS);
    assert.ok(/Past quarter — unavailable/.test(out), out);
    assert.strictEqual((out.match(/^TOTAL\s/gm) || []).length, 1, 'only the anchor table can render');
    assert.ok(!/undefined|NaN|null/.test(out), out);
  });

  check('an empty matrix cell renders as an em dash, never NaN or undefined', () => {
    const out = renderReport(base({
      matrices: {
        anchor: matrix('2025-12-21', 239, { 'Jämtlands': [null, null, null, null, null] }),
        quarter: MATRICES.quarter,
      },
    }), LINKS);
    assert.ok(/^Jämtlands\s+—\s+—\s+—\s+—$/m.test(out), `missing county data must degrade visibly: ${out}`);
    assert.ok(!/NaN|undefined/.test(out));
  });

  check('the old heat-map anchor never survives anywhere in the post', () => {
    const out = renderReport(base(), LINKS);
    assert.ok(!/2025-12-28/.test(out), 'the report re-anchored to 2025-12-21');
    assert.ok(/2025-12-21/.test(out));
  });

  check('monthLabel maps every month index correctly', () => {
    assert.strictEqual(monthLabel('2026-01-15'), 'January 2026');
    assert.strictEqual(monthLabel('2026-09-01'), 'September 2026');
    assert.strictEqual(monthLabel('2025-12-21'), 'December 2025');
  });

  check('runPython falls through ENOENT to the next interpreter, but never retries a real failure', () => {
    // PYTHON_BIN collapses the candidate list to one entry, so an operator who
    // runs this smoke during a deploy — where lib/job-registry.js EXPORTS
    // PYTHON_BIN for this very job — would otherwise read a spurious failure.
    // Same guard adcost-crawl.js's smoke uses; restored below.
    delete process.env.PYTHON_BIN;
    const tried = [];
    const ok = runPython('/out', '2026-09-01', {
      spawn: (bin) => {
        tried.push(bin);
        if (bin === 'python3') return { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) };
        return { status: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });
    assert.deepStrictEqual(tried, ['python3', 'python']);
    assert.deepStrictEqual(ok, { ok: true });

    const tried2 = [];
    assert.throws(() => runPython('/out', '2026-09-01', {
      spawn: (bin) => { tried2.push(bin); return { status: 3, stdout: '', stderr: 'boom' }; },
    }), /exited 3/);
    assert.deepStrictEqual(tried2, ['python3'],
      'a non-zero exit is a real failure — retrying it under another interpreter would mask it');
  });

  check('runPython refuses to guess when the python output is not JSON', () => {
    assert.throws(() => runPython('/out', '2026-09-01', {
      spawn: () => ({ status: 0, stdout: 'Traceback...', stderr: '' }),
    }), /could not parse the report JSON/);
  });

  check('validateArgv accepts --smoke and --dry-run and no args; rejects anything else', () => {
    assert.strictEqual(validateArgv(['--smoke']), true);
    assert.strictEqual(validateArgv(['--dry-run']), true);
    assert.strictEqual(validateArgv([]), true);
    assert.strictEqual(validateArgv(['--dryrun']), false, 'a near-miss must not fall through and POST');
    assert.strictEqual(validateArgv(['--dry-run=1']), false);
    assert.strictEqual(validateArgv(['--smoke', '--foo']), false);
  });

  if (savedPythonBin === undefined) delete process.env.PYTHON_BIN;
  else process.env.PYTHON_BIN = savedPythonBin;

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

// Entry gate. dotenv re-injects SLACK_BOT_TOKEN/SLACK_WEBHOOK_URL from .env, so
// unsetting the env var does NOT prevent a post — DRY_RUN=1 is the only guard that
// works, and an unrecognised flag must be rejected rather than fall through to the
// live path. Same pattern as age-census-report.js.
const ACCEPTED_ARGV = new Set(['--smoke', '--dry-run']);
const USAGE = 'Usage: node adcost-report.js [--smoke] [--dry-run]';
function validateArgv(argv) {
  return argv.every(a => ACCEPTED_ARGV.has(a));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!validateArgv(argv)) {
    console.error(`Unrecognised argument(s): ${argv.filter(a => !ACCEPTED_ARGV.has(a)).join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  } else if (argv.includes('--smoke')) {
    smoke();
  } else {
    if (argv.includes('--dry-run')) process.env.DRY_RUN = '1';
    runReporter({ scriptName: 'adcost-report', run: main });
  }
}
