---
phase: 17-match-pipeline-orchestration
verified: 2026-06-17T00:00:00Z
status: human_needed
score: 7/7 must-haves verified (code level); 1 operator live-run confirmation outstanding
overrides_applied: 0
human_verification:
  - test: "Operator live run on the droplet: SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --segment taby-villa --limit 50"
    expected: "Runner connects to prod DB, seeds booli_sold page-by-page, searches Hemnet /salda per record, persists matched/booli_only/uncertain rows into sold_match with object evidence, prints the per-segment summary line (adjudicated/matched/booli_only/uncertain/error/matchRate/oxylabsSpent/stoppedBy), and a re-run produces no duplicate sold_match rows (DB-03)."
    why_human: "Live network (Oxylabs) + live prod DB writes are authorization-gated and deferred to a one-time operator droplet run per the phase plan and environment note. Cannot be exercised in CI/offline verification. All offline contracts (smoke + grep gates + lib export wiring) pass; this is end-to-end confirmation of the wired pipeline against real data."
---

# Phase 17: Match pipeline orchestration Verification Report

**Phase Goal:** A config-driven runner stitches the ingestion modules, the Phase-14 adjudicator, and DB persistence into one manually-runnable end-to-end pipeline: for each configured segment (municipality + objectType) and a monthly rolling window it seeds Booli, searches Hemnet, adjudicates each non-deed-transfer record to a persisted verdict with evidence, honoring the apartment fee-window vs villa address-key rule.
**Verified:** 2026-06-17
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Merged from ROADMAP Success Criteria (1-4, the contract) and PLAN 17-01/17-02 frontmatter must_haves.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Segments are configuration (municipality + objectType), seeded with Stockholm apartments + Täby villas, expandable without code changes (SC1 / CONFIG-01) | ✓ VERIFIED | `config/sold-segments.json` holds both segments in the D-01 shape (`stockholm-apt`/APARTMENT/areaIds 1/`Lägenhet`/loc 18031; `taby-villa`/HOUSE/areaIds 20/`Hus`/loc 17793/itemType null). Runner `loadSegments()` reads the JSON (scripts/sold-match-run.js:41-45); `main()` iterates `Object.keys(segments)` (line 345) so a 3rd key is auto-included — confirmed at runtime: loader is JSON-driven, no `SEGMENTS` const in code. |
| 2   | A run accepts rolling-window params (min/max sold date) defaulting to a monthly window and executes end-to-end manually: seed → search → adjudicate → persist (SC2 / CONFIG-02) | ✓ VERIFIED (code); live run operator-gated | `parseArgs` honors `--min/max-sold-date` with `validateDate` (lines 64-87). Default window `daysAgoISO(90)`..`daysAgoISO(120)` → runtime: min 2026-02-17 < max 2026-03-19 (~30d ending ~90d back). `main()` wires `seedSegment` → `runSegment` → `matchOne` → `persistMapped` per segment. Live DB/Oxylabs run deferred to operator (human item). |
| 3   | Each non-deed-transfer Booli record is adjudicated against Hemnet `/salda` via `adjudicatePair` — fee-exact for apartments (within fee window), address-key for villas at any age (SC3 / MATCH-01, MATCH-03) | ✓ VERIFIED | HOUSE branch (lines 212-234): unique address + areaOk(≤7%) + priceOk(≤5%) → `matched`/`address_key`; else routes through `adjudicatePair`. APARTMENT branch (lines 236-265): inline `fetchBooliDetail(extractResidenceId(record))` for rent BEFORE `adjudicatePair`, fee-exact candidate selection, `fee_exact` method. `adjudicatePair` imported from lib/spotcheck-adjudicate (exists). MATCH-03 fee-window: D-06 inline fetch means seed-time rent (null in the monthly window) is correctly not relied upon. Smoke cases 1,3,4,5 green. |
| 4   | Each Booli record receives a persisted verdict (matched/booli_only/uncertain) with evidence (matched slug, agreeing signals) (SC4 / MATCH-04) | ✓ VERIFIED | `persistMapped` (lines 144-164) assembles D-08 verdict object (matched_hemnet_slug, verdict, match_method, object evidence = signals+deltas+matched_card+window) and calls `persistVerdictForRecord`. Every code path returns via `persistMapped` (search-fail, no-candidate, house match/non-match, apt match/non-match). Smoke asserts verdict name/method/slug per case. |
| 5   | The runner can fetch a single Booli apartment fee inline via `fetchBooliDetail`, and extract a residenceId without duplicating the regex (PLAN 17-01 truths) | ✓ VERIFIED | `lib/sold-fetch-booli.js` module.exports (lines 358-363) includes `fetchBooliDetail` + `extractResidenceId`; both destructured in runner (line 28) and used (lines 239-241). Wave-1 smoke 19/19 includes both export checks. |
| 6   | Deed transfers never reach sold_match (D-02 gate) | ✓ VERIFIED | `persistVerdictForRecord` (lib/sold-store.js:132-139) returns false before any query when `is_title_transfer` / `isTitleTransfer(sold_price_type)`. Runner routes ALL persists through it. Smoke case 6 (title transfer) asserts zero `INSERT INTO sold_match` queries against the mock client — passes. |
| 7   | The DB-atomic spend ceiling is active (setSpendClient once before any fetch) and CeilingError early-stops workers (D-09) | ✓ VERIFIED | `main()` calls `setSpendClient(client)` immediately after connect, before the segment loop (line 354). `runSegment` worker pool early-returns on `remainingCalls() <= 40` drain guard (line 311) and catches `CeilingError` → `stopped='ceiling'` (line 319). matchOne re-throws CeilingError to the worker (line 189, 241). |

**Score:** 7/7 truths verified at the code level. Truth 2's live end-to-end execution is operator-gated (human item below) — expected per plan, not a gap.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `config/sold-segments.json` | Both segments in D-01 shape | ✓ VERIFIED | Valid JSON, both keys, `Lägenhet` UTF-8 preserved, `taby-villa.hemnet.itemType` JSON null. `node -e require` prints correct values. |
| `lib/sold-fetch-booli.js` | exports fetchBooliDetail + extractResidenceId | ✓ VERIFIED | module.exports lines 358-363 include both; bodies unchanged; smoke 19/19; SEGMENTS const in sold-config.js still intact (backward compat). |
| `scripts/sold-match-run.js` | config-driven end-to-end runner, min 200 lines, contains persistVerdictForRecord | ✓ VERIFIED | 561 lines (368 code + smoke). Contains persistVerdictForRecord, loadSegments, validateDate, matchOne, seedSegment, runSegment, persistMapped. First line is the SCRAPE_FORCE_OXYLABS guard. node -c OK. Smoke 14/14. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| sold-match-run.js | config/sold-segments.json | loadSegments() readFileSync | ✓ WIRED | line 41-45 reads the JSON file |
| sold-match-run.js | sold-transport setSpendClient | setSpendClient(client) before fetch | ✓ WIRED | line 354, after connect, before loop |
| sold-match-run.js | sold-fetch-booli fetchBooliDetail | inline apt fee (D-06) | ✓ WIRED | imported line 28, called via detailFetch (deps seam) line 241; runs BEFORE adjudicatePair |
| sold-match-run.js | spotcheck-adjudicate adjudicatePair | apt + divergent-house adjudication | ✓ WIRED | imported line 31; called lines 223, 251 |
| sold-match-run.js | sold-store persistVerdictForRecord | per-record verdict persist | ✓ WIRED | imported line 30; called in persistMapped line 162 |
| sold-match-run.js | sold-fetch-hemnet searchSoldPaged/searchOptsFor/booliSoldUnix | per-record search | ✓ WIRED | imported line 29; all three exist in lib export |
| sold-match-run.js | sold-store upsertBooliSold/upsertHemnetSold | seed + matched-card persist (D-07) | ✓ WIRED | upsertBooliSold line 284; upsertHemnetSold lines 216, 260 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Runner offline smoke (14 cases incl. all 6 matchOne behaviors + D-02 gate) | `node scripts/sold-match-run.js --smoke` | smoke: 14 pass, 0 fail; exit 0 | ✓ PASS |
| Runner syntax | `node -c scripts/sold-match-run.js` | syntax OK | ✓ PASS |
| Config data file parses | `node -e require config/sold-segments.json` | keys + Lägenhet + null correct | ✓ PASS |
| SEGMENTS const intact (backward compat) | `node -e require sold-config.SEGMENTS` | SEGMENTS intact | ✓ PASS |
| Wave-1 exports smoke | `node lib/sold-fetch-booli.js --smoke` | smoke: 19 pass, 0 fail; exit 0 | ✓ PASS |
| Adjudicator contract intact | `node lib/spotcheck-adjudicate.js --smoke` | smoke: 21 pass, 0 fail; exit 0 | ✓ PASS |
| Default window ordering | `node -e daysAgoISO(90/120)` | min 2026-02-17 < max 2026-03-19 (~30d) | ✓ PASS |
| Live droplet run (seed→search→adjudicate→persist→summary, idempotent re-run) | operator-gated | not run (authorization-gated) | ? SKIP → human |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| MATCH-01 | 17-02 | Non-deed-transfer record adjudicated fee-exact (apt) / address-key (villa) via adjudicatePair | ✓ SATISFIED | Truth 3; HOUSE + APARTMENT branches; smoke cases 1,3,4,5 |
| MATCH-03 | 17-02 | Apt matches confirmed within fee window; houses use address key at any age | ✓ SATISFIED | Truth 3; D-06 inline fetchBooliDetail (seed-time rent not relied upon); house address_key with no age gate |
| MATCH-04 | 17-02 | Persisted verdict (matched/booli_only/uncertain) with evidence | ✓ SATISFIED | Truth 4; persistMapped → persistVerdictForRecord; object evidence with slug+signals+deltas |
| CONFIG-01 | 17-01 | Segments as config, two seeds, expandable without code changes | ✓ SATISFIED | Truth 1; JSON file + JSON-driven loader + Object.keys iteration |
| CONFIG-02 | 17-02 | Rolling-window params, monthly default, runnable end-to-end manually | ✓ SATISFIED (code); live run operator-gated | Truth 2; parseArgs + validateDate + default window + seed→persist chain |

All 5 declared requirement IDs accounted for; no orphaned Phase-17 requirements in REQUIREMENTS.md (MATCH-01/03/04, CONFIG-01/02 all map to Phase 17; MATCH-02 + CONFIG-03 belong to Phase 15, DB-* to Phase 16).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| scripts/sold-match-run.js | 39 | `SEGMENTS` token | ℹ️ Info | Comment only ("NOT the SEGMENTS const"); no const import in code. The acceptance gate `grep -v '^#'` does not strip JS `//` comments so it counts 1, but the runner provably does not use the const (runtime confirmed JSON-driven). Not a stub. |
| scripts/sold-match-run.js | 141 | `JSON.stringify` token | ℹ️ Info | Comment only ("upsertSoldVerdict JSON.stringify's it internally"); no actual stringify call. Evidence is passed as a plain object per Pitfall 4. Not a defect. |

No blocker or warning anti-patterns. No TODO/FIXME/placeholder, no empty returns in production paths, no hardcoded-empty data flowing to output.

### Human Verification Required

#### 1. Operator live droplet run

**Test:** `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --segment taby-villa --limit 50` on the droplet (after confirming the four Phase-16 sold tables are live on prod — already applied per Phase 16 commit 466cfe7).
**Expected:** Seeds `booli_sold` page-by-page; searches Hemnet `/salda` per non-deed-transfer record; persists `matched`/`booli_only`/`uncertain` rows into `sold_match` with object evidence and matched-slug; prints the D-04 per-segment summary line; a re-run upserts with no duplicate `sold_match` rows (DB-03).
**Why human:** Live Oxylabs network calls + live prod DB writes are authorization-gated and deferred to a one-time operator run per the plan and environment note. All offline contracts pass; this is end-to-end confirmation against real data, not reproducible in offline verification.

### Gaps Summary

No code-level gaps. All 7 observable truths, all 3 artifacts, and all 7 key links verify against the actual codebase. All 5 requirement IDs (MATCH-01/03/04, CONFIG-01/02) are satisfied at the code level. The full offline test surface is green: runner smoke 14/14, Wave-1 exports 19/19, adjudicator 21/21, config parse, SEGMENTS backward-compat, syntax, and every consumed lib export wired and present. The six SUMMARY commits exist with a real TDD RED→GREEN sequence. The two grep-gate "violations" the run surfaced are both code comments (verified by line inspection), not behavior, and do not affect correctness.

The single outstanding item is the operator live droplet run (seed → search → adjudicate → persist → summary against prod DB + Oxylabs) — explicitly authorization-gated and deferred per the phase plan, so it is a human-verification item rather than a gap. Status is therefore **human_needed**, not passed: the decision tree mandates human_needed whenever a non-empty human-verification section exists, even with all code truths verified.

---

_Verified: 2026-06-17_
_Verifier: Claude (gsd-verifier)_
