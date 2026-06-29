---
phase: 22-deep-dive-audit
verified: 2026-06-29T00:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase 22: Deep-dive audit — Verification Report

**Phase Goal:** A complete, evidence-based understanding of everything running on the droplet, with keep/kill recommendations — so nothing is removed blind. Gates Phase 24.
**Verified:** 2026-06-29
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Audit doc inventories every app (hemnet, booli, spotify, procore, block_inc, core) with purpose, owner, and last-active evidence (AUDIT-01) | VERIFIED | `docs/price-scraper-droplet-audit.md` §"App inventory" — 6-row table with all apps, purpose, owner (team/Illia/Raymond), and last-active mtimes; reframing that they are Django modules in one project is evidenced by `ls /var/www/apps` output + `LOCAL_APPS` capture in `22-EVIDENCE.md §1` |
| 2 | Data + storage mapped: Postgres DB(s)/tables, Metabase, Redis, Docker volumes, large logs (sizes, incl. kill.log) (AUDIT-02) | VERIFIED | Audit doc §"Data + storage map": `defaultdb` 55 GB with top-table breakdown from `pg_stat_user_tables`; Redis DBSIZE 5 / 8.66 MiB; Metabase v0.47.1 on managed PG (credentials redacted); 4 Docker volumes 25.4 MB; kill.log **4.4 GB** (4,685,891,472 B from `ls -la`, evidence §2) + blocking log **121 MB** |
| 3 | All scheduled/triggered work enumerated — Celery beat schedule, queues, restart scripts — with cadence (AUDIT-03) | VERIFIED | Audit doc §"Scheduled / triggered work": kill.sh every minute (`* * * * *`); 8 DB-backed Celery beat tasks all with cron strings; every scrape task DISABLED (`last_run=None`); only `celery.backend_cleanup` enabled (`0 4 * * *`); restart scripts in `bin/` documented as manual/deploy-time |
| 4 | Real resource + cost baseline captured: actual CPU/mem/disk vs the s-8vcpu-16gb allocation (AUDIT-04) | VERIFIED | Audit doc §"Resource + cost baseline": doctl confirms 8 VCPUs / 16384 MB / 50 GB disk; load avg 0.29/0.18/0.15 on 8 cores (CPU idle); RAM 8.9 Gi used (15 Gi total), dominated by crawler-playwright 6.2 GiB; disk 30 G used (62%) of 49 G; per-container docker stats table present |
| 5 | Each non-Hemnet-price app (incl. Booli) has a keep/kill recommendation backed by dependency evidence (AUDIT-05) | VERIFIED | Audit doc §"Keep/kill recommendations": booli=Keep (cohort-tracker consumes `booli_listing` 234k rows); core=Keep (shared lib, middleware, imported by scrapers); block_inc=Kill (disabled, 14 mo stale, 0 live tuples); procore=Kill (disabled, 19 mo stale, 0 live tuples); spotify=Kill (disabled, 8 mo stale, no tables). Hemnet stated explicitly as "keep-by-default primary workload". Every verdict cites evidence §§ |

**Score: 5/5 truths verified**

### Additional Plan Must-Haves (22-01 and 22-02)

| Must-Have | Status | Evidence |
|-----------|--------|----------|
| Read-only evidence for all 6 apps, storage, scheduled work, and resource baseline captured verbatim in 22-EVIDENCE.md | VERIFIED | `22-EVIDENCE.md` 286 lines, five labelled sections (§1–§5), all 6 apps present, real command outputs including byte counts and container states |
| The 4.6 GB kill.log and 121 MB blocking log sizes recorded from ls/stat (not contents read) | VERIFIED | Evidence §2: `ls -la` shows 4,685,891,472 bytes; `du -sh` shows 4.4G; `ls -la` shows 121,124,632 bytes for blocking log. Sizes from metadata commands only, contents never read. Note: "4.6 GB" was the pre-audit estimate; actual measurement is 4.4 GiB/4.7 GB (SI) — the audit correctly reports the measured value |
| Dependency evidence (shared Postgres / Redis / crons) captured to back keep/kill calls | VERIFIED | Evidence §5 and audit doc §"Keep/kill": `defaultdb` coupling (scraper produces, cohort-tracker consumes), single shared Redis broker, `core` imports, no block_inc/procore/spotify consumers found |
| No droplet state mutated and no secret values copied into the repo | VERIFIED | Forbidden-mutation grep: no matches in evidence file; footer confirms "No mutations performed; secrets redacted". DATABASE_URL password shown as `<REDACTED>`, DJANGO_SECRET_KEY/OXYLABS_* listed by name only with "none copied here" |
| Every claim cites the command/path it came from | VERIFIED | Each audit doc section header cites the specific commands from the evidence file; preamble states every number is cited to `22-EVIDENCE.md §1–§5` |
| No secret values in the audit doc | VERIFIED | Credential key names listed at line 127 with "none copied here"; grep for `password|secret|token|api_key|OXYLABS|DJANGO_SECRET` returns only safe references (key names, not values); the `<REDACTED>` in evidence file is not replicated in the audit doc |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md` | Raw read-only command outputs for sections 1-5 of the audit | VERIFIED | 286 lines; contains `docker ps` output, `kill.log` with byte count, all 5 sections populated with real command outputs |
| `docs/price-scraper-droplet-audit.md` | The evidence-based 5-section droplet audit with keep/kill recommendations | VERIFIED | 132 lines (above 80 min_lines threshold); contains all required headings; all 6 apps; `kill.log` size; `s-8vcpu-16gb`; cites `22-EVIDENCE` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `22-EVIDENCE.md` | `docs/price-scraper-droplet-audit.md` | Plan 22-02 synthesizes the prose audit from raw evidence | WIRED | Audit doc preamble: "every number below is cited to `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md` (sections §1–§5)"; each section header cites specific evidence commands |
| `docs/price-scraper-droplet-audit.md` | Phase 24 cleanup | Per-app keep/kill verdict + dependency evidence gates removal | WIRED | Keep/kill table present with explicit "what breaks if removed" column; Hygiene section states "this audit gates Phase 24 (cleanup)"; "keep/kill" and "Kill (audit-cleared)" present throughout |

### Data-Flow Trace (Level 4)

Not applicable. This phase produces documentation artifacts (markdown files), not components that render dynamic data from a data source.

### Behavioral Spot-Checks

SKIPPED — documentation-only phase; no runnable entry points produced.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| AUDIT-01 | 22-01, 22-02 | Every app inventoried with purpose, owner, last-active | SATISFIED | 6-row inventory table in audit doc with all apps, owner attribution, and mtime evidence |
| AUDIT-02 | 22-01, 22-02 | Data + storage mapped (Postgres, Metabase, Redis, Docker volumes, logs with sizes) | SATISFIED | Full storage section in audit doc: managed PG 55 GB, Redis 8.66 MiB, Metabase, Docker volumes 25.4 MB, kill.log 4.4 GB, blocking log 121 MB |
| AUDIT-03 | 22-01, 22-02 | All scheduled/triggered work enumerated with cadence | SATISFIED | Schedule table: 1 system cron (per-minute), 8 Celery beat tasks (7 disabled, 1 enabled), restart scripts |
| AUDIT-04 | 22-01, 22-02 | Real resource + cost baseline vs s-8vcpu-16gb allocation | SATISFIED | doctl confirmation of 8 vCPU/16 GB/50 GB; actual usage: CPU idle, RAM 8.9/15 Gi, disk 30/49 G; per-container docker stats |
| AUDIT-05 | 22-01, 22-02 | Per non-Hemnet app keep/kill recommendation backed by dependency evidence | SATISFIED | 5-app verdict table with dependency evidence column; all verdicts cite evidence sections |

All 5 AUDIT requirements are mapped to Phase 22 in REQUIREMENTS.md traceability table and all are satisfied. No orphaned requirements identified.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `docs/price-scraper-droplet-audit.md` | None — documentation deliverable | — | — |
| `22-EVIDENCE.md` | None — raw evidence appendix | — | — |

No forbidden mutation commands appear in the evidence file (grep: no matches). No secret values appear in either artifact. The `kill.sh` script content (which contains `kill $(pgrep kdevtmp)` etc.) is correctly captured as *quoted output* of reading an existing script, not as commands the auditor ran.

### Human Verification Required

None. All must-haves are verifiable from the artifacts without droplet access.

---

## Notable Findings (informational, not gaps)

**1. "4.6 GB kill.log" vs actual 4.4 GB:** The pre-audit context and REQUIREMENTS.md estimated the kill.log at "4.6 GB". The actual `ls -la` measurement found 4,685,891,472 bytes = ~4.4 GiB (or ~4.7 GB in SI). The evidence and audit doc correctly use the measured value (4.4 GB). This is evidence of real SSH measurement, not a deficiency.

**2. "6 apps" reframing as Django modules:** The roadmap framed the apps as six separate deployments. The audit correctly discovered and documented that they are Django sub-apps inside a single `hemnet` image and project (`/var/www/apps/hemnet/apps/*`). This is evidenced by `ls /var/www/apps/` (only one directory), `LOCAL_APPS` in settings, and `docker ps` (all containers use image `hemnet`). The reframing is prominently disclosed in a callout box at the top of both `22-EVIDENCE.md` and the audit doc. This is accurate evidence, not a gap.

**3. All scrape beat tasks DISABLED:** The audit found every scrape task (including hemnet and booli) is disabled with `last_run=None` in the DB-backed Celery beat schedule. Only `celery.backend_cleanup` is enabled. Workers are up and queues empty at capture. This is an unexpected operational finding, correctly surfaced.

**4. Active cryptomining malware (kinsing/kdevtmpfsi):** The per-minute `kill.sh` cron is a whack-a-mole suppression of live malware, not a routine maintenance script. This is the cause of the 4.4 GB kill.log. The audit correctly escalates this in the Hygiene section and does not attempt remediation (out of scope for a read-only audit).

**5. Shared `defaultdb` coupling:** The scraper droplet's external managed Postgres (`defaultdb`) is the SAME database used by this cohort-tracker repo. The scraper produces `hemnet_listingv2` and `booli_listing`; the cohort-tracker consumes them. This shared-DB coupling is the dependency evidence backing the Booli=Keep verdict and is correctly documented.

---

## Gaps Summary

No gaps. All five roadmap success criteria are satisfied by cited, evidence-backed content in `docs/price-scraper-droplet-audit.md`, with the full evidence chain in `22-EVIDENCE.md`. Phase 24 is cleared to proceed on the basis of this audit.

---

_Verified: 2026-06-29_
_Verifier: Claude (gsd-verifier)_
