---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Sold-match pipeline
status: planning
stopped_at: "Phase 15 context gathered 2026-06-17 (.planning/phases/15-sold-data-ingestion-library/15-CONTEXT.md). Decisions: detail-fetch recon-gated/prefer-cheaper (apartments-fee-window default; all-records detail only if 'sold in advance' is detail-only AND spend re-confirmed); sold-in-advance best-effort/never-block with a recon-first task; module layout + spike-script disposition = Claude's discretion (new lib/sold-*.js, spike scripts → thin wrappers + cleanup). v3.0 roadmap (Phases 15–17) created same day, 15/15 reqs mapped. Prior: v2.1/v2.2 + spot-check stream shipped (Accumulated Context below). Next: /gsd-plan-phase 15."
last_updated: "2026-06-17"
progress:
  # Scope = current milestone v3.0 (Phases 15–17). Plan totals TBD until each phase is planned.
  total_phases: 3
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

## Current Position

**Phase:** 15 — Sold-data ingestion library (context gathered, not yet planned)
**Plan:** None
**Status:** planning — Phase 15 CONTEXT.md written, ready for /gsd-plan-phase 15
**Progress:** ░░░░░░░░░░ 0% (0/3 phases)

**Milestone v3.0 phases:**
- [ ] Phase 15 — Sold-data ingestion library (SOLD-01..05, MATCH-02, CONFIG-03)
- [ ] Phase 16 — Sold-match DB schema + persistence (DB-01..03)
- [ ] Phase 17 — Match pipeline orchestration (MATCH-01/03/04, CONFIG-01/02)

**Next:** `/gsd-plan-phase 15`

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

### Decisions

- 12-01: Mode A deterministic promote (priceAgrees + hasPhotos + likely-match → CONFIRMED_MATCH) ensures complete artifact without Anthropic API; price alone never confirms a match
- 12-01: confirmedMismatchRate denominator = adjudicated (match+mismatch), UNCERTAIN excluded; wilson95 copied verbatim (not exported from cohort-spotcheck.js)
- 12-02: execFileSync argv arrays (not shell strings) for child-process safety; Slack escalation flows only through cron-wrapper validate() — no custom sendSlack in the gate
- 12-02: Default --rate 0.20 (20% sample); --mode-b stubbed for Plan 12-03 Anthropic vision path
- 12-03: Lazy require('@anthropic-ai/sdk') inside getClient() — module loads cleanly without SDK/key; supports offline --smoke and Mode A fallback
- 12-03: Model default claude-sonnet-4-6 (Claude 4.x, vision-capable); ANTHROPIC_MODEL env overrides for higher-accuracy runs
- 12-03: Vision called only for suspect/low-signal pairs (cost gate T-12-11); null return on any error/missing key → Mode A fallback for that pair (T-12-12)

### Last Session

Stopped at: v2.1 (Phase 10) CODE-COMPLETE 2026-06-12. Shipped 10-04 (export-views-wide gap-aware incremental fix; deleted 16 spent one-off scripts + dead `migrate-booli-listing-drop-agent-fk.js` + 7 verf-log dirs + stray `.clone`; corrected stale SLACK_WEBHOOK "not configured" intel claims; Job C Final: line emits `jobStatus` not `status`) and 10-05 (deleted the 4 pre-v2.0 Pool & Flow scripts + `setup-chart-cron.sh` from the repo; `weekly-view-report.js` + the :3800 `view-data-server.js` kept). Also this session: fixed `booli-targeted-refresh` times_viewed NOT-NULL worker errors (COALESCE, commit 3b0f478, deployed) and confirmed the cohort-track null-jump alert was benign sell-through.
Resume: v2.1 fully closed (repo + droplet). No active coding phase. Open items, none coding: (1) Mon 2026-06-15 06:30 UTC first unattended spot-check gate fire (live validation watch); (2) decide spot-check 20%-vs-100% coverage; (3) flagged booli-refresh coverage-gap follow-up. NEW coding work scoped as milestone v3.0 (Sold-match pipeline) on 2026-06-17 — see Current Position above; next = /gsd-plan-phase 15.

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
