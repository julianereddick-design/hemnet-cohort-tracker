---
phase: 12-cohort-match-spot-check-weekly-qa-gate
plan: "03"
subsystem: spotcheck-vision
tags: [mode-b, claude-vision, anthropic-sdk, spotcheck-gate, image-adjudication]
dependency_graph:
  requires:
    - lib/spotcheck-adjudicate.js
    - cohort-spotcheck-gate.js
    - spotcheck-photos.js
    - "@anthropic-ai/sdk"
  provides:
    - lib/spotcheck-vision.js
    - cohort-spotcheck-gate.js (--mode-b wired)
  affects:
    - cohort-spotcheck-gate.js (adjudicationMode now dynamic)
    - .env.example (ANTHROPIC_API_KEY + ANTHROPIC_MODEL placeholders)
tech_stack:
  added:
    - "@anthropic-ai/sdk ^0.104.1"
  patterns:
    - lazy-require-inside-function
    - cost-gated-api-call
    - mode-a-fallback-on-missing-key
    - base64-image-content-blocks
    - defensive-json-parse
key_files:
  created:
    - lib/spotcheck-vision.js
  modified:
    - cohort-spotcheck-gate.js
    - package.json
    - package-lock.json
    - .env.example
decisions:
  - "Lazy require('@anthropic-ai/sdk') inside getClient() — module loads cleanly without SDK/key at module evaluation time; supports offline --smoke and Mode A fallback"
  - "Model default: claude-sonnet-4-6 (Claude 4.x, vision-capable); overridable via ANTHROPIC_MODEL env (e.g. claude-opus-4-8 for higher accuracy)"
  - "adjudicateWithVision returns null on missing key, empty galleries, or any API/parse error — caller treats null as Mode A for that pair (T-12-12)"
  - "Cost gate: vision called only for provisional === 'suspect' | 'low-signal' pairs; likely-match pairs never hit the API (T-12-11)"
  - "adjudicationMode variable replaces hardcoded 'mode-a-human' in VERDICTS JSON + result_summary — reflects actual mode used"
metrics:
  duration: 5m
  completed: "2026-06-10"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 4
---

# Phase 12 Plan 03: Mode B Claude-Vision Adjudicator Summary

Mode B Claude-vision layer over downloaded gallery images: `lib/spotcheck-vision.js` sends base64-encoded photos to `claude-sonnet-4-6`, returning `{ sharedPhoto, confidence, reasoning }` — gated behind deterministic triage so only suspect/low-signal pairs call the API; Mode A (deterministic) is the unchanged fallback when `--mode-b` is absent or `ANTHROPIC_API_KEY` is unset.

## What Was Built

### lib/spotcheck-vision.js

Pure async module exporting `adjudicateWithVision(pair, opts)`:

- **Lazy SDK load**: `require('@anthropic-ai/sdk')` lives inside `getClient()` — the module loads and exports cleanly without the SDK present at evaluation time. This is what makes `--smoke` and Mode A fallback work without any dep-check.
- **No key → null immediately**: `getClient()` returns null when `ANTHROPIC_API_KEY` is unset; `adjudicateWithVision` propagates null to the caller (Mode A path).
- **Image encoding**: reads up to `maxImagesPerSide` (default 6) files per gallery side using `fs.readFileSync(path.join(artifactDir, g.file))`, base64-encodes to `{ type:'image', source:{ type:'base64', media_type:'image/jpeg', data } }` blocks. Files that fail to read are silently skipped.
- **Empty-gallery short-circuit**: if either side produces 0 readable image blocks, returns `{ sharedPhoto: null, confidence: 'low', reasoning: 'insufficient images' }` — no API call.
- **Prompt**: labels Booli images first, then Hemnet. Instructs the model to look for ONE clearly shared room or exterior feature across both galleries (not just hero photos), and respond with strict JSON `{ sharedPhoto, confidence, reasoning }`.
- **Model**: `process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'` — Claude 4.x, vision-capable; `ANTHROPIC_MODEL` overrides for higher-accuracy runs.
- **Defensive parse**: strips accidental markdown fencing before `JSON.parse`; any parse error returns null and logs a warning (T-12-12).
- **API error handling**: any `client.messages.create` rejection returns null and logs a warning — the gate never crashes because of a vision failure.
- **`--smoke` offline**: 4 checks, all pass with no key and no network:
  1. Module exports `adjudicateWithVision` (purity check)
  2. No key → returns null (Mode A fallback)
  3. Empty galleries + no key → null
  4. Empty galleries + dummy key → `{ sharedPhoto: null, confidence: 'low' }` (no API call because 0 image blocks)

### cohort-spotcheck-gate.js — --mode-b wired

Replaced the Mode A stub `adjudicatePairs(artifact.pairs, {})` call with a mode-aware block:

```
let visionResults = undefined;
let adjudicationMode = 'mode-a-human';
if (args.modeB && process.env.ANTHROPIC_API_KEY) {
  // load vision module, build visionResults map for suspect+low-signal pairs only
  adjudicationMode = 'mode-b-vision';
} else if (args.modeB) {
  log('WARN', '...falling back to Mode A');
}
const verdicts = adjudicatePairs(artifact.pairs || [], { visionResults });
```

- `adjudicationMode` variable (no longer hardcoded) propagates into `VERDICTS-<cohort>.json` and `result_summary`.
- Mode A path: `visionResults = undefined` → `adjudicatePairs` receives `{ visionResults: undefined }` → `spotcheck-adjudicate.js` treats each pair as no-vision (unchanged behavior).
- `--mode-b` CLI flag comment updated to reflect it is now fully implemented (not a stub).

### package.json / .env.example

- `@anthropic-ai/sdk ^0.104.1` added to `dependencies`.
- `.env.example`: `ANTHROPIC_API_KEY=sk-ant-...` (placeholder) + `ANTHROPIC_MODEL=` (optional override).

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Install @anthropic-ai/sdk + .env.example | cb0512f | package.json, package-lock.json, .env.example |
| 2 | lib/spotcheck-vision.js | 8904c91 | lib/spotcheck-vision.js (created) |
| 3 | --mode-b wired in cohort-spotcheck-gate.js | ab403db | cohort-spotcheck-gate.js |

## Deviations from Plan

None — plan executed exactly as written.

- Task 1: `@anthropic-ai/sdk` installed and in `package.json`; `.env.example` documents both `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` as placeholders; `node -e "require('@anthropic-ai/sdk')"` exits 0.
- Task 2: `node lib/spotcheck-vision.js --smoke` passes (4/4) offline; `messages.create`, `module.exports`, `sharedPhoto`, `ANTHROPIC_API_KEY` grep checks all pass; SDK require is lazy (inside `getClient()`); model default is `claude-sonnet-4-6` (no `claude-3-*` ids anywhere).
- Task 3: `node --check cohort-spotcheck-gate.js` passes; all 6 grep acceptance criteria pass; Mode A path intact with `visionResults = undefined`.

## Threat Surface Scan

Threat register dispositions applied per plan:

- **T-12-09 (API key disclosure)**: `ANTHROPIC_API_KEY` read only from `process.env.ANTHROPIC_API_KEY` inside `getClient()`; never hardcoded; `.env.example` carries placeholder only. Grep confirms no literal key in committed files.
- **T-12-10 (data egress)**: Images are public listing photos sent with a generic same-property prompt only (no address/PII beyond what the public listing shows). Mode B is opt-in (`--mode-b` + key). Vision is called only for suspect/low-signal pairs (bounded subset).
- **T-12-11 (DoS/cost)**: Vision called only for `suspect` + `low-signal` pairs; `maxImagesPerSide = 6` caps images per side; `likely-match` pairs never call the API.
- **T-12-12 (malformed model reply)**: `JSON.parse` wrapped in try/catch; any error → null → Mode A for that pair; gate never crashes.
- **T-12-13 (image file tampering)**: Files read only from `path.join(artifactDir, g.file)` where `artifactDir` is the gate-created artifact directory and `g.file` paths come from the artifact JSON written by our own `spotcheck-photos.js`.

No new threat surface introduced beyond what the plan's threat register already covers.

## Known Stubs

None. All three tasks shipped complete:
- `lib/spotcheck-vision.js` is the full Mode B implementation with offline `--smoke`.
- `cohort-spotcheck-gate.js` `--mode-b` is fully wired (no longer a stub).
- The only operator step remaining is providing a real `ANTHROPIC_API_KEY` in production `.env` to activate Mode B on live runs — this is an intentional user_setup item (documented in plan frontmatter and `.env.example`).

## Self-Check: PASSED

- `lib/spotcheck-vision.js` exists: FOUND
- `package.json` contains `@anthropic-ai/sdk`: FOUND
- `.env.example` contains `ANTHROPIC_API_KEY`: FOUND
- Commit cb0512f exists: FOUND
- Commit 8904c91 exists: FOUND
- Commit ab403db exists: FOUND
- `node lib/spotcheck-vision.js --smoke`: PASSED (4 pass, 0 fail)
- `node -e "require('@anthropic-ai/sdk')"`: PASSED
- `node --check cohort-spotcheck-gate.js`: PASSED
- Model default is `claude-sonnet-4-6`: CONFIRMED
- No `claude-3-*` ids in changed files: CONFIRMED
- No real API key committed: CONFIRMED
