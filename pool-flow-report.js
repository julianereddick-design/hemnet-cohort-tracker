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

// ── Pool Table ──────────────────────────────────────────────────
function buildPoolTable(rows) {
  // Index: date -> region -> segment -> {hemnet, booli}
  const data = {};
  const dates = [];
  for (const r of rows) {
    const d = r.snapshot_date.toISOString().slice(0, 10);
    if (!data[d]) { data[d] = {}; dates.push(d); }
    if (!data[d][r.region]) data[d][r.region] = {};
    data[d][r.region][r.segment] = { h: r.hemnet_count, b: r.booli_count };
  }
  dates.sort().reverse(); // most recent first

  const W = 8; // column width
  const header = 'Date   '
    + pad('NatFS/FS', W) + pad('NatFS%', W) + pad('NatTot', W)
    + pad('StkFS/FS', W) + pad('StkFS%', W) + pad('StkTot', W)
    + pad('VG FS/FS', W) + pad('VG FS%', W) + pad('VG Tot', W)
    + pad('BFS/Tot', W);

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
      + pad(pct(natFS.h, natFS.b), W)    // Nat FS/FS
      + pad(pct(natFS.h, natTot.b), W)   // Nat FS%
      + pad(pct(natTot.h, natTot.b), W)  // Nat Tot%
      + pad(pct(stkFS.h, stkFS.b), W)    // Stk FS/FS
      + pad(pct(stkFS.h, stkTot.b), W)   // Stk FS%
      + pad(pct(stkTot.h, stkTot.b), W)  // Stk Tot%
      + pad(pct(vgFS.h, vgFS.b), W)      // VG FS/FS
      + pad(pct(vgFS.h, vgTot.b), W)     // VG FS%
      + pad(pct(vgTot.h, vgTot.b), W)    // VG Tot%
      + pad(pct(natFS.b, natTot.b), W)   // B FS/Tot
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
    + pad('NatFS%', W) + pad('NatPM%', W) + pad('NatTot', W)
    + pad('StkFS%', W) + pad('StkPM%', W) + pad('StkTot', W)
    + pad('VG FS%', W) + pad('VG PM%', W) + pad('VG Tot', W)
    + pad('BPM/Tot', W);

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
      + pad(pct(hStkFS, bStkFS), W)     // Stk FS%
      + pad(pct(hStkPM, bStkPM), W)     // Stk PM%
      + pad(pct(hStkTot, bStkTot), W)   // Stk Tot%
      + pad(pct(hVgFS, bVgFS), W)       // VG FS%
      + pad(pct(hVgPM, bVgPM), W)       // VG PM%
      + pad(pct(hVgTot, bVgTot), W)     // VG Tot%
      + pad(pct(bNatPM, bNatTot), W)    // B PM/Tot
    );
  }
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────
async function main(client, log) {
  const poolRes = await client.query(`
    SELECT snapshot_date, region, segment, hemnet_count, booli_count
    FROM listing_gap_weekly
    WHERE snapshot_date >= CURRENT_DATE - 112
    ORDER BY snapshot_date, region, segment
  `);

  const flowRes = await client.query(`
    SELECT week_start, region, platform, segment, new_listings
    FROM listing_flow_weekly
    WHERE week_start >= CURRENT_DATE - 112
    ORDER BY week_start, region, platform, segment
  `);

  const today = new Date().toISOString().slice(0, 10);
  const poolTable = buildPoolTable(poolRes.rows);
  const flowTable = buildFlowTable(flowRes.rows);

  const message = `*Hemnet vs Booli — Weekly Report (${today})*\n\n`
    + `*Pool* (active listings ≤360d, H as % of B)\n\`\`\`\n${poolTable}\n\`\`\`\n\n`
    + `*Flow* (new listings per week, H as % of B)\n\`\`\`\n${flowTable}\n\`\`\`\n`
    + `_Hemnet PM undercounted (~30% scraper gap)_`;

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
