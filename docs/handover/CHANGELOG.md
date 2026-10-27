# Changelog

Changes to data collection that affect what the stored series mean. Newest first.
Record a data gap or a definition change here as soon as it's known, even
before it's fixed.

---

## 2026-10-27 — market-totals-daily: Hemnet totals moved; job rebuilt

### What broke

Around **2026-10-06** Hemnet changed its search pages:

- `/bostader`, `/kommande/bostader` and `/kommande` now all render `/till-salu`.
- The Apollo keys `searchForSaleListings` / `searchUpcomingListings` are gone.
  Totals now live at `ROOT_QUERY.search["listings({limit:0, search:{...}})"].total`,
  and the `search.upcoming` argument decides the population:

  | URL | `upcoming` | Population | 2026-10-26 |
  |---|---|---|---|
  | `/till-salu?upcoming=EXCLUDE` | `EXCLUDE` | for-sale only | 47,397 |
  | `/till-salu?upcoming=ONLY` (also on bare `/till-salu`) | `ONLY` | kommande | 7,488 |
  | `/till-salu` | (absent) | for-sale + kommande | 54,885 |

  The bare `/till-salu` headline (54,885) is **not** the old `till_salu`. If you
  use it, the for-sale series appears to jump ~16% overnight.
- `sort=` in the URL is ignored. Hemnet always uses `NEWEST_DAY_AND_PACKAGE`.
  This breaks `hemnet-forsale-age-census`'s OLDEST tail walk; that needs its own fix.
- `minimal` / `teaser` can no longer be set via the URL. Both are always `INCLUDE`.

`market-totals-daily` failed every run from 2026-10-06 onward with
`JSON path missing for hemnet.till_salu`.

### Data gap

**No `market_totals` rows for either site from 2026-10-06 until the fix is deployed.**
Booli was still fetchable, but the job wrote all four rows or none, so Booli
was lost too. The snapshots are point-in-time and cannot be backfilled.

Last good day: 2026-10-05, Hemnet `till_salu` 47,139 and `kommande` 6,676.

### Possible series break: Hemnet `kommande`

The new `kommande` number may not match the old definition:

- `till_salu` continues plausibly: 47,139 (2026-10-05), then 47,397 (2026-10-26)
  and 47,606 (2026-10-27).
- `kommande` steps up: 6,676 (2026-10-05), then 7,488 (2026-10-26) and 7,622
  (2026-10-27). That is +12% over three weeks. In the two weeks before the break
  it moved within 6,676–6,851.

The rise may be real, or it may come from the definition change, for example
`minimal`/`teaser` listings now being counted. We can't tell yet. Treat
week-on-week comparisons of Hemnet `kommande` across 2026-10-06 with caution,
and anything built on the Hemnet/Booli kommande ratio as well.

### What changed in the code

- `lib/hemnet-fetch.js` has a new `parseSearchTotals(apolloState)` that returns
  `{ forSale, upcoming, combined }`. It accepts only nationwide keys and skips
  any key narrowed by location or another filter. If two keys for the same
  population disagree, it throws. Other jobs hit by the same change can use it.
- `market-totals-daily.js`:
  - Fetches `/till-salu?upcoming=EXCLUDE` for `till_salu` and bare `/till-salu`
    for `kommande` (4 requests/day instead of 3). `source_url` on the Hemnet
    rows changes to match.
  - **Partition cross-check:** every day it checks that combined ≈ for-sale +
    kommande (tolerance 0.5%). On a mismatch it still writes the rows but raises
    a `hemnet-partition-mismatch` warning.
  - **Per-site isolation:** if one site breaks, the other site's rows are still
    written. The run is still recorded as a **failure**, keyed
    `site-failed:<site>`.
  - Now has a `require.main` guard and injectable `getWithRetry`, so it can be
    tested offline. It exports `main`, `validate` and the parsers.
- Tests:
  - `scripts/test-market-totals-daily.js` runs against real pages captured on
    2026-10-26 (`test-fixtures/hemnet-till-salu-rootquery-2026-10-26.json`).
  - `scripts/test-market-totals-probe.js` now imports the helpers instead of
    copying them.

### Still open (same Hemnet change)

- `scripts/premarket-flow-measure.js`: Hemnet side broken.
- `scripts/hemnet-age-census.js`: needs checking before the 2026-11-01 run.
- `scripts/hemnet-forsale-age-census.js`: the OLDEST sort is gone and needs a redesign.
