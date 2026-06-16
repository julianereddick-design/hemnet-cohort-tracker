# Spike report — Hemnet-as-%-of-Booli (sold-record matching feasibility)

Generated 2026-06-16T13:01:03.771Z. Portal-to-portal sold-record comparison; NOT a market-share figure.
Seed window ends 2026-03-18 (sales ≥90d old → ratio-eligible + Hemnet-posted). Vision unavailable; apartment confirmation via fee-exact (Booli serves no sold photos → no dHash).

## Headline

| Segment | Seed | Title-transfers | Matched | Booli-only | Uncertain | Match rate | Ratio floor (95% CI) |
|---|---|---|---|---|---|---|---|
| Stockholm apartments | 300 | 0 | 182 | 115 | 3 | 60.7% | 60.7% [55.0%–66.0%] |
| Täby houses | 300 | 210 | 51 | 39 | 0 | 56.7% | 56.7% [46.4%–66.4%] |

## Stockholm apartments (APARTMENT)

- Seed 300; title transfers 0 (0.0%) excluded; match seed 300; processed 300.
- Verdicts: {"BOOLI_ONLY":115,"CONFIRMED_MATCH":182,"UNCERTAIN":3}
- **Match rate 60.7%** (182/300); ratio floor 60.7% (95% CI 55.0%–66.0%).
- Apartment precision proxy: 182/182 confirmed matches have an EXACT fee match (strong unit identity).
- Booli-only composition (recall): {"genuine-bypass":114,"match-miss":1}.

## Täby houses (HOUSE)

- Seed 300; title transfers 210 (70.0%) excluded; match seed 90; processed 90.
- Verdicts: {"CONFIRMED_MATCH":51,"BOOLI_ONLY":39}
- **Match rate 56.7%** (51/90); ratio floor 56.7% (95% CI 46.4%–66.4%).
- Booli-only composition (recall): {"genuine-bypass":39}.

## Kill-test read

- **Houses**: validated if match precision >95% and Booli-only resolves cleanly into title-transfer vs genuine-bypass.
- **Apartments**: the spike's real risk. Booli-only is dominated by GENUINE Hemnet-absence (bostadsrätt have no public deed; Booli aggregates broker-reported slutpris Hemnet never showed / suppressed), NOT matcher misses — see recall split + the manual audit packs. Confirm by reviewing MANUAL-AUDIT-stockholm-apt.md.

Audit packs: `MANUAL-AUDIT-<segment>.md` (matches → verify precision; Booli-only → confirm genuine absence).