---
phase: 23-fix-hemnet-capability-oxylabs-fetch
verified: 2026-06-29T00:00:00Z
status: passed
score: 3/3 success-criteria verified (1 production dependency flagged: droplet Oxylabs creds 401)
overrides_applied: 0
re_verification: false
verified_by: orchestrator-inline (droplet evidence; no subagent SSH, for prod-safety on the malware-compromised box)
---

# Phase 23: Fix Hemnet capability (Oxylabs fetch) — Verification Report

**Phase Goal:** Route the Hemnet listing/search fetch through the Oxylabs path already in the repo instead of direct local Chromium, ending the 403 blocking and removing self-hosted Playwright as a resource driver.
**Verified:** 2026-06-29 · **Status:** passed (with one flagged production dependency — see below)
**Method note:** Verified inline by the execute-phase orchestrator using direct droplet evidence (in-container greps, runtime route resolution, `docker ps`/`free -h`, and a 200-page Oxylabs crawl). A subagent verifier was deliberately NOT spawned to SSH the live, malware-compromised team prod box.

---

## Success Criteria

### ✅ Criterion 1 — Hemnet fetch routes through the Oxylabs `webscraper.py` path (not local Chromium), verifiable in code + logs  →  MET (FETCH-01)
- `apps/hemnet/tasks.py` (branch `feat/hemnet-oxylabs-fetch`, commit `7d0fe7c`): new helper `fetch_via_webscraper()` calls `WebScraper(...).run()` (Oxylabs); all 4 `run_async(get_page_source(url))` local-Chromium call sites replaced. In-container `grep -vE '^#' | grep -c webscraper` = **7**; remaining `run_async(get_page_source(` = **0**.
- `config/settings/base.py`: the 3 fetch tasks (`search_listings_2`, `search_pre_market_listings_2`, `scrape_listing_2`) repointed `playwright_queue → default`. Runtime resolution confirmed all three → `{'queue': 'default'}`. (Necessary addition beyond 23-01's tasks.py-only files_modified — routing lives in settings; documented in 23-01-SUMMARY.)
- Django import smoke in-container: `IMPORT_OK` (helper present, `WebScraper` resolves, no circular import). Worker `hemnet-crawler` recreated on the new image, clean celery boot, 0 tracebacks.
- Scoping deviation (documented): `search_ad_cost_2` (GraphQL POST, default queue) left unchanged — not the 403-blocked HTML/Chromium path; out of scope for retiring the Playwright RAM driver.

### ✅ Criterion 2 — Verification crawl returns ~0 403s  →  MET (FETCH-02)
- 200 Hemnet listing pricing pages + 5 search pages via Oxylabs `source=universal`: **200/200 OK (HTTP 200, `__NEXT_DATA__` present), 0 HTTP-403, 0 blocks → 0.00 % block rate.** Audit samples = real 183–214 KB listing pages. Evidence: `23-VERIFICATION-CRAWL.md`. Decisive contrast with the retired Chromium path's historical 403 log (`HEMNET_http_blocking_signals.log`, 121 MB).

### ✅ Criterion 3 — Self-hosted Playwright gated off, no longer runs  →  MET (FETCH-03)
- `hemnet-crawler-playwright` `docker stop` → `Exited (0)`, still present (reversible). **RAM freed ≈ 6.0 GiB** (used 8.6 → 2.6 GiB; available → 12 GiB). Compose service + local-Chromium code intact (`grep -c crawler-playwright` = 2, `docker-compose.yml` git-clean). One-line revert: `docker start hemnet-crawler-playwright`. Evidence: `23-PLAYWRIGHT-GATEOFF.md`.

## Requirements traceability
| Req | Status | Evidence |
|---|---|---|
| FETCH-01 | ✅ met (code) | tasks.py + base.py on branch `7d0fe7c`; in-container grep + runtime routes |
| FETCH-02 | ✅ met | 0.00 % 403 over 200 pages (`23-VERIFICATION-CRAWL.md`) |
| FETCH-03 | ✅ met | playwright container stopped, ~6 GB freed, reversible (`23-PLAYWRIGHT-GATEOFF.md`) |

## Guardrails honored
- Feature branch only (`feat/hemnet-oxylabs-fetch`); team `main` untouched at `ff397e9` (== pre-edit HEAD), never pushed/merged. 1 commit on branch. No secrets in any commit or artifact (all secret-scan gates = 0). No `prune`/`down`; only the targeted worker + the Playwright container touched; all other containers retain original `CreatedAt`. Beat schedule unchanged (all Hemnet tasks `enabled=False`). No new exposed service on the compromised host.

## ⚠️ Production dependency (flagged, NOT a phase gap)
The droplet's **own** Oxylabs Web Scraper API credentials return **HTTP 401** (stale/never-exercised — the local-Chromium path never used the API). The phase's code re-wire is correct and the Oxylabs approach is proven, but **production Hemnet scraping on the droplet will not function until the team refreshes the droplet's Oxylabs API credentials.** This is an operator/team action, explicitly out of this phase's scope (the phase writes no secrets to the malware-compromised box). The verification crawl was therefore run off-box on Decade's Oxylabs account. **Escalated to the operator.**

## Verdict
**PASSED.** All 3 success criteria and FETCH-01/02/03 verified at the code + run-evidence level. The single open item — refreshing the droplet's dead Oxylabs API credentials — is an external operational dependency, escalated, and does not represent incomplete phase work. Branch not merged to team `main` (per scope). Phase 25 right-sizing is unblocked (~6 GB RAM freed).
