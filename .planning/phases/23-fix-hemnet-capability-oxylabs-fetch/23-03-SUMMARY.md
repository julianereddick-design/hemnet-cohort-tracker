# Plan 23-03 Summary — Reversible gate-off of self-hosted Playwright

**Status:** Complete (2026-06-29) · FETCH-03 met (reversible gate-off) · ~6 GB RAM freed
**Plan:** 23-03 · Wave 3 · `requirements: FETCH-03`
**Artifact:** `.planning/phases/23-.../23-PLAYWRIGHT-GATEOFF.md`

## What was done
`docker stop hemnet-crawler-playwright` (STOP only — no `rm`/`down`/`prune`, no compose edit). The
container is `Exited (0)` and still listed; the `crawler-playwright` compose service and the local-Chromium
code path remain fully in place as a one-line revert.

## Evidence
- **RAM freed ≈ 6.0 GiB**: used 8.6 → **2.6 GiB**, available 6.7 → **12 GiB** (the container held 6.045 GiB).
- `docker ps` running `hemnet-crawler-playwright` = **0**; `docker ps -a` = **1** (Exited-but-present).
- Other containers (`redis`, `metabase`, `beat`, `django`, `writer`, `crawler`) all `Up` with original `CreatedAt`.
- Reversibility intact: `grep -c crawler-playwright docker-compose.yml` = **2**; `git status --porcelain docker-compose.yml` empty (unedited).
- `GATEOFF_OK` (plan automated verify passed); gate-off doc = 48 non-blank lines, **0 secret patterns**.

## Revert recipe
`docker start hemnet-crawler-playwright`. Caveat: a full `docker compose up -d` / `bin/restart.sh` would also
restart it — the **durable** gate is the 23-01 routing change (Hemnet fetch no longer flows to `playwright_queue`).

## Why safe
Hemnet fetch re-wired (23-01) + proven via Oxylabs (23-02, 0.00 % 403); all Hemnet beat tasks `enabled=False`
(no live work dropped); the Playwright path was already 403-blocked (no regression); fully reversible.

## Carryover (not blocking this plan)
Production Hemnet scraping on the droplet is gated on refreshing the droplet's own Oxylabs Web Scraper API
credentials (currently **401** — see 23-02). Team/operator action; escalated. Hard removal of Playwright +
permanent RAM reclaim is deferred to Phase 24/25; the freed ~6 GB enables the Phase-25 right-size.
