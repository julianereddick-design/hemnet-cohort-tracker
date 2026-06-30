# Ad-Cost Scrape Gap — 2026-03-16 → 2026-06-30 (no backfill)

**Status:** Weekly Hemnet ad-cost scrape (`AdCostV2`) **resumed 2026-06-30** (first resumed
crawl; ~2026-07-01 local). Dormant since **2026-03-16**.

## What happened

The weekly `search_ad_cost_2` task silently stopped landing rows around **2026-03-16**. Phase 27
(2026-07-01) root-caused it: the pinned GraphQL operation `SellerMarketingProductPrices` was
**removed from Hemnet's public schema** (now `GRAPHQL_VALIDATION_FAILED`), and the droplet's DC IP
is Cloudflare-blocked. The task was rewired to the current `webPricingCalculator` operation over a
Steel residential browser (see `.planning/phases/27-resume-weekly-scrape/`).

## The gap is a VISIBLE FORWARD HOLE — do not backfill

Hemnet ad prices are **current-only**: the pricing calculator returns today's prices for a
(municipality, asking-price) pair. There is **no historical price API** and **no way to
reconstruct** what ad prices were during 2026-03-16 → 2026-06-30.

**Therefore:**
- The ~3.5-month window **has no `AdCostV2` rows** and **cannot be filled**.
- Downstream reporting (Phase 28 Slack / Chart / Excel) must render this as an **explicit forward
  gap** — **no interpolation, no carry-forward, no smoothing** across 2026-03-16 → 2026-06-30.
- Fresh weekly rows accrue **from 2026-06-30 onward** only.

## Caveat on tier comparability across the gap

The resumed crawl maps the current offer slugs to the historical `ad_type` labels for continuity
(`BAS→BASIC`, `PLUS/PREMIUM/MAX` unchanged, `FORNYA_ANNONS→PAID_REPUBLISH`,
`RAKETEN_3_DAGAR→TOPLISTING`, `RAKETEN_5_DAGAR→TOPLISTING_5_DAYS`). The package ladder
(Bas/Plus/Premium/Max) is directly comparable to pre-gap data. The **boost add-ons differ**:
"Raketen" is a newer product than the old "toplistning", so `TOPLISTING`/`TOPLISTING_5_DAYS`
values **before vs after the gap are not strictly the same product** — annotate accordingly in
reports. Also note PLUS/PREMIUM/MAX are now server-composed with BASIC (same net semantics as the
old client-side BASIC-sum). See `27-GRAPHQL-CONTRACT.md`.
