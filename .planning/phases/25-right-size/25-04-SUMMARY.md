---
phase: 25-right-size
plan: 04
status: complete
completed: 2026-06-30
requirements: [SIZE-02]
---

# 25-04 SUMMARY — Post-resize verification (SIZE-02) — GREEN

## What was done

**Task 1 — Post-reboot infra health + recovery (PASS):** The first 2 GB boot OOM-crash-looped (SSH banner timeout, no swap). Root cause: the Metabase gate was NOT reboot-persistent — `hemnet.service`→`bin/restart.sh` re-runs `docker compose up`, and the Docker daemon itself auto-restarts the `on-failure` container (Metabase exits 143 on `docker stop`). Fixed durably with two mechanisms: a `docker-compose.override.yml` marking Metabase `profiles: ["ondemand"]` (boot `compose up` skips it) + `docker update --restart=no hemnet-metabase` (daemon won't restart it). Recovered via reversible re-resize up to 4 GB, applied the fix, rolled back to 2 GB. Reboot test confirmed Metabase stays down; bind survived (3000/8000 closed off-box).

**Task 2 — Verification crawl + GREEN verdict (operator-approved):** First launch revealed a second RAM hog — `hemnet-crawler-playwright` (celery `--concurrency=8`, ~600 MiB), also auto-restarted on boot (same P23 gate-gap), leaving only ~184 MiB headroom. Gated it the same durable way (override profile + `--restart=no`) → avail 1115 MiB. Re-ran the bounded `fetch_via_webscraper` crawl (205 pages @ conc 5) on the resized box with a RAM/OOM watch:
- `ok=178, blocked_403=0, auth_401=0, exc=0` → **0% HTTP-403**.
- **Peak 733 MiB** on the 1963 MiB box (~37%); **no OOM** (dmesg clean).
- Cost ~$0.53. Staged harness removed.

**Final end-state (reboot-validated):** `s-1vcpu-2gb`; 5 scrapers Up; Metabase + Playwright Exited with `restart=no` (reboot-persistent); bind closed off-box; used 627 MiB / avail 1.1 GiB; disk 50 G.

## Key files
- `.planning/phases/25-right-size/25-VERIFICATION.md` — Task 1 recovery + Task 2 GREEN (appended); status → passed
- Droplet `/var/www/apps/hemnet/docker-compose.override.yml` (untracked) — gates metabase + crawler-playwright to `ondemand`

## Deviations / notes
- **Major:** the D-02/P23 `docker stop` gate is not reboot-persistent on this box (boot compose-up + daemon on-failure restart). Resolved with compose `ondemand` profiles + `docker update --restart=no` for BOTH metabase and crawler-playwright. This is the correct lean steady state for a monthly crawler. The 229-day uptime hid the gap.
- **Reversible rollback used as designed:** re-resize up to 4 GB to heal, then back to 2 GB — disk preserved made it possible.
- Open follow-up: provision a dedicated rotatable Oxylabs sub-user (still borrowing cohort-tracker creds); revoke the write-scoped doctl token (T-25-07).

## Self-Check: PASSED
- N≥200 crawl ran only after operator approval; 0 HTTP-403; no OOM ✓
- Bind survived reboot (3000/8000 closed off-box) ✓
- 5 scrapers healthy; Metabase + Playwright gated reboot-persistently ✓
- GREEN verdict recorded; rollback path exercised and documented ✓
