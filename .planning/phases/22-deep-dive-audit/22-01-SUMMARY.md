# Plan 22-01 Summary — Read-only evidence sweep

**Status:** Complete (2026-06-29) · all 3 task gates green
**Plan:** 22-01 · Wave 1 · `requirements: AUDIT-01..05`
**Artifact:** `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md` (5 sections, real numbers, secrets redacted)

## What was done
Connected READ-ONLY (Phase-21 root key) to the live team droplet `170.64.181.89` and captured raw inspection output into `22-EVIDENCE.md`: container inventory, the 6 Django apps + last-active, host/resource baseline (doctl + free/df/docker stats), managed-PG db/table sizes + django-celery-beat schedule (read-only SELECTs via the django container), Redis/queues, on-disk logs, docker images/volumes, and per-app dependency facts. **No droplet state mutated; no secret values copied (all `<REDACTED>`).**

## Self-Check: PASSED
- `## 1`..`## 5` all populated with real command output.
- Task 1/2/3 automated gates: PASS (after rewording 3 prose lines that tripped the secret-redaction regex as false positives — "Secret values"/"password stripped"/"password `<REDACTED>`").
- Forbidden-mutation grep gate: clean.

## Key findings (feed 22-02 + downstream phases)
1. **"6 apps" = Django sub-apps in ONE project** (`apps/{block_inc,booli,core,hemnet,procore,spotify}`), not 6 services. Only the `hemnet` image runs (7 live containers + 1 stale orphan). **Deviation from the ROADMAP's framing — keep/kill = enable/remove a module, not a container.**
2. 🚨 **SECURITY:** `kill.sh` runs every minute via cron, killing/deleting `kinsing` + `kdevtmpfsi` (**known cryptomining malware**) — an active/recurring infection being whack-a-mole'd. This per-minute `find /` + append generates the 4.4 GB `kill.log`. → escalate; relevant to Phases 24 and beyond.
3. **DB is external + shared:** a DO **managed Postgres** `defaultdb` (55 GB) shared by the scraper AND this cohort-tracker repo (`sold_match`, `cohort_*`, `view_log` live there). Scraper produces `hemnet_listingv2` (206k rows) + `booli_listing` (234k rows) that the cohort tracker consumes. Metabase reads the same DB.
4. **All scrape beat-tasks are DISABLED** (`enabled=False`, `last_run=None`) incl. hemnet + booli; only `celery.backend_cleanup` is enabled. Live scraping is triggered manually/externally, not by beat.
5. **Resource baseline (Phase 25):** confirmed `s-8vcpu-16gb` / 50 GB (doctl); load ~0.2 on 8 cores (CPU idle); RAM 8.9/16 GB driven by `crawler-playwright` (6.2 GB). Disk 30/49 GB — reclaimable ≈ 21 GB (kill.log 4.4 G + scraper_log_export 6.6 G + docker images 10.2 G) and DB bloat 49 GB (`booli_historicallisting` 34 G + `hemnet_historicallistingv2` 15 G, 0 live tuples).
6. **Keep/kill raw inputs:** KEEP hemnet, booli (cohort tracker depends on booli_listing), core (shared lib). KILL candidates: block_inc, procore, spotify — all task-disabled, code stale, tables 0 live tuples (spotify has no tables).
7. **Hygiene (Phase 24):** dangling inline `ssh-rsa` blob on Tom's `authorized_keys` line 1 confirmed (inert).

## Deviations
- App-count framing corrected (see finding 1) — recorded in evidence, not a blocker.
- Postgres table/schedule data gathered via `docker exec -i hemnet-django python manage.py shell` running read-only SELECTs (no psql container exists; DB is managed/external). Within the read-only guardrail.

## Next
Plan 22-02 synthesizes `docs/price-scraper-droplet-audit.md` from this evidence.
