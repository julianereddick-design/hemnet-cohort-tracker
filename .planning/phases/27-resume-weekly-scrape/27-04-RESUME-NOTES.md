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

## Gap

The 2026-03-16 → 2026-06-30 dormancy is a no-backfill forward hole — see `docs/ad-cost-scrape-gap.md`.

## Revert

Disable: same command with `t.enabled=False`. Full code revert path in `27-03-DROPLET-WIRING-NOTES.md`.
