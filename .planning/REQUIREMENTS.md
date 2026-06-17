# Requirements: Hemnet Cohort Tracker — Milestone v3.0 Sold-match pipeline

**Defined:** 2026-06-17
**Core Value:** Quantify how much sold-property data Booli holds beyond Hemnet's public `/salda` index, per segment, by matching Booli `/slutpriser` records to Hemnet `/salda` — productionized from the `spike/sold-match-feasibility` spike into a reusable, database-backed pipeline.

**Milestone goal:** Rebuild the sold-match spike into reusable `lib/` modules with DB persistence, config-driven segments, and a monthly rolling-window run mode — runnable manually. Scheduling, reporting, and the listing-stage suppression test are explicitly deferred.

## v1 Requirements (Milestone v3.0)

Requirements for this milestone. Each maps to exactly one roadmap phase (15+).

### Sold ingestion (SOLD)

- [ ] **SOLD-01**: Pipeline fetches Booli `/slutpriser` sold records for a configured segment (municipality + objectType) and rolling sold-date window, with pagination and a sold-date early-stop.
- [ ] **SOLD-02**: Pipeline classifies each Booli sold record's `soldPriceType` and excludes deed transfers (`Lagfart` / `isTitleTransfer`) from the match set while retaining them in the DB.
- [ ] **SOLD-03**: Pipeline captures enriched Booli sold attributes from the SoldProperty node/detail — broker/agency id, operating cost, construction year, tenure form, rooms, living area, floor, coordinates, `soldPriceType`, and fee/rent (when available).
- [ ] **SOLD-04**: Pipeline detects and persists a "sold in advance" (sold before viewing / pre-market) flag as a distinct attribute, after a recon step confirms where Booli encodes it.
- [ ] **SOLD-05**: Pipeline fetches Hemnet `/salda` sold cards for each Booli property via per-property search (reusing the cohort search pattern), with pagination and sold-date early-stop, parsing `SaleCard` fields without a detail fetch.

### Matching (MATCH)

- [ ] **MATCH-01**: Each non-deed-transfer Booli sold record is adjudicated against Hemnet `/salda` candidates using fee-exact precision (apartments) / address-key (villas), reusing the Phase-14 `adjudicatePair` logic.
- [ ] **MATCH-02**: Address normalization (`normAddr` v2) handles the spike-recovered false-negative formats (space-before-unit-letter, dual `X / Y`, ` och `, Booli-truncated number).
- [ ] **MATCH-03**: Apartment matches are confirmed only within the fee-available window (~≤6–9 months back); house matches use the unique address key at any age.
- [ ] **MATCH-04**: Each Booli record receives a persisted match verdict (matched / Booli-only / uncertain) with the supporting evidence (matched Hemnet slug, agreeing signals).

### Persistence (DB)

- [ ] **DB-01**: Sold-side schema is migrated into the project DB — a Booli-sold table, a Hemnet-`/salda` table, and a match/verdict table (with the enriched columns and `sold_in_advance` flag).
- [ ] **DB-02**: Pipeline persists seeds, sold cards, and match verdicts to the DB, replacing the spike's DB-free JSON output.
- [ ] **DB-03**: Re-runs are idempotent — sold records, Hemnet cards, and match rows upsert by stable keys (booli_id / hemnet slug / pair) without duplicate rows.

### Config & robustness (CONFIG)

- [ ] **CONFIG-01**: Segments are configuration (municipality + objectType), seeded with the two validated spike segments (Stockholm apartments, Täby villas) and expandable without code changes.
- [ ] **CONFIG-02**: A run accepts rolling-window parameters (min/max sold date) defaulting to a monthly window, and is runnable manually end-to-end (Booli seed → Hemnet search → adjudicate → persist).
- [ ] **CONFIG-03**: Pipeline enforces an Oxylabs spend ceiling (`MAX_OXY_CALLS`, persisted spend tally) and retries transient Oxylabs 613 errors in the main path (not just probes).

## v2 Requirements (deferred to future milestones)

### Scheduling (SCHED)

- **SCHED-01**: Production cron job on the droplet runs the sold-match pipeline on a monthly cadence.

### Reporting (REPORT)

- **REPORT-01**: Overlap metric (Booli sold pool vs Hemnet `/salda`) per segment over time, surfaced like existing reports.
- **REPORT-02**: Non-Hemnet villa-presence metric exposed as a consumable output.

### Suppression (SUPPRESS)

- **SUPPRESS-01**: Listing-stage suppression test — track Hemnet for-sale villa listings → which appear on `/salda` after selling (Hemnet's own suppression rate, Booli-independent).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Production cron scheduling | Deferred — milestone is "rebuild properly + DB, then decide next steps"; run manually for now (v2: SCHED). |
| Slack / reporting output | Deferred — productionize the data layer first; reporting is a separate product surface (v2: REPORT). |
| Listing-stage suppression test | Different method (for-sale → sold tracking), not Booli-vs-Hemnet sold matching; likely its own milestone (v2: SUPPRESS). |
| Apartment matching >9 months back | Booli strips fee/broker on records older than ~9 months; no unit signal remains (no sold photos), so confirmation is infeasible — design limit, not a bug. |
| dHash / vision image matching on sold pages | Sold detail pages carry no gallery images on either platform; the Phase-14 image path does not apply to sold-match. |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SOLD-01 | TBD | Pending |
| SOLD-02 | TBD | Pending |
| SOLD-03 | TBD | Pending |
| SOLD-04 | TBD | Pending |
| SOLD-05 | TBD | Pending |
| MATCH-01 | TBD | Pending |
| MATCH-02 | TBD | Pending |
| MATCH-03 | TBD | Pending |
| MATCH-04 | TBD | Pending |
| DB-01 | TBD | Pending |
| DB-02 | TBD | Pending |
| DB-03 | TBD | Pending |
| CONFIG-01 | TBD | Pending |
| CONFIG-02 | TBD | Pending |
| CONFIG-03 | TBD | Pending |

**Coverage:**
- v1 requirements: 15 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 15 ⚠️

---
*Requirements defined: 2026-06-17*
*Last updated: 2026-06-17 after milestone v3.0 definition*
