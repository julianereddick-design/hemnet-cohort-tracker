process.env.SCRAPE_FORCE_OXYLABS = '1';   // sold-transport load guard — MUST precede its require
process.env.SOLD_MATCH_BRIDGE = '1';      // same matcher config as the batch (D-05)
// A separate, small spend key + ceiling: this re-run should be served from the disk cache
// the original batch left behind, so any live call is a cache miss worth seeing, not a budget.
process.env.SOLD_SPEND_KEY = process.env.SOLD_SPEND_KEY || 'sold-readjudicate';
process.env.MAX_OXY_CALLS = process.env.MAX_OXY_CALLS || '200';
require('dotenv').config();

// scripts/sold-readjudicate-window.js — re-run the production matcher (matchOne) over the
// records ONE sold-match batch already sampled, without re-sampling.
//
// WHY: re-running sold-match-batch cannot repair a batch — its sampler de-dupes against
// booli_sold (lib/sold-sample.js), so a second run draws a NEW sample (live spend) and never
// revisits the old one. Written for the 2026-09-28 (W40) batch, whose apartment verdicts
// were made with every Booli fee null (App Router detail break, fixed in 29cfe10).
//
// Records are rebuilt from booli_sold via loadBooliRecord (coerces numeric strings — the
// 2026-08 defect where every compare saw strings). Re-check scheduling mirrors runRecheck:
// a row moved OFF booli_only has its schedule cleared; a row newly booli_only is left for
// the next batch's enrollment.
//
// DRY-RUN BY DEFAULT: everything runs in ONE transaction that is ROLLED BACK (verdicts,
// booli_sold backfill, spend tally). --apply commits it.
//
//   node scripts/sold-readjudicate-window.js --window-end 2026-09-28 [--family APARTMENT] [--apply]

const fs = require('fs');
const path = require('path');
const { createClient } = require('../db');
const { setSpendClient, procStats, CeilingError } = require('../lib/sold-transport');
const { loadBooliRecord } = require('../lib/sold-recheck');
const { clearRecheck } = require('../lib/sold-store');
const { loadPanel, buildSeg } = require('../lib/sold-sample');
const { matchOne } = require('./sold-match-run');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

async function main() {
  const windowEnd = arg('--window-end');
  const family = arg('--family', 'APARTMENT');
  const apply = process.argv.includes('--apply');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(windowEnd || '')) throw new Error('--window-end YYYY-MM-DD required');

  const log = (lvl, msg) => { if (lvl !== 'FETCH' && lvl !== 'CACHE') console.log(`[${lvl}] ${msg}`); };
  const segments = {};
  for (const muni of loadPanel().munis) segments[`${muni.name}:${family}`] = buildSeg(muni, family);

  const client = createClient();
  await client.connect();
  await client.query('BEGIN');
  const changes = [];
  const before = {}, after = {};
  let stoppedBy = null;
  try {
    setSpendClient(client);
    const rows = (await client.query(
      `SELECT booli_id, segment, verdict, evidence FROM sold_match
        WHERE window_end::date = $1 AND segment LIKE $2 ORDER BY booli_id`,
      [windowEnd, `%:${family}`],
    )).rows;
    console.log(`${rows.length} ${family} rows in window ending ${windowEnd} — ${apply ? 'APPLY' : 'DRY RUN (rolled back)'}`);

    for (const row of rows) {
      before[row.verdict] = (before[row.verdict] || 0) + 1;
      const seg = segments[row.segment];
      const record = seg && await loadBooliRecord(client, row.booli_id);
      if (!seg || !record) {
        log('WARN', `skip booli_id=${row.booli_id}: ${!seg ? 'unknown segment ' + row.segment : 'no booli_sold row'}`);
        after[row.verdict] = (after[row.verdict] || 0) + 1;
        continue;
      }
      const ev = row.evidence || {};
      let v;
      try {
        v = await matchOne(client, record, seg, row.segment, ev.window_start || null, ev.window_end || windowEnd, log);
      } catch (e) {
        if (e instanceof CeilingError) { stoppedBy = 'ceiling'; log('WARN', e.message); break; }
        throw e;
      }
      if (row.verdict === 'booli_only' && v !== 'booli_only') await clearRecheck(client, row.booli_id);
      after[v] = (after[v] || 0) + 1;
      if (v !== row.verdict) {
        const nu = (await client.query(`SELECT evidence FROM sold_match WHERE booli_id = $1`, [row.booli_id])).rows[0];
        const ne = (nu && nu.evidence) || {};
        changes.push({
          booli_id: row.booli_id, segment: row.segment, from: row.verdict, to: v,
          booli_rent: ne.fee ? ne.fee.booli_rent : null, hemnet_fee: ne.fee ? ne.fee.hemnet_fee : null,
          reason: ne.reason || ne.source || null,
        });
      }
    }

    if (stoppedBy) throw new Error('stopped by spend ceiling — nothing committed');
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    const moves = {};
    for (const c of changes) moves[`${c.from} → ${c.to}`] = (moves[`${c.from} → ${c.to}`] || 0) + 1;
    console.log('\nbefore:', before, '\nafter: ', after, '\nmoves: ', moves);
    console.log('transport:', procStats());
    const out = path.join(__dirname, '..', `verf-sold-readjudicate-${windowEnd}${apply ? '' : '-dryrun'}.json`);
    fs.writeFileSync(out, JSON.stringify({ windowEnd, family, apply, before, after, moves, changes, transport: procStats() }, null, 2));
    console.log(`changes written -> ${out}`);
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
