# Requirements: Hemnet Cohort Tracker — Milestone v3.1 Sold-match productionization

**Defined:** 2026-06-18
**Core Value:** Turn the code-complete v3.0 sold-match pipeline into a scheduled, self-draining, observable production system — so the headline "how much sold data Booli holds beyond Hemnet's `/salda`" becomes a trustworthy, decision-grade number tracked over time, not a one-off spike figure.

**Milestone goal:** Run the existing `scripts/sold-match-run.js` runner on a cron batch across all configured segments; re-check unmatched `booli_only` records for ~4 weeks to drain slutpris-lag before settling them as genuine non-Hemnet; and report each run's results to Slack plus a graphical over-time trend. The listing-stage suppression test (SUPPRESS) stays deferred.

## v1 Requirements (Milestone v3.1)

Requirements for this milestone. Each maps to exactly one roadmap phase (18+).

### Scheduling (SCHED)

- [x] **SCHED-01**: A scheduled orchestrator (`sold-match-batch.js`, under `cron-wrapper.runJob`, modeled on `cohort-spotcheck-gate.js`) runs the sold-match pipeline fortnightly — driving the matcher across a national population-weighted sample (reframed from hand-picked segments to `config/sold-panel.json` + `lib/sold-sample.js`, 14-day window), and logging to `cron_job_log`. _(Phase 19; offline-complete — live wet run operator-gated)_
- [x] **SCHED-02**: The batch enforces ONE Oxylabs spend ceiling across the whole batch (`setSpendClient` once) and fails safe — `validate()` escalates on ceiling/fetch-failure/incomplete rather than silently completing a partial run. _(Phase 19; WR-01 fix makes the fetch-failure escalation fire on real Booli outages)_
- [x] **SCHED-03**: The crontab line (`30 7 * * 1`, fortnightly via even-week gate), env vars, and an operator runbook entry are documented in `deploy-instructions.md`. _(Phase 19; crontab install operator-gated)_

### Re-check pass (RECHECK)

- [x] **RECHECK-01**: Unmatched `booli_only` sold records are persisted with re-check scheduling state (e.g. `first_unmatched_at`, `recheck_until`, `next_recheck_at`) so they can be revisited on subsequent scheduled runs. _(Phase 18: migration + enrollRecheck/enrollUnmatched)_
- [x] **RECHECK-02**: Each scheduled run re-attempts the Hemnet `/salda` search for still-unmatched `booli_only` records that are due and within their re-check window; a late match flips the verdict to `matched` with the supporting evidence (matched Hemnet slug, agreeing signals) and removes it from the re-check queue. _(Phase 18: runRecheck/fetchDueRecheck/clearRecheck; cadence wiring in Phase 19)_
- [x] **RECHECK-03**: A `booli_only` record still unmatched after its re-check window (~4 weeks) settles to a terminal `genuine non-Hemnet` verdict and exits the re-check queue — no further Hemnet searches are spent on it. _(Phase 18: settleExpired/settleNonHemnet)_
- [x] **RECHECK-04**: The re-check window length is configuration (default ~4 weeks) and adjustable without code changes. _(Phase 18: RECHECK_WINDOW_DAYS/INTERVAL_DAYS env-overridable)_

### Reporting (REPORT)

- [x] **REPORT-01**: `sold-match-report.js` emits a per-segment (+region+national) Slack summary of `matched / booli_only / re-check-resolved-late / settled-non-Hemnet` counts and rates via `lib/spotcheck-slack-bot.js` `postInfoMessage`. _(Phase 20; offline-smoke against fixtures)_
- [x] **REPORT-02**: `sold-match-trend-chart.js` writes a committed-HTML Chart.js-4 trend (national match rate + settled genuine-non-Hemnet rate per fortnight) to `view-data/<date>/sold-match/trend.html`, served by `view-data-server.js`. _(Phase 20; per-region lines deferred — national line is the decision-grade output)_
- [x] **REPORT-03**: The settled (post-re-check) genuine-non-Hemnet rate `= genuine_non_hemnet/(matched+genuine_non_hemnet)` over terminal verdicts is the lead headline, reported on a distinct line/series from the raw `booli_only` rate (labelled preliminary/lag-contaminated). _(Phase 20; asserted in both smokes)_

## Future Requirements (deferred to later milestones)

### Suppression (SUPPRESS)

- **SUPPRESS-01**: Listing-stage suppression test — track Hemnet for-sale villa listings → which appear on `/salda` after selling (Hemnet's own suppression rate, Booli-independent). Different method (for-sale → sold tracking), not Booli-vs-Hemnet sold matching.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Listing-stage suppression test | Deferred (SUPPRESS) — Hemnet `/salda` indexes only priced sales, so suppression can't be measured from sold pages alone; needs its own for-sale→sold tracking method. |
| New dashboard / BI stack for the trend chart | The graphical trend reuses the repo's committed-HTML-chart-from-DB pattern; a hosted dashboard is out of scope for this milestone. |
| Apartment re-check >9 months back | Booli strips fee/broker past ~9 months; the ~4-week re-check window sits well inside the fee-available horizon, but no re-check extends an apartment match attempt past the design limit. |
| Real-time / event-driven runs | Cadence is a scheduled batch (cron); streaming or webhook-triggered runs are not in scope. |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCHED-01 | Phase 19 | Complete (offline; live wet run gated) |
| SCHED-02 | Phase 19 | Complete (offline) |
| SCHED-03 | Phase 19 | Complete (crontab install gated) |
| RECHECK-01 | Phase 18 | Complete |
| RECHECK-02 | Phase 18 | Complete |
| RECHECK-03 | Phase 18 | Complete |
| RECHECK-04 | Phase 18 | Complete |
| REPORT-01 | Phase 20 | Complete (offline) |
| REPORT-02 | Phase 20 | Complete (offline) |
| REPORT-03 | Phase 20 | Complete (offline) |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 10 (roadmap created 2026-06-18)
- Unmapped: 0

---
*Requirements defined: 2026-06-18*
