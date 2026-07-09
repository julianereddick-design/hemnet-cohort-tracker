# For-sale (Till salu) age depth — Hemnet vs Booli — runbook & results

_Last updated: 2026-07-10. Both national runs DONE; this doc is now the re-run runbook + results record._

## Goal
Measure the **age distribution of ACTIVE for-sale listings** on Hemnet vs Booli — the
for-sale companion to the pre-market age census. "Age" = days since publish. Original intent
was the Hemnet-vs-Booli **delta**; see the big caveat below on why the tail comparison is not
clean.

## ⚠️ Key caveat (Julian, 2026-07-09) — READ FIRST
**Hemnet refreshes `publishedAt` when a seller buys a new advertising package** on non-Premium
listings. So Hemnet age = "days since last package purchase," NOT days-since-first-listed. This:
- biases Hemnet's distribution **young** (renewals reset the clock),
- makes the **Hemnet tail (>12–24mo) unreliable** — a 18-month-old listing that renewed last
  week shows as ≤1mo,
- breaks a clean like-for-like vs Booli (Booli tracks its own first-seen date — a different clock).

**Julian is NOT interested in the tail.** Orient any analysis to the fresh end / turnover, and
present the Hemnet tail with this caveat (or drop it). Do not headline "Hemnet has fewer zombies"
— that's largely the refresh artifact, not a real supply difference.

## Status
- **Booli for-sale: DONE** (2026-07-09). National FS age histogram, n=52,349:
  ≤1mo 18.5% · 1–3mo 32.0% · 3–6mo 18.2% · 6–12mo 13.4% · 12–18mo 8.4% · 18–24mo 3.3% · >24mo 6.2%.
  0 undated, ~0.7% new-build. Output: `verf-flow-probe/forsale-age-penetration-2026-07-09.{md,json}`.
- **Hemnet for-sale: NATIONAL RUN DONE** (2026-07-09). n=43,338 dated, 0 undated, 290/290 munis,
  1,208 Oxylabs calls, 0 errors, perfect reconciliation (Σ headlines = distinct; no muni hit the
  clamp so the sub-partition safety net never fired). Histogram:
  ≤1mo 48.2% · 1–3mo 25.9% · 3–6mo 7.3% · 6–12mo 6.0% · 12–18mo 4.5% · 18–24mo 2.1% · >24mo 6.0%.
  2,789 new-build. Output: `verf-flow-probe/hemnet-forsale-age-census-2026-07-09.{md,json}`, log `hemnet-fs-run.log`.

## Result read (2026-07-09) — fresh-end oriented, per caveat
- **Hemnet 74% ≤3mo vs Booli 51%**, driven by ≤1mo (48% vs 19%). Treat the +30pt ≤1mo gap as an
  UPPER BOUND on real freshness advantage — the publishedAt-refresh artifact inflates ≤1mo via
  non-Premium package renewals resetting the clock.
- **Tail is the honest tell:** >24mo Hemnet 6.0% ≈ Booli 6.2%. Near-identical DESPITE the refresh
  pushing Hemnet young ⇒ Hemnet's genuine zombie tail is ≥ Booli's. "Hemnet has fewer zombies" is
  NOT supportable (confirmed the caveat's warning).
- Thinner Hemnet mid-bands (3–12mo 13% vs Booli 32%) = same coin: renewals reset would-be-aging
  listings back to ≤1mo rather than letting them accumulate mid-tenure.

## What's built (committed: scripts in `3d911eb`; outputs + this doc stored 2026-07-10)
1. `scripts/forsale-age-penetration.js` — **Booli** FS age estimate via two-pass sort-flip
   binary-search. Modes: `--selftest` (7/7 offline), `--sortprobe [platform]`, `--preflight`,
   default = full run. Self-tested + validated (90d crosscheck between passes Δ=0.9%).
2. `scripts/hemnet-forsale-age-census.js` — **Hemnet** FS age census by municipality partition
   (290 munis, `lib/hemnet-locations-full.json`). Modes:
   - `--selftest` (3/3 offline, incl. sub-partition recovery vs clamp),
   - `--sizes` (page-1 totals for the biggest munis),
   - `--probe [Muni]` (single muni, default Stockholm),
   - default = full national run → writes `verf-flow-probe/hemnet-forsale-age-census-<date>.{md,json}`
     incl. a like-for-like Hemnet-vs-Booli table (auto-loads the latest Booli FS json).

## Method facts established (so a fresh session doesn't re-derive)
- **National pagination CLAMPS** on both sites (can't just paginate the whole country):
  Hemnet `/bostader` caps at page 50 = 2,500 listings (~3 days of age); Booli at page 1000 = 35k.
- **Booli beat it** with a two-pass sort-flip: oldest-first = `?sort=published&ascending=1`
  (FS-only = `upcomingSale=0`). Newest 35k + oldest 35k overlap ⇒ full coverage. (The old
  spike-002 "any sort=* flips ascending" note is STALE — needs explicit `ascending=1`.)
- **Hemnet has NO oldest-first sort** (`sort=OLDEST` ignored) and a tight 2,500 clamp, so
  two-pass gives only ~13% coverage. Hemnet's ONLY path is **municipality partition**.
- **No municipality clamps** (checked 2026-07-09): largest by FS is Göteborg 1,655, Stockholm
  1,527 — all top-17 munis well under 2,400. So the national run is a **plain muni-walk**; the
  built-in recursive sub-partition (by `item_types[]` then `price_min/max`) is a dormant, offline-
  tested safety net that won't fire.
- **Stockholm probe** (32 calls): headline 1,528, recovered 101% (churn), buckets
  [867,483,85,51,25,11,28] → 87% ≤3mo, 1.8% >24mo. Very fresh — but note the refresh caveat.

## RUNBOOK — how to re-run this yourself in the future
Prereqs: Oxylabs creds live in `.env` (the census forces Oxylabs via `SCRAPE_FORCE_OXYLABS=1`).
Each full national run = **~1,200 Oxylabs calls (~0.5% of monthly cap), ~60–75 min.** Paid scrape —
needs explicit go-ahead per the no-Oxylabs-without-approval rule.

1. **Smoke (free-ish, ~17 calls) — confirm creds live + no muni over the clamp:**
   ```
   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js --sizes
   ```
   Expect `Munis over clamp (2400): NONE` and `oxylabsFailureCount:0`.
2. **Full Hemnet national run (background + poll the log):**
   ```
   SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js > verf-flow-probe/hemnet-fs-run.log 2>&1 &
   ```
   Progress logs every 25/290 munis. Writes `verf-flow-probe/hemnet-forsale-age-census-<date>.{md,json}`
   (histogram + auto-generated like-for-like vs the latest Booli FS json).
3. **Booli companion (if you also want to refresh the Booli side, ~84 calls):**
   ```
   SCRAPE_FORCE_OXYLABS=1 node scripts/forsale-age-penetration.js > verf-flow-probe/forsale-run.log 2>&1 &
   ```
   Writes `verf-flow-probe/forsale-age-penetration-<date>.{md,json}`. Run this FIRST if you want the
   Hemnet run's like-for-like table to pick up fresh Booli numbers (it auto-loads the newest Booli json).
4. Offline self-tests (free, no network): `node scripts/hemnet-forsale-age-census.js --selftest`
   (3/3) and `node scripts/forsale-age-penetration.js --selftest` (7/7). Single-muni live probe:
   `SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js --probe Göteborg`.

## ⚠️ KNOWN LIMITATION — no per-region / per-listing storage (found 2026-07-10)
The census accumulates a **single national histogram**: `addCard` folds every listing into global
`buckets[]` + a global `seen` dedup set, and writes out only `{name,id,headline,counted}` per muni —
**no age buckets per municipality, and the raw per-listing publish dates are never dumped.** So the
national outputs on disk **cannot** be re-sliced by region, housing type, or price after the fact.
- **To get an age distribution by region/type/price you must re-run** (there is no local re-slice).
- **Recommended durable fix before the next run** (both free to build offline; only the re-scrape is
  paid): (a) key the buckets by muni and roll munis up to county (needs a muni→county/län map — NOT in
  the repo yet; `lib/hemnet-locations-full.json` is only `{muni:id}`), and (b) dump a per-listing row
  `{id, muni, publishedAt, isNewBuild}` to JSON/CSV so **any** future cut is a free local re-slice.
  Same "per-listing dump outstanding" gap flagged on the pre-market age work.

## Interpretation guide for the output
- **Use the fresh-end / mid bands; discount the >12–24mo tail** (refresh artifact — see caveat).
- Booli total (52.3k) > Hemnet FS (~43.4k) by ~20%, consistent with prior pool-asymmetry work.
- The like-for-like table will render, but frame the tail rows with the Hemnet-refresh caveat.

## Spend (final)
Booli work ~193 calls; Hemnet Stockholm probe + sizing ~49 calls; Hemnet national run 1,208 calls
+ a 17-call re-smoke on 2026-07-09. Total this workstream ≈ 1,467 Oxylabs calls.

## Related memory
`project_forsale_age_penetration` · `project_premarket_age_penetration` · `reference_oxylabs_usage_api_and_cap`
