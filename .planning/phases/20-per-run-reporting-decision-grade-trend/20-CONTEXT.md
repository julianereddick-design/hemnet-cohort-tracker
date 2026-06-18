# Phase 20: Per-run reporting + decision-grade trend - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning
**Source:** v3.1 milestone + operator decisions 2026-06-18 (national panel sample)

<domain>
## Phase Boundary

Two reporting outputs over the sold-match results: (1) a **per-run Slack summary** (per segment: matched / booli_only / re-check-resolved-late / settled-non-Hemnet counts + rates) and (2) a **committed-HTML over-time trend chart** (match rate + the settled genuine-non-Hemnet rate, per segment/region, fortnightly). The **settled (post-re-check) genuine-non-Hemnet rate is the decision-grade headline**, reported distinctly from the raw/instantaneous `booli_only` rate so slutpris-lag contamination is never read as genuine non-Hemnet presence.

**In scope:** REPORT-01, REPORT-02, REPORT-03. **Out of scope:** any matcher/sampler change; new BI/dashboard stack (reuse the committed-HTML-chart family).
</domain>

<decisions>
## Implementation Decisions (LOCKED)

- **D-01 Two standalone scripts** (repo root, siblings of `market-totals-weekly-report.js` / `chart-hb-ratio.js`): `sold-match-report.js` (Slack summary) + `sold-match-trend-chart.js` (committed HTML). Both open their own `createClient()` (db.js), query, `client.end()` in finally. Standalone so they run independently AND can be invoked by the Phase-19 orchestrator at end-of-run (a small optional hook — keep the scripts decoupled).
- **D-02 Data source = `sold_match` table** (cols: `verdict` ∈ {matched, booli_only, uncertain, genuine_non_hemnet}, `match_method`, `segment`, `window_start/end`, `adjudicated_at`, `first_unmatched_at`, `recheck_until`, `next_recheck_at`). Group by `segment` (the orchestrator stamps a muni-type key like `stockholm-apt`); roll up to **region** and **national** via `config/sold-panel.json` (muni→region) + a parsed type. Verify the actual `segment` values the Phase-19 orchestrator writes before hardcoding parsing — read `sold-match-batch.js` once it exists.
- **D-03 THE decision-grade headline = settled genuine-non-Hemnet rate** = `genuine_non_hemnet / (matched + genuine_non_hemnet)` — computed over **terminal verdicts only** (exclude still-in-recheck `booli_only` and `uncertain`). Report it as the lead number, labelled "settled". REPORT-03.
- **D-04 Report the raw `booli_only` rate SEPARATELY and labelled** ("preliminary / lag-contaminated, draining over ~4 wks") = `booli_only / total`. Never merge the two; the visual/label distinction is the point of REPORT-03.
- **D-05 Verdict buckets for the per-run summary** (REPORT-01): matched (first-pass) / booli_only (in re-check) / **re-check-resolved-late** = `verdict='matched' AND first_unmatched_at IS NOT NULL` (was enrolled then matched on re-check) / settled-non-Hemnet = `verdict='genuine_non_hemnet'` / uncertain. Per segment + region + national rollup.
- **D-06 Slack path:** post via `lib/spotcheck-slack-bot.js` `postInfoMessage(channel, text)` (bot token; returns null silently if `SLACK_BOT_TOKEN` unset) — model the message build on `market-totals-weekly-report.js` (monospace block, per-segment rows). NOT the cron-wrapper webhook (that stays for anomaly escalation). The summary can also read the just-finished run's `cron_job_log.result_summary` for run-level counts.
- **D-07 Trend chart:** model on `chart-hb-ratio.js` — Node queries `sold_match`, computes per-period (fortnightly, keyed by `window_end` ISO week) the **settled-non-Hemnet rate** + **match rate** (national line + optional per-region lines), writes a self-contained Chart.js-4 HTML to `view-data/<date>/sold-match/trend.html` (served by the existing `view-data-server.js:3800`). Committed-HTML family — no new dashboard stack.
- **D-08 Offline acceptance (REPORT-04 criterion):** both scripts have a `--smoke` that runs against an in-script FIXTURE dataset (no DB, no network) — the Slack renderer builds the message from fixture rows (asserts the settled-rate math + the raw-vs-settled label separation), the chart generator writes an HTML file from fixture rows (asserts the file contains the settled-rate series + a distinct raw-rate label). `SLACK_BOT_TOKEN` absent → renderer returns the text but does not post. `node -c` + `--smoke` are the acceptance gates; zero Oxylabs, zero live DB.
</decisions>

<canonical_refs>
## Canonical References (downstream agents MUST read)

- `market-totals-weekly-report.js` — closest analog for the Slack summary (query → nested buckets → monospace block → post). Read its DB lifecycle + renderBlock/renderRow helpers.
- `lib/spotcheck-slack-bot.js` — `postInfoMessage` (bot-token post; silent null when no token).
- `chart-hb-ratio.js` — committed-HTML Chart.js generator (query → compute series → embed JSON in `<script>` → write self-contained HTML to view-data/). `export-hb-ratio-xlsx.js` sibling for dual-chart layout.
- `view-data-server.js` — serves view-data/ on :3800.
- `db.js` — `createClient()` lifecycle.
- `config/sold-panel.json` — muni→region map for rollups.
- `migrate-sold-phase16.js` + `migrate-sold-recheck-phase18.js` — the `sold_match` column contract.
- `sold-match-batch.js` (built in Phase 19) — read the actual `segment` key format + `result_summary` shape it writes.
</canonical_refs>

<deferred>
## Deferred
- Wiring the report into the orchestrator as a mandatory step (keep the scripts standalone + an OPTIONAL end-of-run hook; the operator can also schedule them separately).
- Per-property reclassification (loop #2) reporting — separate future build.

---
*Phase: 20-per-run-reporting-decision-grade-trend*
*Context gathered: 2026-06-18*
