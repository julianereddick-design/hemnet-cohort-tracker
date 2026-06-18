# Requirements: Hemnet Cohort Tracker — Milestone v3.1 Sold-match productionization

**Defined:** 2026-06-18
**Core Value:** Turn the code-complete v3.0 sold-match pipeline into a scheduled, self-draining, observable production system — so the headline "how much sold data Booli holds beyond Hemnet's `/salda`" becomes a trustworthy, decision-grade number tracked over time, not a one-off spike figure.

**Milestone goal:** Run the existing `scripts/sold-match-run.js` runner on a cron batch across all configured segments; re-check unmatched `booli_only` records for ~4 weeks to drain slutpris-lag before settling them as genuine non-Hemnet; and report each run's results to Slack plus a graphical over-time trend. The listing-stage suppression test (SUPPRESS) stays deferred.

## v1 Requirements (Milestone v3.1)

Requirements for this milestone. Each maps to exactly one roadmap phase (18+).

### Scheduling (SCHED)

- [ ] **SCHED-01**: A scheduled orchestrator (under the `cron-wrapper.runJob` pattern, modeled on `cohort-spotcheck-gate.js`) runs the sold-match pipeline on a configured cadence on the droplet — driving `scripts/sold-match-run.js` across every configured segment with the rolling sold-date window, and logging the run to `cron_job_log`.
- [ ] **SCHED-02**: The batch run enforces the Oxylabs spend ceiling across the whole multi-segment batch (not just per-segment) and fails safe — on budget exhaustion or persistent fetch failure it escalates rather than silently completing a partial run.
- [ ] **SCHED-03**: The cron schedule, required env vars, and an operator runbook entry are documented in `deploy-instructions.md`, with the crontab line installable on the droplet.

### Re-check pass (RECHECK)

- [x] **RECHECK-01**: Unmatched `booli_only` sold records are persisted with re-check scheduling state (e.g. `first_unmatched_at`, `recheck_until`, `next_recheck_at`) so they can be revisited on subsequent scheduled runs. _(Phase 18: migration + enrollRecheck/enrollUnmatched)_
- [x] **RECHECK-02**: Each scheduled run re-attempts the Hemnet `/salda` search for still-unmatched `booli_only` records that are due and within their re-check window; a late match flips the verdict to `matched` with the supporting evidence (matched Hemnet slug, agreeing signals) and removes it from the re-check queue. _(Phase 18: runRecheck/fetchDueRecheck/clearRecheck; cadence wiring in Phase 19)_
- [x] **RECHECK-03**: A `booli_only` record still unmatched after its re-check window (~4 weeks) settles to a terminal `genuine non-Hemnet` verdict and exits the re-check queue — no further Hemnet searches are spent on it. _(Phase 18: settleExpired/settleNonHemnet)_
- [x] **RECHECK-04**: The re-check window length is configuration (default ~4 weeks) and adjustable without code changes. _(Phase 18: RECHECK_WINDOW_DAYS/INTERVAL_DAYS env-overridable)_

### Reporting (REPORT)

- [ ] **REPORT-01**: Each scheduled run emits a Slack/report summary, per segment, of `matched / booli_only / re-check-resolved-late / settled-non-Hemnet` counts and rates, reusing the spot-check Slack patterns (`lib/spotcheck-slack-bot.js` + cron-wrapper escalation).
- [ ] **REPORT-02**: A graphical over-time trend output (committed HTML chart generated from the DB, in the `market-totals-chart.html` / `chart-hb-ratio.js` family) shows the match rate and the settled genuine-non-Hemnet rate week-over-week, per segment.
- [ ] **REPORT-03**: The settled (post-re-check) genuine-non-Hemnet rate is surfaced as the decision-grade headline metric, reported distinctly from the raw/instantaneous `booli_only` rate so lag-contamination is never mistaken for genuine non-Hemnet presence.

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
| SCHED-01 | Phase 19 | Pending |
| SCHED-02 | Phase 19 | Pending |
| SCHED-03 | Phase 19 | Pending |
| RECHECK-01 | Phase 18 | Complete |
| RECHECK-02 | Phase 18 | Complete |
| RECHECK-03 | Phase 18 | Complete |
| RECHECK-04 | Phase 18 | Complete |
| REPORT-01 | Phase 20 | Pending |
| REPORT-02 | Phase 20 | Pending |
| REPORT-03 | Phase 20 | Pending |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 10 (roadmap created 2026-06-18)
- Unmapped: 0

---
*Requirements defined: 2026-06-18*
