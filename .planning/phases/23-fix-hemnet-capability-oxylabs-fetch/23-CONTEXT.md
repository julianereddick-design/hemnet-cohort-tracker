# Phase 23: Fix Hemnet capability (Oxylabs fetch) - Context

**Gathered:** 2026-06-29
**Status:** Ready for planning
**Source:** Orchestrator-captured during `/gsd-plan-phase 23` (research disabled for this infra milestone; the Phase-22 audit is the evidence base. Three gating gray-area decisions captured via question.)

<domain>
## Phase Boundary

Route the **Hemnet listing/search fetch** on the team-owned price-scraper droplet `170.64.181.89` (`s-8vcpu-16gb`, syd1, root; repo `github.com/tt7676/hem-bol-scrapers`; app at `/var/www/apps/hemnet`) through the **Oxylabs path already present in the repo** (`apps/core/webscraper.py`, added in team PR #22 "feat/webscraper-api") instead of the self-hosted local Chromium path (the `hemnet-crawler-playwright` container on celery `playwright_queue`, conc=8, the 6.2 GB RAM driver). End the Hemnet 403 blocking and retire self-hosted Playwright as a resource driver.

This is the first **mutating** phase of milestone v4.0 (Phase 21 = access, Phase 22 = read-only audit). It is a **prerequisite enabler for Phase 25 (right-size)**: removing the 6.2 GB Playwright RAM driver is what makes a 4 vCPU / 8 GB slug plausible.

**In scope:**
- Re-wire `apps.hemnet.tasks.search_listings_2` (and the sub-tasks it dispatches) so the page fetch goes through `apps/core/webscraper.py` (Oxylabs proxy/API, creds in `.env` `OXYLABS_*`) rather than enqueuing to `playwright_queue` / driving local Chromium (FETCH-01).
- A **bounded, operator-pre-approved verification crawl** (~200 Hemnet pricing pages) proving the 403 block rate drops to ~0, with cost reported (FETCH-02).
- **Gate off** self-hosted Playwright: stop routing to `playwright_queue` and stop the `hemnet-crawler-playwright` container, leaving its code + compose service in place as a one-line revert (FETCH-03).

**NOT in scope:**
- Hard deletion of the Playwright compose service / local-Chromium code (deferred to Phase 24/25 cleanup — see decision below).
- Any other cleanup: the 4.4 GB `kill.log`, 6.6 GB `scraper_log_export`, ~49 GB `simple_history` DB bloat, the stale orphan container, the dangling RSA key blob, and the **🚨 Kinsing/kdevtmpfsi malware** finding — all Phase 24 (the malware should precede/accompany Phase 24 per the audit; it is NOT remediated here, but Phase 23 work runs on this known-infected host — see constraint).
- The Booli fetch (out of scope; only Hemnet is broken/403-blocked).
- Resize / slug change — Phase 25.
- block_inc / procore / spotify — Phase 24 kill candidates, untouched here.
</domain>

<decisions>
## Implementation Decisions

### Delivery mechanism — in-place on droplet + team-repo branch (operator decision 2026-06-29)
- Edit the source directly in `/var/www/apps/hemnet` on the droplet, commit the change to a **feature branch in the team repo** (`tt7676/hem-bol-scrapers`), and rebuild **only the `hemnet` Docker image** (not a full-stack rebuild).
- Matches the milestone's stated **"clean-up & resize in place (not rebuild)"** approach. Reversible: the branch isolates the change from `main`/team deploys, and the gated (not deleted) Playwright path is a one-line revert.
- Do **not** merge to the team's default branch or trigger their deploy pipeline in this phase — coordinate any upstreaming separately. The branch + rebuilt-image approach lets us prove the fix without forcing a team merge.

### Playwright retirement — gate off reversibly, do NOT hard-remove (operator decision 2026-06-29)
- Stop routing Hemnet fetches to `playwright_queue`; stop the `hemnet-crawler-playwright` container so it no longer consumes the 6.2 GB RAM.
- **Leave** the `crawler-playwright` compose service definition and the local-Chromium code path in place so retirement is a one-line revert if the Oxylabs path regresses.
- Hard removal (delete compose service + dead code + the RAM footprint permanently) is **deferred to Phase 24/25**, once the Oxylabs path has proven stable over real runs.

### 403 verification — bounded crawl pre-approved for THIS phase (operator decision 2026-06-29)
- A small **capped verification crawl (~200 Hemnet pricing pages, N=200+ per the standing sample-size rule)** is **pre-authorized** as part of execution to prove FETCH-02 (~0 403s). Report the Oxylabs call count + cost back after the run.
- This is the one paid-run exception explicitly granted for this phase. Any crawl **beyond** the agreed ~200-page bound still requires a fresh per-run go-ahead (standing no-Oxylabs-without-approval rule).

### Production-safety guardrails (team-owned live prod box)
- This is a **team-owned production droplet** running a live (manually/externally triggered) scraper. Treat every change as reversible-first:
  - Work on a feature branch; never force-push or touch team `main`.
  - Rebuild only the `hemnet` image; do not `docker prune`, do not stop booli/core/redis/metabase/django/writer/beat containers.
  - Snapshot the current `apps/hemnet/tasks.py` routing + the `crawler-playwright` service state before editing, so rollback is exact.
  - Connect exactly per the runbook (`IdentitiesOnly` gotcha).
- **Malware caveat:** the host runs a per-minute `kill.sh` suppressing Kinsing/kdevtmpfsi. Phase 23 does NOT remediate it, but be aware the box is compromised — do not introduce new exposed services, and keep `OXYLABS_*` / DB creds out of logs and the repo.

### Claude's Discretion
- Exact code shape of the re-wire (e.g. call `webscraper.py` inline in the task vs a thin adapter), provided the fetch demonstrably goes through Oxylabs and not local Chromium.
- How the verification crawl is invoked (management command, standalone script, or a one-off task run) and how 403s are counted/reported.
- Whether to re-enable the disabled `Scrape hemnet.se` beat task as part of verification or trigger the task manually (manual trigger preferred to avoid changing the prod schedule — but a short manual run is fine).
- Log/inspection commands used to confirm routing (within the safety guardrails).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Droplet facts + access (executor connects exactly as documented)
- `docs/price-scraper-droplet-runbook.md` — host/IP/region, root user, exact SSH command + `IdentitiesOnly` gotcha, key inventory.
- `.planning/phases/21-consistent-access/21-CONTEXT.md` — access decisions + verified durable-access state.

### Evidence base for the fix (Phase 22 audit)
- `docs/price-scraper-droplet-audit.md` — app inventory, the `hemnet-crawler-playwright` RAM-driver finding, `core`/`webscraper.py` = the Oxylabs path, the 121 MB `HEMNET_http_blocking_signals.log`, scheduled-work table (beat tasks DB-backed, all scrape tasks disabled), keep/kill, the 🚨 malware escalation.
- `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md` — raw command outputs: container list (§1), celery queues/`playwright_queue` worker cmd, `docker stats` (crawler-playwright 6.228 GiB), beat schedule rows (`apps.hemnet.tasks.search_listings_2` etc.), redis queues, `core.webscraper.py` dependency note.

### Scope + requirements
- `.planning/ROADMAP.md` (Phase 23 section) — goal + 3 success criteria; **Depends on Phase 21**.
- `.planning/REQUIREMENTS.md` — FETCH-01, FETCH-02, FETCH-03 wording.
- `.planning/PROJECT.md` (v4.0 milestone) — `audit-before-kill`, fix-in-place approach, team-repo provenance.

### On-droplet source (read on the box before editing)
- `/var/www/apps/hemnet/apps/core/webscraper.py` — the Oxylabs fetch path to route through.
- `/var/www/apps/hemnet/apps/hemnet/tasks.py` — `search_listings_2` + sub-tasks that currently drive the playwright path.
- `/var/www/apps/hemnet/docker-compose*.yml` + `bin/` restart scripts — the `crawler-playwright` service to gate off.
- `/var/www/apps/hemnet/.env` — `OXYLABS_*` creds (values stay off logs/repo).

### Standing operator constraints (memories)
- `feedback_no_oxylabs_without_approval`, `feedback_default_larger_sample_sizes` (N=200+), `project_droplet_inventory` (this box is SEPARATE from cohort-tracker), `project_hemnet_flipped_to_oxylabs` (the cohort-tracker repo already flipped Hemnet to Oxylabs — precedent), `project_droplet_audit_phase22`.

### Adjacent milestone phases (do NOT do their work here)
- Phase 24 = cleanup (gated on Phase 22 audit; consumes this phase's gated-off Playwright + does the hard-remove + malware + log/DB reclaim). Phase 25 = right-size (consumes the freed RAM).
</canonical_refs>

<specifics>
## Specific Ideas
- The Hemnet local-Chromium driver is the `hemnet-crawler-playwright` container: `celery -A config.celery worker --concurrency=8 -Q playwright_queue` (evidence §1). It is the single biggest RAM consumer at 6.228 GiB / 15.61 GiB (~40%).
- The Oxylabs path was recently added by the team: merge "feat/webscraper-api" (PR #22, Sat Apr 18 2026) — `apps/core/webscraper.py`. The fix routes through code the team already wrote, not greenfield.
- The Hemnet scrape entry point: beat task `Scrape hemnet.se` → `apps.hemnet.tasks.search_listings_2` (cadence `0 23 * * *` Sydney, currently DISABLED). Ad-cost variant: `apps.hemnet.tasks.search_ad_cost_2`.
- Blocking evidence already on disk: `scraper_log_export/HEMNET_http_blocking_signals.log` (121 MB) — historical 403 signal; the verification crawl proves the post-fix rate.
- Redis broker is shared (`hemnet-redis`), queues `default`/`playwright_queue`/`writer_queue` — gating off Hemnet→playwright must not disturb the booli/writer queues.
- The cohort-tracker repo already proved Hemnet-via-Oxylabs works (memory `project_hemnet_flipped_to_oxylabs`) — strong precedent that the approach is sound.
</specifics>

<deferred>
## Deferred Ideas
- Hard removal of the Playwright compose service + local-Chromium code + permanent RAM reclaim — Phase 24/25.
- Kinsing/kdevtmpfsi malware remediation — Phase 24 (should precede/accompany cleanup).
- Log + DB-bloat reclaim (`kill.log`, `scraper_log_export`, `simple_history`) — Phase 24.
- Upstreaming the Oxylabs-fetch change to the team's default branch / their deploy pipeline — coordinate separately, post-phase.
- Re-enabling the Hemnet beat schedule for ongoing production runs — operator decision once the fix is proven (manual triggers used for verification here).
</deferred>

---

*Phase: 23-fix-hemnet-capability-oxylabs-fetch*
*Context gathered: 2026-06-29 via /gsd-plan-phase orchestrator (3 gray-area decisions captured)*
