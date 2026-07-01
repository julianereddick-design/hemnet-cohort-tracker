# 27-04 — Resume Notes (on-box validation + weekly re-enable)

**Date:** 2026-07-01 (box crawl timestamp 2026-06-30, box tz)
**Droplet:** 357087018 / 170.64.181.89, container hemnet-django, branch `feat/adcost-steel-resume`

## Task 2 — On-box validation crawl: SUCCESS (SCRAPE-02)

Invoked the rewired task once on the box:
`docker exec hemnet-django python manage.py shell -c 'from apps.hemnet.tasks import search_ad_cost_2; search_ad_cost_2.run()'`

- Task log: `crawled [rows=420]` then `wrote [created=420]` (full clean grid, 10×6×7, zero misses).
- ORM verification (`crawled >= today`):
  - **rows: 420**
  - **munis: 10** — Göteborgs, Krokoms, Lunds, Malmö, Sandvikens, Stockholms, Uppsala, Vadstena, Varbergs, Ydre
  - **tiers: 7** — BASIC, PLUS, PREMIUM, MAX, PAID_REPUBLISH, TOPLISTING, TOPLISTING_5_DAYS (all 5 required present, `missing_req: []`)
  - sample ad_price (integer kronor): BASIC 5120, PLUS 8090, PREMIUM 11380
  - **GATE_PASS** (≥8 munis and the 5 required tiers)
- **EXACT_SPEND_USD: ~0.30** — 1 Steel session, ~70 in-page calls (same call profile as the 27-02
  measured run of $0.29; see app.steel.dev invoice for the exact figure).
- This was a real write to the shared `defaultdb` `AdCostV2` table (the resume), not a dry run.

## Task 3 — Weekly PeriodicTask re-enable (SCRAPE-01): DONE

Operator authorized the recurring-cost flip 2026-07-01 ("flip the cron"). Flipped ONLY the weekly
entry (NOT the `[adhoc]` entry):

- **`Scrape hemnet.se ad cost` → enabled=True**, cron **`0 6 * * 1` Australia/Sydney**.
- `[adhoc] Scrape hemnet.se ad cost` → still `enabled=False` (untouched).
- First unattended run: **next Monday 06:00 Australia/Sydney**. Recurring egress ~$0.50/mo.

Disable command (revert): same one-liner with `t.enabled=False`.

## Correction — payment method (2026-07-01, during Phase 28 scoping)

The initial resume used `PAY_NOW`. Verified against Julian's ARPL v6 model that the entire
historical `AdCostV2` series is the **`PAY_WHEN_LISTING_IS_REMOVED`** price (Stockholm @5M matches
BASIC 7297 / PLUS 11662 / PREMIUM 16370 / MAX 22683 exactly; PAY_NOW does not). PAY_NOW would have
injected a fake ~7% drop across the gap.

- Fixed: repo `e9b9d61` + droplet `328dc3d` (`PAYMENT_METHOD = PAY_WHEN_LISTING_IS_REMOVED`); crawler
  worker restarted so the Monday cron uses it.
- The 784 PAY_NOW rows (two test batches: 420 + a partial 364) were **deleted**; historical rows
  (≤ Mar 16, 17,234) untouched.
- Re-crawled: **378 correct rows** (54/60 cells; 6 transient CF misses), 10 munis, 7 tiers,
  GATE PASS, PLUS@5M ∈ {9180, 10068, 10688, 11662} = pay-when-removed basis. ~$0.30.
- Note: the crawler drops ~5–10% of cells on transient Cloudflare/autocomplete misses per run;
  the weekly cadence refreshes them. A per-cell retry is a possible future hardening.

## Gap

The 2026-03-16 → 2026-06-30 dormancy is a no-backfill forward hole — see `docs/ad-cost-scrape-gap.md`.

## Revert

Disable: same command with `t.enabled=False`. Full code revert path in `27-03-DROPLET-WIRING-NOTES.md`.
