---
title: Classify fetch outcomes — delisted vs transient-error vs no-photos — and route each differently
priority: high
area: cohort-spotcheck-gate
status: pending
created: 2026-06-11
resolves_phase: null
---
A `miss` today conflates two very different situations and risks turning review noise into silent misses.

**The problem (case 4 from the false-negative analysis):** `booli=miss` / `hemnet=miss` currently looks the same whether the listing is (a) genuinely **delisted/sold** (gone for good — nothing to review) or (b) **temporarily unfetchable** (transient Oxylabs/network error — the listing still exists). If we naively divert all `miss` pairs out of the review queue (per [[review-queue-require-both-listings-exist]]), a transient error on a real false-match pair means it is **dropped and never checked** — a Type-2 silent miss. So we must not trade review noise for silent misses.

**Desired behaviour:** classify each side's fetch result into at least three states and route accordingly:
- **delisted** (HTTP 404 / "gone" page / removed marker) → separate "listing delisted" bucket, NOT the eyeball queue; likely sold/removed since cohort build.
- **transient-error** (timeout, 5xx, network, Oxylabs failure) → **retry** (next run or short backoff); do NOT treat as delisted, do NOT drop the pair. Surface a count so persistent fetch failures are visible.
- **live-but-no-photos** (`booli-no-hero`: page loads, gallery empty) → can't dHash, but price/area still usable; keep in adjudication, only divert from the *image* review.

**Where:** the fetch layer in `cohort-spotcheck.js` (the part that sets hemnet/booli status) needs to emit a richer status enum, and `cohort-spotcheck-gate.js` review-posting + dHash gating must branch on it. Pairs surviving as transient-error should roll forward to the next run rather than silently resolving.

Companion to [[review-queue-require-both-listings-exist]] — that one filters the queue; this one makes sure filtering doesn't hide real misses.

---
**PARTIALLY RESOLVED 2026-06-12 (Phase 14.1):** the richer status enum now exists — `spotcheck-photos.js` stamps `page_status = { hemnet, booli }` with 'active' | 'delisted' (probe-calibrated classifiers in `lib/spotcheck-photos.js`) | 'error' (transport throw), and the gate diverts ONLY 'delisted' pairs from the review queue; 'error' pairs stay reviewable (never silently dropped). **Still open:** transient-error retry/short-backoff and roll-forward to the next run, plus a persistent-fetch-failure visibility count. Until then a transient-error pair is reviewable noise rather than a silent miss — safe but unrefined.

**13.2 disposition (2026-06-12):** the safety property is fully covered without retry infrastructure — error pairs land in the per-pair review queue (13.1), so a human sees them within the week and the 7-day stale alert (13.2c) prevents rot; the gate already escalates `fetchFailures > 0` to Slack. Retry/roll-forward remains DEFERRED as a nice-to-have: it would need cross-run pair-carry state for a weekly cohort-scoped gate, and the human-review fallback makes its marginal value low at current error rates (W23: 0 error-state pairs). Revisit only if error-pair volume becomes review noise.
