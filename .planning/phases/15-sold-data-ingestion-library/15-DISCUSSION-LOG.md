# Phase 15: Sold-data ingestion library - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-17
**Phase:** 15-sold-data-ingestion-library
**Areas discussed:** Detail-fetch policy, "Sold in advance" recon, Module layout & disposition

---

## Detail-fetch policy (cost vs completeness)

| Option | Description | Selected |
|--------|-------------|----------|
| Apartments only (matching-driven) | Detail fetch only for apartments in fee window; villas card-only | |
| All market records | Detail fetch for every non-lagfart record (~2× Oxylabs/segment) | |
| Configurable (default apts-only) | Apartments-only default + `--enrich-all` flag | |

**User's choice (first pass):** Free-text — "I also want to make sure we pick up the sold advance tab which I think probably sits on the full page, so it depends on that." → policy depends on where "sold in advance" lives.

**Follow-up question:** If "sold in advance" is detail-only, accept ~2× cost to fetch detail for all records?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — detail for all market records | Guarantee flag + full enrichment everywhere, ~2× calls/segment | |
| Recon decides, prefer cheaper | Card-level → apartments-only detail; escalate to all-records only if detail-only AND spend re-confirmed | ✓ |
| Apartments-only regardless | Cap at apartments even if villas lose sold-in-advance/enrichment | |

**User's choice:** Recon decides, prefer cheaper.
**Notes:** Runs are manual/on-demand for now (no cron), so cost is per-run not recurring. Recurring/elevated spend stays Julian's call → don't silently 2×.

---

## "Sold in advance" recon

| Option | Description | Selected |
|--------|-------------|----------|
| Best-effort, never block | Set flag when a reliable signal exists, else null; document recon; never block | ✓ |
| Pay for detail if needed | Fetch detail even for skip records to get the flag | |
| Defer flag to v2 if not free | Only implement if card-level signal exists | |

**User's choice:** Best-effort, never block.
**Notes:** Where Booli encodes "sold in advance" is unknown (recon never looked) — a recon task confirms it first; Julian's hunch is the full detail page. Recon outcome feeds the detail-fetch policy.

---

## Module layout & disposition

| Option | Description | Selected |
|--------|-------------|----------|
| New lib/sold-*.js modules | Separate sold modules; keep searchSold/searchSales logic out of for-sale fetchers | (Claude) |
| Extend existing fetchers | Fold sold into lib/booli-fetch.js / lib/hemnet-fetch.js | |
| You decide | Planner picks | ✓ |

**User's choice:** "You decide." → Claude's discretion (recommended: new `lib/sold-*.js` modules).

| Option | Description | Selected |
|--------|-------------|----------|
| Thin CLI wrappers over lib/ | Spike scripts become thin CLIs; preserve cache | (Claude) |
| Delete them | Remove once lib/ + CLI exist | |
| Leave on branch as-is | Untouched for reference | |

**User's choice:** "Happy for you to decide but make sure you go through and review the code and clean up as needed." → Claude's discretion (recommended: thin wrappers + active cleanup of dead/duplicated spike code).

---

## Claude's Discretion

- Module file boundaries (recommended: new `lib/sold-*.js`, separate from for-sale fetchers; reuse `lib/scrape-http.js`).
- Spike-script disposition (recommended: thin CLI wrappers + review/cleanup during the move).
- Spend ceiling location (keep file-based for Phase 15; revisit DB-backed tally in Phase 16) — area not selected for discussion.

## Deferred Ideas

- Move Oxylabs spend tally into the DB (Phase 16).
- All-records villa detail enrichment (only if "sold in advance" forces it AND spend re-confirmed).
- DB schema/persistence → Phase 16; segment runner + rolling-window → Phase 17; scheduling/reporting/suppression → v2.
