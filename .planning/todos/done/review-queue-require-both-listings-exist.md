---
title: Only route to human eyeball-review when BOTH listings still exist
priority: medium
area: cohort-spotcheck-gate
status: pending
created: 2026-06-11
resolves_phase: null
---
Don't ask a human to eyeball a pair when the Booli (or Hemnet) listing no longer exists — there's nothing to look at.

**Observed:** During the Phase 13 live test (2026-06-11, cohort 2026-W23), pairs like `pair 15440 [suspect] hemnet=ok booli=miss gallery[h=6 b=0] (booli-no-hero)` fall to UNCERTAIN and get posted to the Slack review digest. But `booli=miss` means the Booli listing is gone (delisted/sold) — a human opening it sees nothing to compare against the Hemnet listing. These are noise in the review queue.

**Desired behaviour:** The human eyeball-review queue should contain ONLY the genuinely ambiguous case:
- BOTH listings still exist (hemnet=ok AND booli=ok, both galleries non-empty), AND
- the dHash image comparison says the photos are DIFFERENT (not auto-confirmed), WHILE
- everything else (price / area / address) looks the SAME.

That is the "looks like the same property on paper, but the photos differ — is it really the same place?" case where a human adds value.

**Separate disposition for missing-listing pairs:** `booli=miss` / `hemnet=miss` (no listing to check) should NOT go to the eyeball digest. Give them their own bucket/handling — e.g. flag as "listing delisted" (likely sold/removed since the cohort was built) and either auto-handle or surface in a distinct, clearly-labelled list rather than the image-review queue.

**Where:** the review-posting filter in `cohort-spotcheck-gate.js` (the block that builds the UNCERTAIN digest + per-mismatch messages). Gate on `booli_gallery.length > 0 && hemnet_gallery.length > 0` (both exist) before adding a pair to the eyeball digest; divert no-listing pairs to a separate summary line.

---
**RESOLVED 2026-06-12 (Phase 14.1):** `spotcheck-photos.js` now stamps `page_status = { hemnet, booli }` ('active' | 'delisted' | 'error') per pair via `classifyHemnetPage`/`classifyBooliPage` (Apollo-typename-first, probe-calibrated against live removed pages). The gate partitions UNCERTAIN on it: either side 'delisted' → ONE summary line in the digest ("⚠ N pairs unreviewable — listing removed since cohort build"), no `spotcheck_review` rows. 'error' and legacy records stay reviewable per [[classify-fetch-outcomes-delisted-vs-error]]. Implemented the delisted-classification route rather than the gallery-length gate sketched above (gallery length can't distinguish a delisted page from a photo-less live page).
