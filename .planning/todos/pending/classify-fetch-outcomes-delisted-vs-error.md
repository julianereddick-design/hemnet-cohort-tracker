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
