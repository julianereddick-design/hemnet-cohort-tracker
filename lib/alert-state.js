'use strict';

// lib/alert-state.js
//
// Persistence for lib/alert-policy.js. One row per OPEN condition, keyed by
// (scope, script_name, condition_key).
//
// WHY A TABLE AND NOT cron_job_log. The ladder needs "when did we last alert",
// the debounce needs a consecutive-clear counter, and the sweep needs its own
// incident scope. None of those are facts about a single run, so none of them
// belong on a run row.
//
// WHY `scope`. Spec §4.4 is explicit that the sweep's incident-scoped
// suppression is a DIFFERENT mechanism from cron-wrapper's per-run transition
// rule and must not be conflated with it. 'run' and 'sweep' therefore keep
// separate ladders for the same script and the same condition.
//
// FAILURE POSTURE — the most important decision in this file. If the table is
// missing (migration not run, restored snapshot, wrong database) this degrades
// to ALERTING, never to silence. Phase 4's whole purpose is to make the channel
// quiet, which means a bug that makes it quiet for the WRONG reason looks
// exactly like success right up until an incident is missed. Any OTHER database
// error still propagates: a broken store must not hide behind a quiet channel.
//
//   node lib/alert-state.js --smoke

const MISSING_TABLE_CODE = '42P01';   // postgres undefined_table

const DDL = `
CREATE TABLE IF NOT EXISTS alert_state (
  scope             TEXT        NOT NULL,
  script_name       TEXT        NOT NULL,
  condition_key     TEXT        NOT NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_alerted_at  TIMESTAMPTZ,
  last_alerted_at   TIMESTAMPTZ,
  alert_count       INTEGER     NOT NULL DEFAULT 0,
  consecutive_clear INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, script_name, condition_key)
)`;

function isMissingTable(err) {
  return err && (err.code === MISSING_TABLE_CODE || /relation "alert_state" does not exist/i.test(err.message || ''));
}

async function ensureTable(client) {
  await client.query(DDL);
}

// loadState -> the open state row, or null. null means "new condition", which
// alerts — see the failure posture above.
async function loadState(client, scope, scriptName, conditionKey) {
  if (!conditionKey) return null;
  try {
    const r = await client.query(
      `SELECT condition_key, first_seen_at, last_seen_at, first_alerted_at,
              last_alerted_at, alert_count, consecutive_clear
         FROM alert_state
        WHERE scope = $1 AND script_name = $2 AND condition_key = $3`,
      [scope, scriptName, conditionKey],
    );
    return r.rows.length ? r.rows[0] : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// saveState persists a state produced by alert-policy.applyOutcome. A resolved
// state is DELETED rather than flagged: a tombstone would make the next
// occurrence look like a continuing incident, so the ladder would never restart
// and a genuinely new failure would be suppressed for up to 24h.
async function saveState(client, scope, scriptName, state) {
  if (!state || !state.condition_key) return;
  if (state.resolved) return clearState(client, scope, scriptName, state.condition_key);
  try {
    await client.query(
      `INSERT INTO alert_state
         (scope, script_name, condition_key, first_seen_at, last_seen_at,
          first_alerted_at, last_alerted_at, alert_count, consecutive_clear)
       VALUES ($1,$2,$3, COALESCE($4, NOW()), COALESCE($5, NOW()), $6, $7, $8, $9)
       ON CONFLICT (scope, script_name, condition_key) DO UPDATE SET
         last_seen_at      = EXCLUDED.last_seen_at,
         first_alerted_at  = COALESCE(alert_state.first_alerted_at, EXCLUDED.first_alerted_at),
         last_alerted_at   = COALESCE(EXCLUDED.last_alerted_at, alert_state.last_alerted_at),
         alert_count       = EXCLUDED.alert_count,
         consecutive_clear = EXCLUDED.consecutive_clear`,
      [scope, scriptName, state.condition_key,
       state.first_seen_at || null, state.last_seen_at || null,
       state.first_alerted_at || null, state.last_alerted_at || null,
       state.alert_count || 0, state.consecutive_clear || 0],
    );
  } catch (err) {
    // Never let the suppression store fail the job it is only observing.
    if (!isMissingTable(err)) throw err;
  }
}

async function clearState(client, scope, scriptName, conditionKey) {
  try {
    await client.query(
      `DELETE FROM alert_state WHERE scope = $1 AND script_name = $2 AND condition_key = $3`,
      [scope, scriptName, conditionKey],
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

module.exports = { DDL, ensureTable, loadState, saveState, clearState, isMissingTable, MISSING_TABLE_CODE };

// ---------------------------------------------------------------
//   node lib/alert-state.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { DDL, loadState, saveState, clearState, MISSING_TABLE_CODE } = module.exports;
  let pass = 0, fail = 0;
  const checkA = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  // A recording fake. node-pg's real client is not available offline, and the
  // point here is the CONTRACT — which SQL, which params, and what happens when
  // the table is not there — not Postgres's behaviour.
  function fakeClient(responses = []) {
    const calls = [];
    let i = 0;
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        const r = responses[i++];
        if (r instanceof Error) throw r;
        return r || { rows: [] };
      },
    };
  }

  const missingTable = () => Object.assign(new Error('relation "alert_state" does not exist'), { code: '42P01' });

  check('the DDL is idempotent, so a re-run of the migration is safe', () => {
    assert.match(DDL, /CREATE TABLE IF NOT EXISTS alert_state/i);
  });

  // scope keeps the two mechanisms apart. Spec §4.4 is explicit that the sweep's
  // incident-scoped suppression is a DIFFERENT mechanism from the per-run
  // transition rule and must not be conflated with it.
  check('the primary key is (scope, script_name, condition_key)', () => {
    assert.match(DDL, /PRIMARY KEY \(scope, script_name, condition_key\)/i);
  });

  (async () => {
    await checkA('loadState returns null when the condition is not open', async () => {
      const c = fakeClient([{ rows: [] }]);
      assert.strictEqual(await loadState(c, 'run', 'cohort-track', 'null-views'), null);
    });

    await checkA('loadState scopes the lookup by all three key parts', async () => {
      const c = fakeClient([{ rows: [{ condition_key: 'null-views', alert_count: 2 }] }]);
      const s = await loadState(c, 'run', 'cohort-track', 'null-views');
      assert.strictEqual(s.alert_count, 2);
      assert.deepStrictEqual(c.calls[0].params, ['run', 'cohort-track', 'null-views']);
    });

    // THE most important behaviour in this file. If alert_state is missing — a
    // migration not run, a restored snapshot, a wrong database — the policy must
    // fall back to ALERTING, never to silence. Phase 4 exists to make the channel
    // quiet; a bug that makes it quiet for the WRONG reason is indistinguishable
    // from success until an incident is missed.
    await checkA('a missing alert_state table degrades to alerting, not to silence', async () => {
      const c = fakeClient([missingTable()]);
      const s = await loadState(c, 'run', 'cohort-track', 'null-views');
      assert.strictEqual(s, null, 'null state means "new condition", which alerts');
    });

    await checkA('a missing table on save is swallowed, so it cannot fail the job', async () => {
      const c = fakeClient([missingTable()]);
      await saveState(c, 'run', 'cohort-track', { condition_key: 'null-views', alert_count: 1 });
      // no throw
    });

    // Any OTHER database error is a real fault and must not be silently eaten —
    // that would hide a broken suppression store behind a quiet channel.
    await checkA('a non-missing-table error still propagates', async () => {
      const c = fakeClient([new Error('connection terminated')]);
      await assert.rejects(() => loadState(c, 'run', 'x', 'y'), /connection terminated/);
    });

    await checkA('saveState upserts on the composite key rather than inserting duplicates', async () => {
      const c = fakeClient([{ rows: [] }]);
      await saveState(c, 'run', 'cohort-track', {
        condition_key: 'null-views', first_seen_at: new Date(), last_seen_at: new Date(),
        first_alerted_at: null, last_alerted_at: null, alert_count: 0, consecutive_clear: 0,
      });
      assert.match(c.calls[0].sql, /ON CONFLICT \(scope, script_name, condition_key\)/i);
    });

    await checkA('clearState deletes exactly one condition, not the whole script', async () => {
      const c = fakeClient([{ rows: [] }]);
      await clearState(c, 'run', 'cohort-track', 'null-views');
      assert.match(c.calls[0].sql, /^\s*DELETE FROM alert_state/i);
      assert.deepStrictEqual(c.calls[0].params, ['run', 'cohort-track', 'null-views']);
    });

    // A resolved condition must actually leave the table. Otherwise the next
    // occurrence looks like a continuing incident, the ladder never restarts, and
    // a genuinely new failure is suppressed for up to 24h.
    await checkA('a resolved state is deleted, never left behind as a tombstone', async () => {
      const c = fakeClient([{ rows: [] }]);
      await saveState(c, 'run', 'cohort-track', { condition_key: 'null-views', resolved: true });
      assert.match(c.calls[0].sql, /DELETE FROM alert_state/i,
        'saveState must route a resolved state to a delete');
    });

    check('MISSING_TABLE_CODE is postgres undefined_table', () => {
      assert.strictEqual(MISSING_TABLE_CODE, '42P01');
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
