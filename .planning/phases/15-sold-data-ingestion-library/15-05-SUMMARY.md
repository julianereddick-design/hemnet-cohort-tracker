---
phase: 15-sold-data-ingestion-library
plan: "05"
subsystem: lib/sold-fetch-hemnet, scripts/hemnet-sold
tags: [hemnet-sold, paginated-search, early-stop, search-cache, house-apt-opts, SOLD-05, MATCH-02, T-15-15, T-15-16, T-15-17]
dependency_graph:
  requires: [lib/sold-transport.js, lib/sold-parse.js, lib/sold-addr.js, lib/sold-config.js, lib/booli-to-hemnet-mapping.js]
  provides: [lib/sold-fetch-hemnet.js, scripts/hemnet-sold.js]
  affects: [Phase 17 orchestrator (searchSoldPaged per-record search half)]
tech_stack:
  added: []
  patterns:
    - Per-property /salda search-only (no detail fetch) — SaleCard fields come from Apollo search result only
    - Within-run URL-keyed searchCache + searchInFlight Maps for concurrent-safe dedup
    - House vs apartment search opts (wider bands + drop rooms/item_type for HOUSE)
    - CeilingError + ceiling-floor drain guard (remainingCalls() <= 40) for cost safety
    - normAddr imported from lib/sold-addr (MATCH-02 single source)
key_files:
  created:
    - lib/sold-fetch-hemnet.js
    - scripts/hemnet-sold.js
  modified: []
decisions:
  - "normAddr imported from lib/sold-addr (MATCH-02), not redefined — single source of truth across the pipeline"
  - "searchOptsFor HOUSE: priceBand=0.10, areaBand=0.15, dropRooms=true, dropItemType=true (street address is near-unique key; loose search avoids Booli/Hemnet rooms/subtype quirks)"
  - "searchOptsFor APARTMENT: empty opts (tight defaults: priceBand=0.05, areaBand=0.07, rooms+item_type included to stay under 50-card cap)"
  - "CeilingError caught in searchSoldPaged and returned cleanly as stopReason='ceiling'; remainingCalls()<=40 drain guard returns partial with stopReason='ceiling-floor' (T-15-15)"
  - "searchSold (within-run cache) exported for Phase 17 orchestrator; searchCache/searchInFlight are module-level Maps (process lifetime scope, not per-call)"
  - "hemnet-sold.js appends per-record results to verf-soldspike/hemnet-candidates/<segKey>.jsonl alongside the Plan-04 seeds path"
metrics:
  duration_seconds: 206
  completed_date: "2026-06-17"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 15 Plan 05: Sold-data ingestion library — Hemnet fetch (SOLD-05, MATCH-02)

**One-liner:** `lib/sold-fetch-hemnet.js` productionises the spike's per-property Hemnet /salda SaleCard search with a filtered URL builder, paginated early-stop (address-found / short-page / window / ceiling), within-run search cache, house-vs-apartment opts, and MATCH-02 normAddr from `lib/sold-addr`; `scripts/hemnet-sold.js` is the thin CLI wrapper.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Build lib/sold-fetch-hemnet.js (URL builder + paginated search + cache) | f2c143c | lib/sold-fetch-hemnet.js (created) |
| 2 | Build scripts/hemnet-sold.js thin CLI wrapper | 20dceb3 | scripts/hemnet-sold.js (created) |

## Verification Results

```
SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-hemnet.js --smoke  → smoke: 23 pass, 0 fail
node -c scripts/hemnet-sold.js                                → OK

AC1: node -e exports check (buildHemnetSoldUrl + searchSoldPaged)      → PASS
AC2: grep require('./sold-transport|parse|addr')                        → PASS (all 3 present)
AC3: grep 'salda' + 'location_ids'                                      → PASS (SOLD-05 /salda search)
AC4: grep -cE 'parseBooliSoldDetail|/bostad/'                          → 0 (no detail fetch — SOLD-05 constraint)
AC5: grep -q 'function normAddr' (expect absent)                        → PASS (normAddr imported, not redefined)
AC-CLI1: node -c scripts/hemnet-sold.js                                 → PASS
AC-CLI2: SCRAPE_FORCE_OXYLABS on line 3, before first require('../lib/') on line 8 → PASS
AC-CLI3: grep require('../lib/sold-fetch-hemnet')                       → PASS
AC-CLI4: grep assertOxyUsed + require.main                              → PASS
AC-CLI5: grep -cE "buildHemnetSoldUrl =|parseHemnetSaleCards|hemnet.se/salda\?" → 0 (PASS)
```

## Deviations from Plan

None — plan executed exactly as written.

- Task 1: `lib/sold-fetch-hemnet.js` productionised from `scripts/spike-hemnet-match.js` lines 78–194 with all specified components: `buildHemnetSoldUrl` (price/area/rooms/item_type filtered URL builder), `searchSold` (within-run cache with searchCache/searchInFlight Maps), `searchSoldPaged` (address/short-page/window early-stop pagination), `searchOptsFor` (house vs apartment opts helper), CeilingError + ceiling-floor drain guard. `normAddr` imported from `lib/sold-addr` (not redefined). No per-card detail fetch anywhere in the module.
- Task 2: `scripts/hemnet-sold.js` is a thin CLI wrapper with `SCRAPE_FORCE_OXYLABS='1'` as line 3 (before all lib requires), argv parsing for `--segment/--seed/--window-days/--max-pages`, per-record delegation to `searchSoldPaged`, JSONL output to `verf-soldspike/hemnet-candidates/<segKey>.jsonl`, and `assertOxyUsed()` at end. Zero URL-building/search/parse logic in the wrapper.

## Known Stubs

None. Both modules are infrastructure/search: no data-rendering paths, no placeholder text.

## Threat Surface Scan

T-15-15 (cost DoS — unbounded pagination): mitigated. `searchSoldPaged` caps at `maxPages`, early-stops on address-found/short-page/window, and drains at `remainingCalls()<=40` (returns partial, `stopReason='ceiling-floor'`). Every search page goes through `cachedFetch` (MAX_OXY_CALLS ceiling). Within-run `searchCache` dedupes identical URLs — concurrent workers sharing a URL pay only one Oxylabs call.

T-15-16 (malformed /salda Apollo): mitigated. Candidates built only from `parseHemnetSaleCards` (Plan 01 guarded parser). Non-200 responses are cached as `[]`. `normAddr` handles null safely (returns null). No eval.

T-15-17 (direct-curl bypass): mitigated. `scripts/hemnet-sold.js` sets `SCRAPE_FORCE_OXYLABS='1'` as line 3 before any lib require. `assertOxyUsed()` at end of `main()` sets `process.exitCode=2` if the transport guard fires.

T-15-18 (information disclosure): accepted. Output JSONL holds only public /salda SaleCard fields (street_address, final_price, living_area, etc.). No credentials logged or persisted.

No new trust boundaries beyond the T-15-15..18 register.

## Self-Check: PASSED

- lib/sold-fetch-hemnet.js: FOUND
- scripts/hemnet-sold.js: FOUND
- Commit f2c143c: confirmed in git log (feat(15-05): build lib/sold-fetch-hemnet.js)
- Commit 20dceb3: confirmed in git log (feat(15-05): add scripts/hemnet-sold.js thin CLI wrapper)
- smoke: 23 pass, 0 fail (sold-fetch-hemnet)
- All acceptance criteria returned PASS
