// market-totals-weekly-report.js
// Phase 11 (v2.2) — Weekly market-supply Slack pulse.
// Reads market_totals for (CURRENT_DATE, CURRENT_DATE - 7 days) × {hemnet, booli} × till_salu.
// Renders the locked Slack format (D-04) and posts to SLACK_WEBHOOK_URL.
// Missing prior-week rows render as `?` (D-04); does NOT crash.

require('dotenv').config();
const https = require('https');
const { createClient } = require('./db');

// VERBATIM from weekly-view-report.js:9-30 — D-04 + PATTERNS.md Pattern A (reporting consumer).
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

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`=== Market Supply Pulse — ${today} ===\n`);

  const client = createClient();
  await client.connect();

  let rows;
  try {
    const res = await client.query(`
      SELECT site, day, total
      FROM market_totals
      WHERE segment = 'till_salu'
        AND day IN (CURRENT_DATE, CURRENT_DATE - INTERVAL '7 days')
      ORDER BY site, day
    `);
    rows = res.rows;
  } finally {
    await client.end();
  }

  // Shape into { hemnet: { prior: null, curr: null }, booli: { prior: null, curr: null } }.
  const buckets = { hemnet: { prior: null, curr: null }, booli: { prior: null, curr: null } };
  for (const r of rows) {
    // pg returns DATE columns as JS Date objects; extract the YYYY-MM-DD string.
    const dayStr = r.day instanceof Date
      ? r.day.toISOString().slice(0, 10)
      : String(r.day).slice(0, 10);
    const isToday = dayStr === today;
    const slot = isToday ? 'curr' : 'prior';
    if (buckets[r.site]) buckets[r.site][slot] = Number(r.total);
  }

  if (buckets.hemnet.prior == null || buckets.hemnet.curr == null ||
      buckets.booli.prior  == null || buckets.booli.curr  == null) {
    console.warn(
      `WARN: at least one of the 4 expected rows is missing. ` +
      `hemnet.prior=${buckets.hemnet.prior} hemnet.curr=${buckets.hemnet.curr} ` +
      `booli.prior=${buckets.booli.prior} booli.curr=${buckets.booli.curr}. ` +
      `Rendering "?" cells per D-04. If this is the first-ever Phase 11 run, ` +
      `or fewer than 7 days have elapsed since deploy, this is expected.`
    );
  }

  // Booli − Hemnet gap (note: U+2212 MINUS in the label per D-04).
  const gapPrior = (buckets.booli.prior != null && buckets.hemnet.prior != null)
    ? buckets.booli.prior - buckets.hemnet.prior : null;
  const gapCurr  = (buckets.booli.curr  != null && buckets.hemnet.curr  != null)
    ? buckets.booli.curr  - buckets.hemnet.curr  : null;

  const bodyLines = [
    `Market supply pulse — Till salu, week of ${today}`,
    renderRow('Hemnet',           buckets.hemnet.prior, buckets.hemnet.curr, true),
    renderRow('Booli',            buckets.booli.prior,  buckets.booli.curr,  true),
    renderRow('Booli − Hemnet', gapPrior,          gapCurr,             false),
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

run().catch(err => {
  console.error(err);
  process.exit(1);
});
