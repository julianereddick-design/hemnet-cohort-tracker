# Phase 16: Sold-match DB schema + persistence - Context

**Gathered:** 2026-06-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver the **persistence layer** for the sold-match pipeline:

1. **DB-01** — migrate three sold-side tables into the project Postgres (via the existing
   committed-Node-migration pattern, `migrate-*.js` over `db.js createClient`):
   a Booli-sold table, a Hemnet-`/salda` table, and a match/verdict table — carrying the
   enriched columns the Phase-15 parsers emit plus the `sold_in_advance` flag.
2. **DB-02** — add persist functions so the Phase-15 `lib/sold-*` modules write parsed
   seeds, sold cards, and match verdicts to the DB as the store of record.
3. **DB-03** — re-runs are idempotent: rows upsert by stable keys (booli_id / hemnet slug /
   pair) with no duplicate rows.

**Explicitly NOT this phase:** the config-driven segment runner, monthly rolling-window
orchestration, and the Phase-14 `adjudicatePair` wiring that actually fills verdicts — all of
that is **Phase 17**. Phase 16 designs the verdict table and the persist/upsert plumbing;
Phase 17 drives it. Also out: scheduling/reporting/suppression (v2-deferred).

</domain>

<decisions>
## Implementation Decisions

> These four were decided by Claude from the carried-forward data and house style (Julian
> delegated rather than quizzed — overnight-delegation pattern). None are recurring-cost
> decisions. Any can be reversed in planning by saying so.

### Upsert keys & duplicate-row policy (DB-03)
- **D-01:** **One row per sold record — do NOT replicate the `booli_listing` multi-row
  time-series pattern.** A sold record is a terminal event, not a view stream.
  - `booli_sold`: natural key **`booli_id` (BIGINT)**, `UNIQUE(booli_id)`, persist via
    `INSERT … ON CONFLICT (booli_id) DO UPDATE` (re-fetch refreshes enriched fields).
  - `hemnet_sold`: natural key **`hemnet_slug` (TEXT)** (the `/salda` SaleCard identifier),
    `UNIQUE(hemnet_slug)`, `ON CONFLICT (hemnet_slug) DO UPDATE`. This table is the deduped
    store of Hemnet sold listings; *which Booli search surfaced a card* is the match table's
    job, not a column here.
  - match/verdict: keyed on **`booli_id`** (one current verdict per Booli sold record),
    `UNIQUE(booli_id)`, `ON CONFLICT (booli_id) DO UPDATE` → re-adjudicating an overlapping
    window upserts, never duplicates. `matched_hemnet_slug` is **nullable** (null for
    Booli-only / uncertain).
- **D-02:** Deed transfers (`is_title_transfer = true`) are **stored in `booli_sold`** (retained
  per the v3.0 rule) but are **excluded from the match table** — no verdict row is written for
  them (they never enter adjudication). Mirrors the Phase-15 detail-scope gate.

### Spend tally: file vs DB + CR-01 (D-07 deferred call, now due)
- **D-03:** **Move the spend tally into the DB with an atomic increment**, behind a pluggable
  interface. The DB-backed path uses an atomic `UPDATE … SET calls = calls + 1 … RETURNING calls`
  (or insert-per-call + count) inside a transaction, which **closes CR-01** (the non-atomic
  `_spend.json` race) properly for Phase 17's concurrent drivers — exactly the moment D-07
  earmarked. Keep the **file-based `_spend.json` as a fallback** for offline / no-DB runs
  (recon, smoke, the verf-soldspike dumps) so `lib/sold-transport` still loads and runs without
  a DB. Net: DB ceiling when a client is available, file ceiling otherwise — and the
  `harden-spend-ceiling` todo's CR-01 is resolved by the DB path rather than a file mutex.

### JSONL cache role (DB-02)
- **D-04:** **DB is the store of record; JSONL stays as a raw landing/cache + resume layer.**
  The fetchers keep writing `verf-soldspike/**.jsonl` as they page (cheap, offline-friendly,
  and the existing idempotent-resume mechanism — a ceiling stop resumes from JSONL without
  re-fetching). A **persist step upserts JSONL → DB**. DB-02 ("replace the DB-free JSON output")
  is satisfied because the *queryable output of record* becomes the DB; JSONL is demoted to an
  internal transient cache, not something downstream consumers read. We do **not** rip out JSONL
  (that would lose cheap resume and the offline recon dumps).

### Match/verdict table shape (forward-design for Phase 17)
- **D-05:** **New sold-specific verdict table** (do NOT reuse `cohort_pairs` / `spotcheck_*` —
  different domain: terminal sold events vs active-listing cohort pairs), but **mirror the
  Phase-14 verdict vocabulary** so reporting stays uniform. Shape (planner refines exact
  columns):
  `id SERIAL PK, booli_id BIGINT UNIQUE, matched_hemnet_slug TEXT NULL, verdict TEXT
  (matched | booli_only | uncertain), match_method TEXT (fee_exact | address_key), evidence JSONB
  (agreeing signals, fee/floor/area/price deltas, matched hemnet slug), segment TEXT,
  window_start DATE, window_end DATE, adjudicated_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()`.
  Evidence as **JSONB** for flexibility (Phase 17 fills it from `adjudicatePair`). Designed now,
  populated in Phase 17.

### Claude's Discretion
- **Exact column lists** for `booli_sold` / `hemnet_sold` come from the Phase-15 parser output
  contract (`lib/sold-parse.js` snake_case fields) — planner maps each parsed field to a column.
  Types follow house style: `BIGINT` for ids, `TEXT` for strings, `NUMERIC`/`INTEGER` for
  prices/areas, `DATE` for sold dates, `TIMESTAMPTZ` for audit stamps, `BOOLEAN` for
  `is_title_transfer` / `sold_in_advance`.
- **Migration mechanics:** committed re-runnable Node script(s) (`CREATE TABLE IF NOT EXISTS`,
  idempotent DDL, `createClient`), one per concern or a single `migrate-sold-*.js` — planner's call.
- **Where the migration runs** (local-with-IP-whitelist vs droplet-via-SSH) is an **execution-time
  ops detail**, not a schema decision — settle at execution. Direct `pg` reachability from this
  machine is currently unverified (the prod-read probe was correctly gated); confirm before the
  execute step, whitelist the local IP via `doctl` if refused, or run the migration on the droplet
  (IP already whitelisted). See [[project_ip_whitelist]], [[project_droplet_no_psql]].

### Folded Todos
- **`harden-spend-ceiling-concurrency.md`** (matched 0.4) — folded via **D-03**. CR-01 (non-atomic
  `_spend.json` counter) is resolved by moving the tally into the DB with an atomic increment,
  which is exactly when Phase 17's concurrent drivers need it. WR-05 within that todo was already
  fixed standalone in Phase 15 (commit `a5a25b2`). The early-stop warnings (WR-01..03) remain a
  separate lib-correctness cleanup, not blocking Phase 16 schema work.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & scope
- `.planning/REQUIREMENTS.md` — DB-01, DB-02, DB-03 (this phase) + traceability table.
- `.planning/ROADMAP.md` §"Phase 16" — goal + success criteria; §"Phase 17" — what consumes
  this layer (don't over-build into 17).

### Phase-15 outputs this phase persists
- `lib/sold-parse.js` — **column source of truth**: `parseBooliSoldCards`,
  `parseBooliSoldDetail` (rent, operating_cost, construction_year, agent_id, agency_id,
  tenure/housing_form, sold_in_advance), `parseHemnetSaleCards`. Snake_case field names map
  1:1 to columns.
- `lib/sold-config.js` — `isTitleTransfer` / `Lagfart` classification, segments.
- `lib/sold-transport.js` — current file-based `MAX_OXY_CALLS` + `_spend.json` ceiling (the
  thing D-03 makes DB-backed-with-file-fallback).
- `lib/sold-fetch-booli.js`, `lib/sold-fetch-hemnet.js` — emit the JSONL the persist step reads.
- `.planning/phases/15-sold-data-ingestion-library/15-SOLD-IN-ADVANCE-RECON.md` — `sold_in_advance`
  source (`SoldProperty.soldAsUpcomingSale`, detail-only) + the escalate-except-deed-transfers policy.
- `.planning/phases/15-sold-data-ingestion-library/15-REVIEW.md` — CR-01 + WR cluster detail.

### DB / migration house style (analogs to copy)
- `db.js` — `createClient()` (`DB_HOST/PORT/USER/PASSWORD/NAME` + SSL from `.env`).
- `migrate-spotcheck-phase13.js` — DDL house style: `CREATE TABLE IF NOT EXISTS`, `SERIAL` PK,
  `BIGINT` ids, `TIMESTAMPTZ`, `UNIQUE(...)` for idempotency.
- `migrate-booli-listing-add-fields.js`, `migrate-cohort-pairs-soft-delete.js` — further migration patterns.

### Durable schema reference (memory, not a repo file)
- Memory `reference_booli_hemnet_sold_schema` — validated Booli `/slutpriser` `SoldProperty` /
  Hemnet `/salda` `SaleCard` shapes, title-transfer signal, matching gotchas.
- Memory `project_booli_listing_duplicate_rows` — why `booli_listing` is multi-row (the trap D-01 avoids).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `db.js createClient()` — every migration + persist function opens its client this way; pass the
  caller's client into persist exports (the Phase-13 store pattern: exports take the client as first arg).
- `migrate-*.js` scripts — direct template for the sold migration(s).
- Phase-15 `lib/sold-parse.js` output — already snake_case, already the DB contract.

### Established Patterns
- **Committed Node migrations**, run manually via `createClient` (droplet has no psql —
  [[project_droplet_no_psql]]). Idempotent `IF NOT EXISTS` DDL.
- **Persist exports take the pg client as first arg** (no module-level DB connection) — mirrors
  Phase-13 review-store design; keeps offline smoke paths DB-free.
- **Parameterized SQL only** (`$1,$2,…`) — no string interpolation (Phase-13 security pattern).
- **`removed_at IS NULL` soft-delete** convention exists for cohort data; sold records are
  immutable events so likely not needed — planner decides if a soft-delete column is warranted.

### Integration Points
- Phase-15 fetchers (`lib/sold-fetch-*.js`) → new persist functions → Postgres.
- `lib/sold-transport.js` spend tally → new DB-backed ceiling (D-03), file fallback retained.
- Verdict table is the seam Phase 17's `adjudicatePair` wiring writes into.

</code_context>

<specifics>
## Specific Ideas

- Verdict vocabulary should stay legible against Phase-14's (matched / uncertain / mismatch →
  here matched / booli_only / uncertain) so a future unified sold+cohort report doesn't need a
  translation layer.
- The whole point of the sold-match thesis is surfacing **genuine non-Hemnet Booli presence**
  (~36% of villa solds per the spike) — the `booli_only` verdict is a first-class outcome, not an
  error state; the schema treats it as a normal verdict with `matched_hemnet_slug = null`.

</specifics>

<deferred>
## Deferred Ideas

- **Moving the for-sale-side spend tally to the DB** — D-03 covers the *sold* transport; whether
  the for-sale jobs' spend accounting also migrates to the DB is a separate cleanup, not in scope.
- **Early-stop / pagination lib cleanups (WR-01..03 from 15-REVIEW)** — lib-correctness polish,
  track separately; not schema work.

### Reviewed Todos (not folded)
- **`classify-fetch-outcomes-delisted-vs-error.md`** (matched 0.2) — about the *cohort spotcheck
  gate's* delisted-vs-transient-error routing, a different subsystem from sold-match persistence.
  Reviewed and **not folded**; stays in its own backlog.

</deferred>

---

*Phase: 16-sold-match-db-schema-persistence*
*Context gathered: 2026-06-17*
