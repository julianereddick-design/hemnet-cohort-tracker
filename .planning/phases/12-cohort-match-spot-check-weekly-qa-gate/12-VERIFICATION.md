---
phase: 12-cohort-match-spot-check-weekly-qa-gate
verified: 2026-06-10T08:00:00Z
status: human_needed
score: 12/12 must-haves verified
overrides_applied: 0
human_verification:
  - test: "End-to-end wet-run against a live cohort on the droplet"
    expected: "node cohort-spotcheck-gate.js --cohort <recent-id> resolves cohort, drives cohort-spotcheck.js + spotcheck-photos.js child processes, writes VERDICTS-<cohort>.json + SUMMARY-<cohort>.md in the artifact dir, and records a success/warning cron_job_log row"
    why_human: "Requires DB connection, Oxylabs budget spend, and the prereq tools (cohort-spotcheck.js, spotcheck-photos.js, lib/spotcheck-evidence.js, lib/spotcheck-photos.js) which are UNTRACKED in git — a git-pull deploy to the droplet would NOT include them. Operator must either commit those four files first, or confirm they are already present on the droplet before the wet-run."
  - test: "Git-tracking status of prereq dependency files"
    expected: "cohort-spotcheck.js, spotcheck-photos.js, lib/spotcheck-evidence.js, lib/spotcheck-photos.js are either committed to git (so a git-pull deploy works end-to-end) OR operator explicitly confirms they are pre-deployed on the droplet and the omission is intentional"
    why_human: "All four files are currently UNTRACKED in git (confirmed by git ls-files). The gate invokes them via execFileSync. If the droplet receives a git-pull deploy without these files already present, the gate will fail at step 2/4 with 'MODULE_NOT_FOUND' or similar. This is a deploy-time gap, not a code correctness gap."
  - test: "Slack escalation fires on rate > 5% threshold"
    expected: "A Slack message appears in the Hemnet Status channel with the '[WARNING] cohort-spotcheck-gate: confirmed false-match rate X.X%' format when validate() returns a non-null string"
    why_human: "Requires SLACK_WEBHOOK_URL configured in prod .env and an actual run that crosses the threshold; cannot verify the webhook round-trip programmatically"
  - test: "Mode B (--mode-b) wet-run with a real ANTHROPIC_API_KEY"
    expected: "With ANTHROPIC_API_KEY set and --mode-b passed, suspect/low-signal pairs are sent to Claude vision, visionResults map is populated, adjudicationMode in VERDICTS JSON reads 'mode-b-vision', and likely-match pairs are NOT sent to the API (cost gate verified in logs)"
    why_human: "Requires a real Anthropic API key and live gallery images; the offline --smoke covers the no-key fallback path but not the live API call path"
---

# Phase 12: Cohort Match Spot-Check Weekly QA Gate Verification Report

**Phase Goal:** Turn the validated manual cohort match spot-check into a weekly, automated QA gate that runs after cohort-create — sample each new cohort (20% stratified by county), verify sampled Booli-Hemnet pairs are the same property via field evidence + photo confirmation, render per-pair verdicts (CONFIRMED MATCH / CONFIRMED MISMATCH / UNCERTAIN), compute the confirmed false-match rate with a Wilson CI by county, log to cron_job_log via cron-wrapper, and escalate via Slack on a high rate or fetch failure. Mode A (deterministic, no API) must produce a complete artifact; Mode B (Claude vision, gated behind triage) is additive and falls back to Mode A.
**Verified:** 2026-06-10
**Status:** HUMAN_NEEDED — all automated checks pass; wet-run and git-tracking of prereq tools require operator action.
**Re-verification:** No — initial verification.

---

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | Each sampled pair can be turned into CONFIRMED_MATCH / CONFIRMED_MISMATCH / UNCERTAIN by a pure function with no network/DB | VERIFIED | `lib/spotcheck-adjudicate.js` adjudicatePair() is pure (no pg/db/https imports), 5-branch decision tree confirmed in source; --smoke 13/13 |
| 2  | Mode A (no vision result) still yields a complete verdict set | VERIFIED | Branch 2 (deterministic promote: priceAgrees + hasPhotos + likely-match) and branches 4/5 (UNCERTAIN) fire without vision input; smoke case "deterministic CONFIRMED_MATCH" and "no-vision UNCERTAIN" both pass |
| 3  | Confirmed false-match rate is computed with a 95% Wilson CI | VERIFIED | `lib/spotcheck-summary.js` wilson95() copied verbatim from cohort-spotcheck.js:108-117; wilson95(2,112) smoke case asserts [0.003-0.010, 0.055-0.075]; --smoke 29/29 |
| 4  | A by-county breakdown and mismatch list (pair_id, both URLs, why) are produced | VERIFIED | computeSummary() builds byCounty map and mismatches array; smoke cases verify Stockholm/Uppsala/Skane counts and mismatch why-string includes "price" and "area" delta info |
| 5  | Running the gate against the latest cohort produces verdicts + summary with NO Anthropic API (Mode A) | VERIFIED | cohort-spotcheck-gate.js default path: visionResults=undefined, adjudicationMode='mode-a-human', adjudicatePairs called with {visionResults: undefined}; `node --check` passes; no Anthropic import at module load |
| 6  | The gate reuses the existing tools via execFileSync — it does NOT rebuild them | VERIFIED | 3 execFileSync calls in gate: cohort-spotcheck.js, spotcheck-photos.js (confirmed at lines 108-117 and 128-139); all four prereq files exist on disk (ls confirmed) |
| 7  | Every sampled pair ends with a verdict (CONFIRMED_MATCH / CONFIRMED_MISMATCH / UNCERTAIN) | VERIFIED | adjudicatePairs() loops over all records, every branch returns exactly one verdict string, no branch returns undefined; last branch (else) always returns UNCERTAIN |
| 8  | VERDICTS-<cohort>.json and SUMMARY-<cohort>.md land in the artifact dir | VERIFIED | `path.join(artifactDir, 'VERDICTS-'+cohortId+'.json')` and `path.join(artifactDir, 'SUMMARY-'+cohortId+'.md')` written via fs.writeFileSync in gate steps 9 |
| 9  | Run logs a cron_job_log row via cron-wrapper.runJob with a result_summary | VERIFIED | runJob({ scriptName: 'cohort-spotcheck-gate', main, validate }) wired at module bottom; main() returns a 13-field result_summary object with cohortId, sampled, rates, wilsonCI, fetchFailures, adjudicationMode |
| 10 | validate() returns a warning string (→ Slack) when rate > threshold OR fetchFailures > 0 | VERIFIED | validate() checks summary.fetchFailures > 0 first, then summary.confirmedMismatchRate > summary.threshold; confirmed with grep |
| 11 | Mode B (--mode-b + ANTHROPIC_API_KEY) auto-adjudicates suspect/low-signal pairs via Claude vision; vision NOT called for likely-match pairs (cost gate) | VERIFIED | Gate: `if (args.modeB && process.env.ANTHROPIC_API_KEY)` block; `filter(p => p.provisional === 'suspect' || p.provisional === 'low-signal')`; fallback WARN logged when key absent; --smoke 4/4 offline |
| 12 | Matcher fix (PRD §9) is NOT present | VERIFIED | `grep -i "area.*tie.break\|price.*tie.break" cohort-create.js` returns no matches — correctly deferred |

**Score:** 12/12 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/spotcheck-adjudicate.js` | Pure per-pair verdict logic, --smoke self-test, exports adjudicatePair/adjudicatePairs | VERIFIED | 311 lines; no pg/db/https/anthropic imports; module.exports confirmed; require.main === module smoke block; --smoke 13/13 |
| `lib/spotcheck-summary.js` | Wilson CI + by-county + mismatch list + Slack msg + SUMMARY md render, --smoke | VERIFIED | 429 lines; wilson95 function present; exports wilson95/computeSummary/renderSlackAlert/renderSummaryMd; --smoke 29/29 |
| `lib/spotcheck-vision.js` | Mode B Claude-vision adjudicator, offline --smoke, lazy SDK require | VERIFIED | 265 lines; adjudicateWithVision exported; require('@anthropic-ai/sdk') at line 39 inside getClient() function (not module top); --smoke 4/4 offline with no key |
| `cohort-spotcheck-gate.js` | Weekly orchestration under runJob; Mode A adjudication | VERIFIED | 263 lines; runJob() wired; scriptName 'cohort-spotcheck-gate'; node --check passes |
| `deploy-instructions.md` | Crontab line after cohort-create + runbook entry | VERIFIED | 7 occurrences of 'cohort-spotcheck-gate'; crontab line Mon 06:30 UTC; spotcheck-gate.log registered; VERDICTS-/SUMMARY- artifact paths documented |
| `package.json` | @anthropic-ai/sdk dependency | VERIFIED | `"@anthropic-ai/sdk": "^0.104.1"` in dependencies |
| `.env.example` | ANTHROPIC_API_KEY placeholder | VERIFIED | `ANTHROPIC_API_KEY=sk-ant-...` (placeholder only, no real key) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib/spotcheck-adjudicate.js` | record.provisional / record.deltas.price_pct_diff / record.photos.*_gallery | reads spot-check record shape | WIRED | `d.price_pct_diff`, `photos.hemnet_gallery?.length`, `r.provisional` all accessed with optional chaining |
| `lib/spotcheck-summary.js` | verdicts array from adjudicatePairs | computeSummary(pairs) counts CONFIRMED_MISMATCH | WIRED | `if (v === 'CONFIRMED_MISMATCH')` branch confirmed in source |
| `cohort-spotcheck-gate.js` | cron-wrapper.runJob | scriptName/main/validate | WIRED | `const { runJob } = require('./cron-wrapper')` at top; runJob() invocation at bottom |
| `cohort-spotcheck-gate.js` | lib/spotcheck-adjudicate.js + lib/spotcheck-summary.js | require + adjudicatePairs/computeSummary | WIRED | Both required at module top; adjudicatePairs called at step 7; computeSummary at step 8 |
| `validate()` | SLACK_WEBHOOK_URL via cron-wrapper warning path | non-null string return | WIRED | validate() returns non-null on fetchFailures > 0 or confirmedMismatchRate > threshold; no SLACK_WEBHOOK_URL hardcoded in gate (comment-only reference confirmed) |
| `cohort-spotcheck-gate.js` | lib/spotcheck-vision.js | modeB && ANTHROPIC_API_KEY → build visionResults, pass to adjudicatePairs | WIRED | Lazy require inside the if-block; adjudicateWithVision loop over needVision array; visionResults map passed to adjudicatePairs |
| `lib/spotcheck-vision.js` | Anthropic messages.create (vision) | base64 image blocks from photos.*_gallery file paths | WIRED | `client.messages.create({model, max_tokens:512, messages:[...]})` confirmed in source; image blocks built from `path.join(artifactDir, g.file)` |
| `gate vision gating` | record.provisional | only suspect/low-signal pairs sent to vision | WIRED | `filter(p => p.provisional === 'suspect' || p.provisional === 'low-signal')` confirmed |

---

### Data-Flow Trace (Level 4)

Not applicable — gate writes output artifacts (VERDICTS JSON, SUMMARY MD) rather than rendering dynamic UI. Data flow is verified via key links above: DB → cohortId → child processes → artifact JSON → adjudicatePairs → computeSummary → fs.writeFileSync.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| spotcheck-adjudicate --smoke | `node lib/spotcheck-adjudicate.js --smoke` | smoke: 13 pass, 0 fail | PASS |
| spotcheck-summary --smoke | `node lib/spotcheck-summary.js --smoke` | smoke: 29 pass, 0 fail | PASS |
| spotcheck-vision --smoke (offline) | `node lib/spotcheck-vision.js --smoke` | smoke: 4 pass, 0 fail | PASS |
| gate syntax check | `node --check cohort-spotcheck-gate.js` | exits 0 | PASS |
| End-to-end wet-run | operator wet-run on droplet | not yet run | SKIP (human needed) |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| CTX-D-adjudicate | 12-01 | Mode-agnostic adjudication, complete artifact without API | SATISFIED | adjudicatePair() 5-branch tree; Mode A deterministic promote confirmed; --smoke 13/13 |
| CTX-D-summary | 12-01 | False-match rate + Wilson CI, by county, mismatch list | SATISFIED | computeSummary() confirmed; wilson95(2,112) smoke assertion validates the CI formula |
| CTX-D-trigger | 12-02 | Gate runs after cohort-create under cron-wrapper, logs to cron_job_log | SATISFIED | runJob() wired; deploy-instructions.md Mon 06:30 UTC line confirmed |
| CTX-D-pipeline | 12-02 | Orchestrate existing tools sample→field→photo→adjudicate→summary | SATISFIED | execFileSync for cohort-spotcheck.js + spotcheck-photos.js; adjudicatePairs + computeSummary wired |
| CTX-D-escalation | 12-02 | Slack escalation on >5% rate OR fetch failure via validate() | SATISFIED | validate() returns non-null string on either condition; no custom Slack sender (flows through cron-wrapper) |
| CTX-D-modeB | 12-03 | Mode B Claude-vision gated behind triage, only suspect/low-signal pairs | SATISFIED | provisional filter confirmed; adjudicateWithVision loop confirmed |
| CTX-D-modeB-fallback | 12-03 | Mode B skips to Mode A when ANTHROPIC_API_KEY absent | SATISFIED | `if (!process.env.ANTHROPIC_API_KEY) return null` in getClient(); WARN log in gate; --smoke verifies null return with no key |

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `cohort-spotcheck.js`, `spotcheck-photos.js`, `lib/spotcheck-evidence.js`, `lib/spotcheck-photos.js` | Files are UNTRACKED in git (`git ls-files` confirms none tracked) | WARNING | A `git pull` deploy to the droplet would NOT include these four files. The gate invokes them via execFileSync and will fail at step 2 or step 4 with a spawn error if they are absent. Operator must confirm they are already on the droplet, or commit them before deploying. |

No placeholder implementations, no hardcoded empty returns, no console.log-only handlers, no hardcoded secrets found in the new Phase 12 files.

---

### Human Verification Required

#### 1. Prereq tool git tracking — deploy gate

**Test:** Confirm whether `cohort-spotcheck.js`, `spotcheck-photos.js`, `lib/spotcheck-evidence.js`, `lib/spotcheck-photos.js` are present on the production droplet (or commit and push them before deploying Phase 12).
**Expected:** The four files exist at `/opt/hemnet-cohort-tracker/` on the droplet so that `cohort-spotcheck-gate.js` can invoke them successfully as child processes.
**Why human:** These files are confirmed UNTRACKED in git. The Phase 12 gate is tracked and committed. If the droplet is provisioned fresh from git, it will have the gate but not the tools it calls. Operator decision: commit the four prereq files to git, OR explicitly document that they were manually deployed in a prior session.

#### 2. End-to-end wet-run on the droplet

**Test:** On the droplet, with DB access and Oxylabs credentials, run `node cohort-spotcheck-gate.js --cohort <recent-cohort-id>` (Mode A only, no --mode-b flag). Inspect the output and the artifact dir.
**Expected:** The run completes without error; a `verf-spotcheck-<cohort>-<ts>/` dir is found; `VERDICTS-<cohort>.json` exists with all sampled pairs having a non-null verdict; `SUMMARY-<cohort>.md` exists with a By-county table and a Wilson CI row; a `cron_job_log` row is written with `status='success'` (or `'warning'` if rate > 5%) and a populated `result_summary` JSON column.
**Why human:** Requires live DB connection, Oxylabs API spend, and the untracked prereq tools. Cannot verify programmatically without running against the production environment.

#### 3. Slack escalation round-trip

**Test:** Trigger a run where `confirmedMismatchRate > 0.05` (or use `--threshold 0.001` to force it), with `SLACK_WEBHOOK_URL` set in the prod `.env`.
**Expected:** A Slack message appears in the configured channel with the format `[WARNING] cohort-spotcheck-gate: confirmed false-match rate X.X% (n=N, 95% CI lo-hi%) for cohort <id> — M mismatch(es)`.
**Why human:** Requires the Slack webhook to be active and a run that crosses the threshold.

#### 4. Mode B live adjudication (--mode-b with real ANTHROPIC_API_KEY)

**Test:** On the droplet with `ANTHROPIC_API_KEY` set in `.env`, run `node cohort-spotcheck-gate.js --cohort <id> --mode-b`.
**Expected:** INFO log shows `mode-b: N pair(s) need vision (of M)` where N < M (only suspect+low-signal pairs); VERDICTS JSON has `adjudicationMode: 'mode-b-vision'`; likely-match pairs show `verdict_source: 'deterministic'` not `'mode-b-vision'`.
**Why human:** Requires a real API key and live gallery images.

---

### Gaps Summary

No BLOCKER gaps found. All 12 must-have truths are VERIFIED against the codebase. All smoke tests pass. The `node --check` gate passes. The only unresolved items are operational:

1. **WARNING — Prereq tools untracked in git.** `cohort-spotcheck.js`, `spotcheck-photos.js`, `lib/spotcheck-evidence.js`, `lib/spotcheck-photos.js` exist on disk and are called by the gate, but are not committed to git. A cold git-pull deploy would break the gate at runtime. Operator must resolve before deploying.

2. **HUMAN_NEEDED — Wet-run and Slack escalation** cannot be verified programmatically. These are the standard operator-gate items for a new cron job.

These items do not indicate a code defect — the Phase 12 deliverables (gate, adjudicate/summary/vision lib modules, deploy-instructions update) are correct and complete as coded.

---

_Verified: 2026-06-10_
_Verifier: Claude (gsd-verifier)_
