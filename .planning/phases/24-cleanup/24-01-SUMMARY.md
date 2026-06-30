---
phase: 24-cleanup
plan: 01
status: complete
wave: 1
autonomous: true
completed: 2026-06-30
requirements: [CLEAN-02, CLEAN-04]
---

# 24-01 SUMMARY — Recon (R0–R3)

## Objective met
Strictly read-only / additive-only reconnaissance of the live, compromised price-scraper
droplet `170.64.181.89` (DO 357087018). Snapshotted every revertible state, hunted the
re-spawner across all persistence locations the Phase-22 audit missed, and identified the
live entry vector by off-box reachability probe. Zero droplet state mutated.

## What was found (the inputs 24-02 needs)

- **R0:** `/root/24-backup/` created (additive). 15-item manifest covers all-user crontabs,
  cron.d, spool listing, systemd units+timers, authorized_keys, docker state, disk, ps,
  listening sockets. This is the documented revert path (D-06).
- **R1:** `/etc/ld.so.preload` **ABSENT** → no LD_PRELOAD rootkit; `ps`/`ss` trustworthy.
- **R2:** **No local re-spawner.** The `[kdevtmpfs]` process is the legit kernel thread
  (PID 62, PPID 2/kthreadd) — not the `kdevtmpfsi` miner. No miner binaries staged. Crons:
  only the per-minute `kill.sh` suppressor (root crontab) + commented restart lines; no
  wget/curl in cron; all 15 systemd timers stock. → miner is re-introduced **over the
  network**, not relaunched locally (validates research Assumption A1).
- **R3 — Branch (A) LIVE VECTOR:** `:8000` (django runserver/DEBUG=True) and `:3000`
  (Metabase **v0.47.1**, known Kinsing target) are bound 0.0.0.0 **and internet-reachable
  off-box**. Docker API (unix-socket only) and Redis (bridge-only, but **no requirepass**)
  are NOT externally reachable. ufw allows only 22/80/443 but **Docker DNAT bypasses ufw**,
  and **no DO Cloud Firewall exists** (`doctl firewall list` empty; doctl authenticated). 
- **kill.log** baseline: ~4.37 GiB (per-minute kill output = proof the miner keeps returning).

## Key files
- created: `.planning/phases/24-cleanup/24-VERIFICATION.md` (12-section evidence skeleton;
  R0/R1/R2/R3 populated with real command output; R4–R7 + reclaim/keys/table seeded for
  later plans)
- created (on droplet, additive): `/root/24-backup/` (15-file reversibility set)

## Hand-off to 24-02 (operator-gated)
24-02 Task 1 input is fixed: **create a DO Cloud Firewall on droplet 357087018**
(default-deny inbound except 22/80/443 from the operator source; explicitly close 3000 +
8000 at the DO edge), THEN R4 persistence removal (minimal — only `kill.sh` itself is the
local foothold) + R5 kill/disable + R6 observe. Source-level fix deferred to 24-05.

## Self-Check: PASSED
- All 3 task acceptance gates PASS (verified via the plans' own automated grep checks).
- No destructive token in evidence file; no secret value pasted (Redis requirepass empty).
- Read-only/additive guardrail honored: nothing on the droplet was removed, moved, killed,
  stopped, disabled, or firewall-changed in this plan.

## Note for Phase 25 (not a blocker)
Droplet reports `ubuntu-s-1vcpu-2gb-syd1-01` (1vcpu/2gb), not the s-8vcpu-16gb in older
audit notes — verify true size during the right-size phase.
