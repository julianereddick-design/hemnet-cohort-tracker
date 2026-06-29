# Phase 22: Deep-dive audit - Context

**Gathered:** 2026-06-29
**Status:** Ready for planning
**Source:** Orchestrator-captured during `/gsd-plan-phase 22` (no separate discuss-phase — rich context already in PROJECT.md / ROADMAP.md / Phase-21 artifacts; two gating decisions captured via question)

<domain>
## Phase Boundary

Produce a **complete, evidence-based audit** of everything running on the team-owned price-scraper droplet `170.64.181.89` (`s-8vcpu-16gb`, syd1, root user; repo `github.com/tt7676/hem-bol-scrapers`; Hemnet app at `/var/www/apps/hemnet`), ending in a **keep/kill recommendation per app backed by dependency evidence**. This phase **gates Phase 24 (cleanup)** — nothing gets removed until this audit clears it.

**In scope:** inventory the 6 apps (`hemnet`, `booli`, `spotify`, `procore`, `block_inc`, `core`); map data + storage (Postgres DB(s)/tables, Metabase, Redis, Docker volumes, on-disk logs incl. the 4.6 GB `kill.log` + 121 MB blocking log); enumerate all scheduled/triggered work (Celery beat schedule, queues, restart scripts) with cadence; capture a real resource + cost baseline (actual CPU/mem/disk vs the `s-8vcpu-16gb` allocation); per non-Hemnet-price app (incl. Booli) a keep/kill recommendation with what-breaks-if-removed evidence.

**NOT in scope:** the Oxylabs fetch fix (Phase 23), any cleanup/removal/log truncation (Phase 24), resize (Phase 25), and **any change to the droplet** — this is a read-only investigation. Access setup is done (Phase 21).
</domain>

<decisions>
## Implementation Decisions

### Audit execution model — Claude SSHes, READ-ONLY (operator decision 2026-06-29)
- The executor connects with the Phase-21 root key and runs the audit **itself**, autonomously, against the **live production** droplet.
- **Hard guardrails (this is a team-owned prod box running a live scraper):**
  - **Read-only only.** No writes, no file edits, no `rm`, no log truncation, no service restarts/stops, no `docker` mutations (no `restart`/`stop`/`rm`/`prune`), no package installs, no config changes, NO reboot.
  - Use only inspection commands: `ls`, `cat`, `du`, `df`, `ps`, `top -bn1`, `free`, `systemctl status`, `docker ps`/`docker inspect`/`docker logs --tail`, `crontab -l`, `redis-cli INFO`, read-only `psql`/`\dt`+`count` queries, `celery ... inspect`, reading config files, etc.
  - **Flag-don't-run for heavy I/O:** any command with material load on the live box (full-tree `du -sh /`, greps across the 4.6 GB `kill.log`, full table scans) must be **bounded** (depth-limited `du`, `tail`/`head`/`wc -l` instead of full reads, `du -sh` on specific dirs not recursive over `/`) — prefer cheap metadata (file sizes via `ls -la`/`stat`, `du -sh <dir>` per top-level dir) over expensive recursive scans.
  - Connection: `ssh -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=12 -i ~/.ssh/droplet_ed25519 root@170.64.181.89` (the `IdentitiesOnly` gotcha — see runbook).
- Rationale: Phase 21 verified durable root access; the audit is inherently read-only; `audit-before-kill` is the milestone's stated approach.

### Deliverable location — this repo, `docs/` (operator decision 2026-06-29)
- Write the audit as **`docs/price-scraper-droplet-audit.md`**, alongside the Phase-21 `docs/price-scraper-droplet-runbook.md`. Keeps the v4.0 ops paper trail together and makes it a durable reference for Phases 23–25.
- It must be **evidence-based**: every claim (app purpose, last-active, sizes, cadence, keep/kill) cites the command output / file path it came from, not assertion. Quote actual numbers (sizes in GB/MB, CPU%, mem, cadence strings).

### Audit doc structure (maps 1:1 to the 5 success criteria → AUDIT-01..05)
1. **App inventory (AUDIT-01):** table of all 6 apps (`hemnet`, `booli`, `spotify`, `procore`, `block_inc`, `core`) — purpose, owner, last-active evidence (last log write / last cron fire / last DB row).
2. **Data + storage map (AUDIT-02):** Postgres DB(s) + table list with row counts/sizes, Metabase, Redis (keyspace/INFO), Docker volumes (names + sizes), large on-disk logs with sizes (explicitly the 4.6 GB `kill.log` and the 121 MB blocking log).
3. **Scheduled/triggered work (AUDIT-03):** Celery beat schedule, queue list, restart scripts, crontab — each with cadence.
4. **Resource + cost baseline (AUDIT-04):** actual CPU/mem/disk in use vs the `s-8vcpu-16gb` (~$100/mo) allocation — the right-sizing evidence for Phase 25.
5. **Keep/kill recommendations (AUDIT-05):** per non-Hemnet-price app (incl. Booli) a keep or kill call with dependency evidence (what breaks if removed — shared DB? shared Redis? cron deps? imports?). The Hemnet price scraper is the keep-by-default primary workload.

### Carry-forward findings to verify/fold in
- **Dangling RSA key blob** appended to Tom's `authorized_keys` line 1 (inert, one-key-per-line bug) — note in the audit's hygiene/cleanup section (action deferred to Phase 24).
- Droplet is actually `s-8vcpu-16gb` ~$100/mo despite the legacy `1vcpu-2gb` name — baseline must confirm.

### Claude's Discretion
- Exact command set per section (within the read-only guardrails above).
- Audit doc section ordering/wording beyond the 5 mandated sections.
- Whether to capture a machine-readable appendix (raw command outputs) alongside the prose.
- How to determine "owner" per app (git blame / commit authors in the team repo, container labels, or mark "unknown — team").
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Droplet facts + access
- `docs/price-scraper-droplet-runbook.md` — host/IP/region, root user, exact SSH command + `IdentitiesOnly` gotcha, key inventory, doctl checks, the dangling-RSA-blob finding. **The executor connects exactly as documented here.**
- Memory `project_droplet_inventory` — full DO account map; confirms `170.64.181.89` is the team Hemnet/Booli price-scraper box, SEPARATE from cohort-tracker `170.64.197.241`.
- `.planning/phases/21-consistent-access/21-CONTEXT.md` — access decisions + verified state.

### Scope + requirements
- `.planning/PROJECT.md` (v4.0 milestone section) — audit scope, the 6 apps, `audit-before-kill` approach, investigation provenance.
- `.planning/ROADMAP.md` (Phase 22 section) — goal + 5 success criteria; **gates Phase 24**.
- `.planning/REQUIREMENTS.md` — AUDIT-01..05 wording.

### Adjacent milestone phases (do NOT do their work here)
- Phase 23 = Oxylabs Hemnet fetch fix (403s). Phase 24 = cleanup (consumes this audit). Phase 25 = right-size (consumes the baseline).
</canonical_refs>

<specifics>
## Specific Ideas
- doctl is authenticated on the operator workstation (read token, re-authed 2026-06-29) — use `doctl compute droplet list --format ID,Name,PublicIPv4,Region,Memory,VCPUs` to confirm the actual slug/size for AUDIT-04 without touching the box.
- Known landmarks to find evidence for: the 4.6 GB `kill.log`, a 121 MB blocking log, Docker (the apps run as root containers), Celery + beat, Redis, Postgres, Metabase, app tree under `/var/www/apps/`.
- "Last-active" evidence ideas: newest mtime in each app's dir/log, last cron run, last Celery task, last DB write per app's tables.
</specifics>

<deferred>
## Deferred Ideas
- Any removal, truncation, or right-sizing action — Phases 24/25.
- The Oxylabs fetch fix — Phase 23.
- A real reboot/persistence test — operator-gated (live scraper), out of scope here.
</deferred>

---

*Phase: 22-deep-dive-audit*
*Context captured: 2026-06-29 during /gsd-plan-phase 22*
