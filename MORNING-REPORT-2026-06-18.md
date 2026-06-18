# Morning download — v3.1 sold-match productionization (overnight 2026-06-18)

## TL;DR
Phases 19 + 20 are **built, reviewed, committed, and offline-green** — the v3.1 milestone is code-complete. Mid-build you reframed the sample to a **national population-weighted panel** (~1,000 non-deed Booli sold properties / fortnight); I reshaped the seeding layer around it and everything else carried over. Nothing live ran except the one **operator-approved ID probe** (73 Oxylabs calls). Go-live is four clean steps, all yours.

## What shipped (all offline `--smoke` green, committed to master)
| File | What it does | Smoke |
|---|---|---|
| `lib/sold-sample.js` | National sampler: per-muni×type 14-day Booli fetch → deed-exclude → de-dup vs `booli_sold` → population-weighted allocation to ~1,000 (capped at live volume) → per-record `seg` tag | 16/0 |
| `sold-match-batch.js` | `cron-wrapper.runJob` orchestrator: even-week fortnightly gate, ONE batch-wide spend ceiling, sampler→`matchOne` loop, Phase-18 re-check drain, fail-safe `validate()` | 9/0 |
| `lib/sold-config.js` / `lib/sold-recheck.js` | `RECHECK_BRIDGE_FINAL_ONLY` cost lever (default OFF) | 27/0, 15/0 |
| `deploy-instructions.md` | Crontab line + env vars + runbook + cost-lever/backfill notes | — |
| `sold-match-report.js` | Per-segment/region/national Slack summary; **settled genuine-non-Hemnet rate as the headline**, distinct from raw `booli_only` | 13/0 |
| `sold-match-trend-chart.js` | Committed-HTML Chart.js trend (national match rate + settled-non-Hemnet/fortnight) → `view-data/<date>/sold-match/trend.html` | 9/0 |
| `config/sold-panel.json` + `scripts/probe-national-panel.js` | The v1 11-muni panel + the probe that built it | — |

Regression smokes (sold-store 25, sold-match-run 18) stayed green — no existing behavior changed. Methodology frozen: **Slutpris-only, no Lagfart/matcher change**.

## Decisions I made on your behalf (all reversible)
1. **Panel = 11 municipalities** (Stockholm, Göteborg, Malmö, Uppsala, Helsingborg, Lund, Borås, Nacka, Södertälje, Täby, Kungälv) — the ones where the probe resolved **both** Booli areaId + Hemnet location_id. ~2,741 sold/14d, so **1,000/fortnight is a 36% sample-down**. It's metro/south-heavy with **no Norrland** — see backfill below.
2. **Allocation by population, capped at live volume**, within-muni Hus:Lägenhet by **natural ratio** (your "no per-type editing").
3. **Fortnightly cadence** via an even-ISO-week no-op gate on a weekly cron line (`30 7 * * 1`).
4. **`/salda`-primary matching** (panel is mapped) + the SERP bridge for `booli_only` recovery; re-check drain unchanged.
5. **Cheaper-recheck lever built default-OFF** (`RECHECK_BRIDGE_FINAL_ONLY`) — flip it on to cut ~mid 9k→~6k Oxylabs calls/month.
6. **`MAX_OXY_CALLS` batch ceiling ~8000** (documented; you set the real value at go-live).

## Cost (planning estimate, ±40% until first wet run)
~3–6k Oxylabs calls per fortnightly run → **~7–13k/month (mid ~9k, ~$15–45/mo)**. Re-check drain is ~50% of it (always hits the bridge). Hard-capped by the ceiling regardless.

## Code review (`19-REVIEW.md`) — no blockers
- **WR-01 FIXED** — the fetch-failure fail-safe was dead in prod (`fetchBooliSoldPage` swallows errors); now a real Booli outage is detected and the SCHED-02 escalation fires.
- **WR-02 FIXED** — allocation could over-allocate past target (1001/1000); global budget cap holds `sum ≤ target`.
- **WR-03 (documented, your call)** — the even/odd ISO-week parity drifts at a **53-week year boundary** (could flip run/skip parity for the following year). Clean fix = switch to a continuous fortnight index; low stakes, next year-end.
- **WR-04 + 3 INFO** — minor, in the artifact.

## What's left for you (go-live — all gated to you)
1. **DDL migrations on the droplet** (if not already live): `migrate-sold-phase16.js` + `migrate-sold-recheck-phase18.js`.
2. **Backfill the panel** (optional, improves coverage): 8 munis need Hemnet IDs (Linköping/Örebro/Västerås/Norrköping/Eskilstuna/Halmstad/Sundsvall/Karlstad — Booli IDs already in `config/sold-panel.json._backfill_pending`), + the north needs both. The Hemnet `/locations/show` endpoint is Cloudflare-dead via Oxylabs — needs a small raw-Oxylabs JSON helper, or paste IDs off the URLs.
3. **Approve the first Oxylabs wet run** of `SCRAPE_FORCE_OXYLABS=1 node sold-match-batch.js` — this confirms calls/record and the real fresh-window `booli_only` rate, the two soft spots in the cost estimate.
4. **Install the fortnightly crontab line** + set `MAX_OXY_CALLS` / `SLACK_BOT_TOKEN` per `deploy-instructions.md`.

## Open / deferred
- **Loop #2** (Slutpris→Lagfart reclassification, Model A test) — separate future build, `.planning/todos/pending/loop2-slutpris-lagfart-reclassification-tracker.md`. Model B (Lagfart-only villas) denominator-bias is a noted, accepted gap.
- Per-region trend lines (national line is the decision-grade output).
- WR-03 fortnight-index fix.

Commits this session: `8f885f0` (probe+panel) → `cdc23f5` (Phase 19) → `c04b5aa`/`3c5b7af` (Phase 20) → WR fixes → docs. All on `master`.
