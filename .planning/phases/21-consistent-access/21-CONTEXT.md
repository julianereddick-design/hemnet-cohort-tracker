# Phase 21: Consistent access - Context

**Gathered:** 2026-06-29
**Status:** Ready for planning
**Source:** Live investigation 2026-06-29 (no separate discuss-phase; operator delegated approach decisions)

<domain>
## Phase Boundary

Make operator/Claude access to the price-scraper droplet `170.64.181.89` (`ubuntu-s-1vcpu-2gb-syd1-01`, syd1; root user) **durable and documented**, replacing the fragile one-off DO-console key paste used on 2026-06-29.

In scope: persisting + verifying SSH key access, confirming/registering an account-level key for future rebuilds, and writing an access runbook (incl. who currently has access and the connection gotcha). NOT in scope: the audit (Phase 22), the Oxylabs fetch fix (23), cleanup (24), or resize (25).
</domain>

<decisions>
## Implementation Decisions

### Access identity
- **User = `root`** (current model; the team's containers + scripts run as root). Do not introduce a new login user this phase.
- **Key = the existing `droplet_ed25519` ed25519 keypair** (public comment `julian-droplet`; registered at the DO account level as **"Julian Droplet"**, id `55446611`). It was added to `/root/.ssh/authorized_keys` on 2026-06-29 and that file lives on persistent `ext4` (`/dev/vda1`) — so it **survives reboots by construction**. No new key is generated this phase.
- **SSH connection gotcha (MUST document):** connect with `-o IdentitiesOnly=yes -o IdentityAgent=none -i ~/.ssh/droplet_ed25519`. Without it, the local agent offers other keys first and trips `MaxAuthTries` → a false `Permission denied (publickey)`.

### Account-level key (ACCESS-02)
- "Julian Droplet" (`55446611`) already exists at the DO account level → future droplets created with it auto-trust this key. **DigitalOcean cannot inject a key into an *existing* droplet via API** — so for THIS droplet the on-disk `authorized_keys` entry is the durable mechanism; account-level registration only helps future rebuilds. Document both facts.

### Verification approach (safety)
- The scraper is **live in production**; do NOT reboot it to "prove" persistence. Verify ACCESS-01 by construction instead: (a) key present in `/root/.ssh/authorized_keys` on persistent disk, (b) `sshd` has pubkey auth enabled, (c) a fresh SSH session (new connection, no reuse) authenticates with the key. A real reboot test is operator-gated only.

### Runbook (ACCESS-03)
- Write the access runbook in THIS repo (planning lives here even though the droplet code is the team's `tt7676/hem-bol-scrapers` repo): **`docs/price-scraper-droplet-runbook.md`**.
- Must cover: host/IP/region, user, key + account-key id, exact `ssh` command with the `IdentitiesOnly` gotcha, how to add a key (DO console paste one-liner) and revoke (`sed -i '/<comment>/d'`), an inventory of who currently has access (the 3 keys in `authorized_keys` — identify each), and the "DO can't push keys to existing droplets" caveat.

### Claude's Discretion
- Exact runbook section ordering and wording.
- Whether to also record the key fingerprints in the runbook.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Droplet / account facts
- Memory `project_droplet_inventory` — full 7-droplet account map, this droplet's role, the `IdentitiesOnly` gotcha.
- `.planning/REQUIREMENTS.md` — ACCESS-01/02/03 wording.
- `.planning/ROADMAP.md` (Phase 21 section) — goal + success criteria.

### Current state (verified 2026-06-29)
- `/root/.ssh/authorized_keys` on `170.64.181.89` holds 3 keys (1 = ours `julian-droplet`; 2 = team keys, to be identified in the runbook).
- `sshd_config`: `PubkeyAuthentication` default-on; root login via key works today.
- `/` is `/dev/vda1` ext4 (persistent) — authorized_keys is durable.
</canonical_refs>

<specifics>
## Specific Ideas
- doctl is authenticated (read token) — use `doctl compute ssh-key list` to confirm "Julian Droplet" id `55446611` for ACCESS-02 evidence.
- The other account keys: "cohort-key", "Hemnet", "Tom Laptop", "MonitorDoTom" — relevant when identifying who the 2 non-ours `authorized_keys` entries belong to.
</specifics>

<deferred>
## Deferred Ideas
- Rotating to a dedicated per-droplet key or a non-root deploy user — deferred; not needed for durable access now.
- Actual reboot test — operator-gated (live scraper).
</deferred>

---

*Phase: 21-consistent-access*
*Context gathered: 2026-06-29 via live investigation*
