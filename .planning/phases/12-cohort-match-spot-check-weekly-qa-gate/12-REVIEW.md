---
phase: 12-cohort-match-spot-check-weekly-qa-gate
reviewed: 2026-06-10T14:30:00Z
depth: deep
files_reviewed: 6
files_reviewed_list:
  - lib/spotcheck-adjudicate.js
  - lib/spotcheck-summary.js
  - cohort-spotcheck-gate.js
  - lib/spotcheck-vision.js
  - package.json
  - .env.example
findings:
  critical: 1
  warning: 4
  info: 2
  total: 7
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-06-10T14:30:00Z
**Depth:** deep
**Files Reviewed:** 6
**Status:** issues_found

## Summary

The Phase 12 implementation is structurally sound: the adjudication decision order is correct,
the Wilson CI denominator uses adjudicated (MATCH+MISMATCH) exclusively as specced, the
Mode A deterministic pipeline produces a complete artifact without the API, Mode B is
correctly gated behind both `--mode-b` AND `ANTHROPIC_API_KEY`, and escalation flows entirely
through `validate()` → cron-wrapper with no hand-rolled Slack. The confirmation rule (price
alone never confirms; logic asymmetric) is faithfully implemented and comprehensively smoke-tested.

One BLOCKER was found: the `--smoke` block in `spotcheck-vision.js` runs its async assertions
inside an unawaited IIFE that provides no top-level unhandled-rejection safety net when running
standalone. A thrown error inside `checkAsync` that is caught inside the harness is fine, but
an unexpected throw in the outer IIFE body (e.g. a future edit) would let the process drain and
exit 0 silently, giving a false-green smoke signal. The fix is one line.

Four WARNINGS cover: (1) the cost-gate sending `low-signal` pairs to vision when they can never
yield CONFIRMED_MISMATCH (wasted API spend), (2) a hardcoded model-version string that will
break when Anthropic deprecates it, (3) `--threshold 0` silently resets to 0.05 instead of
treating zero as "always escalate", and (4) a missing try/catch around
`fs.readFileSync(jsonPath)` / `JSON.parse` in the gate orchestrator.

Two INFO items note minor inconsistencies.

---

## Critical Issues

### CR-01: `spotcheck-vision.js` smoke async-IIFE has no unhandled-rejection guard — false-green smoke possible

**File:** `lib/spotcheck-vision.js:211`

**Issue:** The `--smoke` block wraps all async assertions inside an immediately-invoked async
function `(async () => { ... })()` without attaching a `.catch()`. The three async assertions
inside are individually wrapped by `checkAsync` (which catches), so the normal path is fine.
However, if any statement *outside* a `checkAsync` call in the IIFE throws (e.g. a future
coding error in setup/teardown code like line 259's key-restore), the unhandled rejection is
not caught, the `process.exit` on line 262 is never reached, and Node exits with code 0 once
the event loop drains. A CI or pre-deploy smoke check would report green on a broken test.

This is not hypothetical: the `savedKey` restore at line 259 is already outside any `checkAsync`
guard. If `savedKey` restore threw, exit would be swallowed.

**Fix:** Attach `.catch` to the IIFE so failures always exit non-zero:

```javascript
(async () => {
  await checkAsync('no key → returns null (Mode A fallback)', async () => { ... });
  // ... other checkAsync calls ...
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`SMOKE FATAL: ${err.message}`);
  process.exit(1);
});
```

---

## Warnings

### WR-01: Vision cost-gate sends `low-signal` pairs to the API but they can never produce CONFIRMED_MISMATCH

**File:** `cohort-spotcheck-gate.js:178` and `lib/spotcheck-adjudicate.js:86`

**Issue:** The Mode B cost gate at line 178 of the gate sends both `provisional === 'suspect'`
AND `provisional === 'low-signal'` pairs to `adjudicateWithVision`. However, `adjudicatePair`
branch 3 (the only path to `CONFIRMED_MISMATCH`) checks `provisional === 'suspect'` only. A
`low-signal` pair where vision returns `sharedPhoto: false` falls through branches 1-3 to either
branch 4 (`!hasPhotos`) or branch 5 (`UNCERTAIN`). The spec's CONFIRMED_MISMATCH rule requires
"area and/or price diverge AND no shared photo" — for `low-signal`, the re-fetch failed so
field divergence is unknown, meaning UNCERTAIN is technically correct. But the API call was
still made, burned tokens, and produced no actionable verdict.

At the expected base rate (~1.8% false-match on ~285 pairs at 20% sampling), `low-signal`
pairs may be few, but the spend is pure waste.

**Fix (two options, pick one):**

Option A — Exclude `low-signal` from the vision gate (conservative, no API call):
```javascript
// cohort-spotcheck-gate.js line 178
const needVision = (artifact.pairs || []).filter(
  (p) => p.provisional === 'suspect'  // low-signal: re-fetch failed, fields unknown → UNCERTAIN regardless
);
```

Option B — Allow `low-signal` + `sharedPhoto:false` to also yield CONFIRMED_MISMATCH
(assertive, requires updating the adjudication rule and spec):
```javascript
// lib/spotcheck-adjudicate.js line 86
if ((provisional === 'suspect' || provisional === 'low-signal') && sharedPhoto === false) {
```
Option A is the lower-risk change and keeps the adjudication rule consistent with the spec.

---

### WR-02: Hardcoded model version string will break when Anthropic deprecates it

**File:** `lib/spotcheck-vision.js:117`

**Issue:** `const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';`

`claude-sonnet-4-6` is the current model as of this review, but Anthropic periodically
retires version-pinned IDs. When this happens, every Mode B run will fail at the
`client.messages.create` call with a model-not-found error. Because errors are caught and
return `null` (line 170), the failure is silent: all suspect/low-signal pairs silently fall
back to Mode A (UNCERTAIN) with no gate-level alert. The run succeeds without escalation even
though Mode B produced zero verdicts.

The `ANTHROPIC_MODEL` env var provides the override, but its documentation in `.env.example`
only says "blank → latest default" without instructing operators to update it when a model is
retired.

**Fix:**

1. In `.env.example`, document the update obligation:
   ```
   ANTHROPIC_MODEL=               # optional override; blank → default in lib/spotcheck-vision.js
                                  # UPDATE THIS when claude-sonnet-4-6 is deprecated
   ```
2. Add a startup log in the gate when Mode B is active so the resolved model name is visible
   in cron logs:
   ```javascript
   // In cohort-spotcheck-gate.js, after adjudicationMode = 'mode-b-vision':
   log('INFO', `mode-b model: ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6 (default)'}`);
   ```
3. Long-term: use a non-version-pinned alias such as `claude-sonnet-4` if/when Anthropic
   exposes stable aliases, so the default tracks the latest minor.

---

### WR-03: `--threshold 0` silently resets to default 0.05

**File:** `cohort-spotcheck-gate.js:58`

**Issue:**
```javascript
if (!Number.isFinite(a.threshold) || a.threshold <= 0 || a.threshold > 1) a.threshold = 0.05;
```
The guard uses `<= 0`, so `--threshold 0` (a valid "always escalate" test value) is silently
rejected and replaced with `0.05`. An operator trying to force a threshold of zero to test the
escalation path would see normal (non-escalating) behavior with no indication that the argument
was ignored. The gate's INFO log line (line 103) does log `threshold=0.05` after the reset, but
only a reader looking closely at the log would catch the discrepancy.

**Fix:** Change the guard to `< 0` so zero is a valid threshold, OR document the minimum:
```javascript
// Allow 0 (always escalate) as a valid threshold for testing
if (!Number.isFinite(a.threshold) || a.threshold < 0 || a.threshold > 1) a.threshold = 0.05;
```

---

### WR-04: Unguarded `JSON.parse` on the artifact file in the gate orchestrator

**File:** `cohort-spotcheck-gate.js:148`

**Issue:**
```javascript
const artifact = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
```
`cohort-spotcheck.js` produces the JSON; if it crashes mid-write or produces malformed output
(observed in earlier phases as the artifact writer adds fields progressively), `JSON.parse`
will throw an uncaught synchronous exception. While cron-wrapper catches thrown errors from
`main()` (via the `try/catch` in `runJob` line 137), the error message logged will be the raw
JSON parse error without the context of which file was being read, making diagnosis harder in
production.

Additionally, `artifact.pairs` is accessed at lines 157, 177, and 188. All three already use
`artifact.pairs || []`, which is good — but if `artifact` itself is undefined (e.g. if
`JSON.parse` returned `undefined` due to a hypothetical future edge case), the subsequent
`artifact.meta` access at line 154 would throw before the pairs guards.

**Fix:** Wrap the read/parse and validate the result shape:
```javascript
let artifact;
try {
  artifact = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse artifact JSON at ${jsonPath}: ${err.message}`);
}
if (!artifact || !Array.isArray(artifact.pairs)) {
  throw new Error(`Artifact at ${jsonPath} missing pairs array`);
}
```

---

## Info

### IN-01: `spotcheck-adjudicate.js` smoke test has no coverage for `low-signal` + vision path

**File:** `lib/spotcheck-adjudicate.js:142`

**Issue:** The smoke tests cover every branch of `adjudicatePair` except the case where
`provisional === 'low-signal'` and `sharedPhoto === false` (which, as noted in WR-01, falls
through to UNCERTAIN). Adding an explicit test for this case would make the designed-in
conservatism observable and prevent a future developer from accidentally "fixing" it to produce
CONFIRMED_MISMATCH without updating the spec.

**Fix:** Add one smoke case:
```javascript
check('low-signal + sharedPhoto=false → UNCERTAIN (not CONFIRMED_MISMATCH — no field evidence)', () => {
  const r = rec({ provisional: 'low-signal', deltas: { price_pct_diff: null } });
  const result = adjudicatePair(r, { visionResult: { sharedPhoto: false } });
  assert.strictEqual(result.verdict, 'UNCERTAIN');
});
```

---

### IN-02: `adjudicatePairs` accepts `visionResults` with `undefined` value vs. `{}` distinction is fragile

**File:** `lib/spotcheck-adjudicate.js:124-134`

**Issue:** `adjudicatePairs(records, { visionResults } = {})` treats both
`{ visionResults: undefined }` and `{ visionResults: {} }` as "Mode A / no vision" because
`visionResults?.[record.pair_id]` returns `undefined` in both cases. The gate calls it with
`{ visionResults }` where `visionResults` starts as `undefined` and may remain so (Mode A path).
This is correct and works, but the two callers use different conventions:

- Mode A: `adjudicatePairs(artifact.pairs || [], { visionResults })` where `visionResults` is `undefined`
- Mode B: same call, but `visionResults` is a populated `{}` map

The distinction is semantically meaningful (Mode A: never ran vision vs Mode B: ran but no
results for this pair) but both produce the same adjudication outcome. The `adjudicationMode`
field in the output artifact correctly records which mode ran, so this is a documentation gap
rather than a correctness issue. A comment clarifying the two cases would help future readers.

**Fix:** Add a comment in `adjudicatePairs`:
```javascript
// visionResults: undefined (Mode A — vision never ran)
//             OR {} (Mode B — vision ran; pairs not in map fell back to null result)
// Either way, visionResults?.[pair_id] is undefined for unpresent pairs → Mode A for that pair.
```

---

_Reviewed: 2026-06-10T14:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
