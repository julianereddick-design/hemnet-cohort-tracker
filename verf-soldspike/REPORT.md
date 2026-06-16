# Spike report — Hemnet-as-%-of-Booli (sold-record matching feasibility)

Generated 2026-06-16T21:48:39.046Z. Portal-to-portal sold-record comparison; NOT a market-share figure.
Seed window ends 2026-03-18 (sales ≥90d old → ratio-eligible + Hemnet-posted). Vision unavailable; apartment confirmation via fee-exact (Booli serves no sold photos → no dHash).

## Headline

| Segment | Seed | Title-transfers | Matched | Booli-only | Uncertain | Match rate | Ratio floor (95% CI) |
|---|---|---|---|---|---|---|---|
| Stockholm apartments | 300 | 0 | 182 | 115 | 3 | 60.7% | 60.7% [55.0%–66.0%] |
| Täby houses | 1970 | 1670 | 189 | 110 | 1 | 63.0% | 63.0% [57.4%–68.3%] |

## Stockholm apartments (APARTMENT)

- Seed 300; title transfers 0 (0.0%) excluded; match seed 300; processed 300.
- Verdicts: {"BOOLI_ONLY":115,"CONFIRMED_MATCH":182,"UNCERTAIN":3}
- **Match rate 60.7%** (182/300); ratio floor 60.7% (95% CI 55.0%–66.0%).
- Apartment precision proxy: 182/182 confirmed matches have an EXACT fee match (strong unit identity).
- Booli-only composition (recall): {"genuine-bypass":114,"match-miss":1}.

## Täby houses (HOUSE)

- Seed 1970; title transfers 1670 (84.8%) excluded; match seed 300; processed 300.
- Verdicts: {"CONFIRMED_MATCH":189,"BOOLI_ONLY":110,"UNCERTAIN":1}
- **Match rate 63.0%** (189/300); ratio floor 63.0% (95% CI 57.4%–68.3%).
- Booli-only composition (recall): {"genuine-bypass":109,"match-miss":1}.
- ⚠ 2 searches flagged incomplete (pagination cap) — excluded from confident Booli-only.

## Kill-test read

- **Houses**: validated if match precision >95% and Booli-only resolves cleanly into title-transfer vs genuine-bypass.
- **Apartments**: the spike's real risk. Booli-only is dominated by GENUINE Hemnet-absence (bostadsrätt have no public deed; Booli aggregates broker-reported slutpris Hemnet never showed / suppressed), NOT matcher misses — see recall split + the manual audit packs. Confirm by reviewing MANUAL-AUDIT-stockholm-apt.md.

Audit packs: `MANUAL-AUDIT-<segment>.md` (matches → verify precision; Booli-only → confirm genuine absence).