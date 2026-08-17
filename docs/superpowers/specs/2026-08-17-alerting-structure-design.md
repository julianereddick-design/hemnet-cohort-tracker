# Alerting structure — design

**Date:** 2026-08-17
**Status:** approved for planning
**Scope:** how every scheduled job in this repo reports failure, and what reaches a human.

---

## 1. Why

Four incidents in 2026, all the same shape: the system did not know it was broken, or said so
where nobody could hear.

| # | Incident | What it proves |
|---|---|---|
| 1 | `cohort-spotcheck-gate` failed 4 consecutive weeks (Jul 27 – Aug 10). `cron-wrapper` alerted **every time**. Unnoticed. | Detection worked; **signal-to-noise** failed. In the same 60 days `spotcheck-reaction-poller` sent **56** warning alerts (93% of its runs) about a standing condition. The gate was 3 messages in a stream of 59. |
| 2 | Five Slack reporters logged `notification sent` on failed deliveries and exited 0. | A job can report success it did not achieve. Nothing watched them — they write no `cron_job_log` row. |
| 3 | `downloadImage` never settled on a truncated response; the worker never returned, the event loop drained, node **exited 0** with `main()` pending, skipping all write-back. | "Exit code 0" is not evidence of work done. Only a check on the *output* catches this. |
| 4 | The daily health report raised 4 standing "issues" that were normal cohort age-decay. | A flat threshold over an ageing population alerts forever. |

Measured baseline: **12 of ~23 scheduled jobs write any `cron_job_log` row at all.** The other
eleven can fail indefinitely in silence.

The lesson ordering matters and drives the phase order in §7: **noise first, visibility second,
structure third.** Widening coverage before killing noise would add eleven more voices to a
channel already proven untrustworthy.

---

## 2. Principles

1. **Tier by perishability.** A failure earns an interrupt only if it destroys data that can
   never be recovered, because the observation window closed. Everything re-runnable waits for
   the daily digest.
2. **Alert on transitions; report standing state.** A queue depth is a gauge, not an event.
   Gauges belong in the digest and interrupt only on crossing a threshold not previously crossed.
3. **Each mechanism reports only what it alone can see.** Event-driven alerting owns "it ran and
   failed". The watchdog owns "it never ran" and "it ran and produced nothing". Neither repeats
   the other.
4. **Monitor outcomes, not mechanisms.** Alert on disk headroom, not on the prune job that
   protects it — that also catches pressure from causes we have not thought of.
5. **One source of truth, or it will drift.** Proven: `premarket-quality-measure` is deployed,
   `runJob`-wrapped and running weekly, and appears **zero** times in `deploy-instructions.md`.

---

## 3. Tier classification

Tier 1 = perishable ⇒ interrupt. Tier 2 = recoverable ⇒ digest only.

### Tier 1

| job | schedule | why perishable | assertion |
|---|---|---|---|
| `cohort-create` | Mon 06:00 | builds the week's cohort from that week's *new* listings; a missed week can never exist | `cohorts` row for current ISO week, `matched > 0` |
| `market-totals-daily` | daily 08:30 | one site-headline snapshot per day; yesterday is unscrapeable | **4** `market_totals` rows (site × segment) for the day, and at least one total differing from the prior day |
| `premarket-flow-measure` | Mon 08:50 | the weekly pre-market snapshot; the 2026-07-20 loss | `premarket_flow_weekly` rows for the week, **both** platforms |
| `premarket-quality-measure` | Mon 09:00 | samples live pre-market listings; they churn | `premarket_quality_weekly` row for the week |
| `age-census-monthly` | 1st 02:00 (~3h) | monthly census of live pools; a missed month is blank forever | 4 pools in `age_census_run` for the month |
| `cohort-track` | every 2d 22:00 | view counters are cumulative so the *level* survives, but the interval increment is lost — and incremental view rate is the core metric | `cohort_daily_views` rows for the expected date, count near active-pair count |
| `hemnet-targeted-refresh` | every 2d 14:00 | writes the view counts `cohort-track` reads 8h later; a missed cycle is not backfillable | `hemnet_listingv2` rows updated within 24h |
| `booli-targeted-refresh` | every 2d 14:00 | same, Booli side | `booli_listing` rows updated within 24h |
| `booli-targeted-discovery` | Sun 22:00 | discovers the new-listing pool Monday's `cohort-create` draws from | new `booli_listing` rows since Sunday |
| `hemnet-targeted-match` | Mon 03:00 | matches Hemnet↔Booli 3h before `cohort-create` | `cohort_pairs` growth on Monday |
| `cohort-spotcheck-gate` | Mon 06:30 | **corrected to tier 1.** Re-fetches both listing pages *live*; delisted pairs are diverted as unreviewable and get no `spotcheck_review` row. Re-running weeks later yields mostly delisted pages, so that cohort's false-match rate is never measurable again | `spotcheck_review` rows created, or an explicit zero-suspects result, for the cohort |
| `sold-match-batch` | Mon 07:30 (even ISO weeks) | **corrected to tier 1.** The sampler uses a sliding 14-day lookback, so a later re-run samples a different fortnight; and the even-week gate blocks catch-up on an odd week without a config edit | parity-aware, **both directions**: on an even week require new `sold_match` rows; across any 3-week span require ≥1 non-skipped run |
| ad-cost crawler | weekly, *other droplet* | weekly price snapshot; prices move. Writes no log row at all — a DB assertion is the only possible monitor | `hemnet_adcostv2` rows for the week |
| *(no job)* free disk | continuous | a real `ENOSPC` destroyed the Jul 27 spot-check run | bytes **and inodes** above floor; report `days_to_full` at current growth |

### Tier 2

`spotcheck-reaction-poller` (reactions persist in Slack); `weekly-view-report`,
`market-totals-weekly-report`, `premarket-flow-weekly-report`, `sold-match-report`,
`age-census-report`, `sold-match-trend-chart`, `sold-match-xlsx` (all pure renders from our own
DB, re-runnable at any time); the three retention/prune jobs (their *outcome* is monitored as
disk headroom instead).

### The tier line

It falls almost exactly on **capture vs. render**. Anything that reaches out and observes the
market is perishable; anything that reads our own DB and draws a picture is not. Two jobs that
look like QA or reporting — the spot-check gate and the sold-match batch — are on the capture
side because they re-observe live pages.

---

## 4. Mechanisms

### 4.1 The registry — `lib/job-registry.js`

Single source of truth, read by `cron-wrapper` and the watchdog. Carries enough to **generate
the crontab**, because a registry that merely describes a hand-maintained crontab is a third
source of truth.

```js
'premarket-flow-measure': {
  tier: 1,
  frequency: 'weekly',
  label: 'Weekly (Mon 08:50)',
  cron: '50 8 * * 1',
  command: 'node scripts/premarket-flow-measure.js',
  env: { SCRAPE_FORCE_OXYLABS: '1' },
  log: '/var/log/hemnet/premarket-flow-measure.log',
  expectedDurationMin: 45,
  assert: 'premarketFlowCurrentWeek',
},
```

`expectedDurationMin` exists so the watchdog can tell "still running" from "orphaned".

**Drift detection.** `scripts/render-crontab.js` emits the crontab from the registry; deploy is
`crontab < rendered`. `--check` diffs the rendered output against `crontab -l` and runs as an
assertion in the daily digest. This is the only mechanism that catches a line hand-added or
deleted on the droplet. Note the asymmetry it fixes: "a job absent from the registry alerts"
only catches a job that *ran and logged* under an unknown name — i.e. the already-visible case.
It cannot catch a crontab line that never runs and never logs, which is the invisible half.

### 4.2 Event-driven — `cron-wrapper`

Owns "it ran and failed".

**Bug to fix first (§7 Phase 0).** `handleFatal` and `handleSignal` call `recoverRow(...)` then
`process.exit(1)`; `postAlert` is only reached on the normal try/catch path. So uncaught
exceptions, unhandled rejections, and SIGHUP/SIGTERM/SIGINT — including OOM kills on the ~3h age
census — write a log row and **alert nobody**. Until this is fixed, "tier 1 interrupts
immediately" is false for exactly the failure modes that kill long-running jobs.

Alerting rules:

- **tier 1**, failure or warning → alert immediately, and **never suppress on repetition alone**.
  Re-notify ladder: now, +24h, +72h, then daily while unresolved. (Rationale: the one perfectly
  stable error signature in the codebase — `market-totals-daily`'s `Expected 4 rows upserted, got
  N` — belongs to a tier-1 daily job. Naive suppression would alert on day 1 and silently eat
  every subsequent permanently-lost snapshot.)
- **tier 2** → log row only, no Slack. Standing state appears in the digest.
- **job not in the registry** → alert, and flag the registry gap.

**Condition identity comes from the job, not from parsing its text.** `validate()` returns
`{ key, severity, message }` — `key: 'stale-reviews' | 'null-views' | 'partial-upsert' | …`.
Suppression keys on `key`, never on the rendered message. Today's four highest-volume validators
all embed volatile content (pair-id lists, live counts, the week's cohort id), so text-based
signatures would suppress almost nothing and would break silently whenever a log line is edited.

**Required defaults, each of which fails dangerously if guessed:**

- No previous row (new job, renamed script, first run after deploy) → **alert**.
- Previous row `status='running'` (orphan) → **alert**; it is not a comparable terminal state.
- Prior-row lookup is `WHERE script_name=$1 AND id < $currentLogId ORDER BY id DESC LIMIT 1`.
  `ORDER BY started_at DESC LIMIT 1` would return the row the wrapper just inserted for *this*
  run.
- **Flap debounce.** A condition is only "cleared" after N=2 consecutive runs without it.
  Without this, a job oscillating across a threshold (`cohort-track` straddles a hard `>50%`
  boundary as a cohort decays, every 2 days) alerts on every run in both directions — doubling
  today's volume rather than reducing it.

### 4.3 Watchdog — `cron-health-slack`

Owns the two things event-driven alerting structurally cannot see. It **never** alerts on "the
last run failed" — that already fired at the moment it happened.

1. **Did it fire?** A terminal row with `status IN ('success','warning')` inside the frequency
   window. *Not* merely "a row exists": incident 3 leaves a row stuck at `running` forever, and
   orphan `running` rows are a known recurring class here (`scripts/unstick-cron-row.js` ships
   with `--all-orphans`). The current code gets this right by accident via
   `runs.some(r => r.status === 'success')` — **do not regress it.**
2. **Orphan sweep.** Rows still in `running` after `expectedDurationMin × 2`, as a first-class
   check. (Two, not a larger multiple: `unstick-cron-row.js` already defaults to a 6h orphan
   threshold, and the longest job — the age census at ~3h — is well inside 2× its budget.)
3. **Did data arrive?** Run the named assertion.

**Assertion timing — the trap this file has already fallen into once.** `cron-health-slack.js`
carries a scar comment about a flat 25h window producing two standing false alarms. Assertions
phrased against calendar periods repeat that mistake at a new layer, because the digest runs at
03:00 UTC:

| naive assertion | job fires | result at 03:00 |
|---|---|---|
| "a `market_totals` row for today" | 08:30 daily | fails **every day** |
| "`premarket_flow_weekly` rows for this week" | Mon 08:50 | fails **every Monday** |
| "4 pools in `age_census_run` for the month" | 1st 02:00, ~3h | fails **on the 1st of every month** |

So: assertions are evaluated relative to **`last_expected_fire + grace`**, never to a calendar
period, and are **skipped entirely** for any job whose current row is `running` inside its
duration budget.

**Cross-cutting checks.** Two existing detectors belong to no single job and must keep an
explicit slot, or a registry-shaped rewrite will drop them as "not registry-shaped":

- **Zero-growth check** — ≥80% of pairs with zero incremental views ⇒ scrapers degraded. The only
  detector for a *successful but degraded* scrape.
- **Newest-cohort null canary** — threshold on the newest cohort only. Its comment records the
  measured decay curve (7% at 14d → 64% at 63d) and why a flat all-cohort threshold was wrong.
  That comment is the fix for incident 4; losing it re-introduces it.

**Hardening.** The watchdog is currently the least-hardened process in the system — a bare
`createClient(); await client.connect();` with no retry and no `statement_timeout`, where
`cron-wrapper` has `connectWithRetry` (3 attempts, backoff) and a 120s timeout. One transient DB
blip means no digest, which is indistinguishable from health. Add both, and wrap the watchdog in
`runJob` so its own death is at least forensically visible.

### 4.4 The sweep

Closes the latency gap: a daily 03:00 watchdog would find a Monday 08:50 miss at 03:00 Tuesday,
by which time the perishable thing is gone.

- Same script, `--sweep` mode — **not** a second script. Two scripts sharing 90% of their logic
  is how the null-view check came to be re-implemented badly in one place after being fixed in
  another.
- Evaluates **per-job expected-fire + grace**, not a flat cadence. A flat 6h sweep is meaningless
  for a monthly job and gives four chances to re-alert about one 22:00 `cohort-track` run.
- Runs at **01:00 / 11:00 / 17:00 / 23:00** — deliberately outside the Monday 03:00–09:00
  capture cluster, where a sweep would read half the pipeline as not-yet-run.
- **Incident-scoped suppression**: one alert per (script, unbroken failure run), with the same
  24h/72h ladder. This is a *different* mechanism from the per-run transition rule and must not
  be conflated with it. Without it, a standing tier-1 failure produces 5 copies a day — the
  56-warning pathology rebuilt out of its own fix.
- **Storm cap**: a DB outage or expired credential fails every tier-1 job at once. The sweep
  emits **one rolled-up message** ("3 tier-1 jobs unhealthy: …"), never one per job.
- **Cheap queries only.** One indexed "last terminal row per script" query. The expensive
  quality queries — the `ROW_NUMBER() OVER (PARTITION BY pair_id)` over 63 days of
  `cohort_daily_views`, and the per-cohort `GROUP BY` at the table max date — stay in the daily
  digest. They run once a day today; 5×/day against a managed Postgres shared with the other
  droplet is a real change.

### 4.5 Delivery into one channel

Tier 1 and the digest share `#hemnet-ops` (operator decision). Mitigations that respect it:

- **`@`-mention only on tier 1.** Slack notifies on mentions, not channels, so this gives the
  two-channel effect inside one channel at no cost. Tier 1 goes out over the *webhook*, so
  confirm mentions render there (`link_names`) before relying on it.
- **Thread the spot-check review queue.** The dominant channel volume is not `cron-wrapper` — it
  is the gate posting **one message per reviewable pair**, potentially dozens every Monday. One
  parent (`[REVIEW] 2026-W34: 18 pairs`) with each pair as a threaded reply removes ~90% of
  channel-level volume. Reactions behave identically on threaded messages and
  `getReactions(channel, ts)` is unchanged. **Verify against the Phase 13.1 `partitionSharedTs`
  guard before shipping** — that guard keys on *shared* `(channel, ts)`, and threaded replies
  each get their own `ts`, so it should stay satisfied, but prove it.
- **Fixed greppable prefixes** (`🚨 TIER1`, `📋 DIGEST`) so a saved Slack search acts as a
  filtered view.

### 4.6 Proof of life

Once tier 2 goes quiet, incidental chatter no longer proves the channel works — and a tier-1
alert whose webhook delivery failed is simply gone (`postAlert` returns `{ok:false}`,
`cron-wrapper` logs `Slack alert failed`, and a warning run still exits 0). The `#hemnet-ops`
webhook has additionally never been proven by a live post outside this design's own testing.

- The **digest re-states every tier-1 failure/warning from the last 24h**, regardless of whether
  an alert was attempted, so it is a genuine backstop rather than a parallel channel.
- A dated **weekly heartbeat** goes out over the *webhook* path specifically, so the last line of
  defence is exercised on a schedule.

---

## 5. Accepted limits

- **The watchdog cannot detect its own death.** No digest is indistinguishable from health.
  Mitigated (wrapped in `runJob`, so it is forensically visible afterwards; digest backstop) but
  not closed. Closing it properly needs an external dead-man's switch, which is out of scope
  here and should be a separate decision.
- **The disk check will fire immediately** against the confirmed-broken spot-check image prune
  (W30 3,113 → W31 7,177 → W32 12,407 JPGs). It needs an owner at the moment it ships, or it
  becomes exactly the standing noise this design exists to escape.

---

## 6. Out of scope

Fixing the spot-check image prune; the ad-cost crawler's transport; re-running the gate to
resurface the 24 cleared vision-MISMATCH pairs. All tracked separately in
`.planning/todos/pending/`.

---

## 7. Phases and acceptance criteria

Ordered by value delivered, not by architecture. Each phase is independently useful and
independently verifiable.

### Phase 0 — make today honest and quiet
No new architecture; fixes what is actively harming the operator now.

- `cron-wrapper`'s `handleFatal` / `handleSignal` alert before exiting.
- Spot-check review queue posts threaded under one parent.
- `@`-mention on tier-1 alerts only.

**Accept when:** a job killed by SIGTERM produces a Slack alert (verified by sending a real
signal to a test job); a gate run posts one parent plus N replies rather than N top-level
messages, and `partitionSharedTs` still adjudicates them correctly; a tier-1 alert notifies and a
digest does not.

#### Verified live 2026-08-17 (merged `a2c6a05`, deployed to the droplet)

Offline: 93 `--smoke` checks green on both dev and the droplet.

- ✅ **SIGTERM produces an alert.** A real `kill -TERM` against a real `runJob` process on the
  droplet logged `Received SIGTERM — marking cron_job_log row killed` then `Slack alert sent`,
  and exited **1** (our handler) rather than 143 (default disposition). Before this change the
  same signal produced no alert at all. The `cron_job_log` row settled at `killed` /
  `killed by SIGTERM` — no orphan left at `running`.
- ✅ **A tier-1 alert notifies.** Delivered to `#hemnet-ops` and rendered as a live `@channel`
  mention (operator-confirmed):
  `🚨 TIER1 @channel [KILLED] alerting-signal-test: killed by SIGTERM (job "alerting-signal-test"
  is not in lib/job-registry.js — add it with an explicit tier)`
  **`<!channel>` is parsed by Slack on the webhook path — `link_names` is NOT required.** This
  closes the open question in §4.5.
- ✅ **The unregistered-job path works** (bonus): the test job was deliberately absent from the
  registry and alerted loudly while naming the gap, rather than defaulting to quiet.
- ✅ **The `#hemnet-ops` webhook is proven** (§4.6 flagged it as never proven). ⚠️ **Note:** the
  *local dev* `.env` carries a DIFFERENT `SLACK_WEBHOOK_URL` welded to a DM with the Claude Code
  app. A local Slack test therefore proves nothing about routing — always probe from the droplet.
- ✅ **A digest does not notify.** The 13:00 daily health report sits in the same channel
  carrying no mention.
- ⏳ **Gate threading is NOT yet verified live** — it needs a full gate run (Oxylabs + vision
  spend), so it rides on the next scheduled Monday fire. Check then that the channel shows one
  `[REVIEW] <cohort>: N pair(s) need review` parent with N threaded replies, and that no
  `spotcheck_review` rows share a `(channel, ts)`.

### Phase 1 — make liveness answerable
Wrap the seven unwrapped scripts in `runJob`: the five reporters, `sold-match-trend-chart`,
`sold-match-xlsx`. They are DB-only and already have argv gates and `result.ok` branches.

**Accept when:** all ~23 scheduled scripts write a `cron_job_log` row; a deliberately failed
reporter post produces a `failure` row.

### Phase 2 — registry and drift
`lib/job-registry.js`, `scripts/render-crontab.js` with `--check`.

**Accept when:** rendered crontab is byte-identical to the droplet's live `crontab -l` after one
reconciliation; `--check` fails when a line is hand-edited; `premarket-quality-measure` is
present (it is the proven live drift).

### Phase 3 — assertions
`lib/job-assertions.js`, evaluated against `last_expected_fire + grace`, skipping in-flight jobs.
Cross-cutting slot retaining the zero-growth check and the newest-cohort canary.

**Accept when:** every tier-1 job has an assertion; a full digest on the 1st of a month with the
age census mid-flight raises **no** issue; a simulated 3-of-4 `market_totals` write is caught.

#### Phases 1-3 verified live 2026-08-17 (`88b0993`, local = origin = droplet)

Offline: 154 `--smoke` checks green on dev and on the droplet.

**Phase 1.** `sold-match-xlsx` run live → `cron_job_log` row `success`, 890ms. Before Phase 1 that
script wrote **no row at all**. Distinct jobs logging in 30d: **12 → 14** and climbing as the
weekly reporters fire on their own schedules. The 3-of-4 partial-write and forced-post-failure
cases are covered by offline assertions rather than by mutating production data.

**Phase 2.** First `--check` reported drift on 14 lines — every `MISSING` paired with an `EXTRA`
differing only in whitespace, i.e. pure formatting, **no unknown job on the box**. Backed up to
`/root/crontab-backup-2026-08-17.txt`, installed the rendered crontab, and `--check` then
reported *in sync*, still **24 job lines**. Proved it can go red: injecting
`0 0 * * * node /opt/rogue.js` produced `EXTRA … /opt/rogue.js` and exit 1; re-rendering restored
in-sync. `premarket-quality-measure` — the proven live drift — is present.

**Phase 3.** The first live digest exposed **two false alarms in my own assertions**, which is
precisely what this phase exists to prevent shipping:
- `cohort-track` counted every active pair ever (11,992) rather than those inside the 56-day
  tracking window (3,749), so a healthy run read as 38%. Fixed — now scoped and anchored on
  `lastFire`.
- `premarket-quality-measure` was red for a job deployed 2026-08-13 that has never run (zero
  `cron_job_log` rows, empty table; first fire Mon 2026-08-17 09:00). Fixed with `notBefore`.

After the fixes the digest reports **1 issue**, and it is a **true finding**:
`cohort-spotcheck-gate` — no `spotcheck_review` rows since the last expected fire, with 3
consecutive weekly failures and last success 2026-07-20. That is incident 1 from §1, correctly
surfaced. It should clear after the first successful gate run under the `8496706` fix.

Both `notBefore` skips render as `heavy_minus_sign … skipped`, not as failures — the acceptance
case for "a job deployed but not yet due raises no issue". The zero-growth check and the
newest-cohort canary both still render, under an explicit CROSS-CUTTING banner.

⚠️ Minor, open: `cohort-track` now displays `4576/3749 (122%)` — it passes a floor check, but the
denominator is narrower than what `cohort-track` actually tracks, so the floor is more lenient
than intended. Cosmetically odd and worth tightening.

### Phase 3.1 — registry-derived liveness (gap closed 2026-08-17, `a3bfc35`)

Phase 3 asserted tier-1 OUTPUT for all 12 tier-1 jobs but left `cron-health-slack.js`'s liveness
section behind a hardcoded `SCRIPTS = ['cohort-track','cohort-create','age-census-monthly']`, so
"it never ran at all" was detected for **3 jobs out of ~22**. `lib/job-liveness.js` now derives
the set from the registry and anchors on `lastExpectedFire + grace`.

Excluded, each for a reason that would otherwise produce a permanent false "never ran": `shell`
retention lines (no node, no row), the `external` ad-cost crawler (another droplet), and
unscheduled/deprecated entries. A row is not enough — the state must be a **terminal success or
warning**; a stale `running` row reports as an orphan, and a failure since the last fire reports
as *failed* rather than "no runs", because it did fire and the event-driven alert already went out.

**Verified live 2026-08-17** by dry-run against the production DB from the droplet. 22 `--smoke`
checks. Two false alarms caught before merge, both the same shape — a job Phase 1 made loggable
*after* its last expected fire, whose next fire is weeks away:
- `age-census-report` (monthly, last fire 2026-08-01, next 2026-09-01) → `notBefore`.
- `adcost-report` (Phase 28, built the same day, first fire 2026-09-01) → `notBefore`.

The five **weekly** reporters wrapped in Phase 1 needed no key: they fire the same day and
self-heal within hours.

### Phase 4 — tiering, ladder, sweep
Tier-gated `cron-wrapper`, `conditionKey` contract, flap debounce, `--sweep` mode.

**Accept when:** a tier-2 warning repeated 5 runs produces exactly **1** alert and a digest line
reading "continuing since X, 5 consecutive"; a tier-1 failure repeated 5 runs produces alerts on
the ladder, never silence; a simulated all-jobs-down produces **one** rolled-up message, not N.

#### Built 2026-08-17 (`fd4bb33`), deployed; 84 new `--smoke` checks

- `lib/alert-policy.js` (23) — pure: no DB, no Slack, no clock, so the ladder and the debounce are
  tested over **simulated days** rather than waited out in production.
- `lib/alert-state.js` (14) — `(scope, script_name, condition_key)`. `scope` keeps cron-wrapper's
  per-run rule and the sweep's incident rule on separate ladders, as §4.4 requires.
- `lib/alert-sweep.js` (11) + `cron-wrapper` integration (11 added, 27 total).

**⚠️ Spec conflict, resolved in favour of §4.2.** The acceptance line above says a repeated tier-2
warning should produce "exactly 1 alert"; §4.2 says "tier 2 → log row only, **no Slack**". Built to
§4.2 — it is the normative mechanism section, and tier-2 standing state is already visible in the
digest's liveness section. It sits behind a single `TIER2_ALERTS_ENABLED = false` constant, so
first-occurrence-only is a one-line change. **Operator decision outstanding.**

**Verified:**
- ✅ **Storm cap, live against the real registry.** A simulated total blackout resolved **11**
  tier-1 jobs unhealthy and rendered **ONE** message. This is the §7 acceptance case.
- ✅ Ladder over 30 simulated daily runs of a standing tier-1 failure: fires on days 0, 1, 3, then
  daily — still reporting on day 30, never silent. `+48h` is correctly *not* a rung.
- ✅ Flap: bad/good/bad/good/bad produces **1** alert, not 3. Two clean runs clear it, and a later
  recurrence opens a **fresh** ladder (`alert_count` back to 1).
- ✅ A broken or absent state store degrades to **alerting**, proven on three paths.
- ✅ `--sweep` live dry-run: `0 unhealthy` while `cohort-spotcheck-gate` was mid-run — correctly
  read as `in-flight`, not as missing.
- ⏳ **The decisive live proof is still pending**: `spotcheck-reaction-poller` (tier 2) is the job
  that produced **56 of the 59** baseline alerts. Its next run is 12:00 daily. It should write a
  `warning` row and post **nothing**.

Two `conditionKey`s declared, both named in §4.2: `market-totals-daily` → `partial-upsert` (the one
perfectly stable signature in the codebase, on a tier-1 daily job), and `cohort-track` →
`zero-tracked` / `null-views` (the >50% boundary it straddles every 2 days). Counts and cohort ids
stay in the **message**, never in the key — a key that varied with the count would make every
occurrence a brand-new incident. Every validator not yet keyed normalises to `key: null` and keeps
exactly today's behaviour.

### Phase 5 — hardening
`connectWithRetry` + `statement_timeout` on the watchdog; digest backstop; weekly webhook
heartbeat; disk floor with inodes and `days_to_full`.

**Accept when:** the watchdog survives a simulated transient DB failure and still posts; the
heartbeat lands via the webhook path; the disk check reports inode headroom.

#### Built 2026-08-17 (`fd4bb33`), deployed; 15 new `--smoke` checks

- **Watchdog hardening.** Both connect sites now use `connectWithRetry` + a 120s
  `statement_timeout`, matching `cron-wrapper`. It was the least-hardened process in the system.
- **Tier-1 backstop.** Re-states every tier-1 failure/warning/kill in the last 24h regardless of
  whether an alert was attempted. It reads `cron_job_log`, which is written *before* any Slack
  call, so it survives exactly the failure that loses the alert. ✅ Live: correctly re-stated
  `hemnet-targeted-match warning — high postcode-mismatch rate: 379/3718 (10.2%)`.
- **Heartbeat.** Weekly Thu 12:00 over `postAlert` — the **webhook** path specifically, since
  nothing else exercises it once tier 2 is quiet. ✅ Renders correctly in dry-run.
- **Disk floor.** Bytes **and** inodes, 15% / 1 GiB. `days_to_full` is reported as context and is
  never itself a breach — a runway alert would fire on any disk that is merely growing.

**§5's warning did not materialise.** The spec expected the disk check to "fire immediately"
against the broken spot-check image prune. Measured on the droplet 2026-08-17:
**3.8G free (44%), inodes 86% free** — comfortably inside both floors, so it ships **quiet** and
does not need an owner on day one. The 2026-08-14 logrotate + cache-retention work is the likely
reason. `days_to_full` reads "not enough history" until `disk_sample` accumulates two days.

⚠️ The broken image prune is still a real defect — it is simply no longer an emergency.

---

## 8. Success measure

The channel is trustworthy when **the count of tier-1 alerts over 60 days is small enough to read
every one**, and every one of them was worth reading. Baseline to beat: 59 alerts in 60 days, of
which 3 mattered and were missed.
