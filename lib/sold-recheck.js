'use strict';

// lib/sold-recheck.js — Phase 18 re-check drain loop (RECHECK-01/02/03/04).
//
// The genuinely-new orchestration of the milestone: three functions over an
// INJECTED clock that drive an unmatched `booli_only` row through its re-check
// lifecycle, re-using the Phase-17 matcher (NOT re-implementing matching):
//
//   1. enrollUnmatched (RECHECK-01) — stamp scheduling state (first_unmatched_at,
//      recheck_until = first + RECHECK_WINDOW_DAYS, next_recheck_at = first +
//      RECHECK_INTERVAL_DAYS) on booli_only rows that have none yet.
//   2. runRecheck (RECHECK-02) — for each DUE in-window booli_only row, re-run the
//      SAME `matchOne` (deps-injected) from scripts/sold-match-run.js. A late match
//      flips the verdict to `matched` (matchOne persists it) and clears scheduling
//      state (clearRecheck → leaves the queue); a still-unmatched booli_only row
//      advances next_recheck_at; an ambiguous `uncertain` re-check (matchOne's third
//      outcome) clears scheduling state and exits the auto-drain for human review (it is
//      NEVER auto-settled to a terminal verdict). Returns
//      { rechecked, lateMatched, stillPending, uncertain }.
//   3. settleExpired (RECHECK-03) — flip booli_only rows past recheck_until to the
//      terminal `genuine_non_hemnet` verdict; they leave the due set permanently and
//      are NEVER re-searched again (no further Oxylabs spend — the DoS control).
//
// The window/interval come from config (RECHECK-04, lib/sold-config.js), so a typo
// can never widen/zero them. The whole drain is exercised by an inline --smoke that
// drives a MOCKED clock forward over a MOCK pg client with a STUBBED matchOne —
// zero Oxylabs spend, zero live DB writes (SC-5).
//
// This is a LIBRARY: it must `require` cleanly with no network and no DB connection.
// It does NOT set SCRAPE_FORCE_OXYLABS and does NOT require the runner at module top
// (the runner sets SCRAPE_FORCE_OXYLABS on its first line). The real matchOne is
// lazily required only when no stub is injected (resolveMatchOne, Task 2).
//
//   node lib/sold-recheck.js --smoke   # offline self-test (no DB, no network)

const {
  RECHECK_WINDOW_DAYS, RECHECK_INTERVAL_DAYS, RECHECK_BRIDGE_FINAL_ONLY,
} = require('./sold-config');
const {
  enrollRecheck, fetchDueRecheck, advanceRecheck, settleNonHemnet, clearRecheck,
} = require('./sold-store');
// NOTE: scripts/sold-match-run.js is NOT required here at module top — its first line
// sets SCRAPE_FORCE_OXYLABS, which would couple a plain `require('./sold-recheck')` to
// the live transport. It is lazily required inside resolveMatchOne (Task 2) only when
// no deps.matchOne stub is supplied.

// ---------------------------------------------------------------------------
// Injected clock + pure date helpers (SC-5). No bare `new Date()` in the date
// math paths — every timestamp derives from the injected `now` so the smoke can
// drive time deterministically.
// ---------------------------------------------------------------------------

// toISO — normalize an injected clock value (Date | ISO string | undefined) to an
// ISO string. `undefined` falls back to the real clock (production default); a
// string/Date is deterministic (the smoke passes fixed strings).
function toISO(now) {
  if (now == null) return new Date().toISOString();
  if (now instanceof Date) return now.toISOString();
  return new Date(now).toISOString(); // accepts an ISO string; deterministic for the smoke
}

// addDaysISO — base ISO + n days, as ISO. Pure: deterministic for a fixed input.
function addDaysISO(baseISO, n) {
  return new Date(new Date(baseISO).getTime() + n * 86400000).toISOString();
}

// ---------------------------------------------------------------------------
// enrollUnmatched — RECHECK-01. Stamp scheduling state on un-enrolled booli_only
// rows. Row-driven (the caller supplies the rows) so the smoke is DB-free; Phase 19
// supplies them from a "booli_only AND first_unmatched_at IS NULL" query.
// ---------------------------------------------------------------------------
async function enrollUnmatched(client, opts) {
  const o = opts || {};
  const nowISO = toISO(o.now);
  const recheckUntil = addDaysISO(nowISO, RECHECK_WINDOW_DAYS);   // RECHECK-04 window
  const nextRecheckAt = addDaysISO(nowISO, RECHECK_INTERVAL_DAYS); // RECHECK-04 interval
  const rows = o.rows || [];
  let enrolled = 0;
  for (const row of rows) {
    const n = await enrollRecheck(client, row.booli_id, {
      firstUnmatchedAt: nowISO, recheckUntil, nextRecheckAt,
    });
    if (n >= 1) enrolled++;
  }
  return { enrolled };
}

// ---------------------------------------------------------------------------
// settleExpired — RECHECK-03. Flip booli_only rows past recheck_until to the
// terminal `genuine_non_hemnet` verdict (settleNonHemnet nulls next_recheck_at so
// they exit the due set permanently — never re-searched again, no further Oxylabs).
// deps.fetchExpired lets the smoke inject seeded past-window rows DB-free; the
// default runs the real parameterized query.
// ---------------------------------------------------------------------------
async function settleExpired(client, opts) {
  const o = opts || {};
  const nowISO = toISO(o.now);
  const fetchExpired = (o.deps && o.deps.fetchExpired) || (async () =>
    (await client.query(
      `SELECT booli_id FROM sold_match
         WHERE verdict = 'booli_only' AND recheck_until IS NOT NULL AND recheck_until < $1`,
      [nowISO]
    )).rows);
  const expired = await fetchExpired();
  let settledNonHemnet = 0;
  for (const row of expired) {
    const n = await settleNonHemnet(client, row.booli_id, { adjudicatedAt: nowISO });
    if (n >= 1) settledNonHemnet++;
  }
  return { settledNonHemnet };
}

// ---------------------------------------------------------------------------
// runRecheck — RECHECK-02. The drain step. Loads DUE in-window booli_only rows
// (fetchDueRecheck), rebuilds the matchOne record + seg, and re-runs the SAME
// Phase-17 matchOne (deps-injected, NOT re-implemented). A late match flips the
// verdict to `matched` (matchOne persists it) → clearRecheck leaves the queue;
// a still-unmatched row advances next_recheck_at. Returns a clean machine-readable
// count object for Phase 19/20.
// ---------------------------------------------------------------------------

// resolveMatchOne — prefer the injected stub (smoke); else LAZILY require the real
// runner. The lazy require keeps `require('./sold-recheck')` network-free (the
// runner's first line sets SCRAPE_FORCE_OXYLABS).
function resolveMatchOne(deps) {
  if (deps && deps.matchOne) return deps.matchOne;
  return require('../scripts/sold-match-run').matchOne;
}

// loadBooliRecord — fetch the full booli_sold row matchOne needs to re-search (the
// due row from fetchDueRecheck carries only scheduling/identity cols). deps.loadBooliRecord
// lets the smoke inject the record DB-free. Parameterized $1 (T-18-08).
async function loadBooliRecord(client, booliId, deps) {
  if (deps && deps.loadBooliRecord) return deps.loadBooliRecord(booliId);
  const r = await client.query(`SELECT * FROM booli_sold WHERE booli_id = $1`, [booliId]);
  return r.rows[0] || null;
}

async function runRecheck(client, opts) {
  const o = opts || {};
  const nowISO = toISO(o.now);
  const log = o.log || (() => {});
  const deps = o.deps || {};
  const segments = o.segments || {};
  const matchOne = resolveMatchOne(deps);
  const nextRecheckAt = addDaysISO(nowISO, RECHECK_INTERVAL_DAYS); // RECHECK-04 interval
  // D-16 cheaper-recheck lever (default OFF). When ON, an INTERMEDIATE re-attempt runs
  // matchOne with the SERP bridge SUPPRESSED; only the FINAL attempt before settle runs
  // it with the bridge ON. deps.bridgeFinalOnly lets the smoke force it without env.
  const bridgeFinalOnly = deps.bridgeFinalOnly != null
    ? deps.bridgeFinalOnly : RECHECK_BRIDGE_FINAL_ONLY;
  const due = await fetchDueRecheck(client, {
    now: nowISO, segment: o.segment || undefined, limit: o.limit || undefined,
  });
  const summary = { rechecked: 0, lateMatched: 0, stillPending: 0, uncertain: 0 };
  for (const row of due) {
    const seg = segments[row.segment];
    if (!seg) {
      log('WARN', `recheck: unknown segment ${row.segment} for booli_id=${row.booli_id} — skipping`);
      continue;
    }
    const record = await loadBooliRecord(client, row.booli_id, deps);
    if (!record) {
      log('WARN', `recheck: no booli_sold row for booli_id=${row.booli_id} — skipping`);
      continue;
    }
    // D-16: is this the FINAL in-window attempt? The next scheduled re-check would land
    // at nowISO + RECHECK_INTERVAL_DAYS; if that is at/after the row's recheck_until,
    // there is no further in-window attempt remaining → run the bridge. On an INTERMEDIATE
    // attempt (a further re-check still fits in the window) the lever suppresses the bridge.
    const isFinalAttempt = !row.recheck_until
      || nextRecheckAt >= new Date(row.recheck_until).toISOString();
    const suppressBridge = bridgeFinalOnly && !isFinalAttempt;

    // Re-run the SAME Phase-17 matcher. window_start/window_end mirror the row's
    // original window (kept in evidence) or a null fallback — the search itself
    // re-derives candidates; the window strings only annotate the persisted verdict.
    // A CeilingError from matchOne propagates UNCHANGED (not caught) so the Phase-19
    // batch ceiling still stops the drain mid-run (T-18-09). bridgeEnabled() reads
    // SOLD_MATCH_BRIDGE at CALL time, so we toggle it around the call (save/restore in a
    // finally) — matchOne's signature is unchanged (D-16).
    const prevBridge = process.env.SOLD_MATCH_BRIDGE;
    if (suppressBridge) process.env.SOLD_MATCH_BRIDGE = '0';
    let verdict;
    try {
      verdict = await matchOne(client, record, seg, row.segment,
        (row.evidence && row.evidence.window_start) || null,
        (row.evidence && row.evidence.window_end) || null, log, deps);
    } finally {
      if (suppressBridge) {
        if (prevBridge === undefined) delete process.env.SOLD_MATCH_BRIDGE;
        else process.env.SOLD_MATCH_BRIDGE = prevBridge;
      }
    }
    summary.rechecked++;
    if (verdict === 'matched') {
      await clearRecheck(client, row.booli_id); // RECHECK-02: late match leaves the queue
      summary.lateMatched++;
    } else if (verdict === 'booli_only') {
      // still unmatched, still in window (fetchDueRecheck guaranteed recheck_until >= now)
      // → schedule the next attempt. Count from rowCount so a row concurrently settled/
      // cleared between fetchDueRecheck and here is not over-counted (IN-02).
      const n = await advanceRecheck(client, row.booli_id, nextRecheckAt);
      if (n) summary.stillPending++;
    } else {
      // 'uncertain' (or any future non-terminal verdict): matchOne's persist already
      // flipped this row OFF 'booli_only', so advanceRecheck/fetchDueRecheck/settleExpired
      // (all booli_only-guarded) would never touch it again — without this it would leak
      // stale scheduling columns and silently sit in non-terminal limbo (WR-01). Per the
      // identity-model convention 'uncertain' routes to human review and is NEVER auto-
      // settled to a terminal verdict, so we just clear the scheduling state: the row
      // exits the auto-drain queue cleanly and waits for a human verdict.
      await clearRecheck(client, row.booli_id);
      summary.uncertain++;
    }
  }
  return summary;
}

module.exports = {
  toISO, addDaysISO, enrollUnmatched, settleExpired,
  runRecheck, resolveMatchOne, loadBooliRecord,
};

// ---------------------------------------------------------------------------
// Thin main() — manual OFFLINE inspection only. A bare `node lib/sold-recheck.js`
// with no flags prints usage and exits 0; it does NOT connect to a DB or run a live
// drain. The live drain is Phase 19's cron orchestrator (operator-gated). The
// --smoke path (Task 3) runs the fully-offline self-test.
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--smoke')) return; // handled by the --smoke block below
  console.log([
    'lib/sold-recheck.js — Phase 18 re-check drain helpers (library).',
    '',
    'Exports: enrollUnmatched, runRecheck, settleExpired (clock-injected).',
    'These are called by the Phase-19 cron orchestrator inside cron-wrapper.runJob;',
    'this file does NOT run a live drain on its own.',
    '',
    'Usage:',
    '  node lib/sold-recheck.js --smoke    # offline self-test (no DB, no network)',
    `Config: RECHECK_WINDOW_DAYS=${RECHECK_WINDOW_DAYS} RECHECK_INTERVAL_DAYS=${RECHECK_INTERVAL_DAYS}`,
  ].join('\n'));
}

if (require.main === module && !process.argv.includes('--smoke')) {
  main();
}

// ---------------------------------------------------------------------------
// --smoke self-test — fully offline (no DB, no network, no real matchOne).
//   node lib/sold-recheck.js --smoke
//
// Drives a FIXED clock T0 -> T_DUE -> T_EXPIRED across the whole drain
// (enroll -> runRecheck late-match/advance branches -> settleExpired) on a MOCK
// pg client with a STUBBED matchOne — zero Oxylabs spend, zero live DB writes
// (SC-5). The mockClient mirrors the sold-store/sold-match-run harness shape.
// ---------------------------------------------------------------------------
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

  // Mock pg client capturing every (sql, params) pair. `rowsToReturn` is the next
  // SELECT result (default empty). No DB, no network.
  function mockClient() {
    return {
      calls: [],
      rowsToReturn: [],
      query: async function (sql, params) {
        this.calls.push({ sql, params });
        return { rows: this.rowsToReturn || [], rowCount: (this.rowsToReturn || []).length };
      },
    };
  }

  // A mock client whose UPDATEs report rowCount=1 (so enroll counts a stamped row)
  // while still returning rowsToReturn for SELECTs. Needed because the store helpers
  // count rowCount from UPDATEs.
  function mockClientRowCount1() {
    return {
      calls: [],
      rowsToReturn: [],
      query: async function (sql, params) {
        this.calls.push({ sql, params });
        const isSelect = /^\s*SELECT/i.test(sql);
        return {
          rows: isSelect ? (this.rowsToReturn || []) : [],
          rowCount: isSelect ? (this.rowsToReturn || []).length : 1,
        };
      },
    };
  }

  // Fixed-clock timeline (no real new Date() in any assertion):
  const T0 = '2026-06-01T00:00:00.000Z';        // enroll time
  const T_DUE = '2026-06-09T00:00:00.000Z';     // > T0+7d (due), < T0+28d (in window)
  const T_EXPIRED = '2026-07-05T00:00:00.000Z'; // > T0+28d (past window)

  (async () => {
    // 1. addDaysISO is deterministic.
    check('addDaysISO is deterministic', () => {
      assert.strictEqual(addDaysISO(T0, 28), '2026-06-29T00:00:00.000Z');
      assert.strictEqual(addDaysISO(T0, 7), '2026-06-08T00:00:00.000Z');
    });

    // 2. toISO accepts string + Date.
    check('toISO accepts string + Date', () => {
      assert.strictEqual(toISO(T0), T0);
      assert.strictEqual(toISO(new Date(T0)), T0);
    });

    // 3. enrollUnmatched stamps window from config clock.
    await checkAsync('enrollUnmatched stamps window from config clock', async () => {
      const c = mockClientRowCount1();
      const r = await enrollUnmatched(c, { now: T0, rows: [{ booli_id: 1 }] });
      assert.strictEqual(r.enrolled, 1, 'one row enrolled (rowCount=1)');
      // enrollRecheck params: [booliId, firstUnmatchedAt, recheckUntil, nextRecheckAt]
      const p = c.calls[0].params;
      assert.strictEqual(p[1], T0, 'firstUnmatchedAt === now (T0)');
      assert.strictEqual(p[2], addDaysISO(T0, RECHECK_WINDOW_DAYS), 'recheckUntil = now + RECHECK_WINDOW_DAYS');
      assert.strictEqual(p[3], addDaysISO(T0, RECHECK_INTERVAL_DAYS), 'nextRecheckAt = now + RECHECK_INTERVAL_DAYS');
    });

    // 4. runRecheck: stubbed search -> late match flips + clears.
    await checkAsync('runRecheck: late match flips + clears', async () => {
      const c = mockClient();
      c.rowsToReturn = [{ booli_id: 1, segment: 'taby-villa', evidence: {} }];
      const summary = await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: {
          matchOne: async () => 'matched',
          loadBooliRecord: async () => ({ booli_id: 1, street_address: 'X 1' }),
        },
      });
      assert.strictEqual(summary.rechecked, 1, 'rechecked 1');
      assert.strictEqual(summary.lateMatched, 1, 'lateMatched 1');
      assert.strictEqual(summary.stillPending, 0, 'stillPending 0');
      assert.ok(c.calls.some((q) => /UPDATE sold_match\s+SET first_unmatched_at = NULL/.test(q.sql)),
        'clearRecheck ran (nulls first_unmatched_at)');
    });

    // 5. runRecheck: stubbed search -> still unmatched advances.
    await checkAsync('runRecheck: still unmatched advances', async () => {
      const c = mockClient();
      c.rowsToReturn = [{ booli_id: 1, segment: 'taby-villa', evidence: {} }];
      const summary = await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: {
          matchOne: async () => 'booli_only',
          loadBooliRecord: async () => ({ booli_id: 1 }),
        },
      });
      assert.strictEqual(summary.stillPending, 1, 'stillPending 1');
      assert.strictEqual(summary.lateMatched, 0, 'lateMatched 0');
      const adv = c.calls.find((q) => /SET next_recheck_at = \$2/.test(q.sql));
      assert.ok(adv, 'advanceRecheck ran (SET next_recheck_at = $2)');
      assert.strictEqual(adv.params[1], addDaysISO(T_DUE, RECHECK_INTERVAL_DAYS),
        'next_recheck_at advanced to T_DUE + RECHECK_INTERVAL_DAYS');
    });

    // 6. runRecheck: no due rows -> zero counts.
    await checkAsync('runRecheck: no due rows -> zero counts', async () => {
      const c = mockClient();
      c.rowsToReturn = [];
      const summary = await runRecheck(c, { now: T_DUE, segments: {}, deps: { matchOne: async () => 'matched' } });
      assert.deepStrictEqual(summary, { rechecked: 0, lateMatched: 0, stillPending: 0, uncertain: 0 });
    });

    // 6b. runRecheck: an 'uncertain' re-check clears scheduling state (does NOT advance) and
    //     counts in summary.uncertain — the row leaves the auto-drain queue, never stranded
    //     in non-terminal limbo with stale columns (WR-01).
    await checkAsync('runRecheck: uncertain clears state, never advanced/settled', async () => {
      const c = mockClient();
      c.rowsToReturn = [{ booli_id: 1, segment: 'taby-villa', evidence: {} }];
      const summary = await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: {
          matchOne: async () => 'uncertain',
          loadBooliRecord: async () => ({ booli_id: 1 }),
        },
      });
      assert.strictEqual(summary.uncertain, 1, 'uncertain 1');
      assert.strictEqual(summary.stillPending, 0, 'stillPending 0 (not advanced)');
      assert.strictEqual(summary.lateMatched, 0, 'lateMatched 0');
      // clearRecheck ran (nulls scheduling state so the row exits the queue)...
      assert.ok(c.calls.some((q) => /UPDATE sold_match\s+SET first_unmatched_at = NULL/.test(q.sql)),
        'clearRecheck ran on the uncertain row');
      // ...and advanceRecheck did NOT run (no stale advance of an off-booli_only row).
      assert.ok(!c.calls.some((q) => /SET next_recheck_at = \$2/.test(q.sql)),
        'advanceRecheck must NOT run on an uncertain row');
    });

    // 7. runRecheck: unknown segment skipped (matchOne never called).
    await checkAsync('runRecheck: unknown segment skipped', async () => {
      const c = mockClient();
      c.rowsToReturn = [{ booli_id: 1, segment: 'nope', evidence: {} }];
      let matchCalls = 0;
      const summary = await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: { matchOne: async () => { matchCalls++; return 'matched'; }, loadBooliRecord: async () => ({ booli_id: 1 }) },
      });
      assert.strictEqual(summary.rechecked, 0, 'rechecked 0 (skipped)');
      assert.strictEqual(matchCalls, 0, 'matchOne never called for unknown segment');
    });

    // 8. settleExpired: in-window -> settles nothing.
    await checkAsync('settleExpired: in-window settles nothing', async () => {
      const c = mockClient();
      const r = await settleExpired(c, { now: T_DUE, deps: { fetchExpired: async () => [] } });
      assert.strictEqual(r.settledNonHemnet, 0, 'nothing settled before the window');
    });

    // 9. settleExpired: past window -> settles to genuine_non_hemnet.
    await checkAsync('settleExpired: past window settles to genuine_non_hemnet', async () => {
      const c = mockClientRowCount1();
      const r = await settleExpired(c, { now: T_EXPIRED, deps: { fetchExpired: async () => [{ booli_id: 1 }] } });
      assert.strictEqual(r.settledNonHemnet, 1, 'one row settled');
      assert.ok(c.calls.some((q) => /verdict = 'genuine_non_hemnet'/.test(q.sql)),
        'settleNonHemnet ran with the terminal verdict');
    });

    // 10. full lifecycle: enroll(T0) -> recheck still-pending(T_DUE) -> settle(T_EXPIRED).
    await checkAsync('full lifecycle enroll -> recheck -> settle', async () => {
      const c = mockClientRowCount1();
      // enroll
      const e = await enrollUnmatched(c, { now: T0, rows: [{ booli_id: 1 }] });
      assert.strictEqual(e.enrolled, 1, 'enrolled 1');
      // recheck (still pending)
      c.rowsToReturn = [{ booli_id: 1, segment: 'taby-villa', evidence: {} }];
      const rr = await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: { matchOne: async () => 'booli_only', loadBooliRecord: async () => ({ booli_id: 1 }) },
      });
      assert.strictEqual(rr.stillPending, 1, 'stillPending 1');
      // settle (past window)
      c.rowsToReturn = [];
      const s = await settleExpired(c, { now: T_EXPIRED, deps: { fetchExpired: async () => [{ booli_id: 1 }] } });
      assert.strictEqual(s.settledNonHemnet, 1, 'settledNonHemnet 1');
    });

    // 11. CeilingError from matchOne propagates (batch ceiling can still stop the drain).
    await checkAsync('CeilingError from matchOne propagates', async () => {
      const c = mockClient();
      c.rowsToReturn = [{ booli_id: 1, segment: 'taby-villa', evidence: {} }];
      class CeilingError extends Error { constructor(m) { super(m); this.name = 'CeilingError'; } }
      await assert.rejects(
        () => runRecheck(c, {
          now: T_DUE,
          segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
          deps: {
            matchOne: async () => { throw new CeilingError('spend ceiling hit'); },
            loadBooliRecord: async () => ({ booli_id: 1 }),
          },
        }),
        /spend ceiling hit/,
        'runRecheck must re-throw the CeilingError'
      );
    });

    // 12. D-16 lever OFF (default) → SOLD_MATCH_BRIDGE untouched across a re-check
    //     (regression guard: the full-fidelity drain leaves the env exactly as it found it).
    await checkAsync('D-16 lever OFF: SOLD_MATCH_BRIDGE untouched during re-check', async () => {
      const c = mockClient();
      // an INTERMEDIATE attempt (recheck_until far in the future): with the lever OFF
      // the bridge must NOT be suppressed.
      c.rowsToReturn = [{
        booli_id: 1, segment: 'taby-villa', evidence: {},
        recheck_until: '2099-01-01T00:00:00.000Z',
      }];
      const prev = process.env.SOLD_MATCH_BRIDGE;
      process.env.SOLD_MATCH_BRIDGE = '1';
      let bridgeAtCall = null;
      await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: {
          bridgeFinalOnly: false, // lever OFF
          matchOne: async () => { bridgeAtCall = process.env.SOLD_MATCH_BRIDGE; return 'booli_only'; },
          loadBooliRecord: async () => ({ booli_id: 1 }),
        },
      });
      assert.strictEqual(bridgeAtCall, '1', 'bridge stays ON during matchOne (lever OFF)');
      assert.strictEqual(process.env.SOLD_MATCH_BRIDGE, '1', 'bridge env unchanged after');
      if (prev === undefined) delete process.env.SOLD_MATCH_BRIDGE;
      else process.env.SOLD_MATCH_BRIDGE = prev;
    });

    // 13. D-16 lever ON + INTERMEDIATE attempt → SOLD_MATCH_BRIDGE is '0' DURING the
    //     matchOne call and RESTORED to its prior value AFTER.
    await checkAsync('D-16 lever ON + intermediate: bridge suppressed during call, restored after', async () => {
      const c = mockClient();
      c.rowsToReturn = [{
        booli_id: 1, segment: 'taby-villa', evidence: {},
        recheck_until: '2099-01-01T00:00:00.000Z', // far future → NOT final attempt
      }];
      const prev = process.env.SOLD_MATCH_BRIDGE;
      process.env.SOLD_MATCH_BRIDGE = '1';
      let bridgeAtCall = null;
      await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: {
          bridgeFinalOnly: true, // lever ON
          matchOne: async () => { bridgeAtCall = process.env.SOLD_MATCH_BRIDGE; return 'booli_only'; },
          loadBooliRecord: async () => ({ booli_id: 1 }),
        },
      });
      assert.strictEqual(bridgeAtCall, '0', 'bridge SUPPRESSED (0) during intermediate matchOne');
      assert.strictEqual(process.env.SOLD_MATCH_BRIDGE, '1', 'bridge env RESTORED to 1 after');
      if (prev === undefined) delete process.env.SOLD_MATCH_BRIDGE;
      else process.env.SOLD_MATCH_BRIDGE = prev;
    });

    // 13b. D-16 lever ON + FINAL attempt → bridge runs (not suppressed) on the last
    //      in-window attempt before settle.
    await checkAsync('D-16 lever ON + final attempt: bridge runs (not suppressed)', async () => {
      const c = mockClient();
      // recheck_until just after T_DUE so the next scheduled attempt (T_DUE + interval)
      // lands at/after recheck_until → FINAL attempt.
      c.rowsToReturn = [{
        booli_id: 1, segment: 'taby-villa', evidence: {},
        recheck_until: '2026-06-10T00:00:00.000Z', // T_DUE + 7d = 2026-06-16 >= this
      }];
      const prev = process.env.SOLD_MATCH_BRIDGE;
      process.env.SOLD_MATCH_BRIDGE = '1';
      let bridgeAtCall = null;
      await runRecheck(c, {
        now: T_DUE,
        segments: { 'taby-villa': { family: 'HOUSE', hemnet: {} } },
        deps: {
          bridgeFinalOnly: true, // lever ON
          matchOne: async () => { bridgeAtCall = process.env.SOLD_MATCH_BRIDGE; return 'booli_only'; },
          loadBooliRecord: async () => ({ booli_id: 1 }),
        },
      });
      assert.strictEqual(bridgeAtCall, '1', 'bridge ON during FINAL attempt even with lever ON');
      if (prev === undefined) delete process.env.SOLD_MATCH_BRIDGE;
      else process.env.SOLD_MATCH_BRIDGE = prev;
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
