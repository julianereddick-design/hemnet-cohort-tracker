'use strict';
// age-census-report.js — monthly Slack pulse for the age-penetration census.
// Reads age_census_run for a run date (+ the most recent GATE-PASSED prior row per pool,
// for deltas) and posts a platform-comparison table. Companion to scripts/age-census-monthly.js,
// which populates the table.
//
// Reporting rules (redesigned 2026-08-14, client directive — table purpose flipped from
// "how does each platform's own pool age?" to "which platform has MORE listings, band by
// band?"):
//  - ABSOLUTE COUNTS, not shares. The old percentage table hid the headline finding: Booli
//    leads pre-market by ~2.5-3.6x in every band, but Hemnet carries MORE fresh for-sale
//    listings than Booli and only falls behind on the aged tail. A reader comparing two
//    percentage tables cannot see that; two count tables can.
//  - The first four age columns (≤1mo, ≤3mo, ≤6mo, ≤12mo) are CUMULATIVE — each is the running
//    sum of every band at or below it. >24mo is the lone tail band and is NOT cumulative.
//  - The basis is SECOND-HAND ONLY (buckets_secondhand) for all four pools now that both Booli
//    pools populate it too (sibling change, 2026-08-14). A row whose buckets_secondhand is
//    null (a scraper degraded and withheld it that run) falls back to buckets (all-listings)
//    and is marked "incl. new-build" inline — a mixed-basis table must never look uniform.
//  - `pool` is the total of the basis actually shown (its seven bands + undated), NOT n_total
//    (which also counts new-builds). When a row falls back to all-listings, pool == n_total by
//    construction. n_total − pool (what the second-hand basis excluded) is NOT rendered in the
//    Slack post (client directive, 2026-08-14 fix round) — it still reaches the committed
//    artifact JSON via computePoolTotals()'s `excluded`/`excluded_pct` fields, which is the
//    audit trail for what got removed, without cluttering the post itself.
//  - A Booli/Hemnet ratio line follows each block's rows, one column at a time, 2dp with a
//    "x". "—" where either side is missing, gate-failed, or Hemnet is 0. When the two sides sit
//    on DIFFERENT bases (one second-hand, one fallen back to all-listings) the whole line is
//    replaced with one "mixed basis, not comparable" line — a ratio must never be computed
//    across incompatible universes.
//  - A month-on-month line follows: % change in `pool` and in `≤3mo`, per platform, against the
//    most recent PRIOR row whose own gates passed. Omitted per-platform when no valid prior
//    exists for that platform; omitted entirely when neither platform has one. Never fabricated.
//  - Hemnet's >24mo tail carries a standing caveat. Hemnet refreshes publishedAt on ad-package
//    renewal, so Hemnet age = "days since last package purchase". NEVER headline "Hemnet has
//    fewer zombies" — that is the refresh artifact.
//  - A missing pool is named explicitly ("MISSING"), never silently dropped — a partial month
//    must look partial.
//  - A row whose validation gates failed renders as a GATE FAILED banner with its reason,
//    never as a clean, unflagged number, and contributes nothing to the ratio/momentum lines
//    for its platform.
//
// Cron: 07:00 UTC on the 1st of each month, after the 02:00 measure job.
// Self-test: node age-census-report.js --smoke   (offline, no DB, no Slack)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('./db');
const { BAND_KEYS } = require('./lib/age-census');
const { postMessage } = require('./lib/slack-post');
const { runReporter } = require('./cron-wrapper');

const OUT_DIR = path.join(__dirname, 'verf-flow-probe');
const BLOCKS = [
  { key: 'premarket', title: 'PRE-MARKET' },
  { key: 'forsale', title: 'FOR-SALE' },
];
const PLATFORMS = [
  { platform: 'booli', label: 'Booli' },
  { platform: 'hemnet', label: 'Hemnet' },
];

// Column layout. "Booli / Hemnet" (14 chars) is the widest label, so it sets LABEL_W exactly —
// nothing is truncated and nothing is padded further than it needs to be.
const LABEL_W = 14;
const POOL_W = 10;
const COL_W = 9;
const AGE_COLS = [
  { key: 'le1m', header: '≤1mo' },
  { key: 'le3m', header: '≤3mo' },
  { key: 'le6m', header: '≤6mo' },
  { key: 'le12m', header: '≤12mo' },
  { key: 'gt24', header: '>24mo' },
];

function lpad(s, w) { return (' '.repeat(w) + s).slice(-w); }
function rpad(s, w) { return (s + ' '.repeat(w)).slice(0, w); }
// Full thousands-separated integer — the table's whole purpose is absolute counts, so no
// k-abbreviation (a reader comparing 31,418 to 8,307 must see both figures, not "31.4k"/"8.3k").
function fmtN(n) { return Number(n).toLocaleString('en-US'); }
function pctSigned(x) { return `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}%`; }
function ratioStr(b, h) {
  if (b == null || h == null || !h) return '—';
  return `${(b / h).toFixed(2)}×`;
}

// Headline histogram: 2nd-hand where the platform's method can produce it, all-listings
// otherwise (a scraper that degraded and withheld the split that run).
function headlineBuckets(row) { return row.buckets_secondhand || row.buckets; }

// The four cumulative age columns plus the >24mo tail. Each of le1m..le12m is the running sum
// of every band at or below it; gt24 is the lone non-cumulative band.
function ageValues(b) {
  const le1m = b.le1m || 0;
  const le3m = le1m + (b.m1_3 || 0);
  const le6m = le3m + (b.m3_6 || 0);
  const le12m = le6m + (b.m6_12 || 0);
  const gt24 = b.gt24 || 0;
  return { le1m, le3m, le6m, le12m, gt24 };
}

// `pool` is the total of the basis actually shown: the headline histogram's seven bands plus
// undated. Deliberately NOT n_total, which also counts new-builds — see file-header note.
function poolTotal(b) {
  return BAND_KEYS.reduce((a, k) => a + (b[k] || 0), 0) + (b.undated || 0);
}

// Resolves one (platform, pool) cell to a render-ready shape: missing, gate-failed, or ok with
// its computed pool/ages/fallback flag. Every downstream renderer (row, ratio, momentum)
// consumes this instead of re-deriving status checks, so "gate-failed contributes nothing to
// the ratio line" is enforced in one place.
function cellFor(rows, platform, poolKey) {
  const r = rows.find(x => x.platform === platform && x.pool === poolKey);
  if (!r) return { kind: 'missing' };
  if (r.status !== 'ok') return { kind: 'gate_failed', row: r };
  const fallback = !r.buckets_secondhand;
  const b = headlineBuckets(r);
  return { kind: 'ok', row: r, ages: ageValues(b), pool: poolTotal(b), fallback, nTotal: r.n_total };
}

function renderPlatformRow(label, platform, cell) {
  if (cell.kind === 'missing') return [`${label}: MISSING — no row for this run`];
  if (cell.kind === 'gate_failed') {
    return [`${label}: ⛔ GATE FAILED — ${cell.row.notes || cell.row.status}`];
  }
  const { ages, pool, fallback, row } = cell;
  let line = rpad(label, LABEL_W) + lpad(fmtN(pool), POOL_W);
  for (const c of AGE_COLS) line += lpad(fmtN(ages[c.key]), COL_W);
  const flags = [];
  // Every Hemnet row carries the clock caveat; Booli rows never do (Booli's publish clock is
  // sound — see the footer explanation for why Hemnet's is not).
  if (platform === 'hemnet') flags.push('⚠ clock');
  // A row that fell back to all-listings must never look identical to a 2nd-hand-only one.
  if (fallback) flags.push('incl. new-build');
  if (flags.length) line += '  ' + flags.join('  ');
  const lines = [line];
  // An ok row can still carry a caveat the reader must see — filtered cards, publishedAt
  // anomalies, skipped sub-scopes. Indented continuation line beneath the row.
  if (row.notes) lines.push(`  ↳ ${row.notes}`);
  return lines;
}

// Booli ÷ Hemnet, per column, 2dp. "—" wherever either side is unusable (missing, gate-failed,
// or Hemnet is 0) — a ratio must never be computed against a number the reader cannot see above.
//
// CRITICAL: a ratio is also unusable when the two sides are on DIFFERENT bases — one row
// second-hand, the other fallen back to all-listings. Dividing across that boundary produces a
// clean-looking number (e.g. "2.99×") in a table that exists specifically to compare like with
// like, and on Hemnet for-sale the two bases differ by ~7% — a real distortion, not a rounding
// nicety. Both sides must be 'ok' AND share the same fallback flag before any division happens;
// otherwise the whole row is replaced with one explicit "not comparable" line.
function renderRatioRow(booliCell, hemnetCell) {
  if (booliCell.kind === 'ok' && hemnetCell.kind === 'ok' && booliCell.fallback !== hemnetCell.fallback) {
    return `${rpad('Booli / Hemnet', LABEL_W)}  — mixed basis, not comparable`;
  }
  const b = booliCell.kind === 'ok' ? booliCell.ages : null;
  const h = hemnetCell.kind === 'ok' ? hemnetCell.ages : null;
  let line = rpad('Booli / Hemnet', LABEL_W) + lpad('', POOL_W);
  for (const c of AGE_COLS) line += lpad(ratioStr(b && b[c.key], h && h[c.key]), COL_W);
  return line;
}

// Picks the delta baseline for one (platform, pool): the most recent PRIOR row whose own gates
// passed. A gate-failed prior month is never a valid baseline — anchoring a delta on a wrong
// number would make the delta itself look clean while silently inheriting the defect.
function findPrior(priorRows, platform, poolKey) {
  const candidates = priorRows.filter(r => r.platform === platform && r.pool === poolKey && r.status === 'ok');
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => (b.run_date || '').localeCompare(a.run_date || ''))[0];
}

function pctChange(curr, prior) {
  if (!prior) return null;
  return 100 * (curr - prior) / prior;
}

// One platform's momentum segment: % change in pool and in ≤3mo vs the most recent gate-passed
// prior row. null when the current row is absent/gate-failed or no valid prior exists — a first
// month, or a month whose only prior gate-failed, must not fabricate a delta.
function momentumSegment(rows, priorRows, platform, poolKey) {
  const r = rows.find(x => x.platform === platform && x.pool === poolKey);
  if (!r || r.status !== 'ok') return null;
  const prior = findPrior(priorRows, platform, poolKey);
  if (!prior) return null;
  const currB = headlineBuckets(r), priorB = headlineBuckets(prior);
  if (!currB || !priorB) return null;
  const poolPct = pctChange(poolTotal(currB), poolTotal(priorB));
  const le3moPct = pctChange(ageValues(currB).le3m, ageValues(priorB).le3m);
  if (poolPct == null || le3moPct == null) return null;
  return { date: prior.run_date, text: `pool ${pctSigned(poolPct)}, ≤3mo ${pctSigned(le3moPct)}` };
}

function renderMomentumLine(rows, priorRows, poolKey) {
  const segs = [];
  for (const { platform, label } of PLATFORMS) {
    const m = momentumSegment(rows, priorRows, platform, poolKey);
    if (m) segs.push({ label, ...m });
  }
  if (!segs.length) return null;
  const dates = [...new Set(segs.map(s => s.date))];
  // The common case: both platforms' baselines land on the same date, so one shared "vs <date>:"
  // prefix reads cleanest. When they diverge (one platform's prior gate-failed more recently
  // than the other's), each segment carries its own date so neither is misattributed.
  if (dates.length === 1) {
    return `  vs ${dates[0]}:  ${segs.map(s => `${s.label} ${s.text}`).join('   ·   ')}`;
  }
  return `  ${segs.map(s => `${s.label} vs ${s.date}: ${s.text}`).join('   ·   ')}`;
}

function renderBlock(L, title, rows, priorRows, poolKey) {
  let header = rpad(title, LABEL_W) + lpad('pool', POOL_W);
  for (const c of AGE_COLS) header += lpad(c.header, COL_W);
  L.push(header);

  const cells = {};
  for (const { platform, label } of PLATFORMS) {
    const cell = cellFor(rows, platform, poolKey);
    cells[platform] = cell;
    for (const line of renderPlatformRow(label, platform, cell)) L.push(line);
  }

  L.push(renderRatioRow(cells.booli, cells.hemnet));

  const momentum = renderMomentumLine(rows, priorRows, poolKey);
  if (momentum) L.push(momentum);
}

// A blanket "second-hand only" claim in the caption is false in exactly the months something
// degraded — the fallback flag on the affected row exists, but a reader who only reads the
// first line would never see it. The caption must hedge whenever ANY ok row fell back.
function anyFallback(rows) {
  return rows.some(r => r.status === 'ok' && !r.buckets_secondhand);
}

// Pure and testable — no DB, no network. Renders the whole Slack message body for one run
// date given its rows and the prior month's rows (for deltas).
function renderReport(runDate, rows, priorRows) {
  const L = [];
  const caption = anyFallback(rows)
    ? '(second-hand only, except where a row is flagged incl. new-build)'
    : '(second-hand only; new-builds excluded both platforms)';
  L.push(`Age penetration — ${runDate}        ${caption}`);
  L.push('```');
  renderBlock(L, BLOCKS[0].title, rows, priorRows, BLOCKS[0].key);
  L.push('');
  renderBlock(L, BLOCKS[1].title, rows, priorRows, BLOCKS[1].key);
  L.push('```');
  // Operator visibility. ox_calls and error_pages are persisted per pool but were never
  // surfaced, so nothing in Slack distinguished a run that made 400 calls from one that made
  // the expected ~2,142 — a half-scraped pool that still cleared its gates looked identical to
  // a complete one. One compact line, summed across whatever pools are present.
  if (rows.length) {
    const calls = rows.reduce((a, r) => a + (Number(r.ox_calls) || 0), 0);
    const errs = rows.reduce((a, r) => a + (Number(r.error_pages) || 0), 0);
    L.push(`Run: ${calls.toLocaleString('en-US')} proxy calls, ${errs.toLocaleString('en-US')} error page${errs === 1 ? '' : 's'} across ${rows.length} pool${rows.length === 1 ? '' : 's'}.`);
  }
  L.push('Basis = 2nd-hand only, both platforms, unless a row is flagged "incl. new-build" (that scraper withheld the split this run).');
  L.push('⚠ Hemnet age = days since last ad-package purchase (publishedAt refreshes on renewal), so the Hemnet >24mo tail is not a real clock — read the fresh end, not the tail.');
  return L.join('\n');
}

// The full computed shape per pool — the JSON audit trail for anyone reconstructing what a
// published month actually contained without re-deriving it from raw buckets by hand. This is
// where n_total − pool ("excluded as new-build") lives now that the client asked for it OFF the
// Slack post (2026-08-14 fix round): the post drops the line, but the underlying figure must
// still reach the committed artifact, so it is computed explicitly here rather than only being
// implicitly derivable from n_total and pool_total.
function computePoolTotals(rows) {
  return rows.map(r => {
    const fallback = !r.buckets_secondhand;
    const b = headlineBuckets(r);
    const poolT = b ? poolTotal(b) : null;
    const excluded = (poolT != null && r.n_total != null) ? r.n_total - poolT : null;
    const excludedPct = (excluded != null && r.n_total) ? 100 * excluded / r.n_total : null;
    return {
      platform: r.platform, pool: r.pool, status: r.status, fallback,
      n_total: r.n_total,               // whole pool: new-builds + undated included
      pool_total: poolT,                // basis actually shown (2nd-hand unless fallback)
      excluded, excluded_pct: excludedPct, // n_total − pool_total — NOT rendered in the post
      ages: b ? ageValues(b) : null,
      ox_calls: r.ox_calls, error_pages: r.error_pages,
    };
  });
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
    // selected so the momentum line can name exactly which month it's comparing against.
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
  const poolTotals = computePoolTotals(rows);
  fs.writeFileSync(path.join(OUT_DIR, `age-census-${runDate}.json`), JSON.stringify({ runDate, rows, priorRows, poolTotals }, null, 2));

  // postMessage RETURNS {ok:false} on a failed delivery — it does not throw — so the
  // catch below never sees a transport failure. Branch on result.ok or a lost report
  // is logged as "Posted to Slack." The exit code is the only signal that anything
  // went wrong.
  try {
    const result = await postMessage('age-census-report', text);
    if (result.dryRun) {
      console.log('Dry run — no Slack notification sent');
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

module.exports = { renderReport, computePoolTotals };

function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  // bands: { le1m, m1_3, m3_6, m6_12, m12_18, m18_24, gt24, undated } — any key omitted is 0.
  // secondhand defaults to the SAME bands as buckets (the common case now that both Booli pools
  // populate buckets_secondhand too); pass secondhand: null explicitly to test the fallback path.
  const row = (platform, pool, n, bands, extra = {}) => {
    const buckets = { le1m: 0, m1_3: 0, m3_6: 0, m6_12: 0, m12_18: 0, m18_24: 0, gt24: 0, undated: 0, ...bands };
    const { secondhand, ...rest } = extra;
    return {
      platform, pool, n_total: n, status: 'ok', method: 'muni-partition',
      buckets,
      buckets_secondhand: secondhand === undefined ? { ...buckets } : secondhand,
      ...rest,
    };
  };

  // Fixture pair used across several checks: Booli/Hemnet pre-market, second-hand basis, chosen
  // so `pool` (31,418 / 8,307) and the four cumulative columns match the client-approved example
  // exactly, letting the ratio checks below reuse a known-good shape.
  const booliPM = row('booli', 'premarket', 31603,
    { le1m: 8148, m1_3: 7263, m3_6: 3989, m6_12: 4401, m12_18: 1500, m18_24: 1317, gt24: 4800 });
  const hemnetPM = row('hemnet', 'premarket', 8368,
    { le1m: 3259, m1_3: 1899, m3_6: 677, m6_12: 790, m12_18: 500, m18_24: 408, gt24: 774 });

  check('renders one line per pool, PRE-MARKET block before FOR-SALE', () => {
    const out = renderReport('2026-09-01', [booliPM, hemnetPM], []);
    assert.ok(out.includes('Age penetration — 2026-09-01'));
    assert.ok(/^Booli\s/m.test(out));
    assert.ok(/^Hemnet\s/m.test(out));
    assert.ok(out.indexOf('PRE-MARKET') < out.indexOf('FOR-SALE'));
    assert.ok(out.indexOf('≤1mo') < out.indexOf('>24mo'), 'fresh end must lead');
  });

  check('the header caption states plainly when a row fell back to all-listings, instead of a blanket claim', () => {
    const clean = renderReport('2026-09-01', [booliPM, hemnetPM], []);
    assert.ok(/\(second-hand only; new-builds excluded both platforms\)/.test(clean.split('\n')[0]),
      'a fully second-hand month keeps the confident wording');

    const hemnetFallback = row('hemnet', 'premarket', 8368,
      { le1m: 3259, m1_3: 1899, m3_6: 677, m6_12: 790, m12_18: 500, m18_24: 408, gt24: 774 }, { secondhand: null });
    const degraded = renderReport('2026-09-01', [booliPM, hemnetFallback], []);
    const captionLine = degraded.split('\n')[0];
    assert.ok(/second-hand only, except where a row is flagged incl\. new-build/.test(captionLine),
      `the caption must not claim a blanket fact when a row fell back: ${captionLine}`);
    assert.ok(!/excluded both platforms/.test(captionLine), 'the false blanket wording must not also appear');
  });

  check('table shows ABSOLUTE counts, not percentages — pool prints the raw thousands-separated total', () => {
    const out = renderReport('2026-09-01', [booliPM], []);
    const line = out.split('\n').find(l => /^Booli\s/.test(l));
    assert.ok(line.includes('31,418'), `pool must print the full comma-separated count: ${line}`);
    assert.ok(!/%/.test(line), 'the row itself must carry no percentage — this is a counts table');
  });

  check('the four leading age columns are CUMULATIVE: each equals the running sum of bands at or below it', () => {
    const b = booliPM.buckets_secondhand;
    const expected = {
      le1m: b.le1m,
      le3m: b.le1m + b.m1_3,
      le6m: b.le1m + b.m1_3 + b.m3_6,
      le12m: b.le1m + b.m1_3 + b.m3_6 + b.m6_12,
      gt24: b.gt24, // NOT cumulative — the lone tail band
    };
    assert.deepStrictEqual(expected, { le1m: 8148, le3m: 15411, le6m: 19400, le12m: 23801, gt24: 4800 });
    const out = renderReport('2026-09-01', [booliPM], []);
    const line = out.split('\n').find(l => /^Booli\s/.test(l));
    for (const v of Object.values(expected)) {
      assert.ok(line.includes(v.toLocaleString('en-US')), `line must contain cumulative value ${v}: ${line}`);
    }
  });

  check('`pool` is the basis total (its 7 bands + undated), NOT n_total which also counts new-builds', () => {
    // n_total (31,603) includes ~185 new-builds excluded from the 2nd-hand basis; pool (31,418)
    // must be the smaller, basis-only figure — this is the number multiplied against nothing
    // else in the table, so it must never silently be n_total.
    const b = booliPM.buckets_secondhand;
    const expectedPool = BAND_KEYS.reduce((a, k) => a + b[k], 0) + b.undated;
    assert.strictEqual(expectedPool, 31418);
    const out = renderReport('2026-09-01', [booliPM], []);
    const line = out.split('\n').find(l => /^Booli\s/.test(l));
    assert.ok(line.includes('31,418'), `pool must be the basis total: ${line}`);
    assert.ok(!line.includes('31,603'), 'n_total must never leak into the pool column');
  });

  check('the ratio line is Booli ÷ Hemnet, per column, to 2dp with a "x"', () => {
    const out = renderReport('2026-09-01', [booliPM, hemnetPM], []);
    const line = out.split('\n').find(l => /^Booli \/ Hemnet/.test(l));
    assert.ok(line, 'a ratio row must render');
    const b = booliPM.buckets_secondhand, h = hemnetPM.buckets_secondhand;
    const le1mRatio = (b.le1m / h.le1m).toFixed(2) + '×';
    const gt24Ratio = (b.gt24 / h.gt24).toFixed(2) + '×';
    assert.ok(line.includes(le1mRatio), `≤1mo ratio must be exact division: expected ${le1mRatio} in: ${line}`);
    assert.ok(line.includes(gt24Ratio), `>24mo ratio must be exact division: expected ${gt24Ratio} in: ${line}`);
    // sanity: Booli leads pre-market in every band per the client's finding
    assert.ok(b.le1m / h.le1m > 1 && b.gt24 / h.gt24 > 1, 'fixture must actually encode a Booli lead');
  });

  check('ratio prints "—" when either side is missing, and when Hemnet is 0', () => {
    const missingHemnet = renderReport('2026-09-01', [booliPM], []);
    const l1 = missingHemnet.split('\n').find(l => /^Booli \/ Hemnet/.test(l));
    assert.ok(/—/.test(l1) && !/\d×/.test(l1), `every column must be "—" with no Hemnet row at all: ${l1}`);

    const zeroHemnet = row('hemnet', 'premarket', 100, { le1m: 0, gt24: 0 });
    const out = renderReport('2026-09-01', [booliPM, zeroHemnet], []);
    const l2 = out.split('\n').find(l => /^Booli \/ Hemnet/.test(l));
    assert.ok(l2.includes('—'), `a zero Hemnet denominator must degrade to "—", not Infinity/NaN: ${l2}`);
    assert.ok(!/Infinity|NaN/.test(l2));
  });

  check('CRITICAL: the ratio line is suppressed with a reason when the two platforms sit on DIFFERENT bases', () => {
    // Booli is second-hand (its normal fixture); Hemnet fell back to all-listings this run. A
    // ratio dividing across that boundary would look identical to a real one — this must not
    // silently compute one.
    const hemnetFallback = row('hemnet', 'premarket', 8368,
      { le1m: 3259, m1_3: 1899, m3_6: 677, m6_12: 790, m12_18: 500, m18_24: 408, gt24: 774 }, { secondhand: null });
    const out = renderReport('2026-09-01', [booliPM, hemnetFallback], []);
    const ratioLine = out.split('\n').find(l => /^Booli \/ Hemnet/.test(l));
    assert.ok(ratioLine, 'a ratio row must still render, even suppressed');
    assert.ok(/mixed basis, not comparable/.test(ratioLine), `a mixed-basis pair must state the reason plainly: ${ratioLine}`);
    assert.ok(!/\d\.\d\d×/.test(ratioLine), `no column may print a comparable-looking ratio across different bases: ${ratioLine}`);
    // with the excluded-as-new-build line gone from the post, "incl. new-build" on the row
    // itself is the ONLY remaining in-post signal that this pair is on different bases — it
    // must still render even though the ratio line itself carries no per-column numbers.
    const hemnetLine = out.split('\n').find(l => /^Hemnet\s/.test(l));
    assert.ok(/incl\. new-build/.test(hemnetLine), `the fallback flag must still render on its row in a mixed-basis month: ${hemnetLine}`);
    // control: the SAME pair on the SAME basis (both second-hand) must compute real ratios
    const bothSecondhand = renderReport('2026-09-01', [booliPM, hemnetPM], []);
    const controlLine = bothSecondhand.split('\n').find(l => /^Booli \/ Hemnet/.test(l));
    assert.ok(/\d\.\d\d×/.test(controlLine), `same-basis pair must NOT be suppressed: ${controlLine}`);
  });

  check('a fallback row (buckets_secondhand null) uses all-listings and is flagged inline; pool == n_total', () => {
    const b = row('booli', 'premarket', 20244, { le1m: 8155, m1_3: 7280, gt24: 4809 }, { secondhand: null });
    const out = renderReport('2026-09-01', [b], []);
    const line = out.split('\n').find(l => /^Booli\s/.test(l));
    assert.ok(/incl\. new-build/.test(line), 'the fallback must be flagged on the row itself');
    assert.ok(line.includes('20,244'), 'a fallback pool must equal n_total (all-listings basis)');
  });

  check('the excluded-as-new-build line no longer appears in the Slack post, in any shape (normal, fallback, gate-failed, missing)', () => {
    // 2026-08-14 client directive: the line is off the post entirely. This is a hard regression
    // guard — the audit figure moves to computePoolTotals() (checked below), not to the text.
    const normal = renderReport('2026-09-01', [booliPM, hemnetPM], []);
    assert.ok(!/excluded as new-build/.test(normal), `the line must not render at all: ${normal}`);

    const fb = row('booli', 'premarket', 20244, { le1m: 8155, m1_3: 7280, gt24: 4809 }, { secondhand: null });
    const fallbackOut = renderReport('2026-09-01', [fb], []);
    assert.ok(!/excluded as new-build/.test(fallbackOut), 'a fallback row must not resurrect the line either');

    const gateFailed = row('booli', 'premarket', 16000, {}, { status: 'gate_failed', notes: 'gates failed: total_drift' });
    const missing = renderReport('2026-09-01', [gateFailed], []);
    assert.ok(!/excluded as new-build/.test(missing));
  });

  check('the excluded-as-new-build figure still reaches the JSON audit trail via computePoolTotals, exactly as before', () => {
    // The post lost the line; the underlying arithmetic must not have been lost with it — this
    // is what a human re-derives the removed-from-post figure from.
    const [booliRow] = computePoolTotals([booliPM]);
    const excluded = booliPM.n_total - 31418; // 31,603 − 31,418 = 185
    assert.strictEqual(booliRow.excluded, excluded, `computePoolTotals must still compute n_total − pool: got ${booliRow.excluded}`);
    assert.strictEqual(booliRow.excluded_pct.toFixed(1), (100 * excluded / booliPM.n_total).toFixed(1));
    assert.strictEqual(booliRow.pool_total, 31418);
    assert.strictEqual(booliRow.n_total, 31603);

    // a fallback row's basis IS n_total, so its audit-trail excluded figure is correctly ~0 —
    // not a fabricated split, just "nothing was excluded because nothing could be split out".
    const fb = row('booli', 'premarket', 20244, { le1m: 8155, m1_3: 7280, gt24: 4809 }, { secondhand: null });
    const [fbRow] = computePoolTotals([fb]);
    assert.strictEqual(fbRow.excluded, 0, `a fallback row's excluded figure must be exactly 0: got ${fbRow.excluded}`);
    assert.strictEqual(fbRow.excluded_pct, 0);
    assert.strictEqual(fbRow.fallback, true);
  });

  check('Hemnet rows carry the publishedAt-refresh clock caveat; Booli rows do not', () => {
    const out = renderReport('2026-09-01', [booliPM, hemnetPM], []);
    const hemnetLine = out.split('\n').find(l => /^Hemnet\s/.test(l));
    const booliLine = out.split('\n').find(l => /^Booli\s/.test(l));
    assert.ok(/clock/.test(hemnetLine), 'Hemnet row must be flagged');
    assert.ok(!/clock/.test(booliLine), 'Booli clock is sound — no caveat');
    assert.ok(/publishedAt/.test(out), 'the caveat must be explained once in the footer');
  });

  check('month-on-month line appears only when a prior row exists for that platform, and both its pool AND ≤3mo deltas are exact', () => {
    const priorBooli = row('booli', 'premarket', 30000,
      { le1m: 8000, m1_3: 7100, m3_6: 3900, m6_12: 4300, gt24: 4600 }, { run_date: '2026-08-01' });
    const out = renderReport('2026-09-01', [booliPM], [priorBooli]);
    const mLine = out.split('\n').find(l => /vs 2026-08-01/.test(l));
    assert.ok(mLine, 'a momentum line must render when a valid prior exists');
    const currPool = 31418;
    // recompute prior pool from its own bands the same way the renderer does
    const pb = priorBooli.buckets_secondhand;
    const priorPoolTotal = BAND_KEYS.reduce((a, k) => a + (pb[k] || 0), 0) + (pb.undated || 0);
    const poolPct = 100 * (currPool - priorPoolTotal) / priorPoolTotal;
    assert.ok(mLine.includes(`pool ${pctSigned(poolPct)}`), `expected a pool delta of ${pctSigned(poolPct)}: ${mLine}`);
    // the ≤3mo delta — the check's own name promises this and the old version never asserted it
    const currLe3m = 8148 + 7263; // booliPM's le1m + m1_3
    const priorLe3m = pb.le1m + pb.m1_3;
    const le3moPct = 100 * (currLe3m - priorLe3m) / priorLe3m;
    assert.ok(mLine.includes(`≤3mo ${pctSigned(le3moPct)}`), `expected a ≤3mo delta of ${pctSigned(le3moPct)}: ${mLine}`);
  });

  check('no-prior-month produces no momentum line at all', () => {
    const out = renderReport('2026-09-01', [booliPM, hemnetPM], []);
    assert.ok(!/vs \d{4}-\d{2}-\d{2}/.test(out), 'a first month must not fabricate any delta');
  });

  check('momentum line uses per-platform date labels when the two platforms\' baselines diverge', () => {
    // Booli's most recent ok prior is 2026-08-01; Hemnet's is 2026-07-01 (e.g. because a later
    // Hemnet run gate-failed and was correctly skipped as a baseline). The two dates differ, so
    // the shared "vs <date>:" prefix would misattribute one platform's delta to the wrong month.
    const priorBooli = row('booli', 'premarket', 30000,
      { le1m: 8000, m1_3: 7100, m3_6: 3900, m6_12: 4300, gt24: 4600 }, { run_date: '2026-08-01' });
    const priorHemnet = row('hemnet', 'premarket', 8200,
      { le1m: 3200, m1_3: 1850, m3_6: 650, m6_12: 770, gt24: 760 }, { run_date: '2026-07-01' });
    const out = renderReport('2026-09-01', [booliPM, hemnetPM], [priorBooli, priorHemnet]);
    const mLine = out.split('\n').find(l => /Booli vs 2026-08-01/.test(l));
    assert.ok(mLine, `divergent baselines must render per-platform date labels: ${out}`);
    assert.ok(/Hemnet vs 2026-07-01/.test(mLine), `both platforms' own dates must appear: ${mLine}`);
    assert.ok(!/^  vs \d{4}-\d{2}-\d{2}:/.test(mLine), 'must not use the shared-date prefix when the dates differ');
  });

  check('a missing pool is named explicitly, never silently omitted', () => {
    const out = renderReport('2026-09-01', [booliPM], []);
    assert.ok(/Hemnet: MISSING/.test(out), 'a partial month must be visible');
  });

  check('a gate_failed row is rendered with its failure, not as a clean number, and excluded from the ratio', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'premarket', 16000, { le1m: 8155, m1_3: 7280, gt24: 4809 }, { status: 'gate_failed', notes: 'gates failed: total_drift' }),
      hemnetPM,
    ], []);
    assert.ok(/GATE FAILED/.test(out));
    assert.ok(/total_drift/.test(out));
    const ratioLine = out.split('\n').find(l => /^Booli \/ Hemnet/.test(l));
    assert.ok(!/\d\.\d\d×/.test(ratioLine), `a gate-failed side must never feed the ratio: ${ratioLine}`);
  });

  check('an ok row with notes shows them as an indented continuation line directly beneath its row', () => {
    const out = renderReport('2026-09-01', [
      row('hemnet', 'forsale', 43338, { le1m: 20889, m1_3: 8872, gt24: 2600 }, { notes: '2 sub-scopes skipped: Göteborg/villa' }),
    ], []);
    const lines = out.split('\n');
    const rowIdx = lines.findIndex(l => /^Hemnet\s/.test(l));
    assert.ok(rowIdx >= 0, 'the pool row must still render its numbers');
    assert.ok(/sub-scopes skipped/.test(lines[rowIdx + 1]) && /Göteborg\/villa/.test(lines[rowIdx + 1]),
      'the note must be an indented continuation line directly beneath its row');
    assert.ok(/^\s/.test(lines[rowIdx + 1]));
  });

  check('an ok row with no notes gains no continuation line', () => {
    const out = renderReport('2026-09-01', [hemnetPM], []);
    const lines = out.split('\n');
    const rowIdx = lines.findIndex(l => /^Hemnet\s/.test(l));
    assert.ok(!/↳/.test(lines[rowIdx + 1] || ''), 'no notes → no continuation line');
  });

  check('a gate-failed prior row anchors no momentum, but an older ok prior does and names its date', () => {
    const priorFailedOnly = [
      row('booli', 'premarket', 16000, {}, { status: 'gate_failed', notes: 'gates failed: total_drift', run_date: '2026-08-01' }),
    ];
    const noDelta = renderReport('2026-09-01', [booliPM], priorFailedOnly);
    assert.ok(!/vs \d{4}-\d{2}-\d{2}/.test(noDelta), 'a gate-failed baseline must not produce a delta');

    const priorMixed = [
      row('booli', 'premarket', 30000, { le1m: 8000, m1_3: 7100, m3_6: 3900, m6_12: 4300, gt24: 4600 }, { run_date: '2026-07-01' }),
      row('booli', 'premarket', 16000, {}, { status: 'gate_failed', notes: 'gates failed: total_drift', run_date: '2026-08-01' }),
    ];
    const withOlder = renderReport('2026-09-01', [booliPM], priorMixed);
    assert.ok(/vs 2026-07-01/.test(withOlder), 'must anchor on the older ok row rather than skip the delta entirely');
    assert.ok(!/2026-08-01/.test(withOlder), 'must not reference the excluded gate-failed prior date');
  });

  check('the footer surfaces total proxy calls and error pages so a short run is visible', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'premarket', 31603, { le1m: 8148, gt24: 4800 }, { ox_calls: 110, error_pages: 0 }),
      row('hemnet', 'forsale', 43338, { le1m: 20889, gt24: 2600 }, { ox_calls: 1208, error_pages: 3 }),
    ], []);
    assert.ok(/1,318 proxy calls/.test(out), `calls must be summed across the pools present: ${out}`);
    assert.ok(/3 error pages/.test(out));
    assert.ok(/across 2 pools/.test(out), 'the pool count is what makes a short run legible');
    const partial = renderReport('2026-09-01', [booliPM], []);
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
    runReporter({ scriptName: 'age-census-report', run: main });
  }
}
