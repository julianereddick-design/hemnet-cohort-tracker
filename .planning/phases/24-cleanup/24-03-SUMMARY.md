---
phase: 24-cleanup
plan: 03
status: complete
wave: 3
autonomous: false
completed: 2026-06-30
requirements: [CLEAN-01, CLEAN-02, CLEAN-04]
---

# 24-03 SUMMARY — Retire kill.sh + reclaim disk

## Objective met
~17 GB of disk reclaimed (79% → 45% used), kill.sh fully retired, cleared apps confirmed
disabled, container set reduced to the price-scraper essentials — no table dropped, no team
repo edited, live hemnet image/containers untouched. Unblocks Phase 25 right-size.

## What was done (operator-gated; operator chose "delete logs, reclaim all")
- **R7:** gate honored (R6 = WINDOW CLEAN). kill.sh line removed from crontab (no active jobs
  left; revert via backup). kill.log (no open handle) deleted → ~5 GB freed (79%→70%).
- **CLEAN-01:** PeriodicTask dump confirms block_inc/booli/hemnet/procore/spotify/ad-cost all
  `enabled=False, last_run=None`; only `celery.backend_cleanup` enabled. Confirm-only — no
  module/table removal (D-02); 49 GB simple_history bloat left untouched (D-03).
- **Orphan:** `hemnet-django-run-e2e3a39dc795` (Up 7mo) removed, config saved to
  `/root/24-backup/orphan-inspect.json` first. 6 live containers + gated-off playwright intact.
- **Reclaim:** build-cache prune 3.169 GB (no dangling images present — P23 already cleared
  them, so the plan's ~10 GB image estimate was stale); scraper_log_export 6.6 GB deleted
  (no open handle). Live `hemnet:latest` (10.5 GB) + old `84f261d04e6d` both protected.

## Deviation vs plan
- Plan estimated ~21 GB (assumed ~10 GB dangling images). Actual ~17 GB — Phase 23 had
  already reclaimed the dangling images. Docker contribution was build cache (3.17 GB), not
  images. Total still well above the right-size threshold.
- Orphan `docker stop` printed "No such container" then the orphan was gone (config saved
  pre-removal); benign, end-state verified by `docker inspect` failing.

## Key files
- `.planning/phases/24-cleanup/24-VERIFICATION.md` — `## R7` + `## Reclaim …` populated with
  before/after `df` + `docker system df`
- on droplet: `/root/24-backup/{root.crontab.pre-retire.bak, orphan-inspect.json}` (revert set)

## Live box state at handoff
Disk 22G/49G (45%) · kill.sh RETIRED · vector still CLOSED (from 24-02) · 6 live containers Up ·
live hemnet image intact · no miner. ⚠ Host iptables drops still not reboot-persistent →
durable fix = 24-05.

## Self-Check: PASSED
- All 3 task gates PASS; reclaim verified by before/after df (79%→45%).
- No live container stopped, no live image pruned, no DROP TABLE, no repo edit (grep gates green).
- Every removal backed up / reversible where applicable.

## Hand-off to 24-04 (operator-gated)
authorized_keys hygiene (drop the inert dangling RSA blob, keep 3 known-good keys, lock-out
guard), re-run the full Verification table green, copy `/root/24-backup/` off-box into repo
evidence, write the operator-owned remediation/incident record.
