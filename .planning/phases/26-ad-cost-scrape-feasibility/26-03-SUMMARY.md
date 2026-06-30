---
phase: 26-ad-cost-scrape-feasibility
plan: 03
subsystem: ad-cost-scrape reporting/decision (cost evidence in this repo; scrape lives on droplet tt7676/hem-bol-scrapers)
tags: [feasibility, ad-cost, cost-evidence, oxylabs, d04, feas-03, operator-checkpoint]
ran: true
verdict: FEAS-03 cost quantified = trivial; phase gate = transport-capability (creds/product-scope) decision
requires:
  - 26-01 DIRECT_BLOCKED verdict (direct path dead)
  - 26-02 OXYLABS_REWIRE_BLOCKED_D04 result (POST-body transport wall + $0.05/18-call probe + unblock options)
  - 23-VERIFICATION-CRAWL.md flat-plan marginal-cost framing
provides:
  - docs/ad-cost-scrape-cost.md — written per-run/week/month recurring-cost evidence for FEAS-03
  - the single Phase-26 operator checkpoint input (recurring-cost go/no-go, now creds/product-scope-shaped)
affects:
  - Phase 27 (resume weekly scrape) — gated on the operator transport-provision decision
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - docs/ad-cost-scrape-cost.md
    - .planning/phases/26-ad-cost-scrape-feasibility/26-03-SUMMARY.md
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - Cost doc framed around the unblock options (per 26-02's explicit instruction), NOT a per-call extrapolation pretending a path won — because NEITHER path landed a row
  - Task 2 (the blocking operator checkpoint) deliberately NOT executed by this executor — handed to the orchestrator
metrics:
  duration: ~1 session
  task_count: 1
  file_count: 1
  completed: 2026-06-30
---

# Phase 26 Plan 03: Recurring Ad-Cost Scrape Cost — FEAS-03 Evidence Summary

**One-liner:** Wrote `docs/ad-cost-scrape-cost.md` quantifying the recurring weekly ad-cost crawl cost as **trivial** — ~$0.29/run list (~$1.26/mo), ≈$0 marginal on the flat $249/mo Oxylabs plan, ~2 orders of magnitude under the sold-match ~$15–45/mo benchmark — while telling the true post-26-01/26-02 story: **cost is not the obstacle; transport capability is.** Neither fetch path has landed a row (direct = Cloudflare 403; Oxylabs = POST body dropped, $0.05/18 calls, 0 rows), so the phase gate is a **credentials/product-scope decision** (provision a body-preserving Oxylabs product), brought to the operator as the single Phase-26 checkpoint.

## Critical reframe honored

The plan 26-03 was written assuming "whichever path won." Reality after 26-01 + 26-02: **neither won.** Per 26-02's explicit instruction ("26-03's recurring-cost write-up should be framed around the unblock options, not a per-call extrapolation"), the cost doc:

- States plainly that **direct = BLOCKED** (HTTP 403 Cloudflare from droplet IP, `VERDICT: DIRECT_BLOCKED`) and **Oxylabs borrowed-creds = BLOCKED at transport (D-04)** (Web Scraper API creds parse-then-ignore the GraphQL POST body → 0 rows).
- Presents the per-run/week/month figures as **what the cost WOULD be once unblocked** (list-rate, body-capable-transport-assuming, per-call-extrapolated from the recon crawl shape — not measured per-row), plus the **$0.05** actually spent on the probe.
- Centers the **Current status: BLOCKED on transport capability** section with the three unblock options (A/B/C) and the A-or-B recommendation — the decision the operator must actually make.

## What was produced

`docs/ad-cost-scrape-cost.md` containing:

- **Crawl shape** — 60 price points (10 munis × 6 prices) × 2 POSTs ≈ 120 Oxylabs calls/run, weekly `0 6 * * 1` cron (per-week == per-run).
- **Per-run / Per-week / Per-month cost table** — ~$0.29 / ~$0.29 / ~$1.26 at list ($0.0024/call), ≈$0 marginal on the flat $249/mo plan, with the 120 × $0.0024 = $0.288 arithmetic shown.
- **Probe actual** — $0.05 / 18 calls / 0 rows (spent characterising the wall, not crawling).
- **Benchmark** vs sold-match ~$15–45/mo (ad-cost ~2 orders of magnitude cheaper).
- **Current status** — body-bearing POST wall, options A (Web Unblocker) / B (residential-DC proxy) / C (refresh droplet's own creds + verify body delivery); D (GraphQL-over-GET) ruled out (Hemnet 404 for GET).
- **Recommendation:** line — provision Option A or B, then enable Phase 27; recurring dollar cost negligible either way.

Acceptance greps all pass: `per-run|per-week|per-month` = 5 (≥3), `\$[0-9]` = 13 (≥1), `Recommendation:` = 1, sold-match `~$15–45/mo` benchmark present (3 hits). No credential values carried — figures only (T-26-08 mitigated).

## Tasks

| Task | Plan intent | Status |
|------|-------------|--------|
| 1 | Write the recurring-cost breakdown for the winning path | **Done** — `docs/ad-cost-scrape-cost.md` written + committed `8b49ad9`; reframed around unblock options since no path won |
| 2 | Operator checkpoint — recurring-cost go/no-go (`checkpoint:decision`, blocking) | **NOT executed by this executor — handed to the orchestrator** (per objective; the executor does not block waiting for an operator decision) |

## Task 2 handoff (operator checkpoint → orchestrator)

Task 2 is the single blocking Phase-26 checkpoint (`autonomous: false`, D-05). This executor did **not** run it. The orchestrator owns surfacing the decision to the operator. Decision shape (now creds/product-scope, not affordability):

- **Go** — provision a body-preserving Oxylabs product (**A. Web Unblocker** or **B. residential/DC proxy**, recommended) → small remaining build → enable Phase 27. Recurring dollar cost negligible (~$1.26/mo list, ≈$0 marginal).
- **Hold** — no transport provisioned; ad-cost data stays stale (last fresh `AdCostV2` rows 2026-03-16); Phases 27–29 stay blocked.

Evidence for the operator: `docs/ad-cost-scrape-cost.md` (per-run/week/month + recommendation + sold-match benchmark) and `26-OXYLABS-PROBE-RESULT.md` (the transport-wall characterisation).

## Phase 26 outcome (FEAS roll-up)

- **FEAS-01 — ANSWERED:** direct ad-cost GraphQL POST path is **blocked** (Cloudflare 403 from droplet IP). [Complete]
- **FEAS-02 — BLOCKED on transport capability:** no working fetch path yet; borrowed Web Scraper API creds defeat Cloudflare but cannot deliver a GraphQL POST body. Needs a body-preserving Oxylabs product (operator provision). [Open]
- **FEAS-03 — QUANTIFIED:** recurring cost is **trivial** (~$1.26/mo list, ≈$0 marginal) and written up in `docs/ad-cost-scrape-cost.md`; cost is not the obstacle — the blocker is a creds/product-scope decision. [Complete as evidence; the go/no-go is the operator's]

## Deviations from Plan

1. **Cost doc reframed around unblock options instead of a single "winning path" extrapolation.** Required because, contrary to the plan's `DIRECT_WORKS`/`DIRECT_BLOCKED→Oxylabs-won` assumption, **neither path produced a row** — 26-02 hit a D-04 transport wall after 26-01's direct block. This is exactly what 26-02's result doc instructed for 26-03. Not a Rule 1/2/3 code fix (doc-only plan); a framing correction driven by upstream evidence.
2. **Task 2 (blocking operator checkpoint) not executed by the executor — handed to the orchestrator** (per the execution objective; avoids blocking on a human decision the executor cannot resolve).
3. **STATE.md / ROADMAP.md updated via direct edits** (no `gsd-sdk` / SDK present in this environment — consistent with every prior phase in this repo; `gsd-sdk` absent on PATH and `node_modules/@gsd-build/sdk` absent).

No secrets written, committed, or logged.

## Known Stubs

None — the deliverable is a written cost/decision doc carrying only figures from the result docs.

## Self-Check: PASSED

- FOUND: `docs/ad-cost-scrape-cost.md`
- FOUND: `.planning/phases/26-ad-cost-scrape-feasibility/26-03-SUMMARY.md`
- FOUND: commit `8b49ad9` (docs(26-03) cost doc)
- VERIFIED: acceptance greps pass (per-run/week/month = 5, `$`-figures = 13, `Recommendation:` = 1, sold-match benchmark present); no credential values in the doc.
