---
title: Pair removal (D-11) is broken — FK blocks the DELETE and the audit can't restore
priority: high
area: spotcheck-reaction-poller + lib/spotcheck-review-store
status: pending
created: 2026-06-11
resolves_phase: null
---
The ✅-confirm-mismatch removal path doesn't reliably work on real data, and its "recoverable" claim is hollow. Found during the Phase 13 live test (mock-based smoke tests couldn't catch either issue).

**Problem 1 — FK blocks the DELETE.** `removeConfirmedMismatchPair` (lib/spotcheck-review-store.js) runs, in one txn: INSERT audit → `DELETE FROM cohort_pairs WHERE id=$1`. But `cohort_daily_views.pair_id REFERENCES cohort_pairs(id)` has NO `ON DELETE CASCADE` (cohort-setup.js:45). Any pair with daily-view rows (i.e. any pair tracked for >0 days) → the DELETE violates the FK → txn rolls back → pair NOT removed. So a human ✅ on a real mismatch silently fails to clean it. Only a brand-new pair with zero view rows would delete — and then unrecoverably (see P2).

**Problem 2 — not recoverable + destroys history.** `spotcheck_removed_pairs` stores only pair_id, cohort_id, booli_id, hemnet_id, verdicts, reactor, reason. But `cohort_pairs` has NOT NULL columns it doesn't capture: street_address, postcode, municipality, county, booli_listed, hemnet_listed. So you cannot re-INSERT from the audit — the documented "recover from spotcheck_removed_pairs" runbook (deploy-instructions.md) is not executable. And the pair's `cohort_daily_views` time series (the cohort's whole point) is orphaned/blocked or, if force-deleted, gone forever.

**Recommended fix — switch D-11 from hard-DELETE to SOFT-DELETE:**
- Add `removed_at TIMESTAMPTZ`, `removed_reason TEXT`, `removed_by TEXT` columns to `cohort_pairs` (migration).
- "Removal" = UPDATE those columns, not DELETE. Exclude `removed_at IS NOT NULL` pairs from cohort reporting/track queries.
- Sidesteps the FK entirely, preserves the full row + its view history, and recovery is just nulling `removed_at`.
- If a hard purge is ever wanted, do it as a separate, deliberate, snapshot-everything-first operation.

**Interim safety:** the live daily poller is installed. Do NOT rely on ✅-removal until fixed; ❌/❓ on individual mismatch messages are safe (UPDATE only). See [[project_spotcheck_false_negative_taxonomy]], [[project_phase13_review_loop_golive]].

---
**RESOLVED 2026-06-12 (Phase 13.1):** soft-delete shipped exactly as recommended. `migrate-cohort-pairs-soft-delete.js` adds `removed_at/removed_reason/removed_by`; `removeConfirmedMismatchPair` is now audit INSERT + UPDATE (guarded `AND removed_at IS NULL`, never a DELETE — smoke asserts no DELETE is issued); `removed_at IS NULL` filters added across tracking (cohort-track), refresh (booli/hemnet-targeted-refresh), sampling (cohort-spotcheck), reporting (weekly-view-report, cron-health-slack), exports (export-views-wide, export-hb-ratio-xlsx, chart-hb-ratio), and lib/hemnet-locations. Recovery = `UPDATE ... SET removed_at=NULL` (runbook in deploy-instructions.md updated — the old re-INSERT recipe was not executable).
