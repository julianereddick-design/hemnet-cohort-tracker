---
phase: 09-production-cutover-self-hosted-scraper-launch
plan: 02
subsystem: infra
tags: [job-d, job-a, booli, hemnet, oxylabs, worker-pool, conc-8, budget-240, parallel-cron]
status: code-complete (4/5 tasks); wet-run gate SKIPPED at operator direction
wave: 2
plan_complete: false
resume_signal: skipped-with-operator-ack

# Dependency graph
requires:
  - phase: 09-production-cutover-self-hosted-scraper-launch
    plan: 01
    provides: hardened booli-targeted-discovery.js worker pool pattern (JOB_BUDGET_MS constant, per-iteration try/catch with err.stack, validate() warning branches for budgetExceeded + workerErrors) — Plan 09-01 source-of-truth replicated into Job D and retrofitted into Job A
  - phase: 09-production-cutover-self-hosted-scraper-launch
    plan: 1.5
    provides: paid Oxylabs Advanced subscription (D-14) + Booli-via-Oxylabs steady-state validated under 3h load (partial-budget-hit close-out) + 8-week cohort window alignment + Booli-Oxylabs probe pattern (scripts/probe-oxylabs-booli.js)
provides:
  - "Job D — booli-targeted-refresh.js (new): pair-only Booli view-count refresh with conc 8 / JOB_BUDGET_MS=240*60*1000 baked in from line 1; full structural mirror of Job A (D-01..D-05); hardened worker pool (try/catch + err.stack + summary.workerErrors + summary.budgetExceeded + validate() branches)"
  - "Job A retrofit — hemnet-targeted-refresh.js: 7 surgical edits applying same hardening + sizing (D-16); symmetric to Job D for the Hemnet-flip-to-Oxylabs contingency"
  - "scripts/probe-booli-refresh.js (new): VERF-09-2 dry-run probe — 5 live cohort booli_ids fetched through Job D's fetcher + parser pipeline; validates parser correctness vs DB without writes"
  - "scripts/probe-oxylabs-hemnet.js (new, D-18): 12-URL Hemnet-via-Oxylabs probe symmetric to scripts/probe-oxylabs-booli.js; validates the contingency path Job A's retrofit is sized for"
  - "Documented parallel-cron grid (D-17, amends D-06): Job D + Job A at `0 14 */2 * *` (parallel, not sequential 14:00/18:00). Plan 09-03 owns the actual deploy-instructions.md crontab edit."
  - "Combined three-job wet-run gate definition (D-19): VERF-09-2 Job D + Job A retrofit + deferred VERF-09-1 Job C in a single session — gate NOT executed in this plan (see resume_signal)"
affects: [09-03-PLAN, 09-04-PLAN, 09-2.5-PLAN, cutover]

# Tech tracking
tech-stack:
  added:
    - "Job D — new every-2-days Booli view refresh script (booli-targeted-refresh.js) — load-bearing new artifact of Phase 9; was missing pre-09-02"
    - "Hemnet-via-Oxylabs validation path (scripts/probe-oxylabs-hemnet.js) — was a theoretical contingency before this plan; now exercised end-to-end (12/12 PASS on 2026-05-15 probe)"
  patterns:
    - "Conc 8 / budget 240 min worker pool — relaxes Plan 09-01's diagnostic conc-2 hardening lock for both refresh jobs (D-15); paid Oxylabs Advanced (D-14) retired the diagnostic need for conc 2"
    - "Parallel-cron pattern (D-17): two cron lines at the same `0 14 */2 * *` schedule on different scripts; each opens its own pg.Client via db.js:5 (no shared connection pool); combined Oxylabs load ~4% of 50/sec cap"
    - "Symmetric retrofit pattern (D-16): inline edits to an existing cron script (Job A) applying the same hardening contract that the sibling new script (Job D) was built with, establishing parity for Phase 10's planned [[lib-worker-pool-refactor]]"

key-files:
  created:
    - booli-targeted-refresh.js                              # Job D — 394 lines, conc 8, budget 240 min
    - scripts/probe-booli-refresh.js                         # VERF-09-2 dry-run probe
    - scripts/probe-oxylabs-hemnet.js                        # D-18 Hemnet-via-Oxylabs probe
    - verf09-2-logs/probe-oxylabs-hemnet.log                 # 12/12 PASS evidence
    - verf09-2-logs/probe-booli-refresh.log                  # 5/5 PASS evidence
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-02-CONTEXT.md
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-02-DISCUSSION-LOG.md
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-02-PLAN.md
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-02-SUMMARY.md
  modified:
    - hemnet-targeted-refresh.js                             # Job A retrofit per D-16 (7 surgical edits)

commits:
  - hash: 3a8e7a8
    title: "docs(09-02): capture plan context — conc 8, budget 240, parallel Job D+A"
  - hash: aa25ef8
    title: "docs(09-02): replan — D-15..D-19 baked in (conc 8, budget 240, Job A retrofit, Hemnet probe, combined wet-run)"
  - hash: b3884e8
    title: "feat(09-02): Job D booli-targeted-refresh.js — conc 8, budget 240 (D-15)"
  - hash: a939767
    title: "feat(09-02): VERF-09-2 dry-run probe scripts/probe-booli-refresh.js"
  - hash: fd8ac88
    title: "refactor(09-02): Job A retrofit — symmetric 09-01 hardening + conc 8 + budget 240 (D-16)"
  - hash: 41a0664
    title: "feat(09-02): scripts/probe-oxylabs-hemnet.js — Hemnet-via-Oxylabs probe (D-18)"
  - hash: eb3975e
    title: "fix(09-02): probe-booli-refresh SQL — SELECT DISTINCT + ORDER BY rule"
---

# Plan 09-02 Summary — Code-complete with wet-run SKIPPED

## What shipped (Tasks 1-4 of 5)

| Task | Status | Commit | Evidence |
|---|---|---|---|
| 1 — Build Job D `booli-targeted-refresh.js` (D-15: conc 8, budget 240) | ✅ | `b3884e8` | `node --check` OK; `--smoke 8 pass`; full structural mirror of Job A swapped to Booli side with hardened worker pool baked in from line 1 |
| 2 — VERF-09-2 dry-run probe `scripts/probe-booli-refresh.js` | ✅ (with `eb3975e` fix) | `a939767` + `eb3975e` | 5/5 PASS on live probe (verf09-2-logs/probe-booli-refresh.log); SQL bug `SELECT DISTINCT + ORDER BY c.week_start, random()` caught by execution and fixed with `DISTINCT ON (cp.booli_id)` subquery |
| 3 — Job A retrofit `hemnet-targeted-refresh.js` (D-16: 7 surgical edits) | ✅ | `fd8ac88` | `node --check` OK; existing 5 smoke tests still pass; line 237 comment now reads `concurrency 8`; line 257 `Promise.all([worker(), worker()])` replaced with `Array.from({length: 8}, () => worker())`; `JOB_BUDGET_MS = 240 * 60 * 1000` constant inserted; per-iteration try/catch added; validate() gains 2 new branches |
| 4 — Hemnet Oxylabs probe `scripts/probe-oxylabs-hemnet.js` (D-18) | ✅ | `41a0664` | 12/12 PASS on live probe (verf09-2-logs/probe-oxylabs-hemnet.log) — 100% Oxylabs fallback rate, 1.5s-11.7s latency range, all returned active. **Confirms the Hemnet-via-Oxylabs contingency path the Job A retrofit was sized for is operational.** |

## What skipped (Task 5)

**Task 5 — Combined three-job wet-run gate (D-19): SKIPPED at operator direction.**

The wet-run gate per D-19 was specified as:
1. Probes (Booli Oxylabs + Hemnet Oxylabs + Booli refresh) — all PASS gate
2. Job D + Job A in parallel (mirrors D-17 production grid) — ~155 min each
3. Job C standalone (deferred VERF-09-1 gate) — ~3h
4. Three evidence log files: `verf09-2-logs/wet-run-{jobd,joba,jobc}.log` each containing `Final:` lines

**What actually happened:**
- Probes 2 + 3 ran during the session and both PASSED:
  - probe-oxylabs-hemnet.js: 12/12 PASS — verifies new D-18 path
  - probe-booli-refresh.js: 5/5 PASS — verifies Job D parser/shape pipeline against 5 live cohort booli_ids
- Probe 1 (probe-oxylabs-booli.js): operator explicitly skipped — empirically validated by Plan 09-1.5's 3h paid-Oxylabs wet-run; running the 12-URL probe would have added no new signal. See memory.project_probe_oxylabs_booli_empirically_validated for the lasting rationale.
- The wet-run itself (Job D + Job A + Job C cron-scale runs) was NOT executed in this session.

**Operator rationale (captured in session):** the wet-run requires ~3h of real Oxylabs traffic per refresh job (Job D + Job A in parallel) plus ~30-60 min for Job C standalone. Operator chose not to spend the evening on it given (a) probes 2 + 3 cover the new code paths, (b) Plan 09-1.5's 3h wet-run already validated Job C's worker-pool pattern at scale against real Oxylabs steady-state, and (c) the natural Tue 2026-05-19 14:00 UTC cron run will be the first real exercise of Job D + Job A at conc 8 — operator accepts the risk of finding bugs there rather than burning 3h tonight.

**Residual risk explicitly acknowledged:**
1. **Job D + Job A worker pool at conc 8 is unexercised at scale.** First-load test is Tue 2026-05-19 14:00 UTC. If `workerErrors > 0` or `budgetExceeded === true` shows up, recovery is Slack-alert → diagnose → patch → next cycle.
2. **No empirical evidence the 240-min budget is sized correctly for the ~8k pair queue at conc 8.** Plan 09-1.5 attempt-2 rate observation was 13 details/min at conc 2; linear scaling assumption gives ~52/min at conc 8 ≈ ~155 min for 8k pairs. If scaling is sub-linear (Oxylabs queueing overhead), budget could be tight. Acceptable — partial-budget-hit returns Final: + EXIT=0, not failure.
3. **Job D's defensive INSERT path (D-04) is untested.** It runs only when the UPDATE matches zero rows, which shouldn't happen given cohort_pairs JOIN constraints. If it ever DOES run, code is the same shape as Job A's INSERT-after-UPDATE-zero pattern from 09-01-PLAN.md — reasonable confidence.

## Bug fixed during execution

**`eb3975e fix(09-02): probe-booli-refresh SQL — SELECT DISTINCT + ORDER BY rule`** — `scripts/probe-booli-refresh.js` initial implementation used `SELECT DISTINCT ... ORDER BY c.week_start DESC, random() LIMIT 5` which Postgres rejects (`for SELECT DISTINCT, ORDER BY expressions must appear in select list`). Fixed via two-stage CTE-style subquery: `SELECT DISTINCT ON (cp.booli_id) ... ORDER BY cp.booli_id, c.week_start DESC` inner, then `ORDER BY random() LIMIT 5` outer. The `node --check` acceptance criterion didn't catch this (parse-time vs runtime SQL error). Caught by first live execution attempt. Single one-line/structural fix; smoke gate unchanged.

## Outcomes beyond original scope

This plan's execution session **also surfaced and shipped commit `618c896`** — a substantial Booli field-capture change (price/rooms/living_area/object_type/agent_id captured by Job C and Job D from Booli's Apollo state). That work was driven by discoveries made WHILE working on Plan 09-02 (Django scraper decommission + Hemnet matching strategy) and is captured as a separate plan **09-2.5** (retroactively formalized — see `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-2.5-{CONTEXT,DISCUSSION-LOG,PLAN}.md`). 09-2.5's Tasks 1-6 are the field capture work; Task 7 (Job B rewrite) is pending pre-Monday.

## What this means for downstream plans

- **Plan 09-03 (Crontab cutover):** D-17's parallel cron grid (`0 14 */2 * *` for both Job D and Job A) is documented but NOT YET written to `deploy-instructions.md`. Plan 09-03 owns that edit. Plan 09-03 should consume D-17 verbatim — no re-litigation needed.
- **Plan 09-04 (Cutover + runbook):** cohort-track threshold halve (10→5 at cohort-track.js:120) is the only code change. Runbook for failure detection is the larger writing task.
- **Plan 09-2.5 (Booli enrichment + matching fix):** Tasks 1-6 already done (commit 618c896). Task 7 (Job B rewrite) pending; deadline Mon 2026-05-18 03:00 UTC. This plan blocks W21's improved match rate but doesn't block Phase 9 closing per se — degraded outcome (slip one week, W22 absorbs) is acceptable.

## Carry-forward for Plan 09-03 / 09-04 / 09-2.5 attention

- **Conc-8 worker pool unexercised at scale** — first real test is Tue 2026-05-19 14:00 UTC cron. Plan 09-04 runbook should include `workerErrors > 0` and `budgetExceeded === true` detection + diagnostic guidance.
- **`lib/worker-pool.js` extraction stays deferred** ([[lib-worker-pool-refactor]] from 09-CONTEXT.md). After 09-02 ships, FOUR scripts carry near-identical worker-pool code (Job A, Job B, Job C, Job D). Phase 10 refactor candidate.
- **Probe-oxylabs-booli.js empirically validated** — captured as memory note `project_probe_oxylabs_booli_empirically_validated.md` so future-Claude doesn't suggest re-running it as a gate.

---

*Phase: 09-production-cutover-self-hosted-scraper-launch*
*Plan: 09-02*
*Summary written: 2026-05-15*
*Plan complete: NO — wet-run gate skipped with operator-ack. resume_signal: skipped-with-operator-ack*
