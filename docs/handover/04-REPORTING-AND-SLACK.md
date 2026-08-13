# Handover 04 — Reporting & Slack Output Layer

Reference for the operator inheriting `hemnet-cohort-tracker`. Covers every report that
reaches Slack, how Slack posting works technically, the chart/export artifacts, and how to
trigger or safely dry-run each one.

All paths are relative to the repo root:
`C:/Users/JulianReddick/Decade Partners/Investing - Companies/Hemnet/ClaudeCode Master - JR/hemnet-cohort-tracker`
(deployed on the droplet at `/opt/hemnet-cohort-tracker/`). Cron runs from the droplet clone;
all times below are **UTC**.

---

## 1. The two Slack transports (READ THIS FIRST)

There are **two entirely separate Slack integrations**. They are NOT interchangeable
(`SLACK-REVIEW-SETUP.md` §note).

### A. Incoming webhook — `SLACK_WEBHOOK_URL` (text only)

- A plain Slack incoming webhook. **Text-only**; cannot read reactions, cannot upload files.
- Value lives in `.env`: `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...`
  (present in the local `.env` — points at workspace `T01JZJN4HT5`).
- **No shared helper library.** Each consumer carries its own near-identical `sendSlack()` /
  `sendSlackAlert()` that does `https.request(POST, {text})` to the webhook URL. The canonical
  copy is `market-totals-weekly-report.js:13-34`; `premarket-flow-weekly-report.js`,
  `weekly-view-report.js`, and `cron-health-slack.js` each duplicate it verbatim, and
  `cron-wrapper.js:32` has the alert variant.
- Posts to whatever channel the webhook was created against (operator-named "Hemnet Status" in
  the runbook).
- Consumers: `cron-wrapper.js` (job failure/warning alerts), `cron-health-slack.js`,
  `market-totals-weekly-report.js`, `premarket-flow-weekly-report.js`, `weekly-view-report.js`.

### B. Bot token — `SLACK_BOT_TOKEN` (chat.postMessage + reactions.read)

- A Slack **bot OAuth token** (`xoxb-…`), scopes `chat:write` + `reactions:read`. Set up via
  `SLACK-REVIEW-SETUP.md`.
- The single shared helper is **`lib/spotcheck-slack-bot.js`** — raw HTTPS to
  `slack.com/api/<method>` with `Authorization: Bearer <token>`. Exports:
  `postReviewMessage`, `postInfoMessage`, `postDigestMessage` (legacy), `getReactions`.
  **Every function returns `null` silently when `SLACK_BOT_TOKEN` is unset** (`token()` guard,
  `lib/spotcheck-slack-bot.js:25`).
- Target channel = env `SLACK_REVIEW_CHANNEL` (a channel **ID** `C0…`, not a name; the bot must
  be `/invite`d). `sold-match-report.js` prefers `SOLD_MATCH_SLACK_CHANNEL` and falls back to
  `SLACK_REVIEW_CHANNEL`.
- Consumers: `cohort-spotcheck-gate.js` (posts review messages), `spotcheck-reaction-poller.js`
  (reads reactions), `sold-match-report.js` (posts the weekly match-rate summary).

> **`SLACK_BOT_TOKEN`, `SLACK_REVIEW_CHANNEL`, `SLACK_ALLOWED_REACTORS` live only in the droplet
> `.env`** — they are NOT in the local repo `.env` (which has only `SLACK_WEBHOOK_URL`). Any
> bot-token report is a no-op locally unless you add them.

### ⚠️ The dotenv dry-run gotcha (critical)

Every entry script calls `require('dotenv').config()` at the top, which **re-injects
`SLACK_BOT_TOKEN` / `SLACK_WEBHOOK_URL` from `.env` into `process.env`**. Therefore:

```bash
env -u SLACK_BOT_TOKEN node sold-match-report.js   # DOES NOT DRY-RUN — it still POSTS
```

`env -u` clears the var in the shell, but dotenv puts it right back from `.env`. The var is
live again before any Slack call. **To genuinely avoid posting, use one of:**

1. Run the script's offline `--smoke` self-test (no DB, no network — see each report below).
2. Run from a directory / environment where `.env` does **not** contain the token (e.g. the
   local repo, where the bot token is absent → `lib/spotcheck-slack-bot.js` returns `null`).
3. Temporarily comment the var out of `.env` (then restore).
4. Inspect only the `console.log(message)` — all reports print the rendered message to stdout
   *before* the Slack call, so you can eyeball output without reading Slack.

---

## 2. Every report posted to Slack

### 2.1 Cron job failure/warning alerts — `cron-wrapper.js`

- **What:** Not a report per se. `cron-wrapper.runJob()` wraps every scheduled job; on a run
  whose `status` is `failure` or `warning` it fires ONE webhook line:
  `[FAILURE|WARNING] <script_name>: <error_message>` (`cron-wrapper.js:156-161`). Silent on
  success.
- **Transport / channel:** webhook (`SLACK_WEBHOOK_URL`) → "Hemnet Status".
- **Cadence / trigger:** whenever any wrapped job (cohort-track, cohort-create, the Job A/B/C/D
  scrapers, market-totals-daily, sold-match-batch, cohort-spotcheck-gate, …) ends non-green.
- **Dry-run:** it only sends on failure/warning; run the wrapped job normally and it stays
  silent when healthy. No `--smoke`.

### 2.2 Daily health report — `cron-health-slack.js`

- **What:** Aggregates `cron_job_log` for `cohort-track` (25h window) and `cohort-create`
  (8-day window — weekly jobs get a weekly window as of 2026-08-13); adds a view-growth check (flags if ≥80% of pairs had zero incremental
  views) and per-cohort null-view-rate quality lines with a "canary" on the newest cohort.
  Overall header is `:white_check_mark: All healthy` or `:warning: N issue(s)`.
- **Script / transport:** `cron-health-slack.js`, webhook (`SLACK_WEBHOOK_URL`). Exits 1 if the
  webhook is unset (it always posts — no skip branch, no `--smoke`).
- **Cadence / channel / trigger:** daily **03:00 UTC**, "Hemnet Status", cron
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
- **Manual trigger / dry-run:** `node cron-health-slack.js` — **always posts** if `SLACK_WEBHOOK_URL`
  is set. To avoid posting, run where `.env` lacks the webhook, or comment it out.

### 2.3 Weekly cohort view report — `weekly-view-report.js`

- **What:** Finds cohorts with ≥5 days of data (skips `2026-W09/W10/W11`), shells out to
  `export-hb-ratio-xlsx.js` per cohort and `export-cross-cohort-chart.js`, then posts a Slack
  message with **clickable links** to the generated charts hosted by `view-data-server.js`.
- **Script / transport:** `weekly-view-report.js`, webhook (`SLACK_WEBHOOK_URL`). Also requires
  `VIEW_SERVER_HOST` (+ `VIEW_SERVER_PORT`, default 3800) to build links; skips Slack if either
  is missing.
- **Cadence / channel / trigger:** Mondays **09:30 UTC**, "Hemnet Status", cron.
- **Sample shape:**
  ```
  :bar_chart: *Weekly Cohort View Report — 2026-07-27*
  Cohorts: 2026-W20, 2026-W22, 2026-W24, 2026-W26

  <http://HOST:3800/view-data/2026-07-27/cross-cohort-hpct.html|:chart_with_upwards_trend: Cross-Cohort H% Chart>
  Per-cohort charts: <http://HOST:3800/view-data/2026-07-27/2026-W20/charts.html|2026-W20>  ...
  ```
- **Manual trigger / dry-run:** `node weekly-view-report.js`. It regenerates xlsx/charts (DB
  reads, no scraping) and posts. Unset `VIEW_SERVER_HOST` or `SLACK_WEBHOOK_URL` to skip the
  post. No `--smoke`.

### 2.4 Market supply pulse — `market-totals-weekly-report.js`

- **What:** Reads `market_totals` for `(today, today-7) × {hemnet, booli} × {till_salu,
  kommande}`; renders two monospace blocks (For Sale, Pre-market) with prior→current, absolute
  and % WoW deltas, and a `Booli − Hemnet` gap row. Missing rows render `?` (never crashes).
- **Script / transport:** `market-totals-weekly-report.js`, webhook (`SLACK_WEBHOOK_URL`).
- **Cadence / channel / trigger:** Mondays **09:35 UTC**, "Hemnet Status", cron.
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
- **Manual trigger / dry-run:** `REPORT_DATE=2026-07-27 node market-totals-weekly-report.js` —
  `REPORT_DATE` re-runs a past week. **Posts if `SLACK_WEBHOOK_URL` is set**; unset it (or run
  locally without it) to only print. No `--smoke`.

### 2.5 Pre-market flow pulse — `premarket-flow-weekly-report.js`

- **What:** Reads `premarket_flow_weekly` for `(today, today-7)` per platform; renders a
  three-column block (Hemnet / Booli / ratio) for stock, 7-day adds, mean dwell, plus "Hemnet
  fresh adds as % of Booli" and WoW adds. Companion to `scripts/premarket-flow-measure.js`
  (the measurement job that populates the table). `?` on missing rows.
- **Script / transport:** `premarket-flow-weekly-report.js`, webhook (`SLACK_WEBHOOK_URL`).
- **Cadence / channel / trigger:** Mondays **09:40 UTC**, "Hemnet Status", cron.
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
- **Manual trigger / dry-run:** `REPORT_DATE=2026-07-27 node premarket-flow-weekly-report.js`.
  Same webhook dry-run caveat as 2.4. No `--smoke`.

### 2.6 Sold-match weekly match-rate — `sold-match-report.js`

- **What:** The **minimal** weekly message (blank-slate redesign 2026-07-07): a most-recent-first
  table of Matched-on-Hemnet % + sample size `n` for the last 5 fortnightly cohorts, plus a link
  to the trend chart. Reuses `buildSeries` from `sold-match-trend-chart.js` so the % and the
  chart agree. Excludes `2026-W12` pilot (`EXCLUDED_COHORTS`).
  - The file still contains the older **detailed** renderer (`renderReport`: settled
    genuine-non-Hemnet decision-grade rate vs preliminary lag-contaminated booli_only rate,
    per-region / per-type / overlay blocks) — **dormant, not posted** by `run()`.
- **Script / transport:** `sold-match-report.js` → `lib/spotcheck-slack-bot.js` `postInfoMessage`
  (**bot token**). Channel = `SOLD_MATCH_SLACK_CHANNEL` || `SLACK_REVIEW_CHANNEL`. Chart link
  needs `VIEW_SERVER_HOST` (+ port 3800).
- **Cadence / channel / trigger:** Mondays **11:00 UTC** (after the fortnightly
  `sold-match-batch.js` at 07:30), bot-token channel, cron.
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
  - `node sold-match-report.js --smoke` → **offline self-test, no DB, no Slack** (deletes the
    token for the run). This is the safe dry-run.
  - `node sold-match-report.js` → live: DB read + posts if `SLACK_BOT_TOKEN` set. Remember the
    dotenv gotcha — `env -u SLACK_BOT_TOKEN` will NOT stop the post on the droplet.

### 2.7 Spot-check review queue — `cohort-spotcheck-gate.js` (+ `spotcheck-reaction-poller.js`)

- **What (gate):** The Phase-12/13 weekly QA gate samples the new cohort, adjudicates
  Booli↔Hemnet pair quality (dHash + optional Claude vision), and for each MISMATCH / UNCERTAIN
  pair posts **one review message per pair** (own `ts`, so a reaction targets exactly that pair)
  via `postReviewMessage`. Unreviewable/delisted pairs arrive as one `postInfoMessage` summary.
  Each review message carries clickable Hemnet + Booli URLs, the dHash/vision summary, the
  verdict reason, and the emoji legend `React: ✅ confirm mismatch · ❌ override, valid match · ❓ unsure`.
  Separately, `cron-wrapper` fires a **webhook** alert if the confirmed false-match rate exceeds
  threshold (default 5%) or any Hemnet fetch failed.
- **What (poller):** `spotcheck-reaction-poller.js` READS reactions (`getReactions`) on open
  review messages, applies verdicts (✅ soft-removes the pair, ❌ keeps + records override, ❓
  leaves it), and fires a webhook stale-alert if items sit unanswered > `STALE_REVIEW_DAYS`
  (default 7). Only reactions from `SLACK_ALLOWED_REACTORS` count.
- **Script / transport:** both use `lib/spotcheck-slack-bot.js` (**bot token**), channel
  `SLACK_REVIEW_CHANNEL`.
- **Cadence / channel / trigger:** gate Mondays **06:30 UTC** (30 min after cohort-create);
  poller **daily 12:00 UTC**; bot-token review channel; cron.
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
  - `node lib/spotcheck-slack-bot.js --smoke` → offline unit self-test of the bot helper.
  - Gate/poller run locally are safe by construction: without `SLACK_BOT_TOKEN` in the local
    `.env` the helper returns `null` (no post). On the droplet they DO post — no `env -u` escape.

---

## 3. Reporting cadence table

| Report | Script | Cadence (UTC) | Transport → Channel | Trigger |
|---|---|---|---|---|
| Job failure/warning alert | `cron-wrapper.js` (`sendSlackAlert`) | event-driven (any non-green wrapped run) | webhook → Hemnet Status | inside each cron job |
| Daily health report | `cron-health-slack.js` | daily 03:00 | webhook → Hemnet Status | `0 3 * * *` |
| Spot-check review queue | `cohort-spotcheck-gate.js` | Mon 06:30 | bot token → `SLACK_REVIEW_CHANNEL` | `30 6 * * 1` |
| Sold-match batch escalation | `sold-match-batch.js` (via cron-wrapper) | Mon 07:30 (fortnightly effect) | webhook → Hemnet Status | `30 7 * * 1` |
| Weekly cohort view report | `weekly-view-report.js` | Mon 09:30 | webhook → Hemnet Status | `30 9 * * 1` |
| Market supply pulse | `market-totals-weekly-report.js` | Mon 09:35 | webhook → Hemnet Status | `35 9 * * 1` |
| Pre-market flow pulse | `premarket-flow-weekly-report.js` | Mon 09:40 | webhook → Hemnet Status | `40 9 * * 1` |
| Sold-match match-rate summary | `sold-match-report.js` | Mon 11:00 | bot token → `SOLD_MATCH_SLACK_CHANNEL`/`SLACK_REVIEW_CHANNEL` | `0 11 * * 1` |
| Spot-check reaction poller (+ stale alert) | `spotcheck-reaction-poller.js` | daily 12:00 | bot token (reads) + webhook (stale alert) | `0 12 * * *` |
| Market-totals daily capture (silent) | `market-totals-daily.js` | daily 08:30 | webhook only on failure/warning | `30 8 * * *` |

Source of truth for the schedule: `deploy-instructions.md` (crontab blocks). Confirm the live
droplet crontab with `crontab -l` before trusting this table — the doc has drifted before.

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
`files:write` scope (webhooks are text-only; the bot token has only `chat:write` +
`reactions:read`). Adding files delivery requires Julian to add `files:write` and reinstall the
app — Claude cannot touch Slack admin. Details in `MARKET-TOTALS-REPORTING-WIP.md`.

1. **Ad-cost (Phase 28)** — `scripts/adcost-report.py` produces `exports/adcost-all-data.xlsx`
   and `exports/adcost-heatmap.html` from the `hemnet_adcostv2` table (shared `defaultdb`).
   Weighted ARPL uses `data/arpl-baseline.json`. Rerunnable, **local/manual only** — run
   `python scripts/adcost-report.py` (needs `psycopg` + `openpyxl` + DB whitelist). Note the
   2026-03-16→06-30 no-backfill gap that blanks WoW until two adjacent post-resume weeks exist.
2. **Market-totals dashboard** — `scripts/build-market-totals-dashboard.js` +
   `scripts/build-supply-universes-xlsx.js`. Written, not deployed; delivery decision open
   (Slack file upload vs git-commit vs local).

---

## 6. Quick reference — safe offline self-tests

Scripts with a fully-offline `--smoke` (no DB, no network, no Slack — the safest way to
exercise the render logic):

```bash
node sold-match-report.js --smoke          # weekly match-rate + dormant detailed renderer
node sold-match-trend-chart.js --smoke     # trend stacked-bar HTML
node sold-match-xlsx.js --smoke            # per-cohort audit workbook
node scripts/export-sold-match.js --smoke  # national export (rows/links/summary/csv)
node lib/spotcheck-slack-bot.js --smoke    # bot helper (post/reactions parsers)
```

The webhook reports (`cron-health-slack.js`, `market-totals-weekly-report.js`,
`premarket-flow-weekly-report.js`, `weekly-view-report.js`) have **no `--smoke`** — they always
attempt to post when `SLACK_WEBHOOK_URL` is set. Dry-run them by running where `.env` lacks the
webhook, or by reading the `console.log(message)` they print before posting.
