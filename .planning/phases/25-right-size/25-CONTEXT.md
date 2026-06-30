# Phase 25: Right-size - Context

**Gathered:** 2026-06-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Resize the Hemnet/Booli price-scraper droplet (`170.64.181.89`, DO ID 357087018, syd1) **down** from `s-8vcpu-16gb` (~$96–100/mo) to the smallest slug its post-cleanup footprint can safely support, then verify the price scraper still runs and reaches Hemnet via Oxylabs at the smaller size. Satisfies SIZE-01 (resize + cost cut) and SIZE-02 (post-resize verification).

**Footprint that makes this safe (post Phases 23+24):** CPU near-idle (~2–4% of 8 cores); RAM steady-state ~2.6 GiB used / ~12 GiB free after Playwright gate-off (Metabase ~1.6 GiB is the largest remaining consumer); disk 22 G used / 28 G free of 50 G. The shared managed Postgres is **external** — DB size does not count against droplet disk.

**In scope:** the droplet resize itself, gating Metabase to on-demand to unlock a smaller slug, a pre-resize RAM profile to de-risk the target, and a post-resize Oxylabs verification crawl.
**Out of scope:** managed-Postgres / `simple_history` cleanup (separate system + cost lever — see Deferred), any destructive DB changes, rebuilding the box.

</domain>

<decisions>
## Implementation Decisions

### Target slug & Metabase
- **D-01:** Target slug is **`s-1vcpu-2gb` (~$12/mo)** — the smallest standard slug, ~8× cheaper than today. This is the aggressive-but-guarded pick, appropriate because the workload is a **once-a-month crawler storing ~200 data points** (no continuous compute pressure).
- **D-02:** **Gate Metabase to on-demand** (reversible — same pattern as the Phase 23 Playwright gate-off: stop the container, start it only when a dashboard is needed). This drops steady-state under ~1 GiB so a 2 GB slug fits. Metabase does not need to run 24/7 for a monthly crawler.
- **D-03 (guardrail):** Before committing to `s-1vcpu-2gb`, run **one manual Oxylabs crawl with `docker stats`** (Metabase gated) to capture **peak** RAM, not just idle steady-state. Proceed to 2 GB only if peak fits comfortably (target headroom, peak < ~1.5 GiB). **Fallback:** if the profile shows it doesn't fit, drop back to `s-2vcpu-4gb` (~$24/mo). The profiling crawl needs operator per-run approval (see D-06).

### Resize mode
- **D-04:** **CPU/RAM-only, reversible resize** — keep the existing 50 G disk (22 G used fits fine). Do **not** take the one-way disk-growing "full" resize; disk is not the binding constraint and reversibility matches the milestone's reversible-first posture (D-06 from Phase 24). This keeps the option to resize back up if verification fails.

### Verification & rollback
- **D-05:** Green bar = **bounded Oxylabs verification crawl (~200 pages, per N≥200 default)** through `apps/core/webscraper.py`: require HTTP 200 + `__NEXT_DATA__` present, **0% HTTP-403**; plus all Hemnet containers healthy and SSH access surviving the power-cycle. **Rollback:** reversible re-resize back up if the box is blocked/unhealthy. (Ignore the embedded `cdn-cgi/challenge-platform` script — present on normal pages; key on `__NEXT_DATA__`.)

### Execution
- **D-06:** **Claude drives the resize via a write-scoped `doctl` token** (operator provisions it — current token is read-only and 403s on writes). Sequence: power-off → resize → power-on → verify, with an **explicit operator approval gate before power-off** and before the Oxylabs crawl.
- **D-07 (pre-flight safety):** Before any power-cycle, **confirm the Phase 24-05 `127.0.0.1` compose bind is the running state** (commit `ed7192c`) so the reboot does not re-expose :3000/:8000 (the interim 24-02 iptables drops are NOT reboot-persistent). SSH must use the `IdentitiesOnly=yes -o IdentityAgent=none` gotcha or it false-fails.

### Claude's Discretion
- Exact crawl page count within the N≥200 floor, the precise `docker stats` capture method, and the ordering of the Metabase gate-off vs the profiling crawl are left to the planner — provided D-03's "profile peak before locking 2 GB" guardrail and D-05's verification bar are honored.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirements & goal
- `.planning/ROADMAP.md` — Phase 25 goal + Success Criteria (lines ~493–501); v4.0 milestone framing
- `.planning/REQUIREMENTS.md` — SIZE-01, SIZE-02 (lines 38–39)

### Footprint & sizing evidence
- `docs/price-scraper-droplet-audit.md` §"Resource + cost baseline" (lines ~97–104) — actual CPU/RAM/disk vs allocation; the audit's own "4 vCPU / 8 GB plausible" read and the Metabase/Playwright RAM drivers
- `.planning/phases/24-cleanup/24-VERIFICATION.md` — post-cleanup end-state (6 containers, disk 79%→45% = 22 G used, reboot-persistence notes)
- `.planning/phases/23-fix-hemnet-capability-oxylabs-fetch/23-PLAYWRIGHT-GATEOFF.md` — the reversible gate-off pattern + ~6 GB RAM freed (reuse for Metabase)

### Access, execution & hardening
- `docs/price-scraper-droplet-runbook.md` — SSH access model, `IdentitiesOnly` gotcha, doctl read-only-token limitation, resize/power-off notes
- `.planning/phases/24-cleanup/24-05-HARDENING.md` + `24-05-SUMMARY.md` — `127.0.0.1` compose bind (reboot-safe), Oxylabs verification-crawl pattern (0% 403, `__NEXT_DATA__`), borrowed Oxylabs creds

### Verification path
- `apps/core/webscraper.py` (on the droplet repo `tt7676/hem-bol-scrapers`) — Oxylabs Web Scraper API path the verification crawl routes through

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Playwright gate-off recipe (Phase 23):** `docker stop` + celery queue reroute — directly reusable to gate Metabase to on-demand (D-02).
- **Oxylabs verification crawl (Phase 23 / 24-05):** the ~200-page / ~50-page crawl harness keying on HTTP 200 + `__NEXT_DATA__` — reuse verbatim for the post-resize green check (D-05).
- **Phase 21 access runbook:** SSH key model + doctl usage — the access basis for driving the resize (D-06/D-07).

### Established Patterns
- **Reversible-first ops (D-06 milestone principle):** every change must be undoable — drives the CPU/RAM-only resize (D-04) and the Metabase gate (D-02).
- **No Oxylabs crawl without per-run operator approval; N≥200 default** — gates both the D-03 profiling crawl and the D-05 verification crawl.

### Integration Points
- Resize is an **infra/ops action on the droplet + DO API**, not a change to this repo's source. The only "code" touched is the droplet repo's `docker-compose` (Metabase gate) — reversible.

</code_context>

<specifics>
## Specific Ideas

- Operator's framing (verbatim sense): "This is a super light crawl agent — it runs once a month and only stores ~200 data points, so we can go as light as possible. The real constraint we have is **data storage for historical data**, which we may not need forever." → motivates the aggressive `s-1vcpu-2gb` target AND the deferred managed-DB retention idea below.
- Cost trajectory: ~$96/mo → **~$12/mo** at `s-1vcpu-2gb` (fallback ~$24/mo at `s-2vcpu-4gb`).

</specifics>

<deferred>
## Deferred Ideas

- **Managed-Postgres retention + `simple_history` bloat cleanup (~49 GB):** the operator's "historical data we may not need forever" concern. This is a **separate cost lever** — the DB is an external DO managed Postgres, its bloat does not sit on the droplet disk and does not gate this resize. Belongs in its own phase (revives deferred D-03 from Phase 24): measure DB size/cost, decide a retention policy, then prune `simple_history`. **Not touched in Phase 25.**
- **Dedicated rotatable Oxylabs sub-user:** the droplet currently *borrows* the cohort-tracker Web Scraper creds (refreshed in 24-05). Open TODO to provision a dedicated, rotatable sub-user. Out of scope for the resize.

</deferred>

---

*Phase: 25-right-size*
*Context gathered: 2026-06-30*
