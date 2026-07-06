// sold-match-trend-chart.js — Phase 20 committed-HTML Chart.js-4 trend over sold_match
// (REPORT-02 / REPORT-03; D-01/D-07).
//
// Standalone generator modeled on chart-hb-ratio.js (query → compute series →
// embed-JSON-in-<script> → write self-contained HTML to view-data/<date>/). For each
// FORTNIGHTLY period (keyed by window_end's ISO week, since the batch runs fortnightly so
// each window_end already lands on its own period) it computes:
//   settledRate     = genuine_non_hemnet / (matched + genuine_non_hemnet)  — TERMINAL only
//   matchRate       = matched          / (matched + genuine_non_hemnet)    — TERMINAL only
//   rawBooliOnlyRate = booli_only / total                                  — preliminary
// and writes a self-contained Chart.js-4 line chart to
//   view-data/<date>/sold-match/trend.html   (served by view-data-server.js on :3800).
//
// The settled-non-Hemnet series (decision-grade, solid/prominent) is labelled/styled
// DISTINCTLY from the raw booli_only series (dashed/muted, "preliminary, lag-contaminated")
// so slutpris-lag contamination is never read as genuine non-Hemnet presence (D-03/D-07).
//
//   node sold-match-trend-chart.js          # production run (needs DB)
//   node sold-match-trend-chart.js --smoke  # offline self-test (no DB, no network)

const { createClient } = require('./db');
const fs = require('fs');
const path = require('path');

// EXCLUDED_COHORTS — ISO-week keys to drop from the sold-match analysis entirely. 2026-W12
// is a pre-national pilot pull (~54 records, March 2026) that was never part of the national
// sold-match analysis; it skews the trend and the weekly Slack table. Both the chart and the
// report compute cohorts via buildSeries, so listing a key here excludes it from BOTH. Keys
// are full 'YYYY-Www' so they never collide with the same ISO week in another year.
const EXCLUDED_COHORTS = ['2026-W12'];

// ---------------------------------------------------------------------------
// isoWeekKey(dateStr) — map a YYYY-MM-DD to its ISO-8601 week label 'YYYY-Www'
// (Thursday-anchored ISO week number + ISO week-YEAR). Modeled on the
// sold-match-batch.js isoWeekNumber() Thursday-shift, extended to also derive the
// ISO week-year (which can differ from the calendar year near Jan 1 / Dec 31).
// ---------------------------------------------------------------------------
function isoWeekKey(dateStr) {
  const src = new Date(dateStr);
  const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
  const day = d.getUTCDay() || 7;          // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);  // shift to Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// emptyPeriod() — per-cohort counts. A "cohort" = one fortnightly batch window
// (keyed by window_end's ISO week). firstPull = matched at the cohort's initial pass
// (never enrolled for re-check). incremental = matched LATER via the re-check drain
// (was enrolled — first_unmatched_at set). total = all sampled Booli properties.
// ---------------------------------------------------------------------------
function emptyPeriod() {
  return { total: 0, firstPull: 0, incremental: 0 };
}

// rowEnrolled(r) — was this row ever enrolled in the re-check drain? (first_unmatched_at set)
function rowEnrolled(r) {
  return r.was_enrolled === true || r.was_enrolled === 't' || (r.first_unmatched_at != null);
}

// ---------------------------------------------------------------------------
// buildSeries(rows) — PURE. Group sold_match rows by isoWeekKey(window_end) into cohorts and
// compute, per cohort, the two STACKED on-Hemnet shares (% of that cohort's Booli properties):
//   firstPull    = matched AND NOT enrolled  / total   (found on Hemnet at the first pass)
//   incremental  = matched AND enrolled      / total   (found on Hemnet later, via re-check)
// The two stack to the cohort's cumulative on-Hemnet match rate; the headroom to 100% is the
// still-not-on-Hemnet remainder. Rows carry { verdict, window_end, was_enrolled }.
//   Returns { periods:[...sorted week keys], firstPull:[...0..1], incremental:[...0..1],
//             totals:[...counts] }.
// ---------------------------------------------------------------------------
function buildSeries(rows, opts = {}) {
  // opts.exclude overrides the default EXCLUDED_COHORTS (pass [] to include everything).
  const excluded = opts.exclude || EXCLUDED_COHORTS;
  const byPeriod = {};
  for (const r of (rows || [])) {
    if (r.window_end == null) continue;
    const key = isoWeekKey(r.window_end);
    if (excluded.includes(key)) continue; // drop pre-national pilots from the analysis
    if (!byPeriod[key]) byPeriod[key] = emptyPeriod();
    const p = byPeriod[key];
    p.total++;
    if (r.verdict === 'matched') {
      if (rowEnrolled(r)) p.incremental++;
      else p.firstPull++;
    }
  }

  const periods = Object.keys(byPeriod).sort(); // 'YYYY-Www' strings sort chronologically
  const firstPull = [];
  const incremental = [];
  const totals = [];
  for (const key of periods) {
    const p = byPeriod[key];
    firstPull.push(p.total === 0 ? 0 : p.firstPull / p.total);
    incremental.push(p.total === 0 ? 0 : p.incremental / p.total);
    totals.push(p.total);
  }
  return { periods, firstPull, incremental, totals };
}

// ---------------------------------------------------------------------------
// renderHtml(series, opts) — PURE. Self-contained Chart.js-4 STACKED BAR string. One bar per
// cohort (x = fortnightly window). Each bar is two stacked segments (% of that cohort's Booli
// sold properties on Hemnet):
//   (1) Matched first pull        — solid blue  (#1565C0)
//   (2) Found later via re-check  — lighter blue (#90CAF9), the incremental top-up
// The bar total = cumulative on-Hemnet %; the headroom to 100% is still-not-on-Hemnet. As a
// cohort matures its incremental segment grows (the re-check drain finding late Hemnet matches).
// Values embedded inline via JSON.stringify — no external data file.
// ---------------------------------------------------------------------------
function renderHtml(series, opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const toPct = (arr) => arr.map((v) => (v == null ? 0 : Math.round(v * 1000) / 10));

  const datasets = [
    { label: 'Matched first pull', data: toPct(series.firstPull), backgroundColor: '#1565C0' },
    { label: 'Found later (re-check)', data: toPct(series.incremental), backgroundColor: '#90CAF9' },
  ];
  const datasetsJson = datasets.map((d) => `{
      label: ${JSON.stringify(d.label)},
      data: ${JSON.stringify(d.data)},
      backgroundColor: '${d.backgroundColor}',
      stack: 'onHemnet'
    }`);

  const title = 'Sold-match by cohort — % of Booli sold properties found on Hemnet '
    + '(first pull + later re-check)';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sold-match by cohort — ${date}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #fff; }
    .chart-container { width: 900px; height: 420px; }
    .note { color: #607D8B; font-size: 13px; max-width: 900px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="chart-container">
    <canvas id="chart"></canvas>
  </div>
  <p class="note">
    Each bar is one fortnightly cohort. <b>Matched first pull</b> (solid blue) = the share of that
    cohort's Booli sold properties found on Hemnet at the initial match; <b>Found later</b> (light
    blue) = the additional share found on Hemnet by subsequent re-check pulls. The two stack to the
    cohort's cumulative on-Hemnet rate; the gap up to 100% is still-not-on-Hemnet (still draining
    over ~4 weeks of re-checks). Older cohorts' light-blue segment grows as late matches resolve.
  </p>
  <script>
    new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(series.periods)},
        datasets: [${datasetsJson.join(',\n          ')}]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: ${JSON.stringify(title)},
            font: { size: 15 },
            align: 'start'
          },
          legend: { position: 'top', align: 'start', labels: { usePointStyle: true, boxWidth: 30 } }
        },
        scales: {
          x: { stacked: true, title: { display: true, text: 'Cohort (fortnightly window_end ISO week)' }, grid: { display: false } },
          y: { stacked: true, min: 0, max: 100, title: { display: true, text: '% of cohort Booli properties on Hemnet' }, grid: { color: '#eee' } }
        }
      }
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// writeChart(series, opts) — write renderHtml output to
//   view-data/<date>/sold-match/trend.html  (mkdir -p). Returns the absolute path.
// ---------------------------------------------------------------------------
function writeChart(series, opts = {}) {
  const runDate = opts.date || new Date().toISOString().slice(0, 10);
  const html = renderHtml(series, { date: runDate });
  const outDir = path.join(__dirname, 'view-data', runDate, 'sold-match');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'trend.html');
  fs.writeFileSync(outFile, html, 'utf8');
  return outFile;
}

// ---------------------------------------------------------------------------
// DB query (live run() path only — NOT used by --smoke). Static SELECT (T-20-05),
// no interpolated input. Returns rows shaped for buildSeries: { verdict, window_end }.
// ---------------------------------------------------------------------------
async function fetchRows(client) {
  const res = await client.query(
    `SELECT verdict, (first_unmatched_at IS NOT NULL) AS was_enrolled,
            to_char(window_end, 'YYYY-MM-DD') AS window_end
       FROM sold_match
      WHERE window_end IS NOT NULL
      ORDER BY window_end`,
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// run() — live path. createClient/connect/try/finally(end) verbatim from chart-hb-ratio.js.
// ---------------------------------------------------------------------------
async function run() {
  const client = createClient();
  await client.connect();

  let rows;
  try {
    rows = await fetchRows(client);
  } finally {
    await client.end();
  }

  const series = buildSeries(rows);
  const outFile = writeChart(series, { date: new Date().toISOString().slice(0, 10) });

  console.log(`Chart: ${outFile}`);
  console.log('cohort       n   firstPull  +later   = onHemnet');
  for (let i = 0; i < series.periods.length; i++) {
    const fp = series.firstPull[i] || 0;
    const inc = series.incremental[i] || 0;
    const fmt = (v) => `${(v * 100).toFixed(1)}%`;
    console.log(`${series.periods[i]}  ${String(series.totals[i]).padStart(4)}  ${fmt(fp).padStart(8)}  ${fmt(inc).padStart(6)}  ${fmt(fp + inc).padStart(8)}`);
  }
}

module.exports = { isoWeekKey, buildSeries, renderHtml, writeChart, EXCLUDED_COHORTS };

// ---------------------------------------------------------------------------
// Entry gate: --smoke runs the offline self-test; otherwise run().
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  runSmoke();
} else if (require.main === module) {
  run().catch((err) => { console.error('Error:', err.message); process.exit(1); });
}

// ---------------------------------------------------------------------------
// --smoke self-test — fully offline (no DB, no network). Drives the pure helpers +
// renderHtml + writeChart on an in-script FIXTURE. Mirrors the check()/checkAsync()/
// pass-fail/process.exit pattern from lib/spotcheck-slack-bot.js.
//   node sold-match-trend-chart.js --smoke
// ---------------------------------------------------------------------------
function runSmoke() {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // FIXTURE: rows across two fortnightly cohorts (distinct window_end ISO weeks).
  //   Cohort A (window_end 2026-06-10 → 2026-W24): 7 matched first-pull + 1 matched late
  //     (was_enrolled) + 2 settled + 10 booli_only + 1 uncertain → total 21,
  //     firstPull 7/21, incremental 1/21, onHemnet 8/21.
  //   Cohort B (window_end 2026-05-27 → 2026-W22): 3 matched first-pull + 1 settled + 2 booli_only
  //     → total 6, firstPull 3/6=0.5, incremental 0.
  function fixtureRows() {
    const rows = [];
    const A = '2026-06-10'; // ISO week 2026-W24
    const B = '2026-05-27'; // ISO week 2026-W22
    for (let i = 0; i < 7; i++) rows.push({ verdict: 'matched', was_enrolled: false, window_end: A });
    rows.push({ verdict: 'matched', was_enrolled: true, window_end: A, first_unmatched_at: '2026-06-01T00:00:00Z' });
    for (let i = 0; i < 2; i++) rows.push({ verdict: 'genuine_non_hemnet', window_end: A });
    for (let i = 0; i < 10; i++) rows.push({ verdict: 'booli_only', window_end: A });
    rows.push({ verdict: 'uncertain', window_end: A });
    for (let i = 0; i < 3; i++) rows.push({ verdict: 'matched', was_enrolled: false, window_end: B });
    rows.push({ verdict: 'genuine_non_hemnet', window_end: B });
    for (let i = 0; i < 2; i++) rows.push({ verdict: 'booli_only', window_end: B });
    return rows;
  }

  // 1. isoWeekKey maps a known date to the expected ISO-week label.
  check('isoWeekKey: 2026-06-10 → 2026-W24', () => {
    assert.strictEqual(isoWeekKey('2026-06-10'), '2026-W24');
  });
  check('isoWeekKey: 2026-05-27 → 2026-W22', () => {
    assert.strictEqual(isoWeekKey('2026-05-27'), '2026-W22');
  });
  check('isoWeekKey: ISO week-year boundary 2025-12-31 → 2026-W01', () => {
    // 2025-12-31 is a Wednesday; its ISO week is 2026-W01.
    assert.strictEqual(isoWeekKey('2025-12-31'), '2026-W01');
  });

  // 2. buildSeries: per-cohort firstPull + incremental shares (stacked on-Hemnet %).
  check('buildSeries: cohort A firstPull=7/21, incremental=1/21; cohort B firstPull=3/6', () => {
    const s = buildSeries(fixtureRows());
    const a = s.periods.indexOf('2026-W24');
    const b = s.periods.indexOf('2026-W22');
    assert.ok(a >= 0 && b >= 0, 'both cohorts present');
    assert.ok(Math.abs(s.firstPull[a] - (7 / 21)) < 1e-9, `A firstPull 7/21 got ${s.firstPull[a]}`);
    assert.ok(Math.abs(s.incremental[a] - (1 / 21)) < 1e-9, `A incremental 1/21 got ${s.incremental[a]}`);
    assert.strictEqual(s.totals[a], 21, 'A total 21');
    assert.ok(Math.abs(s.firstPull[b] - 0.5) < 1e-9, `B firstPull 0.5 got ${s.firstPull[b]}`);
    assert.strictEqual(s.incremental[b], 0, 'B incremental 0');
    // first-pull + incremental = cumulative on-Hemnet match rate (8/21 for A).
    assert.ok(Math.abs((s.firstPull[a] + s.incremental[a]) - (8 / 21)) < 1e-9, 'A onHemnet 8/21');
  });

  // 2b. buildSeries excludes EXCLUDED_COHORTS (2026-W12 pre-national pilot) by default,
  //     and opts.exclude=[] opts back in.
  check('buildSeries: excludes 2026-W12 by default; opts.exclude=[] includes it', () => {
    const rows = [
      { verdict: 'matched', was_enrolled: false, window_end: '2026-03-18' }, // 2026-W12
      { verdict: 'matched', was_enrolled: false, window_end: '2026-06-10' }, // 2026-W24
    ];
    assert.strictEqual(isoWeekKey('2026-03-18'), '2026-W12', 'sanity: 2026-03-18 is W12');
    const s = buildSeries(rows);
    assert.ok(!s.periods.includes('2026-W12'), 'W12 excluded by default');
    assert.ok(s.periods.includes('2026-W24'), 'W24 retained');
    const sAll = buildSeries(rows, { exclude: [] });
    assert.ok(sAll.periods.includes('2026-W12'), 'W12 present when exclude=[]');
  });

  // 3. multi-cohort ordering is chronological regardless of input order.
  check('buildSeries: cohorts returned chronologically regardless of input order', () => {
    const rows = fixtureRows();
    rows.reverse();
    const s = buildSeries(rows);
    const sorted = [...s.periods].sort();
    assert.deepStrictEqual(s.periods, sorted, 'periods must be sorted');
    assert.deepStrictEqual(s.periods, ['2026-W22', '2026-W24'], 'expected W22 before W24');
  });

  // 4. cohort with no matched rows → firstPull & incremental both 0 (empty bar, full headroom).
  check('buildSeries: cohort with only booli_only/uncertain → firstPull & incremental 0', () => {
    const s = buildSeries([
      { verdict: 'booli_only', window_end: '2026-06-10' },
      { verdict: 'uncertain', window_end: '2026-06-10' },
    ]);
    const i = s.periods.indexOf('2026-W24');
    assert.strictEqual(s.firstPull[i], 0, 'firstPull 0 with no matches');
    assert.strictEqual(s.incremental[i], 0, 'incremental 0 with no matches');
    assert.strictEqual(s.totals[i], 2, 'total still 2');
  });

  // 5. renderHtml: stacked BAR with both segment labels + the incremental top-up embedded.
  check('renderHtml: stacked bar, first-pull + found-later labels, distinct values', () => {
    const s = buildSeries(fixtureRows());
    const html = renderHtml(s, { date: '2026-06-18' });
    assert.ok(html.includes('cdn.jsdelivr.net/npm/chart.js@4'), 'loads chart.js@4 from CDN');
    assert.ok(html.includes("type: 'bar'"), 'bar chart type');
    assert.ok(/stacked:\s*true/.test(html), 'stacked scales');
    assert.ok(html.includes('Matched first pull'), 'has first-pull segment label');
    assert.ok(html.includes('Found later (re-check)'), 'has found-later segment label');
    const fpIdx = html.indexOf('Matched first pull');
    const incIdx = html.indexOf('Found later (re-check)');
    assert.ok(fpIdx >= 0 && incIdx >= 0 && fpIdx < incIdx, 'first-pull dataset before incremental');
  });

  // 6. renderHtml: both datasets share one stack ('onHemnet') so they stack into one bar.
  check('renderHtml: datasets share stack onHemnet', () => {
    const html = renderHtml(buildSeries(fixtureRows()), { date: '2026-06-18' });
    const stacks = (html.match(/stack:\s*'onHemnet'/g) || []).length;
    assert.strictEqual(stacks, 2, `both datasets stacked, got ${stacks}`);
  });

  // 7. writeChart: writes view-data/<date>/sold-match/trend.html; file exists + both labels.
  check('writeChart: writes self-contained trend.html with both bar labels', () => {
    const smokeDate = '2026-06-18-smoke';
    const s = buildSeries(fixtureRows());
    const outFile = writeChart(s, { date: smokeDate });
    assert.ok(fs.existsSync(outFile), `expected file at ${outFile}`);
    assert.ok(outFile.replace(/\\/g, '/').endsWith(`view-data/${smokeDate}/sold-match/trend.html`),
      `unexpected path ${outFile}`);
    const back = fs.readFileSync(outFile, 'utf8');
    assert.ok(back.includes('Matched first pull'), 'written HTML has first-pull label');
    assert.ok(back.includes('Found later (re-check)'), 'written HTML has found-later label');
    assert.ok(back.includes('cdn.jsdelivr.net/npm/chart.js@4'), 'written HTML loads chart.js@4');
    console.log(`smoke wrote: ${outFile}`);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
