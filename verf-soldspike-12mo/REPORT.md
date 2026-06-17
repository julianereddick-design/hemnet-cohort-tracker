# Spike report — Hemnet-as-%-of-Booli (sold-record matching feasibility)

Generated 2026-06-16T23:09:07.270Z. Portal-to-portal sold-record comparison; NOT a market-share figure.
Seed window ends 2026-03-18 (sales ≥90d old → ratio-eligible + Hemnet-posted). Vision unavailable; apartment confirmation via fee-exact (Booli serves no sold photos → no dHash).

## Headline

| Segment | Seed | Title-transfers | Matched | Booli-only | Uncertain | Match rate | Ratio floor (95% CI) |
|---|---|---|---|---|---|---|---|
| Täby houses | 2024 | 1724 | 193 | 105 | 2 | 64.3% | 64.3% [58.8%–69.5%] |

## Täby houses (HOUSE)

- Seed 2024; title transfers 1724 (85.2%) excluded; match seed 300; processed 300.
- Verdicts: {"CONFIRMED_MATCH":193,"BOOLI_ONLY":105,"UNCERTAIN":2}
- **Match rate 64.3%** (193/300); ratio floor 64.3% (95% CI 58.8%–69.5%).
- Booli-only composition (recall): {"genuine-bypass":102,"match-miss":3}.

## Kill-test read

- **Houses**: validated if match precision >95% and Booli-only resolves cleanly into title-transfer vs genuine-bypass.
- **Apartments**: the spike's real risk. Booli-only is dominated by GENUINE Hemnet-absence (bostadsrätt have no public deed; Booli aggregates broker-reported slutpris Hemnet never showed / suppressed), NOT matcher misses — see recall split + the manual audit packs. Confirm by reviewing MANUAL-AUDIT-stockholm-apt.md.

Audit packs: `MANUAL-AUDIT-<segment>.md` (matches → verify precision; Booli-only → confirm genuine absence).