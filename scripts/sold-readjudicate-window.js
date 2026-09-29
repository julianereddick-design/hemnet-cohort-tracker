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
// a row moved OFF booli_only has its schedule cleared. A row moved BACK to booli_only:
// a first-pass row is left for the next batch's enrollment; a reversed LATE match gets its
// original re-check window restored (restoreRecheck), else it would sit in limbo.
//
// Two selections:
//   --window-end D       every <family> row a batch sampled for the window ending D
//   --late-matched-on D  every row the re-check drain late-matched on date D (all families)
//                        — the 2026-09-28 drain matched 248 with no fee and no date window
//
// DRY-RUN BY DEFAULT: everything runs in ONE transaction that is ROLLED BACK (verdicts,
// booli_sold backfill, spend tally). --apply commits it.
//
//   node scripts/sold-readjudicate-window.js --window-end 2026-09-28 [--family APARTMENT] [--apply]
//   node scripts/sold-readjudicate-window.js --late-matched-on 2026-09-28 [--apply]

const fs = require('fs');
const path = require('path');
const { createClient } = require('../db');
const { setSpendClient, procStats, CeilingError } = require('../lib/sold-transport');
const { loadBooliRecord, addDaysISO } = require('../lib/sold-recheck');
const { clearRecheck, restoreRecheck } = require('../lib/sold-store');
const { RECHECK_WINDOW_DAYS, RECHECK_INTERVAL_DAYS } = require('../lib/sold-config');
const { loadPanel, buildSeg } = require('../lib/sold-sample');
const { matchOne } = require('./sold-match-run');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

async function main() {
  const windowEnd = arg('--window-end');
  const lateOn = arg('--late-matched-on');
  const family = arg('--family', 'APARTMENT');
  const apply = process.argv.includes('--apply');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (isDate(windowEnd) === isDate(lateOn)) throw new Error('pass exactly one of --window-end / --late-matched-on YYYY-MM-DD');
  const label = windowEnd ? windowEnd : `late-${lateOn}`;
  const nextRecheckAt = addDaysISO(new Date().toISOString(), RECHECK_INTERVAL_DAYS);

  const log = (lvl, msg) => { if (lvl !== 'FETCH' && lvl !== 'CACHE') console.log(`[${lvl}] ${msg}`); };
  const segments = {};
  for (const muni of loadPanel().munis) {
    for (const fam of ['HOUSE', 'APARTMENT']) segments[`${muni.name}:${fam}`] = buildSeg(muni, fam);
  }

  const client = createClient();
  await client.connect();
  await client.query('BEGIN');
  const changes = [];
  const before = {}, after = {};
  let stoppedBy = null;
  let restored = 0;
  let schedule = null;
  try {
    setSpendClient(client);
    // window dates as TEXT: node-pg would hand back Date objects (the 9a46354 trap).
    const cols = `booli_id, segment, verdict, window_start::text AS ws, window_end::text AS we`;
    const rows = windowEnd
      ? (await client.query(
        `SELECT ${cols} FROM sold_match WHERE window_end::date = $1 AND segment LIKE $2 ORDER BY booli_id`,
        [windowEnd, `%:${family}`])).rows
      : (await client.query(
        `SELECT ${cols} FROM sold_match
          WHERE verdict = 'matched' AND first_unmatched_at IS NOT NULL
            AND adjudicated_at::date = $1 AND window_end::date < $1 ORDER BY booli_id`,
        [lateOn])).rows;
    console.log(`${rows.length} rows (${windowEnd ? `${family}, window ending ${windowEnd}` : `late-matched on ${lateOn}`}) — ${apply ? 'APPLY' : 'DRY RUN (rolled back)'}`);

    for (const row of rows) {
      before[row.verdict] = (before[row.verdict] || 0) + 1;
      const seg = segments[row.segment];
      const record = seg && await loadBooliRecord(client, row.booli_id);
      if (!seg || !record) {
        log('WARN', `skip booli_id=${row.booli_id}: ${!seg ? 'unknown segment ' + row.segment : 'no booli_sold row'}`);
        after[row.verdict] = (after[row.verdict] || 0) + 1;
        continue;
      }
      let v;
      try {
        v = await matchOne(client, record, seg, row.segment, row.ws || null, row.we || null, log);
      } catch (e) {
        if (e instanceof CeilingError) { stoppedBy = 'ceiling'; log('WARN', e.message); break; }
        throw e;
      }
      if (row.verdict === 'booli_only' && v !== 'booli_only') await clearRecheck(client, row.booli_id);
      if (row.verdict !== 'booli_only' && v === 'booli_only') {
        restored += await restoreRecheck(client, row.booli_id, { windowDays: RECHECK_WINDOW_DAYS, nextRecheckAt });
      }
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
    // Post-state of every row moved back to booli_only, read inside the transaction.
    const ids = changes.filter((c) => c.to === 'booli_only').map((c) => c.booli_id);
    if (ids.length) {
      schedule = (await client.query(
        `SELECT count(*)::int reverted,
                count(*) FILTER (WHERE first_unmatched_at IS NULL)::int await_enroll,
                count(*) FILTER (WHERE recheck_until IS NOT NULL AND recheck_until >= now())::int in_window,
                count(*) FILTER (WHERE recheck_until IS NOT NULL AND recheck_until < now())::int will_settle,
                count(*) FILTER (WHERE first_unmatched_at IS NOT NULL AND recheck_until IS NULL)::int limbo
           FROM sold_match WHERE booli_id = ANY($1)`, [ids])).rows[0];
      console.log('reverted-to-booli_only schedule:', schedule, `(restored ${restored})`);
      if (schedule.limbo) throw new Error(`${schedule.limbo} reverted rows left with no schedule — nothing committed`);
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    const moves = {};
    for (const c of changes) moves[`${c.from} → ${c.to}`] = (moves[`${c.from} → ${c.to}`] || 0) + 1;
    console.log('\nbefore:', before, '\nafter: ', after, '\nmoves: ', moves);
    console.log('transport:', procStats());
    const out = path.join(__dirname, '..', `verf-sold-readjudicate-${label}${apply ? '' : '-dryrun'}.json`);
    fs.writeFileSync(out, JSON.stringify({ windowEnd, lateOn, family, apply, before, after, moves, schedule, changes, transport: procStats() }, null, 2));
    console.log(`changes written -> ${out}`);
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
