# Phase 11: Daily market-totals capture + minimal report - Context

**Gathered:** 2026-05-27
**Status:** Ready for planning

<domain>
## Phase Boundary

A new daily cron job (`market-totals-daily.js`) captures Hemnet + Booli nationwide listing totals into a new `market_totals` table; an inline pre-flight smoke-probe defends against silent site breakage; a weekly Slack consumer surfaces Till salu WoW comparing Hemnet vs Booli.

**Locked during discuss (narrows ROADMAP):**
- Segments captured = **`till_salu` + `kommande` only**. Sold dropped — operator decision during discuss (D-01).
- Output volume = **4 rows/day** (2 sites × 2 segments), not the 6 rows/day in ROADMAP SC-1.
- Daily Oxylabs cost = **3 reqs/day** (Hemnet 1 + Booli 2).
- Reporting consumer = **weekly Slack** (Monday), not daily, with a locked output format (see D-04).

**Out of scope (per ROADMAP + discuss):**
- Sold / historic-sold totals — dropped during discuss.
- Per-municipality / per-county totals — own milestone.
- Unexpected-delta alerting (DoD or WoW thresholds) — deferred to a future plan, see D-03.
- Long-horizon backfill — start fresh.
- Cross-platform reconciliation beyond raw deltas — analyst-side, not pipeline.

</domain>

<decisions>
## Implementation Decisions

### Segments + fetch budget (D-01)
- **Segments:** `till_salu`, `kommande`. Sold dropped. Schema stores 4 rows/day, not 6. **ROADMAP SC-1 needs an edit** — see `<roadmap_updates_needed>` below.
- **Fetch budget — 3 Oxylabs requests/day total:**
  - **Hemnet:** 1 fetch of `https://www.hemnet.se/bostader` — a single `__NEXT_DATA__` payload exposes BOTH segments simultaneously:
    - `pageProps.__APOLLO_STATE__.ROOT_QUERY.searchForSaleListings(...).total` → till_salu
    - `pageProps.__APOLLO_STATE__.ROOT_QUERY.searchUpcomingListings(...).total` → kommande
  - **Booli:** 2 separate filtered fetches, one per segment:
    - `https://www.booli.se/sok/till-salu?upcomingSale=0` → `pageProps.__APOLLO_STATE__.ROOT_QUERY.searchForSale(...).totalCount` → till_salu
    - `https://www.booli.se/sok/till-salu?upcomingSale=1` → `pageProps.__APOLLO_STATE__.ROOT_QUERY.searchForSale(...).totalCount` → kommande
  - Rationale: filtered Booli totals are canonical; the `.facets.forSaleType.*` shortcut runs ~0.8% under the filtered total per the 2026-05-27 probe and was rejected during discuss.

### Pre-flight smoke-probe (D-02)
- **Placement:** Inline at the top of `market-totals-daily.js` `main()`. Same Oxylabs fetches power both the probe and the write — zero extra cost.
- **What it checks:** key-present + numeric, for each of the 4 expected JSON paths. If any path resolves to `undefined`, `null`, `NaN`, or a non-positive number, throw with a descriptive error like `JSON path missing for hemnet.till_salu: pageProps.__APOLLO_STATE__.ROOT_QUERY.searchForSaleListings(...).total`. `cron-wrapper.runJob` marks the row `status=failure` and the existing webhook pages.
- **What it does NOT check:** sanity bounds on `total` (e.g. `> 1000`). Operator rationale: a deep market crash could legitimately drive the number low; value-range concerns belong to delta-alerting, not schema-validity.
- **No separate `scripts/probe-market-totals-schema.js`** — a second cron slot was rejected as overkill for a single-job feature.

### Alert thresholds — what Phase 11 alerts on (D-03)
- **Phase 11 alerts only on:**
  1. JSON path missing or non-numeric (schema drift, raised by D-02 inline probe).
  2. Oxylabs fetch failure (`lib/scrape-http.getWithRetry` exhausted both direct curl and the Oxylabs retry).
  3. `validate()` returns a string for any other defensive condition (rows-written < 4, fetched_at older than 1h before NOW).
- **No "unexpected delta" alerting in v1.** ROADMAP SC-2 currently says "warns to Slack on JSON-path-break, fetch failure, **or unexpected delta**" — **drop the "or unexpected delta" clause.** See `<roadmap_updates_needed>`.
- **Why:** Phase 10 was specifically about cutting Slack alert fatigue (removed `oxylabsFallbackRate > 0.30` warnings from Jobs A/C/D, lowered Job B match-rate threshold 50%→30%, retargeted cohort-track null-Booli warning). Introducing a delta threshold without a baseline would regenerate the same noise. Re-evaluate as a future plan once 30+ days of clean baseline data exists in `market_totals`.

### Weekly Slack reporting consumer (D-04)
- **Cadence:** Weekly, Monday morning, alongside `weekly-view-report.js`.
- **Content:** Till salu WoW, Hemnet vs Booli, with Booli−Hemnet gap row. Kommande is captured in `market_totals` but not surfaced by Phase 11's consumer (available for future use / ad-hoc query).
- **Output format — LOCKED (operator-selected mockup, code block exact):**
  ```
  Market supply pulse — Till salu, week of 2026-05-25
  Hemnet:           50,769 →  51,289   (+520, +1.0%)
  Booli:            60,560 →  60,924   (+364, +0.6%)
  Booli − Hemnet:    9,791 →   9,635   (-156)
  ```
- **WoW math:** for each platform, query `market_totals` for `(day=$today)` and `(day=$today - 7)` where `site=$p` and `segment='till_salu'`. Compute absolute delta and percent delta. Gap row: `booli.till_salu - hemnet.till_salu` for both weeks plus their absolute delta. Format numbers with thousands separator (space or comma — operator preference, comma is more familiar in Slack).
- **Where the code lives:** Planner decides. **Recommend a new `market-totals-weekly-report.js`** (clean separation; one concern per script). Embedding in `weekly-view-report.js` is also acceptable but pulls market-totals concerns into the cohort report; reject if it adds a market-totals DB query path to the cohort report.
- **First valid run:** ≥ 7 days after Phase 11 cron deploy. Earlier runs have no prior-Monday row.
- **Missing-data semantics:** If either prior-week row is missing (e.g. fetch failed 7 days ago), render `?` for that row's delta cells; do NOT crash and do NOT silently send a misleading 0%. Log at WARN.

### Cron slots (D-05)
- **Daily slot for `market-totals-daily.js`:** Proposed **08:30 UTC** — right after `sfpl-region-snapshot` (08:00 UTC), well clear of the every-2-days view-refresh cycle (14:00/18:00/22:00 odd days), Mon `cohort-create` (06:00 UTC), Mon Job B (03:00 UTC), Sun Job C (22:00 UTC). Planner may revisit; this is the recommended default, not a hard lock.
- **Weekly slot for the Slack consumer:** Proposed **Monday 09:30 UTC** — after the Mon 09:00 UTC droplet fan-out (per `deploy-instructions.md:76-81`, the legacy Pool & Flow scripts in that block are scheduled for removal in Plan 10-05; `weekly-view-report.js` itself stays). Planner should verify the actual crontab for `weekly-view-report.js` and chain after it.

### Schema details (D-06)
- **Table DDL (locked from ROADMAP + discuss):**
  ```sql
  CREATE TABLE IF NOT EXISTS market_totals (
    day          DATE        NOT NULL,
    site         TEXT        NOT NULL,
    segment      TEXT        NOT NULL,
    total        INTEGER     NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_url   TEXT        NOT NULL,
    PRIMARY KEY (day, site, segment)
  );
  ```
- **`total` type = INTEGER** (Sweden's housing market is well under INT_MAX = 2.1B). Avoid BIGINT.
- **`site` values:** `'hemnet'`, `'booli'` (lowercase).
- **`segment` values:** `'till_salu'`, `'kommande'` (snake_case lowercase).
- **`source_url`:** the exact URL fetched, not a normalized form. Useful for forensics if a future fetch returns wrong data.
- **Idempotent rerun:** `INSERT … ON CONFLICT (day, site, segment) DO UPDATE SET total = EXCLUDED.total, fetched_at = EXCLUDED.fetched_at, source_url = EXCLUDED.source_url`. Same-day rerun is safe.
- **DDL location:** Inline `CREATE TABLE IF NOT EXISTS` at top of `market-totals-daily.js` `main()`. Mirrors `sfpl-region-snapshot.js:16-29` — no separate `*-setup.js`.

### Reuse of existing infrastructure (D-07)
- **HTTP transport:** Use `lib/scrape-http.js` — `getWithRetry(url, log, opts)` + `extractNextData(html)`. Do NOT re-implement the Oxylabs POST inline like `scripts/probe-total-listings.js` did. The probe lives in `scripts/` for ad-hoc use; production code uses the shared transport.
- **`oxylabsFallbackRate` will be 100% for this job.** The top-level Hemnet + Booli search pages are Cloudflare-protected and direct curl will likely 403, same pattern as Jobs C/D today. **Do NOT add a `validate()` warning on fallback rate** — Plan 10-02 (a)/(b) just stripped those warnings from sibling jobs precisely because they became permanent noise.
- **Cron-wrapper integration:** Standard pattern — `runJob({ scriptName: 'market-totals-daily', main, validate })`. Inherits SIGHUP/SIGTERM/SIGINT recovery from 10-01 hardening, `cron_job_log` row management, Slack alerting on `failure`/`warning`.
- **`resultSummary` shape (suggested for planner):** `{ rowsWritten: 4, perRow: [{ site, segment, total, fetchMs, viaOxylabs }, ...], hemnetFetchMs, booliTillSaluFetchMs, booliKommandeFetchMs }`. Persists to `cron_job_log.result_summary` for the consumer + forensics.
- **Slack send for weekly consumer:** Reuse the inline `sendSlack` pattern in `weekly-view-report.js:9-30` (NOT the cron-wrapper webhook, which is for failure/warning only). Read `SLACK_WEBHOOK_URL` from env.

### Claude's Discretion
- Exact log line wording, exact `resultSummary` field names, retry counts inside the JSON-path probe (use a single-shot — the underlying `getWithRetry` already retries).
- Specifics of "format numbers with thousands separator" — comma is more Slack-friendly, but planner may pick either.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope + roadmap
- `.planning/ROADMAP.md` §"Phase 11: Daily market-totals capture + minimal report" — current success criteria SC-1..SC-5 (the ROADMAP edits in `<roadmap_updates_needed>` should be applied before/during planning).
- `.planning/STATE.md` — current milestone state; v2.2 runs in parallel to v2.1.

### Empirical reference for endpoints + JSON paths
- `scripts/probe-total-listings.js` — Established the JSON paths on 2026-05-27. Do **NOT** re-run as a Phase 11 gate; the paths are locked here. Per `[[project-probe-oxylabs-booli-empirically-validated]]`-style logic: skip re-probe unless creds/code/site break.
- `verf-totals/` (gitignored, outside `.planning/`) — Raw probe HTML + parsed `__NEXT_DATA__` JSON dumps for both sites. Available locally on operator's machine for inspection; not committed.

### Production scrape transport + cron infrastructure
- `lib/scrape-http.js` — Use `getWithRetry(url, log)` and `extractNextData(html)`. Module-level `_oxStats` counters track Oxylabs fallback rate.
- `lib/scrape-http.js` §"Environment overrides" — `SCRAPE_FORCE_OXYLABS=1` is available for testing.
- `cron-wrapper.js` — `runJob({ scriptName, main, validate })` contract; SIGHUP/SIGTERM/SIGINT recovery + fresh-client `recoverRow()` (10-01 hardening).
- `cron-setup.js` — `cron_job_log` table DDL (already deployed; no schema change needed for Phase 11).

### Closest existing analog
- `sfpl-region-snapshot.js` — Daily cron-wrapped multi-source aggregator with inline `CREATE TABLE IF NOT EXISTS`. The template for `market-totals-daily.js`.

### Slack reporting reference
- `weekly-view-report.js:9-30` — Inline `sendSlack(webhookUrl, message)` helper. Reuse pattern for the weekly market-totals consumer.
- `deploy-instructions.md:76-81` — Monday 09:00 UTC droplet fan-out block (legacy Pool & Flow; scheduled for retirement in Plan 10-05). The weekly Slack consumer for market-totals should chain after `weekly-view-report.js`, NOT inside the legacy block.

### Memory pointers (auto-memory)
- `[[project-market-supply-pulse-feasibility]]` — Endpoints + JSON paths + Oxylabs cost validated 2026-05-27.
- `[[project-booli-hemnet-totals-asymmetry]]` — Cross-platform supply ratio context (Booli pool ~5× Hemnet on Kommande, ~1.19× on Till salu) — informs why both platforms are captured.
- `[[project-hemnet-flipped-to-oxylabs]]` — Hemnet direct-curl stopped working 2026-05-08→2026-05-21; expect 100% Oxylabs fallback for this job too.
- `[[project-deploy-process]]` — `git pull` on droplet to deploy, not file paste.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`lib/scrape-http.js`** — `getWithRetry` + `extractNextData` already handle curl + Oxylabs fallback + retry envelope + `_oxStats` counters. Consume directly; no new HTTP code.
- **`cron-wrapper.runJob`** — Standard cron harness with DB connect/retry, `cron_job_log` row management, signal-handler recovery (10-01), Slack alerting via `SLACK_WEBHOOK_URL` on failure/warning.
- **`weekly-view-report.js:9-30`** — Inline `sendSlack` helper; reuse for the weekly consumer.
- **`db.js`** — `createClient()` factory; standard pattern for the weekly consumer's DB read.

### Established Patterns
- **Inline DDL at top of `main()`** (`sfpl-region-snapshot.js:16-29`) — no separate `*-setup.js` for a small new table.
- **`INSERT … ON CONFLICT … DO UPDATE`** for idempotent daily rewrites; the PK on `(day, site, segment)` makes same-day reruns trivially safe.
- **`resultSummary` as a JSON blob** stored in `cron_job_log.result_summary` — every cron-wrapped job follows this; downstream tooling (e.g., `cohort-track.js` reading `priorPerCohortNull` from 10-03) treats it as the canonical run record.
- **Failure / warning Slack alerting flows through cron-wrapper** — main jobs `throw` or return a `validate()` warning string. They do NOT send Slack directly. Only reporting consumers send Slack directly (`weekly-view-report.js`, the legacy `pool-flow-report.js`).

### Integration Points
- **DB:** Reads/writes only `market_totals` (new table). Weekly consumer reads only `market_totals`. No coupling to cohort tables or booli/hemnet source tables.
- **Cron:** New crontab entries on droplet (deployed via `deploy-instructions.md` + `git pull` on droplet). Planner should produce a delta against current crontab.
- **Slack:** Uses the existing `SLACK_WEBHOOK_URL`. Failure/warning routes through cron-wrapper; weekly consumer message is a direct send.

### Patterns NOT to Apply
- Do **NOT** add a `validate()` warning on `oxylabsFallbackRate` (will be ~100% for this job — Plan 10-02 lesson).
- Do **NOT** add a Pool & Flow-style direct-to-Slack reporting call from inside the daily job (that's the legacy pattern being retired in Plan 10-05). The daily job is silent on success; the weekly consumer is the only Slack surface.
- Do **NOT** re-implement Oxylabs POST inline. Use `lib/scrape-http.js`.
- Do **NOT** introduce delta-alerting in Phase 11 (see D-03).

</code_context>

<specifics>
## Specific Ideas

- Slack output for the weekly consumer is operator-locked to the "Compact + Booli−Hemnet gap row" mockup (see D-04).
- Sold totals are explicitly out, even though the JSON paths are known and would be a one-line addition. Re-introduce only via a future plan.

</specifics>

<deferred>
## Deferred Ideas

- **Sold / historic-sold totals.** JSON path known (`searchSales.total` on Hemnet, `searchSold.totalCount` on Booli). Trivial schema addition (`segment='sold'`). Operator deferred — revisit if a sold-side signal becomes useful.
- **Unexpected-delta alerting** (DoD or WoW thresholds per segment per platform). Deferred until 30+ days of baseline data is recorded. Revisit as a Plan 11-04 or a v2.3 phase. Need: choose between DoD ±20% (simple, catastrophe-only) and WoW ±10% (smoother but needs 7-day buffer); plus segment-specific tuning given Sweden's seasonality.
- **Per-municipality / per-county totals.** Out of scope per ROADMAP — top-level search pages only expose nationwide; per-area would require N×Oxylabs fan-out. Own milestone.
- **Long-horizon backfill.** Out of scope per ROADMAP — start fresh; historic sold totals are level-only, not deltas.
- **Cross-platform reconciliation analysis.** Out of scope per ROADMAP — analyst-side framing question, not a pipeline concern. See `[[project-booli-hemnet-totals-asymmetry]]` for the open analytical question.
- **Surfacing Kommande in the weekly Slack message.** Captured in `market_totals` but operator chose Till salu only for the weekly view. Easy add later — same output shape, swap segment.

</deferred>

<roadmap_updates_needed>
## ROADMAP edits the planner should apply

Apply these before or during plan-phase (consider `/gsd-phase edit 11` or an inline ROADMAP commit at the start of plan-phase):

1. **SC-1:** Change "writes 6 rows/day (Hemnet × 3 segments + Booli × 3 segments) on success" → **"writes 4 rows/day (Hemnet × 2 segments + Booli × 2 segments) on success — Till salu + Kommande only; Sold dropped during discuss"**.
2. **SC-2:** Drop the "or unexpected delta" clause. Final wording: **"warns to Slack on JSON-path-break or fetch failure"**.
3. **Out of scope clause:** Add **"Sold totals — operator-deferred during Phase 11 discuss; JSON paths known but reserved for a future plan"** to the existing out-of-scope list.

</roadmap_updates_needed>

---

*Phase: 11-daily-market-totals-capture-and-minimal-report*
*Context gathered: 2026-05-27*
