// market-totals-weekly-report.js
// Phase 11 (v2.2) — Weekly market-supply Slack pulse.
// Reads market_totals for (CURRENT_DATE, CURRENT_DATE - 7 days) × {hemnet, booli}
// × {till_salu, kommande}. Renders two stacked blocks (For Sale + Pre-market) in
// the locked Slack format (D-04) and posts to SLACK_WEBHOOK_URL.
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
