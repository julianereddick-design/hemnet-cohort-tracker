---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: Self-hosted scraper hardening
status: In progress
stopped_at: Phase 13, Plan 03 complete
last_updated: "2026-06-11T12:00:00.000Z"
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 9
  completed_plans: 9
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

Stopped at: Phase 13 Plan 03 complete — Slack bot-token I/O lib + operator runbook (lib/spotcheck-slack-bot.js + SLACK-REVIEW-SETUP.md)
Resume: Phase 13, Plan 04

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
