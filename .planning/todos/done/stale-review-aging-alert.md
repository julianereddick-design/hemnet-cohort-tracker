---
title: Stale-review aging alert — flag UNCERTAIN review items with no reaction after N days
priority: medium
area: spotcheck-reaction-poller
status: pending
created: 2026-06-11
resolves_phase: null
---
An UNCERTAIN pair that nobody ever reacts to sits in the queue forever — a Type-2 miss by neglect.

**The problem (case 17 from the false-negative analysis):** the review loop depends on a human reacting ✅/❌/❓. If no one reacts, `spotcheck_review` rows with `human_verdict IS NULL` accumulate silently and the underlying pair (possibly a real false match) is never adjudicated or removed. The poller currently only acts on rows that HAVE reactions.

**Desired behaviour:**
- Track `created_at` on open review rows (already stored) and, in the daily poller or a small weekly digest, **surface review items with no reaction after N days** (e.g. 7) as an aging/escalation alert to Slack — "3 review items unanswered for >7 days."
- Optionally re-ping or summarise the backlog so it doesn't grow unbounded.
- Distinguish genuinely-unanswerable items (the delisted/`miss` pairs from [[review-queue-require-both-listings-exist]]) so they aren't counted as "ignored by a human" — they need a different disposition, not a nag.

**Where:** `spotcheck-reaction-poller.js` (it already reads open review rows via `getOpenReviewMessages`); add an aging check + Slack summary. Pairs with both listings missing should be excluded from the nag and routed per the fetch-outcome classification ([[classify-fetch-outcomes-delisted-vs-error]]).
