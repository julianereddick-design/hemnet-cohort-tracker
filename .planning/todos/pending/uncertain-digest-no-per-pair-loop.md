---
title: UNCERTAIN digest has no per-pair feedback loop — one reaction hits all pairs
priority: high
area: cohort-spotcheck-gate + spotcheck-reaction-poller
status: pending
created: 2026-06-11
resolves_phase: null
---
The UNCERTAIN review path is fundamentally broken: a single Slack reaction on the digest is applied to EVERY pair in it.

**Root cause (cohort-spotcheck-gate.js lines 320-329):** UNCERTAIN pairs are posted as ONE `postDigestMessage`, which returns ONE `ts`. The code then loops over all uncertain pairs and persists each `spotcheck_review` row with that SAME `ts`. The poller (`spotcheck-reaction-poller.js`) reads reactions per row via `getReactions(channel, ts)` — but all rows share the one digest ts, so they all see the same reaction set and `resolveReaction` returns the same action for every pair.

**Consequence:** one ✅ on the digest → poller tries to **remove ALL** uncertain pairs; one ❌ → marks them ALL adjudicated/keep; one ❓ → leaves all. A human cannot say "pair 7 is a mismatch, the other 19 are fine." Reactions are message-level; the digest collapses N pairs into one message. This is the bulk of review volume (e.g. test run: 20 UNCERTAIN vs 3 MISMATCH), so most of the human loop doesn't function — and reacting on the digest is actively dangerous.

**Fix options (pick one):**
1. **Threaded per-pair messages** — post the digest header, then one threaded reply per pair (each gets its own `ts`); react on the thread message. Keeps the channel tidy (collapsed thread) while giving each pair an addressable id. Lowest-infra fit with the current reaction model.
2. **Individual messages per UNCERTAIN pair** (like mismatches) — simplest code change, but 20+/week is channel spam.
3. **Slack interactive components (buttons per pair in one message)** — proper per-pair actions in a single message, but needs Slack interactivity + a request endpoint (more infra).
4. Make the digest **informational only** (don't persist its pairs as actionable rows) and route pairs that truly need a verdict to per-pair messages.

**Interim safety:** until fixed, do NOT react on the digest message — only the individual MISMATCH messages are per-pair safe. Consider having the poller ignore review rows whose `ts` is shared by >1 pair as a guard. Related: [[review-queue-require-both-listings-exist]] (many digest entries are un-reviewable anyway).
