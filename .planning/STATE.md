---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Sold-match pipeline
status: executing
stopped_at: Phase 15-05 COMPLETE 2026-06-17. lib/sold-fetch-hemnet.js + scripts/hemnet-sold.js shipped. Per-property /salda SaleCard search with filtered URL builder (price/area/rooms/item_type), paginated early-stop (address/short-page/window/ceiling), within-run searchCache dedup, house-vs-apartment opts, MATCH-02 normAddr from sold-addr. --smoke 23 pass. Phase 15 COMPLETE (5/5 plans). Next = Phase 16 (sold-match DB schema + persistence).
last_updated: "2026-06-17T15:33:23.000Z"
progress:
  total_phases: 14
  completed_phases: 4
  total_plans: 30
  completed_plans: 26
  percent: 87
---

## Current Position

Phase: 15 (sold-data-ingestion-library) — COMPLETE
Plan: 5 of 5 (ALL COMPLETE)
**Phase:** 15 — Sold-data ingestion library
**Plan:** 15-05 COMPLETE — Hemnet fetch (SOLD-05, MATCH-02)
**Status:** Phase 15 COMPLETE. Next = Phase 16 (sold-match DB schema + persistence)
**Progress:** ██████████ 100% (5/5 plans complete in Phase 15)

**Milestone v3.0 phases:**

- [x] Phase 15 — Sold-data ingestion library (SOLD-01..05, MATCH-02, CONFIG-03) COMPLETE
- [ ] Phase 16 — Sold-match DB schema + persistence (DB-01..03)
- [ ] Phase 17 — Match pipeline orchestration (MATCH-01/03/04, CONFIG-01/02)

**Next:** `/gsd-execute-phase 16`

## Accumulated Context

### Roadmap Evolution

- Milestone v3.0 (Sold-match pipeline) defined 2026-06-17: productionize the validated `spike/sold-match-feasibility` spike into reusable `lib/` modules + DB persistence. 3 phases (15–17), 15 v1 requirements, all mapped. v2 deferred: SCHED (cron scheduling), REPORT (Slack/reporting), SUPPRESS (listing-stage suppression test).
- Phase 12 added: Cohort match spot-check weekly QA gate (verify Booli↔Hemnet pairs are the same property; spec in repo `COHORT-SPOTCHECK.md`)

### Decisions (v3.0, 2026-06-17 — anchored by the spike)

- v3.0: Sold-match reuses the cohort per-property search pattern + Phase-14 `adjudicatePair` logic — no new matching paradigm. Apartments confirm via fee-exact (only ≤~6–9mo back before Booli strips fee/broker); villas via address-key at any age.
- v3.0: Deed transfers (`soldPriceType=Lagfart` / `isTitleTransfer`) are EXCLUDED from matching but RETAINED in the DB. "Sold in advance" (sold before viewing) is a market signal to detect + flag; exact Booli encoding needs a short recon (Phase 15 discovery task).
- v3.0: Image-based matching (dHash/vision) does NOT apply — sold detail pages carry no gallery images on either platform. The Phase-14 image path is out of scope for sold-match.
- v3.0: DB was unreachable during the spike (doctl auth expired); rebuild assumes DB access restored. Apartment matching >9 months back is a design limit (no unit signal remains), not a bug.
- v3.0 finding that anchors scope: ~36% of Booli villa sold records are genuine non-Hemnet presence (hand-confirmed 0/25 on Hemnet), not slutpris suppression and not a matcher miss.

### Decisions (Phase 15-05, 2026-06-17 — Hemnet fetch, SOLD-05 + MATCH-02)

- 15-05: normAddr imported from lib/sold-addr (MATCH-02 single source of truth, not redefined in sold-fetch-hemnet)
- 15-05: searchOptsFor HOUSE: priceBand=0.10, areaBand=0.15, dropRooms=true, dropItemType=true — street address is near-unique key; loose search avoids Booli/Hemnet rooms/subtype quirks; Täby density is low so 50-cap risk is low
- 15-05: searchOptsFor APARTMENT: empty opts (tight defaults) — rooms+area+item_type keep dense building results under the 50-card page cap
- 15-05: CeilingError caught in searchSoldPaged and returned cleanly as stopReason='ceiling'; drain guard at remainingCalls()<=40 returns partial as stopReason='ceiling-floor' (T-15-15)
- 15-05: Within-run searchCache/searchInFlight are module-level Maps (process lifetime scope) — deduplicates concurrent Phase-17 worker calls for the same URL at zero extra Oxylabs cost

### Decisions (Phase 15-04, 2026-06-17 — Booli fetch + detail enrichment)

- 15-04: detailScope defaults to 'fee-window' (apartments only, within FEE_WINDOW_DAYS=270); 'all' requires operator marker in RECON doc at runtime; 'none' skips detail entirely — explicit escalation, never silent (D-01)
- 15-04: parseBooliSoldDetail extended to return sold_in_advance (Boolean(sp.soldAsUpcomingSale) or null) — field was absent from the 15-01 lift, added as Rule 2 (SOLD-04 requirement)
- 15-04: CeilingError caught at both page-loop and mid-card-loop levels — partial-page record written before break so no work lost on ceiling stop (idempotent/resumable)
- 15-04: fetchBooliSoldPage returns { cards, meta } with no JSONL write — Phase 16 passes this primitive its own pg client; fetchBooliSold owns the seeds/<segKey>.jsonl path
- 15-04: D-01 spend guard reads RECON doc at runtime via fs.readFileSync (not module load) — check runs on every invocation of --detail-scope all

### Decisions (Phase 15-03, 2026-06-17 — sold-in-advance recon)

- 15-03: sold_in_advance (SoldProperty.soldAsUpcomingSale) is detail-page-only — NOT on /slutpriser card nodes (confirmed offline, 0 Oxylabs spend)
- 15-03: D-01 escalate-excluding-deed-transfers policy approved by operator: fetch /bostad/<residenceId> for all records WHERE !isTitleTransfer; soldPriceType=Lagfart records stay card-only with sold_in_advance=null; reduces ~2× cost increase by deed-transfer share
- 15-03: Approval marker "escalate detail (spend confirmed)" written to 15-SOLD-IN-ADVANCE-RECON.md (2ba623f); Plan 04 --detail-scope all guard now unblocked

### Decisions (Phase 15-02, 2026-06-17 — transport spine)

- 15-02: sold-transport require path is ./scrape-http (same lib/ dir) — no HTTP duplication; sold pages are 100% Oxylabs so the load-time SCRAPE_FORCE_OXYLABS guard is an invariant kept verbatim from the spike
- 15-02: 613-class sleep in scrape-http.js fallbackViaOxylabs inserted BEFORE the existing single retry; uses existing sleep() helper (no new function added); retry count stays at 1; triggers on OXYLABS_API_NON_200 and OXYLABS_TARGET_NON_200 — both transient classes
- 15-02: spend ceiling (_spend.json) incremented BEFORE fetch — a forced attempt consumes credits whether or not it ultimately succeeds (D-07 invariant preserved from spike)

### Decisions (Phase 15-01, 2026-06-17 — foundation libs)

- 15-01: normStreet imported from lib/spotcheck-evidence in sold-addr.js (not inlined) — keeps sold normalization in sync with cohort spot-check normalization across the codebase
- 15-01: snake_case field names in parsers preserved verbatim from spike (Phase 16 DB column contract; renaming would break Phase 16/17)
- 15-01: startsWith('searchSold(') and startsWith('displayAttributes(') key-scan idioms preserved — do not convert to exact-key lookups (Booli/Hemnet parametrize these query keys)

### Decisions

- 12-01: Mode A deterministic promote (priceAgrees + hasPhotos + likely-match → CONFIRMED_MATCH) ensures complete artifact without Anthropic API; price alone never confirms a match
- 12-01: confirmedMismatchRate denominator = adjudicated (match+mismatch), UNCERTAIN excluded; wilson95 copied verbatim (not exported from cohort-spotcheck.js)
- 12-02: execFileSync argv arrays (not shell strings) for child-process safety; Slack escalation flows only through cron-wrapper validate() — no custom sendSlack in the gate
- 12-02: Default --rate 0.20 (20% sample); --mode-b stubbed for Plan 12-03 Anthropic vision path
- 12-03: Lazy require('@anthropic-ai/sdk') inside getClient() — module loads cleanly without SDK/key; supports offline --smoke and Mode A fallback
- 12-03: Model default claude-sonnet-4-6 (Claude 4.x, vision-capable); ANTHROPIC_MODEL env overrides for higher-accuracy runs
- 12-03: Vision called only for suspect/low-signal pairs (cost gate T-12-11); null return on any error/missing key → Mode A fallback for that pair (T-12-12)

### Last Session

Stopped at: Phase 15-05 COMPLETE 2026-06-17. lib/sold-fetch-hemnet.js + scripts/hemnet-sold.js shipped (commits f2c143c, 20dceb3). Per-property /salda SaleCard search with URL builder, early-stop pagination, within-run cache, house/apt opts, MATCH-02 normAddr. --smoke 23 pass. Phase 15 ALL 5 PLANS COMPLETE.
Resume: Phase 15 complete. Next = /gsd-execute-phase 16 (sold-match DB schema + persistence).

### Decisions (Phase 14, 2026-06-12 overnight)

- 14: Identity-model verdict — CONFIRMED_MATCH needs ≥1 unit-level signal (exact fee / ≥2 distinct label-filtered shared photos / vision) + ≥2 total; price alone never confirms (Branch-2 fig leaf deleted)
- 14: Fee/floor contradictions → UNCERTAIN 'conflict' for human review, NEVER auto-MISMATCH (probe falsified auto-mismatch: fee drift on believed-true matches incl. 15647 at 5208vs4356; Booli≈80%-of-Hemnet cluster)
- 14: Floor tolerance ±0.5 (Booli halvtrappa half-floors); floor can contradict, never confirm
- 14: Gallery cap 6→20 (probe: 48% of shared-photo pairs had best match beyond 6); gate deletes images beyond index 6 post-dHash (disk)
- 14: Vision routing = first-pass-UNCERTAIN residue with galleries, VISION_MAX_CALLS=60 cap, default ON when ANTHROPIC_API_KEY set (prod cron line has no flags; --mode-a opts out)
- 14: dHash threshold stays 6; ≥2 distinct shared scenes (≥1 when either filtered side ≤2)
- 14: stale-cohort guard fixed — expects the just-ended listing week (cohort ids label the LISTING week); old guard would have false-alarmed every scheduled Monday
- 14: hemnet_url cross-link on Booli does NOT exist (spike 0/3) — Hemnet-match-cohort optimization path #1 dead

### Decisions (Phase 14.1 follow-up, 2026-06-12)

- 14.1: Delisted-page classification — removed listings return HTTP 200 tombstones; classify by Apollo listing-node typename FIRST (Hemnet: ≠ActivePropertyListing → delisted; Booli: no Listing: node → delisted), og:image/text only as fallback, so a live ad mentioning "borttagen" can't false-positive. page_status = {hemnet, booli} ∈ active|delisted|error stamped per pair at fetch time
- 14.1: Review-queue partition — UNCERTAIN with either side delisted is unreviewable: ONE digest summary line, NO spotcheck_review rows; 'error' (transient) and legacy no-page_status records STAY reviewable (noise over silent miss); unreviewable count in result_summary
- 14.1: Slack renderer bug found+fixed — bot read pair.dhash_min_dist/pair.vision_verdict which NEVER existed (gate stores pair.dhash.minDist/pair.vision.sharedPhoto); every Phase-13 message rendered "n/a". Now nested-first with flat fallbacks + verdict_reason line ("why is this pair in front of me")
- 14.1: Manual spot-check pack (scripts/make-manual-spotcheck.js) — operator eyeball pack from VERDICTS json, 28 pairs across all 7 funnel stages of W23; deltas.*_pct_diff are FRACTIONS (0.25=25%) despite the name

### Decisions (Phases 13.1 + 13.2, 2026-06-12)

- 13.1: D-11 REVERSED — removal is soft-delete (cohort_pairs.removed_at/removed_reason/removed_by via migrate-cohort-pairs-soft-delete.js); removeConfirmedMismatchPair = audit INSERT + UPDATE guarded `AND removed_at IS NULL`, NEVER DELETE (smoke asserts no DELETE); recovery = SET removed_at=NULL (runbook updated — old re-INSERT recipe was not executable)
- 13.1: removed_at IS NULL filters on tracking/refresh/sampling/reporting/export (cohort-track, booli/hemnet-targeted-refresh, cohort-spotcheck, weekly-view-report, cron-health-slack, export-views-wide, export-hb-ratio-xlsx, chart-hb-ratio, lib/hemnet-locations); NOT filtered: gate multi-unit address stamp (removed pair still signals multi-unit risk), poller by-id lookup (idempotency), repair-data (recovery must see all)
- 13.1: every reviewable pair gets its OWN Slack message (UNCERTAIN + MISMATCH, verdict-labelled header, own ts) — operator chose individual messages over threads 2026-06-11; postDigestMessage demoted to legacy/manual-only; unreviewable delisted pairs → one postInfoMessage, no review rows
- 13.1: poller partitionSharedTs guard — review rows sharing (channel, ts) are digest-era, never acted on, surfaced as sharedTsIgnored (protects against the 12 reviewable W23 rows sharing one ts)
- 13.2: stale-review aging — open rows unanswered > STALE_REVIEW_DAYS (default 7) escalate via poller validate() → Slack; rows adjudicated same-cycle excluded; delisted pairs never enter spotcheck_review so the nag is always answerable
- 13.2: transient-error retry/roll-forward DEFERRED with rationale — error pairs stay in the human queue (never dropped) + gate escalates fetchFailures>0 + stale alert prevents rot; retry infra needs cross-run pair-carry for a weekly cohort-scoped gate, marginal value low (W23: 0 error pairs)

### Decisions (Phase 13)

- 13-01: No FK from spotcheck_removed_pairs.pair_id to cohort_pairs.id — source row is deleted, plain INTEGER keeps the audit unblocked
- 13-01: UNIQUE(pair_id, cohort_id) on spotcheck_review implements D-12 dedup via ON CONFLICT DO NOTHING in upsertReviewMessage
- 13-01: Review-store exports take caller's pg client as first arg — no module-level DB connection opened (gate + poller pass their runJob client)
- 13-01: All SQL uses $1,$2,... parameterised placeholders — no string interpolation (T-13-02 SQL injection mitigation confirmed by grep gate)
- 13-02: D-02 threshold (<=6) NOT baked into spotcheck-dhash.js — threshold + per-pair logging deferred to the gate (Plan 04)
- 13-02: jimp v1.x named-class import ({ Jimp }) + resize({ w, h }) API; old probe syntax not reused
- 13-02: D-03 price guard closes adjudicate branch-3 false-positive; 15647->UNCERTAIN, 16347->CONFIRMED_MISMATCH (regression fixtures)
- 13-03: parseReactions extracted as pure helper for offline smoke — all 3 exports return null without throwing when SLACK_BOT_TOKEN absent (T-13-08)
- 13-03: Booli URLs use /annons/<booli_id> per COHORT-SPOTCHECK.md §4; SLACK_WEBHOOK_URL not referenced in new module (strict separation from Phase 12 alert path)
- 13-03: SLACK-REVIEW-SETUP.md runbook authored autonomously; Slack app creation deferred to operator at deploy time (Plan 06)
- 13-04: D-13 guard only on auto-resolved cohortId; --cohort operator override bypasses it
- 13-04: dHash threshold 6 not raised; only UNCERTAIN promoted to CONFIRMED_MATCH; CONFIRMED_MISMATCH never overridden (asymmetric rule)
- 13-04: vision advisory log placed before adjudicatePairs so p.vision is available for Slack post visionVerdict mapping
- 13-04: Slack review post non-fatal — null from postDigest/postReview skips upsert; VERDICTS still written on Slack outage
- 13-05: resolveReaction is pure (no I/O) — security-critical verdict logic isolated from network for offline unit testing
- 13-05: SLACK_ALLOWED_REACTORS empty/undefined → all reactors allowed (documented fallback; operator runbook instructs setting it before trusting auto-removal)
- 13-05: Contested message (allowed ✅ AND ❌) → action:none+conflict:true — never auto-delete on disagreement (T-13-12 tie-break)
- 13-05: runJob guarded behind !--smoke so the offline smoke path never connects to DB
- 13-06: Phase 12 weekly gate cron first-installed during this deploy (was documented in Phase 12 but never actually active on droplet until D-14 go-live)
- 13-06: SLACK_ALLOWED_REACTORS=U01KC1QT2BB set at go-live; poller all-reactors fallback documented as first-run only (T-13-20 mitigated)
- 13-06: SLACK_WEBHOOK_URL (Phase 12 threshold alerts) kept strictly separate from SLACK_BOT_TOKEN (review queue bot) — two distinct Slack paths, never conflated
