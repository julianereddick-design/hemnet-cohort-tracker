---
phase: 24-cleanup
plan: 05
status: complete
wave: 5
autonomous: false
completed: 2026-06-30
requirements: [CLEAN-04]
---

# 24-05 SUMMARY — Durable hardening + scraper comeback

## Objective met
CLEAN-04 durable closure: the entry vector is fixed at the SOURCE (loopback bind, not only the
firewall), secrets rotated/refreshed, and the Hemnet scraper re-verified GREEN through Oxylabs —
all reversibly, on a feature branch, team `main` untouched, zero secret values written down.

## Per-fix decisions (branched on the 24-01/24-02 diagnosis, didn't assume)
- **Fix 1 — vector at source: DONE.** Compose port scope — `:8000`/`:3000` rebound to
  `127.0.0.1` (commit `ed7192c` on `feat/p24-durable-hardening` off the P23 branch). Off-box both
  now closed by binding. Docker daemon already unix-socket-only; Redis bridge-only → no change.
- **Fix 2 — DEBUG=False: DONE.** runserver→gunicorn = **localhost-interim + TODO** (loopback-only
  now; swap needs a rebuild, avoided pre-resize).
- **Fix 3 — Metabase upgrade: localhost-interim + TODO.** :3000 loopback-only closes the RCE
  exposure; major upgrade migrates its store on the shared managed Postgres = too risky pre-resize.
- **Fix 4 — secrets.** `DJANGO_SECRET_KEY` rotated on-box. Oxylabs refreshed — **operator reused
  the cohort-tracker Web Scraper creds** (copied machine-to-machine, never logged); dedicated
  rotatable sub-user = TODO. `DATABASE_URL`/`MB_DB_*` (shared `defaultdb`) = coordinate-or-defer,
  not rotated. `.env` backed up to `/root/24-backup/env.pre-24-05.bak`.

## Deploy + verify
- **No rebuild needed** (image already had the P23 fetch code) — recreated only
  `crawler`/`django`/`metabase` (`--no-deps`); redis/beat/writer + gated-off playwright untouched.
  Rollback tag `hemnet:pre-24-05` taken first.
- **Re-verify crawl: SCRAPER GREEN.** 50/50 Hemnet pages OK, **0 HTTP-403, 0 auth-401** via the
  new creds (after correcting a verifier false-positive on the `cdn-cgi/challenge-platform` script
  Hemnet embeds in normal pages — production keys on `__NEXT_DATA__`, which is present).
  Oxylabs cost ≈ **~$0.63** (~251 calls incl. the bug re-verify).
- 6 hemnet containers Up; Playwright still Exited (gated off, P23).

## Key files
- `.planning/phases/24-cleanup/24-05-HARDENING.md` (branch, per-fix decisions, secret-rotation
  record, crawl result, revert recipe)
- `docs/price-scraper-droplet-remediation.md` (hardening items marked DONE/interim + open follow-ups)
- droplet revert set: `/root/24-backup/{docker-compose.pre-24-05.bak, env.pre-24-05.bak, env.pre-oxy.bak}` + `hemnet:pre-24-05` image tag

## Self-Check: PASSED
- All 3 task gates PASS; no secret value in any doc/commit; team `main` untouched.
- Scraper re-verified green empirically (50/50). Every change reversible (per-fix commits + tags + .env backup).

## Open follow-ups (recorded in remediation doc)
Dedicated Oxylabs sub-user; shared-`defaultdb` cred coordination; Metabase upgrade + gunicorn
(localhost-only meanwhile); reboot-persistence (now covered by the compose loopback bind).
