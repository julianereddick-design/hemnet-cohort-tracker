---
phase: 24-cleanup
plan: 05
doc: HARDENING
status: in-progress
host: 170.64.181.89 (droplet 357087018)
scraper_repo: tt7676/hem-bol-scrapers @ /var/www/apps/hemnet
started: 2026-06-30
---

# 24-05 — Durable Source-Hardening (D-08)

No secret VALUE appears in this doc — key names + "rotated/ported/deferred" facts only.

## Precondition gate (verified-clean)

24-04 `## Verification table` = all-PASS, **box VERIFIED CLEAN** (no miner, no rootkit, vector
closed, apps disabled, Hemnet sole workload, access preserved). Gate satisfied → 24-05 proceeds.

## Feature branch + prior-image tag

- Branch: **`feat/p24-durable-hardening`** off `feat/hemnet-oxylabs-fetch` (base `7d0fe7c`) —
  team `main` NEVER touched. Mirrors the Phase-23 feature-branch posture.
- Prior-image rollback baseline: `hemnet:latest@549bc2ec0f41`, retagged **`hemnet:pre-24-05`**
  before the recreate (one-command rollback).
- Compose backup: `/root/24-backup/docker-compose.pre-24-05.bak`.

## Fix 1 — entry-vector source closure

Diagnosed vector (24-01/24-02 R3): internet-exposed **Metabase :3000 + django :8000**
(Docker port-publish on `0.0.0.0`, bypassing ufw). **Source fix = compose port scope:**
rebound both publishes to loopback in `docker-compose.yml`:
```
- 8000:8000  → - 127.0.0.1:8000:8000
- 3000:3000  → - 127.0.0.1:3000:3000
```
`docker compose config` → **COMPOSE_OK**. Committed as its own commit `ed7192c`
("harden(p24): bind :8000/:3000 to 127.0.0.1"). After recreate, **off-box probe: :8000 and
:3000 closed by binding** (durable in-config, independent of the host-iptables interim from
24-02, which stays as defense-in-depth). Docker daemon was already unix-socket-only (no
daemon.json) and Redis is bridge-only — no daemon/redis change needed.

## Fix 2 — runserver / DEBUG

- **`DEBUG=False` applied now** via the `DJANGO_DEBUG` env key (django now boots on
  `config.settings.prod`, confirmed in logs).
- **runserver→gunicorn = localhost-interim + TODO.** With :8000 now loopback-only (Fix 1), the
  dev-server is no longer internet-reachable, so the swap is not urgent; it needs a gunicorn
  install + image rebuild = avoided right before the Phase-25 resize (escape hatch). TODO recorded.

## Fix 3 — Metabase upgrade

**localhost-interim + TODO.** With :3000 now loopback-only (Fix 1), the Metabase v0.47.1
pre-auth RCE (CVE-2023-38646 class) is no longer internet-reachable. A major version upgrade
**migrates Metabase's app schema on the SHARED managed Postgres** (`MB_DB_*` → same cluster as
the cohort-tracker's `defaultdb`) — too risky to run right before the resize. Deferred to a
TODO; the image tag swap remains a one-line future change. Reach Metabase meanwhile via
`ssh -L 3000:localhost:3000`.

## Fix 4 — secret rotation

`.env` backed up to `/root/24-backup/env.pre-24-05.bak` (and `env.pre-oxy.bak`) BEFORE changes.
- **`DJANGO_SECRET_KEY`** — **rotated** on-box (generated via `secrets.token_urlsafe`, written
  straight into `.env`, value never printed/committed).
- **Oxylabs (`OXYLABS_WEBSCRAPER_USERNAME`/`OXYLABS_WEBSCRAPER_PASSWORD`)** — the droplet's own
  creds were dead (401, Phase 23). **Operator decision: reused the working cohort-tracker Web
  Scraper API creds** (operator owns both; box is verified-clean), copied **machine-to-machine**
  from this repo's `.env` into the droplet `.env` over SSH via stdin (values never printed or
  committed). ⚠ **TODO (follow-up): replace with a DEDICATED rotatable Oxylabs sub-user** to
  contain blast radius — reused-now/isolate-later was the operator's explicit choice. Ported
  only now (post-verified-clean).
- **`DATABASE_URL` + `MB_DB_*`** — **coordinate-or-defer, NOT rotated.** They point at the
  managed `defaultdb` **SHARED with this cohort-tracker repo**; a blind rotate would break the
  cohort-tracker's own jobs. Deferred with a coordinated-rotation TODO (or a separate scraper DB
  user) — never blind-rotated.

## Rebuild + re-verify crawl

**No image rebuild needed** — the current `hemnet:latest` already carries the Phase-23 fetch
code; only `.env` + compose + bind-mounted settings changed, so the affected containers were
**recreated** (not rebuilt): `docker compose up -d --no-deps crawler django metabase`.
Disturb-nothing check: `crawler/django/metabase` show fresh `CreatedAt`; `redis/beat/writer` +
the gated-off `crawler-playwright` retain ORIGINAL `CreatedAt`. **6 hemnet containers Up,
Playwright still Exited.** crawler celery `ready`; django up on `config.settings.prod`.

Bounded verification crawl (operator-approved): real `fetch_via_webscraper()` on recent
`ListingV2` Hemnet URLs via the new creds, concurrency 5.

**Result — SCRAPER GREEN, ~0% block (403) rate.**
- Diagnostic (1 page): HTTP 200, 182 KB, `__NEXT_DATA__` + `askingPrice` + `listingId` present
  = a real, fully-loaded listing → creds authenticate, page comes back complete.
- **Corrected 50-page crawl: 50/50 OK, 0 blocked, 0 HTTP-403, 0 auth-401 → 100% OK, 0% 403.**
- (A first 200-page pass reported "100% blocked" — a **false positive in the verifier**, not a
  real block: it matched the `cdn-cgi/challenge-platform` Cloudflare script that Hemnet embeds in
  every *normal* page. Production keys on `__NEXT_DATA__`, which is present, so it treats these as
  successful — consistent with Phase 23's 200/200 OK.)
- **Oxylabs cost:** ~251 Web Scraper API calls total (200 + 1 diag + 50 corrected) ≈ **~$0.63**
  (slightly over the ~$0.50 estimate due to the re-verify of the verifier bug). Values/creds never logged.

Disturb-nothing confirmed: **6 hemnet containers Up** (crawler/django/metabase recreated;
redis/beat/writer original `CreatedAt`); `hemnet-crawler-playwright` still **Exited** (gated off,
P23). Rollback tag `hemnet:pre-24-05` present. Verifier scripts removed from the droplet.

## Revert recipe

Exact rollback (most-granular first):
- **One fix:** `cd /var/www/apps/hemnet && git revert <sha>` (each fix is its own commit; Fix 1 = `ed7192c`).
- **All source edits:** `git checkout feat/hemnet-oxylabs-fetch` (or `git checkout -- docker-compose.yml`) on the droplet checkout.
- **Image:** `docker tag hemnet:pre-24-05 hemnet:latest && cd /var/www/apps/hemnet && docker compose up -d --no-deps crawler django metabase`.
- **Secrets/.env:** `cp -a /root/24-backup/env.pre-24-05.bak /var/www/apps/hemnet/.env` (full restore) then recreate the affected containers.
- **Port exposure (if ever needed):** restore `docker-compose.pre-24-05.bak` + recreate; the 24-02 host-iptables interim + the now-removed publishes both kept the ports closed.
- **Escape hatches:** Fix 2/Fix 3 already on firewalled/localhost-interim with TODOs; the whole wave can split to a follow-up phase — the 24-02 containment + loopback bind hold the security line regardless.
