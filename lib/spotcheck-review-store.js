'use strict';

// Stubs — to be implemented (RED phase)
async function upsertReviewMessage() { throw new Error('not implemented'); }
async function isAlreadyAdjudicated() { throw new Error('not implemented'); }
async function markAdjudicated() { throw new Error('not implemented'); }
async function removeConfirmedMismatchPair() { throw new Error('not implemented'); }
async function getOpenReviewMessages() { throw new Error('not implemented'); }

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

    // 2. removeConfirmedMismatchPair: BEGIN → audit INSERT → DELETE → COMMIT ordering
    await checkAsync('removeConfirmedMismatchPair: BEGIN before audit INSERT before DELETE before COMMIT', async () => {
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
      assert.ok(calls[2].includes('DELETE FROM cohort_pairs'), `calls[2] should contain 'DELETE FROM cohort_pairs', got: ${calls[2]}`);
      assert.strictEqual(calls[3], 'COMMIT', `Expected calls[3]='COMMIT', got '${calls[3]}'`);
    });

    // 3. removeConfirmedMismatchPair: ROLLBACK fires when DELETE throws
    await checkAsync('removeConfirmedMismatchPair: ROLLBACK fires on DELETE error', async () => {
      let didRollback = false;
      let callCount = 0;
      const mockClient = {
        query: async (sql) => {
          const trimmed = sql.trim();
          callCount++;
          if (trimmed.startsWith('DELETE')) throw new Error('mock DELETE error');
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

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
