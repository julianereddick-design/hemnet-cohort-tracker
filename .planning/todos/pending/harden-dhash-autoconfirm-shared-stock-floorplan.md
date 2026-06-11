---
title: Harden dHash auto-confirm against shared stock / floorplan / façade images
priority: high
area: cohort-spotcheck-gate
status: pending
created: 2026-06-11
resolves_phase: null
---
dHash auto-confirm is the only verdict path that acts WITHOUT a human — so a false confirm here is invisible. This is the most dangerous failure mode (Type 3) in the false-negative analysis.

**The problem:** the gate auto-promotes UNCERTAIN → CONFIRMED_MATCH when `minDHashDistance <= DHASH_THRESHOLD` (default 6). But a near-zero distance can come from images that are NOT proof of same-property:
- **Floorplans (`planlösning`)** — Swedish listings very commonly include a floorplan image; two different units in the same building/development can share an identical or near-identical floorplan → instant false match.
- **Developer renders in new-builds (`nyproduktion`)** — many distinct apartments reuse the same marketing render.
- **Shared façade/stairwell/exterior shot in multi-unit buildings** — different apartments, same street address, same building photo (this is the known ~1.8% multi-unit false-match problem, now AMPLIFIED because dHash actively auto-confirms on it instead of just failing to disambiguate).

**Desired behaviour (defence in depth):**
1. **Exclude non-discriminating images from the dHash set** — drop floorplan/render-type photos before comparing (detect via Hemnet/Booli image labels/categories where available, or a floorplan classifier). A shared floorplan must never auto-confirm.
2. **Require ≥2 distinct shared photos** (different scenes) before auto-confirm, not a single match — one shared photo is too weak in new-builds/multi-unit.
3. **Never auto-confirm at a multi-unit address** — if the address resolves to a building with multiple known units, force human/vision review instead of dHash auto-confirm; lean on area+price disambiguation (per [[project_cohort_spotcheck]]).
4. Keep logging `minDist` so the threshold and these guards can be calibrated from real data.

**Where:** the dHash step (step 6b) and the auto-confirm promotion loop in `cohort-spotcheck-gate.js`, plus `lib/spotcheck-dhash.js` (needs to accept/skip image categories). Same blind spot applies to vision "sharedPhoto" (a shared floorplan fools vision too) — guard both.
