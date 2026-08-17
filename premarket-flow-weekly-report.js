// premarket-flow-weekly-report.js
// Weekly Slack pulse for pre-market FLOW & staleness (Hemnet vs Booli, second-hand,
// national). Reads premarket_flow_weekly for (CURRENT_DATE, CURRENT_DATE - 7 days) and
// posts the locked comparison block via lib/slack-post.js to the business channel. Companion
// to the measurement job scripts/premarket-flow-measure.js (which populates the table). Mirrors
// the market-totals-weekly-report.js pattern (postMessage, REPORT_DATE override, "?" on
// missing prior week — never crashes).
//
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md

require('dotenv').config();
const { createClient } = require('./db');
const { ladderRows } = require('./lib/premarket-quality');
const { postMessage } = require('./lib/slack-post');
const { runReporter } = require('./cron-wrapper');

// How many past snapshots to print in the ratio trend block. 8 ≈ two months of weekly
// readings — enough to see the trend, short enough to keep the Slack message scannable.
const HISTORY_LIMIT = 8;

function fmtNumber(n) { return Number(n).toLocaleString('en-US'); }
function lpad(s, w) { return (' '.repeat(w) + s).slice(-w); }
function rpad(s, w) { return (s + ' '.repeat(w)).slice(0, w); }

// Booli/Hemnet ratio cell (e.g. "4.03×"). "?" if either side missing/zero-Hemnet.
function ratio(booli, hemnet) {
  if (booli == null || hemnet == null || hemnet === 0) return '?';
  return `${(booli / hemnet).toFixed(2)}×`;
}

// A three-column metric row: "Label:  <Hemnet>  <Booli>  <ratio>".
function metricRow(label, hemnet, booli, unit) {
  const h = hemnet == null ? '?' : fmtNumber(hemnet) + (unit || '');
  const b = booli  == null ? '?' : fmtNumber(booli)  + (unit || '');
  return `${rpad(label + ':', 18)}${lpad(h, 10)}${lpad(b, 12)}${lpad(ratio(booli, hemnet), 13)}`;
}

// Hemnet fresh adds as a FRACTION of Booli's — the headline origination-share metric.
// Why this and not the absolute adds: through 2026-07 both platforms' absolute inflow fell
// ~30% (summer), but this ratio held at ~46-49%, i.e. Hemnet was NOT losing share. The
// absolute numbers mislead; the ratio doesn't. Also note Hemnet holds only ~25% of
// pre-market STOCK but ~47% of FLOW — Booli's stock lead is largely stale inventory.
// null when either side is missing or Booli is zero (no meaningful denominator).
function addsShare(hemnetAdds, booliAdds) {
  if (hemnetAdds == null || booliAdds == null || booliAdds <= 0) return null;
  return hemnetAdds / booliAdds;
}

// The Hemnet/Booli adds table row: share as a percent aligned under the ratio column, plus
// a WoW delta in PERCENTAGE POINTS — a share moving 48.7%→46.7% is "−2.1pp", not "−4.2%".
// The delta is computed from UNROUNDED shares, so it can differ by 0.1 from subtracting the
// two displayed percents; precision is preferred since this row is read for share shifts.
function formatShareRow(curr, prior) {
  const pct = curr == null ? '?' : `${(curr * 100).toFixed(1)}%`;
  let suffix = '';
  if (curr != null) {
    if (prior == null) {
      suffix = '  (WoW ?)';
    } else {
      const dpp = (curr - prior) * 100;
      const sign = dpp >= 0 ? '+' : '−';        // U+2212 for negatives (matches wowAdds)
      suffix = `  (${sign}${Math.abs(dpp).toFixed(1)}pp)`;
    }
  }
  // Blank the Hemnet(10) + Booli(12) columns so the value lands under "Booli/Hemnet".
  return `${rpad('Hemnet/Booli adds:', 18)}${' '.repeat(22)}${lpad(pct, 13)}${suffix}`;
}

// Historic trend of the Hemnet/Booli adds ratio, OLDEST → NEWEST. Rows are
// { day, hemnetAdds, booliAdds }. The raw adds are printed beside each share so the ratio
// is auditable at a glance (and so a big swing can be traced to which side moved). A
// partial week — one platform failed that run, cf. the 2026-07-22 Booli outage — renders
// "?" rather than silently vanishing from the series, so gaps stay visible.
function formatShareHistory(rows) {
  if (!rows || rows.length === 0) return ['  (no history yet)'];
  return rows.map((r) => {
    const s = addsShare(r.hemnetAdds, r.booliAdds);
    const pct = s == null ? '?' : `${(s * 100).toFixed(1)}%`;
    const h = r.hemnetAdds == null ? '—' : fmtNumber(r.hemnetAdds);
    const b = r.booliAdds == null ? '—' : fmtNumber(r.booliAdds);
    return `  ${rpad(r.day, 13)}${lpad(pct, 7)}   (${lpad(h, 5)} / ${lpad(b, 5)})`;
  });
}

// Week-over-week delta string for one platform's adds: "prior → curr (+abs, +pct)".
// "?" semantics per market-totals-weekly-report.js:46-67 when prior missing.
function wowAdds(label, prior, curr) {
  if (curr == null) return `${label}: ?`;
  if (prior == null || prior === 0) return `${label}: ${fmtNumber(curr)} (WoW ?)`;
  const abs = curr - prior;
  const sign = abs >= 0 ? '+' : '−';          // U+2212 for negatives (matches sibling report)
  const pct = (abs / prior) * 100;
  return `${label}: ${fmtNumber(prior)} → ${fmtNumber(curr)} (${sign}${fmtNumber(Math.abs(abs))}, ${sign}${Math.abs(pct).toFixed(1)}%)`;
}

// The quality ladder: Booli's weekly cohort by tier, with Hemnet's single total
// expressed against each cumulative rung. The first row carrying a number is the
// parity point — the sub-segment where the two platforms actually compete.
function qualityBlock({ quality, hemnetAdds, flowWindowDays }) {
  if (!quality) {
    return ['', 'Pre-market quality — measurement did not land this week (see cron_job_log).'];
  }

  // Only compare like with like. A window mismatch makes the numerators incomparable.
  const comparable = hemnetAdds != null && flowWindowDays === quality.window_days;
  const counts = {
    n_total: Number(quality.n_total),
    high: Number(quality.n_high), mid_high: Number(quality.n_mid_high),
    mid_sell: Number(quality.n_mid_sell), mid_fish: Number(quality.n_mid_fish),
    other: Number(quality.n_other), low: Number(quality.n_low),
  };
  const rows = ladderRows(counts, comparable ? hemnetAdds : null);

  const out = [
    '',
    `Pre-market quality — Booli cohort of ${fmtNumber(counts.n_total)}`,
    '',
    `${rpad('Booli tier (best first)', 38)}${lpad('this wk', 9)}${lpad('cum n', 8)}${lpad('cum %', 7)}${lpad('Hemnet', 9)}`,
  ];
  for (const r of rows) {
    out.push(
      rpad('  ' + r.label, 38) +
      lpad(fmtNumber(r.n), 9) +
      lpad(fmtNumber(r.cumN), 8) +
      lpad(r.cumPct + '%', 7) +
      lpad(r.hemnetPct == null ? '—' : r.hemnetPct + '%', 9)
    );
  }

  if (!comparable) {
    out.push('');
    out.push(hemnetAdds == null || flowWindowDays == null
      ? 'Hemnet total unavailable this week — ladder shown without the comparison column.'
      : `Not comparable: quality window ${quality.window_days}d vs flow window ${flowWindowDays}d.`);
  }

  out.push('');
  out.push(`Signals: interior ${Math.round(quality.pct_interior)}% · asking price ${Math.round(quality.pct_price)}%` +
    ` · viewing ${Math.round(quality.pct_viewing)}%`);
  out.push(`         Booli AVM shown where a price would be: ${Math.round(quality.pct_avm_shown)}%`);

  if (Number(quality.n_resolved) < Number(quality.n_ambiguous)) {
    out.push(`         Based on ${fmtNumber(quality.n_resolved)} of ${fmtNumber(quality.n_ambiguous)} ambiguous listings opened.`);
  }
  return out;
}

async function run() {
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  console.log(`=== Pre-market flow pulse — ${today} ===\n`);

  const client = createClient();
  let rows;
  let historyRows = [];
  try {
    await client.connect();
    const res = await client.query(`
      SELECT platform, to_char(snapshot_date, 'YYYY-MM-DD') AS day,
             stock_secondhand_est, adds_window_secondhand, mean_dwell_days, flow_per_day,
             window_days
      FROM premarket_flow_weekly
      WHERE snapshot_date IN ($1::date, $1::date - INTERVAL '7 days')
      ORDER BY platform, snapshot_date
    `, [today]);
    rows = res.rows;

    // Historic trend of the headline ratio: one row per snapshot, both platforms pivoted
    // onto the same line so the share is computable per date. Newest N, then reversed to
    // chronological for display. Independent of the (today, today-7) window above, so a
    // missing exact-7-day prior never hides the trend.
    const hist = await client.query(`
      SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS day,
             MAX(adds_window_secondhand) FILTER (WHERE platform = 'hemnet') AS hemnet_adds,
             MAX(adds_window_secondhand) FILTER (WHERE platform = 'booli')  AS booli_adds
      FROM premarket_flow_weekly
      WHERE snapshot_date <= $1::date
      GROUP BY snapshot_date
      ORDER BY snapshot_date DESC
      LIMIT $2
    `, [today, HISTORY_LIMIT]);
    historyRows = hist.rows.map(r => ({
      day: r.day,
      hemnetAdds: r.hemnet_adds == null ? null : Number(r.hemnet_adds),
      booliAdds:  r.booli_adds  == null ? null : Number(r.booli_adds),
    })).reverse(); // oldest → newest
  } finally {
    await client.end();
  }

  // Shape into { <platform>: { curr:{...}|null, prior:{...}|null } }.
  const P = { hemnet: { curr: null, prior: null }, booli: { curr: null, prior: null } };
  for (const r of rows) {
    const slot = r.day === today ? 'curr' : 'prior';
    if (P[r.platform]) {
      P[r.platform][slot] = {
        stock: r.stock_secondhand_est == null ? null : Number(r.stock_secondhand_est),
        adds:  r.adds_window_secondhand == null ? null : Number(r.adds_window_secondhand),
        dwell: r.mean_dwell_days == null ? null : Number(r.mean_dwell_days),
        windowDays: r.window_days == null ? null : Number(r.window_days),
      };
    }
  }

  const hc = P.hemnet.curr, bc = P.booli.curr;
  if (!hc || !bc) {
    console.warn(`WARN: missing current-week row(s) [hemnet=${!!hc} booli=${!!bc}] for ${today}. ` +
      `If the measure job hasn't run yet today, this is expected — rendering "?" cells.`);
  }

  // Headline metric — Hemnet's share of fresh pre-market adds. Promoted from a footnote to
  // a first-class table row (2026-07-23) because it is the number that actually tracks
  // competitive position: absolute adds fell ~30% on BOTH platforms in July while this
  // ratio held ~46-49%. NOT a combined-market share (hemnet/(hemnet+booli)) — the two
  // platforms aren't a partition of one market, so summing them is misleading. This is
  // Hemnet relative to Booli = 1/(Booli/Hemnet ratio).
  const currShare  = addsShare(hc && hc.adds, bc && bc.adds);
  const priorShare = addsShare(
    P.hemnet.prior && P.hemnet.prior.adds,
    P.booli.prior  && P.booli.prior.adds,
  );

  const bodyLines = [
    `Pre-market flow pulse — last 7 days to ${today}  (2nd-hand, national)`,
    '',
    `${rpad('', 18)}${lpad('Hemnet', 10)}${lpad('Booli', 12)}${lpad('Booli/Hemnet', 13)}`,
    metricRow('Stock (2nd-hand)', hc && hc.stock, bc && bc.stock, ''),
    metricRow('Adds (last 7d)',   hc && hc.adds,  bc && bc.adds,  ''),
    formatShareRow(currShare, priorShare),
    metricRow('Mean dwell',       hc && hc.dwell != null ? hc.dwell : null, bc && bc.dwell != null ? bc.dwell : null, 'd'),
    '',
    `WoW adds — ${wowAdds('Hemnet', P.hemnet.prior && P.hemnet.prior.adds, hc && hc.adds)}`,
    `           ${wowAdds('Booli',  P.booli.prior  && P.booli.prior.adds,  bc && bc.adds)}`,
    '',
    `Hemnet/Booli adds — trend (last ${historyRows.length} snapshot${historyRows.length === 1 ? '' : 's'}):`,
    ...formatShareHistory(historyRows),
  ];

  // Quality ladder — read the week's row and join Hemnet's adds from the flow table.
  let qRow = null;
  const qClient = createClient();
  try {
    await qClient.connect();
    const q = await qClient.query(
      `SELECT * FROM premarket_quality_weekly WHERE snapshot_date = $1::date`, [today]);
    qRow = q.rows[0] || null;
  } catch (err) {
    console.error(`Quality block unavailable: ${err.message}`);
  } finally {
    try { await qClient.end(); } catch (_) { /* best effort */ }
  }
  bodyLines.push(...qualityBlock({
    quality: qRow,
    hemnetAdds: hc && hc.adds != null ? hc.adds : null,
    // Hemnet's OWN measurement window — the thing that must match the quality
    // window for the two numerators to be comparable. Never hardcode this.
    flowWindowDays: hc && hc.windowDays != null ? hc.windowDays : null,
  }));

  const message = '```\n' + bodyLines.join('\n') + '\n```';

  console.log(message);

  // postMessage RETURNS {ok:false} on a failed delivery — it does not throw — so the
  // catch below never sees a transport failure. Branch on result.ok or a lost report
  // is logged as "sent". This script is not wrapped by cron-wrapper.runJob, so the
  // exit code is the only signal that anything went wrong.
  try {
    const result = await postMessage('premarket-flow-weekly-report', message);
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

// Pure helpers exported for offline tests (scripts/test-premarket-report-share.js).
// The run() entrypoint is guarded so a `require` of this module NEVER connects to the DB
// or posts to Slack — importing it used to fire the whole report as a side effect.
// qualityBlock joins that set: it is pure (no I/O) and the --smoke cases drive it directly.
module.exports = { addsShare, formatShareRow, formatShareHistory, ratio, metricRow, wowAdds, qualityBlock };

// Entry gate: --smoke runs the offline self-test; --dry-run renders and posts nothing;
// otherwise the report runs for real, posting to a live Slack channel. REPORT_DATE is read
// from the environment, not argv. Without this gate, an unrecognised flag — `--smoketest`,
// `--smoke=true`, `--smok` — would fall straight through to the live path and POST: dotenv
// re-injects the token, so unsetting env vars does not prevent a post. Same pattern as
// age-census-report.js.
const ACCEPTED_ARGV = new Set(['--smoke', '--dry-run']);
const USAGE = 'Usage: node premarket-flow-weekly-report.js [--smoke] [--dry-run]';
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
    if (argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';
    runReporter({ scriptName: 'premarket-flow-weekly-report', run });
  }
}

// --smoke self-test — fully offline (no DB, no network, no Slack post).
function smoke() {
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

  console.log('=== premarket-flow-weekly-report --smoke ===');

  const quality = {
    window_days: 7, n_total: 2264,
    n_high: 340, n_mid_high: 106, n_mid_sell: 758, n_mid_fish: 767, n_other: 145, n_low: 148,
    pct_interior: 87.1, pct_price: 54.3, pct_avm_shown: 39.7, pct_viewing: 21.1,
    n_ambiguous: 537, n_resolved: 537,
  };

  check('renders one row per ladder rung plus header and signals', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 7 });
    assert(out.some(l => /High — interior \+ price \+ viewing/.test(l)), 'missing High row');
    assert(out.some(l => /Low — marketing filler/.test(l)), 'missing Low row');
    assert(out.some(l => /interior 87%/.test(l)), 'missing signals line');
  });
  check('percentages render to 0 decimal places', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 7 }).join('\n');
    assert(!/\d\.\d%/.test(out), `found a decimal percentage in:\n${out}`);
  });
  check('Hemnet cell blank above 100%, present at parity', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 7 });
    const high = out.find(l => /High — interior/.test(l));
    const midSell = out.find(l => /Mid — interior \+ price/.test(l));
    assert(/—\s*$/.test(high), `High row should end with an em dash: "${high}"`);
    assert(/96%\s*$/.test(midSell), `Mid row should end with 96%: "${midSell}"`);
  });
  check('missing quality row degrades to one line', () => {
    const out = qualityBlock({ quality: null, hemnetAdds: 1150, flowWindowDays: 7 });
    assert(out.length === 2, `expected a blank line plus one message, got ${out.length}`);
    assert(/did not land/i.test(out.join(' ')), 'should say the measurement did not land');
  });
  check('missing Hemnet total renders the ladder without the Hemnet column', () => {
    const out = qualityBlock({ quality, hemnetAdds: null, flowWindowDays: 7 }).join('\n');
    assert(/High — interior/.test(out), 'ladder should still render');
    assert(/Hemnet total unavailable/i.test(out), 'should explain the missing column');
  });
  check('missing flow window degrades like a missing total', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: null }).join('\n');
    assert(/Hemnet total unavailable/i.test(out), 'null window must not render "flow window nulld"');
    assert(!/nulld/.test(out), 'must never print a null window length');
  });
  check('mismatched windows refuse the Hemnet column', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 14 }).join('\n');
    assert(/not comparable/i.test(out), 'should state the two measurements are not comparable');
    assert(!/96%/.test(out), 'must not render a Hemnet ratio across mismatched windows');
  });
  check('partial resolution is disclosed', () => {
    const out = qualityBlock({ quality: { ...quality, n_resolved: 500 }, hemnetAdds: 1150, flowWindowDays: 7 }).join('\n');
    assert(/500 of 537/.test(out), 'should disclose the resolution shortfall');
  });

  check('validateArgv accepts --smoke, --dry-run, and no args; rejects any typo or variant', () => {
    assert(validateArgv(['--smoke']) === true, '--smoke must be accepted');
    assert(validateArgv(['--dry-run']) === true, '--dry-run must be accepted — an operator WILL reach for it');
    assert(validateArgv([]) === true, 'no args must be accepted (routes to the live-post path, not rejected)');
    assert(validateArgv(['--smoketest']) === false, '--smoketest must be rejected — it must not launch a live Slack post');
    assert(validateArgv(['--smoke=true']) === false, '--smoke=true must be rejected');
    assert(validateArgv(['--smok']) === false, '--smok must be rejected');
    assert(validateArgv(['--smoke', '--foo']) === false, 'an extra unrecognised flag must be rejected');
  });

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
