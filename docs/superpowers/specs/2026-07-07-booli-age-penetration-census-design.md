# Booli pre-market age-penetration — census vs binary-search bake-off — design spec

**Date:** 2026-07-07 · **Status:** design approved, pending independent spec review
**Author:** brainstorm session (Julian + Claude)
**Builds on:** [2026-07-06 pre-market flow & staleness measurement](2026-07-06-premarket-flow-measurement-design.md)

---

## 1. What we're really solving for

Yesterday's flow work established that Booli's ~33k pre-market pool is dominated by **aged
backlog** (depth sample: p1 ≈ 0.3d, p300 ≈ 42d, p600 ≈ 261d, p900 ≈ 1,216d ≈ 3.3yr;
new-builds only ~0.6%). That was a handful of sampled pages. The open question Julian wants
answered on a **one-off** basis:

> Of the ~33,409 Booli pre-market listings, exactly **how many are ≤1 month old, 1–3
> months, 3–6, 6–12, 12–18, 18–24, and >24 months** — the full age-penetration histogram.

Secondary goal (Julian's framing): we compute the histogram **two ways** — an exact
**census** (ground truth) and a cheap **binary-search estimate** (candidate) — and measure
how closely the candidate reproduces truth. **If binary-search passes, it becomes the
method we use for this measurement going forward; if it fails, we keep the census.** One
experiment settles the method question.

### Definition of "age"
Age of a listing = `NOW − published`, where `published` is the Booli card's publish
timestamp (when it entered the pre-market/`upcomingSale` pool). Same field and semantics as
yesterday's flow work. This is **time-on-Booli-as-upcoming**, not a title-transfer or
construction date.

---

## 2. Scope (locked decisions)

| Decision | Value |
|---|---|
| Platform | **Booli only** (Hemnet not in scope for this run) |
| Segment | Pre-market only (`upcomingSale=1`) |
| Geography | National (single stream) |
| Pool | **Full pool** (~33,409). New-builds **included**, but reported as a split line |
| Buckets | ≤1mo / 1–3mo / 3–6mo / 6–12mo / 12–18mo / 18–24mo / >24mo, plus an **undated** line |
| Cutoffs (days) | 30 / 90 / 180 / 365 / 548 / 730 |
| Methods | **Both**: full census (truth) + binary-search (candidate), then compare |
| Cadence | One-off. **No DB row, no cron.** Artifact only |
| Overlap / Hemnet compare | Out of scope |

Bucket edges are **half-open** on the young side: bucket `≤1mo` = `age < 30d`; `1–3mo` =
`30 ≤ age < 90`; … ; `>24mo` = `age ≥ 730`. "Month" is treated as a fixed day count (30d)
throughout — no calendar-month arithmetic — so the cutoffs are exactly {30, 90, 180, 365,
548, 730} days. (365/548/730 = 12/18/24 × 30.42, rounded to the conventional 1yr/1.5yr/2yr
day counts.)

---

## 3. Data source (validated 2026-07-06)

- URL: `https://www.booli.se/sok/till-salu?upcomingSale=1&page=<N>`
- Cards: `ROOT_QUERY.searchForSale(...).result` refs → `Listing:*`, parsed by
  `lib/booli-fetch.js::parseBooliSearchCards`. Each card carries `booli_id`, `published`
  (via `parsePublishedToUnix`), `isNewConstruction`, `upcomingSale`.
- Stock total: `searchForSale(...).totalCount` (~33,409), read off page 1.
- **No `sort=` param** — default sort is newest-first (any `sort=*` flips Booli to
  oldest-first; see booli-fetch.js:256). Newest-first ⇒ **age rises monotonically with
  page depth**, which is what makes binary-search possible.
- Page size observed = **35 cards/page** on the 5 depth-sampled pages (1/100/300/600/900),
  and 33,409 ÷ 35 = 954.5 (~955 near-integer pages) corroborates a flat page size. The
  pre-flight (§4.1) confirms this empirically before we rely on it.

Fetching reuses the existing transport: `getWithRetry` + `extractNextData` from
`lib/scrape-http.js`, forced through Oxylabs via `SCRAPE_FORCE_OXYLABS=1` (Booli is
server-rendered `__NEXT_DATA__`, so **non-JS** Oxylabs — do NOT route through `render`/JS,
which draws the smaller already-exceeded bucket). No parser changes needed — yesterday's
`isNewConstruction` extension is already merged.

---

## 4. Method — three stages, one pool snapshot

All three stages run in one script, sharing a single `NOW_SEC` captured at start and a
single page memo (a `Map<pageNum, cards[]>`) so no page is fetched twice within a stage's
reuse.

### 4.1 Pre-flight calibration (~12 calls)
Fetch a contiguous block (pages **1–10**) plus a few deep pages (e.g. **500, 800**). For
each: record `cards.length` and the set of `booli_id`s. Report:
- **page-size stability** — min/max/modal cards per page across the block (expected: all 35),
- **cross-page duplicate rate** — how many `booli_id`s appear on more than one of the
  sampled pages (expected: ~0).

This validates the two assumptions binary-search's arithmetic leans on (flat page size,
no cross-page dupes) *before* committing to either method, and gives the census its
dedup expectation. If page size is materially non-constant, the run logs a prominent
WARNING and binary-search uses the **measured mean** cards/page rather than a hard 35 (the
census is unaffected — it counts actual cards regardless).

### 4.2 Binary-search estimate (~15 calls) — the candidate
Run as a standalone future run would: **live fetches**, each probe chosen from the page's
own age reading, so the test is honest (network + live-pool behaviour included).

For each cutoff `C` in {30, 90, 180, 365, 548, 730} days, find the **crossover page** — the
first page whose listings cross from younger-than-`C` to older-than-`C`:

1. Binary-search page index in `[1, lastPage]`. At each probed page, compute a
   representative age (the page's **median** card age — robust to within-page fuzz). If
   median `< C`, the crossover is deeper; if `≥ C`, shallower. Halving ⇒ ~10 probes pin one
   boundary.
2. **Straddle-page refinement:** the median-crossover page can sit one page deeper than the
   page that actually straddles the `age=C` transition (the boundary may fall in the older
   half of the preceding page). Refine to the true straddle page by checking the shallower
   neighbour — if it still holds some younger-than-`C` cards, it contains the transition.
   Then count younger cards on the straddle page:
   `cumulative_count(C) ≈ (straddlePage − 1) × pageSize + (# cards on straddle page younger than C)`.
   This makes precision **sub-page** and halves the estimator's inherent bias (exact on a
   cleanly-sorted pool; residual error = within-page ordering fuzz, which is what the
   bake-off measures).
3. **Probe sharing:** every probed page is memoized and its median age is tested against
   *all six* cutoffs at once, so the six searches share nearly all fetches. Net ≈ 12–18
   live calls for all six boundaries.

Bucket estimate = successive differences of `cumulative_count` across the six cutoffs; the
`>24mo` bucket = `(stock_total − undated_est) − cumulative_count(730)` — **undated cards are
subtracted from the residual base**, not dumped into `>24mo`. Binary-search cannot see
undated cards by publish-age, so it estimates `undated_est = round(stock_total × undatedRate)`
from the undated fraction observed across its own probed + pre-flight pages (keeps
binary-search standalone). Without this, every undated listing would inflate the
binary-search `>24mo` bucket and could trigger a spurious FAIL that is really a definitional
mismatch, not method error.

**Documented fragilities** (the very things the bake-off tests): relies on (a) clean
newest-first monotonic sort, (b) stable page size, (c) representativeness of the page
median near a boundary. These bite most in the sparse **12–24mo tail**.

### 4.3 Full census (~955 calls) — ground truth
Walk pages `1 → lastPage` (stop on first empty page; `MAX_PAGES` safety cap = **1200**,
logging a WARNING if hit). For every card, dedup by `booli_id` (a `Set` of seen ids), then
bucket by its own age via the pure `bucketByAge`. Accumulate per-bucket counts, split by
`isNewConstruction`, plus an `undated` tally for cards with `published == null`.

**Independence:** the census re-fetches pages rather than reusing the binary-search memo, so
it is a genuine independent measurement of the same pool. (Binary-search's ~15 memoized
pages *could* be reused to save ~15 calls, but we keep them separate for a clean
apples-to-apples comparison; the ~15-call saving is immaterial.)

**Error vs empty — critical.** The walk must distinguish a **non-200 error page** (log,
count as a coverage gap, and **continue** to the next page) from a genuine **200-with-0-cards
page** (the real end of the pool → stop). It must **not** reuse the flow walker's
`cards.length === 0 ⇒ stop` semantics (`premarket-flow-measure.js:86-92` returns `[]` for
*both* cases), or one persistent page failure across ~955 sequential Oxylabs calls would
silently truncate the census and waste the whole spend. Concretely: `fetchPage` returns a
distinguishable signal (`{ status, cards }`; throws/returns null-status on persistent
error). The walk stops only on a true 200-empty page or at `expectedLast + margin`
(`expectedLast = ceil(stock_total / pageSize)`), whichever comes first; error pages are
skipped and tallied.

**Coverage accounting:** the census reports `pages_walked`, `error_pages` (coverage gaps),
`distinct_ids_seen`, `undated`, the **census-measured mean cards/page** (surfaced alongside
the pre-flight estimate to explain any deep-bucket binary-search miss), and
`stock_total − distinct_ids_seen` as a drift/coverage check.

### 4.4 Fairness / drift note
Both methods share one `NOW_SEC`. Binary-search runs first (~2 min), census immediately
after (~25–40 min). The pool adds ~350 listings/day, so over the full run the pool shifts by
~10–15 listings — negligible vs 33k. Timestamps for each stage are recorded in the artifact.

---

## 5. Comparison + verdict

The artifact puts the two histograms side by side:

| Bucket | Census (truth) | Binary-search | Abs error | Rel error |
|---|---|---|---|---|
| ≤1mo … >24mo, undated | n | n̂ | n̂−n | (n̂−n)/n |

**Acceptance criterion (proposed — Julian may retune):** binary-search is "good enough to
adopt going forward" iff, across every bucket:
- absolute error ≤ **1 percentage-point of the pool** (≤ ~334 listings), **and**
- relative error ≤ **10%** on any bucket holding ≥ 1% of the pool.

The **undated** line is compared separately (census: exact count; binary-search: its
probe-based `undated_est`) and is **excluded from the seven age-bucket pass/fail** — undated
cards have no publish-age, so a binary-search-vs-census gap there is an estimation-of-a-rate
difference, not an age-bucketing error. The `>24mo` bucket is compared on the undated-free
residual (§4.2).

The report prints an explicit **PASS / FAIL** against this, plus a one-line recommendation
("adopt binary-search — X× cheaper at equal accuracy" or "keep census — binary-search
misses by Y in the Z bucket").

---

## 6. Components (each independently testable)

Pure, network-free helpers added to `lib/premarket-flow.js` (covered by its existing
`--smoke` block, tested against a **synthetic monotonic pool** so no network is needed):

1. **`bucketByAge(cards, { nowSec, edges })`** → `{ buckets: number[], undated, newbuild: number[] }`.
   Buckets a card array by age into the half-open bands defined by `edges` (ascending day
   cutoffs), tallying new-builds per band and undated separately. Pure.
2. **`pageMedianAge(cards, nowSec)`** → median age (days) of dated cards on a page (null if
   none dated). Pure.
3. **`countYoungerThan(cards, cutoffSec)`** → # cards with `published >= cutoffSec`. Pure
   (used for sub-page refinement).
4. **`findCrossoverPage({ fetchPage, cutoffSec, nowSec, lo, hi, memo, logger })`** →
   `{ page, cumulativeYounger }`. Binary-search driver with injected `fetchPage` + shared
   `memo`; smoke-tested against a synthetic `fetchPage` returning a sorted pool so the
   search logic is verified with zero network.

Orchestration (network) lives in the script:

5. **`scripts/booli-age-census.js`** — captures `NOW_SEC`; runs pre-flight → binary-search
   (all six boundaries via shared memo) → census; computes the comparison + PASS/FAIL;
   writes the artifact. Refuses to run unless `SCRAPE_FORCE_OXYLABS=1` is set (guard against
   an accidental un-proxied run) and prints a call-count tally at the end.

---

## 7. Output

Artifact to `verf-flow-probe/` (no DB, no cron):
- **`booli-age-census-<date>.json`** — both methods' raw bucket counts, cumulative counts,
  per-bucket abs/rel error, new-build split, PASS/FAIL, and coverage stats (pages_walked,
  distinct_ids_seen, undated, page-size min/max/mode, duplicate rate, per-stage timestamps,
  oxylabs_calls per stage).
- **`booli-age-census-<date>.md`** — the comparison table (§5), the census histogram with
  bucket %, cumulative penetration %, the second-hand/new-build split, the PASS/FAIL verdict,
  and a coverage/quality footer.

Console mirrors the markdown. Slack/chart deferred (one-off).

---

## 8. Cost

| Stage | Calls |
|---|---|
| Pre-flight | ~12 |
| Binary-search | ~15 |
| Census | ~955 |
| **Total** | **~982** |

All **non-JS** Oxylabs, sequential, ~25–40 min. ~**0.4%** of the 262k non-JS monthly cap —
immaterial even at ~86% MTD. One-off (not recurring). This is the single Oxylabs spend
Julian has explicitly approved for this run.

---

## 9. Success criteria

- One-off run produces the exact **census** age histogram of the Booli pre-market pool
  across all seven buckets + undated, with new-build/second-hand split, persisted as a
  JSON+MD artifact.
- The same run produces the **binary-search** histogram and a per-bucket **abs/rel error
  table vs census**, with an explicit **PASS/FAIL** against the §5 criterion and a one-line
  adopt/keep recommendation.
- Census coverage is accounted: `distinct_ids_seen` reconciles to `stock_total` within a
  small drift, and any skipped pages are reported (no silent truncation).
- New pure helpers pass `lib/premarket-flow.js --smoke` (offline) before any Oxylabs spend.

---

## 10. Caveats (carried into the report)

- **`published` = entered-pre-market timestamp**, not construction/title date. "Age" here =
  time sitting in Booli's upcoming pool.
- **Census is truth *for this snapshot*** — the live pool drifts ~350/day; both methods
  share one `NOW` and run back-to-back (~10–15 listing drift, §4.4).
- **Binary-search assumes clean monotonic newest-first sort + flat page size** — exactly the
  assumptions the pre-flight checks and the bake-off stress-tests. A FAIL is an informative
  result, not a bug.
- **New-builds included** in the pool total (they're ~0.6%), but reported as a separate line
  so a second-hand-only view is available.
- **Booli national** uses the validated `upcomingSale=1` filter; the plain national query is
  anomalous (`totalCount` 1,611) and unused.
