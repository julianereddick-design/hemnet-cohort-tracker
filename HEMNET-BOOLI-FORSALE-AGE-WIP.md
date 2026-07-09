# For-sale (Till salu) age depth — Hemnet vs Booli — WIP handoff

_Last updated: 2026-07-09. Pick up here after a fresh `/clear`._

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
- **Hemnet for-sale: tool BUILT + VALIDATED, national run NOT yet run.**

## What's built (all UNCOMMITTED as of this writing)
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

## THE REMAINING STEP — run this in the fresh session
```
SCRAPE_FORCE_OXYLABS=1 node scripts/hemnet-forsale-age-census.js
```
- Cost: **~1,150 Oxylabs calls** (~0.5% of monthly cap; run in background, ~60–75 min).
- Needs Julian's explicit go-ahead per the no-Oxylabs-without-approval rule (he's greenlit the
  approach; confirm the run at start of the fresh session).
- Run in background: `... > verf-flow-probe/hemnet-fs-run.log 2>&1 &` then poll the log.
- Verify creds first offline (the tool's `--sizes` is a cheap 17-call smoke).

## Interpretation guide for the output
- **Use the fresh-end / mid bands; discount the >12–24mo tail** (refresh artifact — see caveat).
- Booli total (52.3k) > Hemnet FS (~43.4k) by ~20%, consistent with prior pool-asymmetry work.
- The like-for-like table will render, but frame the tail rows with the Hemnet-refresh caveat.

## Spend so far this thread
Booli work ~193 calls; Hemnet Stockholm probe + sizing = 49 calls. National run (~1,150) pending.

## Related memory
`project_forsale_age_penetration` · `project_premarket_age_penetration` · `reference_oxylabs_usage_api_and_cap`
