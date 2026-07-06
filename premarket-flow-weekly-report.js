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

  // Hemnet share of combined fresh 2nd-hand adds.
  let shareLine = 'Hemnet share of fresh pre-market adds: ?';
  if (hc && bc && hc.adds != null && bc.adds != null && (hc.adds + bc.adds) > 0) {
    shareLine = `Hemnet share of fresh pre-market adds: ${((hc.adds / (hc.adds + bc.adds)) * 100).toFixed(1)}%`;
  }

  const bodyLines = [
    `Pre-market flow pulse — week of ${today}  (2nd-hand, national)`,
    '',
    `${rpad('', 18)}${lpad('Hemnet', 10)}${lpad('Booli', 12)}${lpad('Booli/Hemnet', 13)}`,
    metricRow('Stock (2nd-hand)', hc && hc.stock, bc && bc.stock, ''),
    metricRow('Adds / week',      hc && hc.adds,  bc && bc.adds,  ''),
    metricRow('Mean dwell',       hc && hc.dwell != null ? hc.dwell : null, bc && bc.dwell != null ? bc.dwell : null, 'd'),
    '',
    shareLine,
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

run().catch(err => { console.error(err); process.exit(1); });
