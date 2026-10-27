# Changelog

Changes to data collection that affect what the stored series mean. Newest first.
Record a data gap or a definition change here as soon as it's known, even
before it's fixed.

---

## 2026-10-28 — Hemnet aggregated listings go live; census, pre-market flow and ad-cost repaired

### What Hemnet changed (seen live 2026-10-27 ~22:20 UTC)

- **Aggregated listings** (copied from agency websites, `activePackage: "AGGREGATED"`) now
  appear in search and in every count. Every search key gained `"aggregated":"INCLUDE"`.
  They have **no view counter** (`timesViewed: null`) and often no asking price.
- Overnight, Hemnet's own counts moved:
  - pre-market (kommande): **7,645 → 27,435**; in Stockholm, 3,568 of 4,466 are aggregated (80%)
  - for-sale: **47,397 → 62,844**
- **No URL setting excludes them**: `aggregated=EXCLUDE`, `minimal=EXCLUDE` and
  `aggregated=ONLY` are all ignored.
- **More package values are in use:** `TEASER`, `NC_BASIC_PROJECT` and
  `NC_BASIC_PROJECT_UNIT`. The listing-format alert (`hemnet-new-listing-format`) will fire
  for these. That is expected; see "When the alert fires" in the 2026-10-27 entry.
- **Short result pages are padded with recommendations.** A results page always shows 50
  cards. When fewer results are left, the rest come from a separate `recommendations` list,
  outside the filter. For example, Alingsås pre-market page 2 shows 25 real results and
  25 others.

### Series breaks

| Series | From | Effect |
|---|---|---|
| `market_totals` Hemnet `till_salu`, `kommande` | 2026-10-28 | Hemnet's all-types count. Not comparable with earlier days, and cannot be made comparable from the totals page. |
| Age census, Hemnet pools | 2026-11-01 | Stored histogram **excludes MINIMAL + AGGREGATED**, so it stays comparable. Hemnet's all-types figure is in notes and JSON. |
| Pre-market flow, Hemnet | 2026-11-02 | Adds exclude MINIMAL + AGGREGATED. Stock = Hemnet's count × comparable share from the latest census. **No Hemnet rows for 12/19/26 Oct.** |

The definition of "comparable" lives in one place: `NEW_LISTING_TYPES` in
`lib/age-census.js`. Change it there if the team decides differently.

Early reading (live, 2026-10-27): comparable second-hand pre-market adds on Hemnet were
**621** in the last 7 days, against 793–1,003 a week in September. In the same 7 days there
were 990 MINIMAL and 1,144 AGGREGATED adds. This fits agents moving pre-market listings to
the free tier. One week of data; worth watching.

### What changed in the code

- `lib/hemnet-fetch.js`
  - `parseSearchTotals` accepts any `"INCLUDE"` arg, and takes an optional exact `scope`.
  - New `parseSearchIncludes` lists the INCLUDE args on a page.
  - New `parseSearchPage` reads the page's own result list (`cards`), never the
    recommendations. It also returns the filters Hemnet actually applied.
  - Cards carry `activePackage`.
- `market-totals-daily.js`
  - Tonight's run would have failed on the new arg; fixed.
  - Records `hemnetIncludes`.
  - Warns with `hemnet-listing-types-changed` when the set differs from
    `KNOWN_HEMNET_INCLUDES`. Rows are still written.
- `lib/age-census.js`
  - `newAccumulator({ splitTypes: true })` keeps an all-types tally (used by walk
    termination and gates), plus `cmp` (comparable) and `byType`.
  - New `allTypesSummary`.
- `scripts/hemnet-forsale-age-census.js`: now the engine for **both** Hemnet pools,
  `run({ pool })`.
  - URLs are `/till-salu?upcoming=EXCLUDE|ONLY&location_ids[]=…`.
  - The filters Hemnet applied are checked on every page. An ignored filter counts as a
    failed page.
  - Big scopes are split by property type, then by **rooms**, not price. Most pre-market
    and aggregated listings have no price, so a price split found only 1,059 of
    Stockholm's 4,466. Item type gains `other`.
  - Gates run on all types. The stored row is comparable-only. `allTypes` holds the full
    picture.
- `scripts/hemnet-age-census.js` delegates to the engine with `pool: 'premarket'`.
- `scripts/age-census-monthly.js` saves each pool's full result as
  `verf-flow-probe/age-census-<platform>-<pool>-<date>.json` before writing to the DB.
- `scripts/forsale-age-penetration.js` (Booli for-sale)
  - The depth search treats a page that won't load as past the end.
  - On 2026-10-01, page 1259 returned Oxylabs 613 on all 8 attempts and the rethrow lost
    the whole pool. October's Booli for-sale snapshot is unrecoverable.
- `scripts/premarket-flow-measure.js`
  - Hemnet side rebuilt: `/till-salu?upcoming=ONLY`, walked per property type (7 national
    walks; nationally the 7-day window now sits at the 2,500 cap), comparable listings only.
  - Stock is scaled by the census share. With no census on disk, the Hemnet side fails.
  - **Guarded with `require.main`.** It used to start the live job when loaded, so any
    `node scripts/premarket-flow-measure.js --anything` was a real run.
  - New `--selftest`.
- `scripts/adcost-crawl.py`
  - New retry pass: still-failed cells get one more round on a rebuilt session.
  - On 2026-10-01, scattered failures (cells 5, 6, 23, 24) were never retried, and the
    month stopped at 392/420.

### Verified live (no writes)

- Market totals: 62,844 for-sale + 27,435 pre-market = 90,279 combined, exact.
- Census engine: every check reconciled exactly (counted = Hemnet's headline).
  - Alingsås pre-market: 75/75, 3 requests.
  - Alingsås for-sale: 169/169, 5 requests.
  - Stockholm pre-market: 4,466/4,466, 111 requests.
  - Stockholm for-sale: 3,493/3,493, 92 requests.
- Pre-market flow Hemnet walk: 71 requests, no type hit the cap. Property types add to
  Hemnet's total within 0.3%.
- Expected size of the 1 Nov census: about 2,900 Oxylabs requests (up from ~2,140).

### How to revert

- `git revert` the commits: 00b58aa (market totals), 6868f87 + 0aded00 (census),
  781f69b (flow), 178a08e (ad-cost).
- No schema changes. Note that reverting the Hemnet parts brings back code that cannot
  read Hemnet's current pages.
- To count every listing type as comparable again, empty `NEW_LISTING_TYPES`.

---

## 2026-10-27 — Daily health report: plain-English summary on top

**Why:** the daily report in #hemnet-ops was accurate but hard to read. It used script
names, "tier 1", "assertions", "backstop" and raw error text, and listed most problems
twice (in its section, then again under "Issues").

**What changed (wording only; every check is unchanged):**
- New `lib/health-plain.js` builds a short summary that now leads the message:
  - **Needs attention:** one numbered line per broken job, merging every section that
    complains about it. Each line gives the job's plain name, what went wrong in plain
    words, and what we lose.
  - **Keep an eye on:** warnings and repeating conditions.
  - **All good:** a few key numbers (new cohort size, view refresh counts, disk).
- The existing technical sections follow below a divider, unchanged, for whoever fixes
  things. The duplicated trailing "Issues" list is gone.
- `cron-health-slack.js` collects problems that belong to no single job (disk, stale
  views, newest-cohort canary) in plain words for the summary. Exit codes, alerting and
  the sweep/heartbeat modes are unchanged.

**Extending it:**
- New job: add its plain name and "what we lose" to `JOB_INFO` in `lib/health-plain.js`.
  Otherwise it shows its script name.
- New kind of error or check wording: add to `ERROR_RULES` / `ASSERT_RULES`. Otherwise the
  raw text shows, trimmed and quoted.

**Tests:** `node lib/health-plain.js --smoke` (8 pass) renders the real 27 Oct report's
inputs and checks there is no jargon, each broken job appears once, and paths and crash
text are hidden. It was also previewed read-only against live data.

**Revert:** `git revert <commit>`. No data or schema involved.

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

All three were fixed on 2026-10-28; see that entry. The for-sale census never needed the
OLDEST sort, because it walks every scope to the end.
