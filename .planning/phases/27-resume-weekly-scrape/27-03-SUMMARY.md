---
phase: 27-resume-weekly-scrape
plan: "03"
subsystem: ad-cost-scraper
tags: [droplet, steel, playwright, eventlet, subprocess, feature-branch]
dependency_graph:
  requires: [27-02 (validated technique + corrected webPricingCalculator contract)]
  provides: [droplet feat/adcost-steel-resume — rewired search_ad_cost_2 + adcost_steel.py]
  affects: [27-04 (on-box live validation can now run; then enable weekly cron)]
key_files:
  created:
    - "droplet: apps/hemnet/adcost_steel.py"
    - .planning/phases/27-resume-weekly-scrape/27-03-DROPLET-WIRING-NOTES.md
  modified:
    - "droplet: apps/hemnet/tasks.py (search_ad_cost_2 egress rewire)"
    - "droplet: .env (STEEL_API_KEY appended, gitignored)"
decisions:
  - "No image rebuild — repo is volume-mounted (.:/app); worker restart loads new code"
  - "Subprocess crawl — Playwright incompatible with the crawler's eventlet loop"
  - "Key read from /app/.env, not the compose environment allow-list (avoids container recreate)"
metrics:
  droplet_commit: 4a5e1a7
  feature_branch: feat/adcost-steel-resume
  scrape_fired: false
  completed: "2026-07-01"
---

# Phase 27 Plan 03: Droplet Wiring Summary

**One-liner:** Ported the validated Steel in-page-fetch crawler into the droplet's production
`search_ad_cost_2` on a feature branch — as a subprocess crawl using the corrected
`webPricingCalculator` contract — verified it imports and registers with no scrape fired and the
weekly PeriodicTask still disabled.

## What was done

- **Operator gate (Task 1): APPROVED** by Julian (explicit, naming box 170.64.181.89).
- Forked `feat/adcost-steel-resume` off the box's running HEAD (`feat/p24-durable-hardening`);
  backed up the original `tasks.py`.
- Added `apps/hemnet/adcost_steel.py` (standalone async Steel/CDP crawler) and rewrote
  `search_ad_cost_2` to drive it via subprocess + keep the `AdCostV2` ORM write.
- Installed `STEEL_API_KEY` into the gitignored `.env` (read in-container at `/app/.env`).
- Restarted only `hemnet-crawler` (no rebuild — volume-mounted code; no disturbance to the
  P25 `ondemand`-gated metabase/crawler-playwright).
- Committed `4a5e1a7` on the feature branch (never team main).

## Deviations (all justified — see 27-03-DROPLET-WIRING-NOTES.md)

1. **Restart, not image rebuild** — `volumes: .:/app` makes code live; rebuild unnecessary.
2. **`/app/.env` key read, not env-list injection** — avoids a compose edit + container recreate
   on the RAM-tight box.
3. **Subprocess crawl** — Playwright cannot run under the worker's eventlet pool.
4. **Contract port** (not just egress swap) — the pinned op was dead (27-02 finding).

## Verification (no scrape, PeriodicTask still disabled)

| Check | Result |
|-------|--------|
| `search_ad_cost_2` imports under Django | OK |
| `adcost_steel` imports standalone | OK (crawl / parse_pricing / read_steel_key) |
| celery worker registered the task | YES |
| `parse_pricing` in-container fixture | BAS→BASIC 6820, RAKETEN_3_DAGAR→TOPLISTING 1580 |
| both ad-cost PeriodicTasks `enabled=False` | YES |
| `.env` gitignored + untracked | YES |
| droplet HEAD is feature branch, not main | `feat/adcost-steel-resume` |

## Next (27-04)

On-box live validation: run `search_ad_cost_2` once on the box (first real run of the Python
port — fresh `AdCostV2` rows with `crawled >= today` across ≥8 munis + tiers), then — only if
rows land — flip the weekly `Scrape hemnet.se ad cost` PeriodicTask to `enabled=True`. Document
the ~3.5-month gap (Mar 16 → resume) as a forward hole.
