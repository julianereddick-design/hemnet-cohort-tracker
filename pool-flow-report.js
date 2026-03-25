const { runJob } = require('./cron-wrapper');
const https = require('https');

async function sendSlack(webhookUrl, text) {
  const payload = JSON.stringify({ text });
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

function pct(num, den) {
  if (!den || den === 0) return '-';
  return (num / den * 100).toFixed(1) + '%';
}

function pad(str, len) {
  return String(str).padStart(len);
}

function fmtDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dt = new Date(d);
  return `${months[dt.getMonth()]} ${String(dt.getDate()).padStart(2)}`;
}

// ── Pool helpers ────────────────────────────────────────────────
function parsePoolData(rows) {
  const data = {};
  const dates = [];
  for (const r of rows) {
    const d = r.snapshot_date.toISOString().slice(0, 10);
    if (!data[d]) { data[d] = {}; dates.push(d); }
    if (!data[d][r.region]) data[d][r.region] = {};
    data[d][r.region][r.segment] = { h: r.hemnet_count, b: r.booli_count };
  }
  dates.sort().reverse();
  return { data, dates };
}

function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// ── Pool Raw Numbers Table ──────────────────────────────────────
function buildPoolRawTable(data, dates) {
  const W = 8;
  const header = 'Date   '
    + pad('H FS', W) + pad('B FS', W)
    + pad('H PM', W) + pad('B PM', W)
    + pad('H Tot', W) + pad('B Tot', W);

  const sep = '-'.repeat(header.length);
  const lines = [header, sep];

  for (const d of dates) {
    const get = (region, seg) => (data[d]?.[region]?.[seg]) || { h: 0, b: 0 };
    const natFS = get('National', 'fs');
    const natPM = get('National', 'pm');
    const natTot = get('National', 'total');

    lines.push(
      fmtDate(d).padEnd(7)
      + pad(num(natFS.h), W) + pad(num(natFS.b), W)
      + pad(num(natPM.h), W) + pad(num(natPM.b), W)
      + pad(num(natTot.h), W) + pad(num(natTot.b), W)
    );
  }
  return lines.join('\n');
}

// ── Pool Ratios Table ───────────────────────────────────────────
function buildPoolRatioTable(data, dates) {
  const W = 8;
  const header = 'Date   '
    + pad('NatFS/FS', W) + pad('NatFS%', W) + pad('NatTot', W) + pad('BFS/Tot', W)
    + pad('StkFS/FS', W) + pad('StkFS%', W) + pad('StkTot', W)
    + pad('VG FS/FS', W) + pad('VG FS%', W) + pad('VG Tot', W);

  const sep = '-'.repeat(header.length);
  const lines = [header, sep];

  for (const d of dates) {
    const get = (region, seg) => (data[d]?.[region]?.[seg]) || { h: 0, b: 0 };
    const natFS = get('National', 'fs');
    const natTot = get('National', 'total');
    const stkFS = get('Stockholm', 'fs');
    const stkTot = get('Stockholm', 'total');
    const vgFS = get('VG', 'fs');
    const vgTot = get('VG', 'total');

    lines.push(
      fmtDate(d).padEnd(7)
      + pad(pct(natFS.h, natFS.b), W)
      + pad(pct(natFS.h, natTot.b), W)
      + pad(pct(natTot.h, natTot.b), W)
      + pad(pct(natFS.b, natTot.b), W)
      + pad(pct(stkFS.h, stkFS.b), W)
      + pad(pct(stkFS.h, stkTot.b), W)
      + pad(pct(stkTot.h, stkTot.b), W)
      + pad(pct(vgFS.h, vgFS.b), W)
      + pad(pct(vgFS.h, vgTot.b), W)
      + pad(pct(vgTot.h, vgTot.b), W)
    );
  }
  return lines.join('\n');
}

// ── Flow Table ──────────────────────────────────────────────────
function buildFlowTable(rows) {
  // Index: week -> region -> platform -> segment -> count
  const data = {};
  const weeks = new Set();
  for (const r of rows) {
    const w = r.week_start.toISOString().slice(0, 10);
    weeks.add(w);
    if (!data[w]) data[w] = {};
    if (!data[w][r.region]) data[w][r.region] = {};
    if (!data[w][r.region][r.platform]) data[w][r.region][r.platform] = {};
    data[w][r.region][r.platform][r.segment] = r.new_listings;
  }

  // Sort weeks, exclude current partial week (most recent)
  const sorted = [...weeks].sort();
  // Remove the last week if it's the current week
  const now = new Date();
  const currentWeekStart = new Date(now);
  currentWeekStart.setDate(now.getDate() - now.getDay() + 1); // Monday
  const currentWeekStr = currentWeekStart.toISOString().slice(0, 10);
  const display = sorted.filter(w => w < currentWeekStr).reverse();

  const W = 8;
  const header = 'Week   '
    + pad('NatFS%', W) + pad('NatPM%', W) + pad('NatTot', W) + pad('BPM/Tot', W)
    + pad('StkFS%', W) + pad('StkPM%', W) + pad('StkTot', W)
    + pad('VG FS%', W) + pad('VG PM%', W) + pad('VG Tot', W);

  const sep = '-'.repeat(header.length);

  const lines = [header, sep];
  for (const w of display) {
    const get = (region, platform, seg) => data[w]?.[region]?.[platform]?.[seg] || 0;

    const hNatFS = get('National', 'hemnet', 'fs');
    const hNatPM = get('National', 'hemnet', 'pm');
    const bNatFS = get('National', 'booli', 'fs');
    const bNatPM = get('National', 'booli', 'pm');
    const hNatTot = hNatFS + hNatPM;
    const bNatTot = bNatFS + bNatPM;

    const hStkFS = get('Stockholm', 'hemnet', 'fs');
    const hStkPM = get('Stockholm', 'hemnet', 'pm');
    const bStkFS = get('Stockholm', 'booli', 'fs');
    const bStkPM = get('Stockholm', 'booli', 'pm');
    const hStkTot = hStkFS + hStkPM;
    const bStkTot = bStkFS + bStkPM;

    const hVgFS = get('VG', 'hemnet', 'fs');
    const hVgPM = get('VG', 'hemnet', 'pm');
    const bVgFS = get('VG', 'booli', 'fs');
    const bVgPM = get('VG', 'booli', 'pm');
    const hVgTot = hVgFS + hVgPM;
    const bVgTot = bVgFS + bVgPM;

    lines.push(
      fmtDate(w).padEnd(7)
      + pad(pct(hNatFS, bNatFS), W)     // Nat FS%
      + pad(pct(hNatPM, bNatPM), W)     // Nat PM%
      + pad(pct(hNatTot, bNatTot), W)   // Nat Tot%
      + pad(pct(bNatPM, bNatTot), W)    // B PM/Tot
      + pad(pct(hStkFS, bStkFS), W)     // Stk FS%
      + pad(pct(hStkPM, bStkPM), W)     // Stk PM%
      + pad(pct(hStkTot, bStkTot), W)   // Stk Tot%
      + pad(pct(hVgFS, bVgFS), W)       // VG FS%
      + pad(pct(hVgPM, bVgPM), W)       // VG PM%
      + pad(pct(hVgTot, bVgTot), W)     // VG Tot%
    );
  }
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────
async function main(client, log) {
  // Pool: one row per week — take latest snapshot per ISO week
  const poolRes = await client.query(`
    SELECT snapshot_date, region, segment, hemnet_count, booli_count
    FROM listing_gap_weekly
    WHERE snapshot_date >= CURRENT_DATE - 112
      AND snapshot_date = (
        SELECT MAX(snapshot_date) FROM listing_gap_weekly lgw
        WHERE date_trunc('week', lgw.snapshot_date) = date_trunc('week', listing_gap_weekly.snapshot_date)
      )
    ORDER BY snapshot_date, region, segment
  `);

  // Flow: only from 2026-03-24 onwards (historical data unreliable)
  const flowRes = await client.query(`
    SELECT week_start, region, platform, segment, new_listings
    FROM listing_flow_weekly
    WHERE week_start >= '2026-03-24'
    ORDER BY week_start, region, platform, segment
  `);

  const today = new Date().toISOString().slice(0, 10);
  const { data: poolData, dates: poolDates } = parsePoolData(poolRes.rows);
  const poolRaw = buildPoolRawTable(poolData, poolDates);
  const poolRatios = buildPoolRatioTable(poolData, poolDates);
  const flowTable = buildFlowTable(flowRes.rows);

  const key = 'Nat=National | Stk=Stockholm | VG=Västra Götaland | H=Hemnet | B=Booli\n'
    + '\n'
    + 'Pool:\n'
    + 'NatFS/FS = H ForSale vs B ForSale — for sale market share nationally\n'
    + 'NatFS%   = H ForSale vs B Total — SFPL success converting B PM to FS nationally\n'
    + 'NatTot   = H Total vs B Total\n'
    + 'BFS/Tot  = B ForSale / B Total — H success reducing scope of PM in market\n'
    + '\n'
    + 'Flow:\n'
    + 'NatFS%   = H FS new / B FS new — for sale market share nationally\n'
    + 'NatPM%   = H PM new / B PM new — pre-market market share nationally\n'
    + 'NatTot   = H Tot new / B Tot new — total listings market share nationally\n'
    + 'BPM/Tot  = B PM new / B Tot new — H success reducing PM in market';

  const message = `*Hemnet vs Booli — Weekly Report (${today})*\n\n`
    + `*Pool — Raw Counts* (national, active ≤360d)\n\`\`\`\n${poolRaw}\n\`\`\`\n\n`
    + `*Pool — Ratios*\n\`\`\`\n${poolRatios}\n\`\`\`\n\n`
    + `*Flow* (new listings per week)\n\`\`\`\n${flowTable}\n\`\`\`\n\n`
    + `\`\`\`\n${key}\n\`\`\``;

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    log('WARN', 'SLACK_WEBHOOK_URL not set — printing to stdout instead');
    console.log(message);
  } else {
    await sendSlack(webhookUrl, message);
    log('INFO', 'Weekly report sent to Slack');
  }

  return { poolRows: poolRes.rowCount, flowRows: flowRes.rowCount };
}

runJob({
  scriptName: 'pool-flow-report',
  main,
  validate: (summary) => {
    if (summary.poolRows === 0 && summary.flowRows === 0) {
      return 'No data found in either table';
    }
    return null;
  },
});
