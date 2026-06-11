# Phase 14: Spot-check verdict quality — Context

**Gathered:** 2026-06-11
**Status:** Ready for planning
**Source:** Session decisions 2026-06-11 (re-plan conversation with operator; supersedes a discuss-phase round) + pending todos + Phase 13 live-test analysis

<domain>
## Phase Boundary

Close the false-confirm paths in the spot-check verdict pipeline: the adjudicator's Branch 2 (`priceAgrees + hasPhotos + likely-match → CONFIRMED_MATCH`) and the dHash auto-confirm promotion. This phase changes WHAT the gate decides (verdict quality), not what happens after a verdict.

**In scope:** `lib/spotcheck-adjudicate.js`, `lib/spotcheck-dhash.js`, `lib/spotcheck-vision.js` (guards only), the dHash/promotion/vision steps of `cohort-spotcheck-gate.js`, and a one-off sizing probe script.

**Out of scope (explicitly):** the actionable half of the review loop — soft-delete removal, per-pair Slack messages, poller changes (Phase 13.1); fetch-outcome classification, review-queue filtering, aging alerts (Phase 13.2); the `cohort-create.js` matcher fix itself (PRD §9, still deferred). Execution order is 14 → 13.1 → 13.2 per operator decision 2026-06-11 ("the live loop is useless if I don't trust the data").

**Why this phase runs first:** the operator does not currently trust or fully understand the verdicts the gate produces. The probe (D-01) is as much a trust/understanding deliverable as a sizing input.

</domain>

<decisions>
## Implementation Decisions

### Probe before routing (D-01) — LOCKED
- The FIRST plan of this phase is a sizing probe, run before any adjudicator code changes are committed to a routing design.
- Sample: N=200+ pairs from a full recent cohort (operator's standing preference — never N=10–20; frame actual cost in $ and minutes).
- Must measure: of pairs that today silently confirm via Branch 2 (price-agree + likely-match), how many have NO dHash shared photo (i.e., would no longer free-confirm under D-02)? Full distribution of triage class × dHash minDist × current verdict, not just the headline number.
- Must price: the implied Claude-vision calls in $ (per-pair token cost × volume) for each candidate routing.
- Output doubles as the operator's verdict-trust dataset — a readable artifact showing how the pipeline classifies real pairs, so the operator can see WHY each verdict happened.

### Branch 2 rework (D-02) — LOCKED
- `adjudicatePair` Branch 2 must require a real shared-photo signal: `priceAgrees && likely-match && dHash-confirmed (minDist ≤ threshold)` → CONFIRMED_MATCH (genuinely two-signal).
- The dHash result becomes an INPUT to `adjudicatePair` (it currently isn't one). `hasPhotos` (mere gallery presence) is retired as a confirmation signal.

### No silent confirm without photo correspondence (D-03) — LOCKED
- `likely-match` + price agrees + dHash finds NO shared photo → must NOT silently confirm. Routes onward to vision and/or human review.
- The exact routing split (all to vision? vision then human? thresholds?) is decided AFTER the probe (D-01) quantifies volume and cost — present options with $ figures to the operator at that gate. Do not hard-code a routing before that decision.

### dHash can challenge, not only upgrade (D-04) — LOCKED
- Today dHash only rescues UNCERTAIN→MATCH (gate promotion loop gates on `verdict==='UNCERTAIN'`). A high dHash distance on a price-confirmed pair must raise a visible flag instead of being logged and discarded.

### Auto-confirm hardening ships WITH the Branch 2 rework (D-05) — LOCKED
Because D-02 makes dHash load-bearing, these guards are not optional extras:
- Exclude non-discriminating images from the dHash compare set: floorplans (`planlösning`) and new-build (`nyproduktion`) developer renders. A shared floorplan must never auto-confirm.
- Require ≥2 distinct shared photos (different scenes) before auto-confirm; one shared photo is too weak in new-builds/multi-unit buildings.
- Never auto-confirm at a multi-unit address — force vision/human review there; lean on area+price disambiguation (the known ~1.8% multi-unit false-match population).
- The same non-discriminating-image guards apply to vision's `sharedPhoto` (a shared floorplan fools vision too).
- Keep logging `minDist` per pair so threshold + guards stay calibratable from real data.

### Dependency posture (D-06) — LOCKED
- Do not block on Phase 13.2. If the probe needs the delisted-vs-transient-error distinction to interpret `miss` pairs, pull a minimal version of that classification forward into the probe itself.

### Claude's Discretion
- dHash threshold value (currently 6) — recalibrate from probe data if warranted; D-04 flag threshold choice.
- HOW to detect floorplans/renders: image labels/categories from Hemnet/Booli galleries where available, aspect-ratio/color heuristics, or a small classifier — pick the cheapest reliable mechanism and validate it on probe data.
- HOW to detect multi-unit addresses: e.g. >1 cohort/booli candidate at same street_address+postcode, or apartment housing-form — choose and document.
- Probe artifact format and location (follow existing `verf-spotcheck-*/` conventions).
- Whether the ≥2-shared-photos rule needs a relaxation for pairs with tiny galleries — propose, don't assume.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements (the two todos this phase resolves)
- `.planning/todos/pending/branch2-use-dhash-not-hasphotos.md` — Branch 2 fig-leaf problem, desired behaviour, the vision-cost tradeoff to size
- `.planning/todos/pending/harden-dhash-autoconfirm-shared-stock-floorplan.md` — Type 3 false-confirm guards (floorplan/render/multi-unit), defence-in-depth list

### Spec / process
- `COHORT-SPOTCHECK.md` (repo root) — the spot-check methodology, confirmation rule history, §3/§4/§7

### Code under change
- `lib/spotcheck-adjudicate.js` — verdict decision tree (Branch 2 lives here); D-03 price-guard regression fixtures (pairs 15647, 16347) must keep passing
- `lib/spotcheck-dhash.js` — jimp dHash cross-compare, all-pairs min
- `lib/spotcheck-vision.js` — Claude-vision adjudicator (guards extended here)
- `cohort-spotcheck-gate.js` — orchestrator: dHash step, UNCERTAIN→MATCH promotion loop (~line 274), vision gating, Slack posting
- `cohort-spotcheck.js` + `lib/spotcheck-evidence.js` — sampling, fetch, triage (`classifyDeterministic`)
- `spotcheck-photos.js` + `lib/spotcheck-photos.js` — gallery download (`--max 6` cap is a known dHash blind spot)

### Prior phase context
- `.planning/phases/13-spot-check-image-confirmation-and-human-review-loop/` — Phase 13 plans/decisions (D-01..D-14), esp. 13-02 (dHash) and 13-04 (gate integration)

</canonical_refs>

<specifics>
## Specific Ideas

**Current decision tree (adjudicatePair, first match wins):** 1) priceAgrees + vision sharedPhoto=true → MATCH. 2) priceAgrees + hasPhotos + likely-match → MATCH (**the drain — most pairs exit here**). 3) suspect + vision sharedPhoto=false + !priceAgrees → MISMATCH. 4) no photos → UNCERTAIN. 5) else UNCERTAIN. Note `priceAgrees` in adjudicate = ≤5% (TIGHTER than triage's 12% price_gap flag); the 5–12% band falls to UNCERTAIN.

**Funnel shape (live test, cohort 2026-W23):** ~288 sampled → ~265 silent CONFIRMED_MATCH + 3 MISMATCH + 20 UNCERTAIN. The probe should report how the ~265 redistribute under D-02/D-03.

**Known weaknesses being fixed (W1–W5 from 2026-06-11 analysis):** W1 Branch-2 hasPhotos fig leaf; W2 dHash only upgrades; W3 all-pairs-min fooled by non-discriminating images + 6-photo cap; W4 lenient triage lets price-coincidence through; W5 the sampling-budget argument — 20% sampling exists to AFFORD per-pair rigor, so spend the already-computed dHash signal instead of rubber-stamping on price.

**Cost benchmarks for the probe report:** Oxylabs ~$0.005/call; vision model default `claude-sonnet-4-6` (env-overridable, lazy SDK load, null→Mode-A fallback per Phase 12 decisions). Wilson 95% CI convention for any rate reported.

**Operator conventions:** use functional job names (Cohort create / Cohort track etc.), never Job A/B/C/D; deploy = commit+push, operator pulls on droplet (no Claude-driven SSH); prod DB inspection via committed Node scripts, not psql/inline node -e.

</specifics>

<deferred>
## Deferred Ideas

- Soft-delete pair removal + individual per-pair UNCERTAIN Slack messages + shared-`ts` poller guard → Phase 13.1 (operator decisions already taken: soft-delete yes; individual messages, not threads)
- Fetch-outcome classification (delisted/transient/no-photos), both-listings-exist review filter, stale-review aging alert → Phase 13.2 (except any minimal classification the probe must pull forward per D-06)
- `cohort-create.js` matcher tie-break fix (area/price disambiguation at match time) → still deferred (PRD §9)
- Phase 10 remainder (10-04 export fix + cleanup, 10-05 Pool & Flow retirement) and Phase 11 SC-5 formal soak closure → parked behind the spot-check stream

</deferred>

---

*Phase: 14-spot-check-verdict-quality*
*Context gathered: 2026-06-11 via session decisions (operator re-plan conversation)*
