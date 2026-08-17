#!/usr/bin/env node
// migrate-alert-state.js — create the alert_state table (Phase 4).
//
// Idempotent: CREATE TABLE IF NOT EXISTS, so re-running on deploy is safe.
//
// Until this runs, lib/alert-state.js degrades to ALERTING rather than to
// silence (a missing table means "no state", which reads as "new condition").
// So a forgotten migration makes the channel noisier, never quieter — which is
// the correct direction for a bug in a suppression system to fail.
//
//   node migrate-alert-state.js            apply
//   node migrate-alert-state.js --check    report only, exit 1 if absent
'use strict';
require('dotenv').config();
const { createClient } = require('./db');
const { DDL } = require('./lib/alert-state');
const { DISK_DDL } = require('./lib/disk-floor');

const CHECK = process.argv.includes('--check');

// Both alerting tables. `disk_sample` (Phase 5) lives here rather than in its own
// migration because it has the same one-line, idempotent, deploy-time shape and a
// second script is a second thing to forget.
const TABLES = [
  { name: 'alert_state', ddl: DDL },
  { name: 'disk_sample', ddl: DISK_DDL },
];

async function main() {
  const client = createClient();
  await client.connect();
  try {
    let missing = 0;
    for (const { name, ddl } of TABLES) {
      const before = await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`]);
      const exists = before.rows[0].t !== null;

      if (CHECK) {
        console.log(exists ? `${name}: present` : `${name}: MISSING — run node migrate-alert-state.js`);
        if (!exists) missing++;
        continue;
      }

      await client.query(ddl);
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = $1 ORDER BY ordinal_position`, [name]);
      console.log(`${name}: ${exists ? 'already existed' : 'created'} — ${cols.rows.map(r => r.column_name).join(', ')}`);
    }
    if (CHECK) process.exitCode = missing === 0 ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
