# Changelog

Changes to data collection that affect what the stored series mean. Newest first.
Record a data gap or a definition change here as soon as it's known, even
before it's fixed.

---

## 2026-11-04 — Views tracked on paid Hemnet ads only; new "sellers paying for Hemnet" line

- Team decision: the H% view share compares Booli for-sale homes with their **paid** Hemnet ad
  only. Hemnet's free tier (MINIMAL, 20 Oct) was ~40% of the W43/W44 pairs and gets less
  visibility, which pulled H% down for reasons unrelated to buyer demand. Every cohort before
  20 Oct was all paid, so the paid series is like-for-like with history (W41: 0 pairs left out;
  W44: 547 paid kept, 382 free/other left out).
- `export-hb-ratio-xlsx.js` (per-cohort workbook + charts, and so the cross-cohort chart) keeps
  paid pairs only; `--all-packages` restores the blended view. The like-for-like Slack headline
  was already paid. Free pairs are still collected and tracked (`hpct_free` in the CSV).
- New `lib/paid-coverage.js`: share of each cohort's Booli new homes with a paid Hemnet ad
  (pairs + unmatched; removed pairs count as not matched), in the weekly view pack. History:
  ~45% in May and Aug, ~37% in summer, drifting to 31.8% by W42 (before the free tier), then
  26.0% W43 and 24.9% W44, with 17–18% on free ads.
- `hemnet-targeted-match.js`: twins that are aggregated (copied agency ads) or have no view
  counter are counted as `untrackableTwins` and skipped instead of failing the INSERT as parse
  errors; they leave the match-rate denominator (from draft branch `draft/paid-free-split`).

## 2026-11-04 — Spot-check: clear mismatches removed automatically; backlog cleared

- Nobody had reacted to the spot-check review queue since 24 Aug (Julian, the only allowed
  reactor): 228 open items, W34–W44. Glenn's decision: the gate (`cohort-spotcheck-gate.js` 9a)
  now soft-removes every CONFIRMED_MISMATCH pair itself (audited in `spotcheck_removed_pairs`,
  `human_verdict` AUTO_REMOVED, reactor `auto-spotcheck`, recoverable with
  `UPDATE cohort_pairs SET removed_at = NULL WHERE id = …`) and lists them in the review thread.
  Only UNCERTAIN pairs are posted for a human; Glenn reviews them (added to
  `SLACK_ALLOWED_REACTORS`). The 7-day unanswered warning stays.
- Known accuracy: of 15 automatic MISMATCH verdicts Julian reviewed (Jun–Aug), 8 were real and 7
  were the same home. Accepted: wrongly removing a pair costs ~1% of a cohort's sample, keeping a
  wrong pair puts bad data in the views comparison. Removal leans on price/size divergence, so it
  may slightly under-represent homes whose price changed between the sites.
- Backlog (`scripts/clear-spotcheck-backlog.js`): open MISMATCH items removed the same way;
  other open items before W44 marked CLEARED_STALE (pair kept); W44's uncertain items left open.

## 2026-11-04 — Removed Hemnet ads read as "unrecognised page type" (one refresh run)

- The 3 Nov 15:01 UTC `hemnet-targeted-refresh` run (the first since the App Router fix) alerted
  on 133 `DeactivatedPropertyListing` + 4 `DeactivatedBeforeOpenHousePropertyListing` pages.
  These are ordinary removed ads (label REMOVED "Borttagen från Hemnet", `deactivatedAt` set):
  the App Router pages now carry an entity for them, the old pages carried none. Those 137 rows
  were left untouched for that run (no drop-streak step); nothing else affected.
- `parseActiveListing` (lib/hemnet-fetch.js) now reads them as inactive, as before
  (`DeactivatedBeforeOpenHouse…` → `removed-before-showing`).

## 2026-11-04 — Weekly new listings: counting method replaced before first use

The 2026-11-03 method below was never used: checked against the first full sweep it counted
almost nothing. **Hemnet ids are not a clock**: the ads copied from agency sites since October
got fresh ids but keep the agency's old publish date, so "ids between Monday's highest and the
next Monday's" collapses. Nothing was written or posted with it.

- **New paid listing** = an ad first seen with a paid package (BASIC/PREMIUM/MAX) after the full
  sweep of 3 Nov: a new ad, or a free / copied / teaser ad switching to paid. Week = its publish
  time (buying a package resets it). Re-publishing, renewing or upgrading an ad already paid does
  not count: on 2 Nov ~900 of ~1,100 paid ads with that day's date were old ads re-published,
  and only ~190 were new. Total vs for sale by the tier at that sighting.
- **Wk 2 Nov is partly reconstructed** (flagged estimate): 2–3 Nov were before the sweep, so only
  recent ids (≥ 22.0M) published from 2 Nov count; old ads switching back to paid those two days
  are missed. Wk 9 Nov is the first fully counted week.
- **Wk 19 + 26 Oct estimates** now come from **Hemnet's monthly paid figure**
  (`/statistik/finansiell-rapportering`, type `paid`, from Feb 2026): Feb–Sep 2026 it ran at
  0.76× the workbook total (range 0.70–0.81; Hemnet's "paid" leaves out some ads the weekly page
  always counted; its `published` series ≈ the workbook, 0.91–1.01). October paid 8,592 ÷ 0.764 =
  11,243 on the workbook scale, less 6,496 already in the workbook for 1–18 Oct = 365 a day for
  19–31 Oct → **2,556 total / 1,763 for sale a week (Sweden)**, Stockholm/VG/for sale by their
  shares over the previous 8 weeks. Both weeks get the same figure. About ±10%.
- **The weekly check against Hemnet's public figure is gone** (it counts free and copied ads, so
  it cannot check a paid count). Instead, **every complete month from November** our paid count
  (scaled for days before 2 Nov) × 0.764 is checked against Hemnet's monthly paid figure, ±12%;
  outside that the post warns and the job goes amber. First check: early December.
- A week whose Monday daily walk did not run ok is **held back** to the next Monday (the walk
  catches up on its own), so the series never gets a half-read week.
- New series in `hemnet_weekly_new_listings`: `registry_switched` (of the paid count, ads that
  switched to paid), `registry_new_paid|free|aggregated|other` (ad ids first seen that week, by
  first package), `hemnet_paid_monthly` (month start, Sweden). `registry_all/paid/upgrades` are
  not written.
- Early sign (2 Nov only, not yet a finding): new free ads (~280) outnumbered new paid ones (~190).

## 2026-11-03 — Weekly new listings for the MASTER workbook: now from our own data (GrokBot retired)

*(Counting method and estimates superseded by 2026-11-04 above before first use.)*

- **The workbook**: Glenn's `DATA MASTER\WEEKLY PROPERTIES\MASTER_updated_DDMMYY.xlsx`, weekly new
  pre-owned listings for Sweden, Stockholms län and Västra Götalands län (total, for sale,
  pre-market = total − for sale), back to Dec 2013. Source was Hemnet's public
  `hemnet.se/statistik/nytillkomna` (pre-owned), downloaded by hand or by GrokBot.
- **Series break, wk 19 Oct 2026**: that page now counts free (MINIMAL) and aggregated ads too
  (Sweden for sale ~1,850 → 4,022 a week). The workbook was brought to wk 12 Oct
  (`MASTER_updated_121026.xlsx`, 4 weeks from GrokBot's file, checked against Hemnet) and
  stops there on the public figure.
- **From wk 19 Oct the workbook is PAID new listings counted from the ad registry**
  (`lib/weekly-new-listings.js`): new ad = an id created that week (ids are sequential;
  renewals keep their id), pre-owned only, total/for sale by the tier first seen, paid = ever
  seen with a paid package, plus older free/aggregated ads upgraded to paid that week.
  Every week our count of ALL new ads is checked against Hemnet's public figure (±5%).
- **Wk 19 + 26 Oct are estimates** (no paid-only count exists): Hemnet's total × paid share of
  that week's ads still live at the first sweep (`scripts/seed-weekly-master.js --estimate`).
  Flagged in the table, the CSV, the Slack post and raw-sheet column C of the workbook.
- **Pipeline**: `weekly-new-listings.js` (server, Mon 06:15 UTC) → table
  `hemnet_weekly_new_listings` → `view-data/weekly-new-listings/master-series.csv` + Slack post
  (the Dashboard's three lines). `tools/update-master-workbook.ps1` (Glenn's PC, scheduled task
  "Hemnet MASTER weekly update", Tue 09:00 Sydney (moved from Mon 19:00 on 2026-11-04)) adds the new weeks to a NEW
  `MASTER_updated_DDMMYY.xlsx` through Excel; on failure it leaves
  `MASTER_update_FAILED_<date>.txt` in the folder. Log: `%LOCALAPPDATA%\hemnet-master-update.log`.
- Hemnet's public weekly data is fetched directly:
  `/statistik/nytillkomna?resolution=WEEK&marketState=ALL|FOR_SALE&successionType=PRE_OWNED&locationId=17691|17744|17755`.
  Hemnet revises past weeks by ±1–3; the workbook keeps the figures as first recorded.
- Paid-only cross-check for the future: `/statistik/finansiell-rapportering` = "publicerade och
  betalda objekt", monthly, Sweden (Hemnet's quarterly-report definition).

## 2026-11-04 — Hemnet ad registry: what kind of ad every live Hemnet ad is; sold-match "paid ad"

- **Why**: Hemnet now shows free ads (MINIMAL, since 2026-10-20) and ads copied from agency
  sites (AGGREGATED, since ~2026-10-27). Sold-match's "matched on Hemnet" therefore no longer
  means "a paid Hemnet ad". Hemnet's sold pages carry no package, so the only way to tell is
  to record each ad's package **while it is live**.
- **Two new tier-1 jobs** write `hemnet_ad_registry` (one row per ad id, every package it has
  been seen with), `hemnet_ad_package_history` (first sighting + every package/tier change) and
  `hemnet_ad_sweep_run` (one row per walk, with counts by tier × package):
  - `scripts/hemnet-ad-daily.js`, daily 05:30 UTC — newest ads first until a page is older than
    the cutoff. Hemnet orders by publish day, then package; buying a package resets the publish
    date, so upgrades come back to the top and are caught the next morning.
  - `scripts/hemnet-ad-sweep.js`, Sundays 06:00 UTC — every live ad via the age-census walker
    (`run({ onCards })`), with its completeness gates. Ads not seen are marked gone **only**
    when both pools pass the gates.
- **Aggregated ads carry the agency's own publish date** (one seen 2026-11-03 said May 2026),
  so the daily walk does not see newly aggregated ads; the weekly sweep does.
- **Sold-match**: `lib/sold-ad-type.js` labels each matched home paid / new-build / free /
  aggregated / no ad found / not seen live, by the ad id on the sold card (or the address
  fallback's listing page), plus same address + kommun + living area + rooms within ~6 months
  of the sale. Rule: **paid if any of the home's ads was seen with a paid package at any
  point while listed**. New-build projects (NC_*) are reported separately, not as paid.
  The weekly Slack post gains a "paid ad" column (a dash until ≥75% of that run's matched homes
  have a known type) and a breakdown line; the audit xlsx gains a "Hemnet ad type" column.
- **Coverage starts 2026-11-04**: ads that came down before then can never be typed. The 16 Nov
  batch (sales from 26 Oct) will be mostly "not seen live"; it fills in over ~6–8 weeks.
- **Finding, sold cards with no ad id**: 18–22% of matched sales per run since June match a
  Hemnet sold card whose `listingId` is empty (no package, no labels, mostly "price on
  request"). This is NOT proof of no ad: about half of them (517 of 1,028) had a live Hemnet
  ad at the same address in `hemnet_listingv2`. The registry will settle it for new sales.
- **Hemnet has dropped the Plus package** (confirmed by Glenn 2026-11-03; none among ~2,200 new ads 1–3 Nov). PLUS stays in the paid set so older ads still classify.
- Card parser (`parseListingCards`) gains additive fields (slug, recordType, area, rooms,
  coordinates, agency…). Cost: ~2,500 Oxylabs calls a week for the sweep plus ~25–30 a day
  for the daily walk; within the flat plan.

## 2026-11-03 — Weekly view pack: like-for-like views (CSV + Slack block); package saved at match

- **New measure**: `lib/views-like-for-like.js`. Weekly Hemnet share of views (H%) on
  the same homes on both sites, days 8–28 of listing, Hemnet re-publishes and outage
  spans left out, pooled per Mon–Sun week; headline is **paid listings only**, with
  free, pre-market carryover (`booli_views_day0 >= 100`) and fresh splits, views per
  listing per day for each site, homes counted, and a `flag` column (outage / partial
  week, frozen counters, unknown package, small sample). Method is the 2026-10-27 deep
  dive's (see the view-share notes), now automated.
- **Always all three outputs**: `weekly-view-report.js` writes
  `view-data/<date>/views-like-for-like.csv` (full weekly history from 1 Jun, unfinished
  week left out) **and** `views-like-for-like.xlsx` **and** adds a "Views, like-for-like"
  block to its Slack post for the Mon–Sun week before the pack date. The scorecard bot
  reads the CSV or the post. The cross-cohort and per-cohort charts are unchanged and still
  in the pack.
- **Workbook** (`views-like-for-like.xlsx`): Weekly sheet = the CSV table with every share
  and per-day figure as a SUMIFS over the Intervals sheet; Intervals = one row per home per
  step between readings in the age window (readings, gains as formulas, counted or why
  not); Method = the rules. ~138k rows / 16 MB for Jun–Oct; Excel's own recalculation
  reproduced the CSV exactly (checked 2026-11-03).
- Added to the 2 Nov pack after the fact (CSV + workbook), so that week's scorecard can use them.
- `weekly-view-report.js --dry-run` now really is a dry run. It ignored the flag before and
  posted for real, although the handover docs listed it as a safe preview.
- First values: week of 26 Oct paid 67.4% (19 Oct 69.4%), half a week (27/29 Oct) because
  of the Hemnet outage. The 9 Nov pack (2–8 Nov) is also partial: the 3 Nov reading spans
  the outage, so only 5 and 7 Nov count. 16 Nov is the first complete week.
- `lib/listing-segment.js` (paid/free classification) moved onto master from the
  `draft/paid-free-split` branch for this block only; the xlsx/chart paid/free split on
  that branch is still awaiting the team.
- **hemnet-targeted-match now saves the listing format** (`active_package`, `is_teaser`,
  `listing_typename`, `is_project`, `is_project_unit`, `format_seen_at`) when it matches a
  home. Before, only hemnet-targeted-refresh did, so a new cohort had no package until
  its first refresh, and none while the refresh was down (W44: 926 of 951 unknown).
  Separate statement, never fatal to the match.

---

## 2026-11-03 — Hemnet moves to the App Router; every Hemnet reader repaired (deployed 2026-11-02 UTC)

### What Hemnet changed (~2026-10-30)

- hemnet.se now serves its search, sold and most listing pages from the Next.js **App
  Router** (Booli made the same move on 2026-09-21). There is no `__NEXT_DATA__` and,
  unlike Booli, **no Apollo cache at all**: no `initialApolloState`, no `ROOT_QUERY`.
- The data is all still on the page, inside the flight payload (`self.__next_f`):
  - search: `ListingResultsCombined { total, cards[], recommendations[] }`, with the
    query in a separate `variables: { searchParams, offset, sort }` block. Some
    `searchParams` values are RSC pointers (`"$61:props:…:housingFormGroups"`).
  - sold search: `SoldListingResults { total, cards[] }` (`SaleCard`)
  - listing page: `ActivePropertyListing` with every field we read (views, package, …),
    but `municipality` / `county` nested inline instead of `__ref` pointers.
- The **default /till-salu page no longer carries a kommande count** — only its own
  combined total. Kommande has to be read from `/till-salu?upcoming=ONLY`.
- Rollout was mixed on 2026-11-03: some sold listing pages were still Pages Router.

### What broke, 2026-10-30 → fix deployed

Every job that reads Hemnet: market-totals-daily (Hemnet rows), hemnet-targeted-refresh
(no views updated), hemnet-targeted-match (0 matches), the 1 Nov age census (both Hemnet
pools), cohort-create (W44: 25 pairs instead of ~1,000), cohort-spotcheck-gate, and the
2 Nov pre-market flow (Hemnet side). Sold-match would have failed on its next run (16 Nov).

### Data gaps

| Series | Gap | After the re-runs (2026-11-02 UTC) |
|---|---|---|
| `market_totals` Hemnet `till_salu`, `kommande` | 2026-10-30 → 2026-11-01 | 2 Nov written: 62,801 + 27,167 |
| Hemnet view counts (cohort tracking) | readings 31 Oct and 1 Nov frozen at 29 Oct | blanked; see "Views outage" below |
| Age census, Hemnet pools | 2026-11-01 run missing | re-run for RUN_DATE 2026-11-01: pre-market 6,454, for-sale 43,043 (comparable) |
| Pre-market flow, Hemnet | 2026-11-02 missing | re-run: 554 Hemnet vs 2,346 Booli additions (report shows 23.6% = Hemnet ÷ Booli) |
| Cohort 2026-W44 | 25 pairs only | rebuilt: 951 pairs (backup of the 25 in `/var/log/hemnet/backup-2026-W44-before-rebuild-2026-11-02.json`); spot-check 4.1% |

### Views outage: frozen readings blanked, charts show a labelled gap

- Every Hemnet view reading on **31 Oct and 1 Nov** (5,919 rows, cohorts W36–W43) equalled
  the pair's 29 Oct reading: `hemnet-targeted-refresh` updated nothing, so `cohort-track`
  re-read stale counts. Left in, they show H% falling ~11–13 points on 31 Oct and then a
  spike on the first good reading (3 Nov), when five days of Hemnet views meet two of Booli.
- Those `cohort_daily_views.hemnet_views` were set to NULL (Booli kept). Only rows equal to
  the previous reading were touched; W44's 2 Nov readings (post-fix) were not. Backup:
  `/var/log/hemnet/backup-hemnet-views-outage-2026-10-30_2026-11-02.json` (id, pair_id,
  date, hemnet_views). To revert: `UPDATE cohort_daily_views SET hemnet_views = <value>
  WHERE id = <id>` for each row.
- Every reader already skips a null reading, so nothing else changes. NULL here means
  "not captured", not "not live"; this is the only such window.
- The counters are cumulative, so no views are lost: 3 Nov carries everything since 29 Oct.
  Lost is only how they spread over 30 Oct – 2 Nov, plus the last days of homes that came
  off the market during the outage.
- `lib/view-outages.js` lists the outage; the per-cohort `charts.html` and the cross-cohort
  H% chart shade it ("Hemnet data outage, website change"), break the line across it
  instead of `spanGaps` joining it up, and add a methodology note. The per-cohort chart
  resumes on 5 Nov (it looks back one reading), the cross-cohort chart on 7 Nov (two).
- `chart-hb-ratio.js` (x axis = days since listing) has no calendar band to draw; with the
  nulls its 7-day lookback simply measures across the outage from good readings.

### The fix

- `lib/scrape-http.js` `extractFlightSearchState`: rebuilds the OLD Apollo shape from the
  page (`ROOT_QUERY.search["listings({limit,offset,search,sort})"]`, `searchSales(…)`,
  `ListingCard:<id>` / `SaleCard:<id>`), resolving the RSC pointers. `extractApolloState`
  uses it automatically for App Router pages without an Apollo cache, so
  `parseSearchTotals`, `parseSearchPage`, `parseSearchIncludes` and the census filter
  check are unchanged. Throws (never returns empty) when the result node or its query
  variables are missing.
- `extractDetailState`: listing pages from either router. Used by `fetchDetail` and
  `lib/sold-serp.js`. `resolveRef` accepts inline entities.
- `market-totals-daily.js`: kommande now from `/till-salu?upcoming=ONLY` (`source_url`
  changes accordingly); 3 Hemnet fetches/day instead of 2. The partition cross-check is
  unchanged and was exact on 2026-11-03: 62,802 + 27,166 = 89,968.
- Census, sold transport and the three `fetch*` helpers switched to the router-agnostic
  extractors.
- Tests run against the real pages captured 2026-11-03:
  `test-fixtures/hemnet-approuter-2026-11-03/` (gzipped; loader `test-fixtures/hemnet-approuter.js`).

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
