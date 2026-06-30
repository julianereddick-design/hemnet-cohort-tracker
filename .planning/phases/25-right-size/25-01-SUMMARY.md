---
phase: 25-right-size
plan: 01
status: complete
completed: 2026-06-30
requirements: [SIZE-01]
---

# 25-01 SUMMARY — Pre-flight safety + Metabase gate-off

## What was done

Established the pre-flight safety state and unlocked the smaller slug BEFORE any power-cycle, on the live price-scraper droplet `170.64.181.89` (DO `357087018`).

**Task 1 — D-07 pre-flight (read-only, PASS):** Confirmed the Phase 24-05 `127.0.0.1` loopback bind (commit `ed7192c`) is the *running* state, so the upcoming resize reboot will NOT re-expose Metabase :3000 / django :8000 (the Kinsing entry vector). Four agreeing checks:
- `ed7192c` present in `/var/www/apps/hemnet` (it is HEAD).
- Source `docker-compose.yml` publishes `127.0.0.1:8000:8000` (django) + `127.0.0.1:3000:3000` (metabase); `docker compose config` renders `host_ip: 127.0.0.1` for both. The lone `0.0.0.0:8000` in config output is the django `command:` in-container runserver bind, NOT a host publish.
- Live `docker ps` ports: `hemnet-django => 127.0.0.1:8000`, `hemnet-metabase => 127.0.0.1:3000`.
- Off-box TCP probe: **22 OPEN, 3000 + 8000 closed/filtered**.

**Task 2 — D-02 Metabase gate-off (operator-approved, reversible, PASS):** `docker stop hemnet-metabase` (Exited 143 = clean SIGTERM, no rm/down). Steady-state `used` RAM dropped **1.8 GiB → 979 MiB** (< ~1 GiB → 2 GB slug fits at idle). The 5 scraper containers (crawler/django/beat/writer/redis) stayed Up; playwright remained Exited (P23). Revert: `docker start hemnet-metabase`.

## Key files
- `.planning/phases/25-right-size/25-VERIFICATION.md` — D-07 pre-flight + D-02 gate-off evidence (created)

## Deviations / notes
- The PLAN's literal acceptance ("`docker compose config` shows `127.0.0.1:8000:8000`") does not match `docker compose config`'s long-form port rendering; verified intent instead via the source file's short form + the rendered `host_ip: 127.0.0.1` + live container ports + off-box probe. All agree → D-07 satisfied.
- Metabase measured at 968 MiB now (plans cited ~1.6 GiB — its RSS grows over uptime); still the largest consumer and the binding constraint that gating removes.
- Reality check: droplet hostname `ubuntu-s-1vcpu-2gb-syd1-01` is the legacy creation name; current actual size is genuinely `s-8vcpu-16gb` (nproc=8, 15Gi).

## Self-Check: PASSED
- D-07 loopback bind confirmed running-state (reboot-safe) ✓
- Metabase gated off reversibly; steady-state RAM < 1 GiB ✓
- Evidence appended to 25-VERIFICATION.md ✓
- No later plan proceeds if bind check failed — it passed ✓
