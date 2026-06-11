# Phase 13: Spot-check image confirmation and human review loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-11
**Phase:** 13-spot-check-image-confirmation-and-human-review-loop
**Areas discussed:** Vision's role, Cohort dataset fix, Slack review queue, Feedback mechanism, Reaction vocabulary, Poller cadence, Bot token, Image lib, dHash threshold

---

## Vision's role for suspect pairs

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-adjudicate suspects | Vision decides MATCH/MISMATCH; unsettled → UNCERTAIN | |
| Vision advises, you confirm | Vision posts verdict+reasoning, human confirms | ✓ |
| Skip vision for now | dHash only; all suspects to human | |

**User's choice:** Vision advises, you confirm.
**Notes:** Wants to build confidence in vision first. Vision runs on suspects, human confirms via reaction; measure vision's hit-rate over 4–6 weeks, then decide whether to trust/tweak. → requires logging vision verdict vs human verdict.

## Cohort dataset fix on confirmed MISMATCH

| Option | Description | Selected |
|--------|-------------|----------|
| Mark + exclude (non-destructive) | Status flag; analysis filters out | |
| Hard-remove from cohort_pairs | Delete the false pair | ✓ |
| Flag only, no dataset change | Record verdict, manual cleanup later | |

**User's choice:** Hard-remove from cohort_pairs.
**Notes:** Claude added: write an audit record before delete so removal is recoverable/auditable.

## Slack review queue format

| Option | Description | Selected |
|--------|-------------|----------|
| One weekly digest | Single message, block per pair | |
| One message per pair | Separate message each | |
| Digest + per-pair for mismatches | Digest + individual per vision-flagged mismatch | ✓ |

**User's choice:** Weekly digest, then individual messages per mismatch — to react and feed perspective back into the loop.

## Feedback mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| CLI command (paste from Slack) | Prefilled command per pair | |
| Slack buttons/reactions | Confirm/override via reaction | ✓ |
| Edit a review file | Fill verdicts, script ingests | |

**User's choice:** Slack reactions.
**Notes:** Requires a Slack bot token (reactions can't be read via the write-only webhook) — accepted.

## Reaction vocabulary

| Option | Description | Selected |
|--------|-------------|----------|
| ✅ confirm / ❌ override / ❓ unsure | 3-way | ✓ |
| ✅ confirm / ❌ override only | 2-way | |
| Describe my own | — | |

**User's choice:** ✅ confirm (→ remove) / ❌ override (→ keep) / ❓ unsure (→ leave UNCERTAIN).

## Poller cadence

| Option | Description | Selected |
|--------|-------------|----------|
| Daily poller | Daily cron reads reactions, applies verdicts | ✓ |
| Next weekly run | Read last week's reactions before posting | |
| On-demand command | Manual trigger | |

**User's choice:** Daily poller.

## Slack bot token

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, I'll create it | Operator sets up app + token | |
| Yes, but document it fully | Same + full setup runbook | ✓ |
| Reconsider — avoid bot token | Fall back to CLI | |

**User's choice:** Yes — with a full step-by-step Slack-app setup runbook.

## Image library

| Option | Description | Selected |
|--------|-------------|----------|
| jimp (pure-JS) | No native build, proven in probe | ✓ |
| sharp (native) | Faster, native dep | |

**User's choice:** jimp.

## dHash auto-confirm threshold

| Option | Description | Selected |
|--------|-------------|----------|
| Conservative ≤6 + log all | Near-identical only; log distances to calibrate | ✓ |
| Moderate ≤10 + log all | Probe operating point now | |
| Shadow mode first | No auto-confirm; log only | |

**User's choice:** Deferred to Claude ("what do you think?") → Claude recommended and locked **Conservative ≤6 + log all** (safe start, calibrate threshold from real data over a few weeks). Same measure-first spirit as the vision hit-rate plan.

## Claude's Discretion
- Storage shape (new tables vs columns) for review message-refs, verdicts, and the removed-pair audit trail.
- Exact dHash params, poller structure, reaction edge-cases, vision-vs-human agreement reporting.

## Deferred Ideas
- Raise dHash threshold (≤6 → ~≤10) after live calibration.
- Let vision auto-apply once hit-rate proven (4–6 weeks).
- Matcher fix (COHORT-SPOTCHECK.md §9) — separate future phase.
- Slack interactive buttons (vs reactions).
