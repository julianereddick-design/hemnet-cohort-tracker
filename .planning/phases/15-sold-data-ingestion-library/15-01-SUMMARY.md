---
phase: 15-sold-data-ingestion-library
plan: "01"
subsystem: lib/sold-*
tags: [parser, config, address-normalization, sold-match, MATCH-02, SOLD-02, SOLD-03]
dependency_graph:
  requires: [lib/spotcheck-evidence.js]
  provides: [lib/sold-config.js, lib/sold-parse.js, lib/sold-addr.js]
  affects: [Phase 15 plans 02-05, Phase 16 DB schema contract]
tech_stack:
  added: []
  patterns:
    - Verbatim lift from scripts/spike-*.js into lib/ with 'use strict' header
    - Inline --smoke self-test block (no network, no DB) using assert
    - normStreet imported from lib/spotcheck-evidence (not inlined) for normalization sync
key_files:
  created:
    - lib/sold-config.js
    - lib/sold-parse.js
    - lib/sold-addr.js
  modified: []
decisions:
  - "normStreet imported from lib/spotcheck-evidence, not inlined — keeps sold-addr
    normalization in sync with cohort spot-check normalization (PATTERNS.md:630-635)"
  - "snake_case field names in parsers preserved verbatim — they are the Phase 16
    DB column contract; renaming would break Phase 16/17"
  - "startsWith('searchSold(') and startsWith('displayAttributes(') key-scan idioms
    preserved — do not convert to exact-key lookups (Booli/Hemnet parametrize these)"
metrics:
  duration_seconds: 232
  completed_date: "2026-06-17"
  tasks_completed: 3
  tasks_total: 3
  files_created: 3
  files_modified: 0
---

# Phase 15 Plan 01: Sold-data ingestion library — config, parsers, and normAddr v2

**One-liner:** Three side-effect-free lib modules (sold-config, sold-parse, sold-addr) lifted from the spike with snake_case DB contract intact and normAddr v2 recovering all four MATCH-02 false-negative address formats.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Lift spike-config.js into lib/sold-config.js | d159b01 | lib/sold-config.js (created) |
| 2 | Lift spike-sold-parse.js into lib/sold-parse.js | f010dad | lib/sold-parse.js (created) |
| 3 | Extract normAddr v2 into lib/sold-addr.js (MATCH-02) | bd70ce3 | lib/sold-addr.js (created) |

## Verification Results

```
node lib/sold-config.js --smoke  → smoke: 18 pass, 0 fail
node lib/sold-parse.js --smoke   → smoke: 18 pass, 0 fail
node lib/sold-addr.js --smoke    → smoke: 10 pass, 0 fail
grep eval/Function/vm            → (empty — PASS)
```

## Deviations from Plan

None — plan executed exactly as written. All three modules lifted verbatim from their spike sources with only the specified dependency path change in sold-parse.js (`require('./spike-config')` → `require('./sold-config')`).

## Known Stubs

None. All three modules are pure utility functions with no network/DB side effects and no stub placeholders.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. All three modules are pure transforms over untrusted Apollo state objects. T-15-01 mitigations confirmed: no eval/Function/vm; missing-node guards return []/null; smoke tests assert null/empty-input paths do not throw.

## Self-Check: PASSED

- lib/sold-config.js exists and exports SEGMENTS, isTitleTransfer, daysAgoISO, MARKET_SOLD_TYPES, PRICE_AGREE_PCT, AREA_AGREE_PCT, PRICE_BAND, SOLD_DATE_WINDOW_DAYS, READ_TIME_EXCLUDE_DAYS, DEFAULT_TARGET_PER_SEGMENT
- lib/sold-parse.js exists and exports parseSweNum, parseBooliSoldCards, parseBooliSoldDetail, booliSoldMeta, parseHemnetSaleCards, hemnetSalesMeta
- lib/sold-addr.js exists and exports normAddr; imports normStreet from ./spotcheck-evidence
- Commits d159b01, f010dad, bd70ce3 confirmed in git log
- All three --smoke tests exit 0
