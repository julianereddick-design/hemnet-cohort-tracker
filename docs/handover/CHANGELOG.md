# Changelog

Changes to data collection that affect what the stored series mean. Newest first.
Record a data gap or a definition change here as soon as it's known, even
before it's fixed.

---

## 2026-10-27 — Hemnet listing format tracking (free tier, aggregated listings)

### Why

On 20 Oct 2026 Hemnet launched free listings. They show in Hemnet's page data as
`activePackage: "MINIMAL"`. Hemnet says a second free format, listings aggregated from
agency websites, launches around the end of October. Both are stubs: a few photos, no
description, and a "Read more at the broker" link. They will get far fewer Hemnet views
than paid listings.

Our views data compares the same home on Hemnet and Booli. If free or aggregated listings
enter the tracked sample unlabelled, they pull Hemnet's share of views down for reasons
that have nothing to do with Booli. So every tracked listing now records its format, and
reports can keep the headline on paid listings (comparable with history) and show free and
aggregated listings separately.

Example free listing: https://www.hemnet.se/bostad/22057864 (saved as
`test-fixtures/hemnet-detail-minimal-22057864.apollo.json`).

### What changed

| Piece | Change |
|---|---|
| `lib/hemnet-fetch.js` `parseActiveListing` | Also returns `activePackage`, `isTeaser`, `isProject`, `isProjectUnit` and the listing's type (`typename`). Missing values stay `null`; they are never guessed. |
| Same function | If the page has **no** `ActivePropertyListing` but stores this listing under another type (e.g. a future aggregated or "under the radar" teaser type), it returns `status: 'unrecognised'` instead of `inactive`. Before, such a listing would have been marked inactive, started the drop streak, and silently left the views data. |
| `hemnet-targeted-refresh.js` | After the normal views update, writes the format to new columns on `hemnet_listingv2` and adds a row to `hemnet_listing_format_history` **only when the format changed** (first sighting, paid → free, upgrade). An `unrecognised` listing's row is left untouched. Each run summary now has `packages` (count per package), `teaserCount`, `unseenPackages`, `unrecognisedTypes`, `formatChanges`. |
| Same file | **New Slack warning** (key `hemnet-new-listing-format`) when a package isn't in `KNOWN_PACKAGES`, a listing has no package at all, or a page type isn't recognised. Written in plain English: what changed, how many listings, next step. Keyed, so it follows the normal re-notify ladder rather than firing every run. |
| `migrate-hemnet-listing-format.js` (new) | Adds the columns `active_package`, `is_teaser`, `listing_typename`, `is_project`, `is_project_unit`, `format_seen_at`, and the table `hemnet_listing_format_history`. Idempotent. `--down` reverts. |

Known packages at launch: `BASIC`, `PLUS`, `PREMIUM`, `MAX` (paid), `MINIMAL` (free),
`NC_PREMIUM_PROJECT`, `NC_PREMIUM_PROJECT_UNIT` (new-build projects). MINIMAL is known, so it
does **not** alert. It is counted in every run summary instead.

**No extra Oxylabs cost:** the fields come from the listing pages the refresh already fetches.

**Design choice: the views refresh never depends on the new columns.** The format write
is a separate statement, and the job checks the columns exist before using them. If the
migration hasn't run, or has been reverted, the job logs one warning and carries on
exactly as before.

**Not changed:** `hemnet-targeted-match.js` still only pairs listings it can read as
`ActivePropertyListing`. A listing of an unrecognised type is logged and not paired,
which is the conservative choice. The views reports don't use the new columns yet; that
comes next.

### Tests

- `node lib/hemnet-fetch.js --smoke`: 8 pass. Includes the real free listing (MINIMAL) and
  a real paid pre-market listing (PREMIUM, saved Aug 2026).
- `node hemnet-targeted-refresh.js --smoke`: 12 pass. Known packages don't alert; an unseen
  package and an unrecognised type produce the plain-English warning; the views update SQL
  doesn't touch the new columns; history is change-only.
- The migration and both new SQL statements were run against the production database
  inside a transaction that was rolled back. They apply, the history table records a first
  sighting, skips an unchanged refresh, and records PREMIUM → MINIMAL → PREMIUM as two
  changes. `--down` removes everything. Nothing was left behind.

### Deploy order

1. `git pull --ff-only` on the droplet. Safe on its own: tracking stays off until step 2.
2. `node migrate-hemnet-listing-format.js` on the droplet.
3. The next `hemnet-targeted-refresh` run (every second day) starts filling the columns.

### How to revert

- **Turn tracking off but keep the data:** nothing to do in code. Simply don't use the
  columns. To silence the alert only, add the new value to `KNOWN_PACKAGES` /
  `KNOWN_TYPENAMES`.
- **Revert the code:** `git revert <commit>`, then pull on the droplet. The old code ignores
  the extra columns, so they can stay.
- **Remove the schema as well:** `node migrate-hemnet-listing-format.js --down` (drops the
  columns and the history table; the format history is lost).
- The `unrecognised` status is the one behaviour change outside format tracking. If it ever
  needs undoing on its own, delete the `findListingTypename` branch in `parseActiveListing`;
  those listings then go back to being treated as inactive.

### When the alert fires

1. Open one of the listings with the new value: `view-source:` on the listing page, search
   for `activePackage` and `__typename`.
2. Decide how the views reports should treat it (paid / free / aggregated / exclude).
3. Add the value to `KNOWN_PACKAGES` or `KNOWN_TYPENAMES` in `hemnet-targeted-refresh.js`
   with a one-line note, and record the decision here.
4. For an unrecognised page type, `parseActiveListing` also needs teaching to read it,
   or those listings' view counts stay frozen.

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
