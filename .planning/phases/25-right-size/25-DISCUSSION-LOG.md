# Phase 25: Right-size - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-30
**Phase:** 25-right-size
**Areas discussed:** Target slug, Resize mode, Verification bar, Execution path, Metabase gating, Historical data storage

---

## Target slug

| Option | Description | Selected |
|--------|-------------|----------|
| s-4vcpu-8gb (~$48/mo) | Documented safe default; comfortable headroom | |
| s-2vcpu-4gb (~$24/mo) | Aggressive; fits working set, thin margin; profile first | ✓ (initial) |
| Profile first, then decide | Crawl + docker stats, pick from real burst | |

**User's choice:** s-2vcpu-4gb initially — then went lighter (see Metabase gating).
**Notes:** "Super light crawl agent — runs once a month, only stores ~200 data points, so go as light as possible. The real constraint is data storage for historical data, which we may not need forever."

---

## Resize mode

| Option | Description | Selected |
|--------|-------------|----------|
| CPU/RAM-only (reversible) | Keep 50 G disk; fully reversible; matches D-06 | ✓ |
| Full resize (grow disk, one-way) | Enlarges disk irreversibly; no upside here | |

**User's choice:** CPU/RAM-only (reversible).
**Notes:** Disk not the binding constraint (22 G used of 50 G).

---

## Verification bar

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded Oxylabs crawl, 0% 403 | ~200 pages, HTTP 200 + __NEXT_DATA__, rollback on fail | ✓ |
| Lighter smoke (~50 pages) | Cheaper ~$0.63 crawl; below N≥200 default | |
| Health-only, no crawl | Containers up + reachable; doesn't prove fetch works | |

**User's choice:** Bounded Oxylabs crawl, 0% 403.
**Notes:** Crawl needs per-run operator approval at execution time.

---

## Execution path

| Option | Description | Selected |
|--------|-------------|----------|
| Claude drives via write-scoped doctl | Operator provisions write token; approval gate before power-off | ✓ |
| You run it in DO Console | Claude writes runbook; operator executes | |
| Decide at execution time | Plan both paths | |

**User's choice:** Claude drives via write-scoped doctl.
**Notes:** Operator to provision a write token (current is read-only).

---

## Metabase gating (follow-up to slug)

| Option | Description | Selected |
|--------|-------------|----------|
| Gate Metabase → target s-1vcpu-2gb | Stop Metabase by default (reversible); ~$12/mo; profile peak first | ✓ |
| Keep Metabase always-on → s-2vcpu-4gb | No container changes; ~$24/mo | |
| Profile first, pick lightest that fits | Crawl with docker stats both states | |

**User's choice:** Gate Metabase → target s-1vcpu-2gb (~$12/mo).
**Notes:** Metabase (1.6 GiB) is the binding RAM constraint; gating it on-demand (Playwright pattern) unlocks the 2 GB slug. Pre-resize RAM profile confirms peak fits; fallback to s-2vcpu-4gb if not.

---

## Historical data storage

| Option | Description | Selected |
|--------|-------------|----------|
| Defer — note for its own phase | Out of droplet-resize scope; separate cost lever | ✓ |
| Fold a quick assessment into Phase 25 | Read-only DB sizing note this phase | |

**User's choice:** Defer — note for its own phase.
**Notes:** Managed-Postgres ~49 GB simple_history bloat is external to the droplet; revisit as a dedicated retention/cleanup phase (revives D-03).

---

## Claude's Discretion

- Exact crawl page count (within N≥200), `docker stats` capture method, and ordering of Metabase gate-off vs profiling crawl — left to planner, honoring D-03 and D-05.

## Deferred Ideas

- Managed-Postgres retention + `simple_history` ~49 GB cleanup — separate cost lever, own phase.
- Dedicated rotatable Oxylabs sub-user (currently borrowing cohort-tracker creds) — open TODO.
