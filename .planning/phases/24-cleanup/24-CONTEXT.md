# Phase 24: Cleanup (gated on audit) — Context

**Gathered:** 2026-06-30
**Status:** Ready for planning
**Source:** Operator decisions (AskUserQuestion, 2026-06-30) + Phase-22 audit evidence

<domain>
## Phase Boundary

Phase 24 cleans up the **operator-owned, malware-compromised** price-scraper droplet
`170.64.181.89` (`s-8vcpu-16gb`, syd1), in place, on the evidence produced by Phase 22
(`docs/price-scraper-droplet-audit.md`). **Ownership clarified 2026-06-30:** there is no
separate host-owning team — the DigitalOcean droplet is the operator's, and the scraper
repo `github.com/tt7676/hem-bol-scrapers` is effectively the operator's too (Illia/Raymond
are the operator's devs/contractors). So **repo edits are permitted** and the durable
root-cause hardening is folded INTO this phase. The phase now has **four** workstreams:

1. **Malware remediation (in P24)** — investigate how the Kinsing/`kdevtmpfsi`
   cryptominer persists + how it got in, remove it cleanly, then retire the per-minute
   `kill.sh` whack-a-mole (and the 4.4 GB `kill.log` it generates).
2. **Light app/container cleanup** — confirm the audit-cleared apps
   (spotify/procore/block_inc) stay disabled, remove the 7-month stale orphan container,
   and reclaim ~10 GB of reclaimable Docker images. **No DB table drops** (modules/tables
   stay; their removal is a possible follow-up, not P24).
3. **Disk reclaim** — rotate/remove the oversized droplet logs and reclaim disk so the
   box fits a smaller slug in Phase 25, leaving the Hemnet price scraper as the primary
   workload.
4. **Durable root-cause hardening (folded in 2026-06-30)** — after the host is verified
   clean, fix the entry vector at the source in the repo (not just the firewall
   containment), rotate the `.env` secrets that a long compromise may have exposed,
   upgrade the exposed Metabase v0.47.1, and replace the `django runserver`/DEBUG dev
   server with a production server — each reversible, with the scraper re-verified green.

**In scope:** malware remediation + entry-vector closure (firewall containment AND durable
repo fix); orphan-container removal; Docker image reclaim; droplet log reclaim
(`scraper_log_export` 6.6 GB, `kill.log` 4.4 GB once `kill.sh` is retired);
`authorized_keys` one-key-per-line hygiene fix; **`.env` secret rotation; Metabase upgrade;
runserver/DEBUG → production-server hardening (repo edits + rebuild/redeploy allowed).**

**Explicitly OUT of scope:**
- Dropping the dead app DB tables (block_inc/procore) or removing their app modules —
  left in place (D-02); a possible follow-up, not P24.
- Reclaiming the ~49 GB `simple_history` DB bloat (`booli_historicallisting` 34 GB +
  `hemnet_historicallistingv2` 15 GB) — **deferred to a separate coordinated DB task**;
  it is an external managed shared DB and does not gate Phase 25 droplet right-sizing.
- Droplet resize itself (Phase 25).
</domain>

<decisions>
## Implementation Decisions

### D-01 — Malware: remediate inside Phase 24 (operator 2026-06-30)
Do NOT merely escalate. Phase 24 investigates the persistence mechanism and the likely
entry vector (candidates from the audit: exposed Docker API, `django runserver` on :8000
with DEBUG, the Redis broker, weak/exposed services), removes Kinsing + `kdevtmpfsi`
cleanly, and verifies the host stays clean **without** the per-minute `kill.sh`. After a
verified-clean window, retire `kill.sh` from the system crontab and remove the 4.4 GB
`kill.log`. Still NOTIFY the team (they own the host). Keep the standing rule **"no
Oxylabs creds on the box until remediation is verified"** (STATE 2026-06-30) in force
until this completes — this makes P24 the gating prerequisite for the droplet's Hemnet
fetch to run in prod.

### D-02 — Cleared apps: disable/confirm only, drop nothing (operator 2026-06-30)
Most-conservative removal. Confirm the block_inc/procore/spotify Celery beat tasks remain
disabled (`last_run=None`). Remove the stale orphan container
`hemnet-django-run-e2e3a39dc795` (up 7 months). Reclaim the ~10.2 GB of reclaimable Docker
images (`docker image prune`-class, dangling/unused only — never the live `hemnet` image
the 7 running containers use). **Drop NO DB tables** (block_inc/procore empty tables stay).
Beat tasks are already disabled, so CLEAN-01 is satisfied by *confirming* disabled-state +
orphan/image reclaim, not by code or schema removal. (Note: repo edits ARE allowed in this
phase per the 2026-06-30 ownership clarification + D-08, but the operator's choice here is
still to leave the cleared-app modules/tables in place — removing them is a possible
follow-up, not P24.)

### D-03 — DB `simple_history` bloat: deferred (operator 2026-06-30)
The ~49 GB bloat in the shared external managed Postgres is NOT touched in P24. It does not
affect the droplet's 50 GB local disk that Phase 25 right-sizes, and the DB is shared with
this cohort-tracker repo + the team. Record it as a separate backed-up, team-coordinated
DB-maintenance task.

### D-04 — Disk reclaim (CLEAN-02)
Reclaim the droplet's `/dev/vda1` (30 GB used / 19 GB avail of 49 GB). Targets, in order of
safety:
- `scraper_log_export/` — 6.6 GB of Nov-2025 one-off export logs; remove (or archive off-box
  first if the operator wants them retained).
- Reclaimable Docker images — ~10.2 GB (D-02).
- `kill.log` — 4.4 GB; remove only AFTER `kill.sh` is retired (D-01), else it just regrows.
Target end-state: comfortably under a smaller-slug disk so Phase 25 can resize.

### D-05 — `authorized_keys` hygiene (carried from P21/P22)
Rewrite `/root/.ssh/authorized_keys` one key per line to clear the inert dangling RSA key
blob on line 1. Verify access is preserved before/after (do not lock the operator out).

### D-06 — Reversibility on a compromised host (operator-owned)
Mirror the Phase-23 posture: **in place, audit-before-kill, reversible-first.** Every
destructive step is operator-gated and has a documented revert/restore path. Take a record
of state before each removal (container/image IDs, crontab backup, file listings). Repo
edits + rebuild/redeploy are PERMITTED (operator owns the repo per the 2026-06-30
clarification) — but do them reversibly: work on a feature branch (mirror Phase 23's
`feat/…` posture), keep the prior image tag for rollback, and re-verify the scraper green
after any rebuild. Because the host is (until verified clean) compromised, prefer
removing/observing over adding secrets; **do not reintroduce/port working Oxylabs creds
until the host is verified clean (D-01/CLEAN-04)** — secret *rotation* of already-exposed
creds is fine and expected (D-08).

### D-07 — Sequencing
Malware remediation (D-01) precedes or accompanies disk/container cleanup; `kill.log`
removal depends on `kill.sh` retirement; CLEAN-03 (Hemnet is the primary workload) is the
mid-phase verification. **The durable repo-level hardening (D-08) runs LAST**, gated on the
host being verified clean — fix the source + rotate secrets only once the box is trusted and
the immediate vector is already contained at the firewall. Phase 25 (right-size) stays gated
on this phase.

### D-08 — Durable root-cause hardening folded into P24 (operator 2026-06-30)
Because the operator owns the scraper repo, the durable fixes originally deferrable to a
team are now in scope as a final, post-verified-clean wave (new plan 24-05), each on a
feature branch, reversible, with the scraper re-verified green afterward:
- **Close the entry vector at the source**, not only at the DO Cloud Firewall (24-02
  containment stays the fast first move): once the live vector is diagnosed (24-01 R3), fix
  it in repo/host config — e.g. bind the Docker daemon to the unix socket only
  (`/etc/docker/daemon.json`), put Redis on the docker-internal network + `requirepass`,
  unpublish/scope the port in `docker-compose.yml`.
- **Replace `django runserver` + `DEBUG=True`** with a production server (gunicorn/uvicorn)
  + `DEBUG=False` (or firewall :8000 if a full swap is too risky now).
- **Upgrade Metabase v0.47.1** (pre-auth RCE CVE-2023-38646 class) to a current pinned
  version, or firewall :3000 as the interim control.
- **Rotate the `.env` secrets** a long compromise may have exposed (`DJANGO_SECRET_KEY`,
  `DATABASE_URL`, `MB_DB_*`, Oxylabs) — but only PORT working Oxylabs creds back AFTER
  verified-clean (D-01), preferring a dedicated, rotatable Oxylabs sub-user over the shared
  cohort-tracker creds (STATE 2026-06-30).
- **Escape hatch:** if execution shows the rebuild/redeploy risks destabilizing the scraper
  right before the Phase-25 resize, 24-05 may be split to a follow-up phase — the firewall
  containment + secret rotation still hold the security line meanwhile.

### Claude's Discretion
- Exact remediation tooling/commands (process tree inspection, persistence hunt across
  cron/systemd/`/tmp`/`/dev/shm`/LD_PRELOAD/Docker, package/file integrity).
- Log-rotation mechanism (logrotate config vs one-shot truncate/remove) and whether to
  archive `scraper_log_export` off-box before deletion (default: confirm with operator).
- Whether the verified-clean observation window is hours or a day before retiring `kill.sh`.
- The exact form of the remediation record (audit-doc update + an incident record for the
  operator's own files / contractors — there is no separate owning team to escalate to).
- Verification-evidence format (a `24-VERIFICATION` evidence doc mirroring 22-EVIDENCE.md).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Audit evidence (authorizes every removal)
- `docs/price-scraper-droplet-audit.md` — keep/kill verdicts, disk/log inventory, malware
  finding (Hygiene section), resource baseline, container list.
- `.planning/phases/22-deep-dive-audit/22-EVIDENCE.md` — raw command + output evidence
  (§1 app inventory, §2 data/storage, §3 scheduled work incl. `kill.sh`, §4 resource
  baseline, §5 keep/kill dependency evidence).

### Access + prior phases
- `docs/price-scraper-droplet-runbook.md` — droplet access model (SSH key, `IdentitiesOnly`
  / `MaxAuthTries` gotcha) used to reach the box.
- `.planning/STATE.md` — Phase 23 outcome + the 2026-06-30 malware/creds decision
  (no creds on box until malware remediated; P24 is the gating prerequisite).
- `.planning/REQUIREMENTS.md` — CLEAN-01, CLEAN-02, CLEAN-03 + v4.0 out-of-scope list.

### Requirement IDs this phase must close
- **CLEAN-01** — audit-cleared apps removed/disabled (satisfied per D-02 by confirming
  disabled + orphan/image reclaim; no table/code removal).
- **CLEAN-02** — oversized logs rotated/removed, disk reclaimed, container set reduced to
  essentials.
- **CLEAN-03** — end-state: the Hemnet price scraper is the primary workload.
- **CLEAN-04** — Kinsing/`kdevtmpfsi` remediated in place (persistence removed, entry vector
  closed — firewall containment AND durable repo-source fix per D-08 — `kill.sh` retired),
  host verified clean; the prerequisite for porting Oxylabs creds back onto the box.
</canonical_refs>

<specifics>
## Specific Ideas

- The "8 containers" are all from the single `hemnet` image; the 7 live ones
  (`hemnet-django/-crawler/-crawler-playwright/-writer/-beat/-redis/-metabase`) are the
  product (Playwright already gated OFF in Phase 23 — `docker stop hemnet-crawler-playwright`,
  reversible). The orphan `hemnet-django-run-e2e3a39dc795` is the only container kill target.
- `kill.sh` lives at `/home/raymondsunartio/kill.sh`, runs `* * * * *` in the system crontab,
  and is the *symptom-suppressor* for the infection — retiring it is contingent on D-01
  remediation succeeding, not a standalone cleanup.
- Disk math (audit §2/§4): `/dev/vda1` 30 GB used; reclaimable = `kill.log` 4.4 GB +
  `scraper_log_export` 6.6 GB + reclaimable Docker images ~10.2 GB ≈ 21 GB.
- Kinsing commonly enters via exposed Docker API (2375/2376), unauthenticated Redis, or
  vulnerable web apps — the box runs Redis (broker) + `django runserver` (dev server) on a
  prod host, both worth checking as vectors (audit Hygiene note).
</specifics>

<deferred>
## Deferred Ideas

- Reclaiming the ~49 GB `simple_history` DB bloat — separate coordinated, backed-up DB task
  (D-03).
- Dropping the dead block_inc/procore tables and removing their app modules — left in place
  (D-02); repo edits are now allowed, but the operator's choice is still to leave these; a
  possible follow-up, not P24.
- Droplet resize — Phase 25.

*(No longer deferred: hardening `django runserver`/`DEBUG`, the Metabase upgrade, the
durable in-repo entry-vector fix, and `.env` secret rotation — all folded into P24 as the
final 24-05 hardening wave per D-08, now that the operator owns the repo.)*
</deferred>

---

*Phase: 24-cleanup*
*Context gathered: 2026-06-30 via operator decisions + Phase-22 audit*
