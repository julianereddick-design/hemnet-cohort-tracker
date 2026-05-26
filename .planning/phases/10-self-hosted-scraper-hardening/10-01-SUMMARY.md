---
phase: 10-self-hosted-scraper-hardening
plan: 10-01
title: cron-wrapper signal handlers + general unsticker
status: complete
shipped: 2026-05-26
closes:
  - 09-2.6 #1 (cron-wrapper.js missing SIGHUP/SIGTERM/SIGINT handlers)
  - 09-03 #5 (orphan `running` rows in cron_job_log)
re-confirms:
  - id=435 (hemnet-targeted-refresh, Sat 2026-05-23 14:00) was the trigger to make this a Phase 10 priority — observed during the Plan 09-04 green-week observation
---

# Plan 10-01: cron-wrapper signal handlers + general unsticker

## What shipped

### 1. `cron-wrapper.js`: signal handlers + recovery client

Added `SIGHUP`, `SIGTERM`, `SIGINT` handlers alongside the existing
`uncaughtException` + `unhandledRejection` handlers. On signal, the wrapper
now resolves the `cron_job_log` row to `status='killed'` with
`error_message='killed by SIG{X}'` instead of leaving it orphaned in
`status='running'`.

Key implementation details:
- `shuttingDown` re-entry guard prevents double-fire when multiple signals
  arrive (or signal + uncaughtException race).
- The recovery `UPDATE` runs through a *fresh* `pg` Client, not the main
  `client` — because `client` may be mid-query (concurrent queries on one
  node-pg client throw "another query is already in progress"). Cost is one
  extra connect/disconnect (~few hundred ms) per signal; signals are rare.
- `WHERE id = $4 AND status = 'running'` guards against re-resolving rows
  that have already moved to `success`/`warning`/`failure`/`killed`.

### 2. `scripts/unstick-cron-row.js`: general-purpose unsticker

Generalizes the one-off `scripts/unstick-cron-row-418.js`. Supports:
- `--id N` (repeatable) — unstick specific id(s)
- `--all-orphans [--older-than-hours N]` — unstick everything still in
  `running` for more than N hours (default 6)
- `--list` — read-only report of currently-orphaned rows
- `--reason "text"` — supplies the `error_message` (default placeholder
  text references this plan).

Idempotent: `WHERE id = $N AND status = 'running'` clause means re-runs are
safe. Used `EXTRACT(EPOCH FROM ...)` to compute `duration_ms` from
`NOW() - started_at` so the row's duration field reflects the actual
killed-after time, not the moment of unsticking.

### 3. Cleanup of 8 known orphan rows (2026-05-26)

Initial `--list` against the droplet DB showed **8 orphans older than 6h**
(memory only tracked 4):

| id  | script                    | started               | running for |
| --- | ------------------------- | --------------------- | ----------- |
| 342 | booli-targeted-discovery  | 2026-05-12T05:01:44Z  | 336.5h      |
| 343 | booli-targeted-discovery  | 2026-05-12T05:11:50Z  | 336.3h      |
| 354 | booli-targeted-discovery  | 2026-05-14T21:15:35Z  | 272.2h      |
| 359 | booli-targeted-discovery  | 2026-05-15T02:45:16Z  | 266.7h      |
| 363 | hemnet-targeted-match     | 2026-05-15T10:46:19Z  | 258.7h      |
| 406 | booli-targeted-discovery  | 2026-05-18T01:58:16Z  | 195.5h      |
| 407 | booli-targeted-discovery  | 2026-05-18T01:58:24Z  | 195.5h      |
| 435 | hemnet-targeted-refresh   | 2026-05-23T14:00:03Z  | 63.5h       |

All 8 marked `status='killed'` with `error_message="ghost — pre-10-01
process exited without resolving row (no SIGHUP/SIGTERM/SIGINT handlers in
cron-wrapper.js before 10-01)"`. `--list` post-run confirms zero orphans
remaining.

Update memory: STATE carry-forwards 09-2.6 #1 + 09-03 #5 are CLOSED by
this plan.

## What did NOT change

- The Slack alert path (only fires for `failure` or `warning` today) is
  unchanged. `killed` status does NOT fire a Slack alert. Rationale: most
  `killed` events are operator-initiated (Ctrl-C, console disconnect,
  systemctl stop) and don't need to wake anyone up. If we later want
  alerts on unexpected `killed` rows, that's a separate scope improvement
  — add `status === 'killed'` to the Slack condition at
  `cron-wrapper.js:128`.
- Exit code stays `1` for both `handleFatal` (uncaughtException) and
  `handleSignal`. Cron only cares about 0 vs non-zero; the
  `cron_job_log.status` field is the source of truth for monitoring.
- The runbook in `deploy-instructions.md` (## Manual cron launches) still
  recommends tmux/nohup. That's a sound defense-in-depth practice even
  with signal handlers — the handlers minimize fallout when an operator
  forgets, but tmux/nohup avoids the signal entirely.

## Deployment notes

`cron-wrapper.js` is required by all 7 production scripts (cohort-create,
cohort-track, sfpl-region-snapshot, hemnet-targeted-{refresh,match},
booli-targeted-{discovery,refresh}). Once `git pull`-ed to the droplet,
the next fire of each script picks up the new handlers automatically — no
config or schema changes needed.

Per project memory `project_deploy_process`: deploy via `git push` →
ssh droplet → `git pull`, not file paste.

No downtime, no schema migration, no env change. Safe to deploy any time.
