// scripts/unstick-cron-row.js — Phase 10 / 10-01.
// Marks one or more `status='running'` rows in cron_job_log as 'killed' with a
// supplied error_message. Idempotent — WHERE clause guards against re-marking
// rows that have already resolved.
//
// Usage:
//   node scripts/unstick-cron-row.js --id 435 [--id 359 --id 406] [--reason "text"]
//   node scripts/unstick-cron-row.js --all-orphans [--older-than-hours 24] [--reason "text"]
//   node scripts/unstick-cron-row.js --list  (read-only — show currently-orphaned rows)
//
// Defaults: --reason "ghost — process exited without resolving cron_job_log row"
//           --older-than-hours 6 (when --all-orphans is used)

'use strict';

require('dotenv').config();
const { createClient } = require('../db');

function parseArgs(argv) {
  const out = { ids: [], allOrphans: false, list: false, reason: null, olderThanHours: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n)) { console.error(`--id must be a number; got "${argv[i]}"`); process.exit(2); }
      out.ids.push(n);
    } else if (a === '--all-orphans') {
      out.allOrphans = true;
    } else if (a === '--list') {
      out.list = true;
    } else if (a === '--reason' && argv[i + 1]) {
      out.reason = argv[++i];
    } else if (a === '--older-than-hours' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 0) { console.error('--older-than-hours must be a non-negative integer'); process.exit(2); }
      out.olderThanHours = n;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/unstick-cron-row.js --id <ID> [--id <ID>...] [--reason "text"]
  node scripts/unstick-cron-row.js --all-orphans [--older-than-hours N] [--reason "text"]
  node scripts/unstick-cron-row.js --list`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function listOrphans(client, olderThanHours) {
  const r = await client.query(
    `SELECT id, script_name, started_at,
            ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 3600, 1) AS hours_running
       FROM cron_job_log
      WHERE status = 'running'
        AND started_at < NOW() - ($1 || ' hours')::interval
      ORDER BY started_at`,
    [String(olderThanHours)]
  );
  return r.rows;
}

async function unstickById(client, id, reason) {
  const r = await client.query(
    `UPDATE cron_job_log
        SET status = 'killed',
            finished_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
            error_message = $1
      WHERE id = $2
        AND status = 'running'
      RETURNING id, script_name, started_at, finished_at, status, error_message`,
    [reason, id]
  );
  return r.rows[0] || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.list && !args.allOrphans && args.ids.length === 0) {
    console.error('Specify --id <N>, --all-orphans, or --list. Use --help for syntax.');
    process.exit(2);
  }

  const reason = args.reason || 'ghost — process exited without resolving cron_job_log row';

  const client = createClient();
  await client.connect();
  try {
    // List mode: read-only, show what is currently orphaned (default threshold 6h).
    if (args.list) {
      const orphans = await listOrphans(client, args.olderThanHours);
      if (orphans.length === 0) {
        console.log(`No rows with status='running' older than ${args.olderThanHours}h.`);
      } else {
        console.log(`${orphans.length} orphan row(s) older than ${args.olderThanHours}h:`);
        for (const o of orphans) {
          console.log(`  id=${o.id}  script=${o.script_name.padEnd(28)}  started=${o.started_at.toISOString()}  running for ${o.hours_running}h`);
        }
      }
      return;
    }

    // Build target id list
    let targetIds = args.ids;
    if (args.allOrphans) {
      const orphans = await listOrphans(client, args.olderThanHours);
      targetIds = orphans.map(o => o.id);
      if (targetIds.length === 0) {
        console.log(`No orphans older than ${args.olderThanHours}h to unstick.`);
        return;
      }
      console.log(`Unsticking ${targetIds.length} orphan(s) older than ${args.olderThanHours}h: ${targetIds.join(', ')}`);
    }

    // Update each id
    let updated = 0;
    for (const id of targetIds) {
      const row = await unstickById(client, id, reason);
      if (row) {
        console.log(`Updated: id=${row.id} script=${row.script_name} -> status=${row.status} error="${row.error_message}"`);
        updated++;
      } else {
        const peek = await client.query(`SELECT id, status, started_at, finished_at FROM cron_job_log WHERE id = $1`, [id]);
        console.log(`Skipped id=${id} (${peek.rows[0] ? `already status=${peek.rows[0].status}` : 'no row with this id'})`);
      }
    }
    console.log(`\nDone: ${updated} row(s) updated, ${targetIds.length - updated} skipped.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
