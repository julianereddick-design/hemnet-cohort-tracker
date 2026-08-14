# Slack reporting + ops monitoring — design

**Date:** 2026-08-14
**Scope:** three pieces of work to build now — D, E, F. A fourth, G, is designed here but
**deferred** (§6).
**Status:** APPROVED by the operator 2026-08-14, with G paused. Implementation plan next.

---

## 1. Problem

**D — outputs are split by transport, not by audience.** Every Slack output today is routed by
which credential it happens to use, and the result is backwards:

| Credential | Carries |
|---|---|
| `SLACK_WEBHOOK_URL` (text only) | `cron-wrapper` failure alerts, `cron-health-slack`, `market-totals-weekly-report`, `premarket-flow-weekly-report`, `weekly-view-report`, `age-census-report` |
| `SLACK_BOT_TOKEN` → `SLACK_REVIEW_CHANNEL` (= `C0B9X2WDC4C`, #hemnet-status) | `sold-match-report`, the spot-check per-pair review queue, `spotcheck-reaction-poller` |

So four business reports go to the webhook — which the operator reads in the Claude Code app,
not in #hemnet-status — while the human-review queue sits in #hemnet-status. No health report or
market pulse has appeared in #hemnet-status since 2026-07-06.

**E — the market-totals weekly dashboard has no delivery path.** `build-market-totals-dashboard.js`
(4 charts) and `build-supply-universes-xlsx.js` (7 tabs) exist and work, but nothing ships them
anywhere. Worse, both are **untracked** in the working tree, so they are invisible to any fresh
clone or worktree — the same failure mode as `lib/booli-image-labels.js`, which was missed by six
local review passes because it had never been committed.

**F — the daily health report watches 3 jobs out of ~21.** `cron-health-slack.js` has
`SCRIPTS = ['cohort-track', 'cohort-create', 'age-census-monthly']`. Everything else is covered
only by `cron-wrapper`'s event-driven failure alert, which catches a job that *runs and fails* but
not a job that never fires — exactly the 2026-07-20 pre-market flow incident, where the measure
job died silently and the weekly datapoint was lost.

**G (deferred, §6) — ad-cost reporting cannot tell good data from garbage.** `adcost-report.py` renders whatever
is in `hemnet_adcostv2` with no completeness check. The crawler has in fact been failing silently
since its resume (5 of 6 fires degraded or empty — see
`docs/handover/adcost-crawler-silent-failure.md`), and the report would happily have published
county movers computed from a Stockholm-only sample.

---

## 2. Decisions locked

| # | Decision | Consequence |
|---|---|---|
| 1 | Operator will create an ops channel and invite the bot | D can route by audience |
| 2 | Operator will add `files:write` to the Slack app and reinstall | E can upload files |
| 2b | Operator will create a **new incoming webhook against the ops channel** and replace `SLACK_WEBHOOK_URL` | a webhook is bound to one channel at creation, so `cron-wrapper`'s last-resort alert (§3.2) cannot otherwise reach ops |
| 3 | Charts delivered as **PNG inline**, xlsx as attachment | needs a server-side renderer |
| 4 | Renderer = **`chartjs-node-canvas`** | no headless browser; ~50 MB + cairo/pango apt libs. Chosen over a browser because the cohort droplet hit 100% disk on 2026-07-27 and had 2.0 GB free on 2026-08-13; over QuickChart because that would send data off-box and put a third party in a weekly job's critical path |
| 5 | Reports stay **separate posts**; files go in a **thread under their own post** | no cross-reporter digest coupling; each job stays independently runnable |
| 6 | Crawler fix is **out of scope** — separate workstream | G is the report-side gate only |

---

## 3. D — routing

### 3.1 `lib/slack-post.js`

One module, three functions:

```
postMessage(job, text)              -> { ts, channel }
uploadFiles(job, files, threadTs)   -> void
postAlert(text)                     -> void     // cron-wrapper's own failure path
```

`job` is the caller's job name, not a channel. Routing is resolved inside the module from a single
table, so no reporter names a destination again:

```
business -> SLACK_STATUS_CHANNEL   (#hemnet-status)
  weekly-view-report, market-totals-weekly-report, premarket-flow-weekly-report,
  sold-match-report, age-census-report, adcost-report

ops      -> SLACK_OPS_CHANNEL      (new channel)
  cron-health-slack, cohort-spotcheck-gate (review queue + stale-review escalation),
  spotcheck-reaction-poller, cron-wrapper
```

A job name absent from the table is a **hard error at call time**, not a silent default — a
reporter with no declared audience is a bug.

### 3.2 Transport

Bot token (`chat.postMessage`) everywhere, with one deliberate exception: **`postAlert` keeps the
webhook.** `cron-wrapper`'s failure alert is the last line of defence; if a bot scope or token
breaks, the thing that tells us something broke must not break with it. Belt and braces on exactly
one path, a single mechanism everywhere else.

An incoming webhook is bound to one channel at creation, so for `cron-wrapper`'s alerts to reach
the ops channel — and for the fallback below to land in the right place — the operator must create
a **new webhook pointing at the ops channel** and replace `SLACK_WEBHOOK_URL` with it. Without
that, alerts keep going wherever the current webhook points and the routing table's `ops` entry
for `cron-wrapper` describes an intent the transport does not honour. This is a third one-time
operator action alongside creating the channel and adding `files:write`.

Conversely, if `chat.postMessage` fails in `postMessage`, fall back to the webhook and note the
degradation. A report may be mis-routed but must never be silently lost.

### 3.3 Migration and env

- New: `SLACK_STATUS_CHANNEL`, `SLACK_OPS_CHANNEL`.
- `SLACK_REVIEW_CHANNEL` is retired, but read as a fallback for `SLACK_OPS_CHANNEL` while it is
  unset, so the review queue keeps working regardless of whether code or `.env` lands first.
- `SLACK_BOT_TOKEN` needs `files:write` in addition to `chat:write`; the bot must be a member of
  both channels.
- The ten files that post today move to the helper — `age-census-report.js`,
  `cohort-spotcheck-gate.js`, `cron-health-slack.js`, `cron-wrapper.js`,
  `lib/spotcheck-slack-bot.js`, `market-totals-weekly-report.js`,
  `premarket-flow-weekly-report.js`, `sold-match-report.js`, `spotcheck-reaction-poller.js`,
  `weekly-view-report.js`. `lib/spotcheck-slack-bot.js` keeps its reaction-based review mechanics
  and delegates only the posting.

### 3.4 Dry-run is a requirement, not a nicety

`dotenv.config()` re-injects `SLACK_BOT_TOKEN` and `SLACK_WEBHOOK_URL`, so `env -u VAR node …`
**does not** produce a dry run — it posts. This has already caused a real accidental post. Every
function in the helper must honour a single `--dry-run` flag (or `SLACK_DRY_RUN=1`) that renders to
stdout and performs no network call, and every reporter must accept and forward it.

---

## 4. E — market-totals weekly delivery

### 4.1 Fold the export into the existing reporter

No new crontab entry. `market-totals-weekly-report.js` (Mon 09:35 UTC) gains a second phase:

1. Build and post the pulse text via `postMessage('market-totals-weekly-report', text)`, capturing
   the returned `ts`.
2. Regenerate the artefacts.
3. `uploadFiles(..., ts)` into that thread.

Threading needs the parent's `ts`; having one process own both halves avoids persisting a message
id between two jobs for no reason, and makes it impossible for files to arrive without their pulse.
It also removes the need for the separate `market-totals-weekly-export.js` job sketched in the WIP
handoff.

### 4.2 Artefacts

- **4 PNGs** — For Sale (Till salu) + Booli−Hemnet gap; Kommande / pre-market levels; Hemnet FS
  share (`H FS / B FS %` and `H FS / (B FS + B PM) %`); weekly Mon-over-Mon PoP bars for Hemnet and
  Booli. Rendered by `chartjs-node-canvas` from the same Chart.js configs
  `build-market-totals-dashboard.js` already produces, so config and rendering stay in one place.
- **1 xlsx** — `exports/hemnet-booli-supply-universes.xlsx` from `build-supply-universes-xlsx.js`
  (`exceljs` is already a dependency, so it runs on the droplet unchanged).

All from Universe A (`market_totals`, the site-headline counters). Universe B
(`listing_gap_weekly` / `sfpl_region_daily`) is explicitly not part of this job — the two are not
level-comparable.

### 4.3 Error handling

Text posts first, then artefacts. A render or upload failure must **not** lose the pulse: it warns
to ops and exits non-zero so `cron-wrapper` records a failure, with the text post already
delivered.

### 4.4 Prerequisites

- Commit `build-market-totals-dashboard.js`, `build-supply-universes-xlsx.js` and the WIP handoff
  onto this branch. They are currently untracked and therefore absent from any fresh checkout.
- Deploy adds a one-time `npm i chartjs-node-canvas` plus cairo/pango apt libs on the cohort
  droplet, recorded in `deploy-instructions.md`.
- The HTML dashboard remains a local build target; it is no longer the delivery path.

---

## 5. F — health monitoring in two classes

The ad-cost failure is the argument for the split: a job can exit 0, log `success`, and write
almost nothing. "Did it run?" and "did the data arrive?" are different questions and need
different evidence.

### 5.1 Class 1 — did it fire (`cron_job_log`)

Registry widened from 3 to all 21 scheduled jobs, each a `{ frequency, label }` row against the
existing `WINDOW_HOURS = { daily: 25, every2days: 50, weekly: 192, monthly: 792 }`.

**Already wrapped (13)** — `booli-targeted-discovery`, `booli-targeted-refresh`, `cohort-create`,
`cohort-spotcheck-gate`, `cohort-track`, `hemnet-targeted-match`, `hemnet-targeted-refresh`,
`market-totals-daily`, `scripts/age-census-monthly`, `scripts/premarket-flow-measure`,
`scripts/premarket-quality-measure`, `sold-match-batch`, `spotcheck-reaction-poller`.

**Need `cron-wrapper` added (8 reporters)** — `weekly-view-report`,
`market-totals-weekly-report`, `premarket-flow-weekly-report`, `sold-match-report`,
`sold-match-trend-chart`, `sold-match-xlsx`, `age-census-report`, `cron-health-slack`. They
currently write no log row at all, so "did the Monday report go out?" is unanswerable. A missing
report is not reliably noticed by a human: the 09-03 deploy found the alert channel had been
firing unread since 2026-05-17.

**Fortnightly rule.** `sold-match-batch` fires weekly but no-ops on odd ISO weeks. An odd-week
no-op is health, not silence, and must not raise an issue.

`notBefore` (already implemented for `age-census-monthly`) stays the mechanism for a deployed job
whose first fire is still in the future — a monitor that cries wolf trains the reader to ignore it,
which is the one failure mode a monitor cannot afford.

### 5.2 Class 2 — did the data arrive

Per-table checks, each asserting **both** that a run landed inside the window **and** that it
brought the expected volume:

| Table | Cadence | Expected |
|---|---|---|
| `hemnet_adcostv2` | weekly | ≥400 cells, 10 municipalities, 7 `ad_type` values |
| `market_totals` | daily | a row per platform per day |
| `premarket_flow_weekly` | weekly | a row per platform |
| `sold_match` | fortnightly | new rows for the cohort window |
| age-census tables | monthly | 4 pools persisted |

Two reasons this class exists rather than being folded into Class 1:

1. **It is the only thing that can see cross-box jobs.** The ad-cost crawler runs under
   celery-beat on the price droplet and writes no `cron_job_log` row, so Class 1 is structurally
   blind to it. Class 2 would have fired on 2026-08-03.
2. **A zero-row run leaves no bucket.** Any freshness query that groups by a crawl date cannot see
   a run that wrote nothing — which is what happened on 2026-07-05, 07-19 and 07-26. Hence
   "a run landed in the window" must be asserted independently of volume.

### 5.3 Also fixed here

The stale-cohort null-view false alarms recorded in the 2026-08-13 pending todo.

---

## 6. G — ad-cost gate and weekly post (report side) — **DEFERRED**

> **Paused by the operator, 2026-08-14:** fix the underlying crawler before designing what it
> outputs. Building a report gate on top of a feed that is known-broken means specifying the
> shape of data we have not yet seen arrive correctly — the 420-cell target, the municipality
> list and the tier breakdown should all be re-read from a *working* crawler before they are
> hard-coded into a gate. The section below is retained as the starting point for that later
> workstream; nothing in it is built now.
>
> Note what does NOT pause: **F Class 2 keeps its `hemnet_adcostv2` data-arrival check** (§5.2).
> That is detection, not output — it answers "did the feed deliver?", which is precisely the
> question the crawler workstream needs answered week to week, and it is the one monitor that
> can see a job running on the other droplet. Expect it to report degraded until the crawler is
> fixed; that is the monitor working, not noise.

### 6.1 Completeness gate, before anything renders

`adcost-report.py` compares the latest snapshot against **420 cells = 10 municipalities × 7
product codes × 6 price points**, then branches:

- **Shortfall** → post a degraded-data warning to **ops**, naming the missing municipalities and
  the cell count. Publish **no** county movers and no ARPL headline. Movers computed from a
  Stockholm-only sample are worse than no post, because they look authoritative.
- **Clean** → post to **business**: blended ARPL inc-moms with WoW and change vs the end-2025
  anchor (2025-12-28), the top three county × tier movers, and the heat map + xlsx threaded
  underneath.

Expect the gate to report degraded every week until the crawler is fixed. That is the gate
working. It is also why it is worth building before the fix rather than after.

### 6.2 Boundaries

The task-side completeness gate, per-cell retry, and the `ScrapeError`/`log_failure` defects all
belong to the crawler workstream (`docs/handover/adcost-crawler-silent-failure.md`), not here.
Reporting decisions already locked in Phase 28 are unchanged: 8 counties, gross inc-moms
(net × 1.25), muni detail preserved in the Excel.

---

## 7. Rollout order

1. **D** — helper + routing table + dry-run, all 14 call sites migrated. Nothing else can be
   tested cleanly until posting is one mechanism.
2. **F Class 1** — registry widened, `cron-wrapper` added to the 8 reporters.
3. **F Class 2** — data-arrival checks, `hemnet_adcostv2` first since it is the known-broken feed.
4. **E** — builders committed, renderer added, export folded into the Monday reporter.

D and F Class 1 are the ones that reduce risk immediately; E is additive. G is deferred (§6),
so this workstream ends at E.

---

## 8. Testing

- Every reporter runs offline under `--dry-run` and renders to stdout with no network call. This is
  the primary gate, given the dotenv trap in §3.4.
- A smoke test asserts every job that posts appears in the routing table, and that the table names
  only jobs that exist. This is what stops a future reporter defaulting silently to the wrong
  audience.
- F Class 2 thresholds are checked against known-bad history: the 2026-08-02 and 08-09 ad-cost runs
  must fail the gate, and 2026-07-12 must pass it.
- PNG rendering is asserted on shape only — 4 files, non-zero size, expected dimensions. No
  pixel comparison.
- No paid Oxylabs or Steel call is made by any test.

---

## 9. Out of scope

- The ad-cost crawler fix (separate workstream and repo).
- The ad-cost **report** gate and weekly post — deferred with it, see §6. F Class 2's ad-cost
  data-arrival check is retained and is the only ad-cost work in this plan.
- Universe B reporting (`listing_gap_weekly`, `sfpl_region_daily`).
- The interactive HTML dashboard as a delivery mechanism; it stays a local build target.
- Any change to what the existing reports *say* — this work changes where outputs go, whether they
  are trustworthy, and whether we notice when they stop. Report content changes only where §6.1
  requires suppression.
