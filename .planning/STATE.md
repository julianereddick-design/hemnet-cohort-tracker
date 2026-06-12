---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: Self-hosted scraper hardening
status: Code-complete — no active coding phase; operator-gated prod steps + decisions remain
stopped_at: "v2.1 (Phase 10) CODE-COMPLETE 2026-06-12 — 10-04 (export gap-aware fix + scripts/intel cleanup) and 10-05 (Pool & Flow repo retirement) shipped. Spot-check stream (12/13/13.1/13.2/14/14.1) + v2.2 market-totals (Phase 11) all previously shipped. Remaining is NOT coding: (1) operator-gated droplet steps for 10-05 (remove 4 Mon-09:00 crontab lines + DROP listing_gap_weekly/listing_flow_weekly + remove pool-flow-dashboard.html); (2) Mon 2026-06-15 06:30 UTC first unattended spot-check gate fire (live validation watch); (3) operator decision: spot-check 20%-vs-100% coverage ($4.32 vs $18.35/wk); (4) flagged booli-refresh coverage gap (5969 reported vs ~4097 refreshed) follow-up. Next coding work = a NEW milestone (none scoped yet)."
last_updated: "2026-06-12"
progress:
  # Scope = current milestone v2.1 (Phase 10 only). Prior block (5 phases / 9 plans /
  # 78%) was stale scaffolding that never recomputed as work shipped — corrected 2026-06-12.
  total_phases: 1
  completed_phases: 1
  total_plans: 5
  completed_plans: 5
  percent: 100
---

## Accumulated Context

### Roadmap Evolution

- Phase 12 added: Cohort match spot-check weekly QA gate (verify Booli↔Hemnet pairs are the same property; spec in repo `COHORT-SPOTCHECK.md`)

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
Resume: (1) OPERATOR-GATED droplet steps for 10-05 — remove the 4 Mon-09:00 crontab lines (keep weekly-view-report), `DROP TABLE listing_gap_weekly, listing_flow_weekly`, remove pool-flow-dashboard.html, and `git pull` the repo deletions; (2) Mon 2026-06-15 06:30 UTC first unattended spot-check gate fire (live validation); (3) decide spot-check 20%-vs-100% coverage; (4) flagged booli-refresh coverage-gap follow-up. No active coding phase — next coding work needs a new milestone.

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
