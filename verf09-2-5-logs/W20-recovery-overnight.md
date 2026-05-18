# Plan 09-2.6 W20 recovery — overnight monitor outcome

**Monitor window:** 2026-05-18 ~11:25 UTC → 2026-05-18 ~14:35 UTC (9 polls, 20-min cadence)
**Outcome:** **STALLED — STOP without DELETE.** Job 418 never wrote a single hemnet_listingv2 row in 3h 14min. No W20 rebuild was attempted.

---

## TL;DR

The Hemnet match cohort run kicked off by the operator (`cron_job_log.id = 418`, `script_name = 'hemnet-targeted-match'`, `started_at = 2026-05-18 11:21:14 UTC`) crossed the **3-hour stall ceiling** per the loop spec (`started_at > 3h ago AND status = 'running' → STOP no DELETE`). Across all 9 polls:

| Poll | Age | Status | hemnet_listingv2 writes (since 11:00 UTC) | W20 cohort_pairs |
|------|----:|--------|------------------------------------------:|-----------------:|
| #1 | 0.07h | running | 0 | 441 |
| #2 | 0.43h | running | 0 | 441 |
| #3 | 0.78h | running | 0 | 441 |
| #4 | 1.13h | running | 0 | 441 |
| #5 | 1.48h | running | 0 | 441 |
| #6 | 1.83h | running | 0 | 441 |
| #7 | 2.18h | running | 0 | 441 |
| #8 | 2.53h | running | 0 | 441 |
| #9 | 2.88h | running | 0 | 441 |
| #10 (stall) | **3.23h** | **running** | **0** | **441** |

No cohort tables were touched. W20 cohort_pairs is still the **441-pair partial** from Sun 2026-05-17.

---

## What this signal means

Job 418 is hung on the droplet in a way that:

1. **Never advanced past the SELECT / pre-worker phase**, OR
2. **Workers are stuck inside `processOne` on Oxylabs calls that neither succeed nor throw**, OR
3. **Some other deadlock** — DB connection pool, await on an unresolved promise, etc.

Notable: `JOB_BUDGET_MS = 120 * 60 * 1000` should have forced a drain at the 120-min mark. It did not. The budget check is *inside* the worker iteration body (`while (queue.length)`), so if all workers exited early (or never entered) and the orchestrator is awaiting `Promise.all(...)`, the budget never fires. cron-wrapper.js's `SET statement_timeout = '120000'` would have blown the initial SELECT after 120s if it were hung *there* — so the SELECT presumably succeeded and the hang is downstream.

**Most likely cause:** workers stuck on Oxylabs HTTP requests that never resolve and never reject. Conc 8 + Oxylabs Advanced under stress could in principle stall a fetch indefinitely if there's no per-request timeout configured.

---

## Operator next-action checklist

1. **SSH to droplet** and check what the process is actually doing:
   ```bash
   ps aux | grep -v grep | grep "node hemnet-targeted-match"
   # Look at /tmp/hemnet-match-w20-recovery.log (or whatever stdout file the operator routed to)
   # tail -200 will show whether worker iteration log lines are still being emitted
   ```
   If the log shows no new lines for an extended period → workers truly hung. If it shows steady "processed N/M" lines but they're not landing in DB → DB layer issue.

2. **Kill the stuck process** (TERM, then KILL after 30s if needed). Note: per `cron-wrapper.js:79-80` there's no SIGTERM handler, so `cron_job_log.id = 418` will stay on `status='running'` forever. Manually clean it up:
   ```sql
   UPDATE cron_job_log
      SET status = 'killed',
          finished_at = NOW(),
          error_message = 'killed by operator — Plan 09-2.6 W20 recovery monitor stalled (0 writes in 3h 14min)'
    WHERE id = 418;
   ```

3. **Diagnose before re-running.** Don't just re-fire `node hemnet-targeted-match.js` — the 0-writes-for-3h pattern indicates a real bug that conc 8 (or the delta filter, or one of the other 09-2.6 changes) exposed. Suggested probes:
   - Run `node hemnet-targeted-match.js --dry-run --limit 5` from the droplet — does *that* complete and emit cards? If yes, the bug is concurrency-related.
   - If the dry-run also hangs, the bug is in the shared code path (likely `processOne` or the Oxylabs caller).
   - Check whether the Oxylabs caller has a per-request timeout. If not, add one (e.g. `AbortController` with 60s). Phase 10 carry-forward candidate.

4. **W20 stays at 441 pairs.** That's the pre-recovery partial. Decision needed: ship as-is (W22 absorbs the missed inventory) or schedule another recovery attempt once the hang is diagnosed.

5. **Mon 2026-05-25 03:00 UTC** is the next scheduled `hemnet-targeted-match` cron firing. **If the underlying bug isn't fixed by then, it will repeat the same hang on W21.** This is the most time-critical item.

---

## What the monitor did *not* do

- Did **NOT** DELETE any W20 rows from `cohorts` / `cohort_pairs` / `cohort_unmatched` / `cohort_daily_views`.
- Did **NOT** run `cohort-create.js 2026-05-11`.
- Did **NOT** write `09-2.6-SUMMARY.md`.
- Did **NOT** touch `STATE.md`.

Per spec: "STOP, no DELETE" — the stall protects existing W20 partial state.

---

## Files referenced

- `scripts/check-hemnet-match-w20.js` — polling probe used by all 10 wakeups (committable; reusable for future recovery monitors)
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-2.6-PLAN.md` — full plan (tasks 5-6 were the recovery sweep this monitor was guarding)
- `cron_job_log.id = 418` — the stalled row (still on `status='running'` until operator runs the manual UPDATE above)
