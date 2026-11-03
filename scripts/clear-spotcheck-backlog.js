'use strict';
require('dotenv').config();

// scripts/clear-spotcheck-backlog.js — one-off, 2026-11-04 (Glenn's decision).
//
// Nobody had reacted to the spot-check review queue since 24 Aug (228 open items, W34–W44).
// Same rule as the gate now applies each week (cohort-spotcheck-gate.js step 9a):
//   - open items the automatic check rated MISMATCH → audited soft-remove (AUTO_REMOVED,
//     recoverable: UPDATE cohort_pairs SET removed_at = NULL WHERE id = …)
//   - other open items in cohorts before --keep-open-from → CLEARED_STALE, pair kept
//   - open uncertain items from --keep-open-from on stay open for Glenn to review
//
//   node scripts/clear-spotcheck-backlog.js --dry-run
//   node scripts/clear-spotcheck-backlog.js [--keep-open-from 2026-W44]

const { autoRemoveMismatch, markAdjudicated } = require('../lib/spotcheck-review-store');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const i = argv.indexOf('--keep-open-from');
  const keepFrom = i >= 0 ? argv[i + 1] : '2026-W44';
  const { createClient } = require('../db');
  const client = createClient();
  await client.connect();
  try {
    const open = (await client.query(
      `SELECT pair_id, cohort_id, vision_verdict FROM spotcheck_review WHERE adjudicated_at IS NULL ORDER BY cohort_id, pair_id`)).rows;
    const mismatch = open.filter(r => r.vision_verdict === 'MISMATCH');
    const clear = open.filter(r => r.vision_verdict !== 'MISMATCH' && r.cohort_id < keepFrom);
    const left = open.length - mismatch.length - clear.length;
    console.log(`open ${open.length}: remove ${mismatch.length} (automatic MISMATCH), clear ${clear.length} as kept (before ${keepFrom}), leave ${left} open for review`);
    if (dryRun) { console.log('dry run: nothing written'); return; }
    let removed = 0;
    for (const r of mismatch) {
      if (await autoRemoveMismatch(client, { pairId: r.pair_id, cohortId: r.cohort_id, visionVerdict: r.vision_verdict,
        reason: 'automatic spot-check: different homes (backlog cleared 2026-11-04)' })) removed++;
    }
    for (const r of clear) {
      await markAdjudicated(client, { pairId: r.pair_id, cohortId: r.cohort_id, humanVerdict: 'CLEARED_STALE',
        reactor: null, reason: 'not reviewed; pair kept (backlog cleared 2026-11-04)' });
    }
    console.log(`removed ${removed} pairs (${mismatch.length - removed} were already gone), cleared ${clear.length}`);
  } finally { await client.end(); }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
