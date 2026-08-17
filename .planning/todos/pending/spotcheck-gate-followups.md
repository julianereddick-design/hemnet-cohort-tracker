---
title: Spot-check gate follow-ups after the silent-exit outage
priority: medium
area: spotcheck
status: pending
created: 2026-08-17
resolves_phase: null
---
The gate produced nothing from 2026-07-27 to 2026-08-10. Root cause was a never-settling
promise in `downloadImage` (`lib/spotcheck-photos.js`) — `res.pipe(f)` neither finishes nor
errors the destination when the source is destroyed mid-body, so a truncated image download
hung its worker, `Promise.all` never resolved, and node **exited 0** with `main()` still
pending, skipping the artifact write-back and printing nothing.

Fixed and deployed in `8496706` (response-stream error handlers + a non-unref'd 60s deadline,
with regression tests verified to fail against the pre-fix file). The 51-row stale review queue
was closed as `CLEARED_STALE`. What remains:

**1. Re-run the gate to resurface the suspected false matches.** 24 of the cleared rows carried
`vision_verdict = MISMATCH`. Clearing the queue administratively did **not** remove those pairs,
so any that really are bad matches are still in the cohort feeding view data. The evidence was
1–2 months old, so re-running the gate on a current cohort is the honest way to re-derive them
rather than acting on stale verdicts. First clean run after the fix is Mon 06:30 UTC.

**2. Reword the enrichment guard's error message** (`cohort-spotcheck-gate.js`, ~line 223). It
asserts `spotcheck-photos.js likely died before writing galleries back`. That diagnosis is wrong
and actively misled the investigation: the child ran to completion on 303 of 305 pairs and
exited 0. It should describe the observable fact ("artifact has no galleries and PHOTOS-*.md is
absent") and list *both* candidate causes — a crash, or a silent exit-0 with work still pending —
rather than confidently naming one. Consider also having the gate assert the child actually
wrote something, and capture the child's exit code explicitly.

**3. `cohort-spotcheck-gate` is not in the daily health report's registry**, which is why four
consecutive weekly failures were never surfaced there. Covered by
`health-check-coverage-and-thresholds.md`; noted here for the cross-reference.

**4. The spot-check image prune is still not running.** W30 3,113 → W31 7,177 → W32 12,407 JPGs
and climbing. Disk is currently fine (4.1G free) but the *original* Jul 27 failure was a genuine
`ENOSPC` on `mkdir .../photos/pair20024`, so this is a live re-occurrence risk, not hygiene.

**Recognising this class of bug again:** silent exit 0, no stack trace, and a suspiciously small
time gap between the last work log line and the caller resuming (34 ms here) means the event loop
drained with a promise still pending — not a crash. Any `new Promise` whose only resolve paths
are stream events is a candidate.
