'use strict';

// lib/paid-coverage.js — what share of Booli's new for-sale homes have a PAID Hemnet ad,
// per weekly cohort. Companion to the paid-only H% (team decision 2026-11-04): H% shows
// whether paying sellers still get their views on Hemnet; this shows how many sellers still
// pay. Before Hemnet's free tier (20 Oct 2026) every matched home was paid.
//
// A cohort's Booli homes are its pairs plus cohort_unmatched (cohort-create.js: Booli homes
// newly listed for sale that week in the four tracked counties). Each home falls in one of:
//   paid        matched to a paid Hemnet ad (lib/listing-segment.js segmentOf)
//   free        matched to a free (MINIMAL) Hemnet ad
//   other       matched, package unknown or not a seller ad
//   not matched no Hemnet twin found (not on Hemnet, kommande only, copied agency ad with
//               no postcode, address mismatch), or the pair was removed by the spot-check
// A home with several pairs takes the best: paid > free > other.
//
// Written to view-data/<date>/paid-share.{csv,html} and a line of the weekly view report.
//
//   node lib/paid-coverage.js --smoke          (offline)
//   node lib/paid-coverage.js --live           (read-only: prints the line + table)

const { segmentOf, latestPackageJoin, FREE_TIER_LAUNCH } = require('./listing-segment');

const MIN_COHORT = '2026-W20';                       // same window as the H% charts
const SKIP_COHORTS = ['2026-W09', '2026-W10', '2026-W11'];
const BASELINE_WEEKS = 4;                            // cohorts just before the free tier

const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
const RANK = { paid: 3, free: 2, other: 1 };

// cohorts: [{ cohort_id, week_start, week_end }]
// pairs: [{ cohort_id, booli_id, removed, active_package, hemnet_listed }]
// unmatched: [{ cohort_id, booli_id }]
function computeCoverage({ cohorts, pairs, unmatched }, { from = MIN_COHORT } = {}) {
  const byCohort = new Map();
  for (const c of cohorts) {
    if (c.cohort_id < from || SKIP_COHORTS.includes(c.cohort_id)) continue;
    byCohort.set(c.cohort_id, { ...c, homes: new Map() });   // booli_id -> best class
  }
  const put = (cid, booliId, cls) => {
    const C = byCohort.get(cid);
    if (!C) return;
    const k = String(booliId);
    const cur = C.homes.get(k);
    if (cur === undefined || (RANK[cls] || 0) > (RANK[cur] || 0)) C.homes.set(k, cls);
  };
  for (const u of unmatched) put(u.cohort_id, u.booli_id, 'none');
  for (const p of pairs) {
    if (p.removed) { put(p.cohort_id, p.booli_id, 'none'); continue; }
    const seg = segmentOf(p.active_package, p.hemnet_listed);
    put(p.cohort_id, p.booli_id, seg === 'paid' || seg === 'free' ? seg : 'other');
  }
  return [...byCohort.values()].sort((a, b) => (a.cohort_id < b.cohort_id ? -1 : 1)).map((C) => {
    const n = { paid: 0, free: 0, other: 0, none: 0 };
    for (const cls of C.homes.values()) n[cls]++;
    const total = C.homes.size;
    return {
      cohort_id: C.cohort_id,
      week_start: C.week_start,
      week_end: C.week_end,
      booli_new_homes: total,
      hemnet_paid: n.paid,
      hemnet_free: n.free,
      hemnet_other: n.other,
      not_matched: n.none,
      pct_paid: pct(n.paid, total),
      pct_free: pct(n.free, total),
      pct_not_matched: pct(n.none, total),
    };
  });
}

// Pooled paid share of the BASELINE_WEEKS cohorts that ended before the free tier.
function baseline(rows) {
  const pre = rows.filter(r => r.week_end < FREE_TIER_LAUNCH && r.booli_new_homes > 0).slice(-BASELINE_WEEKS);
  if (!pre.length) return null;
  const paid = pre.reduce((a, r) => a + r.hemnet_paid, 0);
  const all = pre.reduce((a, r) => a + r.booli_new_homes, 0);
  return { pct: pct(paid, all), label: pre.length > 1 ? `${pre[0].cohort_id.slice(5)}–${pre[pre.length - 1].cohort_id.slice(5)}` : pre[0].cohort_id.slice(5) };
}

function slackLine(rows, link) {
  const r = rows[rows.length - 1];
  const title = '*Sellers paying for Hemnet*';
  if (!r || !r.booli_new_homes) return `${title}\nNo cohort to report.`;
  const prev = rows[rows.length - 2];
  const base = baseline(rows);
  const vs = [
    prev && prev.pct_paid !== null ? `prior week ${prev.pct_paid}%` : null,
    base ? `before the free tier ${base.pct}% (${base.label})` : null,
  ].filter(Boolean).join(', ');
  return [
    title,
    `Booli's new homes with a paid Hemnet ad, ${r.cohort_id.slice(5)}: *${r.pct_paid}%*${vs ? ` (${vs})` : ''}. ` +
      `Free Hemnet ad ${r.pct_free}%, not found on Hemnet ${r.pct_not_matched}% (${r.booli_new_homes} homes).`,
    link ? `Chart and table: ${link}` : null,
  ].filter(Boolean).join('\n');
}

const CSV_COLUMNS = ['cohort_id', 'week_start', 'week_end', 'booli_new_homes', 'hemnet_paid', 'hemnet_free',
  'hemnet_other', 'not_matched', 'pct_paid', 'pct_free', 'pct_not_matched'];

function toCsv(rows) {
  const cell = (v) => (v === null || v === undefined ? '' : String(v));
  return [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

function buildHtml(rows, runDate) {
  const labels = JSON.stringify(rows.map(r => r.cohort_id.slice(5)));
  const series = (key) => JSON.stringify(rows.map(r => r[key]));
  const otherPct = JSON.stringify(rows.map(r => pct(r.hemnet_other, r.booli_new_homes)));
  const base = baseline(rows);
  const tableRows = rows.slice().reverse().map(r =>
    `<tr><td>${r.cohort_id}</td><td>${r.week_start}</td><td>${r.booli_new_homes}</td><td><b>${r.pct_paid ?? ''}%</b></td>` +
    `<td>${r.pct_free ?? ''}%</td><td>${r.pct_not_matched ?? ''}%</td><td>${r.hemnet_paid}</td><td>${r.hemnet_free}</td><td>${r.hemnet_other}</td><td>${r.not_matched}</td></tr>`).join('\n');
  return `<!DOCTYPE html>
<html><head>
<title>Sellers paying for Hemnet</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"><\/script>
<style>
body { font-family: Arial, sans-serif; margin: 30px; background: #fff; color: #333; max-width: 1060px; }
.chart-container { width: 1000px; height: 420px; margin-bottom: 30px; }
h1 { font-size: 22px; margin-bottom: 5px; }
.subtitle { color: #666; font-size: 14px; margin-bottom: 30px; }
table { border-collapse: collapse; font-size: 13px; margin-bottom: 30px; }
th, td { padding: 4px 10px; border-bottom: 1px solid #eee; text-align: right; }
th:first-child, td:first-child { text-align: left; }
.notes { margin-top: 20px; padding: 20px 24px; background: #f8f8f8; border-left: 3px solid #1565C0; font-size: 13px; line-height: 1.7; }
.notes ul { margin: 6px 0; padding-left: 20px; }
</style></head><body>
<h1>Share of Booli's new for-sale homes with a paid Hemnet ad</h1>
<div class="subtitle">Generated ${runDate} | weekly cohorts ${rows[0] ? rows[0].cohort_id : ''} to ${rows.length ? rows[rows.length - 1].cohort_id : ''}${base ? ` | before the free tier: ${base.pct}% (${base.label})` : ''}</div>
<div class="chart-container"><canvas id="share"></canvas></div>
<table><tr><th>Cohort</th><th>Week of</th><th>Booli new homes</th><th>Paid Hemnet ad</th><th>Free Hemnet ad</th><th>Not found on Hemnet</th><th>Paid (n)</th><th>Free (n)</th><th>Other (n)</th><th>Not found (n)</th></tr>
${tableRows}
</table>
<div class="notes"><ul>
<li><strong>Homes:</strong> every home newly listed for sale on Booli that week in Stockholm, Västra Götaland, Skåne and Uppsala (the cohort's pairs plus its unmatched homes).</li>
<li><strong>Paid Hemnet ad:</strong> the same home found on Hemnet (same address and postcode, listed within 7 days) with a Basic, Plus, Premium, Max or new-build package. Before Hemnet's free tier (20 Oct 2026) every match was paid.</li>
<li><strong>Free Hemnet ad:</strong> matched to a free (Minimal) ad. <strong>Not found on Hemnet:</strong> no twin found — not on Hemnet, only listed as upcoming, a copied agency ad (no postcode), or an address mismatch — plus pairs the spot-check removed as different homes.</li>
<li>The share moves with the season (summer weeks are lower); compare against the same time of year where possible.</li>
</ul></div>
<script>
new Chart(document.getElementById("share"), {
  type: "bar",
  data: { labels: ${labels}, datasets: [
    { label: "Paid Hemnet ad", data: ${series('pct_paid')}, backgroundColor: "#1565C0" },
    { label: "Free Hemnet ad", data: ${series('pct_free')}, backgroundColor: "#E65100" },
    { label: "Other / package unknown", data: ${otherPct}, backgroundColor: "#90A4AE" },
    { label: "Not found on Hemnet", data: ${series('pct_not_matched')}, backgroundColor: "#E0E0E0" }
  ] },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      title: { display: true, text: "Booli's new for-sale homes by Hemnet ad type, per weekly cohort", font: { size: 16 }, align: "start" },
      legend: { position: "top", align: "start" },
      tooltip: { callbacks: { label: function(c) { return c.dataset.label + ": " + c.parsed.y + "%"; } } }
    },
    scales: {
      x: { stacked: true, grid: { display: false } },
      y: { stacked: true, min: 0, max: 100, grid: { color: "#eee" }, ticks: { callback: function(v) { return v + "%"; } } }
    }
  }
});
<\/script></body></html>`;
}

async function loadInputs(client) {
  const cohorts = (await client.query(
    `SELECT cohort_id, week_start::text AS week_start, week_end::text AS week_end FROM cohorts ORDER BY cohort_id`)).rows;
  const pairs = (await client.query(`
    SELECT cp.cohort_id, cp.booli_id, (cp.removed_at IS NOT NULL) AS removed,
           cp.hemnet_listed::text AS hemnet_listed, pkg.active_package
      FROM cohort_pairs cp ${latestPackageJoin('cp')}`)).rows;
  const unmatched = (await client.query(`SELECT cohort_id, booli_id FROM cohort_unmatched`)).rows;
  return { cohorts, pairs, unmatched };
}

module.exports = { computeCoverage, baseline, slackLine, toCsv, buildHtml, loadInputs, CSV_COLUMNS };

if (require.main === module && process.argv.includes('--live')) {
  require('dotenv').config({ quiet: true });
  const { createClient } = require('../db');
  (async () => {
    const c = createClient();
    await c.connect();
    try {
      const rows = computeCoverage(await loadInputs(c));
      console.log(slackLine(rows));
      console.log('');
      console.table(rows.map(r => ({ cohort: r.cohort_id, homes: r.booli_new_homes, paid: r.pct_paid, free: r.pct_free, other: r.hemnet_other, notFound: r.pct_not_matched })));
    } finally { await c.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  const check = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };
  const cohorts = [
    { cohort_id: '2026-W41', week_start: '2026-10-05', week_end: '2026-10-11' },
    { cohort_id: '2026-W42', week_start: '2026-10-12', week_end: '2026-10-18' },
    { cohort_id: '2026-W43', week_start: '2026-10-19', week_end: '2026-10-25' },
    { cohort_id: '2026-W10', week_start: '2026-03-02', week_end: '2026-03-08' },
  ];
  const pairs = [
    { cohort_id: '2026-W41', booli_id: 1, removed: false, active_package: null, hemnet_listed: '2026-10-06' },
    { cohort_id: '2026-W41', booli_id: 2, removed: true, active_package: 'PREMIUM', hemnet_listed: '2026-10-06' },
    { cohort_id: '2026-W42', booli_id: 3, removed: false, active_package: 'BASIC', hemnet_listed: '2026-10-13' },
    { cohort_id: '2026-W42', booli_id: 4, removed: false, active_package: null, hemnet_listed: '2026-10-21' },
    { cohort_id: '2026-W43', booli_id: 5, removed: false, active_package: 'MINIMAL', hemnet_listed: '2026-10-20' },
    { cohort_id: '2026-W43', booli_id: 5, removed: false, active_package: 'MAX', hemnet_listed: '2026-10-20' },
    { cohort_id: '2026-W43', booli_id: 6, removed: false, active_package: 'MINIMAL', hemnet_listed: '2026-10-21' },
    { cohort_id: '2026-W10', booli_id: 9, removed: false, active_package: null, hemnet_listed: '2026-03-03' },
  ];
  const unmatched = [
    { cohort_id: '2026-W41', booli_id: 10 }, { cohort_id: '2026-W41', booli_id: 11 },
    { cohort_id: '2026-W42', booli_id: 12 },
    { cohort_id: '2026-W43', booli_id: 13 }, { cohort_id: '2026-W43', booli_id: 14 },
  ];
  const rows = computeCoverage({ cohorts, pairs, unmatched }, { from: '2026-W01' });
  const w = (id) => rows.find(r => r.cohort_id === id);
  check('skipped cohorts are left out', () => assert.strictEqual(w('2026-W10'), undefined));
  check('no package before the free tier is paid; a removed pair counts as not matched', () => {
    assert.deepStrictEqual([w('2026-W41').booli_new_homes, w('2026-W41').hemnet_paid, w('2026-W41').not_matched], [4, 1, 3]);
    assert.strictEqual(w('2026-W41').pct_paid, 25);
  });
  check('no package after the free tier is other, not paid', () => {
    assert.deepStrictEqual([w('2026-W42').hemnet_paid, w('2026-W42').hemnet_other, w('2026-W42').not_matched], [1, 1, 1]);
  });
  check('a home with a free and a paid pair counts once, as paid', () => {
    const r = w('2026-W43');
    assert.deepStrictEqual([r.booli_new_homes, r.hemnet_paid, r.hemnet_free, r.not_matched], [4, 1, 1, 2]);
    assert.deepStrictEqual([r.pct_paid, r.pct_free, r.pct_not_matched], [25, 25, 50]);
  });
  check('baseline pools the cohorts that ended before 20 Oct', () => {
    assert.deepStrictEqual(baseline(rows), { pct: 28.6, label: 'W41–W42' });   // 2 of 7
  });
  check('Slack line: latest cohort with prior week and baseline', () => {
    const s = slackLine(rows, 'LINK');
    assert.match(s, /W43: \*25%\* \(prior week 33\.3%, before the free tier 28\.6% \(W41–W42\)\)/);
    assert.match(s, /Free Hemnet ad 25%, not found on Hemnet 50% \(4 homes\)/);
    assert.match(s, /Chart and table: LINK/);
  });
  check('CSV and HTML render', () => {
    const csv = toCsv(rows).trim().split('\n');
    assert.strictEqual(csv[0], CSV_COLUMNS.join(','));
    assert.strictEqual(csv.length, 4);
    assert.match(buildHtml(rows, '2026-11-09'), /Paid Hemnet ad/);
  });
  console.log(`smoke: paid-coverage ${pass} PASS`);
}
