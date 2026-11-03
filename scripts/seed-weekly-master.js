'use strict';
require('dotenv').config();

// scripts/seed-weekly-master.js — one-off loads for hemnet_weekly_new_listings (series 'master').
//
//   --master <csv>      Load the workbook's history (export of MASTER_updated_*.xlsx raw sheets:
//                       week_start,sweden_tot,stockholm_tot,vg_tot,sweden_fs,stockholm_fs,vg_fs).
//                       Never overwrites a week already in the series with a different value
//                       unless --force: the workbook is the record.
//   --estimate <w,w>    Flagged estimates for weeks with no paid-only count (wk 19 + 26 Oct 2026:
//                       Hemnet's public figure counts free + aggregated ads, and our ad registry
//                       started 2 Nov). Method (W.estimateWeeks): Hemnet's monthly paid figure
//                       for the month (statistik/finansiell-rapportering) ÷ its usual ratio to
//                       the workbook (Feb–Sep 2026) gives the month on the workbook's scale; less
//                       the days already in the workbook, spread evenly over the weeks asked for.
//                       Stockholm / VG / for sale by their shares over the 8 weeks before.
//                       The weeks must cover the rest of the month. Marked as estimates everywhere.
//   --dry-run           Print, write nothing.
//
//   node scripts/seed-weekly-master.js --master view-data/master-history.csv --dry-run
//   node scripts/seed-weekly-master.js --estimate 2026-10-19,2026-10-26 --dry-run

const fs = require('fs');
const W = require('../lib/weekly-new-listings');

const NOTE_WORKBOOK = 'Hemnet nytillkomna (workbook)';

function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  const rows = [];
  for (const line of lines) {
    const v = line.split(',');
    const o = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    for (const area of W.AREAS) for (const market of ['tot', 'fs']) {
      const x = o[`${area}_${market}`];
      if (x === '' || x == null) continue;
      if (!/^\d+$/.test(x)) throw new Error(`bad value ${x} for ${o.week_start} ${area}_${market}`);
      rows.push({ week_start: o.week_start, area, market, series: 'master', value: Number(x), note: NOTE_WORKBOOK });
    }
  }
  return rows;
}

const UPSERT = `
  INSERT INTO hemnet_weekly_new_listings (week_start, area, market, series, value, is_estimate, note, updated_at)
  SELECT x.week_start, x.area, x.market, x.series, x.value, COALESCE(x.is_estimate, false), x.note, NOW()
    FROM jsonb_to_recordset($1::jsonb) AS x(week_start DATE, area TEXT, market TEXT, series TEXT, value INTEGER, is_estimate BOOLEAN, note TEXT)
  ON CONFLICT (week_start, area, market, series) DO UPDATE
    SET value = EXCLUDED.value, is_estimate = EXCLUDED.is_estimate, note = EXCLUDED.note, updated_at = NOW()`;

async function loadMaster(client, file, { dryRun, force }) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const weeks = [...new Set(rows.map(r => r.week_start))].sort();
  for (const w of weeks) if (W.mondayOf(w) !== w) throw new Error(`${w} is not a Monday`);
  const ex = await client.query(`SELECT to_char(week_start,'YYYY-MM-DD') w, area, market, value FROM hemnet_weekly_new_listings WHERE series='master'`);
  const have = new Map(ex.rows.map(r => [`${r.w}|${r.area}|${r.market}`, r.value]));
  const conflicts = rows.filter(r => have.has(`${r.week_start}|${r.area}|${r.market}`) && have.get(`${r.week_start}|${r.area}|${r.market}`) !== r.value);
  console.log(`workbook: ${rows.length} values, ${weeks.length} weeks (${weeks[0]} .. ${weeks[weeks.length - 1]}); already in DB ${have.size}; differing ${conflicts.length}`);
  if (conflicts.length && !force) throw new Error(`refusing to overwrite ${conflicts.length} differing values (e.g. ${conflicts.slice(0, 3).map(c => `${c.week_start} ${c.area} ${c.market} ${c.value}`).join('; ')}); use --force`);
  if (!dryRun) for (let i = 0; i < rows.length; i += 2000) await client.query(UPSERT, [JSON.stringify(rows.slice(i, i + 2000))]);
}

async function estimate(client, weeks, { dryRun }) {
  const { getWithRetry } = require('../lib/scrape-http');
  const fin = await getWithRetry(W.FINANCIAL_URL, { logger: () => {} });
  if (fin.status !== 200) throw new Error(`financial page: HTTP ${fin.status}`);
  const financial = W.parseFinancialPage(fin.html);
  for (const week of weeks) if (W.mondayOf(week) !== week) throw new Error(`${week} is not a Monday`);
  const ms = await client.query(
    `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, area, market, value FROM hemnet_weekly_new_listings
      WHERE series = 'master' AND NOT is_estimate AND week_start < $1::date`, [weeks[0]]);
  const series = W.toSeries(ms.rows);
  const month = weeks[0].slice(0, 7);
  const e = W.estimateWeeks({ series, financial, month, weeks });
  console.log(`Hemnet paid ${month}: ${financial.get(month).paid}; usual ratio to the workbook ${e.ratio.toFixed(3)} → month on workbook scale ${Math.round(e.target)}`);
  console.log(`already in the workbook: ${Math.round(e.known)} over ${e.knownDays} days; left ${Math.round(e.target - e.known)} over ${e.missingDays} days = ${e.perDay.toFixed(0)} a day`);
  console.log(`shares (8 weeks before): ${W.AREAS.map(a => `${a} ${(e.shares[a].area * 100).toFixed(1)}% of Sweden, for sale ${(e.shares[a].fs * 100).toFixed(1)}%`).join('; ')}`);
  for (const r of e.rows) console.log(`  ${r.week_start} ${r.area.padEnd(9)} ${r.market}: ${r.value}`);
  const note = `estimate from Hemnet's ${month} paid figure (${financial.get(month).paid}) on the workbook scale`;
  const out = e.rows.map(r => ({ ...r, series: 'master', is_estimate: true, note }));
  if (!dryRun) await client.query(UPSERT, [JSON.stringify(out)]);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run'), force = argv.includes('--force');
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const masterFile = at('--master'), estWeeks = at('--estimate');
  if (!masterFile && !estWeeks) { console.error('Usage: node scripts/seed-weekly-master.js (--master <csv> | --estimate <w,w>) [--dry-run] [--force]'); process.exit(1); }
  process.env.SCRAPE_FORCE_OXYLABS = '1';
  const { createClient } = require('../db');
  const client = createClient();
  await client.connect();
  try {
    if (masterFile) await loadMaster(client, masterFile, { dryRun, force });
    if (estWeeks) await estimate(client, estWeeks.split(','), { dryRun });
    console.log(dryRun ? 'dry run: nothing written' : 'written');
  } finally { await client.end(); }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { parseCsv };
