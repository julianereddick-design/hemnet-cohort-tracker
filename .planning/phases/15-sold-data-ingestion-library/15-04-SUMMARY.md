---
phase: 15-sold-data-ingestion-library
plan: "04"
subsystem: lib/sold-fetch-booli, scripts/booli-sold
tags: [booli-sold, paginated-fetch, detail-enrichment, sold-in-advance, spend-guard, SOLD-01, SOLD-02, SOLD-03, SOLD-04, D-01, T-15-11, T-15-12, T-15-13]
dependency_graph:
  requires: [lib/sold-transport.js, lib/sold-parse.js, lib/sold-config.js]
  provides: [lib/sold-fetch-booli.js, scripts/booli-sold.js]
  affects: [Phase 16 DB persistence (fetchBooliSoldPage), Phase 17 orchestrator (fetchBooliSold)]
tech_stack:
  added: []
  patterns:
    - Paginated /slutpriser fetch with idempotent JSONL resume (seen-Set dedup)
    - detailScope option ('fee-window'|'all'|'none') — explicit escalation, never silent
    - Operator-approval marker guard in CLI wrapper (exit 3 without marker)
    - CeilingError break at page loop AND mid-card-loop level (resumable)
    - fetchBooliSoldPage single-page primitive for Phase 16 DB path (no JSONL write)
key_files:
  created:
    - lib/sold-fetch-booli.js
    - scripts/booli-sold.js
  modified:
    - lib/sold-parse.js
decisions:
  - "detailScope defaults to 'fee-window' (apartments within FEE_WINDOW_DAYS): safest non-escalated default; 'all' requires operator marker; 'none' skips detail entirely"
  - "parseBooliSoldDetail extended to return sold_in_advance (Boolean or null) from SoldProperty.soldAsUpcomingSale — field was absent from the 15-01 lift (Rule 2 fix)"
  - "CeilingError caught at both the page-loop level and mid-card-loop level: record written before break so partial-page work is not lost on ceiling stop"
  - "fetchBooliSoldPage returns { cards, meta } with no JSONL write — Phase 16 passes this primitive its own pg client and handles persistence; fetchBooliSold owns the JSONL path"
  - "SCRAPE_FORCE_OXYLABS='1' is line 3 of booli-sold.js (before comment, after shebang-less first line); all lib requires follow"
  - "D-01 spend guard reads the RECON doc at runtime via fs.readFileSync — the check runs on every invocation of --detail-scope all, not just at module load"
  - "seeds/ dir (not seed/) chosen to match plan spec path ${ROOT}/seeds/${segKey}.jsonl; spike-booli-sold.js used seed/ — lib version is the canonical path"
metrics:
  duration_seconds: 540
  completed_date: "2026-06-17"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 1
---

# Phase 15 Plan 04: Sold-data ingestion library — Booli fetch + detail enrichment

**One-liner:** `lib/sold-fetch-booli.js` productionises the spike's paginated /slutpriser fetch with idempotent JSONL resume, recon-gated detail enrichment (operator-approval-guarded `all` scope, deed-transfer skip), and `sold_in_advance` from `SoldProperty.soldAsUpcomingSale`; `scripts/booli-sold.js` is a thin CLI wrapper with D-01 spend guard (exit 3 without marker).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Build lib/sold-fetch-booli.js (paginated fetch + detail gate) | 7743f36 | lib/sold-fetch-booli.js (created), lib/sold-parse.js (modified) |
| 2 | Build scripts/booli-sold.js thin CLI wrapper | 2a614c8 | scripts/booli-sold.js (created) |

## Verification Results

```
SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-booli.js --smoke → smoke: 17 pass, 0 fail
node -c scripts/booli-sold.js → OK

AC1: node -e "require('./lib/sold-fetch-booli')" exports check → PASS
AC2: grep require('./sold-transport|parse|config') → PASS (all 3 present)
AC3: grep slutpriser + maxSoldDate → PASS (SOLD-01)
AC4: grep is_title_transfer → PASS (SOLD-02 retained-but-flagged)
AC5: grep sold_in_advance → PASS (SOLD-04)
AC6: grep detailScope → PASS (D-01 explicit escalation)
AC-CLI1: node -c scripts/booli-sold.js → PASS
AC-CLI2: SCRAPE_FORCE_OXYLABS on line 3, before first require('../lib/') on line 9 → PASS
AC-CLI3: grep require('../lib/sold-fetch-booli') → PASS
AC-CLI4: grep assertOxyUsed + require.main → PASS
AC-CLI5: grep -cE "cachedFetch|parseBooliSoldCards|booli.se/slutpriser" → 0 (PASS)
AC-CLI6: grep "escalate detail (spend confirmed)" + "SOLD-IN-ADVANCE-RECON" → PASS (D-01 guard)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] parseBooliSoldDetail missing sold_in_advance field**
- **Found during:** Task 1 implementation
- **Issue:** `parseBooliSoldDetail` in `lib/sold-parse.js` (Plan 01 output) did not extract `SoldProperty.soldAsUpcomingSale`. Without this, the detail fetch in sold-fetch-booli.js could not set `sold_in_advance` — the core SOLD-04 requirement.
- **Fix:** Added `sold_in_advance: sp.soldAsUpcomingSale != null ? Boolean(sp.soldAsUpcomingSale) : null` to the return object in `parseBooliSoldDetail`. Boolean cast preserves false as "not sold in advance"; null preserved for records where the field is absent (older sold entries).
- **Files modified:** `lib/sold-parse.js`
- **Commit:** 7743f36 (bundled with Task 1)
- **Smoke test:** `node lib/sold-parse.js --smoke` still 18 pass, 0 fail after change.

## Known Stubs

None. Both modules are infrastructure/fetch: no data-rendering paths, no placeholder text. `sold_in_advance` is correctly set to `null` for deed transfers and for detail-page records where `soldAsUpcomingSale` is absent — this is correct per-spec, not a stub.

## Threat Surface Scan

T-15-11 (cost DoS): mitigated. Every page fetch goes through `cachedFetch` (MAX_OXY_CALLS ceiling, _spend.json). CeilingError breaks the page loop cleanly. `detailScope` defaults to `fee-window` (apartments only); `all` is gated by the operator-approval marker read at CLI runtime. No silent spend escalation is possible.

T-15-12 (malformed Apollo): mitigated. All card/detail parsing goes through `parseBooliSoldCards`/`parseBooliSoldDetail` (Plan 01 guarded parsers). Empty pages stop the loop. `fetchBooliDetail` returns null on any parse error; the caller writes the card-level record without detail enrichment (non-blocking).

T-15-13 (direct-curl bypass): mitigated. `scripts/booli-sold.js` sets `SCRAPE_FORCE_OXYLABS='1'` as line 3 before any lib require. `assertOxyUsed()` runs at the end of `main()` and sets `process.exitCode = 2` if the transport guard fires.

T-15-14 (secret leakage): accepted. Seed JSONL contains only public sold-listing fields. Logs print url/status/counts only.

No new trust boundaries beyond those already in the T-15-11..14 register.

## Self-Check: PASSED

- lib/sold-fetch-booli.js: FOUND
- scripts/booli-sold.js: FOUND
- lib/sold-parse.js (modified): confirmed sold_in_advance added to parseBooliSoldDetail
- Commit 7743f36: confirmed in git log (feat(15-04): build lib/sold-fetch-booli.js)
- Commit 2a614c8: confirmed in git log (feat(15-04): add scripts/booli-sold.js thin CLI wrapper)
- smoke: 17 pass, 0 fail (sold-fetch-booli)
- smoke: 18 pass, 0 fail (sold-parse, including existing tests)
- All 12 acceptance criteria returned PASS
