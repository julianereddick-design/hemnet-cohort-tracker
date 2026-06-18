---
type: todo
status: pending
created: 2026-06-17
resolves_phase: 19
source: 15-REVIEW.md (CR-01, WR-05, WR-06/07)
severity: blocker-for-concurrency
---

# Harden lib/sold-transport spend ceiling before concurrent drivers (Phase 16)

Phase 15 code review (15-REVIEW.md) raised CR-01 (BLOCKER) plus the spend-accounting
warnings. They are **latent in Phase 15** because every fetcher uses strictly sequential
`await cachedFetch(...)` (no Promise.all / parallel maps), so the `_spend.json`
read-modify-write never races and the MAX_OXY_CALLS ceiling holds as-shipped (also
empirically validated by the spike's 3h wet-run).

They become **live the moment Phase 16/17 introduce concurrent fetch drivers.** Fix BEFORE
adding any concurrency:

- **CR-01 (`lib/sold-transport.js` `cachedFetch` ~L90-101):** ceiling enforcement is a
  non-atomic read-modify-write of `_spend.json`. Concurrent fetches both read the same
  `liveCalls`, both pass the check, one increment is lost → counter under-counts, budget
  overshoots. Parallel reruns clobber the file via full-overwrite `saveSpend`.
  Fix: in-process async mutex around the increment + atomic temp-file write-then-rename
  for cross-process safety.
- **WR-05 (CLI wrappers `scripts/booli-sold.js`, `scripts/hemnet-sold.js`):** RESOLVED 2026-06-17
  (standalone fix on spike/sold-match-feasibility). Both wrappers now reject NaN / non-positive
  numeric flags (`--target`, `--market-target`, `--max-pages`, `--window-days`) and exit 1 before
  any fetch. No longer outstanding.
- **WR-06 / WR-07:** spend-summary / accounting accuracy issues — fold into the same pass.

Also review the early-stop/pagination warnings (WR-01..04) for correctness while in this code:
WR-01 (abort-whole-search on one unparseable 200 page), WR-02 (early-stop #4 uses page-min not
date-sorted last card; never fires when all `sold_at` null), WR-03 (pages/pagesWalked off-by-one).

Full detail: `.planning/phases/15-sold-data-ingestion-library/15-REVIEW.md`.
