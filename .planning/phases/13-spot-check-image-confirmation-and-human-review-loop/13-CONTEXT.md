# Phase 13: Spot-check image confirmation and human review loop - Context

**Gathered:** 2026-06-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the Phase 12 spot-check gate actually **catch** false matches (today its Mode A can only
produce CONFIRMED_MATCH/UNCERTAIN and a structurally-zero false-match rate). This phase adds:
a deterministic shared-image check (dHash), Claude vision as an **advisory** adjudicator on
`suspect` pairs, a Slack review queue with both ad links + emoji-reaction feedback, a daily
poller that applies those reactions, and a dataset-correction path that removes confirmed false
pairs from `cohort_pairs`. Plus two correctness guards (mismatch-rule price guard; current-ISO-week
guard). Phase 12's gate goes **live with this phase**.

**Out of scope:** the matcher fix itself (COHORT-SPOTCHECK.md §9 — still deferred); Slack
interactive buttons; raising the dHash threshold or auto-applying vision (both are post-calibration,
data-driven follow-ups).

</domain>

<decisions>
## Implementation Decisions

### Pipeline & adjudication
- **D-01:** Per-pair flow: sample 20% → fields/triage → pull galleries → **dHash** shared-image
  check → **vision (advisory)** on `suspect` pairs → anything unresolved → **Slack review queue**.
- **D-02:** dHash deterministic check using **jimp** (pure-JS, no native build). Auto-confirm a pair
  as CONFIRMED_MATCH only when the closest Booli↔Hemnet image distance is **≤ 6** (conservative;
  near-identical only). **Log every pair's min-distance + final outcome** so the threshold can be
  raised (likely toward ≤10) from real data after a few weeks. `scripts/spotcheck-phash-probe.js`
  is the reference implementation / calibration tool.
- **D-03:** **Fix the mismatch rule** (`lib/spotcheck-adjudicate.js`): CONFIRMED_MISMATCH MUST
  require **price/area divergence AND no shared photo** — a price-agreeing pair can never become a
  confirmed mismatch. (Today's branch fires on `suspect && sharedPhoto===false` with no price check;
  see 13-FINDINGS.md.) Latent in Mode A; bites the moment vision runs.
- **D-04:** **Prior-sale-photo pairs** (galleries from different sales, e.g. pair 15647) can't be
  photo-confirmed → they end **UNCERTAIN**, never MISMATCH. The match rests on field evidence
  (identical price + address + date).

### Vision (advisory, confidence-building)
- **D-05:** Claude vision runs on `suspect` pairs but is **advisory only** — it posts its verdict +
  reasoning to Slack; the **human confirms via reaction**. Vision never auto-applies a verdict in
  this phase.
- **D-06:** **Log vision's verdict alongside the human's** for every reviewed pair, to measure
  vision's hit-rate over **4–6 weeks**, after which we decide whether to let it auto-apply. Model:
  `claude-sonnet-4-6` (carried from Phase 12; overridable via `ANTHROPIC_MODEL`).

### Slack review queue
- **D-07:** After each run, post a **weekly digest** message (all pairs needing review: pair_id,
  address, both ad URLs, dHash + vision summary) **plus an individual message per vision-flagged
  MISMATCH** so the high-stakes ones stand out and can be reacted to.
- **D-08:** Feedback is **Slack emoji reactions**: ✅ = confirm mismatch (→ remove pair) · ❌ =
  override, it's a valid match (→ keep + record) · ❓ = unsure (→ leave UNCERTAIN, re-surfaces).
- **D-09:** Review messages are posted via a **Slack bot token** (`chat.postMessage`; scopes
  `chat:write` + `reactions:read`) so the message timestamp can be polled for reactions — the
  existing write-only `SLACK_WEBHOOK_URL` cannot read reactions and is kept only for the Phase 12
  threshold/fetch-failure alerts. New env var (e.g. `SLACK_BOT_TOKEN`). **The phase MUST produce a
  full step-by-step Slack-app setup runbook** (create app, add scopes, install, invite bot to the
  channel) — the operator will follow it.

### Feedback loop & dataset correction
- **D-10:** A **daily poller** (its own `cron-wrapper.runJob` job) reads reactions on open review
  messages and applies verdicts.
- **D-11:** On ✅ → **hard-remove the pair from `cohort_pairs`**, but FIRST write an audit record
  (pair_id, booli_id, hemnet_id, cohort_id, vision_verdict, human_verdict, reactor, timestamp,
  reason) so the removal is recoverable/auditable. On ❌ → keep the pair + record the override. On
  ❓ → leave UNCERTAIN.
- **D-12:** Persist each review message's ref (channel, ts, pair_id, cohort, vision_verdict) so the
  poller knows what to check; **dedup** so an already-adjudicated pair is never re-surfaced or
  re-pinged on a later run.

### Guards & deploy sequencing
- **D-13:** **Current-ISO-week guard** — the gate verifies the resolved cohort matches the current
  ISO week; if cohort-create hasn't produced this week's cohort yet, **skip + alert** rather than
  silently re-checking last week's cohort. (The Mon 06:00→06:30 buffer is unverified.)
- **D-14:** Phase 12's gate **goes live with this phase** — no silent Mode-A-only cron deploy first;
  the gate is scheduled when it does something useful (image confirmation + review loop).

### Claude's Discretion
- Storage shape — new tables (e.g. `spotcheck_review` for message refs + verdicts;
  `spotcheck_removed_pairs` for the audit trail) vs columns on existing tables. Choose to match
  project conventions (raw `pg` via `db.js`; droplet has no psql).
- Exact dHash parameters (hash size, distance metric) per the probe; poller structure; reaction
  edge-cases (multiple reactions on one message, which reactor counts, late reactions).
- How vision-vs-human agreement is surfaced for the 4–6-week hit-rate review (log table vs a small report).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec & this phase's evidence
- `COHORT-SPOTCHECK.md` — §3 confirmation rule, §4 `/annons/<booli_id>` photo fix, §7 weekly
  process, §9 deferred matcher fix.
- `.planning/phases/13-spot-check-image-confirmation-and-human-review-loop/13-FINDINGS.md` — the
  dHash/vision experiment, the mismatch-rule bug, the two anchor pairs, design forks.
- `.planning/phases/12-cohort-match-spot-check-weekly-qa-gate/12-CONTEXT.md` — Phase 12 locked
  decisions (20% sample, >5% threshold, reuse-not-rebuild, Mode A/B).

### Code to extend / fix
- `cohort-spotcheck-gate.js` — the weekly gate orchestrator to extend (dHash + advisory vision + review queue).
- `lib/spotcheck-adjudicate.js` — **mismatch-rule price-guard fix (D-03)**.
- `lib/spotcheck-vision.js` — the Claude-vision adjudicator to wire as advisory.
- `lib/spotcheck-summary.js` — verdict/summary contracts.
- `scripts/spotcheck-phash-probe.js` — dHash reference + calibration tool.
- `cron-wrapper.js` — `runJob` contract + existing `SLACK_WEBHOOK_URL` alert path.
- `cohort-create.js` — writes `cohort_pairs` (the removal target); upstream job timing.
- `db.js` — pg client (createClient).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `cohort-spotcheck-gate.js` + the `lib/spotcheck-*` modules + `cron-wrapper.runJob` + `db.js` — the
  whole Phase 12 pipeline is the base; Phase 13 extends it, doesn't rebuild.
- `scripts/spotcheck-phash-probe.js` — working dHash (and pHash) cross-compare to lift into a `lib/` module.

### Established Patterns
- `lib/` modules carry `--smoke` self-tests; cron jobs run under `cron-wrapper.runJob` and log to `cron_job_log`.
- Slack today is **outbound-only** (write-only `SLACK_WEBHOOK_URL`). Reading reactions (bot token +
  poller) is a **new inbound capability** for this repo — the main new piece of infra.

### Integration Points
- `cohort_pairs` — confirmed-mismatch removal target (+ audit table).
- `cron_job_log` — run logging for the gate and the new daily poller.
- Weekly cron after `cohort-create` (Mon 06:30 UTC) + a new daily reaction-poller schedule.

</code_context>

<specifics>
## Specific Ideas

- **Regression fixtures (from today's experiment):** pair **15647** (Storvretsvägen — identical
  price, prior-sale photos) must resolve to **UNCERTAIN**; pair **16347** (Bollmoravägen — different
  units, price diverges 16%) must resolve to **CONFIRMED_MISMATCH**. URLs in 13-FINDINGS.md.
- dHash calibration anchors: clean shared-photo matches scored ≤8, the true mismatch 22–24 (n=6).
- Measure-first ethos throughout: dHash logs distances; vision logs agreement vs human — both
  reviewed after ~4–6 weeks before loosening.

</specifics>

<deferred>
## Deferred Ideas

- **Raise the dHash auto-confirm threshold** (≤6 → ~≤10) once live distance data justifies it.
- **Let vision auto-apply** verdicts once its 4–6-week hit-rate is proven.
- **Matcher fix** (COHORT-SPOTCHECK.md §9 — area/price tie-break in `cohort-create.js`) — still a
  separate future phase; this phase measures/corrects, it doesn't fix the matcher.
- **Slack interactive buttons** (vs emoji reactions) — heavier infra, not now.

</deferred>

---

*Phase: 13-spot-check-image-confirmation-and-human-review-loop*
*Context gathered: 2026-06-11*
