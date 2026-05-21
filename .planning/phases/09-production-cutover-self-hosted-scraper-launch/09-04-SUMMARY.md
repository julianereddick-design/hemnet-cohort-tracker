---
phase: 09-production-cutover-self-hosted-scraper-launch
plan: 04
subsystem: cohort-tracking / ops-runbook
tags: [cohort-track, streak-threshold, runbook, green-week, rollback, cutover, d-11]
provides:
  - cohort-track.js drop-streak threshold halved 10 -> 5 (D-11) — compensates for the every-2-days cadence so time-to-drop stays at ~10 calendar days
  - deploy-instructions.md full ## Runbook section (Detect / Diagnose / Re-run for all 7 cron-wrapped scripts)
  - deploy-instructions.md ## Green-week gate and rollback section (4-check GO/NO-GO + Cutover complete path + Rollback path)
  - .planning/.../09-04-GREEN-WEEK.md observation-log stub pre-staged for the Mon 2026-05-25 gate evaluation
affects:
  - 09 (this phase — closes pending the calendar-deferred green-week gate on 2026-05-25)
  - 10 (Phase 10 hardening candidates: cron-wrapper SIGHUP/SIGTERM/SIGINT handlers, scripts/unstick-cron-row.js general-purpose, Booli Oxylabs-fallback threshold re-target, Job B match-rate threshold re-target, agent_id FK fix from 09-2.5 #6)
tech-stack:
  added: []
  patterns:
    - "Operator-launch hygiene: never run a long cron in a naked interactive console; always use tmux or nohup+disown (carry-forward 09-2.6 #1 absorbed into runbook)"
    - "Single-threshold green-week gate vs. prior 4-week median (no parallel-run, no 2-cycle stop-loss — simpler than the pre-rename plan)"
    - "Calendar-deferred checkpoint pattern: pre-stage an observation-log file with gate criteria + empty result fields so a future session can resume verification without re-deriving the gate"
key-files:
  created:
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-GREEN-WEEK.md
    - .planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-SUMMARY.md
  modified:
    - cohort-track.js
    - deploy-instructions.md
key-decisions:
  - "D-11 honored as locked: halve to 5 (not keep 10). Time-to-drop stays at ~10 calendar days under the new every-2-days cadence. Inline D-11 comment on both Booli and Hemnet branches for traceability."
  - "Task 3 deferred per orchestrator instruction — calendar gate (Mon 2026-05-25), cannot complete in-session 2026-05-21. SUMMARY marks Task 3 as 'observation-pending' with full resume criteria captured in 09-04-GREEN-WEEK.md."
  - "Runbook absorbs carry-forwards 09-03 #3 (Booli Oxylabs-fallback warning = expected noise) and 09-2.6 #1 (SIGHUP lesson — use tmux or nohup+disown for manual runs)."
  - "Rollback section uses the actual backup file path /tmp/crontab-backup-1779318677.txt captured 2026-05-20 during the 09-03 deploy (verbatim from 09-03-SUMMARY.md)."
duration: ~4min (in-session code + docs); observation week pending 2026-05-25
completed: 2026-05-21 (Tasks 1+2); Task 3 pending 2026-05-25
---

# Phase 9 Plan 04: Cohort-track streak halve + runbook + green-week gate Summary

**cohort-track drop-streak threshold halved 10 -> 5 per D-11; deploy-instructions.md gained a full ## Runbook + ## Green-week gate and rollback section; the green-week observation log is pre-staged but the gate itself fires on Mon 2026-05-25 and cannot be evaluated in this session.**

## Performance

- **Duration:** ~4 minutes for in-session code+docs (Tasks 1+2). Observation week is calendar-deferred to 2026-05-25.
- **Tasks:** 2/3 in-session complete; Task 3 (green-week checkpoint) deferred to operator on 2026-05-25.
- **Commits:** 3 (Task 1, Task 2, this SUMMARY+GREEN-WEEK stub).
- **Files modified:** 2 (cohort-track.js, deploy-instructions.md). Files created: 2 (09-04-GREEN-WEEK.md, this SUMMARY).

## Task Commits

1. **Task 1: cohort-track.js drop-streak threshold halved 10 -> 5 (Booli + Hemnet branches) per D-11** — `1460857`
2. **Task 2: deploy-instructions.md ## Runbook + ## Green-week gate and rollback** — `198344c`
3. **Task 3: Green-week observation — DEFERRED to 2026-05-25** — SUMMARY + GREEN-WEEK stub commit (this commit)

## Accomplishments

### Task 1 — D-11 streak threshold halve (verbatim diff)

`cohort-track.js` had exactly 2 occurrences of `newStreak >= 10`; both were replaced with `newStreak >= 5` plus a 3-line inline D-11 comment for traceability. Verbatim diff:

```diff
@@ -117,7 +117,10 @@ async function main(client, log) {
         } else {
           // Listing inactive — increment streak
           const newStreak = pair.drop_streak_booli + 1;
-          if (newStreak >= 10) {
+          // D-11: threshold halved from 10 to 5 to compensate for cohort-track
+          // moving from twice-daily to every-2-days (Plan 09-03 / D-07). Time-to-drop
+          // stays at ~10 calendar days (5 runs * ~2 days/run).
+          if (newStreak >= 5) {
             // Threshold reached — mark as dropped
             await client.query(
               'UPDATE cohort_pairs SET dropped_booli_on = $1, drop_streak_booli = 0 WHERE id = $2',
@@ -171,7 +174,10 @@ async function main(client, log) {
         } else {
           // Listing inactive — increment streak
           const newStreak = pair.drop_streak_hemnet + 1;
-          if (newStreak >= 10) {
+          // D-11: threshold halved from 10 to 5 to compensate for cohort-track
+          // moving from twice-daily to every-2-days (Plan 09-03 / D-07). Time-to-drop
+          // stays at ~10 calendar days (5 runs * ~2 days/run).
+          if (newStreak >= 5) {
             // Threshold reached — mark as dropped
             await client.query(
               'UPDATE cohort_pairs SET dropped_hemnet_on = $1, drop_streak_hemnet = 0 WHERE id = $2',
```

Acceptance evidence (all gates green):
- `node --check cohort-track.js` exits 0
- `grep -c "newStreak >= 5" cohort-track.js` = 2
- `grep -c "newStreak >= 10" cohort-track.js` = 0
- `grep -c "drop_streak_booli" cohort-track.js` = 7 (recovery + reset + drop branches preserved; ≥3 required)
- `grep -c "drop_streak_hemnet" cohort-track.js` = 7 (same — recovery + reset + drop preserved)
- `grep -c "D-11" cohort-track.js` = 2 (one inline comment per branch — traceability)

**Recovery branches (cohort-track.js:86-101 Booli, :140-155 Hemnet) and streak-reset branches (cohort-track.js:108-116 Booli, :162-170 Hemnet) were left UNTOUCHED**, per D-11.

**Note on line numbers:** The plan body (drafted earlier) referenced lines 114 and 168; in the current file the `>= 10` lines were at 120 and 174 (pre-edit). The file evolved between PLAN time and EXEC time (notably the per-pair tracking horizon widening at lines 71-79 added ~6 lines above the Booli branch). Edits matched by pattern `newStreak >= 10`, not by line number, so the drift was harmless — both pre-edit occurrences were the intended sites.

### Task 2 — Runbook + green-week + rollback in deploy-instructions.md

The Plan 09-03 stub `## Runbook` / `See ## Runbook section below (added in Plan 09-04).` was replaced with 162 lines of content. Heading inventory (each exactly once):

| Heading                                | Status |
| -------------------------------------- | ------ |
| `## Runbook`                           | 1      |
| `### Detect`                           | 1      |
| `### Diagnose`                         | 1      |
| `### Re-run`                           | 1      |
| `## Green-week gate and rollback`      | 1      |
| `### Green-week GO/NO-GO checklist`    | 1      |
| `### Cutover complete`                 | 1      |
| `### Rollback`                         | 1      |

Content checks:
- `booli-targeted-refresh` referenced 12 times (covers Job D in runbook + green-week + re-run sections — ≥3 required)
- `verify-cron-job-log.js` referenced 3 times (≥1 required)
- `cohort_daily_views` referenced 4 times (≥1 required)
- `D-11` referenced 2 times (the streak-threshold-change traceability note in the Rollback section + intro)
- `compare-writers.js` = 0 references (DROPPED per D-10)
- `cutover-deferred-replan` = 1 reference (only the `-replan` suffix form, no bare `cutover-deferred`)
- Actual backup file path `crontab-backup-1779318677.txt` = 1 reference (rollback)
- `tmux` = 4 references; `SIGHUP` = 1 reference (operator-launch hygiene absorbed from carry-forward 09-2.6 #1)

Job-specific failure modes documented in `### Diagnose`:
- hemnet-targeted-refresh.js (Hemnet view data) — failure / re-run path
- hemnet-targeted-match.js (Hemnet match cohort) — low-match-rate warning marked as currently cosmetic per project memory `project_job_b_match_rate_threshold_stale.md`
- booli-targeted-discovery.js (Booli fetch cohort) — budgetExceeded, workerErrors, EXIT=1 modes
- booli-targeted-refresh.js (Booli view data) — Oxylabs-fallback warning marked as expected noise post-09-1.5 per project memory `project_booli_refresh_oxylabs_fallback_threshold_stale.md`; budgetExceeded; workerErrors (incl. the 09-2.5 #6 FK violation footnote); 0-listings-parsed
- cohort-track.js (Cohort track) — >50% null warning; D-11 streak-threshold note; self-clearance expectation from 09-03 #4
- cohort-create.js, sfpl-region-snapshot.js — pre-Phase-9 (pointer to v1.0 docs)

### Task 3 — Green-week observation (DEFERRED to 2026-05-25)

Task 3 is a `checkpoint:human-verify` gate that fires on a future calendar date (Mon 2026-05-25 06:00 UTC, when cohort-create.js produces W21 and the 4-check GO/NO-GO checklist becomes evaluable). It is impossible to complete this in the 2026-05-21 session — 4+ days in the future.

**Pre-staging done:** `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-GREEN-WEEK.md` created with:
- Observation timeline (every */2 fire 2026-05-21 → 2026-05-25)
- All 4 gate-check sections with command + pass-criteria + empty result fields
- Anomalies table (empty)
- Cohort-track null-Booli warning self-clearance tracker (09-03 #4 carry-forward)
- Outcome section ready for `cutover-complete` / `cutover-deferred-replan` / `partial` resume signal

**Resume mechanism:** When a future session reopens 09-04 on 2026-05-25, the operator (or a fresh agent) reads 09-04-GREEN-WEEK.md, runs the 4 checks, fills the empty fields, and commits the completed log. The decision (GO / NO-GO / partial) is recorded in the Outcome section.

**Pre-gate readiness checks (today, 2026-05-21):**
- ✅ Plan 09-03 crontab deployed (3 `*/2` lines live on droplet per 09-03-SUMMARY.md)
- ✅ Slack webhook firing (`Hemnet Status` channel, verified 2026-05-20 by Task 2 dry-run of Booli view data)
- ✅ cron_job_log accepting rows (last 7 days all 7 scripts present per `verify-cron-job-log.js`)
- ✅ D-11 streak threshold halve shipped TODAY (this plan, Task 1)
- ⏳ First production `*/2` fire pending: 2026-05-21 14:00 UTC (Booli view data + Hemnet view data in parallel per D-17)
- ⏳ Backlogged cohort-track null-Booli warnings expected to self-clear over 2-3 cycles after the first */2 Booli refresh

**Operator next-action timeline:**
1. `git push origin master` — ship 09-04 commits to GitHub (NOT yet done at this commit — operator will push)
2. SSH droplet → `cd /opt/hemnet-cohort-tracker && git pull` — pull both 09-03 + 09-04 onto droplet
3. (Pre-cutover tag suggestion from plan body) `git tag phase-9-pre-cutover && git push --tags` — rollback anchor
4. Watch `Hemnet Status` Slack channel between 2026-05-21 and 2026-05-25
5. Mon 2026-05-25 ~07:00 UTC — run the 4-check GO/NO-GO checklist, fill 09-04-GREEN-WEEK.md, decide

## Files Created/Modified

| File                                                                                        | Type     | Notes                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cohort-track.js`                                                                            | modified | D-11 streak threshold halved 10 -> 5 (Booli + Hemnet branches); inline D-11 comment on both branches                                                |
| `deploy-instructions.md`                                                                     | modified | ## Runbook stub replaced with 162-line full runbook + green-week + rollback section                                                                |
| `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-GREEN-WEEK.md`     | created  | Observation log stub pre-staged with gate criteria + empty result fields; ready for Mon 2026-05-25 fill-in                                          |
| `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-SUMMARY.md`        | created  | This file                                                                                                                                          |

## Decisions & Deviations

### D-11 honored as locked

The user locked option (b) halve to 5 over option (a) keep at 10. No deviation. Time-to-drop stays at ~10 calendar days (5 runs × ~2 days per run) under the new every-2-days cohort-track cadence introduced by Plan 09-03 / D-07.

### Task 3 deferred per orchestrator instruction

The orchestrator's `<plan_constraints>` block explicitly directed deferring Task 3 to the calendar gate on 2026-05-25 rather than blocking the session on a `checkpoint:human-verify`. Rationale:
- The gate fires on Mon 2026-05-25 06:00 UTC (when cohort-create.js produces W21) — 4+ days after this session.
- All 4 gate checks read live cron_job_log + cohort_daily_views state that doesn't exist yet on 2026-05-21.
- Pre-staging the observation log (09-04-GREEN-WEEK.md) gives a resumable state without blocking on a session that cannot succeed today.

This is consistent with the calendar-deferred checkpoint pattern: code+docs ship now, observation completes on the calendar gate, SUMMARY captures resume criteria so a future session can finish the gate without re-deriving it.

### Line-number drift (PLAN body said 114/168; actual lines were 120/174 pre-edit)

The plan body referenced `cohort-track.js:114` and `cohort-track.js:168` as the edit points. Pre-edit grep showed the `>= 10` lines at 120 and 174 respectively — the file had been touched by intermediate plans (notably the 2026-05-15 widening of the per-pair tracking horizon at lines 71-79 added ~6 lines above the Booli branch). Pattern-matched edits sidestepped the drift; both pre-edit occurrences were the intended sites (Booli streak/drop branch + Hemnet streak/drop branch, NOT the recovery or reset branches). No deviation in semantics — Rule 3 fix attempted, no other logic touched.

### compare-writers.js confirmed NOT created

Per D-10, this script was DROPPED from the plan (no parallel-run vs external scraper). Confirmed absent: `grep -c "compare-writers.js" deploy-instructions.md` = 0; no file exists at `scripts/compare-writers.js`.

### Carry-forwards absorbed into the runbook

The plan body did not call out these absorbs explicitly, but they are documented in the runbook for operator continuity:
- **09-03 #3** (Booli Oxylabs-fallback warning = expected noise) → `### Diagnose` section, booli-targeted-refresh.js failure-modes list, marked as **EXPECTED NOISE post-09-1.5**.
- **09-03 #4** (backlogged cohort-track null-Booli warnings) → `### Diagnose` section, cohort-track.js failure modes, with self-clearance expectation tied to the every-2-days Booli refresh.
- **09-2.6 #1** (SIGHUP/SIGTERM/SIGINT gap in cron-wrapper.js) → `### Re-run` section, "**CRITICAL: never launch a long-running cron in a naked interactive console**" + tmux / nohup+disown patterns + unstick-cron-row reference.
- **09-2.5 #6** (agent_id FK violation in Booli view data workers) → `### Diagnose` section, booli-targeted-refresh.js workerErrors mode, noted as "post-09-2.5 a known FK violation ... may fire ~9% of rows ... deploy-time decision still open".
- **09-2.5** project memory `project_job_b_match_rate_threshold_stale.md` → `### Diagnose` section, hemnet-targeted-match.js low-match-rate warning marked as cosmetic.

These absorbs ensure the runbook is operator-ready on 2026-05-25 without requiring the operator to re-derive context from the carry-forward list.

## Carry-forward issues (for Phase 9 close + Phase 10)

1. **(09-04 close, 2026-05-25) Green-week gate evaluation — DEFERRED to operator on 2026-05-25.** 09-04-GREEN-WEEK.md is the source of truth. Resume signal options: `cutover-complete` (all 4 checks pass), `cutover-deferred-replan: <details>` (any check fails → rollback per runbook), `partial: <details>` (judgment call e.g. -6% margin).

2. **(09-04 follow-up) `phase-9-pre-cutover` git tag — operator action.** The plan body suggests tagging `phase-9-pre-cutover` BEFORE the 2026-05-21 14:00 UTC first fire so rollback is one command. NOT done in this session (no `git push` happened either — orchestrator owns push). Operator should `git tag phase-9-pre-cutover -m "Last commit before green-week observation under solo self-hosted writers + halved cohort-track threshold" && git push --tags` before walking away.

3. **(Phase 10) cron-wrapper.js signal handlers** — carry-forward 09-2.6 #1 still open. The runbook describes the operator workaround (tmux / nohup+disown) but does NOT fix the root cause. Phase 10 should add `process.on('SIGHUP'|'SIGTERM'|'SIGINT', handleFatal)` to cron-wrapper.js. Estimated ~5 lines.

4. **(Phase 10) `scripts/unstick-cron-row.js` general-purpose** — the runbook references `scripts/unstick-cron-row-418.js` as a template (one-off from 09-2.6). A general-purpose unsticker would help the operator clean up future SIGHUP-orphaned rows without writing a fresh script each time.

5. **(Phase 10) Booli view-data Oxylabs-fallback threshold re-target** — carry-forward 09-03 #5. The validate() warning `high Oxylabs fallback rate: 100.0%` is permanent noise post-09-1.5. Phase 10 should either remove the threshold or re-target it (warn only if rate suddenly DROPS).

6. **(Phase 10) Hemnet match cohort low-match-rate threshold re-target** — project memory `project_job_b_match_rate_threshold_stale.md`. validate() warns at < 50%; post-09-2.5 healthy range is 40-55%, so the warning is currently cosmetic. Re-target to a real signal or remove.

7. **(Phase 10) 09-2.5 #6 — agent_id FK violation deploy-time decision** — still open. The Booli view data worker pool will silently throw FK violations on ~9% of rows until one of: (a) ALTER TABLE drop FK, (b) drop agent_id from Job C/D writes, (c) two-phase write with booli_agent INSERT first. Until decided, ~9% of Job D rows fail per cycle (caught by per-row try/catch, escalated to validate() warning, but not fixed).

## Known Stubs

`.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-GREEN-WEEK.md` is an INTENTIONAL stub: the file's empty result fields (`Status: _to be filled 2026-05-25_`, checkbox lists, `Raw row: _to be pasted 2026-05-25_`) are the calendar-deferred portion of Task 3. They are NOT a coding stub — they are the data-capture surface for a future operator action. The plan explicitly anticipates this pattern (see plan body Task 3 `<how-to-verify>` "Record any anomalies ... in 09-04-GREEN-WEEK.md" and the `<verification>` line requiring 4 check outputs in this file).

## Self-Check

- ✅ `cohort-track.js` exists with the D-11 edits — verified via grep counts (2× `>= 5`, 0× `>= 10`, 2× `D-11`)
- ✅ `deploy-instructions.md` updated with full runbook — verified via 8/8 heading checks + content acceptance criteria
- ✅ `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-04-GREEN-WEEK.md` exists with gate criteria template (created in this session)
- ✅ Commit `1460857` exists (Task 1: feat(09-04): halve cohort-track drop-streak threshold)
- ✅ Commit `198344c` exists (Task 2: docs(09-04): replace runbook stub)
- ⏳ Task 3 commit (this SUMMARY + GREEN-WEEK stub) is the next commit — captured below in `## Plan Commit` after this file is written

## Self-Check: PASSED

All in-session deliverables present and verified. Task 3 deferred per orchestrator instruction to operator on 2026-05-25; resume criteria fully captured in 09-04-GREEN-WEEK.md.
