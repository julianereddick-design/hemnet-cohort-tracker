---
phase: 13-spot-check-image-confirmation-and-human-review-loop
plan: "02"
subsystem: spotcheck-image-hash
tags: [dhash, image-hash, adjudication, price-guard, jimp, correctness]
dependency_graph:
  requires: [13-01]
  provides: [lib/spotcheck-dhash.js, patched-lib/spotcheck-adjudicate.js]
  affects: [cohort-spotcheck-gate.js, spotcheck-reaction-poller.js]
tech_stack:
  added: [jimp@^1.6.1]
  patterns: [--smoke self-test, nested-loop cross-compare, price-guard rule]
key_files:
  created:
    - lib/spotcheck-dhash.js
  modified:
    - lib/spotcheck-adjudicate.js
    - package.json
    - package-lock.json
decisions:
  - "D-02: dHash ≤6 threshold NOT baked into the lib module — threshold + distance logging live in the gate (Plan 04)"
  - "D-03: price-agreeing pair can never become CONFIRMED_MISMATCH via branch 3 — !priceAgrees guard added"
  - "D-04: prior-sale-photo pairs (e.g. 15647) end UNCERTAIN, enforced by D-03 guard + regression fixture"
  - "jimp v1.x import uses named class destructure ({ Jimp }) and resize({ w, h }) API — probe's old v0.x syntax not reused"
metrics:
  duration_minutes: 15
  completed_date: "2026-06-11"
  tasks_completed: 3
  tasks_total: 3
  files_changed: 4
---

# Phase 13 Plan 02: dHash lib + D-03 price guard Summary

**One-liner:** Pure-JS dHash cross-compare module (jimp v1.x) + price-divergence guard closing the adjudication false-positive that would have flagged prior-sale-photo matches as CONFIRMED_MISMATCH.

## Tasks Completed

| # | Task | Commit | Outcome |
|---|------|--------|---------|
| 1 | Add jimp as a real dependency | 6900202 | `jimp@^1.6.1` in `dependencies`; `require('jimp')` exits 0 |
| 2 | Create lib/spotcheck-dhash.js | 5671fd6 | `--smoke`: 7 pass, 0 fail; exports `minDHashDistance` |
| 3 | Fix D-03 price guard in adjudicate.js | 8e82377 | `--smoke`: 15 pass, 0 fail; both anchor fixtures pass |

## Verification

```
node lib/spotcheck-dhash.js --smoke     → smoke: 7 pass, 0 fail
node lib/spotcheck-adjudicate.js --smoke → smoke: 15 pass, 0 fail
node -e "require('jimp')"               → jimp OK
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] jimp v1.x API change: named-class import + resize({ w, h })**

- **Found during:** Task 2 (smoke showed `Jimp.read is not a function` with default export)
- **Issue:** The probe (`spotcheck-phash-probe.js`) was written for jimp v0.x (`const Jimp = require('jimp')` + `resize(9, 8)`). jimp v1.x exports a named `Jimp` class; the default export no longer has `.read`. Resize signature changed from positional args to `{ w, h }` object.
- **Fix:** `lib/spotcheck-dhash.js` uses `const { Jimp } = require('jimp')` and `resize({ w: 9, h: 8 })`. The probe script (`scripts/spotcheck-phash-probe.js`) was NOT modified (out of scope — pre-existing script; would break independently if run against v1.x, logged to deferred items).
- **Files modified:** `lib/spotcheck-dhash.js` only
- **Commit:** included in 5671fd6

## Known Stubs

None — both modules are fully wired. `minDHashDistance` computes real Hamming distances on real image files; it only returns the sentinel `{minDist:64}` when files are empty/unreadable (by design). The ≤6 threshold is intentionally deferred to the gate (Plan 04).

## Threat Flags

No new network endpoints, auth paths, or trust-boundary crossings introduced. Threat mitigations T-13-05 and T-13-06 confirmed implemented:

- **T-13-05 (DoS via corrupt image):** `hashAll` wraps each `Jimp.read` in try/catch, logs a `console.warn`, and skips the file. `minDHashDistance` returns `{minDist:64}` sentinel rather than throwing.
- **T-13-06 (Logic tampering — false CONFIRMED_MISMATCH):** `!priceAgrees` guard in branch 3 closes the latent false-positive. Regression-tested with pair 15647 (→UNCERTAIN) and pair 16347 (→CONFIRMED_MISMATCH).

## Self-Check: PASSED

Files exist:
- `lib/spotcheck-dhash.js` — FOUND
- `lib/spotcheck-adjudicate.js` — FOUND (modified)

Commits exist:
- 6900202 — FOUND
- 5671fd6 — FOUND
- 8e82377 — FOUND
