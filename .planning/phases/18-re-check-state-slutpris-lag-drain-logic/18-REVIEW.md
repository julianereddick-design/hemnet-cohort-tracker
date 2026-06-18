---
phase: 18-re-check-state-slutpris-lag-drain-logic
reviewed: 2026-06-18T00:00:00Z
depth: deep
files_reviewed: 4
files_reviewed_list:
  - migrate-sold-recheck-phase18.js
  - lib/sold-config.js
  - lib/sold-store.js
  - lib/sold-recheck.js
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 18: Code Review Report

**Reviewed:** 2026-06-18
**Depth:** deep (cross-file: traced runRecheck → matchOne → persistMapped → upsertSoldVerdict, and the store verdict guards)
**Files Reviewed:** 4
**Status:** issues_found (advisory / non-blocking)

## Summary

Phase 18 adds the re-check drain: an idempotent migration (3 nullable TIMESTAMPTZ
columns), validated config window/interval, 5 parameterized store helpers, and a
clock-injected orchestrator that re-uses Phase-17 `matchOne`. The codebase
invariants the prompt called out are all upheld:

- **SQL parameterization:** Every query uses `$1,$2,...`. The only string-built
  fragment in `fetchDueRecheck` is the placeholder *index* (`$${params.length}`),
  never a value. No `${}` value interpolation anywhere. PASS.
- **Migration idempotency:** `ADD COLUMN IF NOT EXISTS` x3, additive only, with a
  parameterized read-back verify. Re-runnable. PASS.
- **Spend safety:** `--smoke` injects `matchOne`/`loadBooliRecord`/`fetchExpired`
  stubs and a mock pg client; the runner (which sets `SCRAPE_FORCE_OXYLABS`) is
  lazily required only when no stub is supplied. The three offline smokes run with
  zero network/DB (verified: 25 + 25 + 11 pass). PASS.
- **Clock/window math:** Pure UTC-ms arithmetic on ISO strings (`n * 86400000`);
  TIMESTAMPTZ stores absolute instants so there is no timezone/DST hazard, and the
  unit is correctly days→ms. `recheck_until = now + WINDOW`, `next_recheck_at = now
  + INTERVAL`. Due/expired boundaries (`recheck_until >= now` vs `< now`) are
  complementary — no gap, no double-processing. PASS.

One real correctness gap remains: the drain handles only the `matched` /
`booli_only` outcomes of `matchOne`, but `matchOne` has a live third return value,
`uncertain`. A re-check that returns `uncertain` strands the row in a non-terminal,
never-cleared, never-settled state (WR-01). The rest are robustness/quality notes.

## Warnings

> **RESOLVED 2026-06-18 (commit 34df402):** `runRecheck` now branches `matched` /
> `booli_only` / else-`uncertain`. Uncertain → `clearRecheck` (drops scheduling state,
> exits the auto-drain) + `summary.uncertain++` — never auto-settled (identity-model:
> uncertain routes to human review). Folded in WR-03 (`clearRecheck` guarded
> `verdict <> 'booli_only'`) and IN-02 (stillPending from `advanceRecheck` rowCount).
> Recheck smoke 12/12 (new uncertain-path test), store 25/25, runner 18/18.

### WR-01: `uncertain` re-check verdict strands the row — never advanced, never settled, never cleared

**File:** `lib/sold-recheck.js:166-174` (cross-file with `scripts/sold-match-run.js:286-288,335-337` and `lib/sold-store.js:169-176,183-191`)

**Issue:** `runRecheck` branches only two ways:
```js
if (verdict === 'matched') { await clearRecheck(...); ... }
else { await advanceRecheck(...); ... }   // assumes "else" === still booli_only
```
But `matchOne` returns three values — `matched`, `booli_only`, and **`uncertain`**
(HOUSE multi-candidate / CONFIRMED_MATCH-demoted branch at sold-match-run.js:286-288;
APARTMENT non-exact branch at 335-337). When a due `booli_only` row re-checks to
`uncertain`:
1. `matchOne` → `persistMapped` → `upsertSoldVerdict` runs `ON CONFLICT (booli_id)
   DO UPDATE SET verdict = EXCLUDED.verdict`, so the row's verdict flips to
   `uncertain` (the scheduling columns are NOT touched by that upsert, so they
   persist with stale values).
2. Back in `runRecheck`, `verdict !== 'matched'` → `advanceRecheck`, whose WHERE is
   `verdict = 'booli_only'`. The row is now `uncertain` → **rowCount 0, no-op**.
   `summary.stillPending` is incremented anyway, so the count is also wrong.
3. The row now has verdict `uncertain` with stale `first_unmatched_at` /
   `recheck_until` / un-advanced `next_recheck_at`. `fetchDueRecheck`
   (`verdict='booli_only'`) will never return it again, and `settleExpired`
   (`verdict='booli_only'`) will never settle it. It silently leaves the queue but
   in a non-terminal limbo with leaked scheduling state.

This is the terminal-state correctness property the phase is supposed to guarantee.
The smoke never exercises it (stubs return only `matched` / `booli_only` —
sold-recheck.js:302,319,381), so the gap is untested.

**Fix:** Treat `uncertain` explicitly. Either clear the scheduling columns (it has
left the actionable `booli_only` set) or keep it on a schedule with an
uncertain-aware guard. Minimal version — clear on any non-`booli_only` outcome:
```js
summary.rechecked++;
if (verdict === 'matched') {
  await clearRecheck(client, row.booli_id);
  summary.lateMatched++;
} else if (verdict === 'booli_only') {
  await advanceRecheck(client, row.booli_id, nextRecheckAt);
  summary.stillPending++;
} else { // 'uncertain' (or any future verdict) — no longer booli_only
  await clearRecheck(client, row.booli_id); // drop stale scheduling state
  summary.stillPending++; // or a new summary.uncertain bucket
}
```
(If business intent is to keep re-checking `uncertain` rows, instead widen the
`advanceRecheck` / `fetchDueRecheck` / `settleExpired` guards to
`verdict IN ('booli_only','uncertain')` — but that is a larger decision; clearing is
the safe default that prevents the limbo state.)

### WR-02: `runRecheck` re-stamps `adjudicated_at` from the real clock, not the injected clock

**File:** `lib/sold-recheck.js:162-164` → `scripts/sold-match-run.js:169`

**Issue:** Every re-check calls `matchOne`, which in `persistMapped` sets
`adjudicated_at: new Date().toISOString()` (sold-match-run.js:169). So a re-check
that produces `booli_only` again still rewrites `adjudicated_at` to wall-clock time,
bypassing the phase's injected-clock discipline. `settleNonHemnet` does pass the
injected `nowISO` (sold-recheck.js:102), but the still-pending re-check path does
not. In a back-dated replay / deterministic test of the full drain, `adjudicated_at`
will diverge from the injected timeline. Not a queue-state bug (scheduling columns
are correct), but it undermines the "no bare `new Date()` in the date-math paths"
guarantee stated in this file's own header (sold-recheck.js:43-45).

**Fix:** Out of scope to change Phase-17 `matchOne` here; document the carve-out, or
thread an optional `now` into `persistMapped` so the re-check path can pass the
injected clock. At minimum, narrow the header comment so it doesn't over-claim
clock purity across the `matchOne` boundary.

### WR-03: `clearRecheck` has no verdict guard — clobbers scheduling state on any row id

**File:** `lib/sold-store.js:196-204`

**Issue:** Unlike `advanceRecheck` / `settleNonHemnet` (both guarded
`AND verdict = 'booli_only'`), `clearRecheck` is unguarded:
`UPDATE sold_match SET ... = NULL WHERE booli_id = $1`. In the current caller it
only fires after a confirmed `matched` verdict (sold-recheck.js:167), so it is safe
*today*. But the helper is exported and reusable; a future caller (or the WR-01 fix
that calls it on `uncertain`) could null the scheduling state of a still-active
`booli_only` row, removing it from the drain. Defense-in-depth: a terminal/cleanup
mutation should assert the state it expects.

**Fix:** Add an expected-state guard, e.g.
`WHERE booli_id = $1 AND verdict <> 'booli_only'` (clear only once the verdict has
moved off the actionable state), or have the caller pass the expected verdict. Keep
returning `rowCount` so callers can detect a no-op.

## Info

### IN-01: `enrollUnmatched` counts `n >= 1` but `enrollRecheck` returns at most 1 row

**File:** `lib/sold-recheck.js:78` / `lib/sold-store.js:157-165`

**Issue:** `enrollRecheck` updates by `WHERE booli_id = $1 AND ...` (booli_id is the
UNIQUE key on sold_match), so `rowCount` is 0 or 1. `if (n >= 1)` is harmless but
slightly misleading about cardinality — `=== 1` documents intent. Same harmless
`>= 1` pattern in `settleExpired` (sold-recheck.js:103). Style only.

**Fix:** Use `=== 1` (or `> 0`) and drop the implied multi-row semantics.

### IN-02: `summary.stillPending` over-counts when `advanceRecheck` is a no-op

**File:** `lib/sold-recheck.js:172-173`

**Issue:** `stillPending` is incremented unconditionally in the else branch, even if
`advanceRecheck` returned `rowCount 0` (which happens today only via the WR-01
`uncertain` path, but also if the row was concurrently settled/cleared between
`fetchDueRecheck` and the update). The machine-readable counts returned for Phase
19/20 can then overstate work done.

**Fix:** Increment based on the helper's `rowCount`, e.g.
`const n = await advanceRecheck(...); if (n) summary.stillPending++; else summary.skipped++;`

### IN-03: `loadBooliRecord` uses `SELECT *` — column-order/shape coupling

**File:** `lib/sold-recheck.js:130`

**Issue:** `SELECT * FROM booli_sold` returns whatever columns the table currently
has and passes the raw row to `matchOne`. It works because `matchOne` reads named
fields, but `SELECT *` couples the re-check to the live schema and can silently pull
columns the matcher doesn't expect. Low risk given the controlled schema; an
explicit column list is more robust and self-documenting.

**Fix:** Enumerate the columns `matchOne` actually consumes (booli_id,
street_address, object_type, sold_price, sold_date, living_area, floor,
residence_url, residence_id, rent, ...), matching the upsert column set.

---

_Reviewed: 2026-06-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
