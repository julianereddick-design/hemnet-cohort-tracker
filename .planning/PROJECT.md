# Project: Hemnet Cohort Tracker

**Last updated:** 2026-06-29

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
- ✅ **v3.0 Sold-match pipeline** — Phases 15–17 (code-complete 2026-06-17). Productionized the `spike/sold-match-feasibility` spike into reusable `lib/` matcher modules + sold-side DB schema/persistence + the config-driven `scripts/sold-match-run.js` runner (Booli `/slutpriser` → Hemnet `/salda`, fee-exact apartments / address-key villas, title-transfer excluded-but-retained). Operator one-time droplet populate run remaining.
- ✅ **v3.1 Sold-match productionization** — Phases 18–20 (shipped/live 2026-06-19). Scheduled fortnightly batch orchestrator (`sold-match-batch.js`), ~4-week `booli_only` re-check drain, per-run Slack report + committed-HTML trend + xlsx. National population-weighted panel sampler. Live cron firing (first full national run W26, fortnight interlock added).

## Current Milestone: v4.0 Hemnet Price-Scraper Droplet — Audit, Consolidate & Right-size

> **Note:** This milestone is *infrastructure/ops* for a **separate** system — the standalone Hemnet+Booli price-scraper droplet `170.64.181.89` (`ubuntu-s-1vcpu-2gb-syd1-01`, syd1), repo `github.com/tt7676/hem-bol-scrapers`, run by the team (Illia/raymond/vitaliy). It is NOT the cohort-tracker codebase in this repo, but it feeds the same Hemnet pricing thesis, so it is tracked here as a milestone. Most changes land in the team repo + droplet ops, not this repo's source.

**Goal:** Take durable control of the price-scraper droplet, understand everything running on it, fix its Hemnet fetch so it stops getting 403-blocked, strip it to just the price scraper, and resize it down from the ~$100/mo `s-8vcpu-16gb` slug.

**Target features:**
- **Consistent access (ACCESS):** durable, documented SSH/DO access that survives reboots/rebuilds — no more per-session DO-console key pastes.
- **Deep-dive audit (AUDIT):** inventory every app (`hemnet`, `booli`, `spotify`, `procore`, `block_inc`, `core`), data flows, Postgres/Metabase/Redis, on-disk logs, the Celery-beat schedule + queues, and a real resource/cost baseline. Understand before touching; produce keep/kill recommendations with dependency evidence.
- **Fix Hemnet capability (FETCH):** route the Hemnet listing/search fetch through the Oxylabs path already in the repo (`apps/core/webscraper.py` / proxy creds) instead of direct local headless Chromium → kills the 403s; retire self-hosted Playwright.
- **Cleanup (CLEAN):** remove the unrelated apps once the audit clears them; reclaim oversized logs/disk; leave the Hemnet price scraper as the primary workload.
- **Right-size (SIZE):** shrink the droplet slug to match the post-cleanup footprint and cut monthly cost.

**Approach (decided):** clean-up & resize **in place** (not a rebuild); **audit-before-kill** (remove nothing until the audit confirms it's safe). Booli keep/kill is decided during the audit.

**Investigation provenance (2026-06-29):** droplet found via a DO account sweep; Hemnet fetch confirmed direct-Chromium → live 403 on `/bostader?price_max=100000`; Oxylabs path exists but unused for the Hemnet search flow; actual size is `s-8vcpu-16gb` (~$96–126/mo) despite the legacy name. Full account map in memory `project_droplet_inventory`.

## Spike Findings (v3.0/v3.1 sold-match)

- Matching is **feasible and precise**: fee-exact for apartments, address-key for villas. Stockholm apt ~61%, Täby villa ~64% (stable across time windows).
- The headline: **~36% of Booli villa sold records are genuine non-Hemnet presence** (hand-confirmed 0/25 on Hemnet), not slutpris suppression and not a matcher miss. Booli holds materially more sold data than Hemnet's public `/salda`.
- Apartment fee/broker are stripped from Booli records older than ~9 months → apartments are fee-confirmable only ≤~6–9mo back; houses match at any age (address = unique key).
- Hemnet `/salda` shows only PRICED sales → suppressed sales are absent from the browsable index (can't be detected via sold pages alone — hence the deferred listing-stage test).

## Key Decisions (sold-match v3.x)

- Sold-match reuses the cohort per-property search pattern and the Phase-14 `adjudicatePair` logic; no new matching paradigm.
- Image-based matching (dHash/vision) does **not** apply to sold pages — sold detail carries no gallery images on either platform.
- Deed transfers (`Lagfart`) are excluded from matching but retained in the DB; "sold in advance" is a market signal to keep and flag.
- v3.1: a `booli_only` (unmatched) record is **lag-contaminated**, not immediately "genuine non-Hemnet" — it may simply lack a published slutpris yet. The re-check pass keeps re-attempting the Hemnet `/salda` search for **~4 weeks** before settling a record as genuine non-Hemnet (operator decision 2026-06-18); the settled rate is the decision-grade figure.
- v3.1: scheduling reuses the existing `cron-wrapper.runJob` + crontab pattern (Phase 12/13 gates); reporting reuses `lib/spotcheck-slack-bot.js`. The graphical trend output follows the repo's committed-HTML-chart-from-DB pattern, not a new dashboard stack.
- v3.1: SUPPRESS (listing-stage suppression test) stays deferred — Hemnet `/salda` indexes only priced sales, so suppression can't be measured from sold pages alone.

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
*Project context for milestone v4.0, defined 2026-06-29.*
