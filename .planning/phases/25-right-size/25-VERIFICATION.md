---
phase: 25-right-size
status: passed
started: 2026-06-30
completed: 2026-06-30
requirements: [SIZE-01, SIZE-02]
result: "Resized s-8vcpu-16gb -> s-1vcpu-2gb (~$96/mo -> ~$12/mo). Verified GREEN: 0% 403, peak 733 MiB, no OOM, bind survived reboot. Metabase + Playwright gated reboot-persistently."
---

# Phase 25: Right-size — Verification Evidence

Droplet: `170.64.181.89`, DO ID `357087018`, region `syd1`.
Current actual size confirmed on-box (2026-06-30): `nproc`=8, `free -h` total 15Gi → **`s-8vcpu-16gb`**. (The droplet hostname `ubuntu-s-1vcpu-2gb-syd1-01` is the legacy *creation* name, NOT the current slug.) Disk `/dev/vda1` 49G, 22G used / 28G avail. Uptime 229 days (box never power-cycled by P23/P24 — those were docker-only). HEAD at `/var/www/apps/hemnet` = `ed7192c`.

---

## D-07 pre-flight — loopback bind  (25-01 Task 1 — PASS)

Goal: confirm the Phase 24-05 `127.0.0.1` compose bind (commit `ed7192c`) is the **running** state so the resize power-cycle does NOT re-expose Metabase :3000 / django :8000 (the Kinsing entry vector). The interim 24-02 host-iptables DROPs are NOT reboot-persistent, so the loopback bind is the only durable protection across the reboot.

**[1] Commit `ed7192c` present in droplet checkout:**
```
$ cd /var/www/apps/hemnet && git log --oneline -8 | grep ed7192c
ed7192c harden(p24): bind :8000/:3000 to 127.0.0.1 (close entry vector at source, CLEAN-04)
```
(ed7192c is HEAD.)

**[2] Compose host publishes bind loopback.** `docker compose config` renders ports in long form (`host_ip:` / `published:` on separate lines), so the colon-joined `127.0.0.1:8000` short form does not appear in its output — but the rendered `host_ip` IS `127.0.0.1` for both, and the SOURCE file uses the explicit short form:
```
$ grep -nE "8000|3000|127\.0\.0\.1" docker-compose.yml
16:      - 127.0.0.1:8000:8000          # django host publish → loopback
19:    command: python -Wall ./manage.py runserver 0.0.0.0:8000   # in-CONTAINER bind (not a host publish)
123:      - 127.0.0.1:3000:3000          # metabase host publish → loopback

$ docker compose config   # rendered ports (django + metabase)
  django:
    ports:
    - host_ip: 127.0.0.1
      target: 8000
      published: "8000"
  metabase (hemnet-metabase):
    ports:
    - host_ip: 127.0.0.1
      target: 3000
      published: "3000"
```
NOTE: the lone `0.0.0.0:8000` seen in `docker compose config` output is the Django `command:` (`runserver 0.0.0.0:8000`) — the in-container bind, NOT a host port publish. Not a re-exposure risk.

**[3] Live running containers bind loopback:**
```
$ docker ps --format '{{.Names}} => {{.Ports}}' | grep -E "metabase|django"
hemnet-django   => 127.0.0.1:8000->8000/tcp
hemnet-metabase => 127.0.0.1:3000->3000/tcp
```

**[4] Off-box TCP probe from operator workstation (bash `/dev/tcp`):**
```
port 22:   OPEN
port 3000: closed/filtered
port 8000: closed/filtered
```

**Verdict: D-07 PASS.** Compose file + rendered config + live container ports + off-box probe all agree — :3000/:8000 are loopback-bound and unreachable from the internet. A reboot will NOT re-expose the entry vector. Later resize plans (25-03) are cleared to proceed on this check; 25-03 re-confirms it as a second checkpoint immediately before power-off.

---

## D-02 Metabase gate-off  (25-01 Task 2 — AWAITING OPERATOR APPROVAL)

BEFORE baseline captured (read-only, 2026-06-30):
```
$ free -h
              total   used   free  shared  buff/cache  available
Mem:           15Gi  1.8Gi  6.0Gi   4.0Mi       7.8Gi       13Gi

$ docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'
hemnet-crawler   85.99 MiB
hemnet-django   118.7 MiB
hemnet-metabase  968 MiB        <-- largest consumer; gate target
hemnet-beat      76.96 MiB
hemnet-writer   209 MiB
hemnet-redis     10.1 MiB
```
Non-Metabase containers sum ≈ 501 MiB → gating Metabase should drop steady-state `used` toward ~0.8–0.9 GiB (under ~1 GiB, evidencing a 2 GB slug fits at idle).

Action taken (operator-approved 2026-06-30, reversible STOP only — no rm/down/prune/compose-edit):
```
$ docker stop hemnet-metabase
hemnet-metabase        # Exited (143) = clean SIGTERM
```

AFTER (settled ~30s):
```
$ free -h
              total   used    free  shared  buff/cache  available
Mem:           15Gi  979Mi   6.9Gi   4.0Mi       7.8Gi       14Gi

$ docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'
hemnet-crawler   86.01 MiB
hemnet-django   118.7 MiB
hemnet-beat      76.94 MiB
hemnet-writer   209 MiB
hemnet-redis     10.1 MiB
(hemnet-metabase absent — Exited)

$ docker ps -a --format '{{.Names}}\t{{.Status}}' | grep hemnet
hemnet-crawler              Up About an hour
hemnet-django              Up About an hour
hemnet-metabase            Exited (143) 32 seconds ago   <-- gated off
hemnet-crawler-playwright  Exited (0) 14 hours ago       <-- P23 gate
hemnet-beat                Up 2 months
hemnet-writer              Up 2 months
hemnet-redis               Up 2 months

$ docker ps --format '{{.Names}}' | grep -c metabase
0
```

| Metric | BEFORE | AFTER | Δ |
|--------|--------|-------|---|
| `free -h` used | 1.8 GiB | **979 MiB** | −~0.85 GiB |
| `free -h` available | 13 GiB | 14 GiB | +1 GiB |
| hemnet-metabase | Up (968 MiB) | Exited | gated |
| 5 scraper containers | Up | Up | unchanged |

**Verdict: D-02 PASS.** Metabase gated off reversibly; steady-state `used` RAM **979 MiB (< ~1 GiB)** — a 2 GB slug fits at idle. The 5 scraper containers (crawler/django/beat/writer/redis) remain Up; playwright remains Exited. Peak-under-load still to be measured in 25-02 before locking the 2 GB target.

**Revert recipe:** `docker start hemnet-metabase` (reach UI on-demand via `ssh -L 3000:localhost:3000 root@170.64.181.89`).

---

## D-03 peak-RAM profile  (25-02 Task 1 — operator-approved, PASS)

Operator approved the profiling crawl 2026-06-30. Harness: the real `WebScraper` (`apps/core/webscraper.py`, = the `fetch_via_webscraper()` path) driven directly inside the `hemnet-crawler` container, Metabase gated. URLs harvested from Hemnet `/bostader?page=N` search pages (54/page), then detail `/bostad/<slug>-<id>` pages crawled at concurrency 5. Success keyed on HTTP 200 + `__NEXT_DATA__` (ignoring the normal-page `cdn-cgi/challenge-platform` Cloudflare script — the 24-05 false-positive lesson). A host-side `free -m` sampler ran every 3s across the crawl (113 samples).

**Diagnostic (1 page) first:** content 1.78 MB, `__NEXT_DATA__` present, 54 `/bostad/` URLs → creds authenticate, pages return complete.

**Full crawl result:**
```
HARVESTED 261 unique listing URLs; crawled 205 @ concurrency 5
RESULT {"ok": 183, "blocked_403": 0, "auth_401": 0, "empty_other": 22, "exc": 0, "attempted": 205, "elapsed_s": 300}
```
- **0 HTTP-403, 0 auth-401** — scraper authenticates and is NOT blocked at the smaller-target-validating load.
- 183/205 returned `__NEXT_DATA__`; the 22 `empty_other` returned no content/`__NEXT_DATA__` (removed-listing tombstones / slow Oxylabs jobs) — **not blocks** (403/401 both 0).
- Oxylabs cost: ~211 Web Scraper API calls (1 diag + 5 search-harvest + 205 detail) ≈ **$0.53**. No credential values logged.

**RAM under load (113 samples, `free -m` used_MiB):**
| | used_MiB |
|---|---|
| Idle (Metabase gated, pre-crawl) | 979 |
| **PEAK during crawl** | **1033** |
| Idle (post-crawl) | 964 |

Peak is only +54 MiB over idle — five concurrent Oxylabs fetches each hold a ~1.8 MB response; the burst barely moves the working set. Containers undisturbed throughout (metabase Exited, 5 scrapers Up). Staged harness/sampler scripts removed from `/root` after the run (24-05 hygiene).

---

## Slug decision  (25-02 Task 2)

D-03 rule: peak < ~1.5 GiB (≈1536 MiB) with comfortable 2 GiB headroom → `s-1vcpu-2gb`; else fall back to `s-2vcpu-4gb`.

- Measured **PEAK = 1033 MiB**, well under 1536 MiB.
- On a 2048 MiB (`s-1vcpu-2gb`) box, a 1033 MiB peak leaves ~1015 MiB for kernel/buffers/cache headroom — comfortable for a once-a-month crawler storing ~200 data points.
- CPU is irrelevant (workload near-idle ~2–4% of 8 cores; a monthly crawl is not compute-bound).

**Chosen slug: `s-1vcpu-2gb`** (~$12/mo; ~8× cheaper than the current ~$96/mo `s-8vcpu-16gb`), justified by measured peak 1033 MiB. Fallback `s-2vcpu-4gb` not required.

Caveat carried into 25-03/25-04: peak was measured on the 16 GB box; the absolute working set should be the same on 2 GB, but with far less buff/cache slack — the 25-04 post-resize verification crawl + OOM watch is the real-size confirmation, with reversible re-resize-up as the rollback.

**Operator confirmed `s-1vcpu-2gb` on 2026-06-30** — carried into 25-03 as the resize target.

---

## Pre-resize gate  (25-03 Task 1 — read-only checks PASS; awaiting power-off approval)

Target slug (from 25-02): **`s-1vcpu-2gb`**.

**Token readiness:** `doctl` v1.151.0 on the operator workstation; `default` context authenticates for reads (`doctl account get` → julian@decadepartners.com.au, Team Hemnet). Write scope unconfirmed — per D-06 the power-off in Task 2 is the first write; a read-only token 403s there and Task 2 stops cleanly (no separate mutating probe run). `doctl` is NOT installed on the droplet — the resize is driven from the workstation.

**D-07 SECOND checkpoint (immediately pre-reboot, read-only):**
```
off-box probe 170.64.181.89:  22 OPEN, 3000 closed/filtered, 8000 closed/filtered
on-box: docker compose config | grep -c 'host_ip: 127.0.0.1'  => 2
```
Loopback bind still the running state → reboot will not re-expose :3000/:8000.

**PRE droplet state:**
```
$ doctl compute droplet get 357087018 --format ID,Name,Memory,VCPUs,Disk,Status
357087018  ubuntu-s-1vcpu-2gb-syd1-01  16384  8  50  active
```
(Memory 16384 / VCPUs 8 / Disk 50 = current `s-8vcpu-16gb`; Name is the legacy creation name.)

**Operator approved the power-cycle 2026-06-30 (current token).** Power-off attempted as the first write:
```
$ doctl compute droplet-action power-off 357087018 --wait
Error: POST .../droplets/357087018/actions: 403 (...) You are not authorized to perform this operation
$ doctl compute droplet get 357087018 --format Status
active   <-- UNCHANGED; read-only token confirmed, no mutation occurred
```

**BLOCKED — read-only token.** The `default` doctl token authenticates for reads but lacks write scope (403 on the droplet-action POST). Per D-06 design, Task 2 stopped cleanly with the droplet untouched (`active`, still `s-8vcpu-16gb`, Metabase gated). 

**Unblock (operator action):** provision a WRITE-scoped Personal Access Token (DO → API → Tokens → Generate New Token, write scope) and configure it on the workstation — either `doctl auth init` (new context) or `export DIGITALOCEAN_ACCESS_TOKEN=<token>` — then signal to resume. Resize resumes from power-off. Token to be revoked after 25-04 green (T-25-07).

**Write token provided by operator 2026-06-30** (`DIGITALOCEAN_ACCESS_TOKEN`, passed inline to doctl — never written to disk/logged). Read-probe `doctl account get` → julian@decadepartners.com.au. D-07 re-confirmed immediately pre-reboot (22 OPEN, 3000/8000 closed).

**Scope safety check (operator-raised):** `doctl compute droplet list` enumerated **7 droplets** on the account; only `357087018` was acted on. Every `droplet-action` is scoped to that single ID — the cohort-tracker box (`556306295`, 170.64.197.241), monitor-prod-syd1, decade-droplet, etc. all stayed `active`/untouched. The shared external managed Postgres `defaultdb` is a separate DO resource — a CPU/RAM droplet resize does not touch it; cohort-tracker DB access unaffected.

---

## Resize executed  (25-03 Task 2 — PASS)

D-06 sequence against DO ID `357087018`, write token, slug `s-1vcpu-2gb`:
```
$ doctl compute droplet-action power-off 357087018 --wait
  3265558878  completed  power_off   ... (droplet → off)
$ doctl compute droplet-action resize 357087018 --size s-1vcpu-2gb --resize-disk=false --wait
  3265561010  completed  resize      2026-06-30 03:17:50 → 03:19:40 UTC
$ doctl compute droplet-action power-on 357087018 --wait
  3265562651  completed  power_on    2026-06-30 03:19:46 → 03:20:01 UTC
```

PRE → POST `doctl compute droplet get 357087018`:
| | Memory | VCPUs | Disk | Status |
|---|---|---|---|---|
| PRE  | 16384 | 8 | 50 | active |
| **POST** | **2048** | **1** | **50** | **active** |

Reversible CPU/RAM-only resize (`--resize-disk=false`) — **50 G disk preserved**, so re-resize-up remains possible. No disk-grow/full resize issued.

SSH reachability on the smaller slug (just rebooted):
```
$ ssh … 'hostname; uptime; free -h; df -h /'
ubuntu-s-1vcpu-2gb-syd1-01
 03:20:30 up 0 min,  load average: 1.41, 0.36, 0.12
Mem:   total 1.9Gi   used 248Mi   available 1.5Gi      # 2 GB slug
/dev/vda1  49G  22G used  28G avail  44%               # 50 G preserved
```

**Verdict: 25-03 PASS.** Droplet resized down to `s-1vcpu-2gb` (cost ~$96/mo → ~$12/mo, SIZE-01), 50 G disk preserved, box back `active` and SSH-reachable with fresh uptime. Write token to be revoked by operator after 25-04 green (T-25-07).

---

## Post-resize infra health  (25-04 Task 1 — recovery + reboot-persistent gate, PASS)

### Problem found: the Metabase gate was NOT reboot-persistent (T-25-13 materialized, then recovered)

On the FIRST 2 GB boot the box went into an OOM crash-loop — SSH accepted TCP on :22 but the handshake timed out (no swap; memory-starved). Root cause analysis (done on a healed box):
- The droplet boots containers via `hemnet.service` → `bin/restart.sh` (`docker compose up -d` + `docker compose restart`).
- Metabase's container restart policy is `on-failure`, and `docker stop` exits 143 (non-zero). On a real reboot the **Docker daemon itself** restarts the `on-failure` container (independent of compose), so Metabase (~1 GiB JVM) came back and OOM-thrashed the 2 GB / 0-swap box.
- A plain `docker stop` is therefore NOT a reboot-persistent gate. The box had 229 days uptime, so this was never exercised — the same latent gap applies to the P23 Playwright `docker stop` gate (see Open items).

### Fix (reversible, durable) — two complementary mechanisms
1. **`docker-compose.override.yml`** (untracked, scp'd to `/var/www/apps/hemnet/`) marks Metabase as `profiles: ["ondemand"]` → the boot-time `docker compose up -d`/`restart` skips it. Validated against the real `bin/restart.sh`: it brought up all scrapers but left Metabase Exited.
2. **`docker update --restart=no hemnet-metabase`** → the daemon no longer auto-restarts it on boot (addresses the `on-failure`-exit-143 path the override does not cover).

Recovery sequence (reversible re-resize used per D-05): rolled UP to `s-2vcpu-4gb` to heal, applied the fix, rolled back DOWN to `s-1vcpu-2gb`; final gate applied by racing `docker update --restart=no` + `docker stop` into the early-boot window (caught ~12 s in).

### Reboot-persistence — DEFINITIVE test (PASS)
Issued `reboot` on the 2 GB box; after it came back:
```
uptime ~64s   metabase running = 0   used = 127 MiB   avail = 1653 MiB
```
Metabase stayed DOWN across a real daemon restart. Confirmed reboot-persistent.

### Settled health snapshot (s-1vcpu-2gb, healthy)
```
off-box probe 170.64.181.89:  22 OPEN, 3000 closed/filtered, 8000 closed/filtered   # bind survived
docker ps -a:  crawler / writer / beat / crawler-playwright / django / redis  Up
               hemnet-metabase  Exited (137)        # gated, policy=no, running=0
free -h:  total 1.9Gi  used 546Mi  available 1.2Gi  # scrapers + playwright up, Metabase gated
df -h /:  /dev/vda1  49G  21G used  28G avail  43%   # 50 G preserved
docker ps ports:  hemnet-django  127.0.0.1:8000->8000/tcp   # loopback bind intact
```

**Verdict: 25-04 Task 1 PASS.** Box healthy on `s-1vcpu-2gb`, Metabase gate now reboot-persistent, loopback bind survived the reboot (3000/8000 closed off-box), 5 scrapers + playwright Up, disk preserved. Ready for the D-05 verification crawl.

**Note (resolved in Task 2):** `hemnet-crawler-playwright` also restarted on boot (same non-persistent-`docker stop` gap from P23) — and turned out to be the dominant idle RAM consumer (celery `--concurrency=8` ≈ 600 MiB / 8 worker procs). On the 2 GB box that left only ~184 MiB headroom at the start of the verification crawl, so it was gated the same durable way (override `ondemand` profile + `--restart=no`) — see Task 2. It is intended-off per P23 (its `playwright_queue` was rerouted to the `default` queue), so gating it strands nothing.

---

## D-05 verification crawl + final end-state  (25-04 Task 2 — GREEN)

Operator approved the verification crawl 2026-06-30.

**Pre-crawl headroom fix:** First launch showed used RAM jump to ~1617 MiB (avail ~184) — the warmed `crawler-playwright` celery workers (~600 MiB) were the cause. Aborted the run, gated Playwright durably (override profile + `docker update --restart=no hemnet-crawler-playwright` + stop) → used dropped to 684 MiB, **avail 1115 MiB**. Re-ran the crawl.

**Crawl result (ON the resized `s-1vcpu-2gb` box, RAM/OOM watched):**
```
HARVESTED 261 unique listing URLs; crawled 205 @ concurrency 5
RESULT {"ok": 178, "blocked_403": 0, "auth_401": 0, "empty_other": 27, "exc": 0, "attempted": 205, "elapsed_s": 326}
PEAK used_MiB = 733   (on a 1963 MiB box → ~37% utilization, ~1.2 GiB headroom)
dmesg OOM check: clean (no "out of memory" / "killed process")
containers after crawl: redis/django/beat/crawler/writer Up; meta=0 pw=0
```
- **0 HTTP-403, 0 auth-401** — scraper reaches Hemnet via Oxylabs at the smaller size.
- **No OOM**; peak 733 MiB. The 27 `empty_other` are removed-listing tombstones / slow jobs, not blocks.
- Cost ~211 calls ≈ $0.53 (+ ~7 from the aborted harvest). Staged harness removed (24-05 hygiene).

**Final end-state — definitive reboot (PASS):**
```
slug: s-1vcpu-2gb (Memory 2048 / VCPUs 1 / Disk 50 / active)
docker ps -a:  redis/django/beat/crawler/writer  Up
               hemnet-metabase           Exited (137)   restart policy = no
               hemnet-crawler-playwright Exited (0)     restart policy = no
off-box probe: 22 OPEN, 3000 closed/filtered, 8000 closed/filtered   # bind survived
free -h: used 627Mi  available 1.1Gi      df -h /: 49G, 21G used (50 G preserved)
```
Both gates reboot-persistent; the 5 scraper containers come up healthy; loopback bind held; no OOM.

**VERDICT: D-05 GREEN.** SIZE-02 met — the scraper runs correctly and reaches Hemnet via Oxylabs (0% 403, no OOM) on `s-1vcpu-2gb`, and the box survives reboots in the secure, lean configuration. No rollback needed.

> **Operator follow-through (T-25-07):** revoke the write-scoped `doctl` token now that verification is green.
