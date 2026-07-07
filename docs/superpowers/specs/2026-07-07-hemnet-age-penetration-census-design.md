# Hemnet pre-market age-penetration — national muni-partition census — design spec

**Date:** 2026-07-07 · **Status:** design in progress
**Author:** brainstorm session (Julian + Claude)
**Companion to:** [Booli age-penetration census](2026-07-07-booli-age-penetration-census-design.md) · **builds on** [pre-market flow](2026-07-06-premarket-flow-measurement-design.md)

---

## 1. What we're solving for

Produce the **national** age-penetration histogram of the Hemnet pre-market pool (Kommande,
~8,368 listings) across the **same seven buckets** as the Booli census (≤1mo / 1–3mo / 3–6mo
/ 6–12mo / 12–18mo / 18–24mo / >24mo, cutoffs 30/90/180/365/548/730 days, + undated), so we
have a **like-for-like freshness comparison** between the two platforms' pre-market pools.

Age = `NOW − publishedAt`, where `publishedAt` is the Hemnet card's "posted as Kommande"
timestamp — the same "entered pre-market" semantics as Booli's `published`, so the two
histograms are directly comparable.

### The Booli method does NOT port directly — and here's why
Booli serves its full 33.7k pre-market pool through deep pagination (validated to page 900+),
so a single national newest-first walk censuses it. **Hemnet caps Kommande pagination** —
probe (2026-07-07) confirmed `/kommande/bostader?sort=NEWEST` returns full pages to ~p50
(ages ~20d) but **empty at p70**, i.e. only ~2,500–3,450 of the 8,368 pool is reachable
nationally, spanning just the freshest **~0–21 days**. The older ~60% is unreachable via the
national stream. So neither a national census nor a national binary-search can see the tail —
we must **partition**.

---

## 2. Scope (locked decisions)

| Decision | Value |
|---|---|
| Platform | **Hemnet only** (paired with the existing Booli census for comparison) |
| Segment | Pre-market only (Kommande) |
| Geography | **National** — all 290 municipalities |
| Pool | Full pool. New-builds **included**, reported as a split line |
| Buckets / cutoffs | Same as Booli: ≤1/1–3/3–6/6–12/12–18/18–24/>24 mo (30/90/180/365/548/730 d) + undated |
| Method | **Municipality-partition census** (no binary-search — see §4.4) |
| Cadence | One-off. **No DB row, no cron.** Artifact only |

---

## 3. Why municipality, not county (validated by probe)

The pagination cap forces partitioning into slices each **under the ~2,500–3,450 cap**.
Probe findings (2026-07-07, `scripts/probe-hemnet-kommande-partition.js`):

- **`location_ids[]=` filters `/kommande`** ✅ — Stockholm muni **1,086**, Göteborg **427**,
  Alingsås **7**. Clean per-partition totals.
- **Partitioning exposes the hidden tail** ✅ — Alingsås surfaced a listing **675 days old**,
  invisible in the national stream.
- **Counties FAIL** — Stockholm *municipality* alone is 1,086; Stockholm/VG/Skåne *counties*
  (dozens of munis each) far exceed the cap → a county partition would silently **truncate
  the three metros**, the worst place to lose data. (Hemnet's apollo also exposes no county
  IDs.)
- **Municipalities all fit** — the biggest single muni (Stockholm, 1,086) sits comfortably
  under the cap, so **every** muni partition paginates to a genuine end with full age
  coverage. Uniform logic, guaranteed completeness.

## 3a. Location IDs — harvested (blocker resolved)

The repo's `lib/hemnet-locations.js` resolver is DB-bound (only the 115 tracked munis).
Hemnet's location API is GraphQL (`POST /graphql`, op `locationSearch` →
`autocompleteLocations`). Rather than fight POST-through-Oxylabs, we harvested it
**in-browser** (same-origin, authenticated — no Oxylabs) for all 290 canonical municipality
names. Result: **`lib/hemnet-locations-full.json`** (290 munis, name→location_id),
cross-validated — **all 115 previously-known IDs match exactly, 0 duplicate IDs**. Two name
quirks were resolved manually: *Falun* → "Falu kommun" (17904), *Habo* (Jönköping, 17922) vs
*Håbo* (Uppsala, 17940). This file is the partition key list.

---

## 4. Method — municipality-partition census

### 4.1 Per-muni walk — stop on "0 new IDs", NOT on empty page (probe-validated)
For each of the 290 munis, walk `https://www.hemnet.se/kommande/bostader?location_ids[]=<id>&sort=NEWEST&page=N`
from `p=1` upward, parsing cards via `lib/hemnet-fetch.js::parseListingCards`
(fields `publishedAt`, `newConstruction`, `id`). Read the muni's headline total from
`ROOT_QUERY.searchUpcomingListings.total` on page 1 (approximate — a cross-check only).

**Stop condition (critical — probe 2026-07-07):** Hemnet does **not** return an empty page
past a muni's end. It **clamps the page number and repeats the tail**: Alingsås returns 8
cards on p1 then the *same single card* on p2…p10 forever; Stockholm (1,086) runs 50/page to
p22, 14 on p23, then repeats those same 14 on p24/p25. So "stop on 200-empty page" would
**never fire for a small muni** and loop to the page cap fetching duplicates. Instead:
**stop when a page contributes 0 new distinct listing IDs** (against the global seen-set),
or a genuine 200-empty page (0-Kommande munis return an empty p1). This is robust to the
clamp: the first repeated/clamped page yields 0 new and terminates the muni. Backstop:
`MAX_PAGES_PER_MUNI = 80` (Stockholm ends ~p23, so 80 is ample); hitting it logs a loud
WARNING. Crucially, muni-filtered streams paginate to their own (small) natural end **well
under the ~2,500/50-page national cap** — Stockholm, the largest, ends ~p23 — so every muni
is fully reachable and coverage is complete.

### 4.2 Bucket + dedup + filters
Count only cards with **`upcoming === true`** — a defensive filter against any injected
"recommended"/Till-salu cards a `/kommande` page might carry (probe 2026-07-07 found **zero**
non-upcoming cards on Alingsås/Stockholm/Göteborg, so this changes nothing today, but it WARNs
and self-corrects if Hemnet ever injects). Dedup by listing `id` **globally** (one `Set`
across all munis — municipalities are disjoint so cross-muni collisions shouldn't occur, but
the global set makes a stray double-listing harmless and bounds the clamp loop). Each distinct
upcoming listing → `bandIndex(cardAgeDays(publishedAt, NOW), EDGES)`, split by
`newConstruction`, undated (`publishedAt == null`) tallied separately. **publishedAt guard:**
a value that isn't a finite unix-seconds int in `(0, NOW]` (e.g. a mangled ISO string via
`coerceNumber`) is counted as an *anomaly* + undated, never silently misbucketed. Sum across
munis = national histogram.

### 4.3 Error vs empty — critical (same lesson as the Booli census)
`fetchPage` must distinguish a **non-200 error** (log, count as coverage gap, continue to the
next page) from real content. Do **not** treat an error page as end-of-muni, or a transient
failure would truncate a muni's walk and undercount its tail. Muni exhaustion is detected by
the **0-new-IDs** rule (§4.1), not by an empty page (small munis never return one). A muni
whose **page 1 itself errors** is a whole-muni gap; such munis are collected and **retried
once at the end** (global dedup makes a re-walk safe), and any still-failing muni is surfaced
in the coverage report as an explicit gap — never silently dropped.

### 4.4 No binary-search here
Binary-search only pays off on a deep single stream (Booli). Muni partitions are shallow
(biggest ~22 pages, most 1–2), so you'd fetch nearly every page anyway — just census each.
(Binary-search was already validated on the Booli side; nothing to re-prove.)

### 4.5 Cap-breach guard
Max known muni is Stockholm (1,086 → ~p24 with clamp, ≪ cap), so no muni should hit the cap.
Set `MAX_PAGES_PER_MUNI = 40` (Stockholm ends ~p24, so 40 is an ample backstop that also
bounds worst-case cost); if a muni's walk reaches it, log a loud WARNING (it would mean a muni
exceeds the cap and needs a sub-split — not expected). The 0-new-IDs stop (§4.1) is the real
terminator; this cap only guards a pathological non-terminating case.

---

## 5. Coverage accounting & reconciliation
Report per run: munis processed, munis with 0 Kommande, distinct listings counted,
`Σ muni totals` vs `distinct counted` (drift/coverage), error/gap pages, census-measured mean
cards/page, per-stage Oxylabs calls. A national sanity check: `distinct counted` should
reconcile to the national `searchUpcomingListings.total` (~8,368) within live-pool drift.
(Note: Hemnet's `total` field is approximate for Kommande — probe saw Alingsås report total=7
but serve ≥9 cards — so **the count is truth**, the total is a cross-check only.)

---

## 6. Output

Artifact to `verf-flow-probe/` (no DB, no cron):
- **`hemnet-age-census-<date>.json`** — national bucket counts, cumulative, new-build split,
  coverage stats, per-muni totals.
- **`hemnet-age-census-<date>.md`** — the Hemnet histogram (count / % / cumulative % /
  new-build) **plus a combined like-for-like table vs the Booli census** (share % per bucket,
  both platforms side by side) and a one-line read on who is fresher.

---

## 7. Cost
Sum of `ceil(total_i / 50)` over 290 munis. National pool ~8,368; munis with 0 Kommande cost
1 call each (empty p1). Estimate **~350–450 non-JS Oxylabs calls**, one-off, ~15–30 min.
~0.15% of the 262k/mo cap — immaterial. This is the one Oxylabs spend to approve for the run.

---

## 8. Components
Reuse pure helpers from `lib/premarket-flow.js` (`bandIndex`, `cardAgeDays`, `bucketByAge`) —
already smoke-tested. New one-off orchestrator `scripts/hemnet-age-census.js`: loads
`lib/hemnet-locations-full.json`, runs the per-muni walk + bucket + reconcile, writes the
artifact and the combined comparison. Guard: refuse to run without `SCRAPE_FORCE_OXYLABS=1`;
`--probe` (1 muni) sanity mode; offline `--selftest` against a synthetic multi-muni pool.

---

## 9. Success criteria
- One-off run yields the exact **national** Hemnet Kommande age histogram (7 buckets +
  undated), new-build/second-hand split, as a JSON+MD artifact.
- Coverage reconciles: `distinct counted` ≈ national total within drift; 0 munis hit the
  cap-breach guard; error pages reported (no silent truncation).
- A **combined Hemnet-vs-Booli** like-for-like freshness table is produced.
- Reuses `lib/hemnet-locations-full.json` (290) and passes the pure-helper smokes offline
  before any spend.

---

## 10. Caveats (carried into the report)
- **`publishedAt` = entered-Kommande timestamp** — comparable to Booli's `published`.
- **Hemnet `total` is approximate for Kommande** — counts are truth, total is a cross-check.
- **Expected asymmetry:** Hemnet's Kommande converts to Till salu faster (shorter dwell), so
  the histogram should read *structurally fresher* than Booli's — quantified, not assumed.
- **New-build share may be higher on Hemnet** — developer project pre-sales sit in Kommande;
  reported as its own line (Booli's was ~0.2%).
- **Location IDs** harvested 2026-07-07 via Hemnet `locationSearch`; re-validate if a muni
  walk 404s (a stale/renamed ID).
