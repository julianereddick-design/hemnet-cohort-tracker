# Phase 9 / Plan 09-02 — Discussion Log

**Date:** 2026-05-15
**Plan:** 09-02 (Job D `booli-targeted-refresh` + symmetric Job A retrofit)
**Layered on top of:** 09-CONTEXT.md (phase) + 09-1.5-CONTEXT.md (prior plan)

This log captures the discuss-phase turns that produced `09-02-CONTEXT.md`. For decisions in their canonical form, read CONTEXT. This file is human-reference only — not consumed by downstream agents.

---

## Why this plan was re-discussed

Plan 09-02-PLAN.md was drafted before 09-1.5's wet-run produced an empirical Oxylabs steady-state rate. The plan body locks `JOB_BUDGET_MS = 35 * 60 * 1000` and `Promise.all([worker(), worker()])` (concurrency 2) — both inherited from Plan 09-01's diagnostic conservatism.

`09-1.5-SUMMARY.md` "Carry-forward issues" #2 explicitly flagged the math doesn't work:

> Job D refreshes ~8,000 active cohort pairs every 2 days. At 5 sec/call × concurrency 2 = ~333 min wall-clock — fits NEITHER the 180-min Job C budget nor the 240-min Job D→Job A cron gap (14:00→18:00 UTC). Plan 09-02 discuss-phase should address this BEFORE Job D is built.

This discussion is the response to that carry-forward.

---

## Gray areas presented (multiSelect)

1. **Budget + concurrency sizing** ✓ selected
2. Queue selectivity (refresh-every-run vs stagger) — not selected
3. Wet-run pass bar under partial-completion — not selected
4. Pre-cutover one-shot refresh (`[[booli-listing-backfill]]`) — not selected

User selected only #1, the load-bearing question. Others either inherit defaults from existing plan body, are deferred for post-green-week consideration, or fall under planner discretion.

---

## Discussion turns

### Turn 1 — "What did we learn? Concurrency at 2 was no good?"

User pushed back on framing. Claude clarified:

- Conc 2 **worked** (09-1.5 attempt 1: zero Oxylabs failures, zero workerErrors, zero parseErrors). Not "no good" — just slow.
- The bottleneck is per-call latency (~5s/call via Oxylabs since Booli IP-bans dev egress), not concurrency.
- Conc 2 was held as a **diagnostic safety net** by Plan 09-01 hardening lock, not an Oxylabs-imposed ceiling.
- 09-1.5-SUMMARY: "Concurrency bump deferred to Phase 10 if needed" — door was deliberately left open.

### Turn 2 — User: "I think we can bump the concurrency — look at Oxylabs — they handle up to 50"

Claude walked through real constraints (not just Oxylabs):

| Constraint | At conc 8 | Notes |
|---|---|---|
| Oxylabs Advanced cap (50/sec) | 1% (1.6 req/sec) | Far below cap |
| Booli politeness | OK — Oxylabs rotates IPs | Pattern-level risk low |
| DB layer | One `pg.Client` per script, serial UPDATE queue ≤800ms | Not binding |
| Empirical throughput @ 8k queue | ~155 min wall-clock | Fits 240-min cron gap |

Concurrency 4 doesn't quite fit (~310 min for 8k queue, 14% over budget). **Conc 8 is the smallest jump that fits.** Conc 16 would over-provision.

### Turn 3 — User: "Move to Conc 8. Why are there 8k? Can we discuss the timing of when jobs go again?"

Claude was honest: the 8k figure is back-of-envelope (8 weeks × ~1k pairs/week × ~30% match-rate guess), realistic range likely 4k-7k. The 240-min budget at conc 8 has ~85-165 min margin across that range — sizing is robust to estimate error.

Surfaced timing levers:
1. Cadence (every-2-days vs daily)
2. Gap compression (4h sequential → tighter)
3. Parallel Job D + Job A
4. Slot times (14:00 UTC = mid-afternoon Sweden)
5. Month-boundary drift on `*/2`

### Turn 4 — User: "No need for Job D and Job A to be at different times, right? Different DB tables, different websites — why not concurrently?"

Claude validated the read with a constraint table:

| Shared | Conflict? |
|---|---|
| DB tables | None (booli_listing vs hemnet_listingv2) |
| External service | None (Booli vs Hemnet) |
| pg.Client | None (each script opens own — db.js:5) |
| Oxylabs cap | Combined ~4% of 50/sec cap |
| Slack alerts | Self-identifying via scriptName |

No technical reason against parallel. Surfaced two follow-on questions: (b) move cohort-track earlier? (c) daily cadence?

### Turn 5 — User: "Parallel job, leave time-wise and every 2 days. Why do we think Hemnet is going to be so much quicker than Booli? Have we tested with Oxylabs?"

Claude admitted: the "fast Hemnet" assumption is contingent, not structural.

- The "~33-51 min" figure is **Phase 7-era**, pre 8-week-alignment.
- We have **never** run Job A with `SCRAPE_FORCE_OXYLABS=1`.
- Hemnet currently allows direct curl, but there's no architectural reason it stays that way. Booli was probably also fast before they IP-banned the dev egress.
- Critically: **Job A doesn't yet have the 09-01 worker-pool hardening.** No `JOB_BUDGET_MS`, no per-iteration try/catch + err.stack, no validate branches for budgetExceeded/workerErrors. If Hemnet flips, Job A hangs into SIGKILL.

Four options presented for scope:
- (α) Scope-creep — harden Job A in Plan 09-02 alongside Job D
- (β) Sister plan (09-02a or 09-02.5) for Job A hardening
- (γ) Accept asymmetry, log as carry-forward
- (δ) Probe-only — add `scripts/probe-oxylabs-hemnet.js` without hardening Job A

Claude recommended (α).

### Turn 6 — User: "Agree with (α) — they should operate the same way"

Locked: Job A retrofit ships in Plan 09-02 alongside Job D build. Symmetric posture.

Claude raised three loose ends:
1. Concurrency for Job A — proposed conc 8 to match Job D (today's Hemnet is direct-curl-fast so workers will be ~80% idle; harmless. Tomorrow's contingency if Hemnet flips: pre-staged.)
2. Add `scripts/probe-oxylabs-hemnet.js` (symmetric to Booli's probe) — ~$0.005 to run, insurance against future Hemnet flip.
3. Optional Task 0: measure actual `cohort_pairs` count via DB query.

### Turn 7 — User: "Do first 2, ignore number 3"

Locked. Final decisions captured in 09-02-CONTEXT.md:

- **D-15:** Job D — conc 8, JOB_BUDGET_MS = 240 min
- **D-16:** Job A retrofit — conc 8, JOB_BUDGET_MS = 240 min, full 09-01 hardening pattern
- **D-17:** Parallel cron run at 14:00 UTC odd-days (amends D-06)
- **D-18:** New `scripts/probe-oxylabs-hemnet.js` (12-URL probe, mirrors `scripts/probe-oxylabs-booli.js`)
- **D-19:** Combined wet-run session (Job C VERF-09-1 deferred + Job D VERF-09-2 + Job A retrofit wet-run all in one testing session)

---

## Items raised but not folded into this plan

- Refresh window narrowing (12 → 8 already done by 09-1.5 ebd2a50; further narrow to 6 weeks discussed but not adopted)
- Conc 16 (reserved for the case where conc 8 shows sub-linear scaling)
- Daily cadence (kept every-2-days)
- Cohort-track earlier slot (kept 22:00 UTC)
- DB-query ground-truth count of cohort_pairs (skipped Task 0)
- `lib/worker-pool.js` extraction (stays deferred per `[[lib-worker-pool-refactor]]`)
- Job A `--smoke` block re-test scope (Claude's discretion during execute)

All are captured in CONTEXT.md `<deferred>`.

---

## Items the planner must address

1. **Re-baseline 09-02-PLAN.md frontmatter** — `<must_haves.truths>` and `<assumptions>` blocks currently say "35-min JOB_BUDGET_MS" and "concurrency 2 + 100-300ms jitter." Re-baseline to 240-min budget and concurrency 8.
2. **Re-baseline 09-02-PLAN.md `<interfaces>`** — the `JOB_BUDGET_MS = 35 * 60 * 1000` constant text in Task 1 Step B becomes `JOB_BUDGET_MS = 240 * 60 * 1000`. The `await Promise.all([worker(), worker()]);` line in Task 1 Step H becomes an 8-worker loop.
3. **Add Task: Retrofit `hemnet-targeted-refresh.js` per D-16** — edits per file map in 09-02-CONTEXT.md `<canonical_refs>` "Code under modification" block.
4. **Add Task: Build `scripts/probe-oxylabs-hemnet.js` per D-18** — mirror of `scripts/probe-oxylabs-booli.js` with fetchDetail/hemnet_listingv2 swap.
5. **Update Task 3 (VERF-09-2 wet-run) to include Job A's wet-run** — combined session now validates THREE jobs (C, D, A) per D-19.
6. **Update crontab block in Plan 09-03's scope per D-17** — parallel `0 14 */2 * *` cron lines for Job D and Job A. (Plan 09-03 still owns the crontab change, but the content is dictated here.)
7. **Amend the existing D-06 in `09-CONTEXT.md`** — note that D-17 supersedes D-06's sequential 14/18 grid. Add a pointer note; don't rewrite history.

---

*End of discussion log.*
