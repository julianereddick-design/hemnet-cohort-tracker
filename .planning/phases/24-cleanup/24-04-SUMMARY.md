---
phase: 24-cleanup
plan: 04
status: complete
wave: 4
autonomous: false
completed: 2026-06-30
requirements: [CLEAN-03, CLEAN-04]
---

# 24-04 SUMMARY — Close Phase 24: keys + green table + remediation record

## Objective met
Box VERIFIED CLEAN with Hemnet as the sole workload (CLEAN-03), SSH access preserved with
hygienic keys, reversibility/forensic set preserved off-box, and an operator-owned remediation
record written that hands durable source-hardening + secret rotation to wave 24-05.

## What was done (operator-gated)
- **D-05 authorized_keys (operator chose "Clean it"):** rewrote `/root/.ssh/authorized_keys` to
  3 clean keys (tomtopfer ed25519, raymondsunartio rsa, julian-droplet ed25519), dropping the
  inert `rsa-key-20230525` blob. Key data extracted byte-for-byte; **guarded swap** refused
  unless my login-key fingerprint present + blob count 0. **Fresh login verified LOGIN_OK** before
  trusting the change. (Cosmetic note: first pass mangled Tom's comment via awk `\t`→tab; fixed
  with a clean comment in a second guarded pass.) Revert: `authorized_keys.bak`.
- **Verification table re-run — all-PASS:** malware gone, no rootkit, no re-infection w/o kill.sh
  (24-02 R6), persistence removed, vector closed (off-box nc), kill.sh retired + kill.log gone,
  apps disabled, orphan gone, ~17 GB reclaimed (79%→45%), CLEAN-03 Hemnet-only, access preserved.
- **Forensics preserved off-box:** `/root/24-backup/` → `./verf-24-backup/` (21 files).
  `orphan-inspect.json` **redacted in the off-box copy** (its container env held the DB
  connection string + Django secret key — kept on-box only); off-box secret-value scan CLEAN.
- **Remediation record written:** `docs/price-scraper-droplet-remediation.md` (operator-owned
  incident record + 24-05 handoff incl. the shared-`defaultdb` DB-cred coordinate-or-defer caveat).
  `docs/price-scraper-droplet-audit.md` malware/orphan/dangling-key findings marked REMEDIATED.

## Key files
- `.planning/phases/24-cleanup/24-VERIFICATION.md` — `## authorized_keys hygiene` + `## Verification table`
- `docs/price-scraper-droplet-remediation.md` (new) · `docs/price-scraper-droplet-audit.md` (findings closed)
- `./verf-24-backup/` (off-box forensic set, redacted) · on droplet `/root/24-backup/` (full revert set)

## Live box state at handoff
VERIFIED CLEAN · vector closed (host-level, not reboot-persistent) · kill.sh retired · 6 hemnet
containers Up + playwright gated-off · 3 clean SSH keys · disk 45%. ⚠ No reboot until 24-05
makes containment durable (localhost rebind).

## Self-Check: PASSED
- All 3 task gates PASS; no secret value committed (off-box copy + remediation doc both scanned clean).
- Lock-out guard honored (fresh LOGIN_OK before trusting the key rewrite).
- Every change reversible; no team-repo edit; no DB table dropped.

## Hand-off to 24-05 (operator-gated — the scraper-comeback wave)
Durable source-hardening: localhost-bind :3000/:8000 + replace runserver/DEBUG + **upgrade
Metabase v0.47.1**; rotate `.env` (Django secret + a dedicated rotatable Oxylabs sub-user;
DB creds coordinate-or-defer for shared `defaultdb`); rebuild/redeploy reversibly + re-verify
scraper green. **Operator input required: fresh Oxylabs creds.** 24-05 has an escape-hatch to
split to a follow-up phase if rebuild risks destabilizing the scraper before Phase 25 resize.
