# 23-PLAYWRIGHT-GATEOFF — Reversible gate-off of the self-hosted Playwright worker (Phase 23-03)

**Date:** 2026-06-29
**Requirement:** FETCH-03 (retire self-hosted Playwright as a resource driver — gated off, NOT hard-removed)
**Action:** `docker stop hemnet-crawler-playwright` (STOP only — no `rm`/`down`/`prune`; compose service + local-Chromium code left in place).

## Before → After (RAM)
| | used | free | available |
|---|---|---|---|
| BEFORE | 8.6 GiB | 353 MiB | 6.7 GiB |
| AFTER  | **2.6 GiB** | 6.3 GiB | **12 GiB** |

- `hemnet-crawler-playwright` was holding **6.045 GiB** (`docker stats` before stop).
- **RAM freed ≈ 6.0 GiB** — used-memory dropped 8.6 → 2.6 GiB; available rose 6.7 → 12 GiB.
- This is the ~6.2 GB driver whose removal makes a Phase-25 4 vCPU / 8 GB right-size plausible.

## Container state (after)
```
hemnet-crawler-playwright   Exited (0) (still listed in `docker ps -a`, NOT removed)
hemnet-crawler              Up   (default-queue eventlet worker, now runs the Oxylabs fetch)
hemnet-beat                 Up   (CreatedAt 2026-04-18 — unchanged)
hemnet-writer               Up   (CreatedAt 2026-04-18 — unchanged)
hemnet-django               Up   (CreatedAt 2026-04-18 — unchanged)
hemnet-redis                Up   (CreatedAt 2026-04-18 — unchanged)
hemnet-metabase             Up   (CreatedAt 2026-04-18 — unchanged)
hemnet-django-run-e2e…      Up   (stale orphan, untouched — Phase 24)
```
- Assertions: running `hemnet-crawler-playwright` count = **0**; `docker ps -a` count = **1** (Exited-but-present).
- Every other container retains its original `CreatedAt` (not recreated); `hemnet-redis` and the booli/writer
  queues untouched.

## Reversibility (intact)
- `crawler-playwright` compose service **NOT deleted**: `grep -c crawler-playwright docker-compose.yml` = **2**.
- `docker-compose.yml` **not edited**: `git status --porcelain docker-compose.yml` = empty.
- Local-Chromium code path (`init_browser` / `get_page_source` in `apps/hemnet/tasks.py`) left fully in place.

### One-line revert recipe
```
docker start hemnet-crawler-playwright          # bring the worker back immediately
# (equivalent: cd /var/www/apps/hemnet && docker compose up -d crawler-playwright)
```
**Caveat:** a future full `docker compose up -d` or a `bin/restart.sh` would also restart this container.
The **durable** gate is the Plan 23-01 routing change — the Hemnet fetch no longer routes to
`playwright_queue` (the three fetch tasks now route to the `default` queue), so even if the Playwright
container restarts it receives no Hemnet work. To fully retire it (delete service + code + permanent RAM
reclaim) is deferred to Phase 24/25.

## Why this is safe now
- The Hemnet fetch was re-wired (23-01) and proven via Oxylabs (23-02: 0.00 % 403 over 200 pages).
- All Hemnet beat tasks are `enabled=False` (no automatic scraping), so stopping this worker drops no live work.
- Fully reversible (`docker start`).

## Note (carried from 23-02, not blocking this gate-off)
Production Hemnet scraping on the droplet is independently gated on refreshing the droplet's own Oxylabs
Web Scraper API credentials (currently 401) — a team/operator action, escalated separately. The Playwright
path was already 403-blocked, so this gate-off introduces no regression.
