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
//                       started 2 Nov). Method: the ads created that week that are still live
//                       now are in the registry with their packages, so
//                         estimate = Hemnet's published total × (paid ÷ all) among those still live.
//                       Survivors are biased (paid ads sell faster than aggregated ones linger),
//                       so this leans low; it is marked as an estimate everywhere.
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
  const pub = await W.fetchHemnetPublic((url) => getWithRetry(url, { logger: () => {} }));
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const week of weeks) {
    if (W.mondayOf(week) !== week) throw new Error(`${week} is not a Monday`);
    const reg = await W.registryWeek(client, week);
    for (const area of W.AREAS) for (const market of ['tot', 'fs']) {
      const p = pub.find(r => r.week_start === week && r.area === area && r.market === market);
      const all = reg.all[area][market], paid = reg.paid[area][market];
      if (!p || !all) throw new Error(`cannot estimate ${week} ${area} ${market}: Hemnet ${p ? p.value : 'n/a'}, live ads ${all}`);
      const est = Math.round(p.value * paid / all);
      console.log(`${week} ${area.padEnd(9)} ${market}: Hemnet ${String(p.value).padStart(5)}  still live ${String(all).padStart(5)} (${(100 * all / p.value).toFixed(0)}%)  of which paid ${String(paid).padStart(5)} (${(100 * paid / all).toFixed(1)}%)  → estimate ${est}`);
      out.push({ week_start: week, area, market, series: 'master', value: est, is_estimate: true,
        note: `estimate: Hemnet total × paid share of that week's ads still live on ${today}` });
      out.push({ week_start: week, area, market, series: 'hemnet_public', value: p.value, note: 'hemnet.se/statistik/nytillkomna, pre-owned' });
    }
  }
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
