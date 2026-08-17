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

const CHECK = process.argv.includes('--check');

async function main() {
  const client = createClient();
  await client.connect();
  try {
    const before = await client.query(`SELECT to_regclass('public.alert_state') AS t`);
    const exists = before.rows[0].t !== null;

    if (CHECK) {
      console.log(exists ? 'alert_state: present' : 'alert_state: MISSING — run node migrate-alert-state.js');
      process.exitCode = exists ? 0 : 1;
      return;
    }

    await client.query(DDL);
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'alert_state' ORDER BY ordinal_position`);
    console.log(exists ? 'alert_state already existed' : 'alert_state created');
    console.log(`columns: ${cols.rows.map(r => r.column_name).join(', ')}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
