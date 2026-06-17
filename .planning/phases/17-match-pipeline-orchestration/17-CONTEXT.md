# Phase 17: Match pipeline orchestration - Context

**Gathered:** 2026-06-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Build ONE config-driven, manually-runnable end-to-end runner that, per configured segment (municipality + objectType) and a rolling sold-date window, executes: **Booli seed → persist booli_sold → Hemnet `/salda` search per record → adjudicate (Phase-14 `adjudicatePair`) → persist verdict to `sold_match`**. It replaces the throwaway `scripts/spike-hemnet-match.js` (file-JSONL, hard-coded 2 segments) with a clean runner writing to the Phase-16 DB.

**In scope:** the runner, segment config-as-data, rolling-window params, the per-record match→adjudicate→persist loop honoring fee-exact (apartments, within fee window) vs address-key (villas), and a per-segment run summary.
**Out of scope (deferred):** the Booli-only recall pass (genuine-bypass vs match-miss labeling), photo/dHash enrichment (sold pages have no galleries), county expansion, and any scheduling/cron automation (this phase is manual-run only).
</domain>

<decisions>
## Implementation Decisions

### Segment configuration (CONFIG-01)
- **D-01 (LOCKED):** Segments live in a **JSON config file** (e.g. `config/sold-segments.json`) that the runner reads — adding a segment is a data edit, not a code change. Migrate the current `SEGMENTS` const out of `lib/sold-config.js` into this file (seed it with `stockholm-apt` + `taby-villa`, preserving the exact `{label, family, booli:{areaIds,objectType}, hemnet:{locationId,itemType}}` shape). Booli `areaIds` and Hemnet `locationId` are still entered by hand per segment (no dynamic resolver required this phase). Keep one loader so both the runner and any CLI wrappers read the same source.

### Rolling window (CONFIG-02)
- **D-02 (LOCKED):** A default run processes **one month** — the most-recent ~30-day sold window ending at the existing 90-day read-time-exclude boundary (`READ_TIME_EXCLUDE_DAYS`), so apartment fee data is still present. `--min-sold-date` / `--max-sold-date` override the window. Sweeping history = re-run with shifted dates (no multi-month loop in a single invocation).

### Booli-only handling (MATCH-04)
- **D-03 (LOCKED):** **Defer the recall pass.** The runner emits `verdict = booli_only` for non-matched records **without** the second loose-recall search (genuine-bypass vs our-search-missed-it). Rationale: the success criteria don't require recall, the genuine-bypass rate was already manually validated in the spike (0/25 on Hemnet), and recall adds material recurring Oxylabs cost. Recall is its own future phase. → see Deferred.

### Run output
- **D-04 (LOCKED):** On completion, persist verdicts to `sold_match` **and print a per-segment run summary**: records adjudicated, matched / booli_only / uncertain counts, match rate, and Oxylabs calls spent. No per-run REPORT.md file (manual tool — keep artifacts lean).

### Claude's Discretion (settled from the codebase scout + spike findings — planner may refine)
- **D-05 Adjudicator inputs:** Sold pages have no galleries, so call `adjudicatePair(record, {})` with `photos: { hemnet_gallery: [], booli_gallery: [] }` and **no dHash/vision**. Verdicts rest purely on unit-level signals: **fee-exact** (apartments, within the fee-available window) and **address + price + area** (houses) — matching the spike and MATCH-01/03.
- **D-06 Apartment fee window:** Reuse the existing `fetchBooliSold` detail gate (`detailScope='fee-window'`) for apartment `rent`; **RESEARCH NEEDED** — the scout reported the gate fetches detail for apartments "sold >270 days ago," which looks inverted vs the ≤~6–9mo fee-available window. The researcher must confirm the actual boundary in `lib/sold-fetch-booli.js` and ensure apartments are fee-confirmable only where fee data exists.
- **D-07 Hemnet persistence:** Persist the **matched** Hemnet card via `upsertHemnetSold` so `sold_match.matched_hemnet_slug` references a real `hemnet_sold` row; do not persist non-matched candidates (lean). Revisit only if evidence needs the full candidate set.
- **D-08 Verdict mapping:** Map `adjudicatePair` output → `sold_match`: `CONFIRMED_MATCH`→`matched`; no same-address candidate OR `CONFIRMED_MISMATCH`→`booli_only`; `UNCERTAIN`→`uncertain`. `match_method` from the adjudicator `source`: `fee_exact` (apt) / `address_key` (house). `evidence` (JSONB) = signals + deltas + matched-card brief + window dates. Planner to finalize exact field assembly against `persistVerdictForRecord`'s expected verdict shape.
- **D-09 Spend ceiling:** Runner calls `setSpendClient(pgClient)` **once at start** to use the Phase-16 DB-atomic ceiling (`MAX_OXY_CALLS` default 4000). Reuse the spike's bounded worker pool (~6 concurrent) with `CeilingError` early-stop.
- **D-10 Orchestration entry point:** New runner script (suggested `scripts/sold-match-run.js`) over the lib modules; honor the `SCRAPE_FORCE_OXYLABS=1` set-before-require invariant.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` — Phase 17 section (goal + 4 success criteria)
- `.planning/REQUIREMENTS.md` — MATCH-01, MATCH-03, MATCH-04, CONFIG-01, CONFIG-02

### Reusable building blocks (wire together; do not re-implement)
- `lib/spotcheck-adjudicate.js` — `adjudicatePair(record, {visionResult?, dhashResult?})` → `{verdict, source, reason, signals, challenge?}`; caller-agnostic (no apt/house branching inside)
- `lib/sold-fetch-booli.js` — `fetchBooliSold(segKey, seg, opts)` (writes seed JSONL) + `fetchBooliSoldPage(...)` (in-memory `{cards, meta}`); implements the D-01 detail gate
- `lib/sold-fetch-hemnet.js` — `searchSoldPaged(booli, seg, windowDays, maxPages, opts)` → `{cards, pages, complete, stopReason?}`; `buildHemnetSoldUrl`, `searchOptsFor(seg)`
- `lib/sold-store.js` — `upsertBooliSold`, `upsertHemnetSold`, `upsertSoldVerdict`, `persistVerdictForRecord(client, record, verdict)` (D-02 title-transfer gate)
- `lib/sold-config.js` — `SEGMENTS` (to migrate to JSON), `isTitleTransfer`, `daysAgoISO`, window/agreement constants
- `lib/sold-transport.js` — `setSpendClient`, `cachedFetch`, `remainingCalls`/`Async`, `CeilingError`, `SCRAPE_FORCE_OXYLABS` invariant
- `scripts/spike-hemnet-match.js` — the throwaway orchestrator being replaced; mirror its match loop (`matchOne` → addr candidates → pickBest → adjudicate), drop the recall pass per D-03

### Prior-phase summaries
- `.planning/phases/15-sold-data-ingestion-library/15-*-SUMMARY.md`
- `.planning/phases/16-sold-match-db-schema-persistence/16-0*-SUMMARY.md` + `16-VERIFICATION.md`
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The entire seed→search→adjudicate→persist chain already exists as separate functions (see canonical refs). Phase 17 is primarily orchestration + verdict-shape assembly + config-as-data, not new algorithms.

### Established Patterns
- Segments-as-data: today a const map keyed by segKey; D-01 moves it to JSON with the same shape.
- Spend safety: file-based tally in the spike; Phase 16 added DB-atomic tally — wire via `setSpendClient` (D-09).
- D-02 title-transfer gate is enforced in `persistVerdictForRecord` — deed transfers never reach `sold_match`.

### Integration Points
- Live prod schema already applied (Phase 16): `booli_sold` / `hemnet_sold` / `sold_match` / `sold_spend` exist (empty). Phase 17 deploy is a plain `git pull` on the droplet — no migration step.
- Runner opens its own pg client via `db.js createClient()` and passes it to both the store upserts and `setSpendClient`.
</code_context>

<specifics>
## Specific Ideas

- Mirror the spike's `matchOne` flow but persist to DB instead of `verf-soldspike/match/*.results.jsonl`.
- Seed two validated segments first (Stockholm apartments, Täby villas), then prove a third can be added by editing only the JSON config (CONFIG-01 acceptance).
</specifics>

<deferred>
## Deferred Ideas

- **Booli-only recall pass** — second loose-recall search per booli_only record to label genuine-bypass vs match-miss with evidence. Its own future phase (recurring Oxylabs cost; spike already hand-validated the rate).
- **Listing-stage funnel / Hemnet suppression-rate tracking** — track for-sale Hemnet villa listings → which appear on `/salda` after selling. Different method; not this milestone.
- **County expansion (Norrbotten / Dalarna)** — separate queued GSD phase (already tracked).
- **Photo/dHash/vision enrichment** — N/A for sold pages (no galleries); do not pursue here.
- **Scheduling/cron automation** of the runner — Phase 17 is manual-run only; automation is a later concern.
</deferred>
