# Phase 12: Cohort match spot-check weekly QA gate — Pattern Map

**Mapped:** 2026-06-10
**Files analyzed:** 4 new files to create
**Analogs found:** 4 / 4

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `cohort-spotcheck-gate.js` | orchestrator / scheduled job | event-driven (trigger after cohort-create) | `cohort-create.js` + `booli-targeted-discovery.js` | exact — same runJob+cron-wrapper pattern, same child-tool invocation style |
| `lib/spotcheck-adjudicate.js` | service / pure transform | transform (verdicts from photo galleries + field triage) | `lib/spotcheck-evidence.js` | exact — same pure module shape, same `--smoke` self-test, no DB/network |
| `lib/spotcheck-summary.js` | utility | transform (Wilson CI, per-county stats, Slack message render) | `lib/spotcheck-evidence.js` + `market-totals-weekly-report.js` | role-match — pure computation + Slack message render |
| `lib/spotcheck-vision.js` | service (Mode B) | request-response (Anthropic API vision call per pair) | **no analog** — `@anthropic-ai/sdk` does not exist in the codebase today |

---

## Pattern Assignments

### `cohort-spotcheck-gate.js` (orchestrator, event-driven / scheduled)

**Primary analog:** `cohort-create.js`
**Secondary analog:** `booli-targeted-discovery.js` (lines 1-30 for the `runJob` invocation pattern)

This is the main new file. It wraps the three existing spot-check steps in `cron-wrapper.runJob`, resolves the latest cohort the same way `cohort-spotcheck.js` does (SELECT ... ORDER BY week_start DESC LIMIT 1), calls `cohort-spotcheck.js` logic inline (or as a child require), calls `spotcheck-photos.js` logic inline, calls `lib/spotcheck-adjudicate.js` / `lib/spotcheck-vision.js`, calls `lib/spotcheck-summary.js` to compute CI + render the Slack escalation message, escalates via `cron-wrapper`'s existing Slack path (status `'warning'`) or via a direct `SLACK_WEBHOOK_URL` call if the rate exceeds the threshold.

**Imports pattern** (`cohort-create.js` lines 1-8):
```javascript
const { runJob } = require('./cron-wrapper');
```

**Imports pattern** (add for gate):
```javascript
const { runJob } = require('./cron-wrapper');
const { createClient } = require('./db');
const fs = require('fs');
const path = require('path');
// existing spot-check tools — reuse, do not rebuild
// cohort-spotcheck.js logic is required inline or via a refactored module export
// spotcheck-photos.js logic same
const { adjudicatePairs } = require('./lib/spotcheck-adjudicate');
const { computeSummary, renderSlackAlert } = require('./lib/spotcheck-summary');
```

**Latest-cohort resolution pattern** (`cohort-spotcheck.js` lines 141-145):
```javascript
// Resolve cohort (latest by week_start unless --cohort given).
let cohortId = args.cohort;
if (!cohortId) {
  const r = await client.query('SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1');
  if (r.rows.length === 0) throw new Error('no cohorts found');
  cohortId = r.rows[0].cohort_id;
}
```

**runJob invocation pattern** (`cohort-create.js` lines 224-237):
```javascript
runJob({
  scriptName: 'cohort-spotcheck-gate',
  main,
  validate: (summary) => {
    if (summary.skipped) return null;
    if (summary.fetchFailures > 0) {
      return `${summary.fetchFailures} fetch failures during spot-check gate`;
    }
    if (summary.confirmedMismatchRate > 0.05) {
      return `confirmed false-match rate ${(summary.confirmedMismatchRate * 100).toFixed(1)}% exceeds 5% threshold`;
    }
    return null;
  },
});
```

**`main(client, log)` signature** (`cohort-create.js` lines 46-48):
```javascript
async function main(client, log) {
  // ... receives cron-wrapper's DB client and logger
  // returns resultSummary plain object — serialised to cron_job_log.result_summary as JSON
```

**Artifact directory naming** (`cohort-spotcheck.js` lines 258-261):
```javascript
const stamp = tsStamp(new Date());
const outDir = path.join(process.cwd(), `verf-spotcheck-${cohortId}-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });
```

**Result summary shape** (`cohort-create.js` lines 211-222 — return object):
```javascript
return {
  cohortId,
  weekStart,
  weekEnd,
  skipped: false,
  booliListingsFound: booliListings.rows.length,
  matched: matched.length,
  unmatched: unmatched.length,
  matchRate,
  day0PairsRecorded: pairs.rows.length,
};
// Gate's equivalent:
return {
  cohortId,
  sampled,
  confirmedMatch,
  confirmedMismatch,
  uncertain,
  confirmedMismatchRate,        // number 0-1
  wilsonLo,                     // 95% Wilson CI lower bound
  wilsonHi,
  fetchFailures,
  artifactDir,
  adjudicationMode,             // 'mode-b-vision' | 'mode-a-human'
  escalated,                    // boolean
};
```

**Escalation via cron-wrapper's warning path** (`cron-wrapper.js` lines 155-161):
```javascript
// Slack alert on failure/warning
const webhookUrl = process.env.SLACK_WEBHOOK_URL;
if (webhookUrl && (status === 'failure' || status === 'warning')) {
  const emoji = status === 'failure' ? 'FAILURE' : 'WARNING';
  const text = `[${emoji}] ${scriptName}: ${errorMessage}`;
  await sendSlackAlert(webhookUrl, text, log);
}
```
The gate triggers this path by returning a non-null string from `validate()` when the threshold is exceeded OR when fetch failures are detected. This means NO extra Slack sending code is needed in the gate — the `validate` function returning a string sets `status = 'warning'` and the existing cron-wrapper Slack path fires.

**DB client creation** (`db.js` lines 1-16):
```javascript
require('dotenv').config();
const { Client } = require('pg');

function createClient() {
  return new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}
module.exports = { createClient };
```
Note: `cron-wrapper.runJob` creates and passes the DB client. The gate's `main(client, log)` receives it — no second `createClient()` needed inside `main` for DB queries. If spot-check sub-steps need their own client (e.g. because `cohort-spotcheck.js` creates its own), use `createClient()` from `./db` and call `client.connect()` / `client.end()` inside the sub-step, matching the pattern in `cohort-spotcheck.js` lines 135-300.

**CLI flags pattern** (`cohort-spotcheck.js` lines 44-58):
```javascript
function parseArgs(argv) {
  const a = { dryRun: false, refetchBooli: false, rate: 0.08, conc: 5 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--cohort') a.cohort = argv[++i];
    else if (t === '--rate') a.rate = parseFloat(argv[++i]);
    else if (t === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (t === '--conc') a.conc = Math.max(1, parseInt(argv[++i], 10) || 5);
  }
  return a;
}
// Gate adds: --mode-b (enable Claude API vision), --threshold 0.05
```

---

### `lib/spotcheck-adjudicate.js` (service, transform)

**Primary analog:** `lib/spotcheck-evidence.js`

Pure module — no DB, no network unless Mode B is enabled. Takes the enriched pair records (post-photos) and returns per-pair verdicts using the confirmation rule from the spec. With Mode B enabled, calls `lib/spotcheck-vision.js` for pairs that need it (suspects and low-signal only; likely-match pairs that have price agreement and at least one photo are promoted to CONFIRMED MATCH without a model call).

**Module shape** (`lib/spotcheck-evidence.js` lines 26-30 + 199-210):
```javascript
'use strict';
// ... pure functions, no DB/network imports at module level ...

module.exports = {
  computeDeltas,
  classifyDeterministic,
  // gate adds:
  // adjudicatePairs,
};

// --smoke self-test at module bottom (guarded by require.main === module)
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  // ...
  process.exit(fail === 0 ? 0 : 1);
}
```

**Confirmation rule logic to encode** (from COHORT-SPOTCHECK.md §3 + 12-CONTEXT.md):
```javascript
// Inputs per pair: record.provisional, record.deltas, record.photos
// Photos: record.photos.hemnet_gallery.length, record.photos.booli_gallery.length
// Price agreement: record.deltas.price_pct_diff <= 0.05

function adjudicatePair(record, { visionResult } = {}) {
  const priceAgrees = record.deltas.price_pct_diff != null && record.deltas.price_pct_diff <= 0.05;
  const hasPhotos = (record.photos?.hemnet_gallery?.length > 0) && (record.photos?.booli_gallery?.length > 0);
  const sharedPhoto = visionResult?.sharedPhoto ?? null; // from Mode B

  if (priceAgrees && sharedPhoto === true) return { verdict: 'CONFIRMED_MATCH', source: 'mode-b-vision' };
  if (priceAgrees && hasPhotos && record.provisional === 'likely-match') return { verdict: 'CONFIRMED_MATCH', source: 'deterministic' };
  // field divergence + no shared photo → CONFIRMED_MISMATCH
  if (record.provisional === 'suspect' && sharedPhoto === false) return { verdict: 'CONFIRMED_MISMATCH', source: 'mode-b-vision' };
  // fallback
  return { verdict: 'UNCERTAIN', source: 'no-photos' };
}
```

**Smoke test shape** (`lib/spotcheck-evidence.js` lines 216-361):
```javascript
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  // test cases here
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

---

### `lib/spotcheck-summary.js` (utility, transform)

**Primary analogs:** `lib/spotcheck-evidence.js` (pure module shape) + `market-totals-weekly-report.js` (Slack message render)

Computes the confirmed false-match rate, Wilson 95% CI (port the already-correct `wilson95` function from `cohort-spotcheck.js`), per-county breakdown, and renders the Slack escalation message. Pure — no DB, no network.

**Wilson CI (already exists)** (`cohort-spotcheck.js` lines 108-117):
```javascript
// 95% Wilson score interval for a binomial proportion. Returns [lo, hi].
function wilson95(successes, n) {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}
```
Copy this verbatim into `lib/spotcheck-summary.js` — do not re-import from `cohort-spotcheck.js` (that file's `wilson95` is not exported).

**Slack message format** (`market-totals-weekly-report.js` lines 12-33, `cron-wrapper.js` lines 155-160):
```javascript
// Pattern A — plain-text Slack via { text: message } payload (cron-wrapper uses this)
const text = `[WARNING] cohort-spotcheck-gate: confirmed false-match rate X.X% (n=N, 95% CI Y-Z%) for cohort 2026-WXX — ${mismatchCount} mismatch(es)`;

// The gate escalation message should be a plain-text string, matching the
// cron-wrapper errorMessage format. The validate() function returns this string.
// cron-wrapper then wraps it: `[WARNING] cohort-spotcheck-gate: <string>`.
// No Block Kit needed — cron-wrapper's sendSlackAlert uses { text } plain payload.
```

**sendSlack pattern** (`market-totals-weekly-report.js` lines 12-33):
```javascript
// VERBATIM reuse — all existing jobs use the same pattern.
async function sendSlack(webhookUrl, message) {
  const payload = JSON.stringify({ text: message });
  const parsed = new URL(webhookUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Slack ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Slack timeout')); });
    req.write(payload);
    req.end();
  });
}
```
NOTE: the gate does NOT need its own `sendSlack` copy. The threshold-breach escalation is handled by returning a non-null string from `validate()` in `runJob`, which triggers the existing `cron-wrapper` Slack path. `lib/spotcheck-summary.js` just returns a plain string that the gate passes through.

**Module export shape**:
```javascript
module.exports = {
  wilson95,
  computeSummary,  // (pairs) => { confirmedMatch, confirmedMismatch, uncertain, rate, wilsonLo, wilsonHi, byCounty, mismatches }
  renderSlackAlert, // (summary, cohortId) => string (the warning message for validate())
  renderSummaryMd,  // (summary, cohortId) => markdown string for SUMMARY-<cohort>.md artifact
};
```

---

### `lib/spotcheck-vision.js` (service, request-response — Mode B)

**No analog exists in the codebase.** `@anthropic-ai/sdk` is not installed (confirmed: `package.json` dependencies are `dotenv`, `exceljs`, `pg` only). There is no Anthropic API usage anywhere in the repo.

**What the planner must know:**
- Requires `npm install @anthropic-ai/sdk` and a new env var `ANTHROPIC_API_KEY` in `.env`.
- Uses the `messages.create` endpoint with `image` content blocks (base64 or URL source).
- Called only for `suspect` and `low-signal` pairs after photos are downloaded (gate controls cost).
- Returns `{ sharedPhoto: boolean|null, confidence: 'high'|'medium'|'low', reasoning: string }`.
- `lib/spotcheck-adjudicate.js` calls it via `visionResult = await visionJudge(pair)`.
- The gate must skip vision calls gracefully if `ANTHROPIC_API_KEY` is not set (Mode A fallback).

**Reference implementation shape** (no existing analog — use Anthropic SDK docs pattern):
```javascript
// lib/spotcheck-vision.js — Mode B: Claude vision adjudicator
'use strict';
// npm install @anthropic-ai/sdk  (new dep — add to package.json)
// const Anthropic = require('@anthropic-ai/sdk');

// adjudicateWithVision(pair, opts) — pair has pair.photos.hemnet_gallery + booli_gallery
// with local file paths. Reads images from disk, encodes as base64, sends to claude-3-5-sonnet
// (or claude-opus-4) with the confirmation rule prompt.
// Returns { sharedPhoto: boolean|null, confidence, reasoning } | null on API error.
async function adjudicateWithVision(pair, opts = {}) { ... }

module.exports = { adjudicateWithVision };
```

---

## Shared Patterns

### DB client creation
**Source:** `db.js` lines 1-16
**Apply to:** `cohort-spotcheck-gate.js` (receives client from cron-wrapper), any sub-steps that need a direct DB connection
```javascript
require('dotenv').config();
const { Client } = require('pg');
function createClient() {
  return new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}
module.exports = { createClient };
```

### cron-wrapper `runJob` contract
**Source:** `cron-wrapper.js` lines 57-172
**Apply to:** `cohort-spotcheck-gate.js`

Key points:
- `main(client, log)` receives a connected DB client and a logger `log(level, message)`.
- Return value of `main` becomes `resultSummary`, serialised to `cron_job_log.result_summary`.
- `validate(resultSummary)` returns `null` (success) or a warning string; a non-null string sets `status = 'warning'` and fires the Slack alert automatically.
- Throwing inside `main` sets `status = 'failure'` and also fires Slack.
- The gate uses `validate` to trigger the Slack escalation (threshold breach → return warning string from validate). No extra Slack code needed.

```javascript
// Full runJob invocation template (cohort-create.js lines 224-237):
runJob({
  scriptName: 'cohort-spotcheck-gate',
  main,
  validate: (summary) => {
    if (!summary || summary.skipped) return null;
    if (summary.fetchFailures > 0) return `${summary.fetchFailures} fetch failures`;
    if (summary.confirmedMismatchRate > ESCALATION_THRESHOLD) {
      return `confirmed false-match rate ${(summary.confirmedMismatchRate*100).toFixed(1)}% exceeds ${(ESCALATION_THRESHOLD*100).toFixed(0)}% threshold (cohort ${summary.cohortId})`;
    }
    return null;
  },
});
```

### Slack escalation
**Source:** `cron-wrapper.js` lines 155-161
**Apply to:** `cohort-spotcheck-gate.js` (via validate → warning path)

The existing `cron-wrapper` Slack path fires whenever `validate` returns a non-null string OR when `main` throws. The gate does NOT need its own `sendSlack` function. The alert text passed to Slack is:
```
[WARNING] cohort-spotcheck-gate: <validate() return string>
```
This is consistent with all other jobs in the repo that escalate on threshold breaches.

### Logging
**Source:** `cohort-spotcheck.js` lines 60-62 and `cron-wrapper.js` `makeLogger` lines 6-16
**Apply to:** `cohort-spotcheck-gate.js`, `lib/spotcheck-adjudicate.js`, `lib/spotcheck-summary.js`

Inside `cron-wrapper`'s `main(client, log)`, the `log` function is provided. Outside cron-wrapper (lib modules), use the same inline pattern:
```javascript
function log(level, msg) {
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);
}
```

### Pure module + `--smoke` self-test
**Source:** `lib/spotcheck-evidence.js` lines 216-361 and `lib/spotcheck-photos.js` lines 167-214
**Apply to:** `lib/spotcheck-adjudicate.js`, `lib/spotcheck-summary.js`

All `lib/` modules in this repo that contain testable pure logic include a `--smoke` self-test block guarded by `require.main === module && process.argv.includes('--smoke')`. New lib modules must follow this convention.

### Artifact directory structure
**Source:** `cohort-spotcheck.js` lines 258-289, `spotcheck-photos.js` lines 105-106
**Apply to:** `cohort-spotcheck-gate.js`

The gate reuses the existing `verf-spotcheck-<cohort>-<ts>/` directory created by `cohort-spotcheck.js`. It should NOT create a new directory — the gate orchestrates the existing tools and their artifact layout.

Directory layout after the gate runs:
```
verf-spotcheck-<cohort>-<ts>/
  spotcheck-<cohort>.json      ← written by cohort-spotcheck.js logic (Layer 1+2)
  spotcheck-<cohort>.md        ← written by cohort-spotcheck.js logic
  PHOTOS-<cohort>.md           ← written by spotcheck-photos.js logic (Layer 3)
  photos/
    pair<N>/
      hemnet_00_hero.jpg
      booli_00_hero.jpg
      hemnet_01_*.jpg  ...
      booli_01_*.jpg  ...
  VERDICTS-<cohort>.json       ← NEW: written by gate (adjudication output)
  SUMMARY-<cohort>.md          ← NEW: written by gate (CI + county breakdown + mismatch list)
```

### Worker pool concurrency pattern
**Source:** `cohort-spotcheck.js` lines 233-253 and `spotcheck-photos.js` lines 111-172
**Apply to:** `cohort-spotcheck-gate.js` (if it calls the photo step inline)

```javascript
// Standard worker pool used by both existing spot-check scripts:
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    await sleep(jitter());
    // ... process item ...
  }
}
await Promise.all(Array.from({ length: args.conc }, () => worker()));
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `lib/spotcheck-vision.js` | service (Mode B adjudicator) | request-response (Anthropic API) | No `@anthropic-ai/sdk` in package.json; no Claude API calls anywhere in the repo. Planner must spec the npm install and API key env var as explicit steps. |

---

## Metadata

**Analog search scope:** repo root + `lib/` directory
**Key files scanned:** `cron-wrapper.js`, `cohort-create.js`, `db.js`, `cohort-spotcheck.js`, `spotcheck-photos.js`, `lib/spotcheck-evidence.js`, `lib/spotcheck-photos.js`, `market-totals-weekly-report.js`, `cron-health-slack.js`, `booli-targeted-discovery.js`, `package.json`
**Grep searches:** Slack/webhook/notify patterns (all `.js`), Anthropic/Claude-API/vision patterns (all files)
**Pattern extraction date:** 2026-06-10
