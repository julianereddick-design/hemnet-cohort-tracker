---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: Self-hosted scraper hardening
status: Ready to execute
stopped_at: "Re-plan 2026-06-11 — spot-check stream re-cut into Phases 13.1 / 13.2 / 14 in ROADMAP.md from the 7 pending todos (operator decisions: spot-check stream before Phase 10 remainder; UNCERTAIN pairs as individual Slack messages; D-11 reversed to soft-delete; Phase 14 vision routing sized by N=200+ probe first; EXECUTION ORDER SWAPPED to 14 → 13.1 → 13.2 — verdict trust before loop actionability)"
last_updated: "2026-06-11T11:20:56.832Z"
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 9
  completed_plans: 7
  percent: 78
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

Stopped at: Re-plan 2026-06-11 — spot-check stream re-cut into Phases 13.1 / 13.2 / 14 in ROADMAP.md from the 7 pending todos (operator decisions: spot-check stream before Phase 10 remainder; UNCERTAIN pairs as individual Slack messages; D-11 reversed to soft-delete; Phase 14 vision routing sized by N=200+ probe first; EXECUTION ORDER SWAPPED to 14 → 13.1 → 13.2 — verdict trust before loop actionability)
Resume: Plan Phase 14 (gsd-plan-phase) — first plan is the N=200+ sizing/trust probe; interim Slack rule (no digest reactions, no ✅-removal trust) stands until 13.1

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
