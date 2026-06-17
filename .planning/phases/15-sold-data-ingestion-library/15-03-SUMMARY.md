---
phase: 15-sold-data-ingestion-library
plan: 03
subsystem: scraping
tags: [booli, sold-in-advance, recon, oxylabs, detail-fetch, apollo]

# Dependency graph
requires:
  - phase: 15-sold-data-ingestion-library/01
    provides: lib/sold-parse.js, lib/sold-addr.js, lib/sold-config.js
  - phase: 15-sold-data-ingestion-library/02
    provides: lib/sold-transport.js (cachedFetch, extractApollo, assertOxyUsed, MAX_OXY_CALLS)
provides:
  - scripts/sold-recon.js — extended recon harness over lib/sold-transport with D-04 sold-in-advance keywords
  - 15-SOLD-IN-ADVANCE-RECON.md — confirmed signal location (detail field only) + operator-approved D-01 policy
  - Verbatim approval marker "escalate detail (spend confirmed)" in RECON doc — unlocks Plan 04 --detail-scope all guard
affects:
  - 15-04 (booli-sold.js fetch implementation — must gate detail fetch on !isTitleTransfer per approved policy)
  - 15-05 (hemnet-sold.js)
  - Phase 16 (DB schema — sold_in_advance boolean column, is_title_transfer boolean column)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Offline-first recon: scan existing verf-soldspike/*.apollo.json dumps before issuing live Oxylabs calls (0 spend for this plan)"
    - "Operator checkpoint gating cost escalation: approval-marker written to RECON doc ONLY after explicit spend sign-off"
    - "isTitleTransfer gate: per-record detail fetch conditioned on soldPriceType !== 'Lagfart' — deed transfers card-only"

key-files:
  created:
    - scripts/sold-recon.js
    - .planning/phases/15-sold-data-ingestion-library/15-SOLD-IN-ADVANCE-RECON.md
  modified:
    - .planning/phases/15-sold-data-ingestion-library/15-SOLD-IN-ADVANCE-RECON.md (operator decision appended post-checkpoint)

key-decisions:
  - "15-03: sold_in_advance (SoldProperty.soldAsUpcomingSale) is detail-page-only — NOT present on /slutpriser card nodes; confirmed via offline Apollo dump scan (0 Oxylabs spend)"
  - "15-03: D-01 resolved — detail-scope = all records EXCEPT deed transfers (soldPriceType=Lagfart / isTitleTransfer=true); gate per-record detail fetch on !isTitleTransfer; deed transfers retained card-only with sold_in_advance=null"
  - "15-03: Approval marker 'escalate detail (spend confirmed)' written to RECON doc after explicit operator sign-off at checkpoint; Plan 04 booli-sold.js must assert marker before enabling --detail-scope all"

patterns-established:
  - "Recon-before-implementation for any detail-page signal: scan offline dumps first, live fetch at most once, document exact Apollo path + sample value before Plan N+1 implements it"
  - "Cost-gate via marker file: operator spend decisions create a named literal string in a tracked file; implementation guards hard-check for it at runtime"

requirements-completed: [SOLD-04]

# Metrics
duration: 45min (Tasks 1-2 prior session) + checkpoint wait + 10min continuation
completed: 2026-06-17
---

# Phase 15 Plan 03: Sold-In-Advance Recon Summary

**D-04 recon confirmed soldAsUpcomingSale is detail-page-only; operator approved escalate-excluding-deed-transfers policy; Plan 04 handoff instruction written with exact isTitleTransfer gate**

## Performance

- **Duration:** ~55 min total (Tasks 1-2 + checkpoint + continuation)
- **Started:** 2026-06-17
- **Completed:** 2026-06-17
- **Tasks:** 2 auto + 1 checkpoint (human-verify) — all complete
- **Files modified:** 2 (scripts/sold-recon.js created; 15-SOLD-IN-ADVANCE-RECON.md created + amended)

## Accomplishments

- Confirmed `soldAsUpcomingSale` is exclusively on Booli `/bostad/<residenceId>` detail pages — NOT present on `/slutpriser` card-level `SoldProperty` nodes (scanned 35 card records from offline Apollo dumps, 0 Oxylabs spend)
- Operator approved the all-records detail escalation with a scope optimisation: skip deed transfers (`soldPriceType = "Lagfart"` / `isTitleTransfer === true`) which are excluded from matching anyway — reducing the ~2× cost increase by the deed-transfer share
- Wrote the verbatim approval marker `escalate detail (spend confirmed)` into 15-SOLD-IN-ADVANCE-RECON.md; Plan 04's `--detail-scope all` guard is now unblocked
- Delivered an unambiguous Plan 04 handoff instruction: exact JS gate logic (`!isTitleTransfer` → fetch detail → read `sp.soldAsUpcomingSale`; deed transfers → card-only, `sold_in_advance = null`)

## Task Commits

1. **Task 1: Lift + extend sold-recon.js with D-04 keywords** - `56a73c8` (feat)
2. **Task 2: Run recon offline, document finding + D-01 disposition** - `2778b9d` (feat)
3. **Post-checkpoint: Record operator D-01 decision in RECON doc** - `2ba623f` (docs)

## Files Created/Modified

- `scripts/sold-recon.js` — Extended recon harness over lib/sold-transport; scans card- and detail-level Apollo state; keywordScan includes D-04 sold-in-advance term set (förhand, advance, upcoming, presale, etc.)
- `.planning/phases/15-sold-data-ingestion-library/15-SOLD-IN-ADVANCE-RECON.md` — Recon finding (detail field only), D-01 disposition with operator-approved escalate-excluding-deed-transfers policy, verbatim approval marker, unambiguous Plan 04 handoff instruction

## Decisions Made

- **sold_in_advance is detail-page-only:** The `Listing:<id>.upcomingSale` field seen in card-level Apollo is on FOR-SALE `Listing` cross-links, not on `SoldProperty` card nodes. Only the `/bostad/<id>` detail page carries `SoldProperty.soldAsUpcomingSale`.
- **Escalate-excluding-deed-transfers policy:** All genuine (non-deed-transfer) sold records get a detail fetch. Deed transfers (soldPriceType = "Lagfart") are excluded from the match pipeline and retained card-only — a detail call on them is wasted spend. Gate: `!isTitleTransfer` before issuing detail fetch.
- **Approval marker mechanism preserved:** The literal string `escalate detail (spend confirmed)` in the RECON doc is the runtime gate for Plan 04's `--detail-scope all`. This prevents silent escalation in any delegated future run.

## Deviations from Plan

None — plan executed exactly as written. The post-checkpoint continuation (appending the approval marker and updating D-01/Plan 04 handoff) is the intended continuation path specified in the checkpoint design.

## Issues Encountered

None. Recon completed at 0 Oxylabs spend — the detail-page dump (`booli-sold-detail-sample.json`) already existed in `verf-soldspike/recon/` from the prior spike, confirming `soldAsUpcomingSale: true` without any live fetch.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 04 (`booli-sold.js`) is fully unblocked: approval marker present, D-01 policy explicit, exact field path and gate logic documented in 15-SOLD-IN-ADVANCE-RECON.md
- Plan 04 must implement: `if (!isTitleTransfer) { fetch /bostad/<residenceId>; read sp.soldAsUpcomingSale }` — deed transfers skip detail fetch and store `sold_in_advance = null`
- Phase 16 DB schema should include: `sold_in_advance BOOLEAN`, `is_title_transfer BOOLEAN` columns on the booli_sold table

---
*Phase: 15-sold-data-ingestion-library*
*Completed: 2026-06-17*
