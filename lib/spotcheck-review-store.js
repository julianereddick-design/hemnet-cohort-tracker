// lib/spotcheck-review-store.js
//
// CRUD + audited transactional soft-delete for the Phase 13 spot-check review queue.
// Implements D-11-as-reversed-in-13.1 (audited soft-remove via cohort_pairs.removed_at)
// and D-12 (persisted message refs + dedup).
//
// Every exported function takes a connected pg Client as its first argument.
// The gate (Plan 04) and the reaction-poller (Plan 05) pass the runJob client.
// No top-level DB connection is opened here.
//
// All queries use parameterised $1,$2,... placeholders — no string interpolation.
//
// Usage:
//   const { upsertReviewMessage, markAdjudicated, removeConfirmedMismatchPair,
//           getOpenReviewMessages, isAlreadyAdjudicated } = require('./lib/spotcheck-review-store');
//   node lib/spotcheck-review-store.js --smoke

'use strict';

// upsert: dedup on (pair_id, cohort_id) so a persisting UNCERTAIN is never re-inserted
async function upsertReviewMessage(client, { pairId, cohortId, channel, ts, visionVerdict }) {
  await client.query(
    `INSERT INTO spotcheck_review (pair_id, cohort_id, channel, ts, vision_verdict)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (pair_id, cohort_id) DO NOTHING`,
    [pairId, cohortId, channel, ts, visionVerdict ?? null]
  );
}

async function isAlreadyAdjudicated(client, { pairId, cohortId }) {
  const r = await client.query(
    `SELECT 1 FROM spotcheck_review
      WHERE pair_id=$1 AND cohort_id=$2 AND human_verdict IS NOT NULL LIMIT 1`,
    [pairId, cohortId]
  );
  return r.rows.length > 0;
}

async function markAdjudicated(client, { pairId, cohortId, humanVerdict, reactor, reason }) {
  await client.query(
    `UPDATE spotcheck_review
        SET human_verdict=$3, reactor=$4, reason=$5, adjudicated_at=NOW()
      WHERE pair_id=$1 AND cohort_id=$2`,
    [pairId, cohortId, humanVerdict, reactor ?? null, reason ?? null]
  );
}

// D-11 REVERSED to soft-delete (Phase 13.1, operator decision 2026-06-11): audit
// FIRST, then UPDATE removed_at/removed_reason/removed_by, all inside one
// transaction. The old hard DELETE was blocked by the cohort_daily_views.pair_id
// FK for any tracked pair (txn rolled back → pair never removed) and the audit
// row can't reconstruct the NOT NULL columns for a re-INSERT. Soft-delete keeps
// the row + its view history; recovery = UPDATE ... SET removed_at=NULL.
// The pairId IS the cohort_pairs.id (SERIAL PK).
async function removeConfirmedMismatchPair(client, { pairId, cohortId, booliId, hemnetId, visionVerdict, humanVerdict, reactor, reason }) {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO spotcheck_removed_pairs
         (pair_id, cohort_id, booli_id, hemnet_id, vision_verdict, human_verdict, reactor, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [pairId, cohortId, booliId, hemnetId, visionVerdict ?? null, humanVerdict, reactor ?? null, reason ?? null]
    );
    await client.query(
      `UPDATE cohort_pairs
          SET removed_at = NOW(), removed_reason = $2, removed_by = $3
        WHERE id = $1 AND removed_at IS NULL`,
      [pairId, reason ?? humanVerdict, reactor ?? null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function getOpenReviewMessages(client) {
  const r = await client.query(
    `SELECT id, pair_id, cohort_id, channel, ts, vision_verdict, created_at
       FROM spotcheck_review WHERE human_verdict IS NULL ORDER BY created_at ASC`
  );
  return r.rows;
}

module.exports = { upsertReviewMessage, markAdjudicated, removeConfirmedMismatchPair, getOpenReviewMessages, isAlreadyAdjudicated };

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network).
//   node lib/spotcheck-review-store.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  (async () => {
    // 1. All five functions are exported
    check('exports: upsertReviewMessage', () => assert.strictEqual(typeof upsertReviewMessage, 'function'));
    check('exports: isAlreadyAdjudicated', () => assert.strictEqual(typeof isAlreadyAdjudicated, 'function'));
    check('exports: markAdjudicated', () => assert.strictEqual(typeof markAdjudicated, 'function'));
    check('exports: removeConfirmedMismatchPair', () => assert.strictEqual(typeof removeConfirmedMismatchPair, 'function'));
    check('exports: getOpenReviewMessages', () => assert.strictEqual(typeof getOpenReviewMessages, 'function'));

    // 2. removeConfirmedMismatchPair: BEGIN → audit INSERT → soft-delete UPDATE → COMMIT
    //    (Phase 13.1: NEVER a DELETE — the cohort_daily_views FK blocked it on real data)
    await checkAsync('removeConfirmedMismatchPair: BEGIN → audit INSERT → soft-delete UPDATE (no DELETE) → COMMIT', async () => {
      const calls = [];
      const mockClient = {
        query: async (sql) => { calls.push(sql.trim()); return { rows: [] }; },
      };
      await removeConfirmedMismatchPair(mockClient, {
        pairId: 1, cohortId: '2026-W24', booliId: BigInt(100), hemnetId: BigInt(200),
        visionVerdict: 'MISMATCH', humanVerdict: 'CONFIRMED_MISMATCH', reactor: 'U123', reason: 'test',
      });
      assert.strictEqual(calls[0], 'BEGIN', `Expected calls[0]='BEGIN', got '${calls[0]}'`);
      assert.ok(calls[1].includes('spotcheck_removed_pairs'), `calls[1] should contain 'spotcheck_removed_pairs', got: ${calls[1]}`);
      assert.ok(calls[2].includes('UPDATE cohort_pairs') && calls[2].includes('removed_at = NOW()'),
        `calls[2] should be the soft-delete UPDATE, got: ${calls[2]}`);
      assert.ok(!calls.some(c => c.includes('DELETE FROM cohort_pairs')), 'must NEVER issue DELETE FROM cohort_pairs');
      assert.strictEqual(calls[3], 'COMMIT', `Expected calls[3]='COMMIT', got '${calls[3]}'`);
    });

    // 3. removeConfirmedMismatchPair: ROLLBACK fires when the soft-delete UPDATE throws
    await checkAsync('removeConfirmedMismatchPair: ROLLBACK fires on UPDATE error', async () => {
      let didRollback = false;
      const mockClient = {
        query: async (sql) => {
          const trimmed = sql.trim();
          if (trimmed.startsWith('UPDATE cohort_pairs')) throw new Error('mock UPDATE error');
          if (trimmed === 'ROLLBACK') { didRollback = true; return { rows: [] }; }
          return { rows: [] };
        },
      };
      let threw = false;
      try {
        await removeConfirmedMismatchPair(mockClient, {
          pairId: 2, cohortId: '2026-W24', booliId: BigInt(101), hemnetId: BigInt(201),
          visionVerdict: null, humanVerdict: 'CONFIRMED_MISMATCH', reactor: null, reason: null,
        });
      } catch (e) {
        threw = true;
      }
      assert.ok(threw, 'Should have re-thrown the error');
      assert.ok(didRollback, 'ROLLBACK should have been called');
    });

    // 4. upsertReviewMessage: sends correct SQL with ON CONFLICT DO NOTHING
    await checkAsync('upsertReviewMessage: uses ON CONFLICT (pair_id, cohort_id) DO NOTHING', async () => {
      let capturedSql = '';
      const mockClient = {
        query: async (sql) => { capturedSql = sql; return { rows: [] }; },
      };
      await upsertReviewMessage(mockClient, {
        pairId: 10, cohortId: '2026-W24', channel: 'C123', ts: '1234.5678', visionVerdict: 'MATCH',
      });
      assert.ok(capturedSql.includes('ON CONFLICT (pair_id, cohort_id) DO NOTHING'),
        `SQL should contain ON CONFLICT clause, got: ${capturedSql}`);
    });

    // 5. isAlreadyAdjudicated: returns true when rows exist, false when empty
    await checkAsync('isAlreadyAdjudicated: returns true for non-empty rows', async () => {
      const mockClient = { query: async () => ({ rows: [{ 1: 1 }] }) };
      const result = await isAlreadyAdjudicated(mockClient, { pairId: 1, cohortId: '2026-W24' });
      assert.strictEqual(result, true);
    });

    await checkAsync('isAlreadyAdjudicated: returns false for empty rows', async () => {
      const mockClient = { query: async () => ({ rows: [] }) };
      const result = await isAlreadyAdjudicated(mockClient, { pairId: 1, cohortId: '2026-W24' });
      assert.strictEqual(result, false);
    });

    // 6. getOpenReviewMessages: returns r.rows array
    await checkAsync('getOpenReviewMessages: returns rows array', async () => {
      const mockRows = [{ id: 1, pair_id: 10, cohort_id: '2026-W24', channel: 'C123', ts: '1234', vision_verdict: null }];
      const mockClient = { query: async () => ({ rows: mockRows }) };
      const result = await getOpenReviewMessages(mockClient);
      assert.deepStrictEqual(result, mockRows);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
