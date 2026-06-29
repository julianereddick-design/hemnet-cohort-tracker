# Phase 21 / Plan 01 — Summary

**Executed:** 2026-06-29
**Status:** COMPLETE — all acceptance criteria green, all 3 requirements (ACCESS-01/02/03) satisfied.
**Files changed (this repo):** `docs/price-scraper-droplet-runbook.md` (new, 86 lines)
**Droplet state changed:** none (Task 1 was read-only; no reboot of the live scraper).

## What was done

**Task 1 — verified durable access by construction (read-only).** Against `root@170.64.181.89`:
- Fresh keyed SSH session → `SSH_OK` (no DO-console paste needed) — **ACCESS-01**.
- `julian-droplet` key present (count 1); 3 `ssh-` keys total; `authorized_keys` on `/dev/vda1` (persistent ext4); `sshd -T` → `pubkeyauthentication yes` → survives reboot by construction — **ACCESS-01**.
- `doctl compute ssh-key list` shows id `55446611` / "Julian Droplet" — **ACCESS-02**.
- All 3 keys fingerprinted + identified (Tom Topfer / Raymond Sunartio / ours).

**Task 2 — wrote the access runbook** `docs/price-scraper-droplet-runbook.md` — **ACCESS-03**. 14/14 grep gates pass; 0 `PRIVATE KEY` matches. Covers host/region/user, operator + account key (`55446611`), exact `ssh` command with the `IdentitiesOnly`/`MaxAuthTries` gotcha, durability, add/revoke procedures, 3-key access inventory, and the "DO can't inject keys into an existing droplet" caveat.

## must_haves — all TRUE
1. Fresh keyed SSH session authenticates, no console paste (ACCESS-01) ✓
2. Our key on persistent `/dev/vda1` `authorized_keys` → survives reboot (ACCESS-01) ✓
3. `sshd` PubkeyAuthentication enabled (ACCESS-01) ✓
4. "Julian Droplet" id 55446611 at DO account level via `doctl` (ACCESS-02) ✓
5. Committed runbook documents the full access model (ACCESS-03) ✓

## Findings to carry forward (for Phase 22 audit / Phase 24 cleanup)
- **Dangling dead RSA key in `authorized_keys`:** line 1 (Tom's ed25519) has an RSA key blob (`rsa-key-20230525`) appended with no newline → inert (grants no access). Rewrite the file one-key-per-line during cleanup.
- **Droplet is actually `s-8vcpu-16gb`** (~$100/mo) despite the `1vcpu-2gb` name — confirms the Phase 25 right-size target.
- **Raymond's RSA key** has no account-level entry (droplet-only) — note for access governance.

## Verification
- Task 1: read-only SSH + doctl, evidence captured to scratchpad `21-access-evidence.txt`.
- Task 2: 14/14 acceptance grep gates pass against `docs/price-scraper-droplet-runbook.md`; `grep -c "PRIVATE KEY"` = 0; 86 lines (≥40).
- No droplet state changed; no reboot performed (operator-gated, deferred).
