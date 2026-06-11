---
title: Adjudicate Branch 2 must use the dHash/vision result, not hasPhotos (price-coincidence false negative)
priority: high
area: lib/spotcheck-adjudicate + cohort-spotcheck-gate
status: pending
created: 2026-06-11
resolves_phase: null
---
Branch 2 confirms a MATCH on "photos exist," not "photos correspond" — wasting the deterministic photo signal the gate already computes.

**The problem.** `adjudicate` Branch 2: `priceAgrees && hasPhotos && provisional==='likely-match' → CONFIRMED_MATCH`. But `hasPhotos = both galleries length>0` — mere PRESENCE, not correspondence. Every active listing has photos, so this is a fig leaf; the real confirmation is price(≤5%)+triage only. Meanwhile dHash (the genuine deterministic shared-photo signal, Phase 13) IS computed for every pair in the gate — and then ignored here. dHash only ever rescues UNCERTAIN→MATCH (gate step ~line 274 gates on `verdict==='UNCERTAIN'`); it never challenges a price-confirmed match. So a `likely-match` pair with agreeing price but dHash=23 (totally different photos) is silently CONFIRMED_MATCH — the price-coincidence / different-property false negative (Type 2).

**Why it matters (Julian's sampling-budget point).** The whole point of sampling only 20% is to AFFORD rigor per pair; dHash is that rigor and is already computed. Branch 2 rubber-stamps on price instead of spending it.

**Desired behaviour.**
- Branch 2 should require a real shared-photo signal: `priceAgrees && likely-match && dHash.confirmed (minDist ≤ threshold)` → CONFIRMED_MATCH (genuinely two-signal). Pass the dHash result into `adjudicatePair` (it currently isn't an input).
- `likely-match` + price agrees + **dHash finds NO shared photo** → do NOT silently confirm → route to **vision** (which can confirm same-property even when the two platforms used different photo sets by recognising the actual rooms), then human.
- Let a high dHash on a price-confirmed pair raise a flag instead of being discarded (fixes the "dHash can only upgrade, never challenge" asymmetry).

**The real tradeoff to size.** Many TRUE matches legitimately use different photo sets across platforms → they'd fail dHash → flow to vision instead of free-confirming → more vision calls + bigger queue. That's exactly the spend the 20% sample frees up — size the vision cost against the tighter sample. Combine with [[harden-dhash-autoconfirm-shared-stock-floorplan]] so a shared floorplan/render can't satisfy the new dHash requirement. See [[project_spotcheck_pipeline_architecture]].
