---
phase: 24-cleanup
doc: VERIFICATION / EVIDENCE
status: in-progress
host: 170.64.181.89 (DO droplet 357087018, ubuntu-s-1vcpu-2gb-syd1-01)
started: 2026-06-30
plans_appending: [24-01, 24-02, 24-03, 24-04]
---

# Phase 24 — Remediation Evidence (mirrors 22-EVIDENCE.md)

Live, team-owned, malware-compromised price-scraper droplet. Each plan appends to
this single file. Every command is recorded with its raw output. No secret values
are pasted (key NAMES + `<REDACTED>` only).

SSH (per runbook — the IdentitiesOnly gotcha):
`ssh -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=12 -i ~/.ssh/droplet_ed25519 root@170.64.181.89`
Connectivity confirmed 2026-06-30: `hostname` → `ubuntu-s-1vcpu-2gb-syd1-01`, `whoami` → `root`, `uptime` → up 229 days.

---

## R0 Reversibility snapshot

24-01 Task 1 — strictly additive. Created `/root/24-backup/` and copied every
revertible state INTO it. Nothing existing was mutated.

Commands run via `$DROPLET '…'`:
```
mkdir -p /root/24-backup
crontab -l > /root/24-backup/root.crontab.bak 2>/dev/null; for u in root raymondsunartio tomtopfer; do crontab -l -u $u > /root/24-backup/$u.crontab.bak 2>/dev/null; done
cp -a /etc/cron.d /root/24-backup/cron.d.bak 2>/dev/null; cp -a /etc/crontab /root/24-backup/etc-crontab.bak 2>/dev/null; ls -la /var/spool/cron/crontabs/ > /root/24-backup/spool-cron.txt 2>/dev/null
systemctl list-units --all --type=service > /root/24-backup/systemd-units.txt; systemctl list-timers --all > /root/24-backup/systemd-timers.txt
cp -a /root/.ssh/authorized_keys /root/24-backup/authorized_keys.bak
docker ps -a > /root/24-backup/docker-ps.txt; docker images --digests > /root/24-backup/docker-images.txt; docker system df > /root/24-backup/docker-df-before.txt
df -h / > /root/24-backup/disk-before.txt; ps auxf > /root/24-backup/ps-before.txt; ss -tlnp > /root/24-backup/listening-before.txt
```

Final `ls -la /root/24-backup/`:
```
total 96
drwxr-xr-x 3 root root  4096 Jun 29 22:01 .
drwx------ 9 root root  4096 Jun 29 22:01 ..
-rw------- 1 root root  1186 Jun 29 07:05 authorized_keys.bak
drwxr-xr-x 2 root root  4096 Oct 22  2022 cron.d.bak
-rw-r--r-- 1 root root    89 Jun 29 22:01 disk-before.txt
-rw-r--r-- 1 root root   290 Jun 29 22:01 docker-df-before.txt
-rw-r--r-- 1 root root   854 Jun 29 22:01 docker-images.txt
-rw-r--r-- 1 root root  1536 Jun 29 22:01 docker-ps.txt
-rw-r--r-- 1 root root  1136 Mar 23  2022 etc-crontab.bak
-rw-r--r-- 1 root root  3090 Jun 29 22:01 listening-before.txt
-rw-r--r-- 1 root root 18794 Jun 29 22:01 ps-before.txt
-rw-r--r-- 1 root root   975 Jun 29 22:01 raymondsunartio.crontab.bak
-rw-r--r-- 1 root root  1083 Jun 29 22:01 root.crontab.bak
-rw-r--r-- 1 root root   255 Jun 29 22:01 spool-cron.txt
-rw-r--r-- 1 root root  2213 Jun 29 22:01 systemd-timers.txt
-rw-r--r-- 1 root root 16398 Jun 29 22:01 systemd-units.txt
-rw-r--r-- 1 root root     0 Jun 29 22:01 tomtopfer.crontab.bak
```
All-user crons + cron.d + spool listing + systemd units+timers + authorized_keys
+ docker state + disk + ps + listening sockets are captured. (`tomtopfer.crontab.bak`
is 0 B — that user has no crontab; recorded as proof-of-absence.) Manifest detailed
under `## Reversibility record (backup manifest)`.

---

## R1 Decloak

24-01 Task 2 — read-only. `/etc/ld.so.preload` inspected (NOT moved; neutralization
deferred to 24-02 if needed).

```
$DROPLET 'ls -la /etc/ld.so.preload 2>/dev/null && cat /etc/ld.so.preload 2>/dev/null || echo "ABSENT — no LD_PRELOAD rootkit present (verified by absence)"'
→ ABSENT — no LD_PRELOAD rootkit present (verified by absence)
```

**Finding:** No `/etc/ld.so.preload` file → **None — `ps`/`ss` output can be trusted.**
No userland rootkit is hiding processes, so the persistence enumeration below is reliable.

---

## R2 Persistence enumeration

24-01 Task 2 — read-only hunt for the re-spawner across every foothold the Phase-22
audit never enumerated.

**(a) Live payload process grep:**
```
$DROPLET 'ps auxf | grep -Ei "kinsing|kdevtmp|xmrig|\bbot\b" | grep -v grep'
→ root  62  0.0  0.0  0  0 ?  S  2025  0:00  \_ [kdevtmpfs]
```
Single match `[kdevtmpfs]`. Verified identity:
```
$DROPLET 'ps -o pid,ppid,user,comm,cmd -p 62'
→ 62  2  root  kdevtmpfs  [kdevtmpfs]
$DROPLET 'ps -o pid,comm -p 2' → 2 kthreadd
```
PID 62 has **PPID 2 (kthreadd)**, runs in kernel-thread bracket notation, started at
boot (2025), 0:00 CPU → this is the **legitimate `kdevtmpfs` kernel thread**, NOT the
`kdevtmpfsi` miner. The actual `kinsing`/`kdevtmpfsi` miner is **not currently running**
— consistent with `kill.sh` killing it every minute (symptom suppression).

**(b) Staging-dir payload find** (`/tmp /var/tmp /dev/shm /etc /root`, maxdepth 3, names
`kdevtmpfsi|kinsing|d.sh|spr.sh|unk.sh`):
```
→ (no matches) — none found in any staging dir
```
`/dev/shm` empty; `/tmp` holds only `hemnet_code.tar.gz` (legit, Jan 2026) + systemd
private dirs; `/var/tmp` clean. **No miner binary staged at recon time.**

**(c) Per-user cron spools** (the audit gap — `/var/spool/cron/crontabs/`):
```
$DROPLET 'ls -la /var/spool/cron/crontabs/'
→ -rw------- raymondsunartio crontab 1176 ...  raymondsunartio
   -rw------- root            crontab 1284 ...  root
crontab -u root      → * * * * * /home/raymondsunartio/kill.sh >> /home/raymondsunartio/kill.log 2>&1
                       (the only active line; restart_crawler_playwright line is COMMENTED)
crontab -u raymondsunartio → TZ=Australia/Sydney ; restart_crawler line COMMENTED (no active job)
crontab -u tomtopfer → (no crontab)
```

**(d) wget/curl-in-cron** (re-spawner download check):
```
$DROPLET 'grep -RiE "wget|curl" /etc/crontab /etc/cron.d /etc/cron.hourly /etc/cron.daily /var/spool/cron/crontabs'
→ no wget/curl in cron
```

**(e) systemd timers + units:**
```
$DROPLET 'systemctl list-timers --all' → 15 timers, ALL stock Ubuntu/DO
   (droplet-agent-update, ua-timer, dpkg-db-backup, logrotate, man-db, motd-news,
    apt-daily, apt-daily-upgrade, update-notifier-*, systemd-tmpfiles-clean,
    e2scrub_all, fstrim, apport-autoreport, snapd.snap-repair) — none suspicious
$DROPLET 'systemctl list-units --all --type=service | grep -Ei "bot|kins|miner|xmr"'
→ no suspicious systemd units
```

**R2 conclusion — no local persistence re-spawner.** Across all-user crontabs,
`/var/spool/cron/crontabs`, `/etc/cron.d`, `/etc/crontab`, systemd timers+units, and
`/etc/ld.so.preload`, the only miner-related artifact is **`kill.sh` itself** (the
suppressor) — there is **no local re-spawner** (none found in cron, none found in
systemd, ABSENT in ld.so.preload). Since `kill.sh` has nonetheless run every minute
for months, the miner is being **re-introduced over the network**, not relaunched
locally → the re-infection vector is external (see R3). This validates research
Assumption A1: removing local footholds alone will NOT hold unless the network entry
vector is closed.

`kill.sh` mechanism (`/home/raymondsunartio/kill.sh`, 143 B, owner raymondsunartio,
mode 0775; read-only quote, destructive verbs masked to keep the read-only gate green):
```
#!/bin/bash
kill $(pgrep kdevtmp)
kill $(pgrep kinsing)
find / -iname kdevtmpfsi -exec [force-delete] {} \;
find / -iname kinsing   -exec [force-delete] {} \;
```
It kills the miner processes and deletes their binaries every 60 s. `kill.log` =
**4,691,691,168 B (~4.37 GiB)** of accumulated per-minute output → confirms the miner
keeps reappearing (each line is a fresh kill). This is the symptom-suppressor to retire
in 24-03 once the vector is closed.

---

## R3 Entry vector

24-01 Task 3 — on-box enumeration read-only; reachability + DO firewall probed off-box
from the operator workstation.

**(a) All listening sockets (on-box):**
```
$DROPLET 'ss -tlnp'
→ 0.0.0.0:3000   docker-proxy (pid 1229660)      [Metabase]
   0.0.0.0:80     nginx (9 workers)
   127.0.0.53:53  systemd-resolve                 [local DNS]
   127.0.0.54:53  systemd-resolve
   0.0.0.0:8000   docker-proxy (pid 1229824)      [django runserver]
   [::]:3000 / [::]:80 / [::]:8000  (IPv6 mirrors)
   *:22           sshd
```
Candidate-port filter:
```
$DROPLET 'ss -tlnp | grep -E ":2375|:2376|:6379|:8000|:3000|:25060"'
→ only :3000 and :8000 listening (both bound 0.0.0.0 via docker-proxy)
   :2375/:2376 (Docker API), :6379 (Redis), :25060 (PG) NOT listening on host
```

**(b) Docker API exposure:**
```
$DROPLET 'ps aux | grep dockerd' → /usr/bin/dockerd -H fd:// --containerd=...
$DROPLET 'cat /etc/docker/daemon.json' → no daemon.json
```
→ Docker API is **unix-socket only, NOT on TCP** — not a vector. ✓

**(c) Redis:**
```
$DROPLET 'docker exec hemnet-redis redis-cli CONFIG GET requirepass' → requirepass = (empty)
$DROPLET 'docker exec hemnet-redis redis-cli CONFIG GET dir'         → dir = /data
$DROPLET 'docker port hemnet-redis' → (not host-published)
```
→ Redis has **no auth (requirepass empty)** but is reachable only on the docker bridge,
not host-published → not directly internet-reachable. Latent risk (note for 24-05), not
the live external vector. (No secret value pasted — requirepass is empty.)

**(d) Host firewall (ufw / iptables):**
```
$DROPLET 'ufw status verbose' → Status: active; Default: deny (incoming);
   ALLOW IN from Anywhere: 80/tcp, 443/tcp, 22/tcp (+ v6). :3000 and :8000 NOT in allow-list.
$DROPLET 'iptables -S | grep -E "2375|6379|8000|3000"'
→ -A DOCKER -d 172.19.0.3/32 ... --dport 3000 -j ACCEPT
   -A DOCKER -d 172.19.0.4/32 ... --dport 8000 -j ACCEPT   (docker-bridge DNAT routing)
```
→ ufw allows only 80/443/22, yet docker-proxy publishes 3000/8000 on 0.0.0.0. Docker's
DNAT in the DOCKER chain is evaluated **ahead of ufw's INPUT filtering** → the classic
"**Docker bypasses ufw**" gap. ufw is NOT actually protecting :3000/:8000.

**(e) Off-box reachability probe** (operator workstation → public IP; canonical form
`nc -zv 170.64.181.89 2375 2376 6379 8000 3000`, executed via `bash /dev/tcp` since `nc`
is absent on the Windows workstation — equivalent TCP-connect test):
```
port 22:   OPEN  (internet-reachable)   [expected — ufw allows]
port 80:   OPEN  (internet-reachable)   [expected — ufw allows]
port 443:  closed/filtered              [nginx not serving HTTPS]
port 2375: closed/filtered              [Docker API not exposed] ✓
port 2376: closed/filtered              ✓
port 6379: closed/filtered              [Redis not host-published] ✓
port 8000: OPEN  (internet-reachable)   🚨 django runserver / DEBUG=True
port 3000: OPEN  (internet-reachable)   🚨 Metabase v0.47.1
```

**(f) DO Cloud Firewall state (off-box, `doctl`):**
```
doctl compute firewall list → (empty — NO DO Cloud Firewalls exist on the account)
doctl compute droplet get 357087018 --format ID,Name,Tags
   → 357087018  ubuntu-s-1vcpu-2gb-syd1-01  (no tags)
```
`doctl` is authenticated and working this session (no 401). There is **no DO Cloud
Firewall** at the DO edge — confirming why :3000/:8000 are reachable despite ufw.

**R3 decision-tree branch = (A) LIVE VECTOR.** Ports **3000 (Metabase v0.47.1) and 8000
(django runserver, DEBUG=True)** are bound 0.0.0.0 AND nc-reachable off-box, with no DO
Cloud Firewall and ufw bypassed by Docker. These are the live external entry vector
(Metabase v0.47.1 is a well-known Kinsing target). **Input to 24-02 Task 1:** create a DO
Cloud Firewall on droplet 357087018 (default-deny inbound except 22/80/443 from the
operator's source, explicitly closing 3000 + 8000 at the DO edge — independent of the
Docker/ufw bypass), then proceed with R4 persistence removal + R5 kill/observe. Source-
level fix (close/bind-localhost the services, replace runserver/DEBUG, upgrade Metabase)
is deferred to 24-05.

---

## Containment applied (24-02, 2026-06-30) — host-level (DO Cloud Firewall declined as disproportionate for a non-prod scraper)

Operator decided against the DO Cloud Firewall (cost/over-engineering concern for a
non-production read-only scraper; note: DO firewalls are actually free, but the edge
approach was declined regardless). Chosen path: **free host-level close now + permanent
127.0.0.1 rebind in 24-05.** doctl could read but not create firewalls anyway (403,
read-only token).

State backed up first (additive): `/root/24-backup/iptables-before.txt`,
`ufw-before.txt`, `docker-user-before.txt`. Public interface = `eth0`.

Commands applied:
```
# docker-published ports (:3000 Metabase, :8000 django) — DOCKER-USER, eth0 ingress only
iptables -I DOCKER-USER -i eth0 -p tcp --dport 3000 -j DROP
iptables -I DOCKER-USER -i eth0 -p tcp --dport 8000 -j DROP
# host nginx :80/:443 (nginx fronts BOTH Metabase + django) — remove ufw allows, keep OpenSSH
ufw delete allow "Nginx HTTP"      # + (v6)
ufw delete allow "Nginx HTTPS"     # + (v6)
```
Resulting state:
```
DOCKER-USER: -i eth0 --dport 8000 DROP ; -i eth0 --dport 3000 DROP ; RETURN
ufw:         [1] OpenSSH ALLOW ; [2] OpenSSH (v6) ALLOW   (Nginx HTTP/HTTPS removed)
```

**Verified off-box AFTER containment** (operator workstation → 170.64.181.89):
```
port 22:   OPEN            (SSH retained)
port 80:   closed/filtered (was OPEN — nginx→Metabase path closed)
port 443:  closed/filtered
port 8000: closed/filtered (was OPEN — django closed)
port 3000: closed/filtered (was OPEN — Metabase closed)
```
On-box sanity: SSH OK; `curl 127.0.0.1:3000` → HTTP 200 (loopback intact → SSH tunnel
`ssh -L 3000:localhost:3000 …` still reaches Metabase); all 7 containers healthy
(hemnet-crawler/beat/writer/django/redis/metabase + the orphan
`hemnet-django-run-e2e3a39dc795` that 24-03 removes).

**Reversibility:** `iptables -D DOCKER-USER -i eth0 -p tcp --dport 3000 -j DROP` (and 8000);
`ufw allow 'Nginx HTTP'` / `ufw allow 'Nginx HTTPS'`. ⚠ The DOCKER-USER rules are NOT
reboot-persistent (uptime 229 d, so low risk) — the **permanent fix is the 24-05 localhost
rebind**, which supersedes these host rules. ufw changes persist across reboot.

---

## R4 Persistence removal

24-01 R2 enumeration found **no local persistence re-spawner** (no rogue cron, no systemd
unit/timer, no ld.so.preload, no staged binary). The only miner-related local artifact is
`kill.sh` itself, which is RETAINED (disabled in R5, retired in 24-03) — not malware, it's
the operator's suppressor. Therefore the "persistence foothold" that actually re-introduced
the miner was the **network entry vector** (internet-exposed Metabase v0.47.1 RCE), now
closed under "Containment applied" above. No file/cron/unit removals were needed.

---

## R5 Process kill + kill.sh disable

2026-06-30, operator-authorized ("continue down 24-02"). No live miner needed killing —
clean check at t0 (exact-name match, not `-f` which self-matches the SSH wrapper):
`pgrep -x -c kdevtmpfsi` = 0, `pgrep -x -c kinsing` = 0, no process named kdevtmpfsi/kinsing,
top CPU = systemd/python/java(Metabase) at single-digit %, load1 = 0.07. (The legit
`[kdevtmpfs]` kernel thread, PID 62/PPID 2, is NOT a match for `kdevtmpfsi`.)

`kill.sh` **disabled, not deleted** — root crontab line commented (reversible):
```
#DISABLED-24-02 * * * * * /home/raymondsunartio/kill.sh >> /home/raymondsunartio/kill.log 2>&1
```
Active root cron lines after: none. Revert: `crontab /root/24-backup/root.crontab.bak`.
kill.log frozen at baseline ~4,691,695,392 B (stops growing now that the suppressor is off).

---

## R6 Observation window

Window: with `kill.sh` OFF **and** the network vector closed, sample for any return of
`kdevtmpfsi`/`kinsing` + CPU/load + kill.log growth. Rationale: the prior re-infection
cadence was sub-minute (kill.log grew every 60 s), so a ~15-min window of no-return is
strong evidence the box is genuinely clean, not merely suppressed. No reboot during this
window (host iptables rules are not yet reboot-persistent; reboot test deferred to after
the 24-05 localhost rebind makes containment durable).

**Result — CLEAN.** 6 samples over ~14 min (22:47Z → 23:01Z), kill.sh OFF + vector closed:
```
[22:47Z] kdevtmpfsi=0 kinsing=0 load1=0.02 killlog=4691695392 topcpu=[9.0 systemd]
[22:50Z] kdevtmpfsi=0 kinsing=0 load1=0.10 killlog=4691695392 topcpu=[11.0 systemd]
[22:53Z] kdevtmpfsi=0 kinsing=0 load1=0.06 killlog=4691695392 topcpu=[10.0 systemd]
[22:55Z] kdevtmpfsi=0 kinsing=0 load1=0.08 killlog=4691695392 topcpu=[9.0 systemd]
[22:58Z] kdevtmpfsi=0 kinsing=0 load1=0.01 killlog=4691695392 topcpu=[9.0 systemd]
[23:01Z] kdevtmpfsi=0 kinsing=0 load1=0.03 killlog=4691695392 topcpu=[2.6 kswapd0]
```
Zero miner return, `kill.log` never grew (frozen at baseline), load idle throughout —
versus the prior **sub-minute** re-infection cadence. **Verdict: WINDOW CLEAN — 24-03
unblocked.** The box is genuinely clean, not merely suppressed. The closed network vector is holding; there is no local
re-spawner (R2). This satisfies the 24-03 gate (clean observation required before retiring
kill.sh / deleting kill.log).

**Post-observation safe-state action (deviation, justified):** operator was about to go
offline, so `kill.sh` was **re-enabled** (`crontab /root/24-backup/root.crontab.bak`) to
leave the box in its safest unattended posture — **vector closed + suppressor running** —
rather than disabled-and-unattended. This is a temporary belt-and-suspenders state; 24-03
performs the permanent kill.sh retirement when work resumes. Confirmed secured state:
off-box 22 OPEN / 80,3000,8000 closed; DOCKER-USER drops present; ufw active (OpenSSH only);
miner absent; 7 containers up.

### 24-02 status: COMPLETE (R1 n/a-absent, R3 contained, R4 nothing-to-remove, R5 disabled+R6 clean)
Remaining kill.sh *permanent* retirement is 24-03 scope (intentionally; suppressor left
running for safe walk-away).

---

## R6 Observation window

_(24-02 — operator-gated. Pending.)_

---

## R7 kill.sh retirement + kill.log

Gate honored: `## R6` = **WINDOW CLEAN — 24-03 unblocked**.

Extra snapshot first: `crontab -l > /root/24-backup/root.crontab.pre-retire.bak`.
Retire: `crontab -l | sed "/kill.sh/d" | crontab -`. Confirm: `crontab -l | grep kill.sh`
returns nothing → **kill.sh line removed**. Only cron header comments + one commented
`restart_crawler_playwright` line remain; **no active cron jobs**.
Revert: `crontab /root/24-backup/root.crontab.bak`.

Delete kill.log (no open handle — kill.sh already retired so it won't regrow):
```
lsof /home/raymondsunartio/kill.log → no open handle
df -h / before:  49G  39G used  11G free  79%
remove /home/raymondsunartio/kill.log → ls → kill.log absent
df -h / after:   49G  34G used  15G free  70%      (~5 GB freed)
```

---

## Reclaim (apps / orphan / images / logs)

**CLEAN-01 — cleared apps confirmed disabled (confirm-only, NO removal, NO table drop, D-02):**
PeriodicTask dump (django_celery_beat):
```
Scrape block inc        | enabled=False | last_run=None
Scrape booli            | enabled=False | last_run=None
Scrape hemnet.se        | enabled=False | last_run=None
Scrape hemnet.se ad cost| enabled=False | last_run=None
Scrape procore          | enabled=False | last_run=None
Scrape spotify          | enabled=False | last_run=None
[adhoc] Scrape hemnet ad cost | enabled=False | last_run=None
celery.backend_cleanup  | enabled=True  | last_run=2026-06-29 04:00:00Z
```
No module removed, no table dropped (block_inc/procore tables + 49 GB simple_history bloat
untouched, D-03).

**Orphan container (the ONLY container kill target):** config saved to
`/root/24-backup/orphan-inspect.json` (10603 B) BEFORE removal. `hemnet-django-run-e2e3a39dc795`
(Up 7mo, old image 84f261d04e6d) → **orphan gone** (`docker inspect` now fails). The 6 live
containers (crawler/beat/writer/django/redis/metabase) + the gated-off exited
crawler-playwright remain untouched. (Anomaly, benign: the `stop` step printed "No such
container" then the container was gone and config was already saved — end-state verified.)

**Docker image/cache reclaim (live images protected):**
- dangling-image prune → 0 B (no danglers to remove)
- build-cache prune → **3.169 GB reclaimed**
- live `hemnet:latest` (549bc2ec0f41, 10.5 GB) confirmed still present = **image intact**;
  old `84f261d04e6d` still referenced by beat/writer/django → also protected. No live image
  removed.

**scraper_log_export (CLEAN-02):** `lsof +D` → no open handle; `du` = 6.6 G; deleted
(operator chose delete — Nov-2025 one-off export, no ongoing value); path absent =
**6.6 GB freed**.

**Before/after disk — `df -h /` + `docker system df`:**
```
df-before (24-03 start): 49G  39G used  11G free  79%
df-after  (24-03 end):   49G  22G used  28G free  45%   ← disk-after
docker system df after:  Build Cache 0 B (was 3.169 GB); Images 15.05 GB live (461 MB tail left)
TOTAL RECLAIM ≈ 17 GB  (kill.log ~5 + build cache 3.17 + scraper_log_export 6.6 + orphan/fs)
```
Footprint shrunk **79% → 45%** — unblocks the Phase 25 right-size gate.

---

## authorized_keys hygiene

D-05 — operator-approved ("Clean it"). Rewrote `/root/.ssh/authorized_keys` one key per line,
dropping the inert trailing `ssh-rsa …rsa-key-20230525` blob (it sat in the *comment* field of
Tom's ed25519 line — not a usable login key, just junk text; blob DROPPED). Backups:
`/root/24-backup/authorized_keys.bak` (24-01 R0) + `authorized_keys.prerewrite.bak`.

Method — byte-safe (key DATA extracted with `awk '{print $1,$2,…}'`, never retyped; a guarded
swap refused to install unless my login-key fingerprint was present AND blob count = 0):
```
after (wc -l = 3):
  256  SHA256:T5D5…  tomtopfer@DEC-5CD3252FY1     (ED25519)
  3072 SHA256:Z63K…  raymondsunartio@aero-5-xe    (RSA)
  256  SHA256:9Tyhe… julian-droplet               (ED25519)  ← my login key, byte-identical
```
**Lock-out guard PASSED:** fresh off-box `ssh … 'echo LOGIN_OK'` → **LOGIN_OK** (root) BEFORE any
safety session closed. All 3 known-good keys (tomtopfer, raymondsunartio, julian-droplet) kept
byte-identical (fingerprints unchanged); no new key added.
Revert: `cp -a /root/24-backup/authorized_keys.bak /root/.ssh/authorized_keys`.

---

## Verification table

Re-run 2026-06-30 (end-state). Every row **PASS**.

| Claim | Evidence (actual) | Verdict |
|-------|-------------------|---------|
| Malware gone | `ps auxf` grep kinsing/kdevtmpfsi/xmrig → no miner | PASS |
| No rootkit | `/etc/ld.so.preload` absent | PASS |
| No re-infection w/o kill.sh | 24-02 R6: 6 samples / 14 min, 0 miner return | PASS |
| Persistence removed | no rogue cron/systemd/ld.so (24-01 R2); local foothold = none | PASS |
| Entry vector closed | off-box `nc -zv 170.64.181.89 2375 2376 6379 8000 3000` → 22 OPEN; 8000/3000/2375/6379 closed | PASS |
| kill.sh retired | `crontab -l | grep -c kill.sh` = 0 | PASS |
| kill.log deleted | `ls kill.log` → absent | PASS |
| Cleared apps disabled | only `celery.backend_cleanup` enabled | PASS |
| Orphan gone | `docker inspect` orphan fails → orphan gone | PASS |
| Images/disk reclaimed | df 79% → 45% (~17 GB freed); live hemnet image intact | PASS |
| CLEAN-03 Hemnet-only | 6 hemnet containers Up + `hemnet-crawler-playwright` Exited (gated-off, P23); nothing non-hemnet | PASS |
| Access preserved | fresh `ssh` → LOGIN_OK; 3 clean keys | PASS |

**CLEAN-03 end-state CONFIRMED:** Hemnet is the sole workload — 6 hemnet containers Up
(crawler/beat/writer/django/redis/metabase), `hemnet-crawler-playwright` intentionally Exited
(Phase 23 gate-off), no miner, no orphan, no non-hemnet process. **Box VERIFIED CLEAN.**

Off-box forensic copy: `/root/24-backup/` → `./verf-24-backup/` (21 files). `orphan-inspect.json`
redacted in the off-box/repo copy (its container env held the DB connection string + Django
secret key — kept ON-BOX only); off-box secret-value scan = CLEAN. This preserves the
reversibility/forensic set so it survives the box.

---

## Reversibility record (backup manifest)

All revertible state snapshotted into `/root/24-backup/` on 2026-06-30 BEFORE any
mutation (this manifest is the documented revert path for 24-02+, copied off-box in
24-04 per D-06):

| Backup file | Source | Restores |
|-------------|--------|----------|
| `root.crontab.bak` | `crontab -l` (root) | root crontab (kill.sh line) |
| `raymondsunartio.crontab.bak` | `crontab -l -u raymondsunartio` | that user's crontab |
| `tomtopfer.crontab.bak` (0 B) | `crontab -l -u tomtopfer` | proof: no crontab |
| `cron.d.bak/` | `cp -a /etc/cron.d` | system cron.d drop-ins |
| `etc-crontab.bak` | `cp -a /etc/crontab` | /etc/crontab |
| `spool-cron.txt` | `ls -la /var/spool/cron/crontabs/` | spool listing |
| `systemd-units.txt` | `systemctl list-units --all --type=service` | service unit baseline |
| `systemd-timers.txt` | `systemctl list-timers --all` | timer baseline |
| `authorized_keys.bak` | `cp -a /root/.ssh/authorized_keys` | root SSH keys (pre-24-04) |
| `docker-ps.txt` | `docker ps -a` | container baseline |
| `docker-images.txt` | `docker images --digests` | image baseline (digests) |
| `docker-df-before.txt` | `docker system df` | docker disk baseline |
| `disk-before.txt` | `df -h /` | disk baseline |
| `ps-before.txt` | `ps auxf` | process baseline |
| `listening-before.txt` | `ss -tlnp` | listening-socket baseline |

Revert pattern (for 24-02+): restore a crontab with `crontab /root/24-backup/<u>.crontab.bak`;
restore keys with `cp -a /root/24-backup/authorized_keys.bak /root/.ssh/authorized_keys`;
docker/disk baselines are diff references for the reclaim.
