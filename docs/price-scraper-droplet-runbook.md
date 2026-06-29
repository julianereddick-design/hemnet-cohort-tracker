# Price-Scraper Droplet — Access Runbook

**Droplet:** `ubuntu-s-1vcpu-2gb-syd1-01` (legacy name; actually an `s-8vcpu-16gb` box, ~$100/mo — to be right-sized in Phase 25)
**IP:** `170.64.181.89`
**Region:** `syd1`
**Login user:** `root` — intentional; the team's Docker containers and scripts run as root. No separate login user (decision: GSD Phase 21).
**Repo it runs:** `github.com/tt7676/hem-bol-scrapers` (team-maintained). App lives at `/var/www/apps/hemnet` on the droplet.
**Last verified:** 2026-06-29 (GSD milestone v4.0, Phase 21).

> This droplet is **separate** from the cohort-tracker droplet (`cohort-tracker`, `170.64.197.241`). See memory `project_droplet_inventory` for the full account map.

---

## How to connect

```bash
ssh -o IdentitiesOnly=yes -o IdentityAgent=none -i ~/.ssh/droplet_ed25519 root@170.64.181.89
```

**The `IdentitiesOnly` gotcha (important):** without `-o IdentitiesOnly=yes -o IdentityAgent=none`, your local SSH agent offers its other keys first, the server hits `MaxAuthTries`, and you get a **false `Permission denied (publickey)`** even though your key is authorized. Always pass those two flags (and `-i ~/.ssh/droplet_ed25519`). The first connection of a session may succeed without them by luck; later ones fail — so just always use them.

For non-interactive/batch use add `-o ControlMaster=no -o ControlPath=none -o ConnectTimeout=12` to force a fresh connection.

---

## Keys & durability

- **Operator key:** `~/.ssh/droplet_ed25519` (ed25519, public comment `julian-droplet`).
  Fingerprint: `SHA256:9TyheDvf4vtVvhuFJfyzj4WBheNldbBuIgWaMI438q8`.
- **Account-level key:** registered on the DigitalOcean account as **"Julian Droplet"**, id **`55446611`** (the public half of `droplet_ed25519`). Confirm with `doctl compute ssh-key list`.
- **Durability:** `/root/.ssh/authorized_keys` lives on `/dev/vda1` (ext4, the persistent root disk), and `sshd` has `PubkeyAuthentication yes`. So access **survives reboots by construction** — a reboot of the live scraper cannot lock us out. *(An actual reboot test is operator-gated and was deliberately NOT performed, since the scraper is in production.)*

---

## Access inventory (who can get in)

Three functional keys in `/root/.ssh/authorized_keys` as of 2026-06-29:

| # | Type | Comment | Owner | Account key |
|---|------|---------|-------|-------------|
| 1 | ed25519 | `azuread\tomtopfer@DEC-5CD3252FY1` | Tom Topfer | "Tom Laptop" (id 57022683), by owner |
| 2 | rsa | `raymondsunartio@aero-5-xe` | Raymond Sunartio (team dev) | none at account level — droplet-only |
| 3 | ed25519 | `julian-droplet` | Us / Julian | "Julian Droplet" (id 55446611) |

> **Hygiene finding (flag for Phase 22 audit / Phase 24 cleanup):** line 1 (Tom's ed25519) has a **dangling, non-functional RSA key blob** appended to it with no newline (its trailing text includes `…ssh-rsa AAAA… rsa-key-20230525`). Because authorized_keys is one-key-per-line, that RSA portion is absorbed into Tom's comment and is **inert** (it grants no access). Worth cleaning up (re-write the file with one key per line) during Phase 24.

Other DO account keys not on this droplet: `cohort-key` (54626251), `Hemnet` (38401931), `MonitorDoTom` (56225717).

---

## Add / revoke access

**Add a key** — must be done from the **DigitalOcean web Console** (Droplet → Console), because DigitalOcean **cannot inject an SSH key into an existing droplet via API**:

```bash
echo 'ssh-ed25519 AAAA...your-key... your-comment' >> /root/.ssh/authorized_keys
```
(Ensure the file ends with a newline first — `tail -c1 /root/.ssh/authorized_keys | od -c` — to avoid joining keys, the bug noted above.)

**Revoke a key** — by its comment:

```bash
sed -i '/julian-droplet/d' /root/.ssh/authorized_keys
```
Substitute the target key's comment (e.g. `tomtopfer`, `raymondsunartio`) for `julian-droplet`.

---

## Caveat — account key vs. existing droplet

**DigitalOcean cannot inject an SSH key into an _existing_ droplet via API.** For THIS droplet the durable access mechanism is the on-disk `/root/.ssh/authorized_keys` entry (above). The account-level key (`55446611`) only matters for **future** droplets created or rebuilt with it — those auto-trust the key at creation time. So: to grant someone access to this box now, paste their key via the web Console; registering an account key alone does nothing for an already-running droplet.

---

## doctl

`doctl` is authenticated on the operator workstation (read token, re-authed 2026-06-29). Useful checks:

```bash
doctl compute droplet list --format ID,Name,PublicIPv4,Region,Memory,VCPUs   # inventory + size
doctl compute ssh-key list --format ID,Name,FingerPrint                      # account keys (confirm 55446611)
```

---

*GSD milestone v4.0 · Phase 21 (Consistent access) · 2026-06-29.*
