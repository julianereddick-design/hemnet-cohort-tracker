# Handover 04 — Reporting & Slack Output Layer

Reference for the operator inheriting `hemnet-cohort-tracker`. Covers every report that
reaches Slack, how Slack posting works technically, the chart/export artifacts, and how to
trigger or safely dry-run each one.

All paths are relative to the repo root:
`C:/Users/JulianReddick/Decade Partners/Investing - Companies/Hemnet/ClaudeCode Master - JR/hemnet-cohort-tracker`
(deployed on the droplet at `/opt/hemnet-cohort-tracker/`). Cron runs from the droplet clone;
all times below are **UTC**.

---

## 1. Routing by audience (READ THIS FIRST)

**As of the 2026-08-14 audience-routing split, `lib/slack-post.js` is the only outbound path**
for every report in this repo, with exactly one deliberate exception: `cron-wrapper.js`'s own
failure/warning alert (`postAlert`), which stays on a raw incoming webhook so that path shares
no failure mode with the bot token it exists to report on. No script builds its own `https`
call or reads `SLACK_WEBHOOK_URL` / `SLACK_BOT_TOKEN` directly any more — routing used to be
split by which *credential* a script happened to use (a webhook stream and a separate bot-token
stream), and that split was backwards: business reports and the human-review queue ended up
mixed across both. It is now split by **audience**, decided by the caller's job name, resolved
inside one module:

```
postMessage(job, text)   -> { ok, ts, channel }   // resolves the channel from AUDIENCE below
postAlert(text)          -> { ok }                // cron-wrapper's failure alert; webhook only
```

`AUDIENCE` in `lib/slack-post.js` (verbatim — this table and the code must never drift):

| Audience | Env var | Channel | Jobs |
|---|---|---|---|
| **business** — what the operator reads for insight | `SLACK_STATUS_CHANNEL` | `#hemnet-status` (`C0B9X2WDC4C`) | `weekly-view-report`, `market-totals-weekly-report`, `premarket-flow-weekly-report`, `sold-match-report`, `age-census-report` |
| **ops** — what the operator reads to run the system | `SLACK_OPS_CHANNEL` (falls back to the retired `SLACK_REVIEW_CHANNEL` while unset) | `#hemnet-ops` (`C0BQ66YQX8S`) | `cron-health-slack`, `cohort-spotcheck-gate` (the per-pair human review queue), `spotcheck-reaction-poller` (stale-review escalation), `cron-wrapper` (job failure/warning alerts) |

A job name absent from `AUDIENCE` is a **hard error at call time** — `resolveChannel` throws
naming the job — not a silent default. Run `node lib/slack-post.js --smoke` to confirm the
table and the repo agree (every job resolves to `business`/`ops`, every job in the table exists
as a script, no reporter still carries its own `sendSlack()` / reads `SLACK_WEBHOOK_URL`
directly).

**Transport:** `chat.postMessage` (bot token) is the transport behind `postMessage` for every
job. If it fails, `postMessage` falls back to the webhook and marks the result `degraded` — a
report may be mis-routed but must never be silently lost. `postAlert` (cron-wrapper's own
alert) uses the webhook only, by design, and never the bot token.

**Retired:** `SLACK_REVIEW_CHANNEL` (honoured only as `SLACK_OPS_CHANNEL`'s fallback while it is
unset — see deploy-instructions.md) and `SOLD_MATCH_SLACK_CHANNEL` (dropped outright;
`sold-match-report.js` now routes through the same `AUDIENCE` table as every other business
report — do not re-add a per-job channel override). The old two-transport split described in
prior versions of this document (a webhook stream vs. a `lib/spotcheck-slack-bot.js` bot-token
stream, each carrying an arbitrary mix of business and ops output) no longer exists — see git
history if you need it.

`lib/spotcheck-slack-bot.js` still exists and is still used by `cohort-spotcheck-gate.js` /
`spotcheck-reaction-poller.js`, but only for its reaction-reading mechanics
(`postReviewMessage`, `getReactions`) — it no longer decides *where* a message posts; channel
resolution for every job lives in `lib/slack-post.js`.

### ⚠️ The dotenv dry-run gotcha (critical) — and the local-run footgun it causes

Every entry script calls `require('dotenv').config()` at the top, which **re-injects
`SLACK_BOT_TOKEN` / `SLACK_WEBHOOK_URL` from `.env` into `process.env`**. Therefore:

```bash
env -u SLACK_BOT_TOKEN node sold-match-report.js   # DOES NOT DRY-RUN — it still POSTS
```

`env -u` clears the var in the shell, but dotenv puts it right back from `.env`. The var is
live again before any Slack call. **To genuinely avoid posting, use one of:**

1. Pass `--dry-run` (every reporter accepts it; renders to stdout via
   `--- DRY RUN: <job> -> C0… ---`, makes no network call). This is the primary, supported
   dry-run path as of the audience-routing split.
2. Run the script's offline `--smoke` self-test (no DB, no network — see each report below).
3. Inspect only the `console.log(message)` — all reports print the rendered message to stdout
   *before* the Slack call, so you can eyeball output without reading Slack.

**The footgun this creates: `postMessage` falls back to the webhook rather than skipping when
there is no bot token.** So a bare `node sold-match-report.js` (or any reporter) on a developer
machine whose `.env` happens to carry `SLACK_WEBHOOK_URL` **will post** — to whatever channel
that webhook targets. This is deliberate on `postMessage`'s part (a report must never be
silently lost), but it means "no `SLACK_BOT_TOKEN` set" is **not** a safe local no-op the way it
used to be under the old `lib/spotcheck-slack-bot.js`-only path (which returned `null` silently
with no token). Always use `--dry-run` locally; never rely on a missing token to keep a run
quiet.

---

## 2. Every report posted to Slack

### 2.1 Cron job failure/warning alerts — `cron-wrapper.js`

- **What:** Not a report per se. `cron-wrapper.runJob()` wraps every scheduled job; on a run
  whose `status` is `failure` or `warning` it fires ONE webhook line:
  `[FAILURE|WARNING] <script_name>: <error_message>` (`cron-wrapper.js:156-161`). Silent on
  success.
- **Transport / channel:** `lib/slack-post.js` `postAlert` — webhook only, by design (§1) →
  `#hemnet-ops` (`C0BQ66YQX8S`).
- **Cadence / trigger:** whenever any wrapped job (cohort-track, cohort-create, the Job A/B/C/D
  scrapers, market-totals-daily, sold-match-batch, cohort-spotcheck-gate, …) ends non-green.
- **Dry-run:** it only sends on failure/warning; run the wrapped job normally and it stays
  silent when healthy. No `--smoke`.

### 2.2 Daily health report — `cron-health-slack.js`

- **What:** Aggregates `cron_job_log` for `cohort-track` (25h window) and `cohort-create`
  (8-day window — weekly jobs get a weekly window as of 2026-08-13); adds a view-growth check (flags if ≥80% of pairs had zero incremental
  views) and per-cohort null-view-rate quality lines with a "canary" on the newest cohort.
  Overall header is `:white_check_mark: All healthy` or `:warning: N issue(s)`.
- **Script / transport:** `cron-health-slack.js` → `lib/slack-post.js` `postMessage('cron-health-slack', …)`
  (ops audience). Exits 1 if `SLACK_OPS_CHANNEL` (and its fallback `SLACK_REVIEW_CHANNEL`) are
  both unset — routing is resolved before any transport is touched, so a misconfigured box fails
  loudly rather than posting nowhere.
- **Cadence / channel / trigger:** daily **03:00 UTC**, `#hemnet-ops`, cron
  (`0 3 * * * node cron-health-slack.js`).
- **Sample shape:**
  ```
  *Hemnet Monitor — Daily Health Report*
  2026-07-28  |  :warning: 1 issue(s)

  :white_check_mark:  *cohort-track* (Daily)  —  1/1 succeeded
        Last: 2026-07-28 22:00 UTC  4.2s  tracked=812 cohorts=8
  ...
  :bar_chart:  *View Growth Check*  —  12/430 pairs (3%) had zero growth
  :mag:  *View Data Quality* (latest data)
        2026-W26: 4/120 null Booli (3%), 2/120 null Hemnet (2%)  ← canary

  *Issues:*
  • Cohort 2026-W25: 55% null Booli views
  ```
- **Manual trigger / dry-run:** `node cron-health-slack.js --dry-run` → renders
  `--- DRY RUN: cron-health-slack -> C0BQ66YQX8S ---` and posts nothing. `node cron-health-slack.js`
  (no flag) posts for real. No `--smoke`.

### 2.3 Weekly cohort view report — `weekly-view-report.js`

- **What:** Finds cohorts with ≥5 days of data (skips `2026-W09/W10/W11`), shells out to
  `export-hb-ratio-xlsx.js` per cohort and `export-cross-cohort-chart.js`, then posts a Slack
  message with **clickable links** to the generated charts hosted by `view-data-server.js`.
- **Script / transport:** `weekly-view-report.js` → `lib/slack-post.js` `postMessage('weekly-view-report', …)`
  (business audience). Also requires `VIEW_SERVER_HOST` (+ `VIEW_SERVER_PORT`, default 3800) to
  build links; skips Slack if it's missing (prints "Skipping Slack (VIEW_SERVER_HOST not set)").
- **Cadence / channel / trigger:** Mondays **09:30 UTC**, `#hemnet-status`, cron.
- **Sample shape:**
  ```
  :bar_chart: *Weekly Cohort View Report — 2026-07-27*
  Cohorts: 2026-W20, 2026-W22, 2026-W24, 2026-W26

  <http://HOST:3800/view-data/2026-07-27/cross-cohort-hpct.html|:chart_with_upwards_trend: Cross-Cohort H% Chart>
  Per-cohort charts: <http://HOST:3800/view-data/2026-07-27/2026-W20/charts.html|2026-W20>  ...
  ```
- **Manual trigger / dry-run:** `node weekly-view-report.js --dry-run` → regenerates xlsx/charts
  (DB reads, no scraping) but renders the Slack message to stdout instead of posting. No
  `--smoke`.

### 2.4 Market supply pulse — `market-totals-weekly-report.js`

- **What:** Reads `market_totals` for `(today, today-7) × {hemnet, booli} × {till_salu,
  kommande}`; renders two monospace blocks (For Sale, Pre-market) with prior→current, absolute
  and % WoW deltas, and a `Booli − Hemnet` gap row. Missing rows render `?` (never crashes).
- **Script / transport:** `market-totals-weekly-report.js` → `lib/slack-post.js`
  `postMessage('market-totals-weekly-report', …)` (business audience).
- **Cadence / channel / trigger:** Mondays **09:35 UTC**, `#hemnet-status`, cron.
- **Sample shape** (fenced monospace):
  ```
  Market supply pulse — week of 2026-07-27

  Till salu (For Sale)
  Hemnet:           45,102 →   45,880   (+778, +1.7%)
  Booli:            53,900 →   54,410   (+510, +0.9%)
  Booli − Hemnet:    8,798 →    8,530   (−268)

  Kommande (Pre-market)
  Hemnet:            3,120 →    3,090   (−30, −1.0%)
  ...
  ```
- **Manual trigger / dry-run:** `REPORT_DATE=2026-07-27 node market-totals-weekly-report.js --dry-run` —
  `REPORT_DATE` re-runs a past week; `--dry-run` renders and posts nothing. No `--smoke`.

### 2.5 Pre-market flow pulse — `premarket-flow-weekly-report.js`

- **What:** Reads `premarket_flow_weekly` for `(today, today-7)` per platform; renders a
  three-column block (Hemnet / Booli / ratio) for stock, 7-day adds, mean dwell, plus "Hemnet
  fresh adds as % of Booli" and WoW adds. Companion to `scripts/premarket-flow-measure.js`
  (the measurement job that populates the table). `?` on missing rows.
- **Script / transport:** `premarket-flow-weekly-report.js` → `lib/slack-post.js`
  `postMessage('premarket-flow-weekly-report', …)` (business audience).
- **Cadence / channel / trigger:** Mondays **09:40 UTC**, `#hemnet-status`, cron.
- **Sample shape:**
  ```
  Pre-market flow pulse — last 7 days to 2026-07-27  (2nd-hand, national)

                       Hemnet       Booli  Booli/Hemnet
  Stock (2nd-hand):     3,090       12,450        4.03×
  Adds (last 7d):         410          520        1.27×
  Mean dwell:             41d          78d        1.90×

  Hemnet fresh adds as % of Booli: 78.8%
  WoW adds — Hemnet: 395 → 410 (+15, +3.8%)
             Booli:  500 → 520 (+20, +4.0%)
  ```
- **Manual trigger / dry-run:** `REPORT_DATE=2026-07-27 node premarket-flow-weekly-report.js --dry-run`.
  Also has a `--smoke` self-test (offline, no DB, no network).

### 2.6 Sold-match weekly match-rate — `sold-match-report.js`

- **What:** The **minimal** weekly message (blank-slate redesign 2026-07-07): a most-recent-first
  table of Matched-on-Hemnet % + sample size `n` for the last 5 fortnightly cohorts, plus a link
  to the trend chart. Reuses `buildSeries` from `sold-match-trend-chart.js` so the % and the
  chart agree. Excludes `2026-W12` pilot (`EXCLUDED_COHORTS`).
  - The file still contains the older **detailed** renderer (`renderReport`: settled
    genuine-non-Hemnet decision-grade rate vs preliminary lag-contaminated booli_only rate,
    per-region / per-type / overlay blocks) — **dormant, not posted** by `run()`.
- **Script / transport:** `sold-match-report.js` → `lib/slack-post.js` `postMessage('sold-match-report', …)`
  (business audience, `SLACK_STATUS_CHANNEL`). Chart link needs `VIEW_SERVER_HOST` (+ port 3800).
  As of the audience-routing split this no longer posts via `lib/spotcheck-slack-bot.js`'s
  `postInfoMessage` — that helper never consulted `isDryRun()` (only bare `SLACK_BOT_TOKEN`
  presence), so `--dry-run` would have looked safe while still posting for real. A failed or
  throwing post now sets a non-zero exit code (`process.exitCode = 1`) rather than swallowing
  the error silently.
- **Cadence / channel / trigger:** Mondays **11:00 UTC** (after the fortnightly
  `sold-match-batch.js` at 07:30), `#hemnet-status`, cron.
- **Known monitoring gap:** unlike most scheduled scripts, `sold-match-report.js` is **not**
  wrapped by `cron-wrapper.runJob`, so it writes no `cron_job_log` row — a failed Monday post
  (now correctly non-zero-exit) is invisible to `cron-health-slack.js`, which only reads
  `cron_job_log`. Closing this is scoped to the separate health-monitoring workstream (design
  spec §5, Class 1 — widening the reporter registry to jobs that don't yet log), not this
  change.
- **Sample shape:**
  ```
  :bar_chart: *Sold-match — Matched on Hemnet*

  ```
  week        matched      n
  2026-W28      77.0%     985
  2026-W26      78.8%    1467
  2026-W25      76.1%      67
  ```
  :chart_with_upwards_trend: <http://HOST:3800/view-data/2026-07-28/sold-match/trend.html|Historical chart>
  ```
- **Manual trigger / dry-run:**
  - `node sold-match-report.js --smoke` → **offline self-test, no DB, no Slack.**
  - `node sold-match-report.js --dry-run` → DB read (read-only), renders
    `--- DRY RUN: sold-match-report -> C0B9X2WDC4C ---`, posts nothing. This is now the
    supported way to check the live data against the routing table without posting.
  - `node sold-match-report.js` (no flag) → live: DB read + posts for real. Remember the local
    footgun in §1 — with no `SLACK_BOT_TOKEN`, this now falls back to the webhook rather than
    silently skipping.

### 2.7 Spot-check review queue — `cohort-spotcheck-gate.js` (+ `spotcheck-reaction-poller.js`)

- **What (gate):** The Phase-12/13 weekly QA gate samples the new cohort, adjudicates
  Booli↔Hemnet pair quality (dHash + optional Claude vision), and for each MISMATCH / UNCERTAIN
  pair posts **one review message per pair** (own `ts`, so a reaction targets exactly that pair)
  via `postReviewMessage`. Unreviewable/delisted pairs arrive as one `postInfoMessage` summary.
  Each review message carries clickable Hemnet + Booli URLs, the dHash/vision summary, the
  verdict reason, and the emoji legend `React: ✅ confirm mismatch · ❌ override, valid match · ❓ unsure`.
  Separately, `cron-wrapper` fires a `postAlert` webhook alert if the confirmed false-match rate
  exceeds threshold (default 5%) or any Hemnet fetch failed.
- **What (poller):** `spotcheck-reaction-poller.js` READS reactions (`getReactions`) on open
  review messages, applies verdicts (✅ soft-removes the pair, ❌ keeps + records override, ❓
  leaves it), and escalates a stale-review count to `validate()` (→ `cron-wrapper`'s own
  `postAlert` webhook) if items sit unanswered > `STALE_REVIEW_DAYS` (default 7). Only reactions
  from `SLACK_ALLOWED_REACTORS` count.
- **Script / transport:** both resolve their channel via `lib/slack-post.js`
  `resolveChannel('cohort-spotcheck-gate')` / `resolveChannel('spotcheck-reaction-poller')` — both
  **ops** audience, resolving to `SLACK_OPS_CHANNEL` — and skip (log + return) rather than throw
  if it comes back unset. `lib/spotcheck-slack-bot.js` still supplies the actual posting and
  reaction-reading mechanics against that resolved channel (`postReviewMessage`,
  `postInfoMessage`, `getReactions`) — it no longer decides the destination itself; that
  resolution moved to `lib/slack-post.js` as part of the split (the review queue's audience moved
  too: it used to sit in `#hemnet-status`, now it's in `#hemnet-ops`, since it's work the
  operator does, not a business read).
- **Cadence / channel / trigger:** gate Mondays **06:30 UTC** (30 min after cohort-create);
  poller **daily 12:00 UTC**; `#hemnet-ops`; cron.
- **Sample review message:**
  ```
  [REVIEW] MISMATCH pair 8412 — Storgatan 5
  Hemnet: https://www.hemnet.se/bostad/21706244
  Booli:  https://www.booli.se/annons/5626686
  dHash: no shared photo (minDist 23) | vision: no shared photo
  Why: price agrees but no shared photo
  React: ✅ confirm mismatch (remove) · ❌ override, valid match (keep) · ❓ unsure (leave)
  ```
- **Dry-run:**
  - `node lib/spotcheck-slack-bot.js --smoke` → offline unit self-test of the bot helper (the
    reaction-contract regression gate).
  - `node lib/slack-post.js --smoke` → offline self-test of the routing table + `postMessage` /
    `postAlert`, including a coverage check that both `cohort-spotcheck-gate` and
    `spotcheck-reaction-poller` still resolve to the `ops` audience.
  - Gate/poller run locally are safe by construction: without `SLACK_BOT_TOKEN` set,
    `resolveChannel` still resolves a channel id (routing doesn't need the token), but
    `postReviewMessage` / `getReactions` return `null` with no token — no post, no crash. On the
    droplet they DO post — there is no `env -u` escape (§1).

---

## 3. Reporting cadence table

| Report | Script | Cadence (UTC) | Audience → Channel | Trigger |
|---|---|---|---|---|
| Job failure/warning alert | `cron-wrapper.js` (`postAlert`) | event-driven (any non-green wrapped run) | ops → `#hemnet-ops` (webhook only) | inside each cron job |
| Daily health report | `cron-health-slack.js` | daily 03:00 | ops → `#hemnet-ops` | `0 3 * * *` |
| Spot-check review queue | `cohort-spotcheck-gate.js` | Mon 06:30 | ops → `#hemnet-ops` | `30 6 * * 1` |
| Sold-match batch escalation | `sold-match-batch.js` (via cron-wrapper `postAlert`) | Mon 07:30 (fortnightly effect) | ops → `#hemnet-ops` | `30 7 * * 1` |
| Weekly cohort view report | `weekly-view-report.js` | Mon 09:30 | business → `#hemnet-status` | `30 9 * * 1` |
| Market supply pulse | `market-totals-weekly-report.js` | Mon 09:35 | business → `#hemnet-status` | `35 9 * * 1` |
| Pre-market flow pulse | `premarket-flow-weekly-report.js` | Mon 09:40 | business → `#hemnet-status` | `40 9 * * 1` |
| Age-penetration census | `age-census-report.js` | monthly, 1st 07:00 | business → `#hemnet-status` | `0 7 1 * *` |
| Sold-match match-rate summary | `sold-match-report.js` | Mon 11:00 | business → `#hemnet-status` | `0 11 * * 1` |
| Spot-check reaction poller (+ stale alert) | `spotcheck-reaction-poller.js` | daily 12:00 | ops → `#hemnet-ops` (reads); stale alert via `cron-wrapper` `postAlert` | `0 12 * * *` |
| Market-totals daily capture (silent) | `market-totals-daily.js` | daily 08:30 | ops → `#hemnet-ops`, only on failure/warning (via `cron-wrapper` `postAlert`) | `30 8 * * *` |

All routing above resolves through the `AUDIENCE` table in `lib/slack-post.js` (§1) — this table
is schedule/channel documentation, not a second source of truth for *which* audience a job gets;
if the two ever disagree, `lib/slack-post.js` wins. `node lib/slack-post.js --smoke` checks the
table is internally consistent (every job resolves, every job exists as a script) but does not
check schedule — confirm the live droplet crontab with `crontab -l` before trusting the Cadence
column here; the doc has drifted before. Source of truth for the schedule itself:
`deploy-instructions.md` (crontab blocks).

---

## 4. Charts & exports (artifacts, NOT posted directly to Slack)

These generate HTML charts / xlsx / csv. HTML charts are written under
`view-data/<run-date>/…` and served by **`view-data-server.js` on port 3800** (linked from the
weekly Slack reports as clickable full URLs). xlsx/csv are written to disk (`view-data/…` or
`exports/`) and shared out-of-band. All Chart.js pages load `chart.js@4` from jsDelivr CDN.

| Builder | Output | Where linked / hosted |
|---|---|---|
| `chart-hb-ratio.js` | `view-data/<date>/<cohort>/hb-ratio-chart.html` + `hb-ratio-summary.csv` + `hb-ratio-detail.csv` | port-3800 server (ad-hoc) |
| `export-hb-ratio-xlsx.js` | `view-data/<date>/<cohort>/hb-ratio-<cohort>.xlsx` + `charts.html` | called by `weekly-view-report.js`; linked in its Slack post |
| `export-cross-cohort-chart.js` | `view-data/<date>/cross-cohort-hpct.html` | linked in `weekly-view-report.js` Slack post |
| `sold-match-trend-chart.js` | `view-data/<date>/sold-match/trend.html` (stacked bar: matched first-pull + found-later) | linked in `sold-match-report.js` Slack post |
| `sold-match-xlsx.js` | `view-data/<date>/sold-match/sold-audit-<cohort>.xlsx` (per-cohort audit, clickable links) | on-disk audit artifact |
| `scripts/export-sold-match.js` | `view-data/<label>/sold-match/sold-match-national-<label>.xlsx` + `.csv` (Records / Uncertain / Summary sheets) | read-only export by created_at date |
| `scripts/adcost-report.py` | `exports/adcost-all-data.xlsx` + `exports/adcost-heatmap.html` (8-county × tier heat map + weighted ARPL, inc-25%-moms) | **local only — not on Slack** (see §5) |
| `scripts/build-market-totals-dashboard.js` | `market-totals-dashboard.html` (4 supply charts) | WIP, not deployed (see §5) |
| `scripts/build-supply-universes-xlsx.js` | `exports/hemnet-booli-supply-universes.xlsx` (7 tabs) | ad-hoc |

### Rule: export links must be clickable full URLs

`feedback_exports_clickable_full_urls`: every Booli/Hemnet link in a report or export must be a
**clickable full URL**, never a raw `/bostad/<id>` path. The canonical builders in
`sold-match-xlsx.js` are the single source of truth and are re-imported by
`scripts/export-sold-match.js`:
- `booliUrl(r)` → prefers `residence_url`, else `https://www.booli.se/bostad/<booli_id>`
- `hemnetUrl(slug, method)` → `https://www.hemnet.se/salda/<slug>` (or `/bostad/` only for the
  SERP bridge)
- `hemnetSearchUrl(r)` → `https://www.google.com/search?q=site:hemnet.se "<addr>" <area>` for
  unmatched rows (a manual check link)

The bot-helper `lib/spotcheck-slack-bot.js` uses `https://www.booli.se/annons/<booli_id>` for
the **live** review-queue listing (the `/annons` path resolves to the current ad).

Excel builders use **ExcelJS** (`{ text, hyperlink }` cells) except `adcost-report.py`, which
uses Python **openpyxl** (color-scale conditional formatting).

---

## 5. Reports built but NOT yet wired to Slack

Two dashboards produce files but have **no Slack delivery** because the Slack app lacks the
`files:write` scope (the bot token currently has only `chat:write` + `reactions:read`; the
audience-routing split in §1 did not add it — that work only needed `chat:write`). **Still
outstanding as of 2026-08-14.** Adding files delivery requires Julian to add `files:write` and
reinstall the app — Claude cannot touch Slack admin. Details in `MARKET-TOTALS-REPORTING-WIP.md`
and design spec §4 (`uploadFiles`, not yet built).

1. **Ad-cost (Phase 28)** — `scripts/adcost-report.py` produces `exports/adcost-all-data.xlsx`
   and `exports/adcost-heatmap.html` from the `hemnet_adcostv2` table (shared `defaultdb`).
   Weighted ARPL uses `data/arpl-baseline.json`. Rerunnable, **local/manual only** — run
   `python scripts/adcost-report.py` (needs `psycopg` + `openpyxl` + DB whitelist). Note the
   2026-03-16→06-30 no-backfill gap that blanks WoW until two adjacent post-resume weeks exist.
2. **Market-totals dashboard** — `scripts/build-market-totals-dashboard.js` +
   `scripts/build-supply-universes-xlsx.js`. Written, not deployed; delivery decision open
   (Slack file upload vs git-commit vs local).

---

## 6. Quick reference — safe offline self-tests and dry-runs

Every reporter accepts `--dry-run` (renders `--- DRY RUN: <job> -> C0… ---` to stdout, makes no
network call — see §1). This is the primary, supported way to check a report without posting:

```bash
node cron-health-slack.js --dry-run                    # -> ops (C0BQ66YQX8S)
node weekly-view-report.js --dry-run                   # -> business (C0B9X2WDC4C)
node market-totals-weekly-report.js --dry-run           # -> business
node premarket-flow-weekly-report.js --dry-run          # -> business
node sold-match-report.js --dry-run                     # -> business
node age-census-report.js --dry-run                      # -> business
```

Scripts with a fully-offline `--smoke` (no DB, no network, no Slack — exercises render logic and,
for `lib/slack-post.js`, the routing table itself):

```bash
node lib/slack-post.js --smoke             # routing table, postMessage/postAlert, doc-vs-code coverage
node sold-match-report.js --smoke          # weekly match-rate + dormant detailed renderer
node sold-match-trend-chart.js --smoke     # trend stacked-bar HTML
node sold-match-xlsx.js --smoke            # per-cohort audit workbook
node scripts/export-sold-match.js --smoke  # national export (rows/links/summary/csv)
node lib/spotcheck-slack-bot.js --smoke    # bot helper (post/reactions parsers)
node premarket-flow-weekly-report.js --smoke
node age-census-report.js --smoke
```

`node lib/slack-post.js --smoke` is the one to run after touching anything Slack-related — it
asserts the `AUDIENCE` table and the repo agree (every job resolves to `business`/`ops`, every
job in the table exists as a script, no reporter still hand-rolls its own `sendSlack()` or reads
`SLACK_WEBHOOK_URL` directly), so a new reporter that forgets to register itself fails loudly
here instead of defaulting silently to the wrong channel.
