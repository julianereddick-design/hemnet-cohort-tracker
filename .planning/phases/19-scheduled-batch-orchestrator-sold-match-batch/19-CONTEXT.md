# Phase 19: Scheduled batch orchestrator (Sold match batch) - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning
**Source:** Live discussion with operator (Julian), 2026-06-18 (v3.1 kickoff)

---

## ⚠ REVISION 2026-06-18 — NATIONAL PANEL SAMPLER (supersedes the segment-loop seeding below)

Operator reframed the sample mid-planning. The **orchestrator skeleton, batch-wide ceiling (D-02/D-03/D-06), fail-safe validate (D-07), Phase-18 re-check drain (D-08), result_summary (D-09), offline smoke (D-10), and docs (D-11/D-12) all still hold**. What changes is the **SEEDING layer** (the old "loop hand-picked segments over a 90-day window" is replaced) and the **window/cadence**. New decisions D-13..D-16 below OVERRIDE D-04 and refine D-11/D-12. Read `19-PANEL-NOTES.md` + `config/sold-panel.json`.

- **D-13 National panel sampler (`lib/sold-sample.js`, NEW).** Reads `config/sold-panel.json` (v1 = 11 municipalities, each with `pop`, `booli_area_id`, `hemnet_location_id`). For each muni × {Hus, Lägenhet} it fetches the Booli `/slutpriser` 14-day feed (`fetchBooliSoldPage`, paginated), excludes deeds (`is_title_transfer` / `soldPriceType ∉ {Slutpris, Sista bud}`), and **de-dupes against `booli_sold.booli_id`** (skip already-seen). It then **allocates a target ~1,000** (config `target_sample_size`) across munis **by population, capped at each muni's live 14-day volume**, and within a muni splits Hus:Lägenhet by the **natural live volume ratio** (NO per-type quota — "no editing per type"). Output: a queue of sampled records, each TAGGED with a synthetic per-record `seg` `{ family: HOUSE|APARTMENT, booli:{areaIds, objectType}, hemnet:{locationId, itemType} }` built from its muni + type, so `matchOne` can search Hemnet for it. The sampler's allocation math is PURE (offline-unit-testable); the fetch is injectable for `--smoke`.
- **D-14 Window + cadence.** Fresh **14-day lookback** (`maxSoldDate = today`, `minSoldDate = today − 14`) — NOT the 90-day settled buffer (D-04 is void). Cadence = **fortnightly**. Cron can't express "every 2 weeks" directly: run the line **weekly** (`30 7 * * 1`, Mon 07:30 UTC) and have the orchestrator **no-op on odd ISO weeks** (act only on even ISO weeks) — log `skipped: true, reason: 'off-week'` and return early. De-dup + 14-day lookback guarantee no overlap across fortnights.
- **D-15 Matching.** For each sampled record, call the existing `matchOne(client, record, seg, ...)` with the record's synthetic `seg` (D-13). `/salda`-primary works because every panel muni has a Hemnet `location_id`; the SERP bridge stays default-on for `booli_only` recovery (set `SOLD_MATCH_BRIDGE=1`, D-05). No matcher edits (Slutpris-only, D-01).
- **D-16 Cheaper re-check lever (default-OFF).** Add a config flag (e.g. `RECHECK_BRIDGE_FINAL_ONLY`, default false) that, when on, makes the Phase-18 re-check skip the SERP bridge on intermediate re-attempts and only run it on the FINAL attempt before settle (cuts ~mid 9k→~6k calls/month). Default OFF preserves current full-fidelity drain. Operator cost lever — document in the runbook; do NOT enable by default.
- **D-17 Ceiling (refines D-12).** Size the batch `MAX_OXY_CALLS` to the cost model in `19-PANEL-NOTES.md` (~3–6k/run) — set a documented default (~8000) high enough to complete a full fortnight but a real hard cap. Per-muni seeding has NO `--limit`; the allocation + ceiling bound cost.

**Coverage note:** the 11-muni v1 is metro/south-heavy (no Norrland). Backfill munis (need Hemnet IDs / both IDs) are listed in `config/sold-panel.json._backfill_pending` — a morning task, NOT a Phase-19 blocker (panel is config; appending is a one-line edit).

---

<domain>
## Phase Boundary

Build a scheduled orchestrator — **"Sold match batch"** — that runs the whole sold-match pipeline on a
cadence on the droplet under the existing `cron-wrapper.runJob` pattern (model: `cohort-spotcheck-gate.js`).
A single batch run drives `scripts/sold-match-run.js` across **every configured segment** over the rolling
sold-date window, runs the **Phase-18 re-check drain pass** inside the same run, enforces ONE Oxylabs spend
ceiling across the whole multi-segment batch, fails safe with Slack escalation rather than silently
completing a partial run, logs to `cron_job_log` with a per-segment result summary, and ships an
installable crontab line + env-var list + operator runbook entry.

**In scope:** SCHED-01, SCHED-02, SCHED-03. Also wires the *cadence* half of RECHECK-02 (the re-check pass
already built in Phase 18 now executes inside this scheduled run).

**Out of scope:** reporting/Slack per-run summary + trend chart (Phase 20, REPORT-01..03); any matcher
behavior change (methodology is frozen — see decisions). The live DDL migration, first Oxylabs wet run, and
installing the crontab on the droplet are operator-gated go-live steps, NOT part of acceptance (consistent
with Phases 15–18 — offline-complete only).
</domain>

<decisions>
## Implementation Decisions (LOCKED)

### Methodology — frozen
- **D-01 Slutpris-only.** No change to title-transfer (Lagfart) handling. The orchestrator inherits the
  runner's existing behavior verbatim (Lagfart excluded from matching; `seedSegment` + `persistVerdictForRecord`
  gates untouched). The metric this batch produces is the match rate of Booli **Slutpris**-sold properties to
  Hemnet. See memory `project_v3_1_scope_slutpris_only`.

### Orchestrator shape
- **D-02 New file `sold-match-batch.js` at repo root** (siblings: `cohort-spotcheck-gate.js`,
  `market-totals-daily.js`). First executable line `process.env.SCRAPE_FORCE_OXYLABS = '1';` then
  `require('dotenv').config();` (load-time guard invariant). Runs under `runJob({ scriptName:
  'sold-match-batch', main, validate })`. cron invokes it directly (`node sold-match-batch.js`); the module
  calls `runJob()` at the bottom; it exports nothing for production (but DOES expose helpers for `--smoke`).
- **D-03 Drive the runner IN-PROCESS via its exports, NOT execFileSync.** Import
  `{ loadSegments, seedSegment, runSegment }` from `./scripts/sold-match-run` and loop segments inside
  `main(client, log)`. This is a deliberate divergence from `cohort-spotcheck-gate.js` (which uses
  `execFileSync` for child scripts): a single Node process is REQUIRED so all segments share ONE
  `setSpendClient(client)` DB-atomic spend tally (SCHED-02 batch-wide ceiling). Per-segment child processes
  would each get their own ceiling.
- **D-04 Rolling window defaults** mirror the runner: `maxSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS)`
  (~90d ago) and `minSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS + SOLD_DATE_WINDOW_DAYS_OR_30)` from
  `lib/sold-config.js`. Operator can override via CLI flags if the planner adds them, but the scheduled line
  uses defaults. **No per-segment `--limit`** — process the full window; the spend ceiling is the cost guard.
- **D-05 Bridge ON.** Set `process.env.SOLD_MATCH_BRIDGE = '1'` in the orchestrator (default-on already, but
  set it explicitly so both the first-pass match AND the re-check's `matchOne` invoke the SERP bridge — the
  flag is read at call time via `bridgeEnabled()`).

### Batch-wide spend ceiling + fail-safe (SCHED-02)
- **D-06 One ceiling for the batch.** Call `setSpendClient(client)` ONCE before the segment loop. The
  `MAX_OXY_CALLS` env governs the whole batch. A `CeilingError` thrown from any segment's `runSegment` (or
  from the re-check pass) STOPS the remaining work — record `batchStoppedBy` and do NOT proceed to later
  segments as if complete.
- **D-07 Fail safe, never silent-partial.** `validate(summary)` returns a non-null Slack string (→
  cron-wrapper posts to `SLACK_WEBHOOK_URL`) when ANY of: the batch stopped on ceiling/ceiling-floor before
  all segments completed; total `fetchFailures` exceed a small threshold; a segment threw a non-ceiling
  fatal error; or not all configured segments ran to completion. Returns `null` only on a clean full run.

### Re-check drain inside the batch (RECHECK-02 cadence)
- **D-08 Run the Phase-18 drain after the segment loop**, in this order: `enrollUnmatched` (stamp
  scheduling state on this run's fresh `booli_only`) → `runRecheck` (re-attempt due, in-window rows via the
  injected real `matchOne`) → `settleExpired` (settle past-window rows to `genuine_non_hemnet`). Inject the
  real clock (`new Date()`). Import these from `./lib/sold-recheck`; pass `deps: { matchOne }` from the
  runner. A `CeilingError` here is handled the same as D-06 (stop + escalate).

### Result summary (cron_job_log)
- **D-09 result_summary** carries: per-segment `{ seeded, adjudicated, matched, booli_only, uncertain,
  error, matchRate, stoppedBy }`; batch totals; the re-check block `{ enrolled, rechecked, lateMatched,
  stillPending, uncertain, settled }`; `oxylabsSpent` (batch, from `spentCallsAsync()`); `batchStoppedBy`;
  `fetchFailures`; `segmentsCompleted` / `segmentsTotal`; and a pre-rendered `slackMsg` for `validate()`.

### Offline smoke (acceptance)
- **D-10 `--smoke`** drives the full orchestrator offline: stubbed seed/search/`matchOne` + mock pg client +
  injected clock, zero Oxylabs, zero live DB. Mirrors the existing `sold-match-run --smoke` and
  `sold-recheck --smoke` injection style. Assert: segment loop drives seed→run for all stub segments; the
  re-check pass (enroll→recheck→settle) is invoked; the batch ceiling is shared (one tally); `validate()`
  escalates on a simulated partial/ceiling stop and stays silent on a clean run; `result_summary` shape.
  `process.exit(fail === 0 ? 0 : 1)`.

### Schedule + docs (SCHED-03)
- **D-11 Cadence = WEEKLY** (operator-confirmable at go-live). Crontab line in `deploy-instructions.md` in
  the existing format, on a Monday UTC slot that does NOT collide with the live Mon crons (cohort-create
  06:00, cohort-spotcheck-gate 06:30, market-totals 08:30, Job B 03:00) — propose **Mon 07:30 UTC**
  (`30 7 * * 1`), logging to `/var/log/hemnet/sold-match-batch.log`. Document required env vars (`DB_*`,
  Oxylabs creds, `SOLD_MATCH_BRIDGE` [default-on], `MAX_OXY_CALLS` batch ceiling, `SLACK_WEBHOOK_URL`) and a
  runbook entry (detect via Slack/`cron_job_log`/log file; diagnose; re-run `node sold-match-batch.js`).
- **D-12 Segments = all in `config/sold-segments.json`.** The batch loops every configured segment;
  curating that list is the operator's cost lever (mention in the runbook). Cadence × segment-count ×
  per-`booli_only` bridge cost (≤4 Oxylabs calls) sizes `MAX_OXY_CALLS`.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Orchestrator + cron pattern (the analog)
- `cohort-spotcheck-gate.js` — closest analog: `runJob({scriptName, main, validate})` orchestrator, arg
  parsing, result_summary, `validate()` Slack escalation, offline guard.
- `cron-wrapper.js` — `runJob({scriptName, main, validate})` contract: provides connected pg client + 120s
  statement timeout + `log(level,msg)`; INSERTs/UPDATEs `cron_job_log`; `validate()` non-null → status
  `warning` → Slack via `SLACK_WEBHOOK_URL`; signal handlers resolve orphans to `killed`.

### Pipeline building blocks to reuse (do NOT reimplement)
- `scripts/sold-match-run.js` — exports `loadSegments`, `seedSegment`, `runSegment`, `matchOne` (+ window
  helpers `daysAgoISO`, `validateDate`, `parseArgs`). `main()` is the manual CLI entry; the orchestrator
  reuses the exported pieces. `SOLD_MATCH_BRIDGE` default-on set in its `main()` (lines ~430-433).
- `lib/sold-recheck.js` — exports `enrollUnmatched`, `runRecheck`, `settleExpired` (clock-injected, lazy
  `matchOne`); offline `--smoke`.
- `lib/sold-transport.js` — `setSpendClient(client)` (batch ceiling switch), `CeilingError`,
  `spentCallsAsync()` / `remainingCallsAsync()`. `lib/sold-spend.js` is the DB-atomic tally underneath.
- `lib/sold-config.js` — `READ_TIME_EXCLUDE_DAYS`, `SOLD_DATE_WINDOW_DAYS`, `RECHECK_WINDOW_DAYS`,
  `RECHECK_INTERVAL_DAYS`, `daysAgoISO`.

### Schedule + runbook home
- `deploy-instructions.md` — crontab registry block + per-job runbook entries (model the new entry on the
  `cohort-spotcheck-gate` one).
</canonical_refs>

<specifics>
## Specific Ideas

- The Phase-19 explorer findings are captured in `19-PATTERNS.md` (analogs + file:line). Planner: read it.
- `cohort-spotcheck-gate.js` uses `execFileSync` for child scripts — do NOT copy that here; in-process is
  mandatory for the shared ceiling (D-03). Keep the `runJob`/`validate` skeleton, swap the body.
</specifics>

<deferred>
## Deferred Ideas

- Per-run Slack summary + committed-HTML trend chart → Phase 20 (REPORT-01..03). The orchestrator's
  `result_summary` should be shaped so Phase 20 can read it without rework, but Phase 20 owns the rendering.
- Per-property Slutpris→Lagfart reclassification tracker (loop #2 / Model A) → separate future build
  (`.planning/todos/pending/loop2-slutpris-lagfart-reclassification-tracker.md`).
- Any Lagfart matcher change → explicitly rejected for v3.1.

---

*Phase: 19-scheduled-batch-orchestrator-sold-match-batch*
*Context gathered: 2026-06-18 via live operator discussion*
