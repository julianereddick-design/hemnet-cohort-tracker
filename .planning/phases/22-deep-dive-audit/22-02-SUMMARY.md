# Plan 22-02 Summary — Synthesize the audit doc

**Status:** Complete (2026-06-29) · both task gates green
**Plan:** 22-02 · Wave 2 · depends_on 22-01 · `requirements: AUDIT-01..05`
**Artifact:** `docs/price-scraper-droplet-audit.md` (132 lines; alongside the Phase-21 runbook)

## What was done
Synthesized `22-EVIDENCE.md` into the decision-grade audit doc with the five mandated sections mapping 1:1 to AUDIT-01..05, every claim cited to evidence §1–§5, real numbers, no secret values. Added a Hygiene & deferred findings section.

## Self-Check: PASSED
- Task 1 gate (sections 1–4, all 6 apps, `kill.log` size, `s-8vcpu-16gb`, `22-EVIDENCE` cite, no secrets): PASS.
- Task 2 gate (Keep/kill + Hygiene sections, per-app verdicts, `primary workload`/`keep-by-default`, RSA + Phase 24, no secrets): PASS.
- 132 lines (> 80 min_lines).

## Coverage (success criteria)
- **AUDIT-01** ✓ App inventory table — 6 apps reframed as Django modules, purpose/owner/last-active.
- **AUDIT-02** ✓ Data+storage — managed PG `defaultdb` 55 GB + table sizes, Redis, Metabase, Docker, logs incl. 4.4 GB kill.log + 121 MB blocking log.
- **AUDIT-03** ✓ Scheduled work — kill.sh/min, only `backend_cleanup` enabled, all scrapes disabled, restart scripts.
- **AUDIT-04** ✓ Baseline — confirmed `s-8vcpu-16gb`, CPU idle, RAM 8.9/16 (playwright 6.2), disk 30/49.
- **AUDIT-05** ✓ Keep/kill — Keep booli/core (dependency-backed), Kill block_inc/procore/spotify (idle+0-rows), Hemnet keep-by-default primary.

## Notable outputs for downstream phases
- **Booli keep/kill question resolved → KEEP** (cohort tracker consumes `booli_listing`).
- Phase 24 cleanup targets enumerated with evidence: 3 kill-cleared apps, ~21 GB disk + ~49 GB DB bloat, stale orphan container, dangling RSA key.
- 🚨 Kinsing/kdevtmpfsi **malware** finding surfaced for escalation (separate from cleanup).
- Phase 25 baseline captured; Phase 23 (retire Playwright) identified as the RAM-driver removal that enables a smaller slug.

## Deviations
None beyond the app-count reframing already captured in 22-01 (Django modules, not services) — reflected throughout the doc.
