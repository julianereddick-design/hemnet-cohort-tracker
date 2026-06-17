---
status: partial
phase: 17-match-pipeline-orchestration
source: [17-VERIFICATION.md]
started: 2026-06-17T00:00:00Z
updated: 2026-06-17T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Operator live run on the droplet
command: `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --segment taby-villa --limit 50`
expected: Runner connects to prod DB, seeds `booli_sold` page-by-page, searches Hemnet `/salda` per record, persists matched/booli_only/uncertain rows into `sold_match` with object evidence, prints the per-segment summary line (adjudicated/matched/booli_only/uncertain/error/matchRate/oxylabsSpent/stoppedBy), and a re-run produces no duplicate `sold_match` rows (DB-03).
why_human: Live network (Oxylabs) + live prod DB writes are authorization-gated and deferred to a one-time operator droplet run per the phase plan and environment note. Cannot be exercised in CI/offline verification. All offline contracts (smoke + grep gates + lib export wiring) pass; this is end-to-end confirmation of the wired pipeline against real data.
prerequisite: The four Phase-16 sold tables must exist live (Phase 16 commit `466cfe7` reportedly confirmed them); else run `node migrate-sold-phase16.js` on the droplet first.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
