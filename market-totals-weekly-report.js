// market-totals-weekly-report.js
// Phase 11 (v2.2) — Weekly market-supply Slack pulse.
// Reads market_totals for (CURRENT_DATE, CURRENT_DATE - 7 days) × {hemnet, booli}
// × {till_salu, kommande}. Renders two stacked blocks (For Sale + Pre-market) in
// the locked Slack format (D-04) and posts via lib/slack-post.js to the business channel.
// Missing prior-week rows render as `?` (D-04); does NOT crash.

require('dotenv').config();
const { createClient } = require('./db');
const { postMessage } = require('./lib/slack-post');
const { runReporter } = require('./cron-wrapper');

function fmtNumber(n) {
  return n.toLocaleString('en-US');
}

// Pad a string to a fixed width on the RIGHT (left-fill with spaces for right-alignment).
function lpad(s, w) { return (' '.repeat(w) + s).slice(-w); }

// Pad a string to a fixed width on the LEFT (right-fill with spaces for left-alignment).
function rpad(s, w) { return (s + ' '.repeat(w)).slice(0, w); }

function renderDeltaPair(curr, prior) {
  // Returns { abs: string, pct: string } with `?` semantics per D-04.
  if (curr == null || prior == null) {
    console.warn(`WARN: missing row — curr=${curr} prior=${prior}; rendering "?" per D-04`);
    return { abs: '?', pct: '?' };
  }
  const absVal = curr - prior;
  const sign = absVal >= 0 ? '+' : '';
  let pctStr;
  if (prior === 0) {
    pctStr = '?';
  } else {
    const pct = (absVal / prior) * 100;
    // Use U+2212 MINUS for negative percent values per D-04.
    const pctSign = absVal >= 0 ? '+' : '−';
    pctStr = `${pctSign}${Math.abs(pct).toFixed(1)}%`;
  }
  // Use U+2212 MINUS for negative absolute deltas per D-04.
  const absSign = absVal >= 0 ? '+' : '−';
  const absStr = `${absSign}${fmtNumber(Math.abs(absVal))}`;
  return { abs: absStr, pct: pctStr };
}

function renderRow(label, prior, curr, withPct) {
  // Format: "<Label>: <right-padded prior> →  <right-padded curr>   (<abs>, <pct>)"
  // or for the gap row: "<Label>: <right-padded prior> →   <right-padded curr>   (<abs>)"
  const labelCol = rpad(label + ':', 16);
  const priorStr = prior == null ? '?' : fmtNumber(prior);
  const currStr  = curr  == null ? '?' : fmtNumber(curr);
  const { abs, pct } = renderDeltaPair(curr, prior);
  const deltaCell = withPct ? `(${abs}, ${pct})` : `(${abs})`;
  return `${labelCol} ${lpad(priorStr, 8)} → ${lpad(currStr, 8)}   ${deltaCell}`;
}

// Render one segment block: a title line + Hemnet / Booli / gap rows.
// `seg` is { hemnet: {prior, curr}, booli: {prior, curr} }.
function renderBlock(title, seg) {
  const gapPrior = (seg.booli.prior != null && seg.hemnet.prior != null)
    ? seg.booli.prior - seg.hemnet.prior : null;
  const gapCurr  = (seg.booli.curr  != null && seg.hemnet.curr  != null)
    ? seg.booli.curr  - seg.hemnet.curr  : null;
  return [
    title,
    renderRow('Hemnet',         seg.hemnet.prior, seg.hemnet.curr, true),
    renderRow('Booli',          seg.booli.prior,  seg.booli.curr,  true),
    renderRow('Booli − Hemnet', gapPrior,         gapCurr,         false),
  ];
}

// Sum two segments cell by cell, for the combined For Sale + Pre-market total.
//
// A missing part propagates as null so the cell renders `?` (D-04) rather than a
// number. This is the whole point of the helper: Booli's pre-market pool is ~4x
// Hemnet's, so a "total" computed from For Sale alone would understate Booli by
// tens of thousands of listings and still look like a plausible figure. A visibly
// absent number is recoverable; a quietly wrong one is not.
function sumSegments(a, b) {
  const add = (x, y) => (x == null || y == null) ? null : x + y;
  return {
    hemnet: {
      prior: add(a.hemnet.prior, b.hemnet.prior),
      curr:  add(a.hemnet.curr,  b.hemnet.curr),
    },
    booli: {
      prior: add(a.booli.prior, b.booli.prior),
      curr:  add(a.booli.curr,  b.booli.curr),
    },
  };
}

async function run() {
  // Report "current" date. Defaults to today; REPORT_DATE=YYYY-MM-DD re-runs a past
  // week (e.g. to backfill a missed pulse or eyeball a prior week's numbers).
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  console.log(`=== Market Supply Pulse — ${today} ===\n`);

  const client = createClient();
  await client.connect();

  let rows;
  try {
    const res = await client.query(`
      SELECT site, segment, to_char(day, 'YYYY-MM-DD') AS day, total
      FROM market_totals
      WHERE segment IN ('till_salu', 'kommande')
        AND day IN ($1::date, $1::date - INTERVAL '7 days')
      ORDER BY segment, site, day
    `, [today]);
    rows = res.rows;
  } finally {
    await client.end();
  }

  // Shape into { <segment>: { hemnet: {prior,curr}, booli: {prior,curr} } }.
  const buckets = {
    till_salu: { hemnet: { prior: null, curr: null }, booli: { prior: null, curr: null } },
    kommande:  { hemnet: { prior: null, curr: null }, booli: { prior: null, curr: null } },
  };
  for (const r of rows) {
    // r.day is already a 'YYYY-MM-DD' string (to_char in SQL) — no JS Date / TZ math.
    const slot = r.day === today ? 'curr' : 'prior';
    if (buckets[r.segment] && buckets[r.segment][r.site]) {
      buckets[r.segment][r.site][slot] = Number(r.total);
    }
  }

  // Warn (don't crash) if any of the 8 expected cells is missing — renders "?" per D-04.
  const missing = [];
  for (const seg of ['till_salu', 'kommande']) {
    for (const site of ['hemnet', 'booli']) {
      for (const slot of ['prior', 'curr']) {
        if (buckets[seg][site][slot] == null) missing.push(`${seg}.${site}.${slot}`);
      }
    }
  }
  if (missing.length) {
    console.warn(
      `WARN: ${missing.length} of 8 expected cells missing [${missing.join(', ')}]. ` +
      `Rendering "?" cells per D-04. If this is the first-ever Phase 11 run, ` +
      `or fewer than 7 days have elapsed since deploy, this is expected.`
    );
  }

  const bodyLines = [
    `Market supply pulse — week of ${today}`,
    '',
    ...renderBlock('Till salu (For Sale)', buckets.till_salu),
    '',
    ...renderBlock('Kommande (Pre-market)', buckets.kommande),
    '',
    ...renderBlock('Total listings (For Sale + Pre-market)',
      sumSegments(buckets.till_salu, buckets.kommande)),
  ];
  const message = '```\n' + bodyLines.join('\n') + '\n```';

  console.log(message);

  // postMessage RETURNS {ok:false} on a failed delivery — it does not throw — so the
  // catch below never sees a transport failure. Branch on result.ok or a lost report
  // is logged as "sent". This script is not wrapped by cron-wrapper.runJob, so the
  // exit code is the only signal that anything went wrong.
  try {
    const result = await postMessage('market-totals-weekly-report', message);
    if (result.dryRun) {
      console.log('\nDry run — no Slack notification sent');
    } else if (result.ok) {
      console.log('\nSlack notification sent');
    } else {
      console.error('\nSlack post failed on both the bot and the webhook fallback');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Slack failed: ${err.message}`);
    process.exitCode = 1;
  }
}

// Entry gate. Without this, an unrecognised flag falls straight through to the
// live path and POSTS: dotenv re-injects the token, so unsetting env vars does
// not prevent a post. Same pattern as age-census-report.js.
const ACCEPTED_ARGV = new Set(['--dry-run', '--smoke']);
const USAGE = 'Usage: node market-totals-weekly-report.js [--dry-run] [--smoke]';

// ---------------------------------------------------------------
//   node market-totals-weekly-report.js --smoke   (offline; no DB, no Slack)
// ---------------------------------------------------------------
function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
  };
  const seg = (hp, hc, bp, bc) => ({ hemnet: { prior: hp, curr: hc }, booli: { prior: bp, curr: bc } });

  check('sums both platforms across both slots', () => {
    const t = sumSegments(seg(45405, 45500, 55827, 56000), seg(7814, 7900, 31901, 32000));
    assert.strictEqual(t.hemnet.prior, 53219);
    assert.strictEqual(t.hemnet.curr, 53400);
    assert.strictEqual(t.booli.prior, 87728);
    assert.strictEqual(t.booli.curr, 88000);
  });

  // The reason this helper exists. Booli's pre-market pool is ~4x Hemnet's, so a
  // total that silently fell back to For Sale alone would understate Booli by tens
  // of thousands and still look like a plausible number.
  check('a missing part makes the TOTAL null, never a partial sum', () => {
    const t = sumSegments(seg(45405, null, 55827, null), seg(7814, null, 31901, null));
    assert.strictEqual(t.hemnet.curr, null, 'must not fall back to the For Sale figure');
    assert.strictEqual(t.booli.curr, null);
    assert.strictEqual(t.hemnet.prior, 53219, 'the complete slot still totals');
  });

  check('a missing pre-market half nulls the total even when For Sale is present', () => {
    const t = sumSegments(seg(45405, 45500, 55827, 56000), seg(null, null, null, null));
    assert.strictEqual(t.hemnet.prior, null);
    assert.strictEqual(t.booli.curr, null);
  });

  check('zero is a real value, not treated as missing', () => {
    const t = sumSegments(seg(0, 0, 0, 0), seg(5, 5, 5, 5));
    assert.strictEqual(t.hemnet.prior, 5);
  });

  check('inputs are not mutated', () => {
    const a = seg(1, 2, 3, 4), b = seg(10, 20, 30, 40);
    sumSegments(a, b);
    assert.deepStrictEqual(a, seg(1, 2, 3, 4));
    assert.deepStrictEqual(b, seg(10, 20, 30, 40));
  });

  check('renderBlock emits a title plus three rows', () => {
    const lines = renderBlock('Total listings (For Sale + Pre-market)', seg(1, 2, 3, 4));
    assert.strictEqual(lines.length, 4);
    assert.strictEqual(lines[0], 'Total listings (For Sale + Pre-market)');
    assert.match(lines[3], /Booli − Hemnet/);
  });

  check('a null cell renders as ? rather than NaN or blank', () => {
    const lines = renderBlock('T', seg(100, null, 200, null));
    assert.ok(lines.some(l => l.includes('?')), 'expected a ? cell');
    assert.ok(!lines.some(l => /NaN|undefined|null/.test(l)), 'no NaN/undefined/null leaked into output');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  }
  if (argv.includes('--smoke')) { smoke(); }
  else {
    if (argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';
    runReporter({ scriptName: 'market-totals-weekly-report', run });
  }
}

module.exports = { sumSegments, renderBlock };
