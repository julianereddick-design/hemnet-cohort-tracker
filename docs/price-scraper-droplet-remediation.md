# Price-Scraper Droplet — Malware Remediation & Incident Record

**Host:** `170.64.181.89` (DigitalOcean droplet `357087018`, `ubuntu-s-1vcpu-2gb-syd1-01`)
**Owner:** operator (owns both the DO droplet AND the scraper repo `tt7676/hem-bol-scrapers` —
no external host-owning team; this is the operator's own incident record, not an escalation).
**Remediated:** 2026-06-30, Phase 24 (waves 24-01 → 24-04). Durable source-hardening scheduled
for wave 24-05. Full command-level evidence: `.planning/phases/24-cleanup/24-VERIFICATION.md`.

---

## Summary

The box was running an active **Kinsing / `kdevtmpfsi` cryptominer**, suppressed every minute
by a `kill.sh` cron that killed the miner processes and deleted their binaries (growing a
**4.69 GB `kill.log`**). This was symptom-suppression, not remediation — the host was
compromised, not clean. Phase 24 root-caused and remediated it **in place, reversibly,
operator-gated**, then retired the suppressor and proved the box clean.

## What was found (recon, 24-01)

- **No local persistence re-spawner.** No rogue entry in any user crontab, `/etc/cron.d`,
  `/etc/crontab`, `/var/spool/cron`, systemd timers/units, or `/etc/ld.so.preload` (no rootkit).
  The `[kdevtmpfs]` process was the legitimate kernel thread (PID 62, parent kthreadd), **not**
  the `kdevtmpfsi` miner.
- **The re-infection was external (network) re-exploitation.** A miner with no local re-spawner
  that nonetheless returned every minute = re-introduced over the network. The open door:
  **internet-exposed Metabase v0.47.1** (a pre-authentication RCE — read-only dashboards and a
  login do **not** protect against it) and **django `runserver` with `DEBUG=True`**, both bound
  `0.0.0.0` on `:3000`/`:8000`. They were reachable from the internet because **Docker
  port-publishing DNAT bypasses ufw** (ufw allowed only 22/80/443) and **no DO Cloud Firewall
  existed**. nginx on `:80` also reverse-proxied both UIs. Docker API (unix-socket only) and
  Redis (bridge-only, though no `requirepass`) were **not** externally reachable.

## What was done (reversible, operator-gated)

| Wave | Action | Reversibility |
|------|--------|---------------|
| 24-01 | Snapshotted all revertible state to `/root/24-backup/` (additive) | — (backup set) |
| 24-02 | **Closed the vector** host-side: `iptables DOCKER-USER -i eth0 DROP` for :3000/:8000 + removed nginx :80/:443 from ufw. Verified off-box. | `iptables -D …` / `ufw allow …`; backups in `/root/24-backup/` |
| 24-02 | Disabled `kill.sh`, **observed 14 min with suppressor off + vector closed → 0 miner return** (vs prior sub-minute cadence) = box genuinely clean | re-enable via backed-up crontab |
| 24-03 | Retired `kill.sh`, deleted `kill.log` (4.69 GB), removed the 7-month orphan container, reclaimed build cache + `scraper_log_export` (~17 GB; disk 79%→45%) | crontab/orphan backups in `/root/24-backup/` |
| 24-04 | Rewrote `authorized_keys` (3 known keys, inert RSA blob dropped) — fresh-login verified | `authorized_keys.bak` |

**Forensic + reversibility set preserved off-box:** `/root/24-backup/` → repo `./verf-24-backup/`
(21 files; `orphan-inspect.json` redacted off-box — its container env held secret values, kept
on-box only). **CLEAN-01/02/03 verification table is all-PASS** (see VERIFICATION.md): malware
gone, no rootkit, vector closed, apps disabled, Hemnet the sole workload, access preserved.

## Verified-clean status

The box is **VERIFIED CLEAN** (all-PASS Verification table, 2026-06-30). The standing rule
"no working Oxylabs creds on the box until remediation is verified" is now **satisfiable**, so
wave **24-05** may proceed.

> ⚠ **Interim containment is host-level and NOT reboot-persistent.** The `DOCKER-USER` drops
> vanish on reboot; until 24-05 binds the services to localhost, **do not reboot** the droplet
> (uptime ~230 days, so low risk). ufw changes persist.

## Durable hardening — status after wave 24-05 (2026-06-30). Evidence: `.planning/phases/24-cleanup/24-05-HARDENING.md`

1. **Close the vector at the source** — ✅ **DONE.** `:3000`/`:8000` rebound to `127.0.0.1` in
   compose (commit `ed7192c`, branch `feat/p24-durable-hardening`); off-box both now closed by
   binding (not just firewall). `DEBUG=False` applied. **Deferred (firewalled/localhost-interim
   + TODO):** runserver→gunicorn swap and the **Metabase v0.47.1 upgrade** — both are now
   loopback-only so not internet-reachable; the Metabase major upgrade migrates its store on the
   shared managed Postgres, too risky right before the Phase-25 resize. Reach Metabase via
   `ssh -L 3000:localhost:3000`.
2. **Rotate the exposed `.env` secrets** — ✅ **partly DONE:**
   - `` `DJANGO_SECRET_KEY` `` — **rotated** (on-box, value never logged).
   - `` `OXYLABS_*` `` — refreshed to working Web Scraper API creds (the droplet's own were
     401/dead). ⚠ **Operator chose to reuse the cohort-tracker creds now** (copied
     machine-to-machine, never logged); **TODO: replace with a dedicated, rotatable Oxylabs
     sub-user** to contain blast radius.
   - `` `DATABASE_URL` `` / `` `MB_DB_*` `` — **coordinate-or-defer, NOT rotated** (shared managed
     `defaultdb` with the cohort-tracker; blind rotate would break its jobs). Open follow-up.
3. **Rebuild/redeploy reversibly** — ✅ **DONE** (recreate-only; no rebuild needed since the image
   already had the P23 fetch code). Prior tag `hemnet:pre-24-05` kept. **Re-verified GREEN:**
   50/50 Hemnet pages OK, 0 HTTP-403 through the new creds. 6 hemnet containers Up; Playwright
   still gated off.

### Open follow-ups (post-Phase-24)
- Dedicated rotatable Oxylabs sub-user (replace the reused cohort-tracker creds).
- Coordinated rotation (or separate scraper DB user) for the shared `defaultdb` creds.
- Metabase v0.47.1 → current pinned image; runserver → gunicorn. (Both localhost-only meanwhile.)
- Make the 24-02 host-firewall drops reboot-persistent OR rely on the compose loopback bind (now in place).

## Deferred (not part of this remediation)

- **~49 GB `simple_history` DB bloat** (`booli_historicallisting` + `hemnet_historicallistingv2`) —
  deferred (D-03); a Phase 25 / separate-coordination item on the shared `defaultdb`.
- **Phase 25 right-size** — unblocked by the ~17 GB reclaim (disk 79%→45%).
