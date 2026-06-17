# Phase 15: Sold-data ingestion library - Context

**Gathered:** 2026-06-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the validated `spike/sold-match-feasibility` DB-free fetch/parse scripts into reusable `lib/` modules that fetch and parse **both sides** of the sold-match:
- **Booli `/slutpriser`** seeds — paginated, sold-date early-stop, enriched attributes, `soldPriceType` classification (`Lagfart` excluded-from-matching but retained), and a **"sold in advance" flag**.
- **Per-property Hemnet `/salda` `SaleCard` search** — reusing the cohort search pattern, paginated, sold-date early-stop, no per-card detail fetch.

…all under the main fetch path's `MAX_OXY_CALLS` ceiling and a transient-613 retry, with `normAddr` v2 recovering the spike's known false-negative address formats.

**Explicitly NOT this phase:** DB schema / persistence (Phase 16), the config-driven segment runner + monthly rolling-window orchestration + adjudication wiring (Phase 17), scheduling/reporting/suppression (deferred to v2).
</domain>

<decisions>
## Implementation Decisions

### Detail-fetch policy (cost vs completeness)
- **D-01:** Detail fetching is **recon-gated, prefer cheaper**. Phase 15's FIRST task is the "sold in advance" recon (see D-04); where the signal + enriched fields actually live decides the policy:
  - **Default (and the case if "sold in advance" is card-level / free):** fetch the Booli `/bostad/<id>` detail page **only for apartments within the fee window** — the one case where detail (the `rent`/fee signal) changes a *match* outcome. Villas match on address, so they stay **card-only**; their enriched detail-only fields (broker/agency, operating cost, construction year, tenure form) stay `null` by default.
  - **If "sold in advance" proves detail-only:** escalating to fetch detail for **all** market records (which would also yield full enrichment everywhere) is allowed **only after Julian re-confirms the spend** — recurring/elevated Oxylabs cost stays his call. Do NOT silently 2× the per-segment call count.
- **D-02:** Card-level Booli parse already captures the cheap enriched fields for every record (object type, sold price, sold date, `soldPriceType`, municipality, descriptive area, living area, rooms, floor, lat/long) — capture all of these for all records regardless of the detail policy (they're free).

### "Sold in advance" detection
- **D-03:** **Best-effort, never block.** Set the `sold_in_advance` flag when a reliable signal exists *within what the detail-fetch policy already pays for*; otherwise leave it `null`/unknown. The phase never blocks on this flag.
- **D-04:** **Recon first.** Where Booli encodes "sold in advance" (sold before viewing / förhandsförsäljning) is currently unknown — the spike recon (`spike-sold-recon.js` keyword scan) never looked for it. A short recon task must confirm the location (card field vs detail field vs a badge/typename vs a `soldPriceType`-adjacent value vs nowhere) and document the finding. Julian's hunch: it sits on the **full detail page**. The recon outcome feeds D-01.

### Module layout — Claude's Discretion
- **D-05:** Julian said "you decide." Recommended direction (planner may refine exact filenames): **new `lib/sold-*.js` modules** (e.g. `lib/sold-parse.js`, `lib/sold-fetch.js` or split Booli/Hemnet, `lib/sold-config.js`) kept **separate** from the for-sale fetchers — the sold side uses distinct Apollo queries (`searchSold` / `searchSales`) and node shapes (`SoldProperty` / `SaleCard`), so folding them into `lib/booli-fetch.js` / `lib/hemnet-fetch.js` would bloat those modules. Reuse the shared `lib/scrape-http.js` transport (do NOT duplicate it).

### Spike-script disposition — Claude's Discretion
- **D-06:** Julian said "happy for you to decide, but go through and review the code and clean up as needed." Recommended: convert `scripts/spike-*.js` into **thin CLI wrappers** over the new `lib/` modules (preserves the runnable manual entry points and the `verf-soldspike/` disk cache), and during the move **review + clean up** dead/duplicated/spike-only scaffolding. Deleting a spike script is fine once its logic fully lives in `lib/` and a wrapper or production CLI replaces it.

### Spend ceiling / robustness — Claude's Discretion (not discussed)
- **D-07:** Keep the **file-based** ceiling (`MAX_OXY_CALLS` + `_spend.json`) from `spike-common.js` for Phase 15; revisit moving the spend tally into the DB when the DB lands in **Phase 16**. Add the transient **Oxylabs 613 retry** to the main fetch path (per CONFIG-03; spike only had retry in probes — confirm whether `lib/scrape-http.js getWithRetry` already covers 613 and extend if not).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope
- `.planning/REQUIREMENTS.md` — SOLD-01..05, MATCH-02, CONFIG-03 (this phase's requirements) + Out-of-Scope table.
- `.planning/ROADMAP.md` — Phase 15 section (goal + 5 success criteria).
- `.planning/PROJECT.md` — milestone v3.0 goal + spike findings that anchor it.

### Spike source to productionize (the core of this phase)
- `scripts/spike-sold-parse.js` — pure parsers: `parseBooliSoldCards` (card/free), `parseBooliSoldDetail` (detail-only enriched: rent, operating_cost, construction_year, agent_id, agency_id, tenure_form), `parseHemnetSaleCards` (rich, no detail fetch), `parseSweNum`, `booliSoldMeta`, `hemnetSalesMeta`.
- `scripts/spike-booli-sold.js` — paginated Booli seed fetch with resume/idempotency, `--market-target` early-stop, title-transfer flagging.
- `scripts/spike-hemnet-match.js` — per-property `/salda` search **and `normAddr` v2** (the address normalizer for MATCH-02 lives here).
- `scripts/spike-common.js` — `cachedFetch` (file-based `MAX_OXY_CALLS` ceiling + `_spend.json`), `extractApollo`, `assertOxyUsed` transport guard, JSONL/JSON helpers, `CeilingError`.
- `scripts/spike-config.js` — `SEGMENTS` (Stockholm apt / Täby villa, both portal IDs), `isTitleTransfer`, `MARKET_SOLD_TYPES`, agreement thresholds, `daysAgoISO`.
- `scripts/spike-sold-recon.js` — Stage-0 recon harness (typename histogram, `keywordScan`, root-query field dump) — extend its keyword set for the "sold in advance" recon (D-04).

### Shared infrastructure (reuse, do not duplicate)
- `lib/scrape-http.js` — `getWithRetry`, `extractNextData`, `getOxylabsStats`; `SCRAPE_FORCE_OXYLABS` flag (must be set BEFORE require).
- `lib/booli-fetch.js`, `lib/hemnet-fetch.js` — existing for-sale fetchers (reference for conventions; sold logic stays separate per D-05).
- `lib/hemnet-locations.json` — muni→Hemnet location_id map. `lib/booli-to-hemnet-mapping.js` — `booliObjectTypeToHemnet` item-type mapping (Täby villa sets item_type per-record).

### Durable schema reference (memory — not a repo file)
- Memory `reference_booli_hemnet_sold_schema` — validated SOLD-page schema (Booli `/slutpriser` `areaIds`/`SoldProperty`, Hemnet `/salda` `SaleCard`, title-transfer signal, area IDs, matching gotchas). Mirrors the parsers above.
- `verf-soldspike/` and `verf-soldspike-12mo/` — recon dumps (`recon/*.apollo.json`), `REPORT.md`, seed/match JSONL from the spike runs.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`spike-sold-parse.js` parsers** — pure, already-correct against the live Apollo shapes; lift into `lib/sold-parse.js` largely as-is. Card parsers are free; `parseBooliSoldDetail` requires a per-record detail fetch (the cost lever in D-01).
- **`spike-common.cachedFetch`** — disk cache + global persisted `MAX_OXY_CALLS` ceiling + `CeilingError`; the spend/ceiling model to carry into the lib transport.
- **`spike-common.assertOxyUsed`** — hard transport guard (sold is 100% Oxylabs on both platforms); keep it as a runtime invariant.
- **`normAddr` v2** in `spike-hemnet-match.js` — splits on `,` `/` ` och `, merges "21 E"→"21E", handles Booli-truncated numbers; this is MATCH-02, move it into the lib and unit-test the recovered formats.

### Established Patterns
- **`__NEXT_DATA__` → `props.pageProps.__APOLLO_STATE__`** extraction via `lib/scrape-http.js extractNextData` is the project-wide scrape idiom (Phases 6–11). Sold reuses it.
- **Forced Oxylabs**: callers set `process.env.SCRAPE_FORCE_OXYLABS = '1'` BEFORE requiring the transport. Sold must keep this (Hemnet + Booli sold are both Oxylabs-only).
- **Idempotent/resumable JSONL seeds** (`spike-booli-sold.js`) — the Phase-15 fetch contract; Phase 16 swaps JSONL persistence for the DB.

### Integration Points
- Output record shapes (snake_case, from the parsers) become the contract the **Phase 16** schema is built around — keep them stable and DB-friendly.
- The lib fetch/parse functions are what the **Phase 17** segment runner orchestrates (per-segment, rolling window, adjudicate).
- `lib/scrape-http.js` is the shared transport — extend its retry for 613 there if not already covered, so the for-sale jobs benefit too.
</code_context>

<specifics>
## Specific Ideas

- Julian: "make sure we pick up the sold advance tab — I think it probably sits on the full page." → "sold in advance" is a real requirement, recon-driven, best-effort; he leans toward it being a detail-page field.
- Julian on cost: "recon decides, prefer cheaper" — don't pre-pay for all-records detail; let the recon prove necessity, and re-confirm spend before any 2× escalation.
- Julian on cleanup: explicitly wants the spike code reviewed and tidied during the move into `lib/`, not just copied.
</specifics>

<deferred>
## Deferred Ideas

- **Move the Oxylabs spend tally into the DB** — sensible once Phase 16 exists; file-based for now (D-07).
- **All-records Booli detail enrichment for villas** — only if "sold in advance" forces it AND spend re-confirmed (D-01); otherwise a possible later enrichment pass.
- DB schema/persistence → **Phase 16**. Segment runner, monthly rolling-window defaults, adjudication wiring → **Phase 17**. Scheduling, reporting/overlap metric, listing-stage suppression test → **v2 milestones**.

None of the above are in Phase 15 scope — discussion stayed within the ingestion-library boundary.
</deferred>

---

*Phase: 15-sold-data-ingestion-library*
*Context gathered: 2026-06-17*
