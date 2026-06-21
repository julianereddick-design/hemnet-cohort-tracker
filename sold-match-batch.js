process.env.SCRAPE_FORCE_OXYLABS = '1';   // FIRST executable line — sold-transport load guard (D-02)
process.env.SOLD_MATCH_BRIDGE = '1';      // D-05: bridge on for first-pass match AND re-check matchOne
require('dotenv').config();

'use strict';

// sold-match-batch.js — Phase 19 "Sold match batch" scheduled orchestrator
// (SCHED-01 / SCHED-02 / RECHECK-02 cadence; D-02..D-17).
//
// Under cron-wrapper.runJob, a single in-process run:
//   - no-ops on ODD ISO weeks (fortnightly cadence, D-14): logs skipped:true,
//     reason:'off-week' and returns early; acts only on even ISO weeks;
//   - otherwise calls the Plan 19-01 national sampler (sampleNational) ONCE,
//   - runs matchOne per sampled record using that record's tagged seg,
//   - then runs the Phase-18 re-check drain (enroll -> recheck -> settle) on the
//     real clock, injecting the runner's real matchOne,
//   - all under ONE batch-wide Oxylabs spend ceiling (setSpendClient called once),
//   - and fails safe: validate() returns a non-null Slack string on a ceiling stop,
//     a fatal sampler/match error, excess fetchFailures, or an incomplete run, rather
//     than silently logging a partial run as success (D-07).
//
// In-process (NOT child-process spawning) is mandatory so all work shares ONE setSpendClient
// DB-atomic ceiling (D-03/D-06). The orchestrator issues exactly ONE read-only raw
// SELECT (the booli_only enrollment query); all writes go through matchOne / the
// parameterized recheck helpers (D-03 invariant).
//
//   node sold-match-batch.js            # production run (via runJob; needs DB + Oxylabs)
//   node sold-match-batch.js --smoke    # offline self-test (no DB, no network)

const { runJob } = require('./cron-wrapper');
const sampler = require('./lib/sold-sample');           // { sampleNational }
const runner = require('./scripts/sold-match-run');     // { matchOne }
const { setSpendClient, CeilingError, spentCallsAsync } = require('./lib/sold-transport');
const recheck = require('./lib/sold-recheck');          // { enrollUnmatched, runRecheck, settleExpired }

// FETCH_FAIL_THRESHOLD — small fail-safe bound (D-07). Excess fetch failures escalate.
const FETCH_FAIL_THRESHOLD = parseInt(process.env.SOLD_BATCH_FETCH_FAIL_THRESHOLD || '5', 10);

// ---------------------------------------------------------------------------
// deps indirection — every pipeline piece is called through deps.* so the offline
// --smoke can stub the whole orchestrator without a DB or network. Production uses
// the real exports; the smoke overwrites these before calling main(mockClient, noLog).
// ---------------------------------------------------------------------------
const deps = {
  sampleNational: sampler.sampleNational,
  matchOne: runner.matchOne,
  setSpendClient,
  spentCallsAsync,
  enrollUnmatched: recheck.enrollUnmatched,
  runRecheck: recheck.runRecheck,
  settleExpired: recheck.settleExpired,
  now: undefined, // injected ISO clock for the smoke (drives the week gate AND the drain)
};

// ---------------------------------------------------------------------------
// isoWeekNumber(date) — Thursday-anchored ISO-8601 week number (int). Modeled on
// cohort-spotcheck-gate.js isoWeekId() but returns the integer so we can gate on
// even/odd parity. Even week → run; odd week → no-op (D-14 fortnightly).
// ---------------------------------------------------------------------------
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;          // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);  // shift to Thursday of this ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ---------------------------------------------------------------------------
// isoWeekKey(date) — the ISO-week-year-anchored key (e.g. "2026-W26") used to scope
// the DB spend ceiling to a single fortnight (GL-01). The year is the Thursday's
// calendar year (ISO-week-year) so week 52/53 of one year never collides with the
// same week number of the next.
// ---------------------------------------------------------------------------
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);  // Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  return `${isoYear}-W${String(isoWeekNumber(date)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// main(client, log) — D-03..D-09. Returns the result_summary (JSONB in cron_job_log).
// ---------------------------------------------------------------------------
async function main(client, log) {
  log = log || (() => {});
  const nowDate = deps.now ? new Date(deps.now) : new Date();
  const isoWeek = isoWeekNumber(nowDate);

  // D-14 fortnightly: no-op on ODD ISO weeks. Do NOT touch the ceiling, sampler, or drain.
  if (isoWeek % 2 !== 0) {
    log('INFO', `off-week (ISO week ${isoWeek} is odd) — skipping fortnightly batch`);
    return { skipped: true, reason: 'off-week', isoWeek, slackMsg: null };
  }

  // GL-01: scope the DB spend ceiling to THIS fortnight. The DB tally keys on
  // SOLD_SPEND_KEY (default 'sold-global') and NEVER resets — a fixed key would make
  // `calls` accumulate across every fortnightly run and permanently jam at
  // MAX_OXY_CALLS after ~1 month. A per-fortnight key gives each even-week run a fresh
  // budget; a resume WITHIN the same fortnight (after a ceiling stop + raised
  // MAX_OXY_CALLS) keeps counting toward the same key, so the idempotent re-run does
  // not double-spend the ceiling. An operator-set SOLD_SPEND_KEY still overrides.
  if (!process.env.SOLD_SPEND_KEY) {
    process.env.SOLD_SPEND_KEY = `sold-batch-${isoWeekKey(nowDate)}`;
    log('INFO', `spend ceiling scoped to key sold-batch-${isoWeekKey(nowDate)}`);
  }

  // D-06: ONE batch-wide ceiling. setSpendClient ONCE, BEFORE any sample/match work.
  deps.setSpendClient(client);

  let batchStoppedBy = null;
  let fatalError = null;
  let queue = [];
  let sampleStats = {};

  // 1) National sampler — ONE call (D-13). CeilingError → batch ceiling stop; any other
  //    error → fatal (do not proceed to the match loop).
  try {
    const res = await deps.sampleNational({ client, log, deps: { now: deps.now } });
    queue = (res && res.queue) || [];
    sampleStats = (res && res.stats) || {};
  } catch (e) {
    if (e instanceof CeilingError) {
      batchStoppedBy = 'ceiling';
      log('WARN', `sampler hit ceiling: ${e.message}`);
    } else {
      fatalError = `sampler error: ${e && e.message}`;
      log('ERROR', fatalError);
    }
  }

  // 2) Match loop — matchOne per sampled record using record.seg. CeilingError stops the
  //    batch; a non-ceiling error counts as an error verdict (belt-and-suspenders —
  //    matchOne already returns booli_only on its own internal errors).
  // Window the sampler actually drew (lib/sold-sample.js stats.window) — pass it into matchOne so
  // verdict rows carry window_end. Without this, batch rows get window_end=NULL and the standard
  // report/xlsx/chart (which filter `WHERE window_end >= date`) silently drop all batch output.
  const win = (sampleStats && sampleStats.window) || {};
  const totals = { matched: 0, booli_only: 0, uncertain: 0, error: 0 };
  let recordsMatched = 0;
  const recordsTotal = queue.length;
  // Bounded worker pool (mirrors runSegment in scripts/sold-match-run.js). The match work is
  // I/O-bound on Oxylabs latency, so a sequential loop made the ~1000-record national run take
  // ~4h. Workers share the ONE pg client (node-pg serialises its queries internally) and the
  // DB-atomic spend ceiling, so only the Oxylabs fetching runs concurrently — cutting the run to
  // ~40-60 min. Concurrency via SOLD_BATCH_CONC (default 6). On a CeilingError the flag stops the
  // pool; up to CONC in-flight matches may finish first (harmless — matchOne re-throws cleanly).
  const CONC = Math.max(1, parseInt(process.env.SOLD_BATCH_CONC || '6', 10));
  if (!batchStoppedBy && !fatalError) {
    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        if (batchStoppedBy) return;
        const record = queue[idx++];
        try {
          const v = await deps.matchOne(
            client, record, record.seg, record.segment, win.minSoldDate || null, win.maxSoldDate || null, log,
          );
          if (v === 'matched' || v === 'booli_only' || v === 'uncertain') totals[v]++;
          else totals.error++;
          recordsMatched++;
        } catch (e) {
          if (e instanceof CeilingError) {
            batchStoppedBy = 'ceiling';
            log('WARN', `match loop hit ceiling: ${e.message}`);
            return;
          }
          totals.error++;
          recordsMatched++;
          log('ERROR', `matchOne booli_id=${record && record.booli_id}: ${e && e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONC }, () => worker()));
  }

  // 3) Re-check drain — only on a clean match pass (not stopped, not fatal). Real clock.
  //    Build the segments map from this run's queue so runRecheck can rebuild a due row's
  //    seg. A CeilingError here → batchStoppedBy='ceiling' (runRecheck re-throws it).
  const recheckBlock = {
    enrolled: 0, rechecked: 0, lateMatched: 0, stillPending: 0, uncertain: 0, settled: 0,
  };
  if (!batchStoppedBy && !fatalError) {
    const now = deps.now ? new Date(deps.now) : new Date();
    try {
      // D-08: the single read-only enrollment SELECT (the only raw SQL in this file).
      const rows = (await client.query(
        `SELECT booli_id FROM sold_match WHERE verdict = 'booli_only' AND first_unmatched_at IS NULL`,
      )).rows;
      const segments = {};
      for (const r of queue) segments[r.segment] = r.seg;

      const e = await deps.enrollUnmatched(client, { now, rows });
      recheckBlock.enrolled = (e && e.enrolled) || 0;

      const rr = await deps.runRecheck(client, {
        now, log, segments, deps: { matchOne: deps.matchOne },
      });
      recheckBlock.rechecked = (rr && rr.rechecked) || 0;
      recheckBlock.lateMatched = (rr && rr.lateMatched) || 0;
      recheckBlock.stillPending = (rr && rr.stillPending) || 0;
      recheckBlock.uncertain = (rr && rr.uncertain) || 0;

      const s = await deps.settleExpired(client, { now });
      recheckBlock.settled = (s && s.settledNonHemnet) || 0;
    } catch (e) {
      if (e instanceof CeilingError) {
        batchStoppedBy = 'ceiling';
        log('WARN', `re-check drain hit ceiling: ${e.message}`);
      } else {
        fatalError = `recheck error: ${e && e.message}`;
        log('ERROR', fatalError);
      }
    }
  }

  const adjudicated = totals.matched + totals.booli_only + totals.uncertain + totals.error;
  const matchRate = adjudicated ? totals.matched / adjudicated : 0;
  const fetchFailures = sampleStats.fetchFailures || 0;
  let oxylabsSpent = 0;
  try { oxylabsSpent = await deps.spentCallsAsync(); } catch (_) { oxylabsSpent = 0; }

  const slackMsg = buildSlackMsg({
    batchStoppedBy, fatalError, fetchFailures, recordsMatched, recordsTotal,
    totals, matchRate, recheckBlock, oxylabsSpent,
  });

  return {
    skipped: false,
    isoWeek,
    sample: sampleStats,
    batchTotals: { ...totals, matchRate },
    recheck: recheckBlock,
    oxylabsSpent,
    batchStoppedBy,
    fatalError,
    fetchFailures,
    recordsMatched,
    recordsTotal,
    slackMsg,
  };
}

// buildSlackMsg — a concise pre-rendered escalation string when something went wrong;
// null on a clean full run. validate() prefers this string.
function buildSlackMsg(s) {
  const reasons = [];
  if (s.batchStoppedBy) reasons.push(`batch stopped on ${s.batchStoppedBy}`);
  if (s.fatalError) reasons.push(s.fatalError);
  if (s.fetchFailures > FETCH_FAIL_THRESHOLD) reasons.push(`fetchFailures=${s.fetchFailures} > ${FETCH_FAIL_THRESHOLD}`);
  if (s.recordsMatched < s.recordsTotal) reasons.push(`incomplete match pass (${s.recordsMatched}/${s.recordsTotal})`);
  if (!reasons.length) return null;
  return `sold-match-batch: ${reasons.join('; ')} `
    + `(matched=${s.totals.matched} booli_only=${s.totals.booli_only} uncertain=${s.totals.uncertain} `
    + `error=${s.totals.error} matchRate=${(s.matchRate * 100).toFixed(1)}% oxylabsSpent=${s.oxylabsSpent})`;
}

// ---------------------------------------------------------------------------
// validate(summary) — D-07 fail-safe. Non-null string → cron-wrapper posts to Slack
// (status=warning). null → clean (status=success). A clean off-week skip is NOT an
// escalation (returns null).
// ---------------------------------------------------------------------------
function validate(summary) {
  if (!summary) return null;
  if (summary.skipped) return null; // clean off-week no-op
  if (summary.batchStoppedBy) return summary.slackMsg || `sold-match-batch stopped on ${summary.batchStoppedBy}`;
  if (summary.fatalError) return summary.slackMsg || summary.fatalError;
  if ((summary.fetchFailures || 0) > FETCH_FAIL_THRESHOLD) {
    return summary.slackMsg || `sold-match-batch: fetchFailures ${summary.fetchFailures} > ${FETCH_FAIL_THRESHOLD}`;
  }
  if ((summary.recordsMatched || 0) < (summary.recordsTotal || 0)) {
    return summary.slackMsg || `sold-match-batch: incomplete match pass (${summary.recordsMatched}/${summary.recordsTotal})`;
  }
  return null;
}

module.exports = { main, validate, isoWeekNumber, deps };

// ---------------------------------------------------------------------------
// Entry gate (D-02 / D-10): --smoke runs the offline self-test; otherwise runJob.
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  runSmoke();
} else if (require.main === module) {
  runJob({ scriptName: 'sold-match-batch', main, validate });
}

// ---------------------------------------------------------------------------
// --smoke self-test — fully offline (no DB, no network, no real sampler/matchOne).
//   node sold-match-batch.js --smoke
// Stubs the whole pipeline via the module-level `deps` + a mock pg client + an
// injected ISO clock (even OR odd week). Zero Oxylabs, zero live DB.
// ---------------------------------------------------------------------------
function runSmoke() {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  const noLog = () => {};
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // Mock pg client: records every {sql, params}; SELECT returns rowsToReturn.
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

  // A queue of two sampled records carrying seg + segment + family.
  function sampleQueue() {
    return [
      {
        booli_id: 1, segment: 'Stockholm:APARTMENT', family: 'APARTMENT',
        seg: { family: 'APARTMENT', booli: { areaIds: 1, objectType: 'Lägenhet' }, hemnet: { locationId: 18031, itemType: 'bostadsratt' } },
      },
      {
        booli_id: 2, segment: 'Täby:HOUSE', family: 'HOUSE',
        seg: { family: 'HOUSE', booli: { areaIds: 20, objectType: 'Hus' }, hemnet: { locationId: 17793, itemType: null } },
      },
    ];
  }

  // Save the real deps so each check can restore them.
  const realDeps = { ...deps };
  function resetDeps() { Object.assign(deps, realDeps); deps.now = undefined; }

  // Fixed clocks. 2026-06-15 (Mon) is ISO week 25 (ODD); 2026-06-22 (Mon) is week 26 (EVEN).
  const EVEN_WEEK = '2026-06-22T08:00:00.000Z'; // ISO week 26 (even)
  const ODD_WEEK = '2026-06-15T08:00:00.000Z';  // ISO week 25 (odd)

  (async () => {
    // sanity: confirm the week parities used by the gate checks.
    check('clock parity sanity (even/odd weeks chosen correctly)', () => {
      assert.strictEqual(isoWeekNumber(new Date(EVEN_WEEK)) % 2, 0, 'EVEN_WEEK is even');
      assert.strictEqual(isoWeekNumber(new Date(ODD_WEEK)) % 2, 1, 'ODD_WEEK is odd');
    });

    // 1. even-week run drives sampler -> match for ALL sampled records.
    await checkAsync('even-week run drives sampler->match for ALL sampled records', async () => {
      resetDeps();
      let sampleCalls = 0;
      let matchCalls = 0;
      deps.now = EVEN_WEEK;
      deps.sampleNational = async () => { sampleCalls++; return { queue: sampleQueue(), stats: { allocated: 2, fetched: 5, deedsExcluded: 1, dupsExcluded: 1, fetchFailures: 0 } }; };
      deps.matchOne = async () => { matchCalls++; return 'matched'; };
      deps.setSpendClient = () => {};
      deps.spentCallsAsync = async () => 42;
      deps.enrollUnmatched = async () => ({ enrolled: 0 });
      deps.runRecheck = async () => ({ rechecked: 0, lateMatched: 0, stillPending: 0, uncertain: 0 });
      deps.settleExpired = async () => ({ settledNonHemnet: 0 });
      const c = mockClient();
      const summary = await main(c, noLog);
      assert.strictEqual(sampleCalls, 1, 'sampler called once');
      assert.strictEqual(matchCalls, 2, 'matchOne called once per queued record');
      assert.strictEqual(summary.skipped, false, 'not skipped on even week');
      resetDeps();
    });

    // 2. odd-week no-op.
    await checkAsync('odd-week no-op (no sampler/match, validate null)', async () => {
      resetDeps();
      let sampleCalls = 0;
      let matchCalls = 0;
      deps.now = ODD_WEEK;
      deps.sampleNational = async () => { sampleCalls++; return { queue: [], stats: {} }; };
      deps.matchOne = async () => { matchCalls++; return 'matched'; };
      let spendCalls = 0;
      deps.setSpendClient = () => { spendCalls++; };
      const c = mockClient();
      const summary = await main(c, noLog);
      assert.strictEqual(summary.skipped, true, 'skipped on odd week');
      assert.strictEqual(summary.reason, 'off-week', "reason 'off-week'");
      assert.strictEqual(sampleCalls, 0, 'sampler NOT called on odd week');
      assert.strictEqual(matchCalls, 0, 'matchOne NOT called on odd week');
      assert.strictEqual(spendCalls, 0, 'setSpendClient NOT called on odd week');
      assert.strictEqual(validate(summary), null, 'clean skip is NOT an escalation');
      resetDeps();
    });

    // 3. single shared ceiling: setSpendClient once, BEFORE the first sampleNational.
    await checkAsync('single shared ceiling (setSpendClient once, before sampler)', async () => {
      resetDeps();
      const order = [];
      deps.now = EVEN_WEEK;
      deps.setSpendClient = () => { order.push('setSpendClient'); };
      deps.sampleNational = async () => { order.push('sampleNational'); return { queue: sampleQueue(), stats: { fetchFailures: 0 } }; };
      deps.matchOne = async () => 'matched';
      deps.spentCallsAsync = async () => 0;
      deps.enrollUnmatched = async () => ({ enrolled: 0 });
      deps.runRecheck = async () => ({ rechecked: 0, lateMatched: 0, stillPending: 0, uncertain: 0 });
      deps.settleExpired = async () => ({ settledNonHemnet: 0 });
      const c = mockClient();
      await main(c, noLog);
      const spendCount = order.filter((x) => x === 'setSpendClient').length;
      assert.strictEqual(spendCount, 1, 'setSpendClient called exactly once');
      assert.ok(order.indexOf('setSpendClient') < order.indexOf('sampleNational'),
        'setSpendClient before sampleNational');
      resetDeps();
    });

    // 4. re-check pass runs after the match loop with a segments map from the queue.
    await checkAsync('re-check pass runs after match loop (segments map from queue)', async () => {
      resetDeps();
      const order = [];
      let segmentsSeen = null;
      deps.now = EVEN_WEEK;
      deps.setSpendClient = () => {};
      deps.sampleNational = async () => ({ queue: sampleQueue(), stats: { fetchFailures: 0 } });
      deps.matchOne = async () => { order.push('match'); return 'booli_only'; };
      deps.spentCallsAsync = async () => 0;
      deps.enrollUnmatched = async () => { order.push('enroll'); return { enrolled: 1 }; };
      deps.runRecheck = async (client, opts) => { order.push('recheck'); segmentsSeen = opts.segments; return { rechecked: 1, lateMatched: 0, stillPending: 1, uncertain: 0 }; };
      deps.settleExpired = async () => { order.push('settle'); return { settledNonHemnet: 0 }; };
      const c = mockClient();
      await main(c, noLog);
      assert.ok(order.lastIndexOf('match') < order.indexOf('enroll'), 'enroll after last match');
      assert.deepStrictEqual(order.slice(-3), ['enroll', 'recheck', 'settle'], 'enroll->recheck->settle order');
      assert.ok(segmentsSeen && segmentsSeen['Stockholm:APARTMENT'] && segmentsSeen['Täby:HOUSE'],
        'segments map built from the queue');
      resetDeps();
    });

    // 5. validate escalates on ceiling/fatal; null on clean.
    await checkAsync('validate escalates on ceiling/fatal, null on clean', async () => {
      assert.ok(validate({ skipped: false, batchStoppedBy: 'ceiling', recordsMatched: 1, recordsTotal: 2, slackMsg: 'x' }), 'ceiling escalates');
      assert.ok(validate({ skipped: false, fatalError: 'boom', recordsMatched: 0, recordsTotal: 0, slackMsg: 'x' }), 'fatal escalates');
      assert.strictEqual(validate({ skipped: false, batchStoppedBy: null, fatalError: null, fetchFailures: 0, recordsMatched: 2, recordsTotal: 2, slackMsg: null }), null, 'clean full run -> null');
    });

    // 6. result_summary shape.
    await checkAsync('result_summary shape', async () => {
      resetDeps();
      deps.now = EVEN_WEEK;
      deps.setSpendClient = () => {};
      deps.sampleNational = async () => ({ queue: sampleQueue(), stats: { allocated: 2, fetched: 5, deedsExcluded: 1, dupsExcluded: 1, fetchFailures: 0 } });
      deps.matchOne = async () => 'matched';
      deps.spentCallsAsync = async () => 99;
      deps.enrollUnmatched = async () => ({ enrolled: 0 });
      deps.runRecheck = async () => ({ rechecked: 0, lateMatched: 0, stillPending: 0, uncertain: 0 });
      deps.settleExpired = async () => ({ settledNonHemnet: 0 });
      const c = mockClient();
      const s = await main(c, noLog);
      assert.ok(s.sample && typeof s.sample === 'object', 'sample stats present');
      for (const k of ['matched', 'booli_only', 'uncertain', 'error', 'matchRate']) {
        assert.ok(k in s.batchTotals, `batchTotals.${k}`);
      }
      for (const k of ['enrolled', 'rechecked', 'lateMatched', 'stillPending', 'uncertain', 'settled']) {
        assert.ok(k in s.recheck, `recheck.${k}`);
      }
      for (const k of ['oxylabsSpent', 'batchStoppedBy', 'fetchFailures', 'recordsMatched', 'recordsTotal', 'slackMsg']) {
        assert.ok(k in s, `summary.${k}`);
      }
      assert.strictEqual(s.oxylabsSpent, 99, 'oxylabsSpent from spentCallsAsync');
      resetDeps();
    });

    // 7. ceiling mid-match stops the batch (2nd record not matched, drain skipped, escalate).
    await checkAsync('ceiling mid-match stops the batch', async () => {
      resetDeps();
      process.env.SOLD_BATCH_CONC = '1'; // force a single worker so the stop is deterministic
      deps.now = EVEN_WEEK;
      deps.setSpendClient = () => {};
      deps.sampleNational = async () => ({ queue: sampleQueue(), stats: { fetchFailures: 0 } });
      let matchCalls = 0;
      let drainCalls = 0;
      deps.matchOne = async () => { matchCalls++; throw new CeilingError('hit'); };
      deps.spentCallsAsync = async () => 0;
      deps.enrollUnmatched = async () => { drainCalls++; return { enrolled: 0 }; };
      deps.runRecheck = async () => { drainCalls++; return { rechecked: 0, lateMatched: 0, stillPending: 0, uncertain: 0 }; };
      deps.settleExpired = async () => { drainCalls++; return { settledNonHemnet: 0 }; };
      const c = mockClient();
      const s = await main(c, noLog);
      assert.strictEqual(s.batchStoppedBy, 'ceiling', "batchStoppedBy='ceiling'");
      assert.strictEqual(matchCalls, 1, 'matchOne NOT called for the 2nd record (conc=1)');
      assert.strictEqual(drainCalls, 0, 're-check drain skipped on ceiling stop');
      assert.ok(validate(s), 'validate escalates on ceiling stop');
      delete process.env.SOLD_BATCH_CONC;
      resetDeps();
    });

    // 8. ceiling in the sampler stops the batch (no match loop, escalate).
    await checkAsync('ceiling in the sampler stops the batch', async () => {
      resetDeps();
      deps.now = EVEN_WEEK;
      deps.setSpendClient = () => {};
      deps.sampleNational = async () => { throw new CeilingError('sampler ceiling'); };
      let matchCalls = 0;
      deps.matchOne = async () => { matchCalls++; return 'matched'; };
      deps.spentCallsAsync = async () => 0;
      const c = mockClient();
      const s = await main(c, noLog);
      assert.strictEqual(s.batchStoppedBy, 'ceiling', "batchStoppedBy='ceiling' from sampler");
      assert.strictEqual(matchCalls, 0, 'no match loop after sampler ceiling');
      assert.ok(validate(s), 'validate escalates');
      resetDeps();
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
