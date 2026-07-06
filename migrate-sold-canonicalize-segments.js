'use strict';
// migrate-sold-canonicalize-segments.js — one-off data migration.
// Run manually: node migrate-sold-canonicalize-segments.js
//
// WHY: the sold-match `segment` key scheme drifted across historical runs, leaving
// orphaned rows under DEAD keys that no current run ever produces:
//   - pilot scheme        : 'kungalv-apt', 'kungalv-villa'
//   - umlaut-stripped      : 'Kungalv:APARTMENT', 'Taby:APARTMENT'
//   - current (canonical)  : '<Muni.name>:<FAMILY>'  e.g. 'Kungälv:APARTMENT'
//
// The re-check drain (sold-match-batch.js) rebuilds a due row's `seg` by looking its
// `segment` up in a map keyed by the CURRENT scheme. Rows under a dead key never
// resolve → `runRecheck` logs "unknown segment … skipping" and the loop `continue`s
// BEFORE advancing next_recheck_at, so they are stuck permanently "due", skipped every
// Monday, and would eventually settle to genuine_non_hemnet WITHOUT ever being
// re-searched. (First observed on the W28 2026-07-06 first-ever real drain fire: 39/39
// due rows — all kungalv-apt/kungalv-villa — skipped.) The dead keys also produce
// duplicate municipality lines in the weekly Slack report.
//
// This migration relabels every dead key to its canonical equivalent in BOTH tables
// that carry `segment` (sold_match — the verdict table the report + drain read; and
// booli_sold — the seeded-record table). Both are UNIQUE(booli_id), so a relabel can
// never collide (one row per booli_id already). Idempotent: the WHERE clauses match only
// dead keys, so a re-run after success is a clean no-op. Runs inside a transaction.

const { createClient } = require('./db');

// Dead key → canonical key. Kept explicit (not derived) so the mapping is auditable.
const REMAP = [
  ['kungalv-apt', 'Kungälv:APARTMENT'],
  ['kungalv-villa', 'Kungälv:HOUSE'],
  ['Kungalv:APARTMENT', 'Kungälv:APARTMENT'],
  ['Taby:APARTMENT', 'Täby:APARTMENT'],
];
const DEAD_KEYS = REMAP.map(([from]) => from);
const TABLES = ['sold_match', 'booli_sold'];

async function snapshot(client) {
  const out = {};
  for (const t of TABLES) {
    const r = await client.query(
      `SELECT segment, COUNT(*)::int AS n FROM ${t} WHERE segment = ANY($1) GROUP BY segment ORDER BY segment`,
      [DEAD_KEYS],
    );
    out[t] = r.rows;
  }
  return out;
}

async function run() {
  const client = createClient();
  await client.connect();
  try {
    console.log('=== BEFORE (dead-key rows) ===');
    console.table((await snapshot(client)).sold_match, ['segment', 'n']);
    console.log('sold_match ^   booli_sold v');
    console.table((await snapshot(client)).booli_sold, ['segment', 'n']);

    await client.query('BEGIN');
    let total = 0;
    for (const t of TABLES) {
      for (const [from, to] of REMAP) {
        const r = await client.query(
          `UPDATE ${t} SET segment = $2 WHERE segment = $1`,
          [from, to],
        );
        if (r.rowCount) {
          console.log(`  ${t}: '${from}' -> '${to}'  (${r.rowCount} rows)`);
          total += r.rowCount;
        }
      }
    }
    await client.query('COMMIT');
    console.log(`Committed. ${total} rows relabeled.`);

    console.log('=== AFTER (dead-key rows should be empty) ===');
    const after = await snapshot(client);
    const leftover = [...after.sold_match, ...after.booli_sold];
    console.table(leftover.length ? leftover : [{ segment: '(none — all canonicalized)', n: 0 }], ['segment', 'n']);

    // Confirm the canonical keys now carry the merged rows.
    const canon = await client.query(
      `SELECT segment, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE verdict='booli_only' AND next_recheck_at <= now() AND recheck_until >= now())::int AS bo_due
         FROM sold_match WHERE segment IN ('Kungälv:APARTMENT','Kungälv:HOUSE','Täby:APARTMENT','Täby:HOUSE')
         GROUP BY segment ORDER BY segment`,
    );
    console.log('=== canonical Kungälv/Täby in sold_match (bo_due = will re-check next fire) ===');
    console.table(canon.rows, ['segment', 'n', 'bo_due']);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
}

module.exports = { REMAP, DEAD_KEYS };
