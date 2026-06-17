---
phase: 15-sold-data-ingestion-library
verified: 2026-06-17T00:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase 15: Sold-Data Ingestion Library Verification Report

**Phase Goal:** The spike's DB-free fetch/parse scripts become reusable lib/ modules that fetch and parse both sides of the sold-match — Booli /slutpriser seeds (paginated, sold-date early-stop, enriched attributes, soldPriceType classification with Lagfart exclusion-but-retain, "sold in advance" detection) and per-property Hemnet /salda SaleCard search — under the main fetch path's spend ceiling and transient-613 retry, with normAddr v2 recovering the spike's known false-negative address formats.
**Verified:** 2026-06-17
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A lib/ Booli-sold module returns parsed, enriched sold records (broker/agency, operating cost, construction year, tenure form, rooms, living area, floor, coords, soldPriceType, fee/rent when available) for a configured segment + rolling window, paginating and early-stopping on sold date | VERIFIED | `lib/sold-fetch-booli.js` exports `fetchBooliSold`/`fetchBooliSoldPage`; `lib/sold-parse.js` `parseBooliSoldDetail` returns all named fields (rent, operating_cost, construction_year, agent_id, agency_id, tenure_form, living_area, rooms, floor, lat, long). `--smoke` passes: 17 pass, 0 fail. Pagination loop with `maxSoldDate`/`minSoldDate` confirmed at line 75 and 205-206. |
| 2 | Each Booli sold record is classified by soldPriceType; deed transfers (Lagfart / isTitleTransfer) flagged excluded-from-matching but still returned for retention | VERIFIED | `parseBooliSoldCards` sets `is_title_transfer: isTitleTransfer(card.soldPriceType)` (sold-parse.js:73). `shouldFetchDetail` gates on `card.is_title_transfer` (sold-fetch-booli.js:150). Title-transfer records are written to JSONL output (not dropped) and `marketCollected` only counts `!is_title_transfer`. Smoke asserts `is_title_transfer=true` for Lagfart. |
| 3 | A recon step confirms where Booli encodes "sold in advance"; the module sets a distinct sold_in_advance flag accordingly | VERIFIED | `15-SOLD-IN-ADVANCE-RECON.md` exists: finding is "DETAIL FIELD — SoldProperty.soldAsUpcomingSale" (line 14). `scripts/sold-recon.js` has D-04 keyword set including 'förhand', 'advance', 'innan visning' (lines 169-171). `parseBooliSoldDetail` extracts `sold_in_advance: sp.soldAsUpcomingSale != null ? Boolean(sp.soldAsUpcomingSale) : null` (sold-parse.js:112). `sold-fetch-booli.js` sets `record.sold_in_advance` from `detail.sold_in_advance` per the recon finding, null for deed transfers (lines 294-297, 261). Operator approval marker "escalate detail (spend confirmed)" present in RECON doc (line 78). |
| 4 | A lib/ Hemnet-/salda module returns parsed SaleCard candidates per-property via search, paginating + early-stopping on sold date, NO per-card detail fetch | VERIFIED | `lib/sold-fetch-hemnet.js` exports `searchSoldPaged` and `buildHemnetSoldUrl`. `searchSoldPaged` has four early-stop conditions (lines 169-193). `grep -cE "parseBooliSoldDetail\|/bostad/" lib/sold-fetch-hemnet.js` returns 0. `--smoke` passes: 23 pass, 0 fail. House vs apartment opts differentiated by `searchOptsFor`. |
| 5 | normAddr v2 matches the spike-recovered formats (space-before-unit-letter, dual "X / Y", " och ", Booli-truncated number); the main fetch path enforces a MAX_OXY_CALLS ceiling and retries transient Oxylabs 613 errors | VERIFIED | All four MATCH-02 formats confirmed live: `norrskensvägen 1 c` → `norrskensvägen 1c`, `Rindögatan 28, 3 tr` → `rindögatan 28`, `X 10 / Y 6` → `x 10`, `58 och 58A` → `58`. `lib/sold-transport.js` enforces `MAX_OXY_CALLS=4000` via `_spend.json` tally. `lib/scrape-http.js fallbackViaOxylabs` sleeps 3000ms before retry on `OXYLABS_API_NON_200`/`OXYLABS_TARGET_NON_200` (CONFIG-03); public API unchanged; single `function sleep` confirmed. |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/sold-config.js` | SEGMENTS, isTitleTransfer, MARKET_SOLD_TYPES, daysAgoISO, agreement thresholds | VERIFIED | Exists; exports all named constants; `--smoke` 18 pass, 0 fail |
| `lib/sold-parse.js` | parseBooliSoldCards, parseBooliSoldDetail, parseHemnetSaleCards, parseSweNum, booliSoldMeta, hemnetSalesMeta | VERIFIED | Exists; all six exports confirmed; snake_case contract preserved; `--smoke` 18 pass, 0 fail |
| `lib/sold-addr.js` | normAddr v2 (MATCH-02) | VERIFIED | Exists; exports `normAddr`; requires normStreet from spotcheck-evidence (not inlined); `--smoke` 10 pass, 0 fail |
| `lib/sold-transport.js` | cachedFetch, extractApollo, assertOxyUsed, CeilingError, MAX_OXY_CALLS ceiling, JSONL helpers | VERIFIED | Exists; load-time guard throws without SCRAPE_FORCE_OXYLABS; all exports confirmed; requires ./scrape-http (no HTTP duplication); `_spend.json` ceiling implemented |
| `lib/scrape-http.js` | 613/transient sleep-before-retry in fallbackViaOxylabs (CONFIG-03) | VERIFIED | `await sleep(3000)` inserted in `catch(e1)` block on `OXYLABS_API_NON_200`/`OXYLABS_TARGET_NON_200`; log line `oxylabs-fallback-backoff` confirmed; public API and single `function sleep` unchanged |
| `lib/sold-fetch-booli.js` | fetchBooliSold (paginated, idempotent JSONL resume, early-stop) + fetchBooliSoldPage (single-page) | VERIFIED | Exists; both functions exported; paginates /slutpriser with sold-date early-stop; detailScope option explicit; `--smoke` (with SCRAPE_FORCE_OXYLABS=1) 17 pass, 0 fail |
| `lib/sold-fetch-hemnet.js` | buildHemnetSoldUrl, searchSoldPaged (per-property paginated search w/ early-stop), within-run search cache | VERIFIED | Exists; all three exported; normAddr imported not redefined; no parseBooliSoldDetail; `--smoke` (with SCRAPE_FORCE_OXYLABS=1) 23 pass, 0 fail |
| `scripts/sold-recon.js` | Extended Stage-0 recon CLI with D-04 sold-in-advance keywords | VERIFIED | Exists; sets SCRAPE_FORCE_OXYLABS=1 before requires; D-04 keyword set confirmed including 'förhand', 'advance', 'innan visning' at lines 168-171; syntax valid |
| `scripts/booli-sold.js` | Thin CLI wrapper over lib/sold-fetch-booli with D-01 spend guard | VERIFIED | Exists; SCRAPE_FORCE_OXYLABS=1 set at line 3 before first lib require at line 9; D-01 guard reads RECON doc and exits 3 without approval marker; assertOxyUsed at end; require.main guard present; syntax valid |
| `scripts/hemnet-sold.js` | Thin CLI wrapper over lib/sold-fetch-hemnet | VERIFIED | Exists; SCRAPE_FORCE_OXYLABS=1 set at line 3 before first lib require at line 8; assertOxyUsed at end; require.main guard present; no URL-build/search logic in wrapper; syntax valid |
| `.planning/phases/15-sold-data-ingestion-library/15-SOLD-IN-ADVANCE-RECON.md` | Documented recon finding + D-01 detail-fetch policy disposition | VERIFIED | Exists; signal location confirmed as "DETAIL FIELD — SoldProperty.soldAsUpcomingSale"; D-01 disposition states all records except deed transfers; operator approval marker "escalate detail (spend confirmed)" present at line 78 |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib/sold-parse.js` | `lib/sold-config.js` | `require('./sold-config')` for isTitleTransfer | WIRED | Confirmed at line 10; `isTitleTransfer` called at line 73 |
| `lib/sold-addr.js` | `lib/spotcheck-evidence.js` | `require('./spotcheck-evidence')` for normStreet | WIRED | Confirmed at line 13; `normStreet` called at line 31 |
| `lib/sold-transport.js` | `lib/scrape-http.js` | `require('./scrape-http')` for getWithRetry/extractNextData/getOxylabsStats | WIRED | Confirmed at line 32; no HTTP implementation duplicated |
| `lib/sold-transport.js` → `cachedFetch` | `_spend.json` | loadSpend/saveSpend file-based ceiling tally | WIRED | `SPEND_FILE = path.join(CACHE_DIR, '_spend.json')` at line 40; read/write in cachedFetch lines 90-100 |
| `lib/sold-fetch-booli.js` | `lib/sold-transport.js` | `require('./sold-transport')` | WIRED | Confirmed at line 29 |
| `lib/sold-fetch-booli.js` | `lib/sold-parse.js` | `require('./sold-parse')` | WIRED | Confirmed at line 40 |
| `lib/sold-fetch-hemnet.js` | `lib/sold-transport.js` | `require('./sold-transport')` | WIRED | Confirmed at line 22 |
| `lib/sold-fetch-hemnet.js` | `lib/sold-parse.js` | `require('./sold-parse')` | WIRED | Confirmed at line 27 |
| `lib/sold-fetch-hemnet.js` | `lib/sold-addr.js` | `require('./sold-addr')` for normAddr v2 | WIRED | Confirmed at line 28; used in searchSoldPaged lines 143, 177 |
| `scripts/booli-sold.js` | `lib/sold-fetch-booli.js` | `require('../lib/sold-fetch-booli')` | WIRED | Confirmed at line 9; `fetchBooliSold` called at line 111 |
| `scripts/hemnet-sold.js` | `lib/sold-fetch-hemnet.js` | `require('../lib/sold-fetch-hemnet')` | WIRED | Confirmed at line 8; `searchSoldPaged` called at line 68 |
| `scripts/sold-recon.js` | `lib/sold-transport.js` | `require('../lib/sold-transport')` | WIRED | Confirmed at lines 24-27; all helpers used |

---

### Data-Flow Trace (Level 4)

Not applicable — all artifacts are fetch/parse utilities or CLI wrappers operating over network responses, not components rendering stored data. Data flows from network → parser → JSONL output; no DB reads involved at this phase level.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `sold-config.js` smoke (18 tests) | `node lib/sold-config.js --smoke` | `smoke: 18 pass, 0 fail` | PASS |
| `sold-parse.js` smoke (18 tests) | `node lib/sold-parse.js --smoke` | `smoke: 18 pass, 0 fail` | PASS |
| `sold-addr.js` smoke (10 tests, MATCH-02 formats) | `node lib/sold-addr.js --smoke` | `smoke: 10 pass, 0 fail` | PASS |
| `sold-transport.js` load-time guard | `node -e "try{require('./lib/sold-transport')}catch(e){...}"` | Guard fires correctly without flag | PASS |
| `sold-fetch-booli.js` smoke (17 tests) | `SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-booli.js --smoke` | `smoke: 17 pass, 0 fail` | PASS |
| `sold-fetch-hemnet.js` smoke (23 tests) | `SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-hemnet.js --smoke` | `smoke: 23 pass, 0 fail` | PASS |
| normAddr MATCH-02 four formats (live) | inline node -e assertion | All four: PASS | PASS |
| `scrape-http.js` public API intact | `node -e "const h=require('./lib/scrape-http'); ..."` | All four exports confirmed | PASS |
| `booli-sold.js` syntax | `node -c scripts/booli-sold.js` | OK | PASS |
| `hemnet-sold.js` syntax | `node -c scripts/hemnet-sold.js` | OK | PASS |
| `sold-recon.js` syntax | `node -c scripts/sold-recon.js` | OK | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SOLD-01 | 15-04 | Booli /slutpriser fetch with pagination and sold-date early-stop | SATISFIED | `fetchBooliSold` paginates with `maxSoldDate`/`minSoldDate` params; early-stops on empty page, ceiling, status non-200. `fetchBooliSoldPage` primitive for Phase 16. |
| SOLD-02 | 15-01, 15-04 | soldPriceType classification; Lagfart excluded from match but retained | SATISFIED | `isTitleTransfer` in sold-config; `is_title_transfer` field on every card from `parseBooliSoldCards`; title-transfer records written to JSONL output; `marketCollected` counts only non-transfers. |
| SOLD-03 | 15-01, 15-04 | Enriched attributes: broker/agency, operating cost, construction year, tenure form, rooms, living area, floor, coords, soldPriceType, fee/rent | SATISFIED | `parseBooliSoldDetail` returns all named fields; card-level attrs (living_area, rooms, floor, lat, long) from `parseBooliSoldCards`; detail enrichment merged in `fetchBooliSold` loop. |
| SOLD-04 | 15-03, 15-04 | "Sold in advance" flag with recon-confirmed field path | SATISFIED | Recon doc confirms `SoldProperty.soldAsUpcomingSale`; `parseBooliSoldDetail` extracts it; `fetchBooliSold` sets `record.sold_in_advance` from detail; deed transfers retain `sold_in_advance: null` (D-03 best-effort). |
| SOLD-05 | 15-05 | Hemnet /salda SaleCard search per-property, paginated, early-stop, no detail fetch | SATISFIED | `searchSoldPaged` paginates with four early-stop conditions; no `parseBooliSoldDetail` or `/bostad/` in sold-fetch-hemnet.js; all fields from search-result Apollo only. |
| MATCH-02 | 15-01 | normAddr v2 handles four spike-recovered false-negative formats | SATISFIED | All four formats confirmed by live execution: space-before-unit-letter, comma-split, slash-split, " och " split. `normStreet` imported not inlined. |
| CONFIG-03 | 15-02 | MAX_OXY_CALLS spend ceiling + transient 613 retry on main fetch path | SATISFIED | `sold-transport.js` enforces ceiling via `_spend.json` tally (counted before fetch); `fallbackViaOxylabs` in scrape-http.js sleeps 3s on `OXYLABS_API_NON_200`/`OXYLABS_TARGET_NON_200` before retry on main path (not just probes). Public API unchanged. |

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `lib/sold-transport.js:90-100` | Non-atomic read-modify-write on `_spend.json` (CR-01 from code review) | INFO (LATENT) | Race window exists between concurrent fetches; however Phase 15 fetchers are strictly sequential awaits so the ceiling holds in current usage. Code review (15-REVIEW.md CR-01) already tracks this for Phase 16 hardening. Does NOT block Phase 15 goal. |
| `lib/sold-fetch-hemnet.js:189` | `Math.min` window check uses page minimum, not last card (WR-02 from code review) | INFO (LATENT) | Could stop one page early or never on all-null sold_at pages. Known, tracked in code review. Current early-stop conditions 1-3 (empty/address-found/short-page) cover the common cases. Does NOT block Phase 15 goal. |
| `scripts/booli-sold.js:85` | `parseArgs` called twice to extract `maxSoldDate` (WR-04 from code review) | INFO (LATENT) | Wasteful but functionally correct for current deterministic parseArgs. Tracked in code review. |

No blockers found. All anti-patterns were identified in 15-REVIEW.md and are latent issues deferred to Phase 16 (CR-01 specifically noted as Phase 16 work by the review).

---

### Human Verification Required

None. All observable truths are verifiable programmatically via smoke tests and code inspection. No visual rendering, real-time behavior, or external-service-dependent paths require human validation for this phase's goals.

---

### Gaps Summary

None. All five success criteria are fully implemented in the codebase with passing smoke tests. All seven requirement IDs (SOLD-01..05, MATCH-02, CONFIG-03) have confirmed implementations. The phase goal — lifting the spike's DB-free fetch/parse scripts into reusable lib/ modules with the full stated feature set — is achieved.

**CR-01 note:** The spend-ceiling race condition identified in 15-REVIEW.md is LATENT for Phase 15 (sequential awaits mean the ceiling holds in current usage) and is explicitly tracked for Phase 16. Per the phase instructions, this is not a failure criterion.

---

_Verified: 2026-06-17_
_Verifier: Claude (gsd-verifier)_
