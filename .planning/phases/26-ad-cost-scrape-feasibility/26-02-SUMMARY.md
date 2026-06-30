---
phase: 26-ad-cost-scrape-feasibility
plan: 02
subsystem: ad-cost-scrape (price-scraper droplet, separate repo tt7676/hem-bol-scrapers)
tags: [oxylabs, graphql, cloudflare, feasibility, d04-escape-hatch, ad-cost]
ran: true
verdict: OXYLABS_REWIRE_BLOCKED_D04
requires:
  - 26-01 DIRECT_BLOCKED verdict (gate)
  - borrowed cohort-tracker Oxylabs Web Scraper API creds (OXYLABS_USERNAME/PASSWORD)
provides:
  - empirical characterisation of the Oxylabs POST-body wall for hemnet.se/graphql
  - operator checkpoint input for FEAS-02/FEAS-03 (needs a body-preserving Oxylabs product)
affects:
  - 26-03 (recurring-cost write-up — reframed around the unblock options, not a per-call extrapolation)
  - droplet apps/hemnet/tasks.py::search_ad_cost_2 (NOT modified — blocked pending creds)
tech-stack:
  added: []
  patterns: [oxylabs-web-scraper-api-universal-source, oxylabs-proxy-endpoints]
key-files:
  created:
    - .planning/phases/26-ad-cost-scrape-feasibility/26-OXYLABS-PROBE-RESULT.md
    - .planning/phases/26-ad-cost-scrape-feasibility/26-02-SUMMARY.md
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - D-04 escape hatch invoked — STOPPED before droplet mutation; brought an informed operator checkpoint rather than thrash
  - No borrowed creds installed on the malware-remediated droplet (they provably cannot deliver a POST body; avoids needless exposure)
metrics:
  oxylabs_calls: 18
  exact_spend_usd: 0.05
  spend_cap_usd: 0.49
  fresh_adcostv2_rows: 0
  duration: ~1 session
  completed: 2026-06-30
---

# Phase 26 Plan 02: Oxylabs Ad-Cost Rewire — Bounded Probe Summary

**One-liner:** The plan RAN (26-01 was `DIRECT_BLOCKED`); the bounded Oxylabs probe proved that Oxylabs reliably defeats Hemnet's Cloudflare block but the borrowed Web Scraper API credentials **cannot deliver a GraphQL POST body** through any integration method — a D-04 product/credential wall. **EXACT_SPEND_USD: 0.05** (18 calls, cap 200/$0.49). No droplet mutation; 0 fresh `AdCostV2` rows; operator checkpoint required.

## Did the plan run?

**Yes — it ran (it was NOT a no-op).** The Task-0 gate re-confirmed `26-DIRECT-TEST-RESULT.md` line 1 = `VERDICT: DIRECT_BLOCKED`, so the conditional Oxylabs rewire activated as intended.

## Outcome

`search_ad_cost_2` issues a body-bearing **GraphQL POST** (two steps: `AutocompleteLocations` → `SellerMarketingProductPrices`). The P23 rewire pattern only ever carried **GET** page fetches. Routing a POST-with-body was the plan's flagged "D-04 may be large/destabilizing" risk — and it materialised as a hard **credential/product-scope wall**, characterised empirically (off-box, on this repo's creds; representative because Oxylabs routes via its own proxy pool):

- **Cloudflare is defeatable.** Every Oxylabs method that reached Hemnet returned an *origin-level* response (HTTP 404 for GET, GraphQL `BAD_REQUEST` JSON for POST) — never the 403 "Just a moment…" challenge the droplet IP hit directly in 26-01.
- **The POST body cannot be delivered with the borrowed Web Scraper API creds.** The universal source accepts + validates `context.content` (base64) and performs a real POST (httpbin → 200), but the body arrives empty (Hemnet → "Must provide query string"; httpbin → `data:""`). The proxy endpoint (`:60000`) strips the body. The two products that *would* carry a raw POST body — Web Unblocker (`unblock.oxylabs.io:60000`) and residential/datacenter proxies (`pr.oxylabs.io:7777` / `dc.oxylabs.io:8001`) — reject these creds (401 / 407). GraphQL-over-GET is unavailable (Hemnet `/graphql` returns 404 for GET).

Full method-by-method table + operator options are in `26-OXYLABS-PROBE-RESULT.md`.

## Tasks

| Task | Plan intent | Status |
|------|-------------|--------|
| 0 (gate) | Re-read 26-01 verdict line 1 | Done — `DIRECT_BLOCKED`, plan activated |
| 1 | Reroute POST through webscraper.py + install borrowed creds on a feature branch + rebuild hemnet image | **Not executed** — blocked by the D-04 transport wall discovered during probe validation; no working path to deploy, so no droplet mutation was made |
| 2 | Bounded Oxylabs probe → fresh `AdCostV2` rows + exact spend | **Ran as a transport-validation probe** — characterised the wall; **0 fresh rows** (POST body undeliverable); spend $0.05 / 18 calls |

## Spend

- **OXYLABS_CALLS: 18** · **EXACT_SPEND_USD: 0.05** (list rate $2.4/1,000 = $0.0024/call); marginal ≈ $0 on Decade's flat $249/mo Advanced Web Scraper API plan (P23 basis).
- Under the pre-authorized 200-call / ~$0.49 cap. No crawl beyond the cap; no full crawl (that is Phase 27).

## Deviations from Plan

**D-04 escape hatch invoked (authorized by the plan + orchestrator STOP guidance).** Two intentional deviations from the happy path, both correctness/safety-driven:

1. **No droplet mutation.** No feature branch, no creds written to the droplet `.env`, no hemnet image rebuild, no container recreate. Rationale: the rewire provably cannot land fresh `AdCostV2` rows with these creds (POST body undeliverable), so building + deploying it would not satisfy the probe's core acceptance and would needlessly expose borrowed secrets on a malware-remediated box. The reversible-first call is to characterise the wall and bring the checkpoint. All 5 lean containers verified untouched (e.g. `hemnet-redis` CreatedAt 2026-04-18); P24 `docker-compose.override.yml` untouched.
2. **Probe used for transport validation, not row-landing.** The bounded probe (within budget) was spent proving the transport wall rather than landing rows, because landing rows is impossible until a body-capable Oxylabs product exists.

No Rule 1/2/3 auto-fixes were applicable (no code was changed). No secrets committed or logged.

## Known Stubs

None — no code was written.

## Operator Checkpoint (FEAS-02/FEAS-03 input)

To deliver a working Oxylabs ad-cost path, provision a **body-preserving Oxylabs product**:
- **A. Web Unblocker** (`unblock.oxylabs.io:60000`) — preserves POST bodies + beats Cloudflare; cleanest fit.
- **B. Residential/DC proxy creds** (`pr.oxylabs.io:7777`) — raw proxy forwards the literal POST.
- **C.** Refresh the droplet's OWN creds AND confirm its plan tier transmits POST bodies (the current borrowed Advanced plan does not).

Recommendation: **A or B**. The remaining build is small — Cloudflare bypass, the recon, and the write path are all already solved. **Cost is not the obstacle** (~$0.29/run at list for a full 120-call pass, ≈$0 marginal); transport capability is. This is the natural, now-creds-shaped input to 26-03's single recurring-cost go/no-go.

## Self-Check: PASSED

- FOUND: `.planning/phases/26-ad-cost-scrape-feasibility/26-OXYLABS-PROBE-RESULT.md` (with `EXACT_SPEND_USD: 0.05` + `OXYLABS_CALLS: 18`)
- FOUND: `.planning/phases/26-ad-cost-scrape-feasibility/26-02-SUMMARY.md`
- FOUND: commit `81672f7`
- VERIFIED: droplet untouched — still on `feat/p24-durable-hardening` @ `ed7192c` (unchanged), no `feat/ad-cost-oxylabs` branch; no creds written to droplet `.env`; no image rebuild; 5 lean containers intact.
