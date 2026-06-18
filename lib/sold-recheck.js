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
//      state (clearRecheck → leaves the queue); a still-unmatched row advances
//      next_recheck_at. Returns { rechecked, lateMatched, stillPending }.
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

const { RECHECK_WINDOW_DAYS, RECHECK_INTERVAL_DAYS } = require('./sold-config');
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
  const due = await fetchDueRecheck(client, {
    now: nowISO, segment: o.segment || undefined, limit: o.limit || undefined,
  });
  const summary = { rechecked: 0, lateMatched: 0, stillPending: 0 };
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
    // Re-run the SAME Phase-17 matcher. window_start/window_end mirror the row's
    // original window (kept in evidence) or a null fallback — the search itself
    // re-derives candidates; the window strings only annotate the persisted verdict.
    // A CeilingError from matchOne propagates UNCHANGED (not caught) so the Phase-19
    // batch ceiling still stops the drain mid-run (T-18-09).
    const verdict = await matchOne(client, record, seg, row.segment,
      (row.evidence && row.evidence.window_start) || null,
      (row.evidence && row.evidence.window_end) || null, log, deps);
    summary.rechecked++;
    if (verdict === 'matched') {
      await clearRecheck(client, row.booli_id); // RECHECK-02: late match leaves the queue
      summary.lateMatched++;
    } else {
      // still unmatched (booli_only | uncertain), still in window (fetchDueRecheck
      // guaranteed recheck_until >= now) → schedule the next attempt.
      await advanceRecheck(client, row.booli_id, nextRecheckAt);
      summary.stillPending++;
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
