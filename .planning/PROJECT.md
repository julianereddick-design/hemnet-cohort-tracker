# Project: Hemnet Cohort Tracker

**Last updated:** 2026-06-17

## What This Is

A Swedish-property data pipeline that measures supply and demand across Hemnet and Booli. It self-hosts the scrapers that populate the source listing tables (`booli_listing`, `hemnet_listingv2`), builds weekly for-sale cohorts, tracks their view-counts and drop-off, runs a weekly spot-check QA gate that confirms Booli↔Hemnet pairs are the same property, and captures daily nationwide market-supply totals. Runs on a DigitalOcean droplet against a managed Postgres DB; scraping goes through Oxylabs.

## Core Value

Quantify the Swedish housing funnel — pool (what's for sale / sold) and flow (how it moves) — across **both** Hemnet and Booli, because either platform alone understates the market. The cross-platform comparison is the differentiator.

## Milestone History

- ✅ **v1.0 Cohort tracker MVP** — Phases 1–5. Weekly for-sale cohorts, view tracking, streak-based drop logic.
- ✅ **v2.0 Self-hosted scraper** — Phases 6–9. Replaced the black-box upstream feed with in-repo scrapers owning the source tables.
- ✅ **v2.1 Self-hosted scraper hardening** — Phase 10. Cleanup, production stabilization.
- ✅ **v2.2 Market supply pulse** — Phase 11. Daily nationwide listing totals (Till salu + Kommande) from `__NEXT_DATA__`.
- ✅ **Spot-check QA stream** — Phases 12–14.1. Cohort match spot-check gate, image confirmation + human review loop, Phase-14 identity-model adjudication (`adjudicatePair`: fee-first verdicts, label-filtered dHash, vision fallback).

## Current Milestone: v3.0 Sold-match pipeline (Booli-sold → Hemnet-sold), DB-backed

**Goal:** Productionize the `spike/sold-match-feasibility` spike into a reusable, config-driven, **database-backed** pipeline that matches Booli `/slutpriser` sold records to Hemnet `/salda` per segment and persists seeds, matches, and verdicts.

**Target features:**
- Reusable `lib/` matcher modules (Booli-sold seed fetch, per-property Hemnet `/salda` search, adjudication, title-transfer filtering, `normAddr` v2) — productionized from `scripts/spike-*.js`.
- Sold-side DB schema + persistence, replacing the spike's DB-free JSON.
- Enriched Booli sold capture (broker, operating cost, construction year, tenure form, rooms/area/floor, coords, `soldPriceType`) + a "sold in advance" flag.
- Config-driven segments (municipality + objectType), seeded with Stockholm apartments + Täby villas.
- Monthly rolling-window parameterization, runnable manually; Oxylabs spend ceiling + transient-613 retry in the main path.

**Deferred (decide next):** production scheduling, reporting/Slack output, listing-stage suppression test.

## Spike Findings That Anchor This Milestone

- Matching is **feasible and precise**: fee-exact for apartments, address-key for villas. Stockholm apt ~61%, Täby villa ~64% (stable across time windows).
- The headline: **~36% of Booli villa sold records are genuine non-Hemnet presence** (hand-confirmed 0/25 on Hemnet), not slutpris suppression and not a matcher miss. Booli holds materially more sold data than Hemnet's public `/salda`.
- Apartment fee/broker are stripped from Booli records older than ~9 months → apartments are fee-confirmable only ≤~6–9mo back; houses match at any age (address = unique key).
- Hemnet `/salda` shows only PRICED sales → suppressed sales are absent from the browsable index (can't be detected via sold pages alone — hence the deferred listing-stage test).

## Key Decisions

- Sold-match reuses the cohort per-property search pattern and the Phase-14 `adjudicatePair` logic; no new matching paradigm.
- Image-based matching (dHash/vision) does **not** apply to sold pages — sold detail carries no gallery images on either platform.
- Deed transfers (`Lagfart`) are excluded from matching but retained in the DB; "sold in advance" is a market signal to keep and flag.

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Project context for milestone v3.0, defined 2026-06-17.*
