---
phase: 15-sold-data-ingestion-library
plan: "02"
subsystem: lib/sold-transport, lib/scrape-http
tags: [transport, cost-control, ceiling, retry, CONFIG-03, SOLD-04, T-15-04, T-15-05, T-15-06, T-15-07]
dependency_graph:
  requires: [lib/scrape-http.js]
  provides: [lib/sold-transport.js]
  affects: [Phase 15 plans 03/04/05 (sold-fetch-booli, sold-fetch-hemnet, sold-match)]
tech_stack:
  added: []
  patterns:
    - Verbatim lift from scripts/spike-common.js into lib/ with require-path adjustment
    - File-based spend ceiling (_spend.json) incremented BEFORE fetch (credits consumed pre-issue)
    - Load-time env-guard (SCRAPE_FORCE_OXYLABS) as module-level invariant
    - Conditional sleep-before-retry on 613-class transient Oxylabs errors (CONFIG-03)
key_files:
  created:
    - lib/sold-transport.js
  modified:
    - lib/scrape-http.js
decisions:
  - "sold-transport require path is ./scrape-http (same lib/ dir) not ../lib/scrape-http — no HTTP duplication"
  - "load-time SCRAPE_FORCE_OXYLABS guard kept verbatim from spike — sold pages are 100% Oxylabs, invariant enforced at require time"
  - "sleep added BEFORE the second fetchViaOxylabs attempt in fallbackViaOxylabs catch block — uses existing sleep() helper (no new function), retry count stays at 1"
  - "613 sleep triggers on OXYLABS_API_NON_200 and OXYLABS_TARGET_NON_200 — both transient classes per fetchViaOxylabs error codes"
  - "log line 'oxylabs-fallback-backoff' emitted at INFO before sleep — visible in production logs without credential leakage (T-15-04)"
metrics:
  duration_seconds: 167
  completed_date: "2026-06-17"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
---

# Phase 15 Plan 02: Sold-data ingestion library — transport spine + 613-retry

**One-liner:** `lib/sold-transport.js` lifted from the spike with file-based MAX_OXY_CALLS ceiling, load-time Oxylabs-force guard, and assertOxyUsed; `lib/scrape-http.js` extended with 3s backoff before its single retry on OXYLABS_API_NON_200/OXYLABS_TARGET_NON_200 (CONFIG-03, main fetch path).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Lift spike-common.js into lib/sold-transport.js | df560e7 | lib/sold-transport.js (created) |
| 2 | Add 613-class sleep-before-retry to fallbackViaOxylabs (CONFIG-03) | 7c5df94 | lib/scrape-http.js (modified) |

## Verification Results

```
node -e "try{require('./lib/sold-transport')}catch(e){...}" → guard fires without flag: PASS
SCRAPE_FORCE_OXYLABS=1 node -e "const t=require(...)..." → loads with flag, exports correct: PASS
grep -q "require('./scrape-http')" lib/sold-transport.js → AC3: PASS
grep -q "_spend.json" lib/sold-transport.js → AC4: PASS
grep -q "class CeilingError" lib/sold-transport.js → AC5: PASS
grep -c "fetchViaOxylabs|curlOnce" lib/sold-transport.js → 0 (no HTTP duplication): PASS
grep -q "OXYLABS_API_NON_200" lib/scrape-http.js → AC1a: PASS
grep -A40 fallbackViaOxylabs | grep -q "await sleep" → AC1b: PASS
grep -c "module.exports = {" lib/scrape-http.js → 1: PASS
grep -A6 "module.exports = {" | grep -q getWithRetry → PASS
node -e "const h=require('./lib/scrape-http'); ..." → module loads, 4 exports intact: PASS
grep -c "function sleep" lib/scrape-http.js → 1 (no duplicate): PASS
grep -c "require('./scrape-http')" lib/sold-transport.js → 1: PASS
Credential check: OXYLABS_USERNAME/PASSWORD only in env reads, never in log strings: PASS
```

## Deviations from Plan

None — plan executed exactly as written.

- Task 1: spike-common.js lifted verbatim with only the `require` path change (`../lib/scrape-http` → `./scrape-http`) and the error message prefix (`spike-common:` → `sold-transport:`). All exports preserved including ROOT, CACHE_DIR, MAX_OXY_CALLS, and the full JSONL/JSON helper set.
- Task 2: scrape-http.js extended with the 8-line conditional-sleep block in `fallbackViaOxylabs`. No API changes, no retry-count changes, no new helper functions.

## Known Stubs

None. Both modules are infrastructure (transport + retry); no data-rendering paths, no placeholder text.

## Threat Surface Scan

No new network endpoints. Changes are:

1. `lib/sold-transport.js` — new module but wraps `lib/scrape-http.js` exclusively; no independent HTTP code. Credential path: credentials consumed by `scrape-http.js` (existing). `_spend.json` is a local file write only. T-15-05 (cost-DoS guard) and T-15-07 (assertOxyUsed) are implemented.

2. `lib/scrape-http.js` — in the new log line `oxylabs-fallback-backoff url=${targetUrl} reason=${reason1} sleep=3000ms`, only the target URL and error code are logged — no credential values. T-15-04 confirmed: `OXYLABS_USERNAME`/`OXYLABS_PASSWORD` appear only in env reads and Authorization header construction, never interpolated into any log string.

T-15-06 (retry storm on 613) mitigated by the 3s sleep + retry-count-stays-1 invariant.

## Self-Check: PASSED

- lib/sold-transport.js exists
- lib/scrape-http.js modified with sleep-before-retry
- Commits df560e7 (sold-transport) and 7c5df94 (scrape-http 613-retry) confirmed in git log
- All acceptance criteria checks returned PASS
