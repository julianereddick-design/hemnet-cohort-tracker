# Phase 19: Sold Match Batch Orchestrator — Pattern Map

**Mapped:** 2026-06-18 (from codebase exploration; gsd-sdk absent → hand-authored)
**New file:** `sold-match-batch.js` (repo root)

## File Classification

| New/Modified File | Role | Closest Analog | Match Quality |
|---|---|---|---|
| `sold-match-batch.js` (NEW) | scheduled orchestrator | `cohort-spotcheck-gate.js` | structural (swap body, keep runJob/validate skeleton) |
| `deploy-instructions.md` (MODIFY) | crontab + runbook | existing `cohort-spotcheck-gate` cron line + runbook section | exact |

---

## Pattern: `runJob` orchestrator skeleton

**Analog:** `cohort-spotcheck-gate.js` + `cron-wrapper.js:57`

`runJob({ scriptName, main, validate })`:
- `main(client, log)` receives a **connected pg client** (120s statement timeout) and `log(level, msg)`;
  returns a `resultSummary` plain object (serialized to JSONB in `cron_job_log.result_summary`).
- `validate(resultSummary)` → return a non-null **string** to force `status='warning'` + that string as
  `error_message`; return `null` to leave `status='success'`. cron-wrapper posts to `SLACK_WEBHOOK_URL`
  only when status ∈ {warning, failure} (cron-wrapper.js:156-161). **No custom Slack sender needed.**
- Signal handlers + uncaught-exception recovery resolve orphan `cron_job_log` rows to `killed`/`failure`.

Skeleton (model on cohort-spotcheck-gate.js:441-455):
```javascript
process.env.SCRAPE_FORCE_OXYLABS = '1';      // FIRST line — load-time guard
process.env.SOLD_MATCH_BRIDGE = '1';         // bridge on for match + recheck
require('dotenv').config();
const { runJob } = require('./cron-wrapper');
const { loadSegments, seedSegment, runSegment, matchOne } = require('./scripts/sold-match-run');
const { setSpendClient, CeilingError, spentCallsAsync } = require('./lib/sold-transport');
const { enrollUnmatched, runRecheck, settleExpired } = require('./lib/sold-recheck');
const { READ_TIME_EXCLUDE_DAYS, SOLD_DATE_WINDOW_DAYS, daysAgoISO } = require('./lib/sold-config');

async function main(client, log) { /* D-03..D-09 */ }
function validate(summary) { /* D-07 */ }

if (require.main === module && process.argv.includes('--smoke')) { runSmoke(); }
else { runJob({ scriptName: 'sold-match-batch', main, validate }); }
```

---

## Pattern: batch-wide spend ceiling (SCHED-02) — the crux

**Analog:** `scripts/sold-match-run.js:main()` (lines ~430-460) + `lib/sold-transport.js:60-65`

One ceiling for the whole batch = call `setSpendClient(client)` ONCE before the segment loop; all segments
share the same `_tally` (DB-atomic `sold_spend` UPDATE … WHERE calls < max). `CeilingError` from any segment
propagates and must stop the batch.

```javascript
setSpendClient(client);                       // D-06: BEFORE any seed/run — batch ceiling
const segments = loadSegments();
const maxSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS);
const minSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS + 30);
const perSegment = {}; let batchStoppedBy = null;
for (const [segKey, seg] of Object.entries(segments)) {
  if (batchStoppedBy) { perSegment[segKey] = { skipped: true }; continue; }
  try {
    const queue = await seedSegment(client, segKey, seg, minSoldDate, maxSoldDate, log /*, limit=null*/);
    const res = await runSegment(client, segKey, seg, queue, minSoldDate, maxSoldDate, conc, log);
    perSegment[segKey] = res.stats; if (res.stopped) batchStoppedBy = res.stopped;
  } catch (e) {
    if (e instanceof CeilingError) { batchStoppedBy = 'ceiling'; }
    else { perSegment[segKey] = { error: e.message }; /* count fetchFailures, continue or stop */ }
  }
}
```
> NOTE: confirm the exact `seedSegment` / `runSegment` signatures by reading `scripts/sold-match-run.js`
> before coding (the explorer reported `runSegment(client, segKey, seg, queue, minSoldDate, maxSoldDate,
> conc, log) → { stats, stopped, spent }` and `seedSegment(client, segKey, seg, minSoldDate, maxSoldDate,
> log, limit)`). The planner's task `read_first` MUST include `scripts/sold-match-run.js`.

---

## Pattern: Phase-18 re-check drain inside the batch (RECHECK-02 cadence)

**Analog:** `lib/sold-recheck.js` exports + its `--smoke` driver.

After the segment loop (and only if not hard-stopped), inject the real clock:
```javascript
const now = new Date();
const enrolled  = await enrollUnmatched(client, { now /*, rows */ });
const recheck   = await runRecheck(client, { now, log, segments, deps: { matchOne } });  // bridge via env
const settled   = await settleExpired(client, { now });
```
`runRecheck` re-runs the SAME `matchOne` for due rows; CeilingError here → treat as batchStoppedBy + escalate.
Read `lib/sold-recheck.js` for exact option keys (the smoke shows the real shape).

---

## Pattern: crontab line + runbook (SCHED-03)

**Analog:** `deploy-instructions.md` crontab block + the `cohort-spotcheck-gate` runbook entry.

```cron
# Phase 19 — Sold match batch (weekly, Mon 07:30 UTC)
30 7 * * 1  cd /opt/hemnet-cohort-tracker && node sold-match-batch.js >> /var/log/hemnet/sold-match-batch.log 2>&1
```
Runbook entry mirrors cohort-spotcheck-gate: Detect (Slack `[WARNING|FAILURE]`, `verify-cron-job-log.js`,
`/var/log/hemnet/sold-match-batch.log`), Diagnose (read `cron_job_log` last 5 rows for `sold-match-batch`,
inspect `result_summary.batchStoppedBy` / `perSegment`), Re-run (`node sold-match-batch.js`; idempotent
upserts per DB-03). Document env vars (D-11). Note the segment-list cost lever (D-12).

---

## Offline smoke (D-10)

**Analog:** `scripts/sold-match-run.js --smoke` (mock client + injected deps) and `lib/sold-recheck.js
--smoke` (mock clock + mock client). Compose both styles: stub `seedSegment`/`runSegment`/`matchOne` and the
re-check helpers via injection, mock pg client, assert loop coverage + ceiling-sharing + validate()
escalation + result_summary shape. Zero Oxylabs, zero live DB. `process.exit(fail === 0 ? 0 : 1)`.

---

## Shared invariants

- `process.env.SCRAPE_FORCE_OXYLABS = '1'` MUST be the first executable line (transport load guard).
- In-process (NOT execFileSync) is mandatory for the shared ceiling — see CONTEXT D-03.
- All SQL goes through the already-parameterized store/recheck helpers — the orchestrator issues no raw SQL.
