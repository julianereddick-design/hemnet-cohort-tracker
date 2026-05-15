# Phase 9 / Plan 09-02: Job D `booli-targeted-refresh` + symmetric Job A hardening - Context

**Gathered:** 2026-05-15
**Status:** Ready for planning (replan of existing 09-02-PLAN.md)
**Scope:** Plan-level context layered ON TOP of phase-level `09-CONTEXT.md` and `09-1.5-CONTEXT.md`. Read those first.

<domain>
## Plan Boundary

**Build Job D (`booli-targeted-refresh.js`) AND retrofit Job A (`hemnet-targeted-refresh.js`) with the same 09-01 worker-pool hardening, sized for the 100%-Oxylabs steady state we now know is the new normal for Booli (and the contingency for Hemnet).**

The existing `09-02-PLAN.md` plan body locks `JOB_BUDGET_MS = 35 * 60 * 1000` (35 min) and `Promise.all([worker(), worker()])` (concurrency 2). Both numbers were inherited from Plan 09-01's diagnostic conservatism — pre-09-1.5, before paid Oxylabs revealed the ~5s/call steady-state latency. With ~8k matched pairs at 8-week alignment, that sizing produces `budgetExceeded:true` on essentially every run.

This plan-context locks the corrected sizing (concurrency 8, budget 240 min), expands scope to retrofit the same hardening into Job A (`hemnet-targeted-refresh.js`) so the two scripts operate symmetrically, switches the cron grid from sequential Job D → Job A to **parallel Job D + Job A at the same 14:00 UTC slot**, and adds a Hemnet-side Oxylabs probe as insurance against a future Hemnet IP-ban.

Out of scope: changing the every-2-days cadence (stays per D-06), moving cohort-track from 22:00 UTC (stays per D-06), measuring the actual `cohort_pairs` count via DB query (skipped — the budget headroom absorbs estimate error), redefining the wet-run pass bar (stays as in `09-02-PLAN.md` <resume-signal>), and the pre-cutover one-shot refresh (`[[booli-listing-backfill]]` stays deferred).

</domain>

<decisions>
## Implementation Decisions

### Job D budget + concurrency sizing (D-15)

- **D-15:** `JOB_BUDGET_MS` for Job D = **240 minutes** (the 14:00 → 18:00 UTC parallel-finish window). Worker pool concurrency = **8** (was 2 in the existing `09-02-PLAN.md` plan body — bumped this plan-discussion).
  - **Rationale:** At 09-1.5's empirical ~13 details/min @ conc 2 (`verf09-1-5-logs/wet-run-attempt2-rate-observation.log`), scaling linearly to conc 8 yields ~52 details/min. For an ~8k-pair queue: 8,000 / 52 ≈ 155 min wall-clock — fits the 240-min budget with ~85 min margin.
  - **Why not conc 4:** ~26 details/min → 8,000 / 26 ≈ 310 min — still 14% over the 240-min cron gap. Would re-introduce `budgetExceeded:true` on every cycle and re-create the alert-fatigue carry-forward Plan 09-1.5 already closed.
  - **Why not conc 16+:** 0.48% → 2% Oxylabs cap usage is fine, but 8× the historical traffic burst is a step too far for the first hardened run. Conc 8 fits the budget with margin; revisit only if a green-week observation shows reason to push further.
  - **Oxylabs Advanced cap check:** 50 jobs/sec server-side cap. Both Job D (1.6 req/sec) + Job A (~0.4 req/sec direct curl + ≤0.1 req/sec rare Oxylabs fallback) running in parallel = ~2 req/sec ≈ 4% of cap. Plenty of headroom.
  - **Hardening lock posture:** This deliberately relaxes the Plan 09-01 hardening lock that held concurrency=2. The lock was a diagnostic safety net during the trial-credit-exhausted investigation; paid Oxylabs (D-14) plus 09-1.5's zero-failure attempt 1 retired the diagnostic need. Lock formally relaxes to conc 8 for both Booli- and Hemnet-side refresh jobs (Job D and Job A — see D-16); Job C and Job B stay at their current concurrency in 09-02 scope.

### Symmetric Job A retrofit (D-16)

- **D-16:** Plan 09-02 expands scope to **retrofit `hemnet-targeted-refresh.js` (Job A) with the same hardening + sizing as Job D**:
  - `JOB_BUDGET_MS = 240 * 60 * 1000` (240 minutes)
  - Worker pool concurrency 2 → 8
  - Per-iteration `try/catch` capturing `err.stack`, counting into `summary.workerErrors`, logging `worker-uncaught hemnet_id=...` line
  - `validate()` branches for `budgetExceeded === true` and `workerErrors > 0`
  - `summary` initialization adds `budgetExceeded: false` and `workerErrors: 0` fields
  - **Why:** Phase 9's purpose is to own both view streams end-to-end. Leaving Job A un-hardened violates the intent and exposes a real failure mode: if Hemnet starts IP-banning the dev egress like Booli already does, Job A's un-hardened worker pool will hang into SIGKILL with no summary-and-bail. The Plan 09-01 → 09-1.5 → 09-02 progression is "make our refresh path symmetric and resilient" — Job A's hardening gap was a Phase 9 oversight that surfaced during this discuss-phase.
  - **Today's behavior:** Hemnet currently allows direct curl, so Job A at conc 8 will leave the worker pool ~80% idle (~10-20 min wall-clock vs. ~30-60 at conc 2). That wasted capacity is harmless. The cost of going to 8 today is zero; the cost of staying at 2 if Hemnet flips is a hung job and a scramble.
  - **Tomorrow's contingency:** If Hemnet flips to Oxylabs-only, Job A at conc 8 → ~155 min wall-clock (same math as Job D). Fits the 240-min budget. Pre-staged.
  - **Cron-grid implication:** Job A no longer needs a separate 18:00 slot — it runs in parallel with Job D at 14:00 (see D-17).

### Parallel-run cron grid (D-17)

- **D-17:** **Amends D-06.** Job D and Job A run in **PARALLEL at 14:00 UTC odd-days**, not sequentially:
  ```
  0 14 */2 * *   cd /path && node booli-targeted-refresh.js
  0 14 */2 * *   cd /path && node hemnet-targeted-refresh.js
  0 22 */2 * *   cd /path && node cohort-track.js
  ```
  - **Rationale (no shared resource):** Different DB tables (`booli_listing` vs `hemnet_listingv2`), different external services (Booli via Oxylabs vs Hemnet direct curl), each script opens its own `pg.Client` via `db.js:5` (`new Client(...)` — not a Pool, so no shared connection drain), separate Slack alert lines (scriptName disambiguates), separate `cron_job_log` rows. Combined Oxylabs load ≈ 4% of 50/sec cap. Combined Node memory ≈ 100MB on a multi-GB droplet.
  - **Cycle-time win:** ~155 min total (Job D dominates) instead of ~155+50=205 sequential. Buys ~95 min of margin before 22:00 cohort-track.
  - **What the new D-06 grid reads as** (all UTC, odd days of month for the every-2-days block; weekly + daily slots unchanged):
    | Time | Job | Cadence |
    |---|---|---|
    | 14:00 | Job D + Job A (parallel) | Every 2 days (odd days) |
    | 22:00 | `cohort-track` | Every 2 days (odd days) |
    | 22:00 Sun | Job C `booli-targeted-discovery` | Weekly |
    | 03:00 Mon | Job B `hemnet-weekly-seeding` | Weekly |
    | 06:00 Mon | `cohort-create` | Weekly |
    | 08:00 daily | `sfpl-region-snapshot` | Daily |
  - **Triage cost:** If both fail in the same cycle, Slack will show two alerts. Each line has its own scriptName, so attribution is per-line. Acceptable.
  - **`cohort-track` timing unchanged:** Stays at 22:00 UTC. Could be moved earlier to ~17:00 (25 min after Job D's max ETA), but the conservative 8h gap remains as the safety margin if Oxylabs has a bad day.

### Hemnet Oxylabs probe (D-18)

- **D-18:** Add **`scripts/probe-oxylabs-hemnet.js`** — symmetric to Job D's `scripts/probe-booli-refresh.js` and `scripts/probe-oxylabs-booli.js`. A 12-URL probe that forces `SCRAPE_FORCE_OXYLABS=1` (`lib/scrape-http.js:40-42`) and validates the Hemnet → Oxylabs path works end-to-end.
  - **Cost:** ~$0.005 to run (12 paid Oxylabs calls). Cheaper than learning the path is broken under pressure.
  - **Why now, not later:** Once Plan 09-02 ships, Job A is hardened for Hemnet-flip-to-Oxylabs scenario. The probe is the validation that the fallback path actually works — without it, the hardening is theoretical. Total scope cost is ~80 lines of code mirroring `scripts/probe-oxylabs-booli.js` with `fetchDetail`/`hemnet_listingv2` swapped in.

### Wet-run gate combination (D-19)

- **D-19:** The existing 09-02-PLAN.md Task 3 (VERF-09-2) already combines Job D's wet-run with the deferred VERF-09-1 Job C wet-run. **D-16 adds Job A's wet-run to the same session** — the testing session now validates the hardened worker-pool pattern against THREE scripts (Job C, Job D, Job A), all on the same paid Oxylabs subscription. Wet-run order in the session: probes first (probe-oxylabs-booli, probe-oxylabs-hemnet, probe-booli-refresh) → then the three job wet-runs in parallel pairs where possible (Job D + Job A parallel; Job C standalone since it's the weekly Sun slot).

### Claude's Discretion

- Whether to extract the hardened worker-pool pattern into `lib/worker-pool.js` ([[lib-worker-pool-refactor]] in 09-CONTEXT.md `<deferred>`): **stays deferred.** Three near-identical copies (Job A, Job C, Job D) is the price of keeping this plan tight. Phase 10 refactor.
- Whether the Job A retrofit task in Plan 09-02 also writes a Job A `--smoke` self-test for the existing `shapeListingForDb`: **Claude's discretion.** Job A has a `--smoke` block already (`hemnet-targeted-refresh.js:300+`); the retrofit may not need to touch it.
- Whether to re-measure Job A's actual wall-clock at the new 8-week alignment before sizing: user explicitly declined as Task 0. Estimate-based sizing is the locked posture.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Plan + phase contracts
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-02-PLAN.md` — existing plan body (THIS PLAN — needs replan to bake in D-15, D-16, D-17, D-18, D-19). The current frontmatter `<must_haves.truths>` and `<interfaces>` blocks reference conc 2 / budget 35-min — both must be re-baselined.
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-CONTEXT.md` — phase-level decisions D-01..D-12. Plan 09-02 inherits Job D structural-mirror scope (D-01..D-05), pair-only refresh, plan list re-shape. **D-06 is AMENDED by D-17 below (parallel run instead of sequential).**
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-1.5-CONTEXT.md` — plan-level context for 09-1.5. D-13 (single-fix-path) and D-14 (paid Oxylabs Advanced subscription) flow into this plan.
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-1.5-SUMMARY.md` — empirical evidence: 13 details/min @ conc 2 (carry-forward #1 + #2), 8-week alignment patch (commit `ebd2a50`), `JOB_BUDGET_MS` 35→180 bump in Job C (commit `1737e88`).
- `.planning/ROADMAP.md` §"Phase 9: Production cutover" — phase scope and SC list (SC-4 still pending reword per 09-CONTEXT.md D-10).

### Code under modification (PLANNER MUST READ before editing)
- `booli-targeted-refresh.js` — **does NOT yet exist.** Plan 09-02 creates it from scratch per 09-02-PLAN.md Task 1, with D-15 sizing baked in (conc 8, budget 240 min).
- `hemnet-targeted-refresh.js` (whole file, 395 lines) — **target of D-16 retrofit.** Critical sections to patch:
  - `:1-14` — header comment (add 09-02 retrofit note: hardening pattern, conc 8, budget 240 min)
  - `:18-23` — require block (no change expected)
  - `:237` — `// 3. Hand-rolled worker pool, concurrency 2, 100-300ms jitter per dispatch.` — bump comment to conc 8
  - `:257` — `await Promise.all([worker(), worker()]);` — expand to 8 workers
  - Worker body — wrap with `try/catch` capturing `err.stack`, incrementing `summary.workerErrors`, logging `worker-uncaught hemnet_id=...` line
  - `summary` init — add `budgetExceeded: false`, `workerErrors: 0` fields
  - Insert `JOB_BUDGET_MS = 240 * 60 * 1000` constant near top of file (mirrors Job D)
  - Worker iteration top — add budget check that sets `summary.budgetExceeded = true` and drains queue
  - `validate()` — add two new branches at end: `if (summary.budgetExceeded === true) { return 'job budget exceeded ...' }` and `if (summary.workerErrors > 0) { return 'worker-level errors caught: ...' }`
- `booli-targeted-discovery.js` (Plan 09-01 source-of-truth for the hardening pattern) — **read-only reference for the retrofit:**
  - `:52` `JOB_BUDGET_MS = 180 * 60 * 1000` constant pattern (09-02 uses 240, not 180 — different budget, same shape)
  - `:227-273` hardened worker body with `try/catch` + `err.stack` + budget check
  - validate branches added in Plan 09-01 Task 2 Edit 4 — model for D-16's Job A patch
- `scripts/probe-oxylabs-booli.js` — **template for new `scripts/probe-oxylabs-hemnet.js` per D-18.** Mirror: `fetchBooliDetail(url)` → `fetchDetail(hemnet_id)`, `booli_listing` read → `hemnet_listingv2` read.
- `scripts/probe-hemnet-fetch.js` — Phase 7-era Hemnet probe. Different purpose (validates parser correctness against DB), but the SELECT shape for picking probe candidates may be reusable.
- `scripts/probe-booli-refresh.js` — Job D's VERF probe (will be built by 09-02 Task 2 as already planned). Not modified by D-18.
- `db.js:5` — `createClient()` returns a fresh `pg.Client` per script. **Reference for D-17 rationale** (parallel runs do not share a connection pool).

### Library + plumbing (read-only for 09-02)
- `lib/booli-fetch.js:250` — `fetchBooliDetail(listingUrl, opts)` — Job D's fetcher.
- `lib/hemnet-fetch.js` — `fetchDetail(id, opts)` — Job A's fetcher.
- `lib/scrape-http.js` — shared HTTP/Oxylabs core. Hardened in 09-01, paid-creds-confirmed in 09-1.5. No change in 09-02 scope.
- `lib/scrape-http.js:40-42` — `SCRAPE_FORCE_OXYLABS=1` env flag. Used by `scripts/probe-oxylabs-booli.js` and the new `scripts/probe-oxylabs-hemnet.js`.
- `cron-wrapper.js:57-141` — `runJob({scriptName, main, validate})` contract. No change.

### Cron + deploy
- `deploy-instructions.md:21-24` — current crontab block. Plan 09-03 (renumbered) owns the crontab update; D-17 dictates the new every-2-days block content. Plan 09-03 should consume D-17 verbatim.
- `.env.example` — env var contract. Paid Oxylabs creds (`OXYLABS_USERNAME`, `OXYLABS_PASSWORD`) live here post-09-1.5. No new env vars in 09-02 scope.

### Codebase conventions
- `.planning/codebase/CONVENTIONS.md` — Pattern 1 cron-wrapped scripts. Both Job D and the retrofitted Job A continue to match Pattern 1.
- `.planning/codebase/STACK.md` — Node.js + `pg` 8.20.0 + `dotenv`. No test framework. CommonJS.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **Plan 09-01's hardened worker-pool pattern is the source of truth** (committed in `booli-targeted-discovery.js`): `JOB_BUDGET_MS` constant + comment, worker iteration with budget check + drain, per-iteration `try/catch` capturing `err.stack` and counting `workerErrors`, `validate()` branches. Job D builds it from scratch per 09-02-PLAN.md Task 1; Job A retrofit per D-16 copies it edit-by-edit. **No `lib/worker-pool.js` extraction in 09-02** ([[lib-worker-pool-refactor]] stays deferred).
- **`scripts/probe-oxylabs-booli.js` (Plan 09-1.5 commit `9bb0d38`)** is the structural template for `scripts/probe-oxylabs-hemnet.js` (D-18). It already implements: `SCRAPE_FORCE_OXYLABS=1`, 12-URL probe loop, `OXYLABS_API_NON_200 body=` excerpt logging, ok/total counter, EXIT=0 on all-pass.
- **`hemnet-targeted-refresh.js` `--smoke` block (`:300+`)** already exists. Job A retrofit does not need to add one; the existing smoke tests for `shapeListingForDb` + `parseArgs` continue to apply.
- **`db.js:createClient()`** returns a fresh `pg.Client` per call — parallel Job D + Job A runs do not share a connection pool. No coordination needed.

### Established Patterns

- **Cron-wrapped scripts (Pattern 1)** — both jobs continue to match: `runJob({scriptName, main, validate})`.
- **Concurrency-N worker pool with jitter** — historically held at N=2 (Plan 09-01 hardening lock). **D-15 + D-16 raise the lock to N=8 for both Booli- and Hemnet-side refresh jobs.** Concrete change: replace `Promise.all([worker(), worker()])` with a loop building 8 worker promises.
- **Per-iteration budget check + drain** — top-of-worker-loop `if ((Date.now() - startMs) >= JOB_BUDGET_MS) { summary.budgetExceeded = true; queue.length = 0; break; }`. Mirror in both Job D and Job A.
- **`worker-uncaught <key>= ...` log line** — present in `booli-targeted-discovery.js` (Plan 09-01) for `booli_id=`; Job D uses `booli_id=`; Job A retrofit uses `hemnet_id=`.
- **`validate()` warning branches** — `budgetExceeded === true` returns "job budget exceeded ...", `workerErrors > 0` returns "worker-level errors caught: ...". Both branches return strings; `runJob` maps to status=`warning`, EXIT=0, Slack alert fires.
- **Parallel-cron pattern** — two cron lines at the same `0 14 */2 * *` schedule, each invoking a different script. Both inherit `runJob`'s scriptName-tagged logging and Slack output. **No new pattern.** Just two existing cron lines fired simultaneously.

### Integration Points

- **`cohort-track.js` (22:00 UTC)** reads both `booli_listing.times_viewed` (`:79-128`) and `hemnet_listingv2` (`:131-183`). After D-17, both writes complete by ~16:35 UTC (Job D dominates) — cohort-track at 22:00 sees fresh data with ~5h margin.
- **`cron_job_log`** receives one row per cron-wrapper run, scriptName-tagged. Plan 09-03's `scripts/verify-cron-job-log.js` (renumbered from 09-02) already proposes checking last-N rows; D-16 + D-17 add no new scripts to its check list.
- **Slack via `SLACK_WEBHOOK_URL`** — both jobs alert on `warning` or `failure`. Parallel-run means two simultaneous alerts on a bad-cycle day. Each is self-identifying.
- **Oxylabs Advanced quota** — paid plan covers all four cron-wrapped scripts (Job A, Job B, Job C, Job D). At conc 8 for Job D and conc 8 for Job A (mostly idle), combined steady-state ≈ 4% of cap. Headroom for Job B's higher per-pair cost ([[job_b_yield_asymmetry]] memory note) and surprise traffic.

</code_context>

<specifics>
## Specific Ideas

- **The "8k pairs" figure is an estimate, not measured.** Chain: 8-week × ~1,000 pairs/week × match-rate-guess of 30%. Realistic range probably 4k–7k. The user explicitly declined a DB-query Task 0 (skipped). The 240-min budget at conc 8 has enough headroom (~85 min margin at 8k, ~165 min margin at 4k) to absorb estimate error in either direction.

- **Empirical rate of 13 details/min at conc 2** comes from `verf09-1-5-logs/wet-run-attempt2-rate-observation.log` (the attempt-2 wet-run killed mid-stream for rate observation). Linear-scaling assumption to conc 8 → ~52/min. If reality at conc 8 is sub-linear (e.g. Oxylabs queueing overhead at higher fan-out), the realistic floor is ~30-40/min → 8k / 35 ≈ 230 min → still fits 240-min budget with thin margin. Conc 16 would be the next step if sub-linear scaling proves real.

- **Job A's "fast Hemnet" assumption is contingent, not structural.** Phase 7-era figures (`~33-51 min`) predate the 8-week alignment and assume Hemnet continues to allow direct curl. There is no architectural reason Hemnet stays fast — Booli was probably also direct-curl-fast before they IP-banned the dev egress. D-16's retrofit + D-18's probe are the insurance.

- **Plan 09-01 hardening lock was diagnostic, not Oxylabs-imposed.** 09-1.5-SUMMARY key-decisions explicitly says "Concurrency bump deferred to Phase 10 if needed." This plan-discussion brings that decision forward into 09-02 because the queue-size + cron-gap math forces it. Documented in D-15.

</specifics>

<deferred>
## Deferred Ideas

- **`[[lib-worker-pool-refactor]] Extract hardened worker-pool pattern into `lib/worker-pool.js`** — already deferred in 09-CONTEXT.md. After 09-02, three scripts (Job A, Job C, Job D) carry near-identical worker-pool code. Refactor candidate for Phase 10.

- **`[[ground-truth-queue-count]] Measure actual cohort_pairs count via DB query** — user explicitly declined as Task 0 for 09-02. Could be run as a one-line diagnostic post-cutover if the actual wall-clock surprises the estimate-based sizing. Operator's choice.

- **`[[daily-cadence]] Daily refresh cadence** — opened as a lever during this discussion, not adopted. Compressed cycle time (~155 min for Job D at conc 8) makes daily feasible without changing Oxylabs spend per pair. User chose to keep every-2-days for now. Revisit after green-week observation if smoother cohort_daily_views time-series is desired.

- **`[[cohort-track-earlier]] Move cohort-track from 22:00 UTC to ~17:00/18:00 UTC** — opened during D-17 discussion, not adopted. The conservative 8h gap to cohort-track remains the safety margin if Oxylabs has a bad day. Revisit if green-week observation shows the margin is unused.

- **`[[conc-16-stretch]] Concurrency 16 for the refresh jobs** — opened during D-15 discussion, not adopted at this stage. Reserve for the case where conc 8 wet-run shows sub-linear scaling and the 240-min budget gets tight. Plan 09-02 Task 3 wet-run is the observation gate.

- **`[[booli-listing-backfill]] Pre-cutover one-shot refresh of stale booli_listing rows** — already deferred in 09-CONTEXT.md. Operator decision at cutover time.

- **`[[downstream-reports-deferred]] Update downstream reports for every-2-days cohort_daily_views** — already deferred in 09-CONTEXT.md. Phase 10 follow-up.

- **`[[hemnet-listingv2-duplicate-handling]] Plan 07's MAX-over-duplicate-rows read in cohort-track** — out of 09-02 scope; tracked in 07-CONTEXT.md.

- **None of the above are blockers for Plan 09-02 itself.**

</deferred>

---

*Phase: 09-production-cutover-self-hosted-scraper-launch*
*Plan: 09-02*
*Context gathered: 2026-05-15*
