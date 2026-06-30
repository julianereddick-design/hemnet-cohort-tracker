# Phase 26 → Phase 27 handoff (resume the AdCostV2 scrape)

**Phase 26 (feasibility) = COMPLETE 2026-06-30.** Operator checkpoint resolved **GO** — pursue the scrape; cost is trivial, a cheap residential-egress path is validated. This handoff is the build spec for Phase 27 (SCRAPE-01/02).

## What Phase 26 concluded (read the result docs for evidence)
- **Direct GraphQL POST is dead** from the droplet IP (Cloudflare 403) — `26-DIRECT-TEST-RESULT.md`.
- **Borrowed Oxylabs Web Scraper API can't carry the POST body** (D-04) — `26-OXYLABS-PROBE-RESULT.md`.
- **The data IS capturable** with a real browser that has cleared Cloudflare — proven live (`26-BROWSER-RENDER-PROBE-RESULT.md`) and validated on a hosted residential browser (`26-STEEL-VALIDATION.md`): Göteborg @ 5M → Bas 6 820 / Plus 10 900 / Premium 15 300 / Max 21 200 kr.
- **The droplet's own headless Chromium is also Cloudflare-blocked from its DC IP** (`26-DROPLET-CHROMIUM-TEST.md`) — so the egress MUST be residential/managed. The droplet still has the Playwright 1.52 + Chromium image intact (`26-DROPLET-PLAYWRIGHT-RECON.md`), just parked.

## The production technique (decided)
**Load `hemnet.se/priser` through a residential/managed browser session, let it clear Cloudflare, then do a QUIET in-page `fetch('/graphql')` — do NOT automate the form.** Scripted clicking/typing triggers a mid-session Cloudflare Turnstile re-challenge ~half the time; a single in-page fetch (the page's own request) does not. Cloudflare clearing is **probabilistic per IP → wrap in retry-on-block** (fresh session/IP on challenge). The working harness pattern is `scripts/probe-steel-adcost.js` (retry loop + form-ready gating already built).

## Egress decision (one input still pending)
Same in-page-fetch code works for all; only the session provider differs. Ranked:
1. **Oxylabs render + `execute_javascript`** — **$0 extra** on the existing $249/mo plan. ⏳ PENDING: operator sent the inquiry (`26-OXYLABS-INQUIRY.md` Q1 = "does render support in-page JS execution returning its result?"). If YES → use this, no new vendor.
2. **Steel.dev** — **VALIDATED** (~$10 one-time floor already paid + ~$0.50/mo). Key in gitignored `.env` as `STEEL_API_KEY` (⚠️ rotate — was pasted in chat). Harness: `scripts/probe-steel-adcost.js` (deps: `npm i --no-save steel-sdk playwright-core`).
3. Bright Data Scraping Browser (~$0.13/mo, KYC friction) — fallback.

**Recommendation:** wait for the Oxylabs reply; if yes, build on rank 1 ($0); else build on Steel (rank 2). Don't re-litigate — both are proven-cheap.

## Phase 27 build tasks (SCRAPE-01/02)
1. **Capture the `SellerMarketingProductPrices` query string** — we have `webAutocompleteLocations` (in the Steel probe output); still need the price query text. Get it via one clean form submit through the residential session, OR reconstruct from the droplet's `apps/hemnet/tasks.py::search_ad_cost_2`.
2. **Build the in-page-fetch crawler:** for each of 10 munis × 6 asking-price levels (2M/5M/7.5M/10M/15M/20M): autocomplete → locationId → `SellerMarketingProductPrices(locationId, askingPrice, productCodes[7])` → parse `prices[].{code, price.amount}`. ~120 GraphQL calls/run. Retry-on-block.
3. **Wire it into the droplet's `search_ad_cost_2`** (replace the dead direct `requests.post` egress with the chosen residential path) on a FEATURE BRANCH in the team repo `tt7676/hem-bol-scrapers` (NEVER team main; rebuild only the hemnet image; reuse P23 reversible-delivery guardrails). Writes `AdCostV2` to the shared managed Postgres `defaultdb`.
4. **Re-enable the weekly PeriodicTask** ("Scrape hemnet.se ad cost", cron `0 6 * * 1`) only after a bounded validation crawl lands fresh rows. (Cron wiring proper = Phase 29.)
5. Cost is trivial (~$0.50/mo or $0); report exact spend per the standing rule.

## Key references
- Memory: `project_ad_cost_feasibility_p26` (full recap), `project_phase23_oxylabs_fetch_and_dead_creds`, `project_droplet_audit_phase22`, `project_droplet_right_sized_p25`.
- Docs: `docs/ad-cost-scrape-cost.md` (FEAS-03), all `.planning/phases/26-ad-cost-scrape-feasibility/26-*.md`.
- Droplet SSH: `ssh -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=12 -i ~/.ssh/droplet_ed25519 root@170.64.181.89` (repo at `/var/www/apps/hemnet`).

*Scaffold Phase 27 with `/gsd-plan-phase 27` (or `/gsd-discuss-phase 27` first) in a fresh context — it will load the memory + these docs.*
