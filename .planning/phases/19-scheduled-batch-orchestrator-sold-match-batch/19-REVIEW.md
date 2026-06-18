---
phase: 19-sold-match-batch
reviewed: 2026-06-18T00:00:00Z
depth: deep
files_reviewed: 4
files_reviewed_list:
  - lib/sold-sample.js
  - sold-match-batch.js
  - lib/sold-config.js
  - lib/sold-recheck.js
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 19: Code Review Report

**Reviewed:** 2026-06-18
**Depth:** deep (cross-file: traced into lib/sold-fetch-booli.js, lib/sold-store.js, scripts/sold-match-run.js, cron-wrapper.js)
**Files Reviewed:** 4
**Status:** issues_found

## Summary

No BLOCKING (critical) defects. The de-dup query is correctly parameterized (no
injection), the RECHECK_BRIDGE_FINAL_ONLY save/restore is leak-free on every path
including throw, the batch ceiling is installed exactly once before any spend, and
CeilingError propagates and stops the batch from all three stages (sampler, match
loop, re-check drain) with validate() escalating. DB-client lifecycle is owned by
cron-wrapper.runJob (closed in its finally), so the orchestrator holds no leak.

However the review found two genuine correctness gaps the 108 offline assertions do
not cover, both WARNING-class:

1. **The D-07 `fetchFailures` fail-safe is effectively dead in production** — the real
   `fetchBooliSoldPage` swallows every non-Ceiling error internally and returns empty
   cards, so the sampler's failure counter never increments on real fetch failures. A
   whole muni-type silently contributing zero will NOT escalate.
2. **`allocate` violates its own documented `sum(quota) <= target` invariant** by
   per-muni rounding drift (verified: 11 equal munis, target 1000 → 1001). The smoke
   masks it because its fixtures cap every muni below the rounded share.

Plus a fortnightly-cadence parity discontinuity at year boundaries and three minor items.

## Warnings

### WR-01: D-07 `fetchFailures` fail-safe never fires on real fetch failures

**File:** `lib/sold-sample.js:192-203` (and `sold-match-batch.js:208,226`)

**Issue:** The sampler only increments `fetchFailures` inside the `catch` around
`fetchPage(...)` (lines 196-202), and that catch re-throws `CeilingError` (line 199),
so the counter is reached ONLY for a thrown non-Ceiling error. But the production
default `fetchBooliSoldPage` (lib/sold-fetch-booli.js:78-97) catches transport errors,
non-200 statuses, and Apollo-parse failures internally and returns
`{ cards: [], meta: { totalCount: null, pages: null } }` — it never throws except for
CeilingError. Consequently a real Booli outage, Cloudflare block, or parser break makes
a muni-type silently contribute 0 rows with `fetchFailures` stuck at 0. The
`FETCH_FAIL_THRESHOLD` escalation in `buildSlackMsg` (line 208) and `validate` (line 226)
therefore can never trigger in production. The "excess fetchFailures escalate" fail-safe
(D-07) is dead code against the real transport. The smoke only exercises it via injected
throwing stubs, so 108 green assertions hide this.

**Fix:** Detect the swallowed-failure signature (empty cards + null `meta.pages` /
null `meta.totalCount`) as a failed page in the sampler, since that is exactly what the
real fetcher returns on error:
```js
if ((cards || []).length === 0 && (!meta || meta.pages == null)) {
  // distinguishes a genuine empty/error page from a real last page (which carries meta.pages)
  fetchFailures++;
  log('WARN', `sampleNational ${segKey} page=${page} empty/error page`);
  break;
}
```
Alternatively, have `fetchBooliSoldPage` surface a `meta.error` flag the sampler can
count. Note: a genuinely empty feed also has null pages, so this will over-count benign
empties; if that is undesirable, prefer the explicit `meta.error` flag approach so only
true failures escalate.

### WR-02: `allocate` can over-allocate past `target` (rounding drift breaks a documented invariant)

**File:** `lib/sold-sample.js:100` (and the invariant claim at lines 83-84)

**Issue:** Step A computes each muni's share with `Math.round((target * pop) / sumPop)`
independently. Summed across munis these rounded shares can exceed `target`. Verified
empirically: 11 munis each `pop=100` (`sumPop=1100`), `target=1000`, ample live volume →
`round(1000*100/1100)=round(90.9)=91`, `11*91 = 1001` total quota. The header explicitly
promises `sum(quota) <= target` (lines 83-84) and the orchestrator treats the allocation
as the spend envelope, so this both breaks the stated contract and lets the batch run
(and bill Oxylabs for) a few more records than the configured ceiling implies. Smoke
test #6 ("totals bounded", lines 356-369) does NOT catch this because every muni's live
is capped at 60 (30 HOUSE + 30 APARTMENT), which binds the per-muni cap below the rounded
share and absorbs the drift — the over-allocation only appears when live volume exceeds
the population share, which is the normal case for the large munis.

**Fix:** Track the running allocation and clamp the last/each muni so the cumulative sum
never exceeds `target`, e.g. cap `muniTarget` at `target - allocatedSoFar` before the
live cap:
```js
let allocatedSoFar = 0;
// inside the loop, after computing muniTarget:
muniTarget = Math.min(muniTarget, liveTotal, target - allocatedSoFar);
if (muniTarget <= 0) continue;
// ... build houseQuota/aptQuota ...
allocatedSoFar += houseQuota + aptQuota;
```
Then restore the smoke to assert with UNCAPPED live (e.g. live=10000 per type) so the
drift would actually be exercised.

### WR-03: Fortnightly even-week gate has a parity discontinuity at year boundaries

**File:** `sold-match-batch.js:60-66, 77`

**Issue:** `isoWeekNumber` is correct ISO-8601 (Thursday-anchored, handles 53-week
years), but gating on `isoWeek % 2` makes the fortnightly cadence non-continuous across
December→January. Verified: 2025-12-28 = W52 (even, runs), 2026-01-05 = W2 (even, runs)
— but the intervening 2025-12-29..2026-01-04 is W1 (odd, skipped), so a 2-week gap is
preserved there. The problem case is a 53-week year: 2026 ends on W53 (odd), so 2026's
last run is W52 and the next is 2027 W2, but the W53→W1 transition keeps odd→odd, while a
normal W52→W1 transition flips even→odd. Net effect: every year boundary can shift the
run from "every other week" to a 3-week or 1-week interval, and 53-week years invert the
parity for the entire following year (all the weeks that used to be "run" weeks become
"skip" weeks). This will not crash and the run is idempotent, but the operator's expected
biweekly cadence silently drifts and an entire year can flip to the wrong parity.

**Fix:** Gate on a continuous fortnight index instead of intra-year ISO-week parity, e.g.
floor of epoch-days since a fixed anchor Monday divided by 14:
```js
const EPOCH_ANCHOR = Date.UTC(2026, 0, 5); // a known even-week Monday
const fortnight = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - EPOCH_ANCHOR) / (14 * 86400000));
if (fortnight % 2 !== 0) { /* off-week */ }
```
If intra-year ISO-week parity is genuinely the desired semantic, document the
year-boundary drift explicitly in the header comment so it is a known, accepted behavior.

### WR-04: `now` semantics diverge between the gate and the re-check drain

**File:** `sold-match-batch.js:73 vs 142`

**Issue:** The week gate derives `nowDate` once (line 73) from `deps.now`. The re-check
drain re-derives a second `now` (line 142: `deps.now ? new Date(deps.now) : new Date()`).
In production `deps.now` is `undefined`, so the gate and the drain each call `new Date()`
at different instants. For a long batch (the match loop can run hundreds of matchOne
Oxylabs round-trips between the two), the drain's `now` is materially later than the
gate's. This is not wrong per se, but it means `enrollUnmatched`/`settleExpired` window
math is anchored to "end of batch" while the gate decision used "start of batch" — two
different clocks in one logical run. If the batch ever straddles midnight the
enroll/settle boundaries shift by a day relative to the gate. Minor, but the two clocks
should be one captured value.

**Fix:** Capture `nowDate` once at the top of `main` and reuse it for the drain rather
than re-reading the clock:
```js
const nowDate = deps.now ? new Date(deps.now) : new Date();
// ... later, in the drain block:
const now = nowDate;
```

## Info

### IN-01: `matchOne` error verdict still counts a record as "completed", masking incompleteness

**File:** `sold-match-batch.js:128-129`

**Issue:** On a non-Ceiling throw from `matchOne`, the loop does `totals.error++` AND
`recordsMatched++`. So `recordsMatched === recordsTotal` even when records errored, and
the `recordsMatched < recordsTotal` incompleteness check in `validate` (line 229) never
fires for errored records — only a mid-loop CeilingError break leaves the counter short.
This appears intentional (an error is treated as a terminal verdict, and matchOne already
self-converts internal errors to `booli_only`), but it means a run where every record
throws would still validate as "clean full run" with `totals.error` high. Consider
escalating when `totals.error` exceeds a small threshold, mirroring `fetchFailures`.

**Fix (optional):** Add `if (s.totals.error > ERROR_THRESHOLD) reasons.push(...)` to
`buildSlackMsg`/`validate` so a high error rate escalates.

### IN-02: `client` undefined would throw an unhelpful error in the default de-dup path

**File:** `lib/sold-sample.js:160-167`

**Issue:** The default `knownBooliIds` closure calls `client.query(...)`. If
`sampleNational` is ever called in production without `opts.client` (e.g. a future caller
forgets it) and with a non-empty `allBooliIds`, this throws `Cannot read properties of
undefined (reading 'query')` rather than a clear contract error. The current orchestrator
always passes `client`, so this is latent only.

**Fix:** Guard at entry: `if (!deps.knownBooliIds && !client) throw new Error('sampleNational requires opts.client or deps.knownBooliIds');`

### IN-03: Allocation "spill" between types cannot reach target when both types are individually capped

**File:** `lib/sold-sample.js:110-119`

**Issue:** Minor under-allocation (the opposite of WR-02, and benign): when
`houseQuota` is clamped down to `liveHouse`, the spill is added to `aptQuota` capped at
`liveApt`; if apartments are also at their cap the spilled remainder is simply dropped, so
the muni allocates fewer than `muniTarget` even though `muniTarget <= liveTotal`
guaranteed enough total live existed. This is a rare rounding interaction (only when the
natural-ratio rounding pushes one type's quota above its live count while the other is
already saturated) and only loses a record or two — acceptable for a sampler, noted for
completeness. No fix required; the `sum(quota) <= sum(live)` invariant is preserved.

---

## Focus-area verdicts (as requested)

1. **Allocation correctness:** One real defect — over-allocation past `target` (WR-02).
   No negative/NaN (Number coercion + `Math.max(0, ...)` guards hold); zero-volume munis
   correctly drop (line 97); `sum(quota) <= sum(live)` holds; `sum(quota) <= target` does
   NOT (WR-02).
2. **Fortnightly even-week gate:** ISO-week math itself is correct (verified across
   year/53-week boundaries). The parity-based cadence drifts at year boundaries (WR-03).
   No false-skip or double-run WITHIN a year; the run is idempotent so a double-run would
   be harmless anyway.
3. **Batch ceiling propagation (SCHED-02):** Correct. `setSpendClient` called exactly
   once before any sampler/match work (line 83, smoke #3 confirms order). CeilingError from
   sampler (97), match loop (123), and re-check drain (165) all set `batchStoppedBy` and
   `validate` escalates (224). `validate` returns null only on a clean full run and a clean
   off-week skip. CAVEAT: the `fetchFailures` arm of the same fail-safe is dead (WR-01).
4. **De-dup query safety:** SAFE. `SELECT booli_id FROM booli_sold WHERE booli_id = ANY($1)`
   with `[ids]` bound (lib/sold-sample.js:162-165) — fully parameterized, no interpolation.
5. **RECHECK_BRIDGE_FINAL_ONLY lever:** Correct. `prevBridge` saved before mutation and
   restored in `finally` on every path including throw (lib/sold-recheck.js:182-194),
   including the `delete` for the previously-undefined case. No env leak across records
   (each record save/restores independently). `boolEnv` rejects typos to the documented
   default (lib/sold-config.js:66-73). Smoke #12/#13/#13b confirm.
6. **Resource leaks / unhandled rejections / pagination off-by-one:** DB client owned and
   closed by cron-wrapper.runJob (createClient/finally); the orchestrator opens no client.
   No unhandled rejection (every await is in a try/catch or propagates intentionally).
   Sampler pagination terminates on empty page OR `page >= meta.pages` (line 212) with no
   off-by-one (smoke #12b confirms exactly 4 fetches, no infinite loop on null-pages error
   pages). The only pagination-adjacent issue is WR-01 (error pages indistinguishable from
   true empties).

---

_Reviewed: 2026-06-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
