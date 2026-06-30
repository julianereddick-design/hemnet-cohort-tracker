---
phase: 26-ad-cost-scrape-feasibility
plan: 01
subsystem: price-scraper-droplet / ad-cost-feasibility
tags: [feasibility, droplet, hemnet, graphql, cloudflare, ad-cost, gate]
requires:
  - droplet SSH access (P21 runbook)
  - search_ad_cost_2 + AdCostV2 (droplet repo tt7676/hem-bol-scrapers)
provides:
  - 26-DIRECT-TEST-RESULT.md (VERDICT: DIRECT_BLOCKED) — the gate 26-02 reads
affects:
  - 26-02 (now RUNS — conditional Oxylabs rewire is activated, does not no-op)
tech-stack:
  added: []
  patterns: [on-droplet Django-shell direct-POST smoke, branch-on-HTTP-status]
key-files:
  created:
    - .planning/phases/26-ad-cost-scrape-feasibility/26-DIRECT-TEST-RESULT.md
  modified: []
decisions:
  - "Direct search_ad_cost_2 GraphQL POST is BLOCKED from the droplet IP (HTTP 403 Cloudflare 'Just a moment') on the first (autocomplete) POST — direct path is dead, mirroring P23's HTML-fetch block but on the GraphQL endpoint P23 had left direct"
  - "Branch rule honored: non-200 smoke => no full 10-muni pass; FEAS-02 handed to 26-02 (Oxylabs rewire)"
  - "Smoke wrote 0 AdCostV2 rows (blocked before any write); zero Oxylabs spend, no secrets, no schedule change"
metrics:
  duration: ~15m
  completed: 2026-06-30
  tasks: 2
  files: 1
---

# Phase 26 Plan 01: Direct ad-cost scrape feasibility test Summary

**One-liner:** The direct `search_ad_cost_2` GraphQL POST is Cloudflare-blocked (HTTP 403 "Just a moment…") from the droplet's source IP on its first request, so the direct path is dead and the Oxylabs rewire (26-02) is now activated — verdict `DIRECT_BLOCKED`, zero spend.

## What was built / done

A two-task on-droplet feasibility test against `170.64.181.89` (container `hemnet-django`), producing the machine-readable gate doc `26-DIRECT-TEST-RESULT.md`.

**Task 1 — Recon + 1-cell smoke (no local repo changes; all work on droplet):**
- Read `apps/hemnet/tasks.py::search_ad_cost_2` read-only: it's a raw `requests.post` to `https://www.hemnet.se/graphql` (no Cloudflare bypass, no Oxylabs), two GraphQL ops per price point — `AutocompleteLocations` (muni name → `locationId`) then `SellerMarketingProductPrices` (locationId + askingPrice → per-tier prices). Iterates `AdCostPricePointV2.objects.all()` = 60 price points (10 munis × 6 asking prices), writes one `AdCostV2` row per tier (BASIC/PLUS/PREMIUM/MAX/PAID_REPUBLISH/TOPLISTING/TOPLISTING_5_DAYS), with `PLUS/PREMIUM/MAX += BASIC` packaging.
- Captured `AdCostV2` fields: `property_municipality` (FK), `property_price`, `ad_type`, `ad_price`, `valid_until` (null), `crawled` (auto_now_add freshness stamp). History: 17,234 rows, last `crawled` 2026-03-16, 0 today.
- Ran a faithful single-cell smoke (muni `Göteborgs`, asking price 2,000,000) replicating the exact endpoint + payloads via the Django shell. **Result: `AUTOCOMPLETE_HTTP_STATUS=403`**, body = Cloudflare `Just a moment...` interstitial. The block hit step 1, so the ad-cost query was never reached and **0 rows were written**.

**Task 2 — Branch + verdict doc:**
- Branch rule: smoke was non-200, so the representative all-10-muni pass was **not run**.
- Wrote `26-DIRECT-TEST-RESULT.md` with first line `VERDICT: DIRECT_BLOCKED`, the exact 403/Cloudflare status, full recon notes, and the 26-02 handoff (Oxylabs rewire via `apps/core/webscraper.py`, borrowed cohort-tracker creds per D-07, bounded probe + FEAS-03 cost go/no-go).

## Verification

- `grep -m1 -E '^VERDICT: (DIRECT_WORKS|DIRECT_BLOCKED)$'` → `VERDICT: DIRECT_BLOCKED` ✓
- `AdCostV2.objects.filter(crawled__date=today).count()` → `FRESH_ROWS=0` (consistent with a blocked smoke; no full pass) ✓
- Weekly `Scrape hemnet.se ad cost` PeriodicTask `ENABLED=False`; `[adhoc] Scrape hemnet.se ad cost` `ENABLED=False` — no schedule change ✓
- No Oxylabs calls, no secrets read/written, temp smoke script removed from droplet ✓

## Deviations from Plan

None — plan executed exactly as written. The smoke returned the expected-plausible blocked branch (P23 had only hoped the GraphQL POST was still direct-reachable); the plan's branch rule routed cleanly to `DIRECT_BLOCKED` without running the full pass.

**Commit note:** Task 1 produced no local repo file changes (its work was droplet-side recon + a smoke that wrote no rows), so it has no standalone local commit; its evidence is captured in the Task 2 result doc and this SUMMARY. Task 2's result doc was committed individually (`36a2290`).

## Authentication / gates

None. SSH key access worked first try with the documented `IdentitiesOnly=yes -o IdentityAgent=none` flags. The Hemnet 403 is the **target site's Cloudflare challenge**, not an auth failure — it is the intended measurement of this test, not a blocker.

## Known Stubs

None.

## Handoff

`26-02` is now **activated** (not a no-op). It must build the Oxylabs rewire of `search_ad_cost_2` (P23 `webscraper.py` pattern), using borrowed cohort-tracker Oxylabs creds (D-07; droplet's own creds are dead 401), run a bounded validation probe with exact-spend reporting, and bring the operator the single FEAS-03 recurring-cost go/no-go (D-05).

## Self-Check: PASSED

- FOUND: `.planning/phases/26-ad-cost-scrape-feasibility/26-DIRECT-TEST-RESULT.md`
- FOUND: `.planning/phases/26-ad-cost-scrape-feasibility/26-01-SUMMARY.md`
- FOUND commit: `36a2290` (result doc)
