---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: Self-hosted scraper hardening
status: Executing Phase 12
last_updated: "2026-06-10T00:00:00.000Z"
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 9
  completed_plans: 8
  percent: 89
---

## Accumulated Context

### Roadmap Evolution

- Phase 12 added: Cohort match spot-check weekly QA gate (verify Booli↔Hemnet pairs are the same property; spec in repo `COHORT-SPOTCHECK.md`)

### Decisions

- 12-01: Mode A deterministic promote (priceAgrees + hasPhotos + likely-match → CONFIRMED_MATCH) ensures complete artifact without Anthropic API; price alone never confirms a match
- 12-01: confirmedMismatchRate denominator = adjudicated (match+mismatch), UNCERTAIN excluded; wilson95 copied verbatim (not exported from cohort-spotcheck.js)

### Last Session

Stopped at: Phase 12, Plan 01 complete (2026-06-10)
Resume: 12-02-PLAN.md
