# Phase 13: Spot-check image confirmation and human review loop - Pattern Map

**Mapped:** 2026-06-11
**Files analyzed:** 8 new/modified files
**Analogs found:** 8 / 8

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `lib/spotcheck-dhash.js` | utility/lib | transform | `scripts/spotcheck-phash-probe.js` + `lib/spotcheck-vision.js` | exact (lifted from probe + lib conventions) |
| `lib/spotcheck-adjudicate.js` (fix) | utility/lib | transform | itself (D-03 price-guard fix on branch 3) | self-fix |
| `lib/spotcheck-slack-bot.js` | utility/lib | request-response (outbound + inbound) | `cron-wrapper.js` `sendSlackAlert` (outbound half) | role-match (inbound reactions new) |
| `lib/spotcheck-review-store.js` | service | CRUD | `db.js` + `cohort-create.js` INSERT pattern + `cron-setup.js` DDL pattern | role-match |
| `cohort-spotcheck-gate.js` (extend) | controller/orchestrator | request-response | itself (Phase 12 base) | self-extension |
| `spotcheck-reaction-poller.js` | controller/cron | event-driven | `cohort-spotcheck-gate.js` `runJob` registration + `cron-wrapper.js` | role-match |
| `migrate-spotcheck-phase13.js` | migration | CRUD | `cron-setup.js`, `cohort-setup.js` | exact |
| `deploy-crontab-phase13.sh` / crontab entry | config | n/a | `setup-droplet.sh` crontab lines | exact |

---

## Pattern Assignments

### `lib/spotcheck-dhash.js` (utility, transform)

**Analog:** `scripts/spotcheck-phash-probe.js` (dHash algorithm) + `lib/spotcheck-vision.js` (lib module conventions)

**Imports pattern** — copy from `lib/spotcheck-vision.js` lines 1-30 (header + lazy-load guard) and `scripts/spotcheck-phash-probe.js` lines 1-18:

```javascript
// lib/spotcheck-dhash.js
//
// Deterministic dHash (gradient hash) cross-comparison for Booli<->Hemnet
// gallery pairs. Extracted from scripts/spotcheck-phash-probe.js.
// Pure-JS via jimp (no native build). No DB, no network.
//
// Usage:
//   const { minDHashDistance } = require('./lib/spotcheck-dhash');
//   node lib/spotcheck-dhash.js --smoke

'use strict';

const fs   = require('fs');
const path = require('path');
```

**Core dHash algorithm** — copy verbatim from `scripts/spotcheck-phash-probe.js` lines 23-103 (dhash + hamming + hashImage + listImages + hashAll). Key excerpt:

```javascript
// ---------- dHash: 9x8 greyscale, adjacent-pixel gradient -> 64 bits ----------
async function dhash(img9x8) {
  const W = 9;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left  = img9x8.bitmap.data[(y * W + x)       * 4];
      const right = img9x8.bitmap.data[(y * W + (x + 1)) * 4];
      bits += left > right ? '1' : '0';
    }
  }
  return bits;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function hashImage(file) {
  const base = await Jimp.read(file);
  const d = await dhash(base.clone().resize(9, 8).greyscale());
  return { file: path.basename(file), d };
}
```

**Primary export** — the new lib wraps the probe's nested-loop cross-compare as a named export:

```javascript
// minDHashDistance(booliDir, hemnetDir, pairId) -> { minDist, bFile, hFile }
// Returns { minDist: 64, bFile: null, hFile: null } when either side has no images.
// Logs per-file errors to console.warn; never throws.
async function minDHashDistance(booliFiles, hemnetFiles) { ... }

module.exports = { minDHashDistance };
```

**--smoke self-test pattern** — copy structure from `lib/spotcheck-adjudicate.js` lines 142-309 (check() helper + assert + process.exit). Smoke for dhash: verify hamming(x,x)===0, hamming with 1 bit flip===1, and that minDHashDistance on missing files returns { minDist:64 } without throwing.

```javascript
// ---------------------------------------------------------------
// --smoke self-test (no DB, no network, no real images required).
//   node lib/spotcheck-dhash.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  // ... tests ...
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

---

### `lib/spotcheck-adjudicate.js` — mismatch-rule price-guard fix (D-03)

**Analog:** itself. The bug is in branch 3 at lines 86-91.

**Current branch 3** (`lib/spotcheck-adjudicate.js` lines 86-91):

```javascript
// 3. Mode B vision says NOT the same place + triage also flags suspect
if (provisional === 'suspect' && sharedPhoto === false) {
  return {
    verdict: 'CONFIRMED_MISMATCH',
    source: 'mode-b-vision',
    reason: 'suspect triage + vision found no shared photo',
  };
}
```

**Required fix** — add `!priceAgrees` guard so a price-agreeing pair can never become CONFIRMED_MISMATCH (per COHORT-SPOTCHECK.md §3: "price/area diverge AND no shared photo"):

```javascript
// 3. Mode B vision says NOT the same place + triage also flags suspect
//    PRICE GUARD (D-03): price-agreeing pair can never be a confirmed mismatch —
//    it stays UNCERTAIN. Spec: COHORT-SPOTCHECK.md §3 requires field divergence AND no shared photo.
if (provisional === 'suspect' && sharedPhoto === false && !priceAgrees) {
  return {
    verdict: 'CONFIRMED_MISMATCH',
    source: 'mode-b-vision',
    reason: 'suspect triage + vision found no shared photo + price diverges',
  };
}
```

**New smoke test to add** — in the existing `--smoke` block (after line 247), add the regression case for pair 15647:

```javascript
// D-03 regression: pair 15647 — price agrees, suspect, sharedPhoto=false → must stay UNCERTAIN
check('D-03 price-agreeing suspect + sharedPhoto=false → UNCERTAIN (not CONFIRMED_MISMATCH)', () => {
  const r = rec({
    pair_id: 15647,
    provisional: 'suspect',
    deltas: { price_pct_diff: 0.0, area_pct_diff: 0.10 }, // price agrees
  });
  const result = adjudicatePair(r, { visionResult: { sharedPhoto: false } });
  assert.strictEqual(result.verdict, 'UNCERTAIN');
  assert.notStrictEqual(result.verdict, 'CONFIRMED_MISMATCH');
});
```

Note: the existing smoke test at lines 239-247 ("suspect + sharedPhoto=false → CONFIRMED_MISMATCH regardless of price") tests `price_pct_diff: 0.01` (price agrees) and currently asserts CONFIRMED_MISMATCH — that assertion must be inverted to UNCERTAIN after the fix is applied.

---

### `lib/spotcheck-slack-bot.js` (utility, request-response + inbound)

**Analog (outbound half):** `cron-wrapper.js` lines 32-55 (`sendSlackAlert` via HTTPS + webhook URL)

**Outbound pattern** — copy and adapt `cron-wrapper.js` lines 32-55. The bot-token path uses `chat.postMessage` (not webhook) but the same raw `https.request` approach applies:

```javascript
// cron-wrapper.js lines 32-55 — Slack HTTPS request idiom
async function sendSlackAlert(webhookUrl, text, log) {
  try {
    const parsed = new URL(webhookUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ text });

    await new Promise((resolve, reject) => {
      const req = transport.request(parsed, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Slack request timeout')); });
      req.write(payload);
      req.end();
    });
    log('INFO', 'Slack alert sent');
  } catch (err) {
    log('ERROR', `Slack alert failed: ${err.message}`);
  }
}
```

**New bot-token outbound** — adapt the idiom above to call `https://slack.com/api/chat.postMessage` with `Authorization: Bearer ${SLACK_BOT_TOKEN}` instead of a webhook URL. Returns the message `ts` (timestamp) for later reaction polling.

**New inbound (reactions read)** — `https://slack.com/api/reactions.getPermalink` / `reactions.get` — same raw HTTPS pattern, GET with `?channel=&timestamp=` query params and `Authorization: Bearer`. No existing analog in the repo; model the retry/error handling after `cron-wrapper.js` `connectWithRetry` (lines 18-30).

**Env var convention** — `SLACK_BOT_TOKEN` (new). Keep `SLACK_WEBHOOK_URL` (existing, used by cron-wrapper for failure/warning alerts). Never use one for the other's purpose.

**Module exports:**

```javascript
module.exports = {
  postReviewMessage,   // (channel, text) -> { ok, ts } | null
  postDigestMessage,   // (channel, pairs[]) -> { ok, ts } | null
  getReactions,        // (channel, ts) -> [{ name, users }] | null
};
```

**--smoke pattern:** same `check()` + `assert` + `process.exit` structure as `lib/spotcheck-vision.js` lines 186-268. Offline smoke: assert all functions are exported, assert that missing SLACK_BOT_TOKEN returns null without throwing.

---

### `lib/spotcheck-review-store.js` (service, CRUD)

**Analog:** `cohort-create.js` lines 153-179 (INSERT pattern, parameterised queries) + `cron-setup.js` lines 7-28 (CREATE TABLE IF NOT EXISTS pattern) + `db.js` (createClient)

**createClient import** — copy from `cron-setup.js` lines 1-2:

```javascript
const { createClient } = require('./db');
```

**DDL pattern for new tables** — copy `cohort-setup.js` / `cron-setup.js` style: `CREATE TABLE IF NOT EXISTS`, inline column list, named UNIQUE constraints. The two new tables:

```javascript
// spotcheck_review — message refs + open verdicts (D-12)
await client.query(`
  CREATE TABLE IF NOT EXISTS spotcheck_review (
    id           SERIAL PRIMARY KEY,
    pair_id      INTEGER NOT NULL,
    cohort_id    TEXT NOT NULL,
    channel      TEXT NOT NULL,
    ts           TEXT NOT NULL,             -- Slack message timestamp (opaque string)
    vision_verdict TEXT,                    -- 'MATCH'|'MISMATCH'|null
    human_verdict  TEXT,                    -- 'CONFIRMED_MISMATCH'|'OVERRIDE_MATCH'|'UNCERTAIN'|null
    reactor      TEXT,                      -- Slack user ID who reacted
    adjudicated_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pair_id, cohort_id)              -- dedup: never re-surface same pair
  )
`);

// spotcheck_removed_pairs — audit trail for cohort_pairs hard-removes (D-11)
await client.query(`
  CREATE TABLE IF NOT EXISTS spotcheck_removed_pairs (
    id           SERIAL PRIMARY KEY,
    pair_id      INTEGER NOT NULL,
    cohort_id    TEXT NOT NULL,
    booli_id     BIGINT NOT NULL,
    hemnet_id    BIGINT NOT NULL,
    vision_verdict TEXT,
    human_verdict  TEXT NOT NULL,
    reactor      TEXT,
    reason       TEXT,
    removed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
```

**INSERT pattern** — copy `cohort-create.js` lines 159-178 (parameterised `$1,$2…`, ON CONFLICT DO NOTHING):

```javascript
// cohort-create.js lines 159-178 — canonical INSERT pattern
await client.query(`
  INSERT INTO cohort_pairs
    (cohort_id, booli_id, hemnet_id, ...)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (cohort_id, booli_id, hemnet_id) DO NOTHING
`, [ ... ]);
```

**cohort_pairs hard-delete with audit** — new operation, no existing analog (all existing writes are INSERT/UPDATE, never DELETE). Pattern: wrap in a transaction, INSERT audit record first, then DELETE:

```javascript
async function removeConfirmedMismatchPair(client, { pairId, cohortId, booliId, hemnetId, visionVerdict, humanVerdict, reactor, reason }) {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO spotcheck_removed_pairs
         (pair_id, cohort_id, booli_id, hemnet_id, vision_verdict, human_verdict, reactor, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [pairId, cohortId, booliId, hemnetId, visionVerdict, humanVerdict, reactor, reason]
    );
    await client.query('DELETE FROM cohort_pairs WHERE id = $1', [pairId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
```

**Module exports:**

```javascript
module.exports = {
  upsertReviewMessage,      // (client, { pairId, cohortId, channel, ts, visionVerdict }) -> void
  markAdjudicated,          // (client, { pairId, cohortId, humanVerdict, reactor }) -> void
  removeConfirmedMismatchPair, // (client, { ... }) -> void (audit + delete, wrapped in BEGIN/COMMIT)
  getOpenReviewMessages,    // (client) -> [{ id, pair_id, cohort_id, channel, ts, vision_verdict }]
  isAlreadyAdjudicated,     // (client, { pairId, cohortId }) -> boolean
};
```

---

### `cohort-spotcheck-gate.js` (extend existing orchestrator)

**Analog:** itself. Phase 13 adds three new sections into the existing `main(client, log)` function.

**Current import block** (`cohort-spotcheck-gate.js` lines 26-34) — add new lib imports:

```javascript
// Existing imports (lines 26-34)
const { runJob }          = require('./cron-wrapper');
const { execFileSync }    = require('child_process');
const fs                  = require('fs');
const path                = require('path');
const { adjudicatePairs } = require('./lib/spotcheck-adjudicate');
const { computeSummary, renderSlackAlert, renderSummaryMd } = require('./lib/spotcheck-summary');

// Phase 13 additions
const { minDHashDistance }    = require('./lib/spotcheck-dhash');
const { postReviewMessage, postDigestMessage } = require('./lib/spotcheck-slack-bot');
const { upsertReviewMessage } = require('./lib/spotcheck-review-store');
```

**ISO-week guard (D-13)** — insert after step 1 (cohort resolution, after line 103):

```javascript
// D-13: Current-ISO-week guard — skip rather than silently re-check a stale cohort
const currentIsoWeek = isoWeekId(new Date()); // e.g. '2026-W24'
if (cohortId !== currentIsoWeek) {
  const msg = `cohort-spotcheck-gate: resolved cohort ${cohortId} != current ISO week ${currentIsoWeek} — skipping`;
  log('WARN', msg);
  // Alert via existing SLACK_WEBHOOK_URL path: return a warning-shaped summary.
  return { skipped: true, reason: `stale cohort: ${cohortId} vs current ${currentIsoWeek}` };
}
```

**dHash step** — insert between step 6 (artifact loaded) and step 7 (adjudication), i.e. after line 159 and before line 181:

```javascript
// 6b. dHash cross-compare: for each pair with both galleries, compute min Hamming distance.
//     Auto-confirm as CONFIRMED_MATCH when minDist <= DHASH_THRESHOLD (default 6, D-02).
//     Log every pair's min-distance so the threshold can be calibrated from real data.
const DHASH_THRESHOLD = parseInt(process.env.DHASH_THRESHOLD || '6', 10);
const dhashResults = {};
for (const p of (artifact.pairs || [])) {
  const photos = p.photos || {};
  const booliFiles  = (photos.booli_gallery  || []).map(g => path.join(artifactDir, g.file));
  const hemnetFiles = (photos.hemnet_gallery || []).map(g => path.join(artifactDir, g.file));
  if (booliFiles.length === 0 || hemnetFiles.length === 0) continue;
  const { minDist } = await minDHashDistance(booliFiles, hemnetFiles);
  dhashResults[p.pair_id] = { minDist };
  log('INFO', `dHash pair ${p.pair_id}: minDist=${minDist}`);
}
```

**Slack review-queue step (D-07/D-08/D-09)** — insert after step 9 (artifacts written), around line 234:

```javascript
// 9b. Post review queue to Slack (D-07): weekly digest + per-mismatch messages.
const botToken = process.env.SLACK_BOT_TOKEN;
const reviewChannel = process.env.SLACK_REVIEW_CHANNEL;
if (botToken && reviewChannel) {
  const uncertainPairs = verdicts.filter(v => v.verdict === 'UNCERTAIN');
  const mismatchPairs  = verdicts.filter(v => v.verdict === 'CONFIRMED_MISMATCH');

  // Weekly digest: all UNCERTAIN pairs
  if (uncertainPairs.length > 0) {
    const { ts } = await postDigestMessage(reviewChannel, uncertainPairs) || {};
    if (ts) {
      for (const p of uncertainPairs) {
        await upsertReviewMessage(client, {
          pairId: p.pair_id, cohortId, channel: reviewChannel, ts,
          visionVerdict: (visionResults && visionResults[p.pair_id]) ? visionResults[p.pair_id].sharedPhoto : null,
        });
      }
    }
  }
  // Individual message per vision-flagged MISMATCH (D-07)
  for (const p of mismatchPairs) {
    const { ts } = await postReviewMessage(reviewChannel, p) || {};
    if (ts) {
      await upsertReviewMessage(client, {
        pairId: p.pair_id, cohortId, channel: reviewChannel, ts,
        visionVerdict: 'MISMATCH',
      });
    }
  }
}
```

**runJob registration** — keep as-is (`cohort-spotcheck-gate.js` lines 266-279). The `validate()` function already handles `skipped: true` by returning null. No changes needed there.

---

### `spotcheck-reaction-poller.js` (controller/cron, event-driven)

**Analog:** `cohort-spotcheck-gate.js` (full `runJob` registration pattern, lines 266-279) + `cron-wrapper.js` (runJob contract, lines 57-172)

**runJob registration** — copy from `cohort-spotcheck-gate.js` lines 266-279 exactly:

```javascript
// cohort-spotcheck-gate.js lines 266-279 — canonical runJob wire-up
runJob({
  scriptName: 'cohort-spotcheck-gate',
  main,
  validate: (summary) => {
    if (!summary || summary.skipped) return null;
    if (summary.fetchFailures > 0) {
      return `${summary.fetchFailures} fetch failure(s) during spot-check gate (cohort ${summary.cohortId})`;
    }
    if (summary.confirmedMismatchRate > summary.threshold) {
      return summary.slackMsg;
    }
    return null;
  },
});
```

**Adapted for poller:**

```javascript
// spotcheck-reaction-poller.js
'use strict';

const { runJob }              = require('./cron-wrapper');
const { getReactions }        = require('./lib/spotcheck-slack-bot');
const { getOpenReviewMessages, markAdjudicated, removeConfirmedMismatchPair, isAlreadyAdjudicated }
                              = require('./lib/spotcheck-review-store');
const { createClient }        = require('./db');  // only if not passed via runJob

async function main(client, log) {
  const channel = process.env.SLACK_REVIEW_CHANNEL;
  if (!process.env.SLACK_BOT_TOKEN || !channel) {
    log('WARN', 'SLACK_BOT_TOKEN or SLACK_REVIEW_CHANNEL not set — poller skipping');
    return { skipped: true, reason: 'no bot token/channel', applied: 0 };
  }

  const openMessages = await getOpenReviewMessages(client);
  log('INFO', `reaction-poller: ${openMessages.length} open review message(s) to check`);
  let applied = 0;

  for (const msg of openMessages) {
    const reactions = await getReactions(msg.channel, msg.ts);
    if (!reactions) continue;
    // D-08: ✅ = confirm mismatch (remove pair) | ❌ = override match (keep) | ❓ = leave UNCERTAIN
    const confirm   = reactions.find(r => r.name === 'white_check_mark');
    const override  = reactions.find(r => r.name === 'x');
    // ... apply verdict, call markAdjudicated / removeConfirmedMismatchPair ...
    applied++;
  }

  return { skipped: false, applied, checked: openMessages.length };
}

runJob({
  scriptName: 'spotcheck-reaction-poller',
  main,
  validate: (summary) => {
    if (!summary || summary.skipped) return null;
    return null; // poller failure is logged via cron_job_log; no Slack escalation needed
  },
});
```

**Cron schedule** — daily (D-10). Following `setup-droplet.sh` line 36 style:

```
0 12 * * *  cd /opt/hemnet-cohort-tracker && node spotcheck-reaction-poller.js
```

---

### `migrate-spotcheck-phase13.js` (migration, CRUD)

**Analog:** `cron-setup.js` (lines 1-33) and `cohort-setup.js` (lines 1-78) — both use the same `createClient + connect + CREATE TABLE IF NOT EXISTS + client.end()` pattern.

**Full structure to copy from `cron-setup.js` lines 1-33:**

```javascript
const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS ...
  `);
  console.log('Created table: ...');

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

The migration creates `spotcheck_review` and `spotcheck_removed_pairs` (DDL shown in the review-store section above).

---

## Shared Patterns

### DB access (raw pg via db.js)
**Source:** `db.js` lines 1-16, used in every job
**Apply to:** `lib/spotcheck-review-store.js`, `migrate-spotcheck-phase13.js`, `spotcheck-reaction-poller.js`
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

### runJob contract
**Source:** `cron-wrapper.js` lines 57-172 + `cohort-spotcheck-gate.js` lines 266-279
**Apply to:** `spotcheck-reaction-poller.js` (new cron job), `cohort-spotcheck-gate.js` (unchanged wire-up)

Key contract: `main(client, log)` receives a connected pg Client + logger. Returns a plain result object. `validate(summary)` returns a non-null string to trigger `SLACK_WEBHOOK_URL` alert, or null for no alert. `cron_job_log` row is written automatically by `runJob`.

```javascript
// cron-wrapper.js lines 57-72 — runJob signature
async function runJob({ scriptName, main, validate }) {
  const log = makeLogger(scriptName);
  // ... connects DB, inserts cron_job_log row, calls main(client, log),
  //     calls validate(resultSummary), fires SLACK_WEBHOOK_URL on warning/failure ...
}
```

### lib module --smoke self-test
**Source:** `lib/spotcheck-adjudicate.js` lines 142-310, `lib/spotcheck-vision.js` lines 186-268, `lib/spotcheck-summary.js` lines 226-427
**Apply to:** `lib/spotcheck-dhash.js`, `lib/spotcheck-slack-bot.js`, `lib/spotcheck-review-store.js`

Pattern: `check()` sync helper + `checkAsync()` async helper, `assert` from stdlib, `process.exit(fail === 0 ? 0 : 1)`. Guard behind `require.main === module && process.argv.includes('--smoke')`. Never requires DB or network.

```javascript
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  // ...sync tests...
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

For async tests, add the IIFE + `.catch` pattern from `lib/spotcheck-vision.js` lines 211-268:

```javascript
(async () => {
  await checkAsync('...', async () => { ... });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
  process.exit(1);
});
```

### Lazy SDK / env-key guard for optional integrations
**Source:** `lib/spotcheck-vision.js` lines 35-41
**Apply to:** `lib/spotcheck-slack-bot.js` (SLACK_BOT_TOKEN missing → return null, no throw)

```javascript
// lib/spotcheck-vision.js lines 35-41
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
```

Adapt for Slack: if `!process.env.SLACK_BOT_TOKEN` return null / skip silently. Never crash on missing env.

### Error handling: never throw from lib helpers
**Source:** `lib/spotcheck-vision.js` lines 145-173 (try/catch returning null on API error, parse error)
**Apply to:** `lib/spotcheck-slack-bot.js` (postReviewMessage, getReactions both return null on error), `lib/spotcheck-dhash.js` (hashImage try/catch skip on unreadable file, `scripts/spotcheck-phash-probe.js` lines 98-103)

```javascript
// spotcheck-phash-probe.js lines 98-103 — skip-on-error pattern for image hashing
async function hashAll(files) {
  const out = [];
  for (const f of files) {
    try { out.push(await hashImage(f)); } catch (e) { /* skip unreadable */ }
  }
  return out;
}
```

### Parameterised queries, no string interpolation
**Source:** `cohort-create.js` lines 153-178, `cron-setup.js` lines 19-18
**Apply to:** all DB writes in `lib/spotcheck-review-store.js`, `spotcheck-reaction-poller.js`

Always use `$1,$2,...` placeholders. T-12-04 note in `cohort-spotcheck-gate.js` line 108: "Uses argv array (NOT shell string)". Same discipline applies to DB params.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `lib/spotcheck-slack-bot.js` (inbound half) | utility | request-response (inbound) | `reactions.get` polling is a first-ever inbound Slack API call in this repo; only outbound webhook existed before |
| `spotcheck-reaction-poller.js` validate() | controller | event-driven | No existing event-driven poller in the repo; runJob wraps it but the reaction-apply logic is novel |

For the inbound Slack API call, use the same raw `https.request` pattern from `cron-wrapper.js` `sendSlackAlert` (lines 32-55), adapted to a GET with Authorization header. Consult RESEARCH.md / Slack API docs for `reactions.get` endpoint shape.

---

## Metadata

**Analog search scope:** project root + `lib/` + `scripts/`
**Files scanned:** 12
**Pattern extraction date:** 2026-06-11
