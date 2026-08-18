# Handover 05 — Monitoring & Alerts

**This is the "it is 3am, what is this message and does it matter?" document.**

Doc `04` describes every *report* the system produces. This one describes every *alert* — what
can land in `#hemnet-ops`, what each one means, what you should do about it, and, most
importantly, **why we monitor each job at all**. If you read only one section, read §3.

All times **UTC**. Droplet repo: `/opt/hemnet-cohort-tracker`. Source of truth for the job
list, tiers and schedule is **`lib/job-registry.js`** — the crontab is *generated* from it
(`node scripts/render-crontab.js | crontab -`). If this document and the registry ever
disagree, the registry wins and this document is the bug.

> **Alerting was rebuilt over six phases and shipped 2026-08-17.** Anything you read about
> monitoring in a document dated before that — including older revisions of `02` and `04` — is
> describing the previous system. Design spec:
> `docs/superpowers/specs/2026-08-17-alerting-structure-design.md`.

---

## 1. Why this was rebuilt (the problem it solves)

Over the 60 days to 2026-08-17 the ops channel received **59 alerts. Three of them mattered,
and all three were missed.** 56 came from a single recurring tier-2 warning
(`spotcheck-reaction-poller`, which warned on 93% of its runs about a review queue nobody was
draining).

That is the failure mode this whole system is designed against. **An alerting channel that
cries wolf is worse than no channel at all**, because it trains the operator to ignore the one
message that mattered. Every design decision below — tiering, suppression, the re-notify
ladder, the storm cap — exists to protect the signal, not to reduce work.

The corollary matters just as much: **a bug in a suppression system is invisible.** If
suppression breaks in the direction of silence, you cannot tell it apart from "everything is
fine" until an incident is missed. So every failure path here is built to **degrade to
alerting, never to silence** — a missing `alert_state` table, an unreachable database, an
unrecognised job name all make the channel *noisier*, which is the correct direction for this
kind of bug to fail.

---

## 2. The alert catalogue — everything you can receive

Six message shapes reach `#hemnet-ops`. Nothing else does. Samples below are copied from real
output, not invented.

| # | Shape | Fired by | Means | Urgency |
|---|---|---|---|---|
| 1 | `🚨 TIER1 @channel [FAILURE] <job>: <error>` | `cron-wrapper.js` | A **tier-1** job ended non-green. Something perishable may already be lost. | Act today |
| 2 | `🚨 TIER1 @channel [WARNING] <job>: <error>` | `cron-wrapper.js` | A tier-1 job completed but its own validator is unhappy with the data. | Act this week |
| 3 | `🚨 TIER1 @channel [KILLED] <job>: killed by <signal>` | `cron-wrapper.js` | The process was killed — OOM, SIGTERM, reboot. Distinct from a crash. | Act today |
| 4 | `🚨 TIER1 @channel [SWEEP] N tier-1 jobs unhealthy` | `cron-health-slack.js --sweep` | Between digests, N tier-1 jobs are missing / orphaned / failing. **One** rolled-up message however many are broken. | Act today |
| 5 | `*Hemnet Monitor — Daily Health Report*` | `cron-health-slack.js` | The 03:00 digest. The complete picture, whether or not anything alerted. | Read daily |
| 6 | `💚 [HEARTBEAT] alerting webhook alive` | `cron-health-slack.js --heartbeat` | Thursday 12:00 proof-of-life. **Its absence is the alert.** | Note if missing |

Plus one non-alert that also lands in `#hemnet-ops`: `[REVIEW] <cohort>: N pair(s)`, the
human spot-check queue (doc `04` §2.7). That is work to do, not a fault.

### Real examples, verbatim

```
:rotating_light: TIER1 <!channel> [FAILURE] cohort-spotcheck-gate: Command failed:
/usr/bin/node /opt/hemnet-cohort-tracker/spotcheck-photos.js
/opt/hemnet-cohort-tracker/verf-spotcheck-2026-W33-20260817-063806 --gallery --all --max 20 --conc 5
```

```
:rotating_light: TIER1 <!channel> [SWEEP] 1 tier-1 job unhealthy
• cohort-spotcheck-gate (Weekly (Mon 06:30)) — failing: failure: Command failed: ...
```

```
:green_heart: [HEARTBEAT] alerting webhook alive — 2026-08-18 00:08 UTC.
If this stops arriving weekly, tier-1 alerts are not being delivered either.
```

**The `🚨 TIER1` prefix and the `@channel` mention are the whole point.** A message without
them is not asking you to do anything right now. A message with them is.

### Why the heartbeat exists

Every other alert in this system is *conditional* — it fires only when something is wrong. That
means a broken webhook, a revoked token or a dead `cron-health-slack` is **indistinguishable
from a healthy week**. The heartbeat is the only unconditional message: it proves the delivery
path itself still works. **If Thursday comes and no heartbeat arrived, assume tier-1 alerts are
not being delivered and check the transport before trusting the silence.**

The heartbeat deliberately uses `postAlert` (the raw webhook), not the bot token, because that
is the same last-line-of-defence path tier-1 failures use. Testing a different path would prove
nothing about the one that matters.

---

## 3. The tier model — what matters, and why

Every job in `lib/job-registry.js` carries an explicit `tier`. There is no default: a job with
no tier is a hard error. The question the tier answers is not "how important is this job?" but:

> **If this run is missed, can the data ever be recovered?**

**Tier 1 — perishable.** The job observes something that only exists at the moment it runs.
Miss it and there is a permanent hole in the record: no re-run tomorrow recovers it. These
interrupt (`🚨 TIER1` + `@channel`), and they are swept for four times a day between digests.

**Tier 2 — recoverable.** The job renders, exports, reports or tidies up. Every one of them can
simply be re-run. **Tier 2 posts nothing to Slack.** It writes its `cron_job_log` row and
appears in the daily digest. This is what silenced 56 of the 59 baseline alerts.

That asymmetry is the single most important idea in this document. A failed chart is an
inconvenience; a missed scrape is a hole in a time series that no amount of later work can fill.

### Tier 1 — the perishable jobs, and exactly what is lost

| Job | Schedule | What is irrecoverably lost if it misses |
|---|---|---|
| `cohort-create` | Mon 06:00 | Builds the week's cohort from **that week's new listings**. A missed week can never exist. |
| `cohort-track` | every 2d 22:00 | View counters are cumulative, so the *level* survives — but the **interval increment** is lost, and incremental view rate is the core product metric. |
| `hemnet-targeted-refresh` | every 2d 14:00 | Writes the view counts `cohort-track` reads 8h later. Miss it and `cohort-track` records nothing. |
| `booli-targeted-refresh` | every 2d 14:00 | Booli half of the same pair. |
| `booli-targeted-discovery` | Sun 22:00 | Discovers the new-listing pool Monday's `cohort-create` draws from. Miss it and Monday's cohort is short. |
| `hemnet-targeted-match` | Mon 03:00 | Matches Hemnet↔Booli three hours before `cohort-create` consumes the result. |
| `market-totals-daily` | daily 08:30 | One site-headline snapshot per day. **Yesterday is unscrapeable** — the site shows today. |
| `premarket-flow-measure` | Mon 08:50 | The weekly pre-market snapshot. This is the job that silently lost the 2026-07-20 datapoint. |
| `premarket-quality-measure` | Mon 09:00 | Samples **live** pre-market listings, which churn. Last week's pool is gone. |
| `cohort-spotcheck-gate` | Mon 06:30 | Re-fetches both listing pages **live**. Delisted pairs are diverted as unreviewable, so that cohort's false-match rate is **never measurable again**. |
| `sold-match-batch` | Mon 07:30 (even ISO weeks) | The sampler uses a sliding 14-day lookback, so a later re-run samples a **different fortnight** — not the missed one. |
| `age-census-monthly` | 1st 02:00 | Monthly census of live pools. A missed month is blank forever. |
| `ad-cost-crawler` | 1st 02:00 (price droplet) | Monthly price grid. Hemnet publishes only current prices; last month's are gone. |

### Tier 2 — everything else

Reporters (`weekly-view-report`, `market-totals-weekly-report`, `premarket-flow-weekly-report`,
`sold-match-report`, `sold-match-trend-chart`, `sold-match-xlsx`, `age-census-report`,
`adcost-report`), retention jobs (`spotcheck-artifact-retention`, `soldmatch-cache-retention`,
`premarket-quality-retention`), the review poller (`spotcheck-reaction-poller`), and the
monitoring jobs themselves (`cron-health-slack`, `cron-health-sweep`, `alerting-heartbeat`).

Each reads data that is already safely in Postgres. If one fails, re-run it — the numbers will
be the same.

### One deliberate blind spot

`cron-health-slack` is **tier 2, including when it is the thing that died.** The watchdog cannot
watch itself, and pretending otherwise would be false comfort. This is an accepted limit
(spec §5), and the Thursday heartbeat is the partial compensation for it.

---

## 4. The daily digest, section by section

03:00 UTC daily, `#hemnet-ops`. **The digest posts every day whether or not anything is
wrong** — it is the backstop that makes suppression safe. Anything suppressed from the live
channel still shows up here.

Read it in this order:

**`📡 Liveness` — did each scheduled job fire at all?**
Derived from the registry, so it covers **every** scheduled job (24 currently), not a hardcoded
handful. Healthy jobs are rolled into a single line that **still names every one of them** — a
roll-up that hid its coverage would be evidence of nothing. Only unhealthy jobs get their own
line. The seven states, in the order they are decided: `pending` (a `notBefore` key) ·
`in-flight` (running, within 2× its expected duration) · `orphan` (running *past* 2× — probably
died without updating its row) · `too-soon` (not yet past its next expected fire plus grace) ·
`ok` · `failed` (ran, ended non-green) · `missing` (no run since its last expected fire —
reported as *silent*). `ok`, `in-flight` and `too-soon` all count as healthy; the latter two are
marked with a trailing `*` in the roll-up.

**`🎯 Assertions` — did the data actually arrive?**
The critical distinction: **exit code 0 is not evidence.** A tier-1 job that exits clean having
written nothing is a silent data loss, and it has happened. Each tier-1 job therefore declares
an assertion against its own *output table* — `cohort-create — 2026-W33 with 1604 pairs`,
`market-totals-daily — 4/4 rows, 4 changed vs prior day`. Assertions are anchored on
`last_expected_fire + grace`, never on a calendar period; the digest runs at 03:00, so "a row
for today" would fail every single day.

**`🔁 Open conditions` — what is suppressed right now.**
Any condition currently being held back by the ladder or the tier gate, with how long it has
been open and how many times it has recurred. **This section is what makes silence readable.**
If a tier-2 job has been unhappy for a fortnight, this is where you find out. Absent when there
is nothing open.

**`🛡️ Tier-1 backstop (last 24h)` — re-stated regardless of delivery.**
Every tier-1 non-green event in the last 24 hours, restated *whether or not an alert was
actually delivered*. If the webhook was down, or suppression misfired, the event still surfaces
here within a day.

**`💾 Disk headroom` — free bytes, free inodes, days to full.**
Floors: **15% or 1GiB free**, whichever binds first, and inodes tracked separately (a disk can
run out of inodes with gigabytes free). `days_to_full` is extrapolated from the `disk_sample`
table, one row per day.

> ⚠️ **Read `days to full` with care.** This droplet's disk load is *bursty*, not linear:
> Monday alone adds ~1G of spot-check JPEGs plus ~1.9G of sold-match cache, then the cache ages
> out. On 2026-08-18, on the old 8.7G volume, the check correctly reported `1.2G free (14%)` —
> genuinely below the floor — but its `days to full: <1` extrapolated one Monday burst as a
> steady rate. Trust the **free-space** number; treat `days_to_full` as a nudge, not a countdown.
>
> The box was resized to a **50 GB** disk later that day (`03` §1), so this check now has a lot
> of slack and should be quiet. **If it fires again, something has genuinely changed** — do not
> assume it is the usual Monday artifacts.

**`📊 View Growth Check` and `🔍 View Data Quality`** — the two cross-cutting product checks
that predate the rebuild: pairs with zero incremental views, and per-cohort null-view rates
with a canary on the newest cohort. Not job health; data health.

---

## 5. Why the channel is quiet — and what quiet does *not* mean

The most dangerous thing about this system is that **it is designed to be quiet**, and a broken
suppression system is also quiet. Four mechanisms hold messages back. Know all four, or you
will misread silence as health.

**1. The tier gate.** Tier 2 never posts. Full stop. (`TIER2_ALERTS_ENABLED = false` in
`lib/alert-policy.js` — one line to flip if you want first-occurrence-only.)

**2. The re-notify ladder — 0h, +24h, +72h, then daily.** A tier-1 condition alerts once when
it appears, again after 24 hours, again after 72, then once a day while it persists. It does
**not** re-alert on every run. The ladder is anchored on the **first** alert, never the previous
one — anchoring on the previous one lets a missed sweep slide the whole schedule right.

*Seen live:* the gate failed Monday 07:43. The sweep saw it still failing at 11:00, 17:00 and
23:00. **Three sightings, one alert** (`alert_count=1, seen_count=3`). The 17:00 and 23:00
sweeps logged `sweep: 1 unhealthy, 0 due to alert` and posted nothing. That is correct
behaviour, not a broken sweep.

**3. The flap debounce (N=2).** A condition is only considered resolved after **two**
consecutive clean runs, so a job oscillating pass/fail/pass/fail does not restart the ladder on
every swing. This is why `evaluateAlert` runs on **success** too — a clean run has to tick open
conditions forward.

**4. The storm cap.** If everything breaks at once, the sweep sends **one** rolled-up message
naming all of them, never one per job. Proven against the live registry: a simulated total
blackout of 11 tier-1 jobs produced a single message.

### Suppression keys on the condition, never on the text

Suppression is keyed on a `conditionKey` that **the job itself declares**, never on the message
text. Message text embeds pair-id lists, live counts and cohort ids, so text-keyed suppression
would treat "379 mismatches" and "380 mismatches" as different problems and alert on both.

Declared so far: `market-totals-daily` → `partial-upsert`; `cohort-track` → `zero-tracked`,
`null-views`. **A validator that declares no key normalises to `key: null`, which alerts every
time.** That is deliberate — nothing regresses into silence by omission; un-keyed conditions
are merely noisier than they need to be.

> **Two known candidates for a key.** `hemnet-targeted-match` warns every Monday
> (`postcode-mismatch 379/3718, 10.2%`) and `premarket-quality-measure` warns every Monday
> (`621/621 ambiguous listings unresolved`). Both are tier 1 and un-keyed, so both alert on
> every run. Declaring a `conditionKey` for each would put them on the ladder instead.

### How to tell suppression from breakage

If the channel is quiet and you want to know whether that is real:

1. **The 03:00 digest posted** → the pipeline is alive. Read `🔁 Open conditions` and
   `🛡️ Tier-1 backstop` to see what is being held back.
2. **The Thursday heartbeat arrived** → the webhook transport is alive.
3. Neither arrived → **do not trust the silence.** Check `cron_job_log` directly:
   `node scripts/verify-cron-job-log.js`.

---

## 6. Things that look broken and are not

New operators reliably try to "fix" these. Do not.

| You see | It means | Do |
|---|---|---|
| `⌛ deployed, first run due 2026-09-02` | A `notBefore` key. The job was wrapped in monitoring *after* its last expected fire, so it has no log row and cannot have one yet. | Nothing. Delete the `notBefore` from the registry once it has run once. |
| A job reported **silent** right after a deploy | Same cause, no key. Daily and weekly jobs self-heal within hours; only monthly ones need `notBefore`. | Wait one cycle. |
| A **`*` after a job name** in the `✅ N ran on schedule` roll-up | That job is currently **in flight** (running, and not yet past 2× its expected duration) or **too soon** (not yet past its next expected fire plus grace). Both are healthy states, folded into the roll-up rather than given their own line. | Nothing. |
| `➖ <job> — skipped: deployed, not yet due` in Assertions | The assertion is deliberately not evaluated, because there is no data to assert on yet. | Nothing. |
| `cron-health-slack`, `cron-health-sweep` and `alerting-heartbeat` listed as three jobs | They are three registry entries sharing one script file (`file:` records the sharing so the `runJob` coverage check can find it). Three schedules, three modes, one implementation — deliberate, because two scripts sharing 90% of their logic is how a check once got fixed in one place and left broken in the other. | Nothing. |
| The sweep logs `0 due to alert` while a job is unhealthy | The ladder is suppressing correctly. | Nothing — confirm in the digest. |
| `cohort-spotcheck-gate` appears **twice** in the digest | Once under Liveness (last run failed) and once under Assertions (no rows written). Redundant, not wrong. | Nothing. |

**Never hand-edit the crontab.** It is generated from `lib/job-registry.js`. Edit the registry,
then `node scripts/render-crontab.js | crontab -`. `--check` detects drift and runs as a digest
assertion. Backups live at `/root/crontab-backup-*.txt`.

---

## 7. The five incidents this design is built from

Each of these is a real, paid-for lesson. They explain why the checks are shaped the way they
are, and they are the best argument against simplifying any of them away.

**1. The 59-alert baseline (60 days to 2026-08-17).** 56 of 59 alerts came from one recurring
tier-2 warning; the 3 that mattered were missed in the noise. → the tier model.

**2. The lost pre-market datapoint (2026-07-20).** `premarket-flow-measure` died on a transient
Oxylabs 613. A weekly observation of a churning pool was lost permanently. → tier 1 means
perishable, and every tier-1 job asserts on its own output.

**3. `exit 0` is not evidence (`cohort-spotcheck-gate`, Jul–Aug 2026).** A truncated image
download never settled, so Node's event loop drained and the process exited **0** with `main()`
still pending. The gate produced nothing for three consecutive weeks while reporting success.
There was no crash, no stack, no non-zero exit — **nothing a status check could have caught.**
→ assertions test the *output table*, never the exit code.

**4. Anchoring on calendar periods (found in build).** An assertion of the form "there is a row
for today" fails every day when the digest runs at 03:00 and the job runs at 08:30. → everything
anchors on `last_expected_fire + grace`.

**5. One undersized box wearing three disguises (2026-08-18).** A `[SWEEP]` alert about the
spot-check gate turned out not to be a gate bug at all. The droplet had **512 MB and no swap**
(~248 MB actually available) and had been OOM-killing jobs **every Monday** since at least the
start of the journal. It presented as three unrelated defects: the gate failing weekly, the
weekly xlsx export "silently losing the three biggest cohorts", and a chronic disk squeeze.
Resolved by resizing to 2 GB / 50 GB (`03` §1 and §8).

Three things from it are worth carrying into any future investigation:

- **A kernel OOM kill leaves no stack.** The job log showed `Command failed:` with *nothing
  before it*. That absence is the signature, not missing plumbing — I initially misread it as
  the gate failing to capture its child's stderr, when it captures stderr fine and the child
  simply never got to write any. **`journalctl | grep "Killed process"` before assuming a code
  bug.**
- **A peak measured under a ceiling is the ceiling, not the requirement.** The export looked
  like a 248 MB job because 248 MB was where it died. Given room, it wanted **550 MB**. Any
  "it just needs a bit more headroom" conclusion drawn from an OOM-truncated measurement is
  unreliable by construction.
- **Catch-and-continue turns a hard failure into a silent one.** `weekly-view-report.js` loops
  cohorts inside a `try/catch` that logs and continues, so the parent exited `success` while
  individual cohorts vanished from the report for weeks. Nothing in the alerting layer can see
  a failure a job has already swallowed — which is exactly why tier-1 **assertions test output
  tables rather than exit status**.

---

## 8. Runbook — what to do with each alert

**`[FAILURE]` / `[KILLED]` on a tier-1 job.** Read `/var/log/hemnet/<job>.log` on the droplet
for the real error — the Slack line is truncated. Decide whether the observation window is
still open: if it is, re-run the job by hand (`tmux` or `nohup … & disown` — a naked console
SIGHUPs and orphans a `running` row). If it has closed, record the gap; do not silently re-run
into a different window. Per-job failure modes: `deploy-instructions.md`.

**`[WARNING]` on a tier-1 job.** The job ran and wrote data, but its validator is unhappy. Not
same-day urgent. If the same warning recurs weekly, that is a signal to declare a
`conditionKey` for it (§5), not to ignore it.

**`[SWEEP] N tier-1 jobs unhealthy`.** N > 1 usually means an infrastructure cause, not N
independent bugs — check disk, database reachability and the Oxylabs cap before investigating
jobs individually.

**No heartbeat on Thursday.** Treat all subsequent silence as unverified. Check
`SLACK_WEBHOOK_URL`, then `node cron-health-slack.js --dry-run`.

**Disk below the floor.** Almost always spot-check image artifacts. `du -sh
/opt/hemnet-cohort-tracker/verf-spotcheck-*`. The retention job keeps the 3 newest cohorts, but
it prunes at 06:20 and the gate writes the new cohort at ~06:38, so **4 cohorts are on disk six
days out of seven** at roughly 1G each. Cohorts whose gate failed with 0 galleries hold no
recoverable value; a cohort with complete galleries can still be re-adjudicated via
`scripts/spotcheck-readjudicate-from-disk.js` and should be kept.

---

## 9. Verifying the machinery itself

Everything here is offline-testable. **125 `--smoke` checks** cover the alerting modules alone
(counts below verified 2026-08-18); they need no database, no network and no Slack.

```bash
node lib/alert-policy.js  --smoke    # tiering, ladder, debounce  (25 checks)
node lib/alert-state.js   --smoke    # suppression store           (14)
node lib/alert-sweep.js   --smoke    # sweep + storm cap           (11)
node lib/job-liveness.js  --smoke    # registry-derived liveness   (22)
node lib/disk-floor.js    --smoke    # df parsing, days_to_full    (15)
node cron-wrapper.js      --smoke    # wrapper + alert decision    (27)
node lib/job-registry.js  --smoke    # registry integrity          (11)
```

Safe live inspection — **none of these post to Slack**:

```bash
node cron-health-slack.js --dry-run             # renders the full digest
node cron-health-slack.js --sweep --dry-run     # renders the sweep decision
node cron-health-slack.js --heartbeat --dry-run # renders the heartbeat
node scripts/render-crontab.js --check          # crontab drift (droplet only)
node migrate-alert-state.js --check             # alert_state + disk_sample present?
node scripts/verify-cron-job-log.js             # last 5 runs per job, straight from the DB
```

**When a job dies without explaining itself**, measure it rather than guessing:

```bash
node scripts/mem-profile.js -- node export-hb-ratio-xlsx.js --cohort 2026-W14
node scripts/mem-profile.js --watch             # sample the whole box during a live run
```

It samples the child's **whole process tree** (a job that shells out hides its real peak
otherwise) plus `MemAvailable`, which is what the OOM killer actually acts on, and reports a
peak, a sparkline and a **plateau-vs-climbing verdict**. That verdict is the point: a job that
plateaus needs more RAM, a job still climbing in its final third retains per-item state and will
outgrow whatever ceiling you buy it. The exit code is the child's, so it is safe to wrap around
anything.

> ⚠️ **The dotenv dry-run gotcha (doc `04` §1).** `dotenv` re-injects `SLACK_BOT_TOKEN`, so
> `env -u SLACK_BOT_TOKEN node <report>.js` does **not** dry-run — it posts. Use each script's
> own `--dry-run` flag and nothing else. This has cost a real accidental post before.

**Storage:** two tables, created by `node migrate-alert-state.js` (idempotent).
`alert_state` — `(scope, script_name, condition_key)` where scope is `run` or `sweep`, plus
`alert_count`, `seen_count`, `consecutive_clear`. Resolved conditions are **deleted**, not
tombstoned. `disk_sample` — one row per day, feeding `days_to_full`.

---

*Written 2026-08-18, from the live system as verified after its first unattended day.
Companion docs: `02` (what each job does), `03` (infrastructure), `04` (reports).*
