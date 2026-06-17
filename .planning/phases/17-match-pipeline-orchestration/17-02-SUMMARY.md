---
phase: 17-match-pipeline-orchestration
plan: 02
subsystem: sold-match-pipeline
tags: [orchestration, runner, config-driven, tdd, wave-2, match-pipeline]
requires:
  - config/sold-segments.json (17-01 — loadSegments reads this, not the SEGMENTS const)
  - lib/sold-fetch-booli.js (17-01 exports fetchBooliDetail + extractResidenceId)
  - lib/sold-fetch-hemnet.js (searchSoldPaged, searchOptsFor, booliSoldUnix)
  - lib/sold-store.js (upsertBooliSold, upsertHemnetSold, persistVerdictForRecord — D-02 gate)
  - lib/sold-transport.js (setSpendClient, CeilingError, remainingCalls, stdoutLogger)
  - lib/spotcheck-adjudicate.js (adjudicatePair — Phase-14 identity model)
  - lib/spotcheck-evidence.js (computeDeltas, pctDiff)
  - lib/sold-addr.js (normAddr — MATCH-02)
  - lib/sold-config.js (daysAgoISO, READ_TIME_EXCLUDE_DAYS, SOLD_DATE_WINDOW_DAYS, agreement consts)
provides:
  - scripts/sold-match-run.js (config-driven end-to-end runner — seed → search → adjudicate → persist + per-segment summary)
affects:
  - Phase 17 complete (2/2 plans) — closes MATCH-01/03/04 + CONFIG-02; CONFIG-01 closed by 17-01
  - operator (post-merge): live droplet run seeds booli_sold + populates sold_match for the first time
tech-stack:
  added: []
  patterns:
    - config-driven runner (loadSegments from JSON, rolling-window CLI args, segment loop)
    - deps-injection for offline TDD (matchOne accepts deps.searchSoldPaged / deps.fetchBooliDetail; smoke stubs them)
    - bounded worker pool with DB-atomic spend ceiling + CeilingError early-stop + remainingCalls drain guard
    - verdict-object assembly with plain-object evidence (store JSON.stringify's internally — Pitfall 4)
key-files:
  created:
    - scripts/sold-match-run.js
  modified: []
decisions:
  - "House confirmation uses the spike address-key shortcut (cands.length===1 && areaOk && priceOk → matched/address_key); villas NEVER route through fee-exact adjudication (OQ-2 resolved — routing through unmodified adjudicatePair yields ~0% for houses)"
  - "Apartment fee fetched INLINE via fetchBooliDetail in the match loop (D-06) — seed-time rent is null for the monthly window (gate is inverted); Pitfall 3"
  - "Recall pass dropped (D-03) — non-matched emits booli_only with no second loose search"
  - "matchOne returns the mapped verdict string so the worker pool tallies without re-reading the DB"
  - "matchOne takes an optional deps param so the offline --smoke injects stubbed search/detail (no network, no DB, mock pg client)"
metrics:
  duration: ~25 min
  completed: 2026-06-17
  tasks: 2
  files: 1
---

# Phase 17 Plan 02: Match Pipeline Runner Summary

**One-liner:** Built `scripts/sold-match-run.js` — the config-driven, manually-runnable end-to-end sold-match runner that loads segments from JSON, rolls a monthly sold-date window, seeds `booli_sold` page-by-page, searches Hemnet `/salda` per non-deed-transfer record, adjudicates apartments fee-exact (inline `fetchBooliDetail`) and villas address-key (spike shortcut), and persists a `matched`/`booli_only`/`uncertain` verdict with object evidence — under the Phase-16 DB-atomic spend ceiling with a bounded ~6-worker pool — replacing the throwaway `scripts/spike-hemnet-match.js`.

## What Was Built

One new file, `scripts/sold-match-run.js` (561 lines), assembling the existing Phase 15/16/17-01 building blocks into a single orchestration runner. No new algorithms — every matching primitive already existed; this wires them with three deliberate divergences from the spike (DB persist instead of JSONL, no recall pass per D-03, inline apartment fee per D-06).

**Task 1 — scaffold:**
- `loadSegments()` reads `config/sold-segments.json` (D-01; NOT the `SEGMENTS` const — Pitfall 7, grep gate enforces 0 `SEGMENTS`).
- `validateDate(s)` enforces `YYYY-MM-DD` format + `Date.parse` + ISO round-trip (rejects `2026-13-99`, `2026-02-30` rollovers — ASVS V5 / T-17-03). `parseArgs` runs both date args through it and throws a clear error BEFORE any fetch/query.
- `parseArgs(argv)` — `--segment`, `--limit`, `--conc` (default 6), `--min-sold-date`, `--max-sold-date`, `--smoke`; both `--flag value` and `--flag=value` forms.
- Default window (D-02/CONFIG-02): `maxSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS)` (~90d ago), `minSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS + 30)` (~120d ago).
- Helpers copied verbatim from the spike: `sleep`, `jitter`, `addrCandidates` (uses canonical `normAddr` from `lib/sold-addr` + `booliSoldUnix`), `pickBest` (date proximity then `pctDiff` tiebreak), `cardBrief` (null-safe), `deltasFor` (the booli↔hemnet `computeDeltas` mapping, postcode null).
- `seedSegment` — `fetchBooliSoldPage` page loop, `upsertBooliSold` per card with `{segment, family}`, non-title-transfer cards queued; respects `--limit`.
- `runSegment` — bounded worker pool: shared `idx` + `stopped` flag, tally from the `matchOne` return string, `remainingCalls() <= 40` drain guard, `CeilingError` early-stop, and the D-04 per-segment summary line (`adjudicated / matched / booli_only / uncertain / error / matchRate / oxylabsSpent / stoppedBy`).
- `main` — `createClient` + `connect` + `setSpendClient` BEFORE any fetch (D-09 / Pitfall 5), `try/finally client.end()`, segment selection (single `--segment` or all config keys), unknown-segment error.
- Offline `--smoke` guarded behind `!--smoke` for `main` (no DB connect in smoke).

**Task 2 — `matchOne`:**
- `searchSoldPaged` (deps-injectable) → `addrCandidates` → `pickBest` → `deltasFor`.
- Search error (non-Ceiling) → `booli_only` tagged `search-failed`; CeilingError re-throws to the worker.
- 0 candidates → `booli_only` (`no-address-candidate`), NO recall pass (D-03).
- **HOUSE:** `cands.length === 1 && areaOk (≤7%) && priceOk (≤5%)` → `matched` / `address_key` + `upsertHemnetSold` (D-07); otherwise route through `adjudicatePair` with empty units → `CONFIRMED_MATCH` demoted to `uncertain`, `CONFIRMED_MISMATCH` → `booli_only`, else `uncertain`.
- **APARTMENT:** inline `fetchBooliDetail(extractResidenceId(record))` for `rent` (D-06; before building the adjudicatePair record — Pitfall 3), prefer a fee-exact candidate, `adjudicatePair` with `hemnet_unit.fee` / `booli_unit.rent` → `CONFIRMED_MATCH` → `matched` / `fee_exact` + `upsertHemnetSold` (D-07), `CONFIRMED_MISMATCH` → `booli_only`, else `uncertain`.
- `persistMapped` helper assembles the D-08 verdict object (matched slug + match_method + object evidence with deltas/signals/reason/source/matched_card/window) and calls `persistVerdictForRecord` (the D-02 title-transfer gate lives inside). Evidence is a PLAIN OBJECT — never pre-stringified (Pitfall 4; grep gate enforces 0 `JSON.stringify`).

## Tasks Completed

| Task | Name | Test Commit (RED) | Impl Commit (GREEN) | Files |
| ---- | ---- | ----------------- | ------------------- | ----- |
| 1 | Runner scaffold (config, CLI+date validation, window, DB+spend lifecycle, worker pool, smoke) | c7df895 | ba6a5a9 | scripts/sold-match-run.js (new) |
| 2 | matchOne — fee-exact apt / address-key villa adjudication + verdict persist | b1c1503 | 6dca0e4 | scripts/sold-match-run.js |

TDD discipline followed per task: failing smoke committed first (RED), implementation second (GREEN). The offline `--smoke` block IS the test harness (no external runner).

## Verification

All plan verify commands pass:

- `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke` → **smoke: 14 pass, 0 fail**, exit 0 (fully offline — no DB, no network).
- `node lib/spotcheck-adjudicate.js --smoke` → exit 0 (adjudicator contract intact).
- `node -c scripts/sold-match-run.js` → exit 0 (syntax OK).
- Grep gates: first non-empty line is exactly `process.env.SCRAPE_FORCE_OXYLABS = '1';`; `SEGMENTS` count = 0 (Pitfall 7); `JSON.stringify` count = 0 (Pitfall 4); required literals present (`seg.family === 'HOUSE'`, `address_key`, `fee_exact`, `fetchBooliDetail(`, `extractResidenceId(`, `persistVerdictForRecord(`, `house-address+area+price`); house shortcut condition `cands.length === 1 && areaOk && priceOk` present.

All six `matchOne` behaviors are green in the offline smoke (mock pg client + injected search/detail deps):
1. house unique address+price+area → `matched` / `address_key` + Hemnet persist
2. house no candidate → `booli_only` (no recall)
3. house multi-candidate → `uncertain` | `booli_only` (not matched)
4. apt fee-exact → `matched` / `fee_exact` + Hemnet persist
5. apt no fee (rent null) → `uncertain`
6. title transfer → zero `sold_match` queries (D-02 gate)

## Deviations from Plan

None — plan executed exactly as written. The PATTERNS `matchOne` D-08 mapping was followed with the orchestrator's LOCKED house address-key directive (the spike shortcut, not the open-question "route everything through adjudicatePair" path). Optional extra smoke checks added (parseArgs `--flag=value` form, `validateDate('2026-02-30')` rollover, `--max-sold-date` malformed throw) — total 14 offline checks.

## Decisions Made

- **House = address-key shortcut (OQ-2 resolved):** villas confirm via unique address + agreeing area + price at any age (`match_method='address_key'`), never through fee-exact. Routing houses through unmodified `adjudicatePair` (no fee signal) would yield ~0% match rate and fail success criterion 3. Multi-candidate / divergent houses fall back to `adjudicatePair` (CONFIRMED_MATCH demoted to `uncertain`, mirroring the spike).
- **Apartment fee inline (D-06):** `fetchBooliDetail` is called in the match loop for `rent`, NOT relied upon from seed time — the `detailScope='fee-window'` gate is inverted relative to the monthly window, so seed-time `rent` is null for every record in the default window (Pitfall 3).
- **No recall pass (D-03):** non-matched records emit `booli_only` with no second loose search.
- **deps-injection for offline TDD:** `matchOne` takes an optional `deps` param (`searchSoldPaged` / `fetchBooliDetail` default to the real imports); the smoke injects stubs so all six behaviors run with no network and a mock pg client.
- **matchOne returns the verdict string:** the worker pool tallies from the return value without re-reading the DB.

## Threat Surface

No new surface beyond the plan's threat register. T-17-03 (CLI date injection) is mitigated by `validateDate` (format + round-trip, throws before any fetch/query; dates reach the DB only via the already-parameterized store upserts). T-17-04 (runaway Oxylabs spend) is mitigated by `setSpendClient` before any fetch + `CeilingError` early-stop + `remainingCalls() <= 40` drain guard — the runner adds no new uncounted fetch path. T-17-05 (DB injection) — the runner builds NO raw SQL and passes `evidence` as a plain object (grep gates: 0 `JSON.stringify`, 0 raw SQL). No threat flags.

## Known Stubs

None. `matchOne` is fully implemented (Task 1's placeholder was replaced in Task 2). The runner is config-wired end-to-end: `loadSegments` consumes `config/sold-segments.json`, the seed/search/adjudicate/persist chain calls real lib functions, and the offline smoke exercises `matchOne` via injected deps + a mock client (the deps param is a test seam, not a production stub — production calls default to the real imports).

## For the Next Plan / Operator

- **Phase 17 is COMPLETE (2/2 plans).** Milestone v3.0 (Phases 15–17) is code-complete.
- **Carried operator action (from Phase 16, still one run):** on the droplet run `node migrate-sold-phase16.js` to create the four sold tables (`booli_sold` / `hemnet_sold` / `sold_match` / `sold_spend`) before the runner's live DB persistence + `setSpendClient` ceiling can be exercised. (Per 17-RESEARCH DB State: Phase 16 already confirmed the tables live on prod via commit 466cfe7 — verify before assuming a fresh migration is needed.)
- **First live run (operator, manual):** `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --segment taby-villa --limit 50` on the droplet seeds `booli_sold`, persists `sold_match` verdicts, prints the per-segment summary; a re-run upserts with no duplicate `sold_match` rows (DB-03, proven in Phase 16). Default (no args) processes the monthly window ending ~90 days ago for all config segments.
- **Adding a segment** is now a single-file edit to `config/sold-segments.json` (CONFIG-01).
- **Deferred (v2, out of scope):** the Booli-only recall pass (genuine-bypass vs match-miss labeling), cron scheduling, Slack reporting, county expansion.

## Self-Check: PASSED

- FOUND: scripts/sold-match-run.js
- FOUND commit: c7df895 (Task 1 RED)
- FOUND commit: ba6a5a9 (Task 1 GREEN)
- FOUND commit: b1c1503 (Task 2 RED)
- FOUND commit: 6dca0e4 (Task 2 GREEN)
- VERIFIED: --smoke 14 pass 0 fail (offline); node -c exit 0; grep gates (0 SEGMENTS, 0 JSON.stringify, line-1 guard, required literals) all pass

## TDD Gate Compliance

Both tasks followed RED → GREEN. Per task: a `test(17-02): ...` commit (failing smoke) precedes the `feat(17-02): ...` commit (implementation that passes it). No REFACTOR commit was needed (the GREEN implementations were clean). Gate sequence verified in git log:
- Task 1: c7df895 `test` → ba6a5a9 `feat`
- Task 2: b1c1503 `test` → 6dca0e4 `feat`
