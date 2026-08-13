# Monthly age-penetration check — design

Date: 2026-08-13
Branch: `feat/age-penetration-monthly` (off `feat/forsale-age-penetration`)
Status: approved in brainstorming, pending spec review

## 1. Purpose

Turn four one-off July age censuses into a monthly series, so the age structure of both
platforms' pools becomes a trend rather than a snapshot.

The question it answers each month: **how fresh is each pool, and is the gap between the
platforms moving?** Specifically, per pool: how much of the stock is ≤1mo / ≤3mo old, how
big is the aged tail, and how did that change since last month.

It is a *stock* measurement. It complements — does not replace — the weekly pre-market
*flow* pulse and the weekly Booli pre-market *quality* ladder.

## 2. Scope

All four pools, every month:

| Platform | Pool | Script (exists) | Method | Calls/run |
|---|---|---|---|---|
| Booli | pre-market (`upcomingSale=1`) | `scripts/booli-age-census.js` | binary-search over newest-first | ~60 |
| Booli | for-sale (`upcomingSale=0`) | `scripts/forsale-age-penetration.js` | two-pass sort-flip binary-search | ~84 |
| Hemnet | pre-market (`/kommande`) | `scripts/hemnet-age-census.js` | 290-municipality partition census | ~656 |
| Hemnet | for-sale (`/bostader`) | `scripts/hemnet-forsale-age-census.js` | 290-municipality partition census | ~1,208 |

Total ≈ **2,000 Oxylabs calls/month ≈ $5/month**. Against the 262k non-JS monthly cap at
~55-60% utilisation (~100k headroom, re-checked 2026-08-13) this is immaterial. Wall clock
≈ 2.5-3h, Hemnet for-sale the long pole.

Age bands are the existing seven: ≤1mo · 1-3mo · 3-6mo · 6-12mo · 12-18mo · 18-24mo ·
\>24mo, plus an undated count. Band logic stays in `lib/premarket-flow` (`bandIndex`,
`cardAgeDays`) — unchanged, so July's numbers and September's are computed identically.

### Out of scope

- Regional slicing of Booli (see §5 — structurally unavailable under binary-search).
- Per-listing dumps / zombie lists (rejected: forces Booli onto full-census scraping,
  ~4,000+ calls and hours of runtime, ~90k DB rows/month).
- Conversion tracking (do Kommande listings become Till salu?) — a separate study.
- Charting the series (deferred until ≥3 datapoints exist).

## 3. Architecture

Mirrors the pre-market quality job: **measure** and **report** are separate jobs on
separate cron entries, so a scrape failure never blocks or corrupts the post, and the post
can be re-run from the DB without re-scraping.

```
  02:00 UTC, 1st of month     scripts/age-census-monthly.js   (measure)
        │
        ├─ booli-age-census        run() → histogram → persist row   (~10 min)
        ├─ forsale-age-penetration run() → histogram → persist row   (~15 min)
        ├─ hemnet-age-census       run() → histogram + 290 muni rows  (~40 min)
        └─ hemnet-forsale-census   run() → histogram + 290 muni rows  (~2h)
                                                    ↓
                                        age_census_run / age_census_muni
                                                    ↓
  07:00 UTC, 1st of month     scripts/age-census-report.js    (report)
        └─ read DB → Slack post + verf-flow-probe/*.{md,json}
```

**Order is cheapest-first** so the two cheap Booli datapoints are banked before the
expensive Hemnet walks start.

**Each pool persists the moment it completes** — the 2026-07-20 lesson, where a transient
Oxylabs 613 on one platform lost the entire weekly datapoint. A Hemnet failure must never
cost the Booli rows.

### Component changes

Each of the four scripts gains an exported `run(opts)` returning a result object; all
current CLI behaviour and self-tests (`--selftest`, `--probe`, `--sizes`, `--sortprobe`,
`--preflight`) are preserved unchanged. This is the `runJob`-direct-require contract
already used by `premarket-flow-measure.js`.

`run()` returns:

```js
{
  platform, pool, method,
  nTotal, nUndated, nNewbuild,            // nNewbuild exact (Hemnet) or sampled (Booli, §5)
  buckets:           { le1m, m1_3, m3_6, m6_12, m12_18, m18_24, gt24, undated },
  bucketsSecondhand: { ...same shape... }, // null for Booli — see §5
  muni: [ { name, id, headlineN, countedN, buckets, bucketsSecondhand } ],  // Hemnet only
  oxCalls, errorPages, runtimeS,
  gates: { ... },                          // §6
}
```

New shared helper `lib/age-census.js`: bucket-shape constructors, the dual-tally
accumulator, gate assertions, and DB upsert. Keeps the four scripts free of DB knowledge
and keeps the orchestrator thin.

## 4. Data model

One migration, `migrate-age-census.js` at repo root (repo convention — see
`migrate-premarket-flow.js`). Idempotent: `CREATE TABLE IF NOT EXISTS`, safe to re-run.

```sql
CREATE TABLE age_census_run (
  id                  SERIAL PRIMARY KEY,
  run_date            DATE        NOT NULL,
  platform            TEXT        NOT NULL,   -- 'booli' | 'hemnet'
  pool                TEXT        NOT NULL,   -- 'premarket' | 'forsale'
  method              TEXT        NOT NULL,   -- 'binary-search' | 'sort-flip' | 'muni-partition'
  n_total             INTEGER     NOT NULL,
  n_newbuild          INTEGER,                -- NULL when unavailable
  n_newbuild_sampled  BOOLEAN     NOT NULL DEFAULT FALSE,
  n_newbuild_sample_n INTEGER,                -- cards actually inspected (Booli)
  n_undated           INTEGER     NOT NULL,
  buckets             JSONB       NOT NULL,   -- all listings
  buckets_secondhand  JSONB,                  -- exact 2nd-hand-only; NULL for Booli
  ox_calls            INTEGER     NOT NULL,
  error_pages         INTEGER     NOT NULL DEFAULT 0,
  runtime_s           INTEGER,
  status              TEXT        NOT NULL,   -- 'ok' | 'gate_failed' | 'partial'
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_date, platform, pool)
);

CREATE TABLE age_census_muni (
  id                 SERIAL PRIMARY KEY,
  run_id             INTEGER NOT NULL REFERENCES age_census_run(id) ON DELETE CASCADE,
  muni_name          TEXT    NOT NULL,
  muni_id            INTEGER NOT NULL,
  headline_n         INTEGER NOT NULL,   -- site-reported total, for reconciliation
  counted_n          INTEGER NOT NULL,   -- cards actually walked
  buckets            JSONB   NOT NULL,
  buckets_secondhand JSONB   NOT NULL,
  UNIQUE (run_id, muni_id)
);
```

`UNIQUE (run_date, platform, pool)` makes a re-run idempotent (upsert), which matters
because a partial month will be re-fired by hand.

Volume: 4 run rows + ~580 muni rows per month ≈ 7k rows/year. Negligible.

This closes the 2026-07-10 limitation ("any regional cut needs a fresh ~1,200-call
re-run") for the Hemnet side. A muni→county rollup needs a muni→county map, which is not
in the repo (`lib/hemnet-locations-full.json` is only `{muni: id}`); the per-muni rows make
that map a purely offline addition whenever it's wanted.

## 5. New-builds — what is exact and what is not

Agreed rule: **tally both, headline 2nd-hand.** The implementation is asymmetric, and the
asymmetry is a property of the scraping methods, not a shortcut.

- **Hemnet (both pools) — exact.** The muni-partition censuses visit every card and already
  parse `newConstruction`. Both histograms are computed from the same walk at zero extra
  cost. This is where it matters: 2,789 of 43,338 Hemnet for-sale listings (6.4%) were
  new-builds in July.
- **Booli (both pools) — not exact.** Binary-search infers band counts from crossover *page
  positions*; it never sees most cards, so per-band new-build exclusion is unavailable.
  What it can do for free: report the new-build share observed across the ~2,000 cards the
  search does fetch, stored as `n_newbuild` with `n_newbuild_sampled = TRUE` and the sample
  size. `buckets_secondhand` stays NULL for Booli.

  A uniform-share correction is explicitly **rejected**: July found new-builds concentrate
  in the old tail, so spreading them evenly across bands would manufacture a wrong number
  that looks precise.

Consequence, stated in every report: the Booli headline is all-listings and the Hemnet
headline is 2nd-hand-only. At Booli's observed ~0.2% (pre-market) / ~0.7% (for-sale)
new-build share this sits below month-to-month noise, but it is a definitional difference
and is footnoted rather than hidden.

Comparability with July's baseline: `buckets` (all listings) is directly comparable for all
four pools. `buckets_secondhand` starts fresh — the first Hemnet for-sale headline delta
against July would be ~6.4% definitional, so the report suppresses month-on-month deltas on
the 2nd-hand series until two months of it exist.

## 6. Validation gates

Each pool asserts before it persists. A failed gate persists the row with
`status='gate_failed'` and raises in the Slack post — a wrong number must never land
quietly.

- **Hemnet (both):** Σ(muni headline totals) = distinct IDs counted. July: exact, 0 gaps.
- **Hemnet (both):** no municipality hit the pagination clamp (`MAX_PAGES_PER_MUNI`); if one
  does, the existing recursive `item_type`→price sub-partition must fire, and the fact is
  recorded in `notes`.
- **Booli for-sale:** the two-pass 90-day overlap crosscheck. July: 26,454 vs 26,939
  (Δ 0.9%). Gate at Δ ≤ 3%.
- **All:** `n_undated` = 0 expected; non-zero is recorded and reported, not fatal.
- **All:** `n_total` within ±25% of the prior month's run for that pool. Trips on a
  scrape-shape regression (the failure mode that silently halves a pool), not on real
  market movement.
- **All:** `error_pages` = 0 expected; > 2% of calls fails the gate.

## 7. Reporting

One Slack post per month, in the same channel as the weekly flow pulse. Shape (not final —
Julian expects to iterate on the table):

```
Age penetration — 2026-09-01   (Hemnet 2nd-hand only; Booli incl. new-build, <1%)
                    n        ≤1mo      ≤3mo      >24mo
Booli pre-market    33.7k    24.2%     45.8%     14.3%   (Δ vs Aug: +0.4pt ≤3mo)
Hemnet pre-market    8.4k    39.1%     61.9%      9.3%
Booli for-sale      52.3k    18.5%     50.5%      6.2%
Hemnet for-sale     43.3k    48.2%     74.1%      6.0%  ⚠ clock
```

Rules, from Julian's 2026-07-09 steer:

- **Lead with the fresh end** (≤1mo, ≤3mo) and absolute counts. Share and absolute tell
  opposite stories — Hemnet looks fresher by share while Booli's pool is ~4× larger in
  pre-market — so both appear.
- **The >24mo tail carries a standing caveat on Hemnet rows.** Hemnet refreshes
  `publishedAt` when a seller buys a new ad package, so Hemnet age is "days since last
  package purchase", biased young, and its tail is not a real clock. Never headline
  "Hemnet has fewer zombies" — that is the refresh artifact.
- Month-on-month deltas shown once a prior month exists for that series.
- Full seven-band tables, per-muni Hemnet detail, gate results and Oxylabs spend go to the
  committed artifacts (`verf-flow-probe/age-census-YYYY-MM-01.{md,json}`), not the post.

## 8. Failure handling

- Fetches use `getWithRetry` from `lib/scrape-http` — the retry that hardened the flow job
  after the 2026-07-20 incident.
- Per-pool try/catch in the orchestrator: a thrown pool is logged, recorded, and the
  orchestrator continues to the next one. Exit code non-zero if any pool failed.
- The measure job runs under the existing cron-wrapper, so a hard crash alerts rather than
  producing a silently missing month.
- The report job posts whatever rows exist for that `run_date` and names the missing ones
  explicitly ("Hemnet for-sale: FAILED — 0 rows"). A partial month is visible, not implied.

## 9. Delivery plan

1. **Land the for-sale scripts.** `scripts/forsale-age-penetration.js` and
   `scripts/hemnet-forsale-age-census.js` have never been on master — they exist only on
   the local, unpushed `feat/forsale-age-penetration` (7 ahead of master, 0 behind). Merge
   it, then verify the merge does not duplicate `70ba1c5` against an equivalent commit
   already on master (flagged in prior work as needing rebase-not-merge).
2. **Clean-clone gate.** Before any deploy: clone master fresh and run all four scripts'
   offline self-tests. Directly targets last week's failure where `lib/booli-image-labels.js`
   was untracked and six local review passes missed it, because every local run had the file.
3. Migration → `lib/age-census.js` → `run()` refactors → orchestrator → report job.
4. Deploy, then **ask for explicit go-ahead on the first live run** (~$5, ~3h) before firing
   it, notwithstanding the standing cron approval.
5. Enable the two cron entries only after the first run is verified green.

## 10. Testing

All offline, no network, no DB:

- `lib/age-census.js --smoke`: dual-tally accumulator, bucket shapes, gate assertions
  (including deliberately tripped gates).
- Orchestrator smoke: synthetic pool via injected page-fetcher, asserts per-pool persistence
  ordering, that one failing pool does not abort the others, and the non-zero exit code.
- Migration idempotency: run twice against a scratch schema.
- Report renderer against a fixture row set: no-prior-month case, partial-month case,
  gate-failed case, and the Hemnet clock caveat present on Hemnet rows.
- The four existing self-tests must still pass unchanged after the `run()` refactor —
  this is the regression guard on the refactor itself.

## 11. Known limitations, stated once

- Booli is national-only. Regional cuts will be Hemnet-only until someone pays for a Booli
  full census.
- Hemnet's clock is package-purchase-based, so the Hemnet tail and the Hemnet-vs-Booli tail
  comparison are unreliable in both directions. The ≥3mo bands are the honest ground.
- The census measures age and turnover rate, not exit destination. A fat Booli tail could be
  genuinely-parked stock or listings Booli never cleared; this job cannot distinguish them.
