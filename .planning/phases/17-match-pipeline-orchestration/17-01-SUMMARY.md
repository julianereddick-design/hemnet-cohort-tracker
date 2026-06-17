---
phase: 17-match-pipeline-orchestration
plan: 01
subsystem: sold-match-pipeline
tags: [config-as-data, exports, prerequisites, wave-1]
requires:
  - lib/sold-config.js (SEGMENTS shape — source of the migrated data)
  - lib/sold-fetch-booli.js (fetchBooliDetail + extractResidenceId already implemented)
provides:
  - config/sold-segments.json (CONFIG-01 segments-as-data: stockholm-apt + taby-villa)
  - lib/sold-fetch-booli.js exports fetchBooliDetail + extractResidenceId (for Plan 02 runner)
affects:
  - scripts/sold-match-run.js (Plan 02 — will loadSegments() from the JSON + destructure the two new exports)
tech-stack:
  added: []
  patterns:
    - segments-as-data (JSON config file read by the runner, replacing the const for new callers)
    - export-only module boundary (expose existing private fns, zero logic change)
key-files:
  created:
    - config/sold-segments.json
  modified:
    - lib/sold-fetch-booli.js
decisions:
  - "config/sold-segments.json is a COPY of the SEGMENTS const, not a move — SEGMENTS stays for Phase 15/16 backward compat (Pitfall 7)"
  - "fetchBooliDetail + extractResidenceId exported with zero logic change; function bodies untouched"
metrics:
  duration: ~12 min
  completed: 2026-06-17
  tasks: 2
  files: 2
---

# Phase 17 Plan 01: Wave 1 Prerequisites Summary

**One-liner:** Migrated segment definitions into `config/sold-segments.json` (CONFIG-01 segments-as-data) and exported the already-implemented `fetchBooliDetail` + `extractResidenceId` from `lib/sold-fetch-booli.js`, unblocking the Plan-02 runner with no DB, network, or logic changes.

## What Was Built

Two small, file-isolated prerequisites the Phase-17 runner (Plan 02) depends on:

1. **CONFIG-01 — segments as data.** Created `config/sold-segments.json` (new `config/` directory) containing the two seed segments — `stockholm-apt` (APARTMENT, Booli areaIds 1 / `Lägenhet`, Hemnet locationId 18031 / `bostadsratt`) and `taby-villa` (HOUSE, Booli areaIds 20 / `Hus`, Hemnet locationId 17793 / `null`) — copied verbatim in the D-01 shape from the `SEGMENTS` const in `lib/sold-config.js`, UTF-8 preserved. Adding a third segment is now a single-file data edit. The `SEGMENTS` const was intentionally left untouched (copy, not move) for backward compatibility with existing Phase 15/16 smokes and scripts that import it.

2. **fetchBooliDetail export (OQ-2/OQ-3).** Added `fetchBooliDetail` and `extractResidenceId` to `lib/sold-fetch-booli.js` `module.exports`. Export-only — the function bodies (lines 108–143) were not modified. This lets the Plan-02 runner fetch a single apartment's fee detail inline (the D-06 fix) and extract a Booli `residenceId` from a card without reproducing the `cachedFetch`+`extractApollo`+`parseBooliSoldDetail` block or duplicating the `/bostad/(\d+)` regex. Added two matching `--smoke` export assertions (smoke now 19 checks).

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Create config/sold-segments.json (CONFIG-01) | b7ed2e7 | config/sold-segments.json (new) |
| 2 | Export fetchBooliDetail + extractResidenceId (OQ-2/OQ-3) | 9311701 | lib/sold-fetch-booli.js |

## Verification

All plan verify commands pass:

- `node -e "require('./config/sold-segments.json')..."` → **config OK** (family/objectType/locationId/areaIds/itemType assertions all pass; `Lägenhet` UTF-8 preserved; `taby-villa.hemnet.itemType` is JSON `null`)
- `node -e "require('assert').ok(require('./lib/sold-config').SEGMENTS['taby-villa'])"` → **SEGMENTS intact** (backward compat preserved)
- `node -c lib/sold-fetch-booli.js` → exit 0 (**syntax OK**)
- `SCRAPE_FORCE_OXYLABS=1 node -e "...typeof m.fetchBooliDetail/extractResidenceId/fetchBooliSoldPage/fetchBooliSold..."` → **exports OK** (all four functions present)
- `SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-booli.js --smoke` → **smoke: 19 pass, 0 fail** (was 17; +2 new export checks), exit 0

## Deviations from Plan

None — plan executed exactly as written. The optional `--smoke` export assertions (recommended in Task 2) were added.

## Decisions Made

- **Copy, not move:** `config/sold-segments.json` mirrors the `SEGMENTS` const; the const remains in `lib/sold-config.js` for Phase 15/16 backward compatibility (Pitfall 7). The Plan-02 runner reads the JSON via its own `loadSegments()`; it will not import `SEGMENTS`.
- **Export-only boundary:** `fetchBooliDetail` (returns parsed detail / `null`, re-throws only `CeilingError`) and `extractResidenceId` (returns the residenceId string / `null`) were exposed without touching their bodies — a clean module boundary per OQ-2/OQ-3.

## Threat Surface

No new surface. Both changes are a committed data-file creation (T-17-01, accept) and an export-list edit (T-17-02, accept) — no network listener, no auth path, no SQL, no credential handling. Credentials and the spend ceiling are exercised only by the runner (Plan 02). No threat flags.

## Known Stubs

None. Both artifacts are fully wired: the JSON is consumed by the Plan-02 runner's `loadSegments()`, and the two exports are destructured by the runner per the pattern map.

## For the Next Plan (17-02)

- `const segments = loadSegments()` reads `config/sold-segments.json` (see 17-PATTERNS.md `loadSegments()` snippet).
- `const { fetchBooliSoldPage, fetchBooliDetail, extractResidenceId } = require('../lib/sold-fetch-booli')` — all now exported.
- Carried operator action (from Phase 16, still one run): on the droplet run `node migrate-sold-phase16.js` to create the four sold tables before the runner's live DB persistence + `setSpendClient` ceiling can be exercised.

## Self-Check: PASSED

- FOUND: config/sold-segments.json
- FOUND: lib/sold-fetch-booli.js (module.exports includes fetchBooliDetail + extractResidenceId)
- FOUND commit: b7ed2e7 (Task 1)
- FOUND commit: 9311701 (Task 2)
