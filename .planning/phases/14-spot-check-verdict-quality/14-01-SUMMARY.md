# Plan 14-01 Summary — Sizing/trust probe + DECISION (D-13 delegation)

**Executed:** 2026-06-11 overnight (operator delegation D-13) · **Probe run:** droplet, cohort 2026-W23, 288 pairs (20% of 1,434), ~864 Oxylabs calls ≈ $4.32, wall-clock ~70 min
**Artifacts:** droplet `verf-spotcheck-2026-W23-20260611-123456/` (PROBE-2026-W23.md + probe-2026-W23.json); local copy `verf-probe14/`

## Probe results (5 tests)

| Test | Result |
|---|---|
| T1 fee coverage | 161 apartments (55.9% of sample); **91.3%** have exact-kr fee on BOTH platforms (95% CI 86–95%); of those **95.2% exactly equal**, 0 near-misses, **7 contradictions** |
| T2 redistribution | 263 current silent confirms → 230 stay MATCH (now evidence-backed), 25 → UNCERTAIN, 8 → MISMATCH-candidates |
| T3 gallery cap | Shared photo found: **127 at cap-6 vs 246 at cap-20** — the old cap lost 119 pairs (48% of all shared-photo pairs); 25 best-matches sat at gallery position 18+ |
| T4 label filter | Only **1** cap-6 auto-confirm relied solely on a floorplan (16660 Norrtorpsvägen 40); full-filtered histogram cleanly separates (≤6: 244 pairs; ≥16: 7) |
| T5 residue/cost | Proposed UNCERTAIN residue 43 (25 with galleries → vision at **$1.05/wk**, 18 delisted/no-photos); 9 multi-unit pairs in sample; coverage: 20% = $4.32/wk vs 100% structured = $18.35/wk |

## DECISION (Claude, per D-13 delegation, from probe data)

1. **Fee-first identity model CONFIRMED** — 91.3% coverage × 95.2% exactness makes exact-fee the primary unit-level confirm signal. `feeMatch` (exact kr) + ≥1 supporting signal → CONFIRMED_MATCH.
2. **Fee/floor contradictions → UNCERTAIN `conflict` (human review), NOT auto-MISMATCH.** Probe falsified the auto-mismatch idea: contradiction list includes believed-true match 15647 (5208 vs 4356) and a recurring Booli≈80%-of-Hemnet cluster → fee drift/revision exists on true matches. These pairs never silently confirm AND never auto-remove — they reach a human with the numbers.
3. **Floor tolerance ±0.5** — 4 of 5 floor disagreements among fee-exact true matches were Booli half-floors (halvtrappa 0.5/1.5). Floor never confirms (neighbours share floors); >0.5 difference → conflict review.
4. **Gallery cap 6 → 20** (gate `--max` default). 48% shared-photo recall was being lost; images are CDN-direct so cost is hash time only.
5. **dHash threshold stays 6; ≥2 distinct shared scenes required (≥1 when either filtered side ≤2 images).** Histogram shows clean separation at full-gallery + label-filtered; no need to loosen.
6. **Label-based floorplan/render exclusion on both platforms** (Hemnet Apollo `FLOOR_PLAN` + Booli `floorplan`/`property_map`/`nearby_area`); jimp whiteness heuristic dropped (D-10).
7. **Vision routing A: ALL first-pass-UNCERTAIN pairs with usable galleries → vision** (~25/wk ≈ $1.05), capped by `VISION_MAX_CALLS` (default 60). Enabled by default when ANTHROPIC_API_KEY present (prod cron line carries no flags — code default governs; `--mode-a` opts out).
8. **Coverage stays 20%** — the 100% structured option ($18.35/wk, full-cohort fee screening + cleanup) is left as an OPERATOR decision (recurring spend), documented in the morning report.

## What this resolved/superseded
- Plans 14-02/14-03/14-04 scope was implemented directly during the overnight run (operator delegation) with one design difference from the drafted plans: `adjudicatePair(record, { visionResult, dhashResult })` signature, contradiction split hard/soft per decision 2 above.
- Todos resolved: `branch2-use-dhash-not-hasphotos` (Branch 2 deleted; identity model), `harden-dhash-autoconfirm-shared-stock-floorplan` (label filter + ≥2 scenes + multi-unit safety by construction — price+area alone can never confirm anywhere, incl. multi-unit addresses).
