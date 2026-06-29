# Requirements — Milestone v4.0: Hemnet Price-Scraper Droplet — Audit, Consolidate & Right-size

**Defined:** 2026-06-29
**Scope:** The standalone Hemnet+Booli price-scraper droplet `170.64.181.89` (`ubuntu-s-1vcpu-2gb-syd1-01`, syd1; repo `github.com/tt7676/hem-bol-scrapers`). Infrastructure/ops milestone — most work is droplet ops + the team repo, not this repo's source.

**Approach:** clean-up & resize **in place** (not rebuild); **audit-before-kill**.

> Prior milestone (v3.1 sold-match productionization) requirements are preserved in git history and traced in `MILESTONES`/PROJECT history.

---

## v4.0 Requirements

### Consistent access (ACCESS)
- [ ] **ACCESS-01**: Operator has durable SSH access to the droplet that survives reboots (key in `authorized_keys`, not a one-off console paste).
- [ ] **ACCESS-02**: A known SSH key is registered at the DigitalOcean account level so droplet rebuilds/recreations retain access.
- [ ] **ACCESS-03**: Access model is documented in a runbook — who has access, which key, how to add/revoke, and the `IdentitiesOnly` connection gotcha.

### Deep-dive audit (AUDIT)
- [ ] **AUDIT-01**: Every app on the droplet (`hemnet`, `booli`, `spotify`, `procore`, `block_inc`, `core`) is inventoried with purpose, owner, and last-active evidence.
- [ ] **AUDIT-02**: Data + storage are mapped — Postgres DB(s)/tables, Metabase, Redis, Docker volumes, and on-disk logs (incl. the 4.6 GB `kill.log` / 121 MB blocking log).
- [ ] **AUDIT-03**: All scheduled/triggered work is enumerated — Celery beat schedule, queues, restart scripts — with cadence.
- [ ] **AUDIT-04**: A real resource + cost baseline is captured (CPU/mem/disk actually used vs the `s-8vcpu-16gb` allocation) to inform right-sizing.
- [ ] **AUDIT-05**: For each non-Hemnet-price app (incl. Booli), a keep/kill recommendation backed by dependency evidence (what breaks if removed).

### Fix Hemnet capability (FETCH)
- [x] **FETCH-01**: The Hemnet listing/search fetch routes through the Oxylabs path (`apps/core/webscraper.py` / proxy creds) instead of direct local headless Chromium.
- [x] **FETCH-02**: On a verification run, the Hemnet pricing-page 403 block rate drops to ~0.
- [x] **FETCH-03**: Self-hosted Playwright / headless Chromium is retired (or gated off) once the Oxylabs path is proven, removing it as a resource driver.

### Cleanup (CLEAN) — gated on AUDIT
- [ ] **CLEAN-01**: Apps the audit clears as unused (spotify/procore/block_inc, and Booli if confirmed redundant) are removed/disabled.
- [ ] **CLEAN-02**: Oversized logs are rotated/removed and disk is reclaimed; the container set is reduced to the price-scraper essentials.
- [ ] **CLEAN-03**: End-state — the Hemnet price scraper is the primary workload running on the droplet.
- [ ] **CLEAN-04**: The Kinsing/`kdevtmpfsi` cryptominer is remediated in place — root-cause persistence removed, the entry vector closed (network/host-layer, no team-repo edit), and the per-minute `kill.sh` whack-a-mole retired — and the host is verified clean over an observation window. (Folded into Phase 24 by operator decision 2026-06-30; this is the standing prerequisite for porting Oxylabs creds back onto the box.)

### Right-size (SIZE)
- [ ] **SIZE-01**: The droplet is resized down to a slug matched to the post-cleanup footprint, reducing monthly cost from ~$100.
- [ ] **SIZE-02**: Post-resize verification confirms the price scraper still runs correctly (and reaches Hemnet via Oxylabs) at the smaller size.

---

## Out of Scope (v4.0)
- **Clean rebuild / migration to a fresh droplet** — operator chose in-place cleanup + resize. (Revisit only if the audit shows the box is unsalvageable.)
- **Consolidating onto the cohort-tracker droplet** — rejected; different stack, would destabilize a working production box. "One page" is a later data/reporting-layer concern, not this milestone.
- **Refactoring the team's scraper beyond the Oxylabs fetch switch** — feature work in `hem-bol-scrapers` stays with the team.
- **The other locked droplets** (`hemnetnews`, `snapshot-runner`, `Decade-Internal-Skill-Site`) — separate follow-up if needed.

## Traceability

| REQ | Phase |
|-----|-------|
| ACCESS-01, ACCESS-02, ACCESS-03 | 21 |
| AUDIT-01, AUDIT-02, AUDIT-03, AUDIT-04, AUDIT-05 | 22 |
| FETCH-01, FETCH-02, FETCH-03 | 23 |
| CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04 | 24 |
| SIZE-01, SIZE-02 | 25 |
