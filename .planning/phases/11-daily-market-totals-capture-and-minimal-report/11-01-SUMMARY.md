---
phase: 11-daily-market-totals-capture-and-minimal-report
plan: "01"
subsystem: market-totals-capture
tags: [market-totals, daily-cron, hemnet, booli, postgres, oxylabs, cron-wrapper]
dependency_graph:
  requires: [cron-wrapper.js, lib/scrape-http.js, db.js, cron_job_log table]
  provides: [market_totals table DDL, market-totals-daily.js, 08:30 UTC cron slot]
  affects: [deploy-instructions.md, .planning/ROADMAP.md]
tech_stack:
  added: [market_totals (new Postgres table)]
  patterns: [inline DDL, Promise.all 3-fetch, Apollo ROOT_QUERY prefix-walk, assertNumericTotal smoke probe, idempotent UPSERT ON CONFLICT, sync validate]
key_files:
  created: [market-totals-daily.js]
  modified: [.planning/ROADMAP.md, deploy-instructions.md]
decisions:
  - "4 rows/day (2 sites × 2 segments: till_salu + kommande); Sold dropped per operator decision during Phase 11 discuss"
  - "No oxylabsFallbackRate validate() warn — D-07 / Plan 10-02 lesson; field present in resultSummary as reporting-only"
  - "Silent on success: cron-wrapper is the only Slack surface; no direct sendSlack in main()"
  - "Inline smoke probe (D-02): assertNumericTotal throws on undefined/null/NaN/non-positive — no sanity bounds"
  - "Apollo ROOT_QUERY prefix-walk via pickByPrefix: stable against argument-shape changes"
metrics:
  duration: "~15 min (Tasks 1-3)"
  completed: "2026-05-27"
  tasks_complete: 3
  tasks_total: 4
  files_created: 1
  files_modified: 2
---

# Phase 11 Plan 01: ROADMAP Scope Edits + market-totals-daily.js + Crontab Registry Summary

**One-liner:** Daily cron job capturing 4 rows/day of Hemnet + Booli nationwide listing totals via 3-fetch Promise.all + inline Apollo ROOT_QUERY walk + assertNumericTotal smoke probe, idempotent upsert into new `market_totals` table, 08:30 UTC cron slot registered.

## Status: 3/4 Tasks Complete — Wet-Run Pending Operator Action

Tasks 1–3 are committed. Task 4 (operator wet-run on production droplet) is pending and is documented in the checkpoint below.

## Completed Tasks

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Apply locked ROADMAP edits for Phase 11 scope | af8d7cb | `.planning/ROADMAP.md` |
| 2 | Write market-totals-daily.js | 848cc74 | `market-totals-daily.js` (145 lines) |
| 3 | Register 08:30 UTC crontab entry | 7e10024 | `deploy-instructions.md` |

## Task 1: ROADMAP Edits Applied (3/3)

All three locked edits from `<roadmap_updates_needed>` applied:

1. **SC-1/SC-2 (line 162):** "6 rows/day (Hemnet × 3 segments + Booli × 3 segments)" → "4 rows/day (Hemnet × 2 segments + Booli × 2 segments) on success — Till salu + Kommande only; Sold dropped during discuss"
2. **SC-2:** "or unexpected delta" clause dropped. Final: "warns to Slack on JSON-path-break or fetch failure"
3. **Out-of-scope:** Appended "Sold totals — operator-deferred during Phase 11 discuss; JSON paths known but reserved for a future plan."

Verified: all grep acceptance checks pass, no other Phase blocks modified.

## Task 2: market-totals-daily.js Shipped

**File:** `market-totals-daily.js` at repo root (145 lines)

**Key sections:**
- **Inline DDL (lines 15–24):** `CREATE TABLE IF NOT EXISTS market_totals (day DATE, site TEXT, segment TEXT, total INTEGER, fetched_at TIMESTAMPTZ, source_url TEXT, PRIMARY KEY (day, site, segment))`
- **Idempotent UPSERT (lines 26–30):** `ON CONFLICT (day, site, segment) DO UPDATE SET total = EXCLUDED.total, fetched_at = EXCLUDED.fetched_at, source_url = EXCLUDED.source_url`
- **assertNumericTotal smoke probe (lines 33–39):** Throws descriptive error if any JSON path resolves to undefined/null/NaN/non-positive; cron-wrapper marks `status='failure'` and fires Slack
- **pickByPrefix (lines 42–51):** Apollo ROOT_QUERY prefix-walk; stable against argument-shape changes (mirrors `lib/hemnet-fetch.js:196-204` pattern)
- **extractApolloRoot (lines 53–63):** Extracts `__APOLLO_STATE__.ROOT_QUERY` from `extractNextData(html)`; throws descriptive error on missing state
- **3-fetch Promise.all (lines 74–80):** Hemnet 1 req (both segments) + Booli 2 reqs (one per segment) = 3 Oxylabs reqs/day
- **Upsert loop (lines 100–107):** 4 rows, logs `upsert ok: site=... segment=... total=...`
- **sync validate() (lines 118–124):** Warns if `rowsWritten !== 4`; no oxylabsFallbackRate threshold; no delta check

**All acceptance checks passed:**
- `node -c market-totals-daily.js` exits 0
- `CREATE TABLE IF NOT EXISTS market_totals` present
- `PRIMARY KEY (day, site, segment)` present
- `ON CONFLICT (day, site, segment)` present
- `scriptName: 'market-totals-daily'` present
- `require('./lib/scrape-http')` present
- `assertNumericTotal` present
- `till_salu` count: 6 (≥ 4)
- `kommande` count: 6 (≥ 4)
- `oxylabsFallbackRate` present (reporting field only)
- No `oxylabsFallbackRate > 0` threshold check
- No `sendSlack` or `SLACK_WEBHOOK_URL` (silent on success)
- No `require('dotenv')` (cron-wrapper loads env)

## Task 3: Crontab Registry Updated

New Phase 11 block inserted in `deploy-instructions.md` between the Phase 9 every-2-days closing block (line 65) and the "Preserved supplementary cron lines" section:

```cron
30 8 * * *  cd /opt/hemnet-cohort-tracker && node market-totals-daily.js       >> /var/log/hemnet/market-totals.log 2>&1
```

Slot rationale documented: 30-min buffer after `sfpl-region-snapshot` (08:00 UTC, DB-only); clear of every-2-days view-refresh cycle and Mon fan-out.

Exactly 1 `market-totals-daily.js` line in file. `market-totals-weekly-report.js` NOT added (reserved for Plan 11-03).

## Task 4: Wet-Run — Pending Operator Action

See checkpoint message below. The crontab line is documented but NOT yet live. Operator must:
1. Deploy via `git pull` on droplet
2. Run `node market-totals-daily.js` manually
3. Verify 4 rows in `market_totals` + `cron_job_log` row `status='success'`
4. Activate crontab line via `crontab -e`

## Deviations from Plan

None — plan executed exactly as written. The `market-totals-daily.js` content closely follows the plan-provided template. Minor omission: the plan template included individual `tHemStart`/`tBTSStart`/`tBKomStart` timing variables post-Promise.all (which measure elapsed from before the parallel start, not per-request), simplified to a single `fetchElapsedMs = Date.now() - t0` after the parallel block (semantically equivalent for a Promise.all). This does not affect correctness or any acceptance criterion.

## Known Stubs

None. The script is fully wired to real infrastructure (`lib/scrape-http.js`, `cron-wrapper.js`, live `market_totals` table DDL). First production write will occur after the operator wet-run (Task 4).

## Threat Flags

None. `market-totals-daily.js` introduces no new network endpoints, auth paths, or trust boundaries. It consumes existing `lib/scrape-http.js` transport (Oxylabs + direct curl) and writes only to the new `market_totals` table (isolated from cohort tables). DDL runs inside `cron-wrapper`-provided pg.Client with existing `statement_timeout=120s`.

## Self-Check: PASSED

- `market-totals-daily.js` exists: CONFIRMED
- `.planning/ROADMAP.md` edits applied: CONFIRMED (grep verifications passed)
- `deploy-instructions.md` updated: CONFIRMED
- Commits exist:
  - `af8d7cb` (Task 1 — ROADMAP edits)
  - `848cc74` (Task 2 — market-totals-daily.js)
  - `7e10024` (Task 3 — deploy-instructions.md)
