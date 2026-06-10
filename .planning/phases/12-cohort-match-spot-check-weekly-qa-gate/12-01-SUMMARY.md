---
phase: 12-cohort-match-spot-check-weekly-qa-gate
plan: "01"
subsystem: spotcheck-gate
tags: [pure-module, adjudication, wilson-ci, smoke-test]
dependency_graph:
  requires: [cohort-spotcheck.js, lib/spotcheck-evidence.js, spotcheck-photos.js, lib/spotcheck-photos.js]
  provides: [lib/spotcheck-adjudicate.js, lib/spotcheck-summary.js]
  affects: [cohort-spotcheck-gate.js (plan 12-02), lib/spotcheck-vision.js (plan 12-03)]
tech_stack:
  added: []
  patterns: [pure-module, --smoke-self-test, wilson-score-interval, mode-agnostic-adjudication]
key_files:
  created:
    - lib/spotcheck-adjudicate.js
    - lib/spotcheck-summary.js
  modified: []
decisions:
  - "Mode A (no vision) deterministic promote: priceAgrees + hasPhotos + provisional=likely-match → CONFIRMED_MATCH; ensures complete artifact without Anthropic API"
  - "Asymmetric verdict logic: one shared photo confirms; mismatch requires field divergence (triage=suspect) PLUS no shared photo; price alone never confirms"
  - "confirmedMismatchRate denominator = adjudicated (match+mismatch), not sampled — UNCERTAIN excluded from rate"
  - "wilson95 copied verbatim from cohort-spotcheck.js (not exported there); no cross-file import"
metrics:
  duration: 12m
  completed: "2026-06-10"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 12 Plan 01: Spotcheck Adjudicate + Summary Modules Summary

Pure verdict and CI modules for the mode-agnostic weekly spot-check QA gate: `adjudicatePair` with 5-branch decision tree, `computeSummary` with Wilson 95% CI, by-county breakdown, and mismatch list.

## What Was Built

### lib/spotcheck-adjudicate.js
Pure per-pair verdict logic (no DB, no network). Exports `adjudicatePair(record, { visionResult })` and `adjudicatePairs(records, { visionResults })`.

Decision tree (first match wins):
1. `priceAgrees && sharedPhoto === true` → `CONFIRMED_MATCH` / `mode-b-vision`
2. `priceAgrees && hasPhotos && provisional==='likely-match' && sharedPhoto==null` → `CONFIRMED_MATCH` / `deterministic`
3. `provisional==='suspect' && sharedPhoto === false` → `CONFIRMED_MISMATCH` / `mode-b-vision`
4. `!hasPhotos` → `UNCERTAIN` / `no-photos`
5. otherwise → `UNCERTAIN` / `no-vision`

Mutates records in-place: attaches `verdict`, `verdict_source`, `verdict_reason`. 13-case `--smoke` covers all branches including the pair 16347 (area+price diverge, mismatch) and pair 15647 (area-gap-only, price agrees, deterministic promote) canonical cases.

### lib/spotcheck-summary.js
Pure stats/render module. Exports `wilson95`, `computeSummary`, `renderSlackAlert`, `renderSummaryMd`.

- `wilson95` copied verbatim from `cohort-spotcheck.js` lines 108-117 (not exported there).
- `computeSummary(pairs)`: counts by verdict, `confirmedMismatchRate = confirmedMismatch / adjudicated` (UNCERTAIN excluded from denominator), Wilson 95% CI, per-county breakdown, mismatch list with delta strings.
- `renderSlackAlert(summary, cohortId)`: plain-text string for cron-wrapper `validate()` escalation path (e.g., `confirmed false-match rate 2.9% (n=35, 95% CI 0.8-9.8%) for cohort 2026-W23 — 1 mismatch(es)`).
- `renderSummaryMd(summary, cohortId)`: markdown with Summary table, By-county table, Mismatches section.
- 29-case `--smoke` covers wilson95 edge cases (n=0, known value wilson95(2,112)), computeSummary fixture assertions, Slack/MD render content checks.

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | lib/spotcheck-adjudicate.js | 66341f2 | lib/spotcheck-adjudicate.js (created) |
| 2 | lib/spotcheck-summary.js | c545fa7 | lib/spotcheck-summary.js (created) |

## Deviations from Plan

None — plan executed exactly as written. Both modules implement the specified contracts, pass all `--smoke` tests, and contain no DB/network/Anthropic imports.

## Threat Surface Scan

Both modules are pure in-process transforms with no new network endpoints, auth paths, file access, or schema changes. Threat register dispositions from plan frontmatter applied:

- **T-12-01 (Tampering)**: All field accesses guarded with optional chaining and `!= null` checks; null `price_pct_diff` → `priceAgrees=false`, null/undefined `photos` → `hasPhotos=false`. No field crashes the function.
- **T-12-02 (DoS)**: O(n) render; bounded by sample size (~110 pairs).
- **T-12-03 (Info disclosure)**: No PII, no secrets; only already-public listing URLs in output.

No new threat surface found.

## Self-Check: PASSED

- `lib/spotcheck-adjudicate.js` exists: FOUND
- `lib/spotcheck-summary.js` exists: FOUND
- Commit 66341f2 exists: FOUND
- Commit c545fa7 exists: FOUND
- `node lib/spotcheck-adjudicate.js --smoke`: 13 pass, 0 fail
- `node lib/spotcheck-summary.js --smoke`: 29 pass, 0 fail
- Purity check (no pg/db/https/anthropic imports): PASSED for both modules
