# Ad-cost crawler — silent failure since the Phase 27 resume

**Status:** OPEN. Diagnosed 2026-08-14 by read-only inspection. **Nothing has been changed** —
no code, config, container restart, migration or DB write, and no paid Steel/Oxylabs call.

**Purpose of this document:** a self-contained brief for a separate workstream to fix the
crawler. It assumes no knowledge of the session that produced it. The reporting half of this
milestone (Slack post + completeness gate in `adcost-report.py`) is being handled separately in
the `hemnet-cohort-tracker` repo and is **not** in scope here.

---

## 1. Summary

The weekly Hemnet ad-package-price scrape has **never worked reliably since it was resumed** on
2026-07-01. Five of its six scheduled fires produced degraded or empty data, and **all but one
of those reported success**. Downstream reporting cannot tell a 35-row week from a 420-row week.

Cloudflare begins refusing the in-page `POST /graphql` a few requests into a browser session and
the refusal **latches** for the remainder of that session. Both exception handlers in the crawler's
grid loop `continue` per cell, so the task walks every cell, writes whatever it managed to collect,
and exits 0.

**Untouched, the next fire (Sun 2026-08-16 20:00 UTC) will fail the same way and report success.**

---

## 2. The record

`AdCostV2` expects **420 cells per run** = 60 grid cells (10 municipalities × 6 price points)
× 7 offer slugs.

| Fire (UTC) | Cells written | Municipalities | Reported as |
|---|--:|--:|---|
| 2026-07-01 05:23 | 378 | 10 | out-of-band manual re-run — see §6.4 |
| 2026-07-05 20:00 | **0** | 0 | `succeeded` |
| 2026-07-12 20:00 | **420** | 10 | `succeeded` — the only clean run |
| 2026-07-19 20:00 | **0** | 0 | failed `rc=4`, but never recorded — see §4.2 |
| 2026-07-26 20:00 | **0** | 0 | `succeeded` |
| 2026-08-02 20:00 | **6** | 1 (Stockholms) | `succeeded` |
| 2026-08-09 20:00 | **5** | 1 (Stockholms) | `succeeded` |

Read this as a crawler that has never been reliable, not as a recent two-week break. Jul 12 is
the outlier that flattered it.

The 10 expected municipalities: Göteborgs, Krokoms, Lunds, Malmö, Sandvikens, Stockholms,
Uppsala, Vadstena, Varbergs, Ydre.

---

## 3. Root cause

**Confidence: ~95% on the loss mechanism; ~80% on the specific refusal being a Cloudflare
challenge/rate-limit that latches mid-session.** The residual uncertainty is entirely because the
evidence was deliberately discarded — see §4.1.

### 3.1 The loop cannot abort; it can only silently skip

`apps/hemnet/adcost_steel.py`, the one and only grid loop, contains no `break`:

```python
227:            for cell in grid:
232:                    print(f"autocomplete failed {full_name}: {e}", file=sys.stderr)
233:                    continue
242:                    print(f"price fetch failed {full_name}@{price}: {e}", file=sys.stderr)
243:                    continue
```

Per-cell exception isolation already exists and is **not** the problem. What is missing is
everything around it: retry, session re-clear, abort, and a completeness gate.

### 3.2 The loop ran to the end — proven by the clock

Steel session records cross-referenced against celery timestamps:

| Date | Final Steel session | Duration | Subprocess exit | Cells |
|---|---|--:|---|--:|
| Jul 12 | `20:00:08.840Z` | 113.7 s | `20:02:02` rows=420 | 60/60 |
| Aug 2 | `20:03:00.786Z` | 69.0 s | `20:04:07` rows=42 | 6/60 |
| Aug 9 | `20:03:35.425Z` | 45.8 s | `20:04:20` rows=35 | 5/60 |

Aug 2's session was created at 20:03:00.8 and the subprocess did not exit until 20:04:07.7 —
**66.9 s of work for 6 successful cells.** Calibrating from Jul 12 (~100 s for 60 cells ≈ 1.7 s/cell),
those 6 cells cost ~10 s; the remaining ~44 s is the loop grinding the other 54 cells at ~0.8 s each.
A `break`, a destroyed execution context or a closed target would each have ended the subprocess
at ~20:03:25. It didn't.

That ~0.25–0.8 s per skipped cell is a **real round trip through the residential proxy returning
something that isn't JSON** — `r.json()` rejects inside the page, `page.evaluate` propagates,
`continue`.

### 3.3 It is not a municipality boundary, and not autocomplete

Missing grid indices per run (grid is muni-major; Stockholms = 0–5, Göteborgs = 6–11):

```
2026-07-01 05:23  got=54/60  missing: [0, 1, 2, 3, 4, 7]
2026-07-12 20:02  got=60/60  missing: []
2026-08-02 20:04  got=6/60   missing: [6 … 59]
2026-08-09 20:04  got=5/60   missing: [5 … 59]
```

- **Aug 9 died at index 5 = `Stockholms 20 000 000`** — mid-municipality, on a
  `webPricingCalculator` call using an already-cached `locationId`. A muni-boundary or
  autocomplete failure cannot produce this.
- **Jul 1 is the reverse pattern and the most informative run:** indices 0–4 failed, **5 and 6
  succeeded**, 7 failed, 8–59 all succeeded. Index 5 succeeding requires
  `cache["Stockholms kommun"]` to have been populated, which only happens on a *successful*
  autocomplete at index 0. So autocomplete worked, the **price fetches** failed transiently, and
  the loop **recovered**.

The difference between Jul 1 (scattered, recovers) and Aug 2/9 (clean suffix, never recovers) is
that in August the refusal **latches** — the exit IP/session earns a hard bot verdict rather than
intermittent noise.

### 3.4 Corroboration: escalating Cloudflare pressure

The crawler creates one Steel session per clear-attempt (`MAX_ATTEMPTS = 5` at
`adcost_steel.py:74`; `create_session` inside the attempt loop at `:202`):

```
2026-07-01T04:41:53  63.2s  1.10 MB  -> cleared attempt 1   (52 cells)
2026-07-05T20:00:02  53.3s  1.14 MB  -> cleared attempt 1   (0 cells)
2026-07-12T20:00:08 113.7s  0.04 MB  -> cleared attempt 1   (60 cells)
2026-07-19T20:00:03         30 sessions, ~63-73s each, 0.00-0.18 MB, never cleared
2026-07-26T20:00:03  64.1s  3.62 MB
2026-07-26T20:01:08  61.5s  3.65 MB
2026-07-26T20:02:10  39.0s  1.73 MB  -> cleared attempt 3   (0 cells)
2026-08-02T20:00:02  60.0s  3.64 MB
2026-08-02T20:01:02  61.1s  3.66 MB
2026-08-02T20:02:02  58.3s  3.64 MB
2026-08-02T20:03:00  69.0s  1.65 MB  -> cleared attempt 4   (6 cells)
2026-08-09T20:00:03  69.0s  0.04 MB
2026-08-09T20:01:10  70.1s  2.56 MB
2026-08-09T20:02:20  72.8s  3.64 MB
2026-08-09T20:03:35  45.8s  1.64 MB  -> cleared attempt 4   (5 cells)
```

Clear-attempts needed went **1 → 1 → 1 → never → 3 → 4 → 4**. And `proxyBytesUsed` is
**inversely** correlated with success: 0.04 MB on the only clean run vs ~3.6 MB on every failed
clear-attempt — the signature of a session chewing through Turnstile/challenge assets.

### 3.5 Alternatives checked and refuted

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Steel credit/quota exhaustion | **Refuted** | `creditsUsed: 0` on all 79 sessions; every August session `status: released`, `releaseReason: user_requested` (our own `finally`) |
| Per-session page cap / 300 s `sessionTimeout` | **Refuted** | `sessionTimeout: 300000` (`:134`) but August runs were 45.8 s and 69.0 s; only three Jun 30 dev sessions ever hit 300 s |
| Concurrency / session limit | **Refuted** | Four `create_session` calls succeeded back-to-back on Aug 2 and Aug 9; a rejected create would `raise_for_status()` → exit 1, and we saw exit 0 |
| Unhandled exception aborting the muni loop | **Refuted** | No `break` in the loop (§3.1) + ~44 s of post-failure grinding (§3.2) |
| Changed GraphQL contract | **Refuted as cause** | A schema change is permanent; Stockholms resolved *and* priced correctly on Aug 2 with the current queries, and Jul 12 got all 420. Cannot produce N = 60, 6, 5, 0 |
| Malware resource starvation | **Not relevant** | No `kinsing`/`kdevtmpfsi` running; `/proc/loadavg` = `0.02 0.05 0.01`; 1109 MB available. Chromium runs off-box at Steel |

---

## 4. Why nobody noticed — two blindness defects

### 4.1 The stderr is captured and thrown away

`apps/hemnet/tasks.py:1749-1755` logs `proc.stderr` **only when `returncode != 0`**. Aug 2 and
Aug 9 both exited **0**, so their `autocomplete failed …` / `price fetch failed …` lines were
collected into `proc.stderr` and discarded unread. **There is no traceback for Aug 2 or Aug 9
anywhere** — not in `docker logs`, not in `/var/log`, not in `ScrapeError`. This is the single
reason the root cause has to be argued from timing rather than quoted.

### 4.2 The failure handler itself crashes

`BaseTask.log_failure` (`tasks.py:744-748`) reads `self.request.url`:

```
  File "/app/apps/hemnet/tasks.py", line 747, in log_failure
    url=self.request.url,
AttributeError: 'Context' object has no attribute 'url'
```

`search_ad_cost_2` takes no `url`, so `ScrapeError.objects.create()` never runs and `on_failure`
raises inside celery's error path. **`ScrapeError` has had zero rows since 2026-06-25.** That
table cannot be trusted as a monitoring source for this task.

### 4.3 The retry policy is actively counterproductive

`tasks.py:1698-1704`: `autoretry_for=(Exception,)`, `retry_backoff=5`, `max_retries=5`. On Jul 19
this re-ran the whole task six times, producing **30 fresh residential Steel sessions in 37
minutes** against what is plainly an IP-reputation block:

```
2026-07-19 20:05:44 ERROR search_ad_cost_2 crawl failed [rc=4 stderr=attempt 1: still challenged
attempt 2: still challenged … attempt 5: still challenged
VERDICT: BLOCKED_CF]
… retry: Retry in 4s / 6s / 8s / 30s / 43s …
2026-07-19 20:37:26 RuntimeError: adcost steel crawl failed rc=4
```

Hammering a reputation block with fresh sessions is the opposite of backing off, and plausibly
worsened the pool's standing for subsequent weeks.

---

## 5. Fix plan

Ordered by value. **A and B stop the data loss; C is what makes the next failure diagnosable.**
Nothing here has been applied.

### C — Cheapest and most urgent: stop discarding the evidence
- `tasks.py:1749-1755` — log `proc.stderr` **unconditionally** at INFO/WARNING, not only on
  `rc != 0`.
- `adcost_steel.py:145-156` — have `in_page_fetch` return `{status, body}` and log `r.status`
  plus the first ~200 chars on a parse failure.

Two edit sites, both on the logging path. No change to crawl behaviour, scheduling, or what is
written. Makes the next occurrence name itself — 403 challenge vs 429 rate-limit vs schema
change — from a free log read, with zero Steel spend.

### B — The actual data fix: per-cell retry + latched-state recovery
In `adcost_steel.py`:
1. Wrap each cell's price fetch (`:236-243`) in a retry — 2–3 attempts, 2–5 s backoff. Jul 1
   proves cells that fail once succeed later.
2. **Detect the latched state and re-clear.** Track consecutive failures; after ~3 in a row, stop
   burning the grid: re-run `wait_for_clear(page)`; if still bad, tear down browser + session,
   `create_session` afresh, re-`goto`, re-clear, reset `cache`, and **resume from the failed cell**
   rather than restarting. This is the change that converts Aug 2's 6/60 into something near
   60/60 — the second half of every failed run was spent grinding a session already dead to
   Cloudflare.
3. Add ~0.5–1.5 s inter-cell jitter. 70 back-to-back XHRs from one session is itself a bot
   signal and is the plausible trigger for the latch.

### A — Completeness gate in the task
`tasks.py`, after `:1757`. Compute `expected = len(grid) * len(OFFER_SLUGS)` (60 × 7 = 420):
- `len(rows) == 0` → raise (retry).
- `len(rows) < expected * 0.95` → **write what you have, then raise/alert**, so the week is
  visibly incomplete. Today `rows=35` is indistinguishable from `rows=420` downstream.

### D — Fix the crashing failure handler
`tasks.py:747` — `url=self.request.url` → `url=getattr(self.request, "url", "") or f"task:{self.name}"`.
Until this lands, no `search_ad_cost_2` failure will ever reach `ScrapeError`.

### E — Soften the retry policy
`tasks.py:1698-1704` — `retry_backoff` in the tens of minutes with `retry_backoff_max`, total
attempts capped at 2–3. Consider a deferred re-attempt hours later: the block is time-varying
(Jul 12 cleared on attempt 1 at the same time of day).

### F — Tighten the clear detector
`adcost_steel.py:69-75, 164-176`. `CLEAR_RE` includes bare `Priser`, matched case-insensitively
against 4000 chars of body — "priser"/"priserna" appears in Hemnet's global nav on essentially
every page, so `is_clear` fires on pages that are not usably cleared; and `is_block` only scans
`body[:600]`. Replace with a positive functional probe: after the clear check, issue **one** cheap
`webAutocompleteLocations` call and require a valid `hits[]` before declaring the session good.
This converts Jul 5's and Jul 26's silent 0-cell runs into an honest `rc=4`.

### G — Idempotency, before B and E make retries more frequent
`AdCostV2` has **no uniqueness constraint** (`class Meta` carries only `verbose_name_plural`) and
the write loop sits *after* the crawl, so any exception during the write triggers a full-task retry
that re-writes rows. Add a unique constraint or `update_or_create` keyed on
(municipality, price, ad_type, crawl-week). Latent, not yet triggered.

---

## 6. Environment and gotchas

**Access** (read-only diagnosis used exactly this):
```
ssh -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none \
    -i ~/.ssh/droplet_ed25519 root@170.64.181.89
```

1. **The code on disk is the running code.** Repo `tt7676/hem-bol-scrapers`, branch
   `feat/adcost-steel-resume`, `HEAD = 328dc3d`, working tree clean except an untracked
   `docker-compose.override.yml`. `/var/www/apps/hemnet` is bind-mounted to `/app` in container
   `hemnet-django`. All containers have been up ~6 weeks with no restart since Jul 1.
   **Consequence: an edit is live in production immediately, and is reverted by anyone's
   `git pull`.** The branch is not merged to team main — that's a team call.
2. **Beat fires at 20:00:00 UTC, never 20:04.** The 20:04 values are `AdCostV2.crawled`
   (`auto_now_add` at write time) — i.e. ~4 minutes of Cloudflare grinding, not the schedule.
   Beat has not missed a Sunday: `enabled=True`, `crontab=0 6 * * 1 Australia/Sydney`,
   `total_run_count=115`, and `PeriodicTasks.last_update = 2026-07-01 04:41:47`, so the schedule
   definition has not been touched since Jul 1. A second row `[adhoc] Scrape hemnet.se ad cost`
   is inert (`enabled=False`, `crontab=None`, `total_run_count=0`).
3. **Zero-row runs leave no date bucket.** Any freshness query that groups by `crawled::date`
   is blind to Jul 5 / 19 / 26 — they wrote nothing at all. Monitor "did rows arrive in the
   window" **and** "were there ≥400 of them across 10 municipalities", not volume alone.
4. **Jul 1's 378-row bucket is not the run in the log.** The logged 04:41:51 task wrote
   `created=364`, and those rows are absent from `AdCostV2` (no 04:42 bucket). The 378-row bucket
   at 05:23 matches Steel session `2026-07-01T05:22:31.308Z` and has no container-log entry (the
   worker restarted 05:16:14), so it was invoked out-of-band. Rows were evidently deleted and the
   crawl re-run by hand during the resume work. **Do not treat Jul 1 as a clean baseline.**
5. **Schema:** the column is `property_municipality_id`, not `property_municipality`.
   `valid_until` is NULL on every row.
6. **No `psql` on the droplet** — query via the Django shell or a read-only Python snippet.
7. **Known, separately tracked:** `kinsing`/`kdevtmpfsi` crypto-mining malware on this box,
   suppressed per-minute by a `kill.sh` cron. Not implicated here (load 0.02). Do not attempt
   remediation as part of this work.

---

## 7. Open question, and what would settle it

The exact refusal is **not directly quoted** — see §4.1. Distinguishing a 403 Cloudflare
challenge from a 429 rate-limit from a contract change needs the in-page response status and body,
which the current code never logs.

Two routes:
- **Free:** apply fix C, let Sunday's run fail, read the log. Costs one week, zero spend.
- **Paid:** one live Steel session with C applied. Requires explicit per-run operator approval —
  the standing rule is that no paid Steel/Oxylabs run happens without a go-ahead for that
  specific run.

---

## 8. Verification, once a fix lands

1. `AdCostV2` gains a bucket with **420 cells across 10 municipalities and 7 `ad_type` values**
   for the run's date.
2. The task's own log states the completeness result (`rows=N/420`) rather than a bare `rows=N`.
3. A deliberately degraded run (e.g. a forced early failure) is reported as a **failure or
   alert**, not `succeeded`.
4. `ScrapeError` gains a row on a genuine failure — proving §4.2 is fixed.
5. Steel session count per fire returns to ~1 (clear on attempt 1), not 3–4.
