# Ad-cost scrape migration: 170.64.181.89 → cohort-tracker

**Date:** 2026-08-18
**Status:** design approved, spec under review
**Goal:** move the Hemnet ad-cost scrape onto the cohort-tracker droplet so the
standalone price-scraper droplet can be destroyed, saving ~$12/month (~$144/year).

---

## 1. Why this is worth doing

`170.64.181.89` is a 1 vCPU / 2GB / 50GB droplet (`s-1vcpu-2gb`, ~$12/mo) running a
five-container Django + Celery + Redis stack. Exactly **one** scheduled task on it is
enabled:

```
Scrape hemnet.se ad cost   True    0 2 1 * *   apps.hemnet.tasks.search_ad_cost_2
celery.backend_cleanup     True    0 4 * * *   (housekeeping, not a scrape)
```

Every other beat task — `Scrape hemnet.se` (listings), `Scrape booli`, `Scrape block inc`,
`Scrape procore`, `Scrape spotify` — is `enabled=False` and has been since the Phase 22
audit. The box has no crontab entries. It exists to run one HTTP POST loop, once a month,
for about 21 minutes.

The cohort-tracker droplet (`170.64.197.241`) already runs the *reporting* half of this
exact pipeline (`adcost-report.js` + `scripts/adcost-report.py`), already has a Python venv
with `psycopg`, and was resized on 2026-08-18 to the same 1 vCPU / 2GB / 50GB spec. Both
halves on one box means one box instead of two.

---

## 2. The decisive finding: the working transport is not a browser

`ADCOST_TRANSPORT` defaults to `unlocker`, which is a plain `POST` to
`https://www.hemnet.se/graphql` through Bright Data's Web Unlocker proxy (port 44445,
`verify=False` because the unlocker terminates TLS), issued with Python `requests`.

**No Playwright. No CDP. No browser session. No Cloudflare-clearing.**

The other two transports in the file are dead:

| transport | status |
|---|---|
| `unlocker` | **DEFAULT, working.** Validated live 2026-08-17, 420/420 cells. Billed per *successful* request, so failed retries are free (~$0.10/run). |
| `brightdata` | Falsified 2026-08-17 — Browser API returns `resolve_fail_cf_max_tries` on both US and SE; the page never clears. |
| `steel` | Last resort. Clear rate decayed to ~12% by 2026-08-14, and Cloudflare refused `POST /graphql` even on pages it did clear. |

This is what makes the migration small. The portable part is a `requests` loop; the ~1,000
lines of browser machinery around it are dead weight for the path we actually run.

## 3. The destination can already reach everything it needs

Verified 2026-08-18 by querying from the cohort-tracker DB user:

| table | rows | readable from cohort-tracker |
|---|---|---|
| `hemnet_adcostpricepointv2` | 60 (10 munis × 6 bands) | yes |
| `hemnet_municipalityv2` | 362 | yes |
| `hemnet_adcostv2` | the write target | yes (already read by the report) |

All three live in the **shared managed Postgres `defaultdb`**, not on the droplet. Django is
needed only for the code that orchestrates the crawl, never for data access. Destroying the
droplet does not touch any of this data.

---

## 4. Decisions locked

| # | decision | rationale |
|---|---|---|
| D1 | **Lift-and-shift the Python crawler**, don't rewrite in Node | The retry / latch-detection logic is hard-won. On 2026-08-02 the pre-fix crawler wrote 6 of 420 rows and exited 0 — a silent failure that cost five weeks of data and was diagnosable only from timing. Re-deriving that logic in a second language is where a month of data goes missing. Keep the risky part byte-identical; rewrite only the boring parts. |
| D2 | **Port only the `unlocker` transport**; delete `steel` and `brightdata` | Both falsified. Keeping them means carrying Playwright onto a box that has neither the dependency nor a use for it. ⚠ This retires the documented "rollback = `ADCOST_TRANSPORT=steel`" — see D3. |
| D3 | **Snapshot `.181.89` before destroying it** | With the Steel transport gone, the snapshot *is* the rollback. Also preserves the Django admin, the beat rows, and the disabled listing scrapers on paper. ~$1–2/mo for 50GB; delete when confident. |
| D4 | **Grid lives in repo constants**, asserted against `hemnet_adcostpricepointv2` | Once Django is gone, editing that table means hand-written SQL against production: no review, no history. Code is reviewed and versioned. The assertion catches drift in either direction. Also collapses today's *two* silently-forkable definitions (the DB table, and `MUNI`/`PRICE_POINTS` hardcoded in `adcost-report.py`) into one. |
| D5 | **Validate with a `--dry-run` crawl**, not a live one | A validating write would create a real 2026-08-18 snapshot, which becomes "latest" and shifts the report's period-on-period column. Dry-run crawls fully, skips the write, diffs in memory. |
| D6 | **Cut over before 1 Sept; destroy after it succeeds** | The series is monthly and unbackfillable. Keeping the old box through one real unattended run costs ~$6 and buys a working fallback. |
| D7 | **Hold the snapshot for a quarter** (to ~2026-11-18), then delete | Julian's call, 2026-08-18. ~$1–2/mo for 50GB. Covers three monthly cycles, so any seasonal or cadence-related failure surfaces while the fallback still exists. |

---

## 5. Architecture

### As-is

```
celery beat row "Scrape hemnet.se ad cost"  (0 2 1 * * UTC, django_celery_beat)
  └─> search_ad_cost_2                      (apps/hemnet/tasks.py:1746, eventlet worker)
        ├─ grid    <- AdCostPricePointV2 via Django ORM  (60 rows)
        ├─ crawl   -> subprocess: python adcost_steel.py (1,315 lines, plain interpreter)
        │             stdin  = grid JSON
        │             stdout = {"rows": [...], "stats": {...}}
        │             timeout=2700, env ADCOST_SUBPROCESS_TIMEOUT=2700
        └─ write   -> AdCostV2.objects.create/save  (Django ORM, idempotent by day)
              └─ completeness gate: raise if rows < expected * 0.95
```

The subprocess exists because Playwright is incompatible with the celery worker's eventlet
monkey-patching. **Under the `unlocker` transport that reason no longer applies** — there is
no Playwright in the path — but the subprocess boundary is still a good seam and the port
keeps it.

### To-be

```
lib/job-registry.js  'ad-cost-crawler'  (30 0 1 * * UTC)  -> generated crontab
  └─> adcost-crawl.js                   (Node, cron-wrapper.runJob, tier 1)
        └─ subprocess: .venv-adcost/bin/python scripts/adcost-crawl.py
              ├─ grid    <- repo constants (asserted against hemnet_adcostpricepointv2)
              ├─ crawl   -> requests POST via Bright Data unlocker proxy
              ├─ write   -> psycopg, raw SQL, idempotent by day
              └─ completeness gate: exit non-zero if rows < expected * 0.95
```

Mirrors `adcost-report.js` exactly: a thin Node job registered in the registry, shelling out
to Python under `PYTHON_BIN`. Same idiom, same alerting, same liveness, same log conventions.

---

## 6. Port plan, component by component

### 6.1 Copy essentially unchanged

From `apps/hemnet/adcost_steel.py`, keeping behaviour identical:

- `parse_pricing` — the GraphQL response shape
- `make_unlocker_gql`, `warmup_unlocker`, `warmup_unlocker_retrying`
- `default_session_factory`, the rebuild/resume loop, `derive_time_budget`,
  `grid_seconds_needed`
- `read_env_value` / `read_credential` (env, else repo-root `.env`; never logged)
- the whole `selftest()` suite — becomes the job's offline smoke check

The GraphQL contract, unchanged (validated live 2026-07-01, `27-GRAPHQL-CONTRACT.md`):

- autocomplete op `webAutocompleteLocations` → `locationId`
- price op `webPricingCalculator` → `pricingCalculator[]`
- `ad_price = prices.PAY_WHEN_LISTING_IS_REMOVED.total.amountInCents / 100` (SEK, **net of moms**)
  — ⚠ **not `PAY_NOW`**. An earlier revision of this spec said `PAY_NOW`, inherited from the
  Django module docstring; the code it documented never did that. The historical AdCostV2
  series is denominated in `PAY_WHEN_LISTING_IS_REMOVED` and matches it to the krona
  (Stockholm @5M → BASIC 7297 / PLUS 11662 / PREMIUM 16370 / MAX 22683), which is what makes
  the series continuous across the scrape gap. Treat any future `PAY_NOW` sighting in prose
  as a documentation bug, never as a spec for the code.
- `composeUpgradesWithBasic: true` → PLUS/PREMIUM/MAX already composed, no BASIC-sum
- `offerSlug` → historical `ad_type` via `SLUG_TO_AD_TYPE`

### 6.2 Delete

`create_session`, `cdp_endpoint`, `release_session`, `read_steel_key`,
`brightdata_cdp_url`, every `playwright.async_api` import and code path, and the
`TRANSPORTS` selector itself. Roughly 1,000 of 1,315 lines.

### 6.3 Rewrite — the grid

Replaces the Django ORM query over `AdCostPricePointV2`.

The crawler reads municipalities and price bands from repo constants shared with
`scripts/adcost-report.py` (today `MUNI` = 10 entries, `PRICE_POINTS` = 6 bands). A check
asserts the constants still match `hemnet_adcostpricepointv2` (60 rows) and fails loudly on
any mismatch, in either direction.

The crawler needs `full_name` (e.g. `"Stockholms kommun"`) for the autocomplete call and
`property_municipality_id` for the write, so the shared constant carries id, name, full_name
and county.

### 6.4 Rewrite — the write

Replaces `AdCostV2.objects.create` / `obj.save(update_fields=["ad_price"])`.

Semantics that must be reproduced exactly:

- key = `(property_municipality_id, property_price, ad_type)`, **scoped to the crawl day**
  (`crawled::date = today`)
- existing row with a different `ad_price` → UPDATE that row
- existing row with the same price → no write
- no existing row → INSERT with `valid_until = NULL` and `crawled = now()`
  (Django's `auto_now_add`)

⚠ `hemnet_adcostv2` has **no uniqueness constraint**. Idempotency is entirely in the code.
This is exactly why 2025-10-19 holds 742 rows — a double-run. Getting this wrong corrupts
the series silently, and the reporting side only tolerates it because it dedupes with
`max(ad_price)` in SQL.

### 6.5 Orchestration

`adcost-crawl.js`, modelled on `adcost-report.js`:

- `cron-wrapper.runJob` → `cron_job_log` row
- spawn `PYTHON_BIN` (registry supplies `/opt/hemnet-cohort-tracker/.venv-adcost/bin/python`)
- **fall through interpreters only on `ENOENT`** — a python that exists but fails must fail
  loudly, never be retried under a different interpreter
- `--smoke` runs the ported `selftest()`: offline, zero network, zero spend
- pass `ADCOST_SUBPROCESS_TIMEOUT` and the subprocess timeout from one constant so they
  cannot drift

Registry entry: `tier: 1`, `frequency: 'monthly'`, `cron: '30 0 1 * *'` (see the schedule note below),
`env: { PYTHON_BIN: ... }`, `log: /var/log/hemnet/adcost-crawl.log`,
`expectedDurationMin: 45` — matching the 2700s subprocess ceiling, not the ~21 min expected
runtime, so a slow-but-succeeding month is not alerted as an overrun. The existing
`assert: 'adCostMonth'` (40-day window, demands a
complete 420-cell grid) already covers freshness and needs no change — but the entry stops
being `external: true`.

**Schedule (corrected 2026-08-18 after an adversarial pre-mortem):** the crawl runs
`30 0 1 * *` UTC, **not** `0 2 1 * *`. That slot is already held by `age-census-monthly`,
a tier-1 job with `expectedDurationMin: 240` — scheduling there would have started two
never-before-run monthly jobs on the same minute, on one vCPU / 2GB with no swap, and the
crawler's TIME_BUDGET leaves only ~31% headroom at its own measured rate. The month on the
1st now reads: 00:30 crawl (≤45 min) → 02:00 census (~3h) → 07:00 census report →
07:10 ad-cost report.

---

## 7. Invariants that must survive the port

These are load-bearing. Each exists because it failed once.

1. **Rows are written BEFORE the completeness gate raises.** A degraded month keeps its
   partial data *and* reports failure. Reversing this either discards good rows or reports
   a 35-row month as success.
2. **`ADCOST_MIN_COMPLETENESS = 0.95`, `ADCOST_OFFERS_PER_CELL = 7`**, expected =
   `len(grid) × 7` = 420.
3. **The subprocess timeout discards stdout on overrun.** `subprocess.run` kills the child
   and throws its stdout away, so an overrun loses the *entire* harvest, not the tail — a
   permanent hole on an unbackfillable monthly series. Sized 2700s from a measured
   ~21s/cell × 60 cells ≈ 1,300s plus headroom. The crawler derives its own `TIME_BUDGET`
   from the same value so the two cannot drift.
4. **Crawler stderr is always logged, not only on non-zero exit.** Every degraded run so far
   exited 0; its `price fetch failed` lines were captured and thrown away unread, which is
   the only reason the August failures had to be diagnosed from timing rather than a stack.
5. **The credential is read from env or repo-root `.env`, never logged.**
6. **Retry, latched-refusal detection, and resume-from-failed-cell** — the crawler proves a
   session with a real autocomplete call before trusting it. A text-match on "Priser" hits
   Hemnet's global nav on every page, which is how 5 and 26 July "cleared" and then
   collected nothing.

---

## 8. Validation

**Offline first:** `--smoke` (ported `selftest()`) must pass. Zero network, zero spend.

**Then one ad-hoc `--dry-run` crawl** on cohort-tracker: full crawl, no write, diff in memory
against the 2026-08-17 grid.

- **Pass** = 420/420 cells returned, and prices either identical or differing for a visible
  reason.
- **Not** exact equality: if Hemnet repriced this week that is a real observation, not a port
  bug. The 2026-08-17 grid is the reference because it is the most recent complete run.

Cost ~$0.10 of Bright Data, ~21 minutes. **Paid — requires explicit go-ahead on the day.**

---

## 9. Cutover

1. Land the port; `--smoke` green on the workstation and on the droplet.
2. Copy `BRIGHTDATA_UNLOCKER_PROXY` into cohort-tracker's `.env` (confirmed absent today).
3. Ad-hoc `--dry-run`; diff against 2026-08-17. **Gate: stop here if it fails.**
4. Register the job; `render-crontab.js --check` clean. **Disable the Celery beat row
   "Scrape hemnet.se ad cost"** so two writers can never target the same crawl day.
5. 1 Sept: confirm 420/420 written by cohort-tracker and that the 07:10 report reads it.
6. Snapshot `.181.89`, verify the snapshot, then destroy the droplet.

Steps 5–6 deliberately follow the first real unattended run, so the old box remains a live
fallback through September.

---

## 10. Risks

| risk | mitigation |
|---|---|
| Egress from cohort-tracker is slower than the old box, eroding the 2700s margin | The dry-run measures it. If sec/cell rises materially, raise the timeout *and* `TIME_BUDGET` together before cutover. |
| Idempotent-write bug duplicates rows (no DB constraint to catch it) | Reproduce the day-scoped key exactly; assert row counts after the first real run. Consider a unique index as follow-up work — out of scope here. |
| Both writers fire on 1 Sept | Beat row disabled at step 4, before the first cohort-tracker fire. |
| Losing the Steel rollback | Accepted (D2/D3). Steel was ~12% effective; the snapshot is the real fallback. |
| Bright Data credential mishandled in transit | Copy directly host-to-host; never echo it into a transcript or a commit. |
| ✅ **Bright Data rejects the new egress IP** — RESOLVED 2026-08-18 | Verified fine. Zone `hemnet_pricing_unlocker` authenticates by username/password with **no source-IP allowlist**: cohort-tracker got HTTP 200 and 165KB of real Hemnet HTML through the proxy, three samples, against a control from the old box. Latency varies 5.9–45s on **both** hosts — variance, not a slower destination. ⚠ This probe hit the homepage, not `/graphql`; it does **not** settle the crawl's timing. |
| 🔴 **The source code exists in only one place, and it is the box being destroyed** | See §12.1. Rescued by Task 0 of the implementation plan, which runs **before** any other work: snapshot the droplet, copy both files into `docs/handover/adcost-django-source/`, verify by md5, commit and push. |

---

## 11. Out of scope

- Migrating the disabled listing scrapers (Booli / Hemnet / block inc / procore / spotify).
  They use Playwright and a Redis queue; a much larger job, and they are off by choice.
- The county-vs-rate-card reporting grain question
  (see the `project_hemnet_adcost_rate_cards` memory).
- A uniqueness constraint on `hemnet_adcostv2`.
- Rebuilding the Django admin UI anywhere else.

---

## 12. What else is on the box — checked 2026-08-18

### 12.1 🔴 One thing DOES block the destroy: the source is unversioned

Found 2026-08-18 while checking whether the repos were up to date:

```
repo:      /var/www/apps/hemnet   (bind-mounted to /app in the container)
branch:    feat/adcost-steel-resume @ 328dc3d
remote:    github.com/tt7676/hem-bol-scrapers.git
upstream:  none — never pushed
status:    M apps/hemnet/adcost_steel.py   (+1,226 lines)
           M apps/hemnet/tasks.py          (+115 lines)
```

`git branch -r --contains 328dc3d` returns nothing: the commit is on no remote branch either.

**The entire working Bright Data fix — 1,238 uncommitted insertions, 56 of them referencing
`unlocker`/`44445`/`BRIGHTDATA` — exists only as a working tree on the droplet this design
destroys.** It is simultaneously the only thing producing the dataset. This is a live risk
independent of the migration: if that host failed tonight, weeks of hard-won debugging would
be gone, and §6's "copy the unlocker path" would have nothing to copy from.

The remote belongs to a third party, so pushing the branch upstream is not available to us.

**Mitigation — plan Task 0, before any other work:** snapshot the droplet, copy both files into
`docs/handover/adcost-django-source/`, verify byte-identical by md5, commit and push. The
snapshot moved from the end of the sequence to the very beginning for the same reason.

### 12.2 Nothing else depends on the box

The remaining original open items are closed.

**Snapshot retention:** hold a quarter — see D7.

**Nothing else depends on `.181.89`.** Verified:

- **nginx listens publicly on :80 but serves nothing.** No config in `sites-enabled`, and the
  access log holds **zero** requests from zero distinct client IPs. It is a running default
  install, not a service anyone uses.
- **There is a `hemnet-metabase` container** — `metabase/metabase:v0.47.1`, **Exited (137)**
  (OOM-killed) **six weeks ago**. This was the one genuine surprise, and it is the only thing
  on the box besides the scrape with any claim to being valuable.
- **Metabase's content survives the droplet.** It is configured with
  `MB_DB_TYPE=postgres` against the **managed** Postgres
  (`private-db-postgresql-syd1-79303…`, database `metabase`) and has **no local volume
  mounts** at all. Every dashboard, saved question and user lives in the managed database,
  not on this disk. Destroying the droplet destroys the *server process*, not the work.
  Restoring it later is one `docker run` of the same image against the same `MB_DB_*` config,
  on any host — it does not have to be this one.
- The box also holds `OXYLABS_*` and `STEEL_API_KEY` in its `.env`. These are credentials,
  not dependencies: nothing routes *through* this droplet. Its DB trusted-source entry
  becomes stale on destroy and should be removed for hygiene.

**Residual caveat:** if anyone is accustomed to reaching Metabase or the Django admin at
`http://170.64.181.89/`, those URLs stop working. The access log says nobody has, and
Metabase has been dead six weeks without complaint, but the URL disappearing is real.
