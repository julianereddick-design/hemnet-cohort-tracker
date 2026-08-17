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
//  - ONE anchor: 2025-12-21, pinned in the Python. No second "vs last run" comparison
//    in the post. The anchor is a complete snapshot (420/420, verified).
//  - The headline is CHANGE. Prices are sticky — between 2026-07-12 and 2026-08-17
//    exactly 60 of 420 observations moved, all of them MAX — so "nothing moved" is a
//    real and useful result, not an empty report.
//  - Artifacts are LINKED, never uploaded (that would need files:write). They are
//    written to view-data/<date>/adcost/ and served by view-data-server.js on :3800.
//
// Two rendering regimes, chosen by how much moved:
//  - Few movers (<= LIST_MAX): every moved cell is listed individually, which is the
//    format the client asked for.
//  - Many movers: a per-PRODUCT roll-up. This is not a stylistic preference. The anchor
//    is FIXED, so the moved set only grows: as of 2026-08-17 all 420 of 420 cells differ
//    from 2025-12-21, and listing 420 lines every month forever is not a report. The
//    roll-up says the same thing at a readable altitude and the heat map carries the detail.
//
// Cron: 07:00 UTC on the 1st, five hours after the 02:00 UTC scrape on the price droplet.
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

// The per-product roll-up. `moved` is counted, never assumed: "unchanged in all 10
// municipalities" is a claim about data and is only printed when munis_moved is 0.
function renderProductTable(products) {
  const L = [];
  L.push(rpad('Product', 20) + lpad('moved', 9) + lpad('median', 9) + '   range');
  for (const p of products) {
    if (p.moved === 0) {
      L.push(rpad(p.product, 20) + lpad(`0/${p.compared}`, 9) + lpad('—', 9)
        + `   unchanged in all ${p.munis_compared} municipalities`);
      continue;
    }
    const range = `${pctSigned(p.min_pct)} … ${pctSigned(p.max_pct)}`;
    L.push(rpad(p.product, 20) + lpad(`${p.moved}/${p.compared}`, 9)
      + lpad(pctSigned(p.median_pct), 9) + '   ' + range);
  }
  return L;
}

// The biggest single move, named. With a roll-up the reader loses every individual
// cell, and the largest mover is the one cell always worth naming explicitly.
function renderLargestMover(moved) {
  if (!moved.length) return null;
  const top = moved.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a));
  return `Largest single move: ${top.municipality} ${top.product} @${fmtPricePoint(top.price_point)}   `
    + `${fmtN(top.from)} → ${fmtN(top.to)}  ${pctSigned(top.pct)}`;
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
  L.push('```');

  if (report.moved_count === 0) {
    // Not an empty report. Hemnet's prices are sticky, and a month in which nothing
    // moved is a finding — it is why the anchor comparison is worth publishing at all.
    L.push(`No price changed. All ${fmtN(report.compared_cells)} observations are identical to ${anchor}.`);
  } else if (moved.length <= LIST_MAX) {
    for (const c of moved) L.push(renderMovedCell(c));
    const still = (report.products || []).filter(p => p.moved === 0).map(p => p.product);
    if (still.length) L.push('', `${still.join(' / ')} unchanged in every municipality.`);
  } else {
    for (const line of renderProductTable(report.products || [])) L.push(line);
    const top = renderLargestMover(moved);
    if (top) L.push('', top);
  }

  L.push('```');

  // Every warning the Python raised, verbatim. A stale or partial scrape must never
  // be inferable only from a number the reader has to compare against last month.
  for (const w of report.warnings || []) L.push(`⚠ ${w}`);

  const artifacts = [];
  if (links.heatmapUrl) artifacts.push(`<${links.heatmapUrl}|Heat map>`);
  if (links.xlsxUrl) artifacts.push(`<${links.xlsxUrl}|All data (xlsx)>`);
  if (artifacts.length) L.push(artifacts.join('   ·   '));
  else L.push('(artifacts not linked — VIEW_SERVER_HOST is unset)');

  L.push(`Prices are SEK per ad, net of 25% moms, on the pay-when-removed basis; `
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
module.exports = { renderReport, renderCoverage, renderProductTable, runPython, monthLabel, main };

// ---------------------------------------------------------------
// --smoke self-test (offline: no DB, no Python, no Slack)
// ---------------------------------------------------------------
function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  };

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
  const base = (over = {}) => ({
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
    assert.ok(/BASIC \/ PLUS \/ PREMIUM/.test(out), 'products with zero movers must be named as unchanged');
    assert.ok(!/median/.test(out), 'a short list must not also render the roll-up table');
  });

  check('CRITICAL: many movers collapse to a per-product roll-up instead of hundreds of lines', () => {
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
    assert.ok(out.split('\n').length < 30, `the post must stay readable: got ${out.split('\n').length} lines`);
    assert.ok(/MAX\s+60\/60\s+−21\.6%\s+−22\.6% … −7\.2%/.test(out), `roll-up row shape: ${out}`);
    assert.ok(/Largest single move/.test(out), 'the roll-up must still name the single biggest mover');
    assert.ok(/420 of 420 observations moved/.test(out));
  });

  check('the roll-up prints "unchanged in all N municipalities" only when nothing in that product moved', () => {
    const moved = [];
    for (let i = 0; i < 60; i++) moved.push(cell('Stockholms', 'MAX', 5000000, 23150, 18146));
    const out = renderReport(base({
      moved_count: 60, moved_cells: moved,
      products: [
        product('BASIC', 0, 60, null, null, null, 0),
        product('MAX', 60, 60, -21.6, -22.6, -7.2, 10),
      ],
    }), LINKS);
    assert.ok(/BASIC\s+0\/60\s+—\s+unchanged in all 10 municipalities/.test(out), out);
    assert.ok(!/MAX.*unchanged/.test(out), 'a product that moved must never be called unchanged');
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

  check('exactly ONE anchor is quoted, everywhere it appears', () => {
    const out = renderReport(base(), LINKS);
    const dates = out.match(/\d{4}-\d{2}-\d{2}/g).filter(d => d !== '2026-09-01');
    assert.deepStrictEqual([...new Set(dates)], ['2025-12-21'],
      `the post must quote one and only one baseline: ${[...new Set(dates)]}`);
    assert.ok(!/2025-12-28/.test(out), 'the old heat-map anchor must not survive anywhere');
  });

  check('monthLabel maps every month index correctly', () => {
    assert.strictEqual(monthLabel('2026-01-15'), 'January 2026');
    assert.strictEqual(monthLabel('2026-09-01'), 'September 2026');
    assert.strictEqual(monthLabel('2025-12-21'), 'December 2025');
  });

  check('runPython falls through ENOENT to the next interpreter, but never retries a real failure', () => {
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
