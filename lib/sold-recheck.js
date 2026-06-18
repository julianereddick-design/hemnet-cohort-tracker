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

module.exports = {
  toISO, addDaysISO, enrollUnmatched, settleExpired,
};
