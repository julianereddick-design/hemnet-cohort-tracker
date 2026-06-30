---
phase: 25-right-size
plan: 03
status: complete
completed: 2026-06-30
requirements: [SIZE-01]
---

# 25-03 SUMMARY — Reversible right-size to s-1vcpu-2gb

## What was done

**Task 1 — Pre-resize gate (PASS):** Operator-approved power-cycle. The `default` doctl token proved read-only (power-off 403'd, droplet stayed `active` — clean stop, no mutation), so the operator provisioned a write-scoped token (passed inline, never persisted). D-07 second checkpoint re-confirmed pre-reboot (3000/8000 closed, compose loopback count 2). PRE state `16384/8/50/active`.

**Scope safety (operator-raised mid-run):** `doctl compute droplet list` confirmed 7 droplets; only `357087018` acted on. Cohort-tracker box (556306295) + 5 others stayed `active`. Shared managed Postgres `defaultdb` is external — untouched by a droplet CPU/RAM resize.

**Task 2 — Power-cycle (PASS):** `power-off --wait` → `resize --size s-1vcpu-2gb --resize-disk=false --wait` → `power-on --wait`. POST state **2048 / 1 / 50 / active**. Reversible (disk preserved at 50 G). SSH back with fresh uptime (0 min), Mem total 1.9 GiB, disk 50 G.

## Key files
- `.planning/phases/25-right-size/25-VERIFICATION.md` — `## Pre-resize gate` + `## Resize executed` (appended)

## Deviations / notes
- The `default` doctl token is read-only (reads OK, writes 403); operator provided a temporary write-scoped token. Memory [[database-ip-whitelisting]] updated with this finding. Token to be revoked after 25-04 green (T-25-07).
- Cost cut: ~$96/mo (`s-8vcpu-16gb`) → ~$12/mo (`s-1vcpu-2gb`), SIZE-01.

## Self-Check: PASSED
- Write token proven (power-off succeeded, not 403) ✓
- D-07 re-confirmed pre-reboot ✓
- Power-off → reversible resize (--resize-disk=false) → power-on, disk preserved at 50 G ✓
- POST doctl shows 2048/1/50 active; SSH reachable, fresh uptime ✓
