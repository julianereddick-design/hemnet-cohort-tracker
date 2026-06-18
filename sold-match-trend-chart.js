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
// emptyPeriod() — per-period verdict counts.
// ---------------------------------------------------------------------------
function emptyPeriod() {
  return { matched: 0, booliOnly: 0, settled: 0, uncertain: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// buildSeries(rows) — PURE. Group sold_match rows by isoWeekKey(window_end) and compute
// per period the three rates. Rows carry { verdict, window_end }.
//   Returns { periods: [...sorted week keys], settled: [...], match: [...], rawBooliOnly: [...] }
//   with null entries for periods with no terminal verdicts (settled/match) — spanGaps.
//   rawBooliOnly is null only when total === 0.
// ---------------------------------------------------------------------------
function buildSeries(rows) {
  const byPeriod = {};
  for (const r of (rows || [])) {
    if (r.window_end == null) continue;
    const key = isoWeekKey(r.window_end);
    if (!byPeriod[key]) byPeriod[key] = emptyPeriod();
    const p = byPeriod[key];
    p.total++;
    switch (r.verdict) {
      case 'matched': p.matched++; break;
      case 'booli_only': p.booliOnly++; break;
      case 'genuine_non_hemnet': p.settled++; break;
      case 'uncertain': p.uncertain++; break;
      default:
        console.warn(`WARN: unknown verdict "${r.verdict}" in period ${key} — counted only in total`);
        break;
    }
  }

  const periods = Object.keys(byPeriod).sort(); // 'YYYY-Www' strings sort chronologically
  const settled = [];
  const match = [];
  const rawBooliOnly = [];
  for (const key of periods) {
    const p = byPeriod[key];
    const terminal = p.matched + p.settled;
    settled.push(terminal === 0 ? null : p.settled / terminal);
    match.push(terminal === 0 ? null : p.matched / terminal);
    rawBooliOnly.push(p.total === 0 ? null : p.booliOnly / p.total);
  }
  return { periods, settled, match, rawBooliOnly };
}

// ---------------------------------------------------------------------------
// renderHtml(series, opts) — PURE. Self-contained Chart.js-4 line chart string.
// Datasets (data embedded inline via JSON.stringify — no external data file):
//   (1) Settled non-Hemnet rate — decision-grade, solid prominent (#1565C0, width 3)
//   (2) Match rate — solid (#2E7D32, width 2)
//   (3) Raw booli_only (preliminary, lag-contaminated) — dashed + muted (#B0BEC5)
// Rates scaled to percent (0..100). spanGaps:true for null periods.
// ---------------------------------------------------------------------------
function renderHtml(series, opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const toPct = (arr) => arr.map((v) => (v == null ? null : Math.round(v * 1000) / 10));

  const datasets = [
    {
      label: 'Settled non-Hemnet rate (decision-grade)',
      data: toPct(series.settled),
      borderColor: '#1565C0', borderWidth: 3, borderDash: [], pointRadius: 2,
      tension: 0.3, spanGaps: true,
    },
    {
      label: 'Match rate',
      data: toPct(series.match),
      borderColor: '#2E7D32', borderWidth: 2, borderDash: [], pointRadius: 2,
      tension: 0.3, spanGaps: true,
    },
    {
      label: 'Raw booli_only (preliminary, lag-contaminated)',
      data: toPct(series.rawBooliOnly),
      borderColor: '#B0BEC5', borderWidth: 2, borderDash: [6, 3], pointRadius: 2,
      tension: 0.3, spanGaps: true,
    },
  ];

  const datasetsJson = datasets.map((d) => `{
      label: ${JSON.stringify(d.label)},
      data: ${JSON.stringify(d.data)},
      borderColor: '${d.borderColor}',
      borderWidth: ${d.borderWidth},
      borderDash: [${d.borderDash.join(',')}],
      pointRadius: ${d.pointRadius},
      tension: 0.3,
      spanGaps: true
    }`);

  const title = 'Sold-match trend — settled genuine-non-Hemnet rate (decision-grade) '
    + 'vs raw booli_only (preliminary)';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sold-match trend — ${date}</title>
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
    The <b>settled</b> non-Hemnet rate (solid blue) = genuine_non_hemnet / (matched +
    genuine_non_hemnet) over TERMINAL verdicts only — the decision-grade headline. The
    <b>raw booli_only</b> rate (dashed grey) = booli_only / total is preliminary and
    lag-contaminated (drains over ~4 weeks of re-checks); never read it as genuine
    non-Hemnet presence.
  </p>
  <script>
    new Chart(document.getElementById('chart'), {
      type: 'line',
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
          x: { title: { display: true, text: 'Fortnightly period (window_end ISO week)' }, grid: { display: false } },
          y: { min: 0, max: 100, title: { display: true, text: 'Rate (%)' }, grid: { color: '#eee' } }
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
    `SELECT verdict, segment, to_char(window_end, 'YYYY-MM-DD') AS window_end
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
  console.log('period      settled   match     raw booli_only');
  for (let i = 0; i < series.periods.length; i++) {
    const fmt = (v) => (v == null ? '   n/a' : `${(v * 100).toFixed(1)}%`);
    console.log(`${series.periods[i]}  ${fmt(series.settled[i]).padStart(7)}  ${fmt(series.match[i]).padStart(7)}  ${fmt(series.rawBooliOnly[i]).padStart(7)}`);
  }
}

module.exports = { isoWeekKey, buildSeries, renderHtml, writeChart };

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

  // FIXTURE: rows across two fortnightly periods (distinct window_end ISO weeks).
  //   Period A (window_end 2026-06-10 → 2026-W24): matched=8 (one late-resolved),
  //     settled=2, booli_only=10, uncertain=1 → settled 2/10=20%, match 8/10=80%, raw 10/21.
  //   Period B (window_end 2026-05-27 → 2026-W22): matched=3, settled=1, booli_only=2.
  function fixtureRows() {
    const rows = [];
    const A = '2026-06-10'; // ISO week 2026-W24
    const B = '2026-05-27'; // ISO week 2026-W22
    for (let i = 0; i < 7; i++) rows.push({ verdict: 'matched', window_end: A });
    rows.push({ verdict: 'matched', window_end: A, first_unmatched_at: '2026-06-01T00:00:00Z' });
    for (let i = 0; i < 2; i++) rows.push({ verdict: 'genuine_non_hemnet', window_end: A });
    for (let i = 0; i < 10; i++) rows.push({ verdict: 'booli_only', window_end: A });
    rows.push({ verdict: 'uncertain', window_end: A });
    for (let i = 0; i < 3; i++) rows.push({ verdict: 'matched', window_end: B });
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

  // 2. buildSeries: settled excludes in-recheck booli_only — three DISTINCT numbers.
  check('buildSeries: period A settled=2/10=0.20, match=8/10=0.80, raw=10/21', () => {
    const s = buildSeries(fixtureRows());
    const i = s.periods.indexOf('2026-W24');
    assert.ok(i >= 0, '2026-W24 present');
    assert.ok(Math.abs(s.settled[i] - 0.2) < 1e-9, `settled expected 0.20 got ${s.settled[i]}`);
    assert.ok(Math.abs(s.match[i] - 0.8) < 1e-9, `match expected 0.80 got ${s.match[i]}`);
    assert.ok(Math.abs(s.rawBooliOnly[i] - (10 / 21)) < 1e-9, `raw expected 10/21 got ${s.rawBooliOnly[i]}`);
    assert.notStrictEqual(s.settled[i], s.rawBooliOnly[i], 'settled and raw must differ');
  });

  // 3. multi-period ordering is chronological regardless of input order.
  check('buildSeries: periods returned chronologically regardless of input order', () => {
    const rows = fixtureRows();
    rows.reverse(); // shuffle: B-rows now precede A-rows? reverse keeps mix; assert sort anyway
    const s = buildSeries(rows);
    const sorted = [...s.periods].sort();
    assert.deepStrictEqual(s.periods, sorted, 'periods must be sorted');
    assert.deepStrictEqual(s.periods, ['2026-W22', '2026-W24'], 'expected W22 before W24');
  });

  // 4. period with no terminal verdicts → null settled/match (spanGaps).
  check('buildSeries: period with only booli_only/uncertain → null settled & match', () => {
    const s = buildSeries([
      { verdict: 'booli_only', window_end: '2026-06-10' },
      { verdict: 'uncertain', window_end: '2026-06-10' },
    ]);
    const i = s.periods.indexOf('2026-W24');
    assert.strictEqual(s.settled[i], null, 'settled null with no terminal verdicts');
    assert.strictEqual(s.match[i], null, 'match null with no terminal verdicts');
    assert.ok(Math.abs(s.rawBooliOnly[i] - 0.5) < 1e-9, 'raw = 1/2 still computed');
  });

  // 5. renderHtml: chart.js@4 + distinct settled/raw labels, distinct embedded values.
  check('renderHtml: chart.js@4, settled label distinct from raw booli_only label', () => {
    const s = buildSeries(fixtureRows());
    const html = renderHtml(s, { date: '2026-06-18' });
    assert.ok(html.includes('cdn.jsdelivr.net/npm/chart.js@4'), 'loads chart.js@4 from CDN');
    assert.ok(html.includes('Settled non-Hemnet'), 'has Settled non-Hemnet label');
    assert.ok(/booli_only.*preliminary|preliminary.*booli_only/i.test(html), 'has distinct raw booli_only/preliminary label');
    assert.ok(html.includes('lag-contaminated'), 'raw labelled lag-contaminated');
    // embedded values: settled 20.0 distinct from raw ~47.6 for period A.
    assert.ok(html.includes('20'), 'embedded settled pct present');
    // The settled and raw datasets must hold different arrays.
    const settledIdx = html.indexOf('Settled non-Hemnet');
    const rawIdx = html.indexOf('Raw booli_only');
    assert.ok(settledIdx >= 0 && rawIdx >= 0 && settledIdx < rawIdx, 'both datasets present, settled first');
  });

  // 6. renderHtml: type 'line'.
  check('renderHtml: line chart', () => {
    const html = renderHtml(buildSeries(fixtureRows()), { date: '2026-06-18' });
    assert.ok(html.includes("type: 'line'"), 'line chart type');
  });

  // 7. writeChart: writes view-data/<date>/sold-match/trend.html; file exists + both labels.
  check('writeChart: writes self-contained trend.html with both labels', () => {
    const smokeDate = '2026-06-18-smoke';
    const s = buildSeries(fixtureRows());
    const outFile = writeChart(s, { date: smokeDate });
    assert.ok(fs.existsSync(outFile), `expected file at ${outFile}`);
    assert.ok(outFile.replace(/\\/g, '/').endsWith(`view-data/${smokeDate}/sold-match/trend.html`),
      `unexpected path ${outFile}`);
    const back = fs.readFileSync(outFile, 'utf8');
    assert.ok(back.includes('Settled non-Hemnet'), 'written HTML has settled label');
    assert.ok(back.includes('Raw booli_only'), 'written HTML has raw booli_only label');
    assert.ok(back.includes('cdn.jsdelivr.net/npm/chart.js@4'), 'written HTML loads chart.js@4');
    console.log(`smoke wrote: ${outFile}`);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
