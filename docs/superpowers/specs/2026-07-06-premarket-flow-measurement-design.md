# Pre-market flow & staleness measurement — design spec

**Date:** 2026-07-06 · **Status:** design approved, pending spec review
**Author:** brainstorm session (Julian + Claude)

---

## 1. What we're really solving for

We currently track only the **stock** of pre-market listings ("Kommande" on Hemnet,
`upcomingSale` on Booli) as a weekly headline total. On stock, Booli's pre-market pool
(~33k) looks **~4× larger** than Hemnet's (~8k). That ratio is misleading: it's inflated
by aged backlog and new-build developer pre-sales that sit in "coming soon" for months.

The real question is **Hemnet vs Booli pre-market traction** — who is capturing more
*fresh* coming-soon supply — and whether Booli's 33k is genuinely valuable inventory or
mostly stale/new-build dross where the fresh, real listings arrive at a rate comparable
to Hemnet.

The clean signal is **flow** (second-hand listings *added* per week), not stock. Flow
strips out the backlog. Paired with **dwell** (how long the average listing sits) and
**new-build share**, it directly answers "is Booli's pre-market lead real or an artifact
of aged inventory?"

### Explicitly out of scope
- **Exclusivity / overlap matching** (is a Booli listing also on Hemnet?) — decided too
  hard/brittle for now. We measure each platform's own captured pre-market supply. Note
  Booli does **not** ingest Hemnet's feed, so the two flows are independent captures
  (same-property overlap can only happen if a broker posts to both independently).
- **Property-type split** — not needed.
- **For-sale flow** — pre-market only.
- **Per-county / regional breakdown** — national only.
- **Recurring cron / Slack / charts** — this spec is a **one-off run**, but writes results
  to a persisted table so the trend survives if we promote it later (see §7).

---

## 2. Scope (locked decisions)

| Decision | Value |
|---|---|
| Segment | Pre-market only (Kommande / `upcomingSale`) |
| Geography | National |
| Inventory | **Second-hand only** — exclude new builds |
| Cadence | One-off now; stored for future trend |
| Dimensions | None (no property-type / region split) |
| Overlap matching | Excluded |

---

## 3. Data sources (validated 2026-07-06)

Both platforms expose, on their **search-result cards**, a per-listing publish timestamp,
a pre-market flag, and a **new-build flag** — sorted newest-first. No detail-page fetches
required.

### Hemnet — Kommande
- URL: `https://www.hemnet.se/kommande/bostader?sort=NEWEST&page=<N>`
- Cards: `ListingCard:*` in `__APOLLO_STATE__` (parsed by `lib/hemnet-fetch.js::parseListingCards`)
- Per-card fields used: `publishedAt` (Unix seconds), `upcoming` (bool),
  **`newConstruction` (bool)** + `projectId` (present on project listings)
- Stock total: `ROOT_QUERY.searchUpcomingListings(...).total` (~8,250) — **includes new builds**
- Sort token: `sort=NEWEST`

### Booli — pre-market
- URL: `https://www.booli.se/sok/till-salu?upcomingSale=1&page=<N>`
- Cards: `ROOT_QUERY.searchForSale(...).result` refs → `Listing:*`
  (parsed by `lib/booli-fetch.js::parseBooliSearchCards`)
- Per-card fields used: `published` (string `YYYY-MM-DD HH:MM:SS` → Unix via
  `parsePublishedToUnix`), `upcomingSale` (bool), **`isNewConstruction` (bool)**
- Stock total: `searchForSale(...).totalCount` (~33,410) — **includes new builds**
- **No `sort=` param** (any sort flips Booli to oldest-first; default is newest-first)
- **National works as a single stream** via `upcomingSale=1` (returns only pre-market
  cards, `totalCount` matches the national facet). The plain no-filter national query is
  anomalous (`totalCount` 1,611) — **do not use it**; the `upcomingSale=1` filter is the
  validated national path.

### Required parser extensions (small, additive, non-breaking)
Neither card parser currently surfaces the new-build flag. Both need one additive field:
- `parseListingCards` (hemnet): add `newConstruction: entry.newConstruction === true`
  (optionally `projectId`).
- `parseBooliSearchCards` (booli): add `isNewConstruction: listing.isNewConstruction === true`.

These are additive-only (the cohort scraper consumes these parsers; no existing field
changes) and must be covered by the existing `--smoke` self-tests.

---

## 4. Method

### 4.1 Flow (the traction number) — exact, per-listing
For each platform, walk newest-first pages accumulating cards. A card counts toward
`adds_window_secondhand` iff **both**:
1. `published >= NOW - 7*86400` (inside the 7-day window), **and**
2. new-build flag is `false` (second-hand only).

Counting is **per-listing**, evaluated card-by-card — never `pageSize × pageCount`. On the
boundary page we count only the specific in-window cards.

**Stop condition:** stop paging once an entire page's cards are all older than the cutoff
(guards against minor out-of-order re-publishes better than "first old card"). A
`MAX_PAGES` safety cap bounds cost — set comfortably **above** the expected window depth
(Booli's ~48-page walk + margin → cap ~80), logging a warning if hit so a truncated walk
is never mistaken for a low flow number.

**Known bias (documented, accepted):** a listing added as pre-market during the week that
has already flipped Kommande→for-sale by run time has left the pool and won't be counted,
so `adds_window_secondhand` is a **floor**, not exact. The bias applies equally to both
platforms, so the **Hemnet-vs-Booli ratio stays fair**. (A future ID-diff method across
two stored snapshots removes the bias — hence storing from day one.)

### 4.2 Stock composition (the "is the 33k real?" evidence)
The headline `total`/`totalCount` includes new builds and aged listings. To characterize
the pool without walking all ~33k, take a **depth sample**: fetch a handful of pages spread
across the pool depth (e.g. Booli pages 1 / 100 / 300 / 600; Hemnet pages 1 / 50 / 100 /
160). For each sampled page compute new-build % and median listing age. This yields:
- `newbuild_share_pool_est` — estimated new-build fraction of the whole pool
- an age-band profile (how much of the pool is > 3 / 6 / 12 months old)

### 4.3 Derived metrics
- `flow_per_day = adds_window_secondhand / 7`
- `stock_secondhand_est = round(stock_total * (1 - newbuild_share_pool_est))`
- `mean_dwell_days = stock_secondhand_est / flow_per_day`
- **`premarket_share`** (cross-platform, computed at report time) =
  `hemnet.adds / (hemnet.adds + booli.adds)`

---

## 5. Components (each independently testable)

1. **Parser extensions** (`lib/hemnet-fetch.js`, `lib/booli-fetch.js`) — surface the
   new-build flag on cards. Pure functions; covered by `--smoke`.
2. **Flow walker** — given (page-fetcher, cutoff, MAX_PAGES) returns
   `{ adds_secondhand, newbuild_in_window, pages_walked, cards }`. Platform-agnostic;
   takes a per-platform card-normalizer.
3. **Depth sampler** — given (page-fetcher, sample page numbers) returns per-page
   `{ newbuild_pct, median_age_days, n }`.
4. **Metrics** — pure function: raw counts + samples → derived metrics (§4.3).
5. **Storage** — migration to create `premarket_flow_weekly` + an idempotent upsert.
6. **Orchestrator** (`scripts/premarket-flow-measure.js`) — wires 2–5 for both platforms,
   forces Oxylabs, prints the comparison, writes rows + a JSON/markdown artifact.

---

## 6. Storage — `premarket_flow_weekly`

One row per (`snapshot_date`, `platform`). Lives in the same prod DB as `market_totals`
(access via committed Node script / `db.js` — the droplet has no `psql`).

| Column | Type | Meaning |
|---|---|---|
| `snapshot_date` | date | run date |
| `platform` | text | `'hemnet'` \| `'booli'` |
| `window_days` | int | 7 |
| `stock_total` | int | site headline total (incl. new builds) |
| `stock_secondhand_est` | int | `stock_total × (1 − newbuild_share_pool_est)` |
| `adds_window_secondhand` | int | exact 7-day second-hand adds (floor — see §4.1) |
| `flow_per_day` | numeric | `adds_window_secondhand / 7` |
| `newbuild_share_window` | numeric | new-build % among fresh-window cards |
| `newbuild_share_pool_est` | numeric | new-build % from depth sample |
| `mean_dwell_days` | numeric | `stock_secondhand_est / flow_per_day` |
| `pages_walked` | int | flow-walk pages (provenance) |
| `oxylabs_calls` | int | total calls this run (cost tracking) |
| `created_at` | timestamptz | default `now()` |

`UNIQUE(snapshot_date, platform)` → re-running the same day upserts (idempotent).
`premarket_share` is derived at report time, not stored per-row.

---

## 7. Cost & plan headroom

- **Flow walk:** Hemnet ~700 adds/wk ÷ 50 ≈ 16 pages; Booli ~1,600 ÷ 35 ≈ 48 pages.
- **Depth sample:** ~4–6 pages each ≈ 10.
- **Total one-off ≈ 75–90 Oxylabs calls** (~$0.20 at list).
- Recurring (if later promoted): ~300–400 calls/month.

Account is at **~86% of the 262k non-JS monthly cap** (June 225k). This job adds
**~0.15%** → immaterial. All calls are non-JS (`render` unused) — do **not** route this
through JS/render (that draws on the smaller 199.2k bucket, already exceeded). The real
headroom risk is the queued cohort county expansion, not this job.

---

## 8. Output

Console + a written artifact (`verf-flow-probe/premarket-flow-<date>.{json,md}`) with the
headline comparison:

| Platform | Stock (2nd-hand) | Adds/wk (2nd-hand) | Mean dwell | New-build % of pool |
|---|---|---|---|---|
| Hemnet | … | … | … | … |
| Booli | … | … | … | … |

plus the derived **pre-market share** and a one-line read of stock-ratio vs flow-ratio vs
dwell (the "lead is real / lead is backlog" verdict). Slack/chart deferred.

---

## 9. Success criteria

- One-off run produces, for both platforms, second-hand `adds_window_secondhand`,
  `stock_secondhand_est`, `mean_dwell_days`, and `newbuild_share_pool_est`, persisted to
  `premarket_flow_weekly` (idempotent on re-run).
- The artifact clearly shows stock-ratio vs flow-ratio vs dwell so the "is Booli's
  pre-market lead real?" question is answered from data.
- Parser extensions are additive and pass `--smoke`.
- Total cost < ~100 Oxylabs calls.

---

## 10. Caveats (carried into the report)

- **Flow is a floor** (conversion undercount, §4.1) — ratio fair, absolute understated.
- **New-build pool share is a sampled estimate**, not a full census.
- **`published` semantics:** Hemnet `publishedAt` = time posted as Kommande; Booli
  `published` = time posted as upcoming. Both are "entered pre-market" timestamps —
  comparable for flow.
- **No same-property overlap** between platforms is measured (exclusivity out of scope).
- **Booli national** uses the `upcomingSale=1` filter (validated); the plain national
  query is anomalous and unused.
