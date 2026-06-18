# Loop #2 — per-property Slutpris→Lagfart reclassification tracker (Model A test)

**Status:** PENDING — deferred, separate future build (NOT part of v3.1 Phases 18–20).
**Logged:** 2026-06-18 (Julian, during v3.1 Phase-19 kickoff discussion).
**Related memory:** [[project_v3_1_scope_slutpris_only]], [[project_hemnet_market_share_plan]] (validation test #3), [[project_lagfart_mostly_on_hemnet]].

## What

A scheduled monitoring loop that tracks each **explicit** Booli sold property (keyed by `residence_id`)
and watches whether its own `sold_price_type` flips **Slutpris → Lagfart** over time.

- **Cadence/horizon:** re-check every **4 weeks for ~6 months** (covers the 3–6mo land-registry lag).
- **Data source (cheap):** re-pull Booli `/slutpriser` for the cohort's window and re-read `sold_price_type`
  off the cards (cards already carry it) keyed by `residence_id` — no per-property detail fetch required.
- **State:** a NEW small tracking table of per-property `sold_price_type` snapshots over time
  (NOT the `sold_match` Phase-18 re-check columns, which are a different loop).
- **Readout:** the reclassification rate among our matched/analyzed Slutpris villas + the conversion-timing curve.

## Why

The "~85% of villas are Lagfart" figure is a point-in-time snapshot of a SETTLED window; it can't tell us
whether a FRESH cohort looks like that or how the mix drifts with age. This loop discriminates:

- **Model A** — every villa starts as Slutpris then ages into Lagfart → a fresh Slutpris capture is a
  COMPLETE, unbiased denominator; the 85% is an aging artifact; keeping Slutpris-only is safe.
- **Model B** — some villas only ever register as Lagfart (off-market / estate / developer batches never
  broker-reported) → structurally missing from a Slutpris-only denominator = sampling bias.

It also yields the conversion curve → tunes the right capture window (settled enough for slutpris to post,
fresh enough to stay Slutpris-complete; prod `READ_TIME_EXCLUDE_DAYS=90` may already lose some to Lagfart).

## Acknowledged gap (note-and-ignore for now, Julian 2026-06-18)

This loop tests **Model A only**. It does **NOT** test Model B — a property that is Lagfart-only from the
start is never in the tracked Slutpris cohort, so its absence is invisible here. Accepted/deferred; flagged
so Model A confirmation is not mistaken for "denominator validated."

## When built — likely shape

Mirror Phase 18's enroll → re-check → settle pattern but on the Booli-source side:
enroll a fresh sale-month cohort → 4-weekly `sold_price_type` re-read for 6 cycles → settle → surface the
reclassification rate alongside the Phase-20 match-rate trend.
