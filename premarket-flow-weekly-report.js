// premarket-flow-weekly-report.js
// Weekly Slack pulse for pre-market FLOW & staleness (Hemnet vs Booli, second-hand,
// national). Reads premarket_flow_weekly for (CURRENT_DATE, CURRENT_DATE - 7 days) and
// posts the locked comparison block to SLACK_WEBHOOK_URL. Companion to the measurement
// job scripts/premarket-flow-measure.js (which populates the table). Mirrors the
// market-totals-weekly-report.js Slack pattern (sendSlack, REPORT_DATE override, "?" on
// missing prior week — never crashes).
//
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md

require('dotenv').config();
const https = require('https');
const { createClient } = require('./db');

// VERBATIM from market-totals-weekly-report.js:13-34 (reporting-consumer Slack sender).
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

async function run() {
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  console.log(`=== Pre-market flow pulse — ${today} ===\n`);

  const client = createClient();
  let rows;
  try {
    await client.connect();
    const res = await client.query(`
      SELECT platform, to_char(snapshot_date, 'YYYY-MM-DD') AS day,
             stock_secondhand_est, adds_window_secondhand, mean_dwell_days, flow_per_day
      FROM premarket_flow_weekly
      WHERE snapshot_date IN ($1::date, $1::date - INTERVAL '7 days')
      ORDER BY platform, snapshot_date
    `, [today]);
    rows = res.rows;
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
  ];
  const message = '```\n' + bodyLines.join('\n') + '\n```';

  console.log(message);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await sendSlack(webhookUrl, message);
      console.log('\nSlack notification sent');
    } catch (err) {
      console.error(`Slack failed: ${err.message}`);
    }
  } else {
    console.log('\nSkipping Slack (SLACK_WEBHOOK_URL not set)');
  }
}

// Pure helpers exported for offline tests (scripts/test-premarket-report-share.js).
// The run() entrypoint is guarded so a `require` of this module NEVER connects to the DB
// or posts to Slack — importing it used to fire the whole report as a side effect.
module.exports = { addsShare, formatShareRow, ratio, metricRow, wowAdds };

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}
