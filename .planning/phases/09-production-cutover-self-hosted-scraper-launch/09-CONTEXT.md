# Phase 9: Production cutover — self-hosted scraper launch - Context

**Gathered:** 2026-05-14
**Status:** Ready for planning

<domain>
## Phase Boundary

**Own both view streams (Booli + Hemnet) end-to-end on an every-2-days cadence, then run the cohort pipeline to green for one full week-cycle on self-hosted data alone.**

Phase 9 closes a gap that the original plan list (09-01/02/03) did NOT cover: `booli_listing.times_viewed` is only written at discovery time (Job C, weekly Sun) and was previously refreshed by an external scraper that is now fully off. Until Phase 9 ships, `cohort-track.js` reads stale Booli view counts every cycle and writes them to `cohort_daily_views.booli_views` — the Booli side of every active cohort time-series silently flat-lines.

The phase delivers: (1) a new Job D `booli-targeted-refresh.js` — a direct mirror of Job A but on the Booli side, (2) a cadence shift for the view-refresh cycle (Job D + Job A + cohort-track) from "daily Hemnet only" to "every 2 days, same day, sequential" for both, (3) crontab wiring + Slack alerting + cron_job_log observability for all four cron-wrapped scripts, and (4) a runbook + green observation week.

**Scope clarifications surfaced during discuss:**
- Pair-only refresh: Job D refreshes ONLY the matched-pair Booli URLs (joined to `cohort_pairs`, last 8 weeks, `dropped_booli_on IS NULL`). Unmatched `booli_listing` rows are ignored — those are leftover discovery rows and don't need view tracking.
- Both Booli and Hemnet external scrapers are ALREADY decommissioned. No quiescence step, no parallel-run observation week against an external source.
- Existing Plan 09-01 (Booli discovery hardening) is unchanged and already half-executed (Tasks 1+2 committed in worktree `worktree-agent-a92bdb70060716238`; VERF-09-1 wet-run deferred until the new Job D plan ships, then both can be wet-run together).

</domain>

<decisions>
## Implementation Decisions

### Job D scope mirror (D-01 .. D-05)

- **D-01:** Job D is a **full structural mirror of `hemnet-targeted-refresh.js`**, swapped to the Booli side. Same SELECT shape, same concurrency 2 + 100-300ms jitter, same `validate()` four-branch contract (no listings / 0 parsed / >5% errors / >30% Oxylabs fallback rate). Also inherits the Plan 09-01 worker-pool hardening: per-iteration `try/catch` capturing `err.stack`, 35-min `JOB_BUDGET_MS` wall-clock budget, and `validate()` warning branches for `budgetExceeded` and `workerErrors > 0`. Lifted from the Plan 09-01 Task 2 pattern in `booli-targeted-discovery.js:227-273` (after merge).

- **D-02:** Target SELECT (PAIR-ONLY, locked):
  ```sql
  SELECT DISTINCT cp.booli_id, bl.url
  FROM cohort_pairs cp
  JOIN cohorts c ON c.cohort_id = cp.cohort_id
  JOIN booli_listing bl ON bl.booli_id = cp.booli_id
  WHERE c.week_start >= CURRENT_DATE - INTERVAL '8 weeks'
    AND cp.dropped_booli_on IS NULL
  ORDER BY cp.booli_id
  ```
  JOIN to `booli_listing` is required because `fetchBooliDetail(url, opts)` at `lib/booli-fetch.js:250` takes a URL, not a `booli_id`.

- **D-03:** Per-worker UPDATE on active:
  ```sql
  UPDATE booli_listing
     SET times_viewed = $1, is_active = true, crawled = NOW(),
         days_listed = (CURRENT_DATE - listed)::int
   WHERE booli_id = $2
  ```
  On 404 / inactive: `UPDATE booli_listing SET is_active = false WHERE booli_id = $1` (preserve `times_viewed` — same defensive pattern as Job A at `hemnet-targeted-refresh.js:181-189`).

- **D-04:** Defensive INSERT fallback IS included (full mirror, not the "drop dead code" variant). Mirrors `hemnet-targeted-refresh.js:147-164` — INSERT into `booli_listing` if no row exists for `booli_id`. Even though `cohort_pairs.booli_id` should always have a backing row in `booli_listing` (cohort-create.js guarantees this), the safety net costs ~15 lines and matches Job A symmetry. Drop logic and recovery semantics live in `cohort-track.js` (streak/drop, see [[cohort-track-streak-impact]] below).

- **D-05 (REVISED 2026-05-15):** Lookback = **8 weeks** (was 12 weeks). User intent: 8 weekly cohorts active in parallel, with all three cohort windows aligned at 8 weeks: per-pair tracking horizon (`cohort-track.js:71`), refresh window (this — Jobs A and D), and outer cohort load sweep (`cohort-track.js:14` set to 63 days = 56 + 7-day week-span buffer). Eliminates the Days 31-84 refresh-but-don't-track dead zone. Job A's SQL has been patched in parallel (`hemnet-targeted-refresh.js:208`).

### Crontab slot times (D-06 .. D-09)

- **D-06:** Every-2-days cycle = **odd days of month**, three sequential UTC slots: **14:00 Job D → 18:00 Job A → 22:00 cohort-track**. 4h gaps cover worst-case runtimes (Job D ~30–60 min, Job A ~33–51 min, both with Oxylabs fallback headroom). cohort-track at 22:00 UTC is safely after both refreshes and well clear of Mon 06:00 cohort-create. Crontab idiom: `0 14 */2 * *`, `0 18 */2 * *`, `0 22 */2 * *`.

- **D-07:** Existing crontab lines for cohort-track at 23:30 and 02:00 UTC (`deploy-instructions.md:21-22`) are **removed** — cohort-track moves entirely into the every-2-days cycle. Two daily slots → one every-2-days slot is a deliberate cadence shift, not a coverage reduction; cohort_daily_views naturally gets ~2-day gaps in the `date` column (downstream report compatibility is OUT OF SCOPE for Phase 9 — see [[downstream-reports-deferred]]).

- **D-08:** Untouched existing crontab lines (preserved verbatim from `deploy-instructions.md:23-24`): cohort-create Mon 06:00 UTC, sfpl-region-snapshot daily 08:00 UTC. Phase 9 additions: Job C Sun 22:00 UTC, Job B Mon 03:00 UTC (already planned in renumbered 09-03), Job D + Job A + cohort-track every 2 days as above.

- **D-09:** Month-boundary drift with `*/2`: on 31-day months the last fire (day 31) is followed by day 1 of the next month — a 1-day gap instead of 2. Acceptable for view tracking. If tighter spacing is needed later, switch to explicit `1,3,5,...,29,31` enumeration — defer to operator decision.

### External scraper decommissioning (D-10)

- **D-10:** **Both Booli and Hemnet external scrapers are already fully off.** Phase 9 does NOT include any quiescence step or parallel-run observation week against an external source. SC-4 in ROADMAP.md should be reworded from "External scraping process is decommissioned (or quiesced) and the cohort pipeline runs to green..." to **"The cohort pipeline runs to green for one full week-cycle on self-hosted data alone (Jobs A+B+C+D + cohort-create + cohort-track)."** The renumbered Plan 09-04 (was 09-03) no longer needs `scripts/compare-writers.js` — there's no parallel external writer to compare against.

### Cohort-track streak/drop threshold (D-11) — PLANNER MUST ADDRESS

- **D-11 (open question for planner):** The streak/drop logic in `cohort-track.js:113-127, 167-181` uses a `>= 10` threshold (10 consecutive misses → mark `dropped_booli_on` / `dropped_hemnet_on`). With cohort-track moving from daily to every-2-days, that threshold now triggers at **~20 calendar days inactive** instead of 10. Two options:
  - (a) Keep `>= 10` (slower drop detection — drops happen ~20 days after listing goes silent)
  - (b) Halve to `>= 5` (preserves ~10-day drop window — closer to current behavior)
  Planner must decide and document. Default recommendation: **(b) halve to 5** to preserve current drop-detection latency, but the planner should verify no downstream report assumes a specific drop-streak value.

### Plan list re-shape (D-12)

- **D-12:** New plan list for Phase 9 after replan:
  - `09-01-PLAN.md` Booli discovery hardening — **KEEP AS IS** (already half-executed, Tasks 1+2 committed in worktree `worktree-agent-a92bdb70060716238`). Wet-run defers until D's wet-run.
  - **NEW `09-02-PLAN.md` Job D `booli-targeted-refresh.js`** — build script per D-01..D-05 above, add `scripts/probe-booli-refresh.js` (VERF-09-2 dry-run probe), wet-run dry-run gate.
  - `09-03-PLAN.md` (was 09-02) Cron integration — extend to schedule all 4 cron-wrapped scripts (Jobs A, B, C, D) + cohort-track + cohort-create + sfpl-region-snapshot per the every-2-days block in D-06..D-09. Update `deploy-instructions.md`.
  - `09-04-PLAN.md` (was 09-03) Cutover + runbook — simpler than original draft: no parallel-run vs external scraper, no `compare-writers.js`. Focus is the green-week verification + runbook entry.

### Claude's Discretion

- Crontab slot times (D-06): user said "you choose" after the job-catalogue explainer — locked to 14/18/22 UTC odd days based on runtime headroom analysis.
- Streak threshold halving (D-11): planner picks (a) or (b), with default recommendation (b) noted.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### ROADMAP + project state
- `.planning/ROADMAP.md` §"Phase 9: Production cutover — self-hosted scraper launch" — phase scope and (now outdated) SC list. **Note: SC-4 needs updating per D-10. The planner should rewrite SC-4 as part of the replan.**
- `.planning/config.json` — workflow config (research: false)

### Existing Phase 9 plans (one to keep, two to renumber)
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-01-PLAN.md` — Booli discovery hardening (KEEP, half-executed)
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-02-PLAN.md` — Cron integration (will be renumbered to 09-03)
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-03-PLAN.md` — Cutover + runbook (will be renumbered to 09-04)
- `scripts/diagnose-verf-b2.md` — Plan 09-01 Task 1 investigation note (already committed)

### Existing job patterns to mirror or extend
- `hemnet-targeted-refresh.js` — Job A. **Full structural template for new Job D.** Critical sections: `:60-78` (shapeListingForDb mapping), `:96-190` (processOne worker body), `:204-211` (SELECT pattern), `:235-254` (worker pool + concurrency), `:272-294` (validate four-branch contract), `:300+` (smoke-test scaffolding).
- `booli-targeted-discovery.js` — Job C. **Source of the hardened worker-pool pattern** to copy into Job D after Plan 09-01 merges: `:52` (`JOB_BUDGET_MS` constant + comment), `:227-273` (hardened worker with `try/catch` + `err.stack` capture + budget check), validate branches added in Plan 09-01 Task 2 Edit 4 (after Plan 09-01 merge).
- `lib/booli-fetch.js:250` — `fetchBooliDetail(listingUrl, opts)`. Returns `{status: 'active'|'inactive', listing|reason}`. Already wraps Oxylabs fallback via `getWithRetry`.
- `lib/hemnet-fetch.js` — `fetchDetail(id, opts)`. Job A's equivalent fetcher.
- `lib/scrape-http.js` — shared HTTP/Oxylabs core (already hardened in Plan 09-01 Task 2 commits).
- `cron-wrapper.js:140` — `runJob({scriptName, main, validate})` contract. Status taxonomy: success / warning / failure → exit 0/0/1; Slack alerts on warning|failure.

### Cohort pipeline reading points
- `cohort-track.js:79-128` — Booli read path (currently reads stale `booli_listing.times_viewed`).
- `cohort-track.js:131-183` — Hemnet read path (MAX over duplicate rows).
- `cohort-track.js:185-189` — `cohort_daily_views` insert with `ON CONFLICT (pair_id, date) DO NOTHING`.
- `cohort-track.js:113-127, 167-181` — streak/drop logic (10-threshold; see D-11).
- `cohort-create.js:79-91` — Booli FS row read at cohort creation (Day-0 view source).
- `cohort-create.js:116-128` — Hemnet candidate match query (postcode + street).
- `cohort-create.js:159-179` — `cohort_pairs` INSERT.
- `cohort-create.js:200-207` — `cohort_daily_views` Day-0 INSERT.

### Verification helpers
- `verf-b2-logs/wet-run.log` — Plan 09-01 source-of-truth EXIT=1 incident log.
- `scripts/verf04-snapshot.js` and `scripts/verf03-snapshot.js` — VERF pattern for snapshot-based verification.
- `scripts/probe-hemnet-fetch.js` — Pattern for new `scripts/probe-booli-refresh.js`.

### Codebase conventions
- `.planning/codebase/CONVENTIONS.md` — naming (camelCase JS, snake_case DB), error handling (Pattern 1: cron-wrapped scripts), SQL patterns (parameterized, ON CONFLICT, ::date casts).
- `.planning/codebase/STACK.md` — Node.js + `pg` 8.20.0 + `dotenv`. No test framework. No formatter. CommonJS.
- `.planning/codebase/STRUCTURE.md`, `ARCHITECTURE.md`, `CONCERNS.md`, `INTEGRATIONS.md`, `TESTING.md` — full codebase intel (read selectively per phase needs).

### Deploy + operations
- `deploy-instructions.md:21-24` — current crontab block (the doc-vs-reality drift open question from existing Plan 09-02 carries forward to the renumbered Plan 09-03).
- `.env.example` — env var contract (DB_*, optional SLACK_WEBHOOK_URL).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`hemnet-targeted-refresh.js` complete structure** (~294 lines): Job D should be a near-line-by-line mirror swapped to the Booli side. Lift the `shapeListingForDb` field mapping (`:60-78`), the SELECT pattern (`:204-211`), the worker pool (`:235-254`), the four-branch `validate()` (`:272-294`), and the smoke-test scaffolding (`:300+`). Net implementation effort: ~280 lines of Booli analog, ~30-60 min of writing time.

- **Plan 09-01's hardened worker-pool pattern** (Tasks 1+2 in `worktree-agent-a92bdb70060716238`): `JOB_BUDGET_MS = 35 * 60 * 1000`, `try { processDetailFetch } catch { workerErrors++; log stack }`, validate warning branches for `budgetExceeded` and `workerErrors > 0`. Copy this pattern directly into Job D — do NOT extract to `lib/worker-pool.js` in this phase (defer that refactor; copy-paste is cheaper than premature abstraction).

- **`lib/booli-fetch.js:fetchBooliDetail`**: ready-to-use; takes URL, returns `{status, listing}` or `{status: 'inactive', reason: '404'}`. Already wraps Oxylabs fallback.

- **`lib/scrape-http.js`**: shared Oxylabs core (after Plan 09-01 merge). Job D inherits the hardened `fallbackViaOxylabs` automatically via `fetchBooliDetail`.

- **`cron-wrapper.js:runJob`**: status + Slack + cron_job_log wiring. Job D just needs to export `main(client, log)` and `validate(summary)`.

### Established Patterns

- **Pattern 1 (cron-wrapped scripts) per `.planning/codebase/CONVENTIONS.md`** — Job D MUST follow: `const { runJob } = require('./cron-wrapper');` + `async function main(client, log) {...}` + `runJob({scriptName, main, validate})`.

- **Pair-only refresh gate** — both Job A and Job D filter on `cohort_pairs.dropped_X_on IS NULL` and `cohorts.week_start >= NOW() - 8 weeks` (revised 2026-05-15 from 12 weeks per D-05). Drop-recovery logic lives in `cohort-track.js`, not in the refresh scripts themselves. Job D MUST NOT include recovery branching — that would duplicate cohort-track's state machine.

- **Defensive single-INSERT-after-UPDATE pattern** — Job A inserts a fresh `hemnet_listingv2` row if the UPDATE found 0 matches (`:147-164`). Job D mirrors this for symmetry, even though `cohort_pairs.booli_id` should always have a backing `booli_listing` row.

- **Concurrency 2 + 100-300ms jitter** — load-shaping pattern shared by Jobs A and C. Job D inherits this.

- **`--smoke` self-test** — pure-function test of a `shape*ForDb` helper, gated on `process.argv.includes('--smoke')`. Job D needs an equivalent `shapeBooliForUpdate` helper + smoke block.

### Integration Points

- **booli_listing UPDATE target**: Job D writes the columns currently set by Job C's upsert (`times_viewed`, `is_active`, `crawled`, `days_listed`). The `ON CONFLICT (url) DO UPDATE` at `booli-targeted-discovery.js:207-213` is the schema reference for which columns are owned by us vs. external.

- **cohort-track reads from booli_listing.times_viewed**: `cohort-track.js:83/99` is the consumer. After Job D ships, the value cohort-track reads will be a fresh (≤2-day-old) write, not a stale (~weeks-old) value.

- **cron_job_log writes**: Job D inherits this for free via `runJob`. Plan 09-03's `scripts/verify-cron-job-log.js` already proposed checking last-N rows for each scheduled job — extend to include `booli-targeted-refresh` in the script list.

- **SLACK_WEBHOOK_URL**: Phase 9 SC-2 says alerts wire via cron-wrapper. Job D inherits this for free; the operator-set webhook URL in droplet `.env` covers all four cron-wrapped scripts.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly framed the missing piece as "we previously would get Booli views from the booli_listing table — we turned off that job. We now need to get Booli daily views as well from the listings which we've matched with Hemnet." The "matched with Hemnet" wording is load-bearing — Job D MUST filter on `cohort_pairs` (pair-only), not on `booli_listing` (all rows). Confirmed during clarification.

- The 2-day cadence has historical precedent in this codebase: commit `9663e81 "feat: 2-day Booli deltas, H/B ratio chart, and Excel export"` from the v1.0 era. This is a return to a known design point, not a fresh invention.

- Job D's wet-run + Job C's wet-run (deferred VERF-09-1) can be done in the same testing session — both run against live Booli/Oxylabs/DB, both share the hardened worker-pool pattern. Combine them when the new Job D plan is ready to wet-test.

</specifics>

<deferred>
## Deferred Ideas

- **[[downstream-reports-deferred]] Update downstream reports for every-2-days cohort_daily_views**: `pool-flow-report.js`, `weekly-view-report.js`, `export-views-wide.js`, `chart-hb-ratio.js`, `export-hb-ratio-xlsx.js`, `generate-pool-flow-charts.js`, etc. currently assume daily granularity in `cohort_daily_views.date`. With ~2-day gaps starting in Phase 9, these reports may show odd patterns (gaps in time-series charts; delta-per-day calculations that assume 1-day intervals). User explicitly chose NOT to discuss this gray area — defer to a follow-up phase (Phase 10?) once Phase 9 is in production and the actual report behavior is observed.

- **[[lib-worker-pool-refactor]] Extract hardened worker-pool pattern into `lib/worker-pool.js`**: After Phase 9 ships, three scripts (Job A, Job C, Job D) will all carry near-identical worker-pool code with `try/catch + err.stack + budget` hardening. Extraction makes sense in a Phase 10 refactor; not worth the risk inside Phase 9.

- **[[cron-tightening]] Explicit-day-list crontab vs `*/2`**: On 31-day months, `*/2` produces a 1-day gap at the month boundary instead of 2. Switching to explicit `0 14 1,3,5,...,29,31 * *` enumeration gives exact 2-day spacing. Trade-off is crontab readability. Operator decision after observing the first cross-month boundary.

- **[[booli-listing-backfill]] One-shot Job D against existing cohort_pairs to refresh stale data**: Since the external scraper was turned off, `booli_listing.times_viewed` for already-tracked listings is stale (timestamp-of-last-external-scrape, not "now"). When Job D first runs, it will write fresh values that look like a huge jump in `cohort_daily_views.booli_views`. Operator may want a one-shot pre-cutover Job D run to make the first cohort-track delta look natural. Defer to operator preference at cutover time.

- **[[verf-09-1-deferred]] VERF-09-1 wet-run for Job C (Plan 09-01 Task 3)**: Deferred until the new Job D plan ships. Both wet-runs will be done in the same testing session so the hardened worker-pool pattern is validated against both Booli scripts at once.

- **None of the above are blockers for Phase 9 itself.** All are post-cutover follow-ups that can be sized and prioritized after the green-week observation.

</deferred>

---

*Phase: 09-production-cutover-self-hosted-scraper-launch*
*Context gathered: 2026-05-14*
