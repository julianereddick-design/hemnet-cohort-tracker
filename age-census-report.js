'use strict';
// age-census-report.js — monthly Slack pulse for the age-penetration census.
// Reads age_census_run for a run date (+ the most recent GATE-PASSED prior row per pool,
// for deltas) and posts the fresh-end summary. Companion to scripts/age-census-monthly.js,
// which populates the table.
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
//  - Month-on-month deltas print only when a GATE-PASSED prior row exists for that
//    (platform, pool) — a first month must not fabricate a delta, and a gate-failed prior
//    month must never anchor one either (it would make a wrong number look clean). The
//    baseline may therefore be older than one month; its date is named in the delta label.
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

// The denominator every printed share is computed over: the headline histogram's DATED bands.
// This is deliberately NOT n_total. n_total is the whole pool — new-builds and undated listings
// included — whereas the shares run over the headline histogram, which for Hemnet rows is
// 2nd-hand only (2,789 new-builds of 43,338 on Hemnet for-sale, ~6.4%). Printing n_total beside
// those shares made `n × share` wrong by that margin, while the footer claimed the headline was
// 2nd-hand only. The `n` column now prints THIS number, so the column and the shares beside it
// are one universe; the full pool total is carried in the artifact JSON instead.
function headlineTotal(row) {
  const b = headlineBuckets(row) || {};
  return BAND_KEYS.reduce((a, k) => a + (b[k] || 0), 0);
}

function share(row, keys) {
  const b = headlineBuckets(row);
  const dated = headlineTotal(row);
  if (!dated) return null;
  return 100 * keys.reduce((a, k) => a + (b[k] || 0), 0) / dated;
}

function pct(x) { return x == null ? '?' : x.toFixed(1) + '%'; }

// Month-on-month delta in percentage points, on the ≤3mo (fresh-end) share. '' when no
// prior row exists for this (platform, pool) — a first month must not fabricate a delta.
// The baseline's own date is folded into the label because findPrior (below) may reach
// past the immediately preceding month to the last row that actually passed its gates —
// "vs last month" would be a lie if the baseline is really two months back.
function delta(curr, prior, keys) {
  if (!prior) return '';
  const c = share(curr, keys), p = share(prior, keys);
  if (c == null || p == null) return '';
  const d = c - p;
  const vs = prior.run_date ? ` vs ${prior.run_date}` : '';
  return `  (Δ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}pt${vs})`;
}

// Picks the delta baseline for one pool: the most recent PRIOR row whose own gates passed.
// A gate-failed prior month is never a valid baseline — anchoring a delta on a wrong number
// would make the delta itself look clean while silently inheriting the defect. Filtering
// here (not just in the SQL) means renderReport is correct even if it's ever called with an
// unfiltered priorRows array, which is exactly what the smoke tests exercise offline.
function findPrior(priorRows, t) {
  const candidates = priorRows.filter(r => r.platform === t.platform && r.pool === t.pool && r.status === 'ok');
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => (b.run_date || '').localeCompare(a.run_date || ''))[0];
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

    const prior = findPrior(priorRows, t);
    // Every Hemnet row carries the clock caveat; Booli rows never do (Booli's publish
    // clock is sound — see the footer explanation for why Hemnet's is not).
    const clock = t.platform === 'hemnet' ? '  ⚠ clock' : '';
    // Booli's binary-search method cannot exclude new-builds per band, so its headline is
    // all-listings, not 2nd-hand-only. That definitional difference is stated inline.
    const basis = r.buckets_secondhand ? '' : '  incl. new-build';

    L.push(
      `${rpad(t.label, 20)}${lpad(fmtN(headlineTotal(r)), 8)}${lpad(pct(share(r, ['le1m'])), 9)}` +
      `${lpad(pct(share(r, ['le1m', 'm1_3'])), 9)}${lpad(pct(share(r, ['gt24'])), 9)}` +
      `${delta(r, prior, ['le1m', 'm1_3'])}${clock}${basis}`
    );
    // An ok row can still carry a caveat the reader must see — filtered cards, publishedAt
    // anomalies, skipped sub-scopes. Rendering notes only on the GATE FAILED branch meant a
    // run with a KNOWN gap printed as numbers alone. Indented continuation line beneath the row.
    if (r.notes) L.push(`  ↳ ${r.notes}`);
  }

  L.push('```');
  // Operator visibility. ox_calls and error_pages are persisted per pool but were never
  // surfaced, so nothing in Slack distinguished a run that made 400 calls from one that made
  // the expected ~1,208 — a half-scraped pool that still cleared its gates looked identical to
  // a complete one. One compact line, summed across whatever pools are present.
  if (rows.length) {
    const calls = rows.reduce((a, r) => a + (Number(r.ox_calls) || 0), 0);
    const errs = rows.reduce((a, r) => a + (Number(r.error_pages) || 0), 0);
    L.push(`Run: ${calls.toLocaleString('en-US')} proxy calls, ${errs.toLocaleString('en-US')} error page${errs === 1 ? '' : 's'} across ${rows.length} pool${rows.length === 1 ? '' : 's'}.`);
  }
  L.push('n = the headline universe the shares are computed over (dated bands only), NOT the whole pool — full pool totals are in the run artifact JSON.');
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
    // method is fetched by neither renderReport nor the smoke fixtures — dropped as dead.
    const q = `SELECT platform, pool, n_total, buckets, buckets_secondhand, status, notes,
                      ox_calls, error_pages
                 FROM age_census_run WHERE run_date = $1::date`;
    rows = (await client.query(q, [runDate])).rows;
    // status = 'ok' excludes gate-failed rows from ever anchoring a delta. DISTINCT ON still
    // picks one row per (platform, pool) — now the most recent VALID month, which may be
    // older than the immediately preceding one if that month's gates failed. run_date is
    // selected so the delta label can name exactly which month it's comparing against.
    priorRows = (await client.query(
      `SELECT DISTINCT ON (platform, pool) platform, pool,
              to_char(run_date, 'YYYY-MM-DD') AS run_date,
              n_total, buckets, buckets_secondhand, status
         FROM age_census_run WHERE run_date < $1::date AND status = 'ok'
        ORDER BY platform, pool, run_date DESC`, [runDate])).rows;
  } finally {
    await client.end();
  }

  const text = renderReport(runDate, rows, priorRows);
  console.log(text);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `age-census-${runDate}.md`), text);
  // The Slack table's `n` is the headline (dated-band) universe, so the FULL pool total is
  // carried here where it cannot be mistaken for the denominator of the printed shares.
  const poolTotals = rows.map(r => ({
    platform: r.platform, pool: r.pool, status: r.status,
    n_pool_total: r.n_total,                 // whole pool: new-builds + undated included
    n_headline: headlineTotal(r),            // what the printed shares (and the `n` column) use
    ox_calls: r.ox_calls, error_pages: r.error_pages,
  }));
  fs.writeFileSync(path.join(OUT_DIR, `age-census-${runDate}.json`), JSON.stringify({ runDate, rows, priorRows, poolTotals }, null, 2));

  // DRY_RUN=1 is the ONLY reliable guard: dotenv re-injects SLACK_WEBHOOK_URL from .env even
  // if the shell unsets it, so an unset-var trick does not prevent a live post.
  if (process.env.DRY_RUN === '1') { console.log('DRY_RUN=1 — not posting to Slack'); return; }
  if (!process.env.SLACK_WEBHOOK_URL) { console.log('No SLACK_WEBHOOK_URL — not posting'); return; }
  await sendSlack(process.env.SLACK_WEBHOOK_URL, text);
  console.log('Posted to Slack.');
}

module.exports = { renderReport };

function smoke() {
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

  check('the n column is the same universe as the shares beside it, not the whole pool', () => {
    // n_total 43,338 is the whole pool; the headline (2nd-hand, dated) bands sum to 34,713.
    // Printing 43.3k beside shares computed over 34,713 made `n × share` wrong by ~6.4% —
    // exactly the new-build share the footer claimed was already excluded.
    const r = row('hemnet', 'forsale', 43338, 20889, 11224, 2600);
    const headline = 20889 + 11224 + 2600;
    const out = renderReport('2026-09-01', [r], []);
    const line = out.split('\n').find(l => /^Hemnet for-sale/.test(l));
    assert.ok(line.includes('34.7k'), `n must print the headline universe ${headline}, got: ${line}`);
    assert.ok(!line.includes('43.3k'), 'n must not print the whole-pool total beside dated-band shares');
    // n × share must now reconstruct a band: 60.2% of 34,713 ≈ 20,889.
    const le1mPct = 100 * 20889 / headline;
    assert.ok(line.includes(le1mPct.toFixed(1) + '%'), 'the ≤1mo share must be over the same denominator');
    assert.ok(/headline universe/.test(out), 'the footer must say what n is');
    assert.ok(/artifact JSON/.test(out), 'the footer must say where the full pool total lives');
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

  check('an ok row with notes shows them — a known coverage gap must never read as clean', () => {
    const out = renderReport('2026-09-01', [
      row('hemnet', 'forsale', 43338, 20889, 11224, 2600, { notes: '2 sub-scopes skipped: Göteborg/villa' }),
    ], []);
    assert.ok(/sub-scopes skipped/.test(out), 'notes on an ok row must be rendered, not swallowed');
    assert.ok(/Göteborg\/villa/.test(out), 'the detail must survive');
    const lines = out.split('\n');
    const rowIdx = lines.findIndex(l => /^Hemnet for-sale/.test(l));
    assert.ok(rowIdx >= 0, 'the pool row must still render its numbers');
    assert.ok(/sub-scopes skipped/.test(lines[rowIdx + 1]), 'the note must be an indented continuation line directly beneath its row');
    assert.ok(/^\s/.test(lines[rowIdx + 1]), 'the continuation line must be indented');
  });

  check('an ok row with no notes gains no continuation line', () => {
    const out = renderReport('2026-09-01', [row('hemnet', 'forsale', 43338, 20889, 11224, 2600)], []);
    const lines = out.split('\n');
    const rowIdx = lines.findIndex(l => /^Hemnet for-sale/.test(l));
    assert.ok(!/↳/.test(lines[rowIdx + 1] || ''), 'no notes → no empty continuation line');
  });

  check('a gate-failed prior row anchors no delta', () => {
    const curr = [row('booli', 'premarket', 33742, 8155, 7280, 4809)];
    const priorFailedOnly = [
      row('booli', 'premarket', 16000, 8000, 7000, 4700,
        { status: 'gate_failed', notes: 'gates failed: total_drift', run_date: '2026-08-01' }),
    ];
    const out = renderReport('2026-09-01', curr, priorFailedOnly);
    assert.ok(!/Δ/.test(out), 'a gate-failed baseline must not produce a delta');
  });

  check('delta anchors on the older ok row when a newer prior row is gate-failed, and names its date', () => {
    const curr = [row('booli', 'premarket', 33742, 8155, 7280, 4809)];
    const priorMixed = [
      row('booli', 'premarket', 33000, 8000, 7000, 4700, { run_date: '2026-07-01' }),              // older, ok
      row('booli', 'premarket', 16000, 8000, 7000, 4700,
        { status: 'gate_failed', notes: 'gates failed: total_drift', run_date: '2026-08-01' }),     // newer, gate-failed
    ];
    const out = renderReport('2026-09-01', curr, priorMixed);
    assert.ok(/Δ/.test(out), 'must anchor on the older ok row rather than skip the delta entirely');
    assert.ok(/2026-07-01/.test(out), 'the baseline date must be visible so a reader knows what is being compared');
    assert.ok(!/2026-08-01/.test(out), 'must not reference the excluded gate-failed prior date');
  });

  check('the footer surfaces total proxy calls and error pages so a short run is visible', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'premarket', 33742, 8155, 7280, 4809, { ox_calls: 60, error_pages: 0 }),
      row('hemnet', 'forsale', 43338, 20889, 11224, 2600, { ox_calls: 1208, error_pages: 3 }),
    ], []);
    assert.ok(/1,268 proxy calls/.test(out), `calls must be summed across the pools present: ${out}`);
    assert.ok(/3 error pages/.test(out));
    assert.ok(/across 2 pools/.test(out), 'the pool count is what makes a short run legible');
    // missing/null counters must not render NaN
    const partial = renderReport('2026-09-01', [row('booli', 'premarket', 33742, 8155, 7280, 4809)], []);
    assert.ok(!/NaN/.test(partial), 'absent counters must degrade to 0, never NaN');
    assert.ok(/0 proxy calls/.test(partial));
  });

  check('validateArgv accepts --smoke and --dry-run and no args; rejects anything else', () => {
    assert.strictEqual(validateArgv(['--smoke']), true);
    assert.strictEqual(validateArgv(['--dry-run']), true, '--dry-run must be accepted — an operator WILL reach for it');
    assert.strictEqual(validateArgv([]), true, 'no args routes to the live posting path, not a rejection');
    assert.strictEqual(validateArgv(['--dryrun']), false, 'a near-miss must not fall through and POST to Slack');
    assert.strictEqual(validateArgv(['--dry_run']), false);
    assert.strictEqual(validateArgv(['--dry-run=1']), false);
    assert.strictEqual(validateArgv(['--smoketest']), false);
    assert.strictEqual(validateArgv(['--smoke', '--foo']), false, 'an extra unrecognised flag must be rejected');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

// Entry gate. Without this, `node age-census-report.js --dry-run` fell straight through to the
// live path and POSTED TO SLACK: the old dispatch was "anything that isn't --smoke runs main()",
// and DRY_RUN=1 is the only guard that works (dotenv re-injects SLACK_WEBHOOK_URL from .env, so
// unsetting the env var does not prevent a post). --dry-run is therefore accepted AND mapped to
// DRY_RUN=1, and every other argument is rejected. Same pattern as scripts/age-census-monthly.js.
const ACCEPTED_ARGV = new Set(['--smoke', '--dry-run']);
const USAGE = 'Usage: node age-census-report.js [--smoke] [--dry-run]';
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
    main().catch(e => { console.error('Error:', e.message); process.exit(1); });
  }
}
