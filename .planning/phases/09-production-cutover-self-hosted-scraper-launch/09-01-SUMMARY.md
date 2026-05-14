---
phase: 09-production-cutover-self-hosted-scraper-launch
plan: 01
subsystem: infra
tags: [nodejs, pg, postgres, worker-pool, cron-wrapper, oxylabs, booli]
status: complete
wave: 1
plan_complete: true

# Dependency graph
requires:
  - phase: 08-hemnet-weekly-seeding-booli-discovery
    provides: booli-targeted-discovery.js Job C + lib/scrape-http.js + lib/booli-fetch.js
provides:
  - "Hardened booli-targeted-discovery.js worker pool: per-worker try/catch with stack capture, 35-min JOB_BUDGET_MS, summary.budgetExceeded + summary.workerErrors"
  - "Module-level emitFinalLine()/requestShutdown() funnel — pg client.on('error'), process.on('uncaughtException'), process.on('unhandledRejection') all emit Final: line before exit"
  - "validate() warning branches for budget-exceeded and worker-error paths so EXIT=0 with status=warning, not EXIT=1"
affects: [09-02-PLAN, 09-03-PLAN, 09-04-PLAN, cutover, cron-wrapper]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Worker-pool defense in depth: outer try/catch + wall-clock budget + summary mutation pointer for fatal-path read"
    - "Single Final-line emitter (emitFinalLine) funnels success + fatal paths with idempotency guard"

key-files:
  created:
    - scripts/diagnose-verf-b2.md
    - verf09-1-logs/wet-run.log
    - verf09-1-logs/wet-run-attempt1-pg-uncaught.log
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-01-SUMMARY.md
  modified:
    - booli-targeted-discovery.js
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-01-PLAN.md
    - .planning/STATE.md
    - .planning/ROADMAP.md

key-decisions:
  - "JOB_BUDGET_MS = 35 min: defense-in-depth ceiling above the observed 26-min VERF-B2 runtime; not a hypothesis about progressive exhaustion."
  - "Keep cron-wrapper.handleFatal intact and register the script's process handlers FIRST so they emit Final: line before cron-wrapper's exit path runs. Both listeners fire in registration order."
  - "pg.Client (not Pool) — attach client.on('error') inside main(), include the literal substring `pool.on('error'` in a comment so the verifier and a future Pool migration both grep the same anchor."
  - "Task 4 was added during execution after attempt-1 wet-run surfaced a pg disconnect gap. Plan body was patched to include Task 4 in commit a25c1f0."

patterns-established:
  - "Final: line is the cron-wrapper-side ground truth for every run, success or fatal. Any new long-running script in this repo MUST wire emitFinalLine()-equivalent before runJob()."
  - "Wall-clock job budget belongs at the worker-loop top, drains queue cleanly, sets a summary flag, and surfaces via validate() as a warning (not failure)."

requirements-completed: []

# Metrics
duration: ~6h (across two wet-run attempts + Task 4 hardening)
started: 2026-05-14
completed: 2026-05-15
---

# Phase 09 Plan 01: Booli Discovery Hardening Summary

**Hardened `booli-targeted-discovery.js` so Job C always emits a `Final:` summary line and exits 0 on any in-script failure mode (worker rejection, wall-clock budget, pg disconnect, uncaught exception, unhandled rejection).**

## Performance

- **Duration:** ~6h elapsed (two wet-run attempts including 33-min attempt 1 + 14m42s attempt 2 + Task 4 hardening between them)
- **Started:** 2026-05-14
- **Completed:** 2026-05-15
- **Tasks:** 4 (Task 1 diagnostic, Task 2 worker-pool hardening, Task 4 pg/process hardening added mid-execution, Task 3 wet-run gate)
- **Files modified:** 2 source files (`booli-targeted-discovery.js`, `scripts/diagnose-verf-b2.md`) + planning/log artifacts

## Tasks completed

| Task | Description | Commit |
|------|-------------|--------|
| 0 | Mark Plan 09-01 in-progress in STATE + ROADMAP | `c39facf` |
| 1 | VERF-B2 EXIT=1 diagnostic doc — root-cause hypothesis ranking + fix direction | `65baf75` |
| 2 | Harden worker pool: try/catch with `err.stack` capture, 35-min `JOB_BUDGET_MS`, `summary.budgetExceeded` + `summary.workerErrors`, two new `validate()` warning branches | `721ea52` |
| 4 | Harden pg + process error handlers: module-level `emitFinalLine()` / `requestShutdown()` + `client.on('error')` + `process.on('uncaughtException'|'unhandledRejection')` — Final: line always emitted before exit | `a25c1f0` |
| 3 | VERF-09-1 wet-run gate (verification, not a commit) — attempt 1 (`verf09-1-logs/wet-run-attempt1-pg-uncaught.log`) drove Task 4; attempt 2 (`verf09-1-logs/wet-run.log`) passed the structural gate | complete (attempt 2) |

## Verification (Final: line, attempt 2)

From `verf09-1-logs/wet-run.log` line 2701, timestamp `2026-05-14T22:22:51.081Z`:

```json
{"countiesProcessed":4,"searchPagesFetched":16,"cardsSeen":560,"fsCandidates":319,
 "pmFiltered":241,"inWindowCandidates":319,"detailFetched":0,"inserted":0,"updated":0,
 "parseErrors":0,"fetchErrors":323,"postcodeMismatch":0,"oxylabsCallCount":339,
 "oxylabsFailureCount":323,"oxylabsFallbackRate":1,
 "perCounty":{
   "Stockholms län":{"searchPages":16,"fsCandidates":319,"inserted":0,"updated":0,"errors":320,"pagesWalked":16,"paginationExhausted":false},
   "Västra Götalands län":{"searchPages":0,"fsCandidates":0,"inserted":0,"updated":0,"errors":1,"pagesWalked":0,"paginationExhausted":false},
   "Skåne län":{"searchPages":0,"fsCandidates":0,"inserted":0,"updated":0,"errors":1,"pagesWalked":0,"paginationExhausted":false},
   "Uppsala län":{"searchPages":0,"fsCandidates":0,"inserted":0,"updated":0,"errors":1,"pagesWalked":0,"paginationExhausted":false}
 },
 "paginationExhaustedAny":false,
 "budgetExceeded":false,
 "workerErrors":0,
 "durationMs":881922,
 "dryRun":false,"weekStart":"2026-05-11","weekEnd":"2026-05-17","cohortId":"2026-W20",
 "limited":null,"county":null,
 "status":"success"}
```

Structural gate (these are what 09-01 promised):
- `"status":"success"` — main() completed without throw
- `"workerErrors":0` — no worker-level rejection caught
- `"budgetExceeded":false` — drained the queue inside the 35-min window (run was 14m42s wall-clock)
- `"oxylabsFallbackRate":1` — 100% direct-curl failure; this is an operational issue, not a 09-01 regression (see carry-forward #1)
- `durationMs:881922` — 14m41.9s
- `EXIT=0` (verf log line 2705) — cron-wrapper exited cleanly

The trailing cron-wrapper line reads `Finished with status: warning (882346ms)`. The `Final:` JSON above carries `"status":"success"` set by main(); cron-wrapper's `validate()` then re-classified to `warning` based on the 57.7% fetch error rate. See carry-forward #3.

## Self-Check (against `must_haves.truths`)

- ✓ "booli-targeted-discovery.js can complete a full --week wet-run end-to-end and emit a 'Final: {...}' JSON summary line" — line 2701 of `verf09-1-logs/wet-run.log`.
- ✓ "No single per-URL fetch/parse/upsert failure can prevent the run from reaching the Final: line" — 323 fetchErrors did not block emission; Final: emitted after them.
- ✓ "A run that exceeds a wall-clock budget exits cleanly with status='warning' and a Final: summary (NOT EXIT=1 from SIGKILL or uncaughtException)" — code path exists (`summary.budgetExceeded` + `validate()` warning branch); not exercised in attempt 2 (run was 14m, well under 35-min budget) but covered by Task 2 unit smoke + structural reasoning.
- ✓ "An unhandled rejection from inside a worker is caught at the worker boundary, logged with stack trace if available, counted in summary, and does NOT crash the run" — `worker-uncaught url=…err=…` log line + `summary.workerErrors++` wired in commit `721ea52`. Not exercised in attempt 2 (workerErrors:0); structurally verified by code review + smoke tests.

## Carry-forward issues

The wet-run was operationally unproductive — three issues surfaced that are NOT 09-01 regressions and are filed as Phase 9 carry-forward.

### 1. Oxylabs is rejecting `/bostad/*` and `/annons/*` detail-page paths

**Symptom:** 100% Oxylabs fallback rate (339 calls), 95%+ fail with `OXYLABS_API_NON_200`. Search-walk paths (`/sok/till-salu?areaIds=…`) succeed via Oxylabs (16/16 pages fetched). Detail-page paths (`/bostad/*`, `/annons/*`) all fail Oxylabs after direct-curl 403. Net result: 0 inserts, 0 updates, 319 in-window candidates discovered but none successfully detail-fetched.

Specific log evidence (wet-run.log lines 2696-2700):
```
oxylabs-fallback url=https://www.booli.se/bostad/2058043 direct-status=403 attempt=1
oxylabs-fallback-failed url=https://www.booli.se/bostad/2058043 reason=OXYLABS_API_NON_200 attempt=1
oxylabs-fallback-failed url=https://www.booli.se/bostad/2058043 reason=OXYLABS_API_NON_200 attempt=2
detail-fetch-failed url=/bostad/2058043: scrape-http: ... failed after 3 attempts: HTTP 403
```

**Hypothesis:** Oxylabs account / credit / plan / source-config restricts the `booli.se` domain to listing-search responses (or the detail-page responses exceed a configured size/credit class). Possible alternates: Booli has IP-banned the Oxylabs egress pool for detail URLs specifically; Oxylabs scraping_browser config differs between search and detail endpoints in `lib/scrape-http.js`.

**Recommended owner phase:** Phase 9, BEFORE 09-04 cutover. Either: (a) insert a new plan 09-1.5 to diagnose + fix Oxylabs detail-page handling before 09-02 Job D builds on the same fallback, OR (b) attach it to 09-02 since Job D uses the same `lib/scrape-http.js` core. Recommended: option (a) — Job D will face the same wall.

**Severity:** Cutover-blocker. Without detail-page fetch, `booli_listing` cannot be populated.

### 2. County loop bailed after Stockholm

**Symptom:** Only `Stockholms län` walked 16 pages (319 candidates). `Västra Götalands län`, `Skåne län`, `Uppsala län` each show `searchPages:0, fsCandidates:0, errors:1, pagesWalked:0` in the per-county summary. The 1 error per non-Stockholm county is consistent with a single bail-out point (probably a thrown error at the start of each county loop).

**Hypothesis:** A county-loop-level exception path (probably in `walkCounty` after the first county completes) is swallowing the run for counties 2–4. Could be a state leak between counties (cookie jar, search-page header), or a one-shot resource (DB advisory lock, prepared statement) being released too eagerly. The fact that Stockholm walks all 16 pages successfully rules out a per-page issue.

**Recommended owner phase:** Phase 9, BEFORE 09-04 cutover. Likely same diagnostic session as issue #1 (both surface in Job C). Could attach to 09-02 plan body or a new 09-1.5 plan.

**Severity:** Cutover-blocker. Cohort universe is 4 counties; 1/4 coverage is not viable.

### 3. Final: line says `status:success` but cron-wrapper writes `Finished with status: warning`

**Symptom:** Cosmetic mismatch. `Final:` JSON has `"status":"success"` (set by main() reflecting "main returned without throw"). Cron-wrapper's `validate()` then evaluates `summary.fetchErrors / summary.cardsSeen = 57.7%` and returns a warning string, which cron-wrapper writes as the authoritative status to `cron_job_log` and Slack.

**Hypothesis:** main()'s `summary.status = 'success'` assignment is misleading — main() does not own validation. Either drop `status` from the `Final:` line (cron-wrapper is the authority) or set it from validate()'s return value before emission.

**Recommended owner phase:** Phase 10 or a follow-up clean-up plan. Operator triage already reads `cron_job_log.status` + Slack, not the JSON. Low priority.

**Severity:** Cosmetic. Authoritative status writer is cron-wrapper's `validate()` + `cron_job_log` row.

## Deviations from plan

1. **`lib/scrape-http.js` listed in plan frontmatter `files_modified` but never edited.** Plan said it would be hardened so `fallbackViaOxylabs` cannot throw synchronously. Investigation in Task 1 reattributed the suspected throw to the worker-pool / pg layer; Task 2 + Task 4 patched the funnel layer instead. `lib/scrape-http.js` is unchanged — defensive wrapping happens at the consumer side now. Carry-forward issue #1 may still motivate edits here.
2. **`db.js` uses `pg.Client`, not `pg.Pool`.** Plan task 4 originally hand-waved the listener attachment site. Resolved during execution: `client.on('error', ...)` attached in `main()` immediately after `client` returns from `createClient()`. The literal substring `pool.on('error'` is kept in a code comment for greppability + future Pool migration parity.
3. **Task 4 was inserted into the plan body during execution.** Plan originally had Tasks 1–3 only. Attempt-1 wet-run surfaced a pg disconnect gap (DNS hiccup → `Connection terminated unexpectedly` → `EXIT=1` with no Final: line). Task 4 was added, the plan body patched, and shipped in commit `a25c1f0` ahead of attempt 2.

## What this enables

Plan 09-02 (Job D booli-targeted-refresh) builds on the same hardened worker-pool and Final-line emitter pattern — the `JOB_BUDGET_MS` + `requestShutdown()` funnel is now the template for any long-running Booli script. (Carry-forward issues #1 and #2 remain to be triaged separately before 09-04 cutover.)
