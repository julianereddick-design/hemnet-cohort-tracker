'use strict';
// age-census-report.js — monthly Slack pulse for the age-penetration census.
// Reads age_census_run for a run date (+ the prior month for deltas) and posts the fresh-end
// summary. Companion to scripts/age-census-monthly.js, which populates the table.
//
// Reporting rules (spec §7, from Julian 2026-07-09):
//  - Lead with the FRESH end (≤1mo, ≤3mo) and absolute counts. Share and absolute tell
//    opposite stories: Hemnet looks fresher by share while Booli's pre-market pool is ~4×
//    bigger. Both appear.
//  - Hemnet's >24mo tail carries a standing caveat. Hemnet refreshes publishedAt on ad-package
//    renewal, so Hemnet age = "days since last package purchase". NEVER headline "Hemnet has
//    fewer zombies" — that is the refresh artifact.
//  - Hemnet headline = 2nd-hand only; Booli = all listings (binary-search cannot exclude
//    new-builds per band). At Booli's ~0.2-0.7% new-build share this is below noise, but it
//    is a definitional difference and is stated, not hidden.
//  - A missing pool is named explicitly ("MISSING"), never silently dropped — a partial month
//    must look partial.
//  - A row whose validation gates failed renders as a GATE FAILED banner with its reason,
//    never as a clean, unflagged number.
//  - Month-on-month deltas print only when a prior row exists for that (platform, pool) — a
//    first month must not fabricate a delta.
//
// Cron: 07:00 UTC on the 1st of each month, after the 02:00 measure job.
// Self-test: node age-census-report.js --smoke   (offline, no DB, no Slack)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createClient } = require('./db');
const { BAND_KEYS } = require('./lib/age-census');

const OUT_DIR = path.join(__dirname, 'verf-flow-probe');
const POOL_LABELS = [
  { platform: 'booli', pool: 'premarket', label: 'Booli pre-market' },
  { platform: 'hemnet', pool: 'premarket', label: 'Hemnet pre-market' },
  { platform: 'booli', pool: 'forsale', label: 'Booli for-sale' },
  { platform: 'hemnet', pool: 'forsale', label: 'Hemnet for-sale' },
];

// VERBATIM from premarket-flow-weekly-report.js:16-38 (itself verbatim from
// market-totals-weekly-report.js:13-34 — the shared reporting-consumer Slack sender).
async function sendSlack(webhookUrl, message) {
  const payload = JSON.stringify({ text: message });
  const parsed = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Slack ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Slack timeout')); });
    req.write(payload);
    req.end();
  });
}

function lpad(s, w) { return (' '.repeat(w) + s).slice(-w); }
function rpad(s, w) { return (s + ' '.repeat(w)).slice(0, w); }
function fmtN(n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : Number(n).toLocaleString('en-US'); }

// Headline histogram: 2nd-hand where the method can produce it (Hemnet muni-partition),
// all-listings otherwise (Booli binary-search, which cannot resolve new-builds per band).
function headlineBuckets(row) { return row.buckets_secondhand || row.buckets; }

function share(row, keys) {
  const b = headlineBuckets(row);
  const dated = BAND_KEYS.reduce((a, k) => a + (b[k] || 0), 0);
  if (!dated) return null;
  return 100 * keys.reduce((a, k) => a + (b[k] || 0), 0) / dated;
}

function pct(x) { return x == null ? '?' : x.toFixed(1) + '%'; }

// Month-on-month delta in percentage points, on the ≤3mo (fresh-end) share. '' when no
// prior row exists for this (platform, pool) — a first month must not fabricate a delta.
function delta(curr, prior, keys) {
  if (!prior) return '';
  const c = share(curr, keys), p = share(prior, keys);
  if (c == null || p == null) return '';
  const d = c - p;
  return `  (Δ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}pt)`;
}

// Pure and testable — no DB, no network. Renders the whole Slack message body for one run
// date given its rows and the prior month's rows (for deltas).
function renderReport(runDate, rows, priorRows) {
  const find = (list, t) => list.find(r => r.platform === t.platform && r.pool === t.pool);
  const L = [];
  L.push(`Age penetration — ${runDate}`);
  L.push('```');
  L.push(`${rpad('', 20)}${lpad('n', 8)}${lpad('≤1mo', 9)}${lpad('≤3mo', 9)}${lpad('>24mo', 9)}`);

  for (const t of POOL_LABELS) {
    const r = find(rows, t);
    if (!r) {
      // A missing pool is named explicitly, never silently omitted from the table.
      L.push(`${t.label}: MISSING — no row for this run`);
      continue;
    }
    if (r.status !== 'ok') {
      // A gate-failed row renders ONLY the failure banner — never alongside a number that
      // would read as validated. The reason (e.g. "total_drift") must be visible.
      L.push(`${t.label}: ⛔ GATE FAILED — ${r.notes || r.status}`);
      continue;
    }

    const prior = find(priorRows, t);
    // Every Hemnet row carries the clock caveat; Booli rows never do (Booli's publish
    // clock is sound — see the footer explanation for why Hemnet's is not).
    const clock = t.platform === 'hemnet' ? '  ⚠ clock' : '';
    // Booli's binary-search method cannot exclude new-builds per band, so its headline is
    // all-listings, not 2nd-hand-only. That definitional difference is stated inline.
    const basis = r.buckets_secondhand ? '' : '  incl. new-build';

    L.push(
      `${rpad(t.label, 20)}${lpad(fmtN(r.n_total), 8)}${lpad(pct(share(r, ['le1m'])), 9)}` +
      `${lpad(pct(share(r, ['le1m', 'm1_3'])), 9)}${lpad(pct(share(r, ['gt24'])), 9)}` +
      `${delta(r, prior, ['le1m', 'm1_3'])}${clock}${basis}`
    );
  }

  L.push('```');
  L.push('Hemnet headline = 2nd-hand only; Booli = all listings (binary-search cannot exclude new-builds per band).');
  L.push('⚠ Hemnet age = days since last ad-package purchase (publishedAt refreshes on renewal), so the Hemnet >24mo tail is not a real clock — read the fresh end, not the tail.');
  return L.join('\n');
}

async function main() {
  const runDate = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  const client = createClient();
  let rows = [], priorRows = [];
  try {
    await client.connect();
    const q = `SELECT platform, pool, method, n_total, buckets, buckets_secondhand, status, notes
                 FROM age_census_run WHERE run_date = $1::date`;
    rows = (await client.query(q, [runDate])).rows;
    priorRows = (await client.query(
      `SELECT DISTINCT ON (platform, pool) platform, pool, n_total, buckets, buckets_secondhand, status
         FROM age_census_run WHERE run_date < $1::date
        ORDER BY platform, pool, run_date DESC`, [runDate])).rows;
  } finally {
    await client.end();
  }

  const text = renderReport(runDate, rows, priorRows);
  console.log(text);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `age-census-${runDate}.md`), text);
  fs.writeFileSync(path.join(OUT_DIR, `age-census-${runDate}.json`), JSON.stringify({ runDate, rows, priorRows }, null, 2));

  // DRY_RUN=1 is the ONLY reliable guard: dotenv re-injects SLACK_WEBHOOK_URL from .env even
  // if the shell unsets it, so an unset-var trick does not prevent a live post.
  if (process.env.DRY_RUN === '1') { console.log('DRY_RUN=1 — not posting to Slack'); return; }
  if (!process.env.SLACK_WEBHOOK_URL) { console.log('No SLACK_WEBHOOK_URL — not posting'); return; }
  await sendSlack(process.env.SLACK_WEBHOOK_URL, text);
  console.log('Posted to Slack.');
}

module.exports = { renderReport };

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  const row = (platform, pool, n, le1m, m1_3, gt24, extra = {}) => ({
    platform, pool, n_total: n, status: 'ok', method: 'muni-partition',
    buckets: { le1m, m1_3, m3_6: 0, m6_12: 0, m12_18: 0, m18_24: 0, gt24, undated: 0 },
    buckets_secondhand: { le1m, m1_3, m3_6: 0, m6_12: 0, m12_18: 0, m18_24: 0, gt24, undated: 0 },
    ...extra,
  });

  check('renders one line per pool, fresh-end first', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'premarket', 33742, 8155, 7280, 4809),
      row('hemnet', 'premarket', 8368, 3272, 1908, 778),
    ], []);
    assert.ok(out.includes('Age penetration — 2026-09-01'));
    assert.ok(/Booli pre-market/.test(out));
    assert.ok(/Hemnet pre-market/.test(out));
    assert.ok(out.indexOf('≤1mo') < out.indexOf('>24mo'), 'fresh end must lead');
  });

  check('Hemnet rows carry the publishedAt-refresh clock caveat; Booli rows do not', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'forsale', 52349, 9684, 16751, 3246),
      row('hemnet', 'forsale', 43338, 20889, 11224, 2600),
    ], []);
    const hemnetLine = out.split('\n').find(l => /Hemnet for-sale/.test(l));
    const booliLine = out.split('\n').find(l => /Booli for-sale/.test(l));
    assert.ok(/clock/.test(hemnetLine), 'Hemnet tail must be flagged');
    assert.ok(!/clock/.test(booliLine), 'Booli clock is sound — no caveat');
    assert.ok(/publishedAt/.test(out), 'the caveat must be explained once in the footer');
  });

  check('month-on-month delta appears only when a prior row exists', () => {
    const curr = [row('booli', 'premarket', 33742, 8155, 7280, 4809)];
    const noPrior = renderReport('2026-09-01', curr, []);
    assert.ok(!/Δ/.test(noPrior), 'first month must not fake a delta');
    const withPrior = renderReport('2026-09-01', curr, [row('booli', 'premarket', 33000, 8000, 7000, 4700)]);
    assert.ok(/Δ/.test(withPrior));
  });

  check('a missing pool is named explicitly, never silently omitted', () => {
    const out = renderReport('2026-09-01', [row('booli', 'premarket', 33742, 8155, 7280, 4809)], []);
    assert.ok(/Hemnet for-sale: MISSING/.test(out), 'a partial month must be visible');
  });

  check('a gate_failed row is rendered with its failure, not as a clean number', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'premarket', 16000, 8155, 7280, 4809, { status: 'gate_failed', notes: 'gates failed: total_drift' }),
    ], []);
    assert.ok(/GATE FAILED/.test(out));
    assert.ok(/total_drift/.test(out));
  });

  check('Booli rows report the all-listings tally, Hemnet the 2nd-hand one', () => {
    const b = row('booli', 'premarket', 1000, 500, 300, 100);
    b.buckets_secondhand = null;                      // binary-search: not available
    const out = renderReport('2026-09-01', [b], []);
    assert.ok(/incl\. new-build/.test(out), 'the definitional difference must be stated');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

if (require.main === module && !process.argv.includes('--smoke')) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
