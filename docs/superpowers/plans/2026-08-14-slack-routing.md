# Slack Routing (D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every Slack output by audience instead of by credential — business reports to `#hemnet-status`, ops traffic and the human-review queue to a new ops channel — through one shared module with a real dry-run.

**Architecture:** A new `lib/slack-post.js` owns a job→audience table and all outbound posting. Callers name themselves (`'sold-match-report'`), never a channel; the module resolves the channel. Bot token (`chat.postMessage`) is the single transport, with one deliberate exception: `cron-wrapper`'s failure alert keeps the incoming webhook, so the thing that reports breakage cannot break with the bot. A job absent from the table throws at call time — a reporter with no declared audience is a bug, not a default.

**Tech Stack:** Node.js (CommonJS), `https` core module only, `dotenv`, Postgres via `pg`. No test framework — this repo tests with `node <file> --smoke` self-tests using `assert`.

**Spec:** `docs/superpowers/specs/2026-08-14-slack-reporting-routing-design.md` (§3 is this plan; §4 E and §5 F get their own plans; §6 G is deferred)

## Global Constraints

- **Never post to Slack from a test.** Every self-test runs offline with no network call. Tests that exercise posting inject a fake transport via the `deps` parameter.
- **`env -u SLACK_BOT_TOKEN node …` does NOT dry-run — it posts.** `dotenv.config()` re-injects the token from `.env`. The only reliable guards are `--dry-run` (mapped to `SLACK_DRY_RUN=1` in-process) and `SLACK_DRY_RUN=1`. This has already caused one accidental live post.
- **Every reporter gets a strict argv gate**, following `age-census-report.js:660-680`: an `ACCEPTED_ARGV` set, and anything unrecognised exits non-zero with usage. Without the gate, an unknown flag falls through to the live path and posts.
- **Node version:** whatever the droplet runs (Node 18+). No new npm dependencies in this plan.
- **Channel env vars:** `SLACK_STATUS_CHANNEL` (business), `SLACK_OPS_CHANNEL` (ops). `SLACK_REVIEW_CHANNEL` is retired but read as a fallback for `SLACK_OPS_CHANNEL` while it is unset, so code and `.env` can land in either order.
- **Commit style:** conventional commits, one commit per task, `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` at the end of the message.
- **`uploadFiles` is deliberately NOT in this plan.** Spec §3.1 lists it in the module, but its only consumer is E (market-totals delivery), and `files:write` is not yet on the app. It lands with the E plan. Flagged as a conscious deviation from the spec's module shape.
- **`adcost-report` is deliberately NOT in the routing table.** Spec §3.1 lists it under `business`, but G is deferred (§6) and no such job exists in this repo. Task 2's coverage test asserts the table names only jobs that exist, so adding it now would fail that test. It joins the table with G.

---

### Task 1: The routing table and channel resolution

The pure core: which job belongs to which audience, and which env var that maps to. No network, no I/O.

**Files:**
- Create: `lib/slack-post.js`

**Interfaces:**
- Produces:
  - `AUDIENCE` — `Object<string, 'business'|'ops'>`, the job→audience table
  - `resolveChannel(job: string) -> string` — throws `Error` on unknown job or unset channel env var
  - `isDryRun() -> boolean`

- [ ] **Step 1: Write the failing test**

Create `lib/slack-post.js` containing ONLY the self-test block below (the implementation arrives in Step 3). This repo has no test runner; the `--smoke` block IS the test file, and it must run offline.

```js
// lib/slack-post.js
'use strict';

module.exports = {};

// ---------------------------------------------------------------
// --smoke self-test (offline: no network, no DB, no Slack)
//   node lib/slack-post.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { AUDIENCE, resolveChannel, isDryRun } = module.exports;
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); console.log(`  PASS  ${name}`); pass++; }
    catch (e) { console.error(`  FAIL  ${name}: ${e.message}`); fail++; }
  }

  const saved = {
    status: process.env.SLACK_STATUS_CHANNEL,
    ops: process.env.SLACK_OPS_CHANNEL,
    review: process.env.SLACK_REVIEW_CHANNEL,
    dry: process.env.SLACK_DRY_RUN,
  };

  check('every job in the table is business or ops', () => {
    for (const [job, audience] of Object.entries(AUDIENCE)) {
      assert.ok(['business', 'ops'].includes(audience), `${job} has audience "${audience}"`);
    }
  });

  check('business job resolves to SLACK_STATUS_CHANNEL', () => {
    process.env.SLACK_STATUS_CHANNEL = 'C0BUSINESS';
    assert.strictEqual(resolveChannel('sold-match-report'), 'C0BUSINESS');
  });

  check('ops job resolves to SLACK_OPS_CHANNEL', () => {
    process.env.SLACK_OPS_CHANNEL = 'C0OPS';
    assert.strictEqual(resolveChannel('cron-health-slack'), 'C0OPS');
  });

  check('ops falls back to SLACK_REVIEW_CHANNEL while SLACK_OPS_CHANNEL is unset', () => {
    delete process.env.SLACK_OPS_CHANNEL;
    process.env.SLACK_REVIEW_CHANNEL = 'C0LEGACY';
    assert.strictEqual(resolveChannel('spotcheck-reaction-poller'), 'C0LEGACY');
  });

  check('unknown job throws and names the job', () => {
    assert.throws(() => resolveChannel('not-a-real-job'), /not-a-real-job/);
  });

  check('missing channel env throws rather than posting somewhere arbitrary', () => {
    delete process.env.SLACK_OPS_CHANNEL;
    delete process.env.SLACK_REVIEW_CHANNEL;
    assert.throws(() => resolveChannel('cron-health-slack'), /SLACK_OPS_CHANNEL/);
  });

  check('SLACK_DRY_RUN=1 and DRY_RUN=1 both mean dry run', () => {
    process.env.SLACK_DRY_RUN = '1';
    assert.strictEqual(isDryRun(), true);
    delete process.env.SLACK_DRY_RUN;
    process.env.DRY_RUN = '1';
    assert.strictEqual(isDryRun(), true, 'DRY_RUN=1 is the existing convention in age-census-report.js');
    delete process.env.DRY_RUN;
    assert.strictEqual(isDryRun(), false);
  });

  process.env.SLACK_STATUS_CHANNEL = saved.status || '';
  process.env.SLACK_OPS_CHANNEL = saved.ops || '';
  process.env.SLACK_REVIEW_CHANNEL = saved.review || '';
  if (saved.dry) process.env.SLACK_DRY_RUN = saved.dry;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/slack-post.js --smoke`
Expected: FAIL — a `TypeError` because `AUDIENCE` is undefined (`module.exports` is empty).

- [ ] **Step 3: Write minimal implementation**

Insert above the self-test block, replacing `module.exports = {};`:

```js
// ---------------------------------------------------------------
// Routing table. A job's NAME decides its audience; no caller ever
// names a channel. Adding a reporter means adding a row here — a job
// missing from the table throws at call time (see resolveChannel),
// because a reporter with no declared audience is a bug, not a default.
// ---------------------------------------------------------------
const AUDIENCE = {
  // business — what the operator reads for insight, in #hemnet-status
  'weekly-view-report': 'business',
  'market-totals-weekly-report': 'business',
  'premarket-flow-weekly-report': 'business',
  'sold-match-report': 'business',
  'age-census-report': 'business',

  // ops — what the operator reads to run the system, in the ops channel
  'cron-health-slack': 'ops',
  'cohort-spotcheck-gate': 'ops',        // the per-pair human review queue
  'spotcheck-reaction-poller': 'ops',    // stale-review escalation
  'cron-wrapper': 'ops',                 // job failure/warning alerts
};

const ENV_BY_AUDIENCE = {
  business: ['SLACK_STATUS_CHANNEL'],
  // SLACK_REVIEW_CHANNEL is retired but honoured while SLACK_OPS_CHANNEL is
  // unset, so the code and the .env edit can land in either order.
  ops: ['SLACK_OPS_CHANNEL', 'SLACK_REVIEW_CHANNEL'],
};

function resolveChannel(job) {
  const audience = AUDIENCE[job];
  if (!audience) {
    throw new Error(
      `slack-post: job "${job}" is not in the routing table. Add it to AUDIENCE in lib/slack-post.js ` +
      `with an explicit 'business' or 'ops' audience.`
    );
  }
  const names = ENV_BY_AUDIENCE[audience];
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  throw new Error(`slack-post: job "${job}" is ${audience} but ${names[0]} is not set`);
}

// dotenv re-injects tokens from .env, so `env -u` does NOT prevent a post.
// These two flags are the only reliable guards. DRY_RUN=1 is the convention
// already used by age-census-report.js and scripts/age-census-monthly.js.
function isDryRun() {
  return process.env.SLACK_DRY_RUN === '1' || process.env.DRY_RUN === '1';
}

module.exports = { AUDIENCE, resolveChannel, isDryRun };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node lib/slack-post.js --smoke`
Expected: PASS — `7 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add lib/slack-post.js
git commit -m "feat(slack): routing table resolves a job name to its audience channel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Posting, dry-run, and the webhook fallback

`postMessage` and `postAlert`, with an injectable transport so the fallback path is testable without a network.

**Files:**
- Modify: `lib/slack-post.js`

**Interfaces:**
- Consumes: `resolveChannel`, `isDryRun` (Task 1)
- Produces:
  - `postMessage(job: string, text: string, deps?: {chatPost, webhookPost}) -> Promise<{ok: boolean, ts: string|null, channel: string, dryRun?: boolean, degraded?: boolean}>`
  - `postAlert(text: string, deps?: {webhookPost}) -> Promise<{ok: boolean}>`
  - `deps.chatPost(channel, text) -> Promise<{ok, ts, channel}|null>`; `deps.webhookPost(url, text) -> Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Add these checks inside the `--smoke` block, before the env restore lines. Add the async harness at the top of the block, next to `check`:

```js
  async function checkAsync(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); pass++; }
    catch (e) { console.error(`  FAIL  ${name}: ${e.message}`); fail++; }
  }

  (async () => {
    const { postMessage, postAlert } = module.exports;

    await checkAsync('dry run renders to stdout and makes no call', async () => {
      process.env.SLACK_STATUS_CHANNEL = 'C0BUSINESS';
      process.env.SLACK_DRY_RUN = '1';
      let called = false;
      const res = await postMessage('sold-match-report', 'hello', {
        chatPost: async () => { called = true; return { ok: true, ts: '1.1' }; },
      });
      assert.strictEqual(called, false, 'dry run must not call the transport');
      assert.strictEqual(res.dryRun, true);
      assert.strictEqual(res.ts, null);
      delete process.env.SLACK_DRY_RUN;
    });

    await checkAsync('happy path returns the ts for threading', async () => {
      const res = await postMessage('sold-match-report', 'hello', {
        chatPost: async (channel, text) => {
          assert.strictEqual(channel, 'C0BUSINESS');
          assert.strictEqual(text, 'hello');
          return { ok: true, ts: '1755000000.001', channel };
        },
      });
      assert.strictEqual(res.ts, '1755000000.001');
      assert.strictEqual(res.degraded, undefined);
    });

    await checkAsync('bot failure falls back to the webhook and marks degradation', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
      let fellBack = false;
      const res = await postMessage('sold-match-report', 'hello', {
        chatPost: async () => null,
        webhookPost: async () => { fellBack = true; return true; },
      });
      assert.strictEqual(fellBack, true, 'a report must never be silently lost');
      assert.strictEqual(res.degraded, true);
      assert.strictEqual(res.ok, true);
    });

    await checkAsync('both transports down reports failure rather than claiming success', async () => {
      const res = await postMessage('sold-match-report', 'hello', {
        chatPost: async () => null,
        webhookPost: async () => false,
      });
      assert.strictEqual(res.ok, false);
    });

    await checkAsync('postAlert uses the webhook only — it must not need the bot', async () => {
      let usedWebhook = false;
      const res = await postAlert('[FAILURE] something broke', {
        webhookPost: async () => { usedWebhook = true; return true; },
      });
      assert.strictEqual(usedWebhook, true);
      assert.strictEqual(res.ok, true);
    });

    await checkAsync('an unknown job throws before any transport is touched', async () => {
      let called = false;
      await assert.rejects(
        () => postMessage('mystery-job', 'x', { chatPost: async () => { called = true; return { ok: true }; } }),
        /mystery-job/
      );
      assert.strictEqual(called, false);
    });

    // --- coverage: the table and the repo agree ---
    await checkAsync('every job in the table exists as a script in the repo', async () => {
      const fs = require('fs');
      const path = require('path');
      const root = path.join(__dirname, '..');
      for (const job of Object.keys(AUDIENCE)) {
        const candidates = [
          path.join(root, `${job}.js`),
          path.join(root, 'lib', `${job}.js`),
          path.join(root, 'scripts', `${job}.js`),
        ];
        assert.ok(candidates.some(p => fs.existsSync(p)), `${job} is in the routing table but no such script exists`);
      }
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })();
```

Move the env-restore lines and the original `console.log`/`process.exit` pair to the end of this async block so the summary prints once.

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/slack-post.js --smoke`
Expected: FAIL — `postMessage is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add above `module.exports`:

```js
const https = require('https');

// Real transports. Both mirror the existing lib/spotcheck-slack-bot.js and
// cron-wrapper.js implementations: 10s timeout, never throw, resolve falsy on error.
async function chatPostMessage(channel, text) {
  const tok = process.env.SLACK_BOT_TOKEN;
  if (!tok) return null;
  const payload = JSON.stringify({ channel, text });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.ok) {
            console.warn(`[slack-post] chat.postMessage ok=false: ${json.error || body}`);
            return resolve(null);
          }
          resolve({ ok: true, ts: json.ts, channel: json.channel });
        } catch (e) {
          console.warn(`[slack-post] chat.postMessage parse error: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.warn(`[slack-post] chat.postMessage error: ${e.message}`); resolve(null); });
    req.setTimeout(10000, () => { req.destroy(); console.warn('[slack-post] chat.postMessage timeout'); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function webhookPostMessage(webhookUrl, text) {
  if (!webhookUrl) return false;
  const payload = JSON.stringify({ text });
  const parsed = new URL(webhookUrl);
  return new Promise((resolve) => {
    const req = https.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', (e) => { console.warn(`[slack-post] webhook error: ${e.message}`); resolve(false); });
    req.setTimeout(10000, () => { req.destroy(); console.warn('[slack-post] webhook timeout'); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// postMessage(job, text) — the one way a report reaches Slack.
// Resolves the channel from the job name, honours dry run, and falls back to
// the webhook if the bot call fails: a report may be mis-routed, but it must
// never be silently lost.
async function postMessage(job, text, deps = {}) {
  const channel = resolveChannel(job);          // throws on an unknown job, before any I/O
  const chatPost = deps.chatPost || chatPostMessage;
  const webhookPost = deps.webhookPost || webhookPostMessage;

  if (isDryRun()) {
    console.log(`--- DRY RUN: ${job} -> ${channel} ---\n${text}\n--- end dry run ---`);
    return { ok: true, ts: null, channel, dryRun: true };
  }

  const res = await chatPost(channel, text);
  if (res && res.ok) return { ok: true, ts: res.ts, channel };

  console.warn(`[slack-post] ${job}: chat.postMessage failed — falling back to the webhook`);
  const sent = await webhookPost(process.env.SLACK_WEBHOOK_URL, `[degraded routing: ${job}]\n${text}`);
  return { ok: !!sent, ts: null, channel, degraded: true };
}

// postAlert(text) — cron-wrapper's failure alert. Webhook ONLY, deliberately:
// this is the last line of defence, so it must not share a failure mode with
// the bot token it is there to report on. The webhook must point at the ops
// channel (operator action; see deploy-instructions.md).
async function postAlert(text, deps = {}) {
  const webhookPost = deps.webhookPost || webhookPostMessage;
  if (isDryRun()) {
    console.log(`--- DRY RUN: alert ---\n${text}\n--- end dry run ---`);
    return { ok: true, dryRun: true };
  }
  const sent = await webhookPost(process.env.SLACK_WEBHOOK_URL, text);
  return { ok: !!sent };
}
```

Update the exports line:

```js
module.exports = { AUDIENCE, resolveChannel, isDryRun, postMessage, postAlert };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node lib/slack-post.js --smoke`
Expected: PASS — `14 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add lib/slack-post.js
git commit -m "feat(slack): postMessage with dry-run and webhook fallback, postAlert on the webhook

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Migrate the four webhook business reporters

`weekly-view-report`, `market-totals-weekly-report`, `premarket-flow-weekly-report`, `age-census-report` each carry their own copy of `sendSlack()` and post to whatever channel the webhook happens to point at. All four become one `postMessage` call to the business channel.

**Files:**
- Modify: `weekly-view-report.js:9-30` (delete `sendSlack`), `weekly-view-report.js:95-122` (call site)
- Modify: `market-totals-weekly-report.js:159-168`
- Modify: `premarket-flow-weekly-report.js:286-295`
- Modify: `age-census-report.js:342-346`

**Interfaces:**
- Consumes: `postMessage(job, text)` (Task 2)

- [ ] **Step 1: Write the failing test**

Add to `lib/slack-post.js`'s smoke block — this asserts the migration is complete and stays complete:

```js
    await checkAsync('no reporter carries its own sendSlack or reads SLACK_WEBHOOK_URL directly', async () => {
      const fs = require('fs');
      const path = require('path');
      const root = path.join(__dirname, '..');
      // Grows by one file per migration task: Task 4 adds cron-health-slack.js,
      // Task 5 adds sold-match-report.js. Keep it to what is already migrated,
      // so every task ends with the suite green.
      const migrated = [
        'weekly-view-report.js', 'market-totals-weekly-report.js',
        'premarket-flow-weekly-report.js', 'age-census-report.js',
      ];
      for (const f of migrated) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        assert.ok(!/function sendSlack\s*\(/.test(src), `${f} still defines its own sendSlack()`);
        assert.ok(!/process\.env\.SLACK_WEBHOOK_URL/.test(src), `${f} still reads SLACK_WEBHOOK_URL directly`);
        assert.ok(/require\(['"]\.\/lib\/slack-post['"]\)/.test(src), `${f} does not use lib/slack-post`);
      }
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/slack-post.js --smoke`
Expected: FAIL — `weekly-view-report.js still defines its own sendSlack()`

- [ ] **Step 3: Write minimal implementation**

In `weekly-view-report.js`: delete the `sendSlack` function (lines 9-30) and the now-unused `https` require if nothing else uses it. At the top add:

```js
const { postMessage } = require('./lib/slack-post');
```

Replace the posting block (around lines 95-122) with:

```js
  if (serverHost) {
    try {
      await postMessage('weekly-view-report', message);
      console.log('Slack notification sent');
    } catch (err) {
      console.error(`Slack failed: ${err.message}`);
    }
  } else {
    console.log('Skipping Slack (VIEW_SERVER_HOST not set)');
  }
```

Apply the same three edits to the other three files, using their own job names — `'market-totals-weekly-report'`, `'premarket-flow-weekly-report'`, `'age-census-report'` — and keeping each file's existing message-building code untouched. In `age-census-report.js`, delete the local `DRY_RUN === '1'` early return at line 344: `postMessage` now owns dry-run, and leaving both means the message is never rendered for inspection during a dry run.

- [ ] **Step 4: Run test to verify it passes**

Run each of these — all four must render their message to stdout and make no network call:

```bash
node lib/slack-post.js --smoke
node age-census-report.js --dry-run
SLACK_DRY_RUN=1 node market-totals-weekly-report.js
SLACK_DRY_RUN=1 node premarket-flow-weekly-report.js
SLACK_DRY_RUN=1 node weekly-view-report.js
```

Expected: smoke PASSES; each reporter prints `--- DRY RUN: <job> -> C0… ---` followed by its message. These four read the production DB, so run them where `.env` resolves — they are read-only queries.

- [ ] **Step 5: Commit**

```bash
git add weekly-view-report.js market-totals-weekly-report.js premarket-flow-weekly-report.js age-census-report.js lib/slack-post.js
git commit -m "refactor(slack): four business reporters post via the shared helper

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Migrate `cron-health-slack.js` to ops

The daily health report is ops, not business. It already has a `--dry-run`; that becomes the shared one.

**Files:**
- Modify: `cron-health-slack.js:94-110` (its `sendSlack` and dry-run handling)

**Interfaces:**
- Consumes: `postMessage(job, text)` (Task 2)

- [ ] **Step 1: Write the failing test**

Add `'cron-health-slack.js'` to the `migrated` array in the smoke block's "no reporter carries its own sendSlack" check:

```js
      const migrated = [
        'weekly-view-report.js', 'market-totals-weekly-report.js',
        'premarket-flow-weekly-report.js', 'age-census-report.js',
        'cron-health-slack.js',
      ];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/slack-post.js --smoke`
Expected: FAIL — `cron-health-slack.js still defines its own sendSlack()`

Also capture the baseline the migration must preserve — `node cron-health-slack.js --dry-run` renders the report to stdout and posts nothing.

- [ ] **Step 3: Write minimal implementation**

Add `const { postMessage } = require('./lib/slack-post');` at the top. Delete the local `sendSlack` function and the `SLACK_WEBHOOK_URL` read. Replace the send with:

```js
  await postMessage('cron-health-slack', text);
```

Keep the existing `--dry-run` argv handling, but make it set the shared flag instead of branching locally:

```js
  if (process.argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node lib/slack-post.js --smoke
node cron-health-slack.js --dry-run
```

Expected: smoke PASSES; the report renders under `--- DRY RUN: cron-health-slack -> C0… ---` with no network call.

- [ ] **Step 5: Commit**

```bash
git add cron-health-slack.js
git commit -m "refactor(slack): daily health report routes to ops via the shared helper

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Split the bot-token consumers — report to business, review queue to ops

This is the reversal the whole workstream exists for: `sold-match-report` moves to business, while the spot-check review queue and its poller move to ops. `lib/spotcheck-slack-bot.js` keeps its reaction mechanics and delegates only the posting.

**Files:**
- Modify: `sold-match-report.js:499` (channel resolution)
- Modify: `cohort-spotcheck-gate.js:412-436` (`reviewChannel`)
- Modify: `spotcheck-reaction-poller.js:281-283` (`channel`)
- Modify: `lib/spotcheck-slack-bot.js:227-232` (`postInfoMessage` delegates to the helper)

**Interfaces:**
- Consumes: `postMessage(job, text)`, `resolveChannel(job)` (Tasks 1-2)
- Produces: unchanged public API on `lib/spotcheck-slack-bot.js` — `postReviewMessage`, `postDigestMessage`, `postInfoMessage`, `getReactions` keep their signatures, so the poller's `ts`-based review rows are unaffected

- [ ] **Step 1: Write the failing test**

Add to the smoke block:

```js
    await checkAsync('the review queue is ops and the sold-match report is business', async () => {
      assert.strictEqual(AUDIENCE['cohort-spotcheck-gate'], 'ops',
        'the pairs needing human eyes belong in the ops channel');
      assert.strictEqual(AUDIENCE['spotcheck-reaction-poller'], 'ops');
      assert.strictEqual(AUDIENCE['sold-match-report'], 'business');
    });

    // Also add 'sold-match-report.js' to the `migrated` array in the earlier
    // "no reporter carries its own sendSlack" check — it completes that list.
    await checkAsync('no consumer reads SLACK_REVIEW_CHANNEL outside the helper', async () => {
      const fs = require('fs');
      const path = require('path');
      const root = path.join(__dirname, '..');
      for (const f of ['sold-match-report.js', 'cohort-spotcheck-gate.js', 'spotcheck-reaction-poller.js']) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        assert.ok(!/process\.env\.SLACK_REVIEW_CHANNEL/.test(src),
          `${f} still resolves its own channel — routing must live in lib/slack-post.js`);
      }
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/slack-post.js --smoke`
Expected: FAIL — `sold-match-report.js still resolves its own channel`

- [ ] **Step 3: Write minimal implementation**

In `sold-match-report.js`, replace line 499's channel resolution with the helper. `SOLD_MATCH_SLACK_CHANNEL` is dropped: a per-job channel override is exactly the ad-hoc routing this work replaces.

```js
const { resolveChannel } = require('./lib/slack-post');
// …
    const channel = resolveChannel('sold-match-report');
```

In `cohort-spotcheck-gate.js`, replace the `reviewChannel` read:

```js
  const reviewChannel = resolveChannel('cohort-spotcheck-gate');
```

Keep the existing "not set → skip the post, still write verdicts" behaviour by wrapping it:

```js
  let reviewChannel = null;
  try {
    reviewChannel = resolveChannel('cohort-spotcheck-gate');
  } catch (err) {
    log('INFO', `review queue: ${err.message} — skipping Slack post (verdicts still written)`);
  }
```

In `spotcheck-reaction-poller.js`, apply the same pattern with `resolveChannel('spotcheck-reaction-poller')`, preserving its existing WARN-and-skip behaviour.

In `lib/spotcheck-slack-bot.js`, leave `postReviewMessage`, `postDigestMessage` and `getReactions` alone — they take an explicit `channel` argument and the callers now pass a resolved one. Change only the header comment to record that channel resolution now lives in `lib/slack-post.js`.

- [ ] **Step 4: Run test to verify it passes**

```bash
node lib/slack-post.js --smoke
node lib/spotcheck-slack-bot.js --smoke
```

Expected: both PASS. The second is the regression gate — the review queue's reaction mechanics must be untouched.

- [ ] **Step 5: Commit**

```bash
git add sold-match-report.js cohort-spotcheck-gate.js spotcheck-reaction-poller.js lib/spotcheck-slack-bot.js lib/slack-post.js
git commit -m "refactor(slack): review queue to ops, sold-match report to business

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `cron-wrapper` alerts through `postAlert`

The failure alert keeps the webhook, but stops hand-rolling the HTTP call so there is one place to change if the alert path ever moves.

**Files:**
- Modify: `cron-wrapper.js:32-55` (delete `sendSlackAlert`), `cron-wrapper.js:155-162` (call site)

**Interfaces:**
- Consumes: `postAlert(text)` (Task 2)

- [ ] **Step 1: Write the failing test**

Add to the smoke block:

```js
    await checkAsync('cron-wrapper alerts via postAlert, not its own https call', async () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.join(__dirname, '..', 'cron-wrapper.js'), 'utf8');
      assert.ok(!/function sendSlackAlert\s*\(/.test(src), 'cron-wrapper still hand-rolls its Slack call');
      assert.ok(/postAlert/.test(src), 'cron-wrapper does not use postAlert');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/slack-post.js --smoke`
Expected: FAIL — `cron-wrapper still hand-rolls its Slack call`

- [ ] **Step 3: Write minimal implementation**

Delete `sendSlackAlert` (lines 32-55) and add the require at the top:

```js
const { postAlert } = require('./lib/slack-post');
```

Replace the alert block:

```js
  // Slack alert on failure/warning. Webhook only, by design — see lib/slack-post.js postAlert.
  if (status === 'failure' || status === 'warning') {
    const emoji = status === 'failure' ? 'FAILURE' : 'WARNING';
    const res = await postAlert(`[${emoji}] ${scriptName}: ${errorMessage}`);
    log(res.ok ? 'INFO' : 'ERROR', res.ok ? 'Slack alert sent' : 'Slack alert failed');
  }
```

Drop the now-unused `https`, `http` and `url` requires if nothing else in the file uses them.

- [ ] **Step 4: Run test to verify it passes**

```bash
node lib/slack-post.js --smoke
node -e "require('./cron-wrapper')" && echo "cron-wrapper loads clean"
```

Expected: smoke PASSES; the require prints the confirmation with no error — this catches a require deleted while still in use.

- [ ] **Step 5: Commit**

```bash
git add cron-wrapper.js lib/slack-post.js
git commit -m "refactor(slack): cron-wrapper alerts through postAlert, webhook path unchanged

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: A strict argv gate on every reporter

`age-census-report.js` already proves the failure mode: before it had a gate, `node age-census-report.js --dry-run` fell through to the live path and posted. Every reporter that posts gets the same treatment.

**Files:**
- Modify: `weekly-view-report.js`, `market-totals-weekly-report.js`, `premarket-flow-weekly-report.js`, `sold-match-report.js`, `cron-health-slack.js` (entry points)
- Reference: `age-census-report.js:655-680` — the pattern to copy

**Interfaces:**
- Produces: every reporter accepts exactly `[--dry-run]` (plus `--smoke` where one already exists) and rejects everything else with exit code 1

- [ ] **Step 1: Write the failing test**

Add to the smoke block:

```js
    await checkAsync('every posting reporter has an argv gate that maps --dry-run', async () => {
      const fs = require('fs');
      const path = require('path');
      const root = path.join(__dirname, '..');
      const reporters = [
        'weekly-view-report.js', 'market-totals-weekly-report.js',
        'premarket-flow-weekly-report.js', 'sold-match-report.js',
        'cron-health-slack.js', 'age-census-report.js',
      ];
      for (const f of reporters) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        assert.ok(/ACCEPTED_ARGV/.test(src), `${f} has no argv gate — an unknown flag would fall through and POST`);
        assert.ok(/SLACK_DRY_RUN\s*=\s*['"]1['"]|DRY_RUN\s*=\s*['"]1['"]/.test(src),
          `${f} does not map --dry-run to the dry-run flag`);
      }
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/slack-post.js --smoke`
Expected: FAIL — `weekly-view-report.js has no argv gate`

- [ ] **Step 3: Write minimal implementation**

At the bottom of each reporter, replace its bare `run().catch(...)` entry point with the gate. For `weekly-view-report.js`:

```js
// Entry gate. Without this, an unrecognised flag falls straight through to the
// live path and POSTS: dotenv re-injects the token, so unsetting env vars does
// not prevent a post. Same pattern as age-census-report.js.
const ACCEPTED_ARGV = new Set(['--dry-run']);
const USAGE = 'Usage: node weekly-view-report.js [--dry-run]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  }
  if (argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';
  run().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
```

Repeat for the other four, changing the script name in `USAGE`, keeping each file's own entry function name, and adding `'--smoke'` to `ACCEPTED_ARGV` where the file already has a smoke block.

- [ ] **Step 4: Run test to verify it passes**

```bash
node lib/slack-post.js --smoke
node weekly-view-report.js --bogus; echo "exit=$?"
```

Expected: smoke PASSES; the second prints the usage line and `exit=1` — it must NOT run or post.

- [ ] **Step 5: Commit**

```bash
git add weekly-view-report.js market-totals-weekly-report.js premarket-flow-weekly-report.js sold-match-report.js cron-health-slack.js lib/slack-post.js
git commit -m "fix(slack): strict argv gate so an unknown flag cannot fall through and post

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and the operator's deploy steps

The code is useless until the operator makes the channel, the scopes and the webhook. Write down exactly what they must do, in the order that keeps the system posting throughout.

**Files:**
- Modify: `deploy-instructions.md`
- Modify: `docs/handover/04-REPORTING-AND-SLACK.md`
- Modify: `.planning/codebase/INTEGRATIONS.md`
- Move: `.planning/todos/pending/slack-output-routing-split.md` → `.planning/todos/done/`
- Move: `.planning/todos/pending/sfpl-retirement-and-health-window-fix.md` → `.planning/todos/done/` (verified complete on 2026-08-14: `3e56610` is in master, the droplet is at `d4add9e`, and the `sfpl-region-snapshot` crontab line is already gone)

- [ ] **Step 1: Write the deploy runbook section**

Add to `deploy-instructions.md` under a new heading `## Slack routing (audience split)`:

```markdown
Three one-time operator actions, all in Slack, before deploying this change:

1. Create the ops channel (recommended: `#hemnet-ops`) and `/invite` the Hemnet Status bot.
   Copy its `C0…` ID from the channel's About panel.
2. Create a NEW incoming webhook pointing at that ops channel. A webhook is bound to the
   channel it was created against and cannot be re-pointed in code, so `cron-wrapper`'s
   failure alert reaches ops only if `SLACK_WEBHOOK_URL` is this new URL.
3. Confirm the bot is a member of BOTH `#hemnet-status` and the ops channel.

Then on the droplet, in `.env`:

    SLACK_STATUS_CHANNEL=C0B9X2WDC4C     # #hemnet-status
    SLACK_OPS_CHANNEL=<the new C0… id>
    SLACK_WEBHOOK_URL=<the new ops webhook url>
    # SLACK_REVIEW_CHANNEL is retired — the helper reads it only as a fallback
    # for SLACK_OPS_CHANNEL, so it is safe to leave in place during the deploy
    # and delete afterwards.

Order does not matter: while `SLACK_OPS_CHANNEL` is unset the helper falls back to
`SLACK_REVIEW_CHANNEL`, so the review queue keeps working whether the code or the `.env`
edit lands first.

Verify before the next Monday cron, from the droplet, with no post:

    node cron-health-slack.js --dry-run
    node sold-match-report.js --dry-run

Each prints `--- DRY RUN: <job> -> C0… ---`. Check the channel id on each line is the one
you intended: that line is the whole point of the change.
```

- [ ] **Step 2: Update the handover and integrations docs**

In `docs/handover/04-REPORTING-AND-SLACK.md`, replace the credential-based description of routing with the audience table from spec §3.1, and record that `lib/slack-post.js` is now the only outbound path (except `postAlert`'s webhook). In `.planning/codebase/INTEGRATIONS.md`, update the Slack entry to list the two channel env vars and the retired `SLACK_REVIEW_CHANNEL` / `SOLD_MATCH_SLACK_CHANNEL`.

- [ ] **Step 3: Close the two pending todos**

```bash
git mv .planning/todos/pending/slack-output-routing-split.md .planning/todos/done/
git mv .planning/todos/pending/sfpl-retirement-and-health-window-fix.md .planning/todos/done/
```

Add a closing line at the bottom of each: what shipped, the date, and the commit range.

- [ ] **Step 4: Verify the docs match the code**

Run: `node lib/slack-post.js --smoke`
Expected: PASS. Then read `deploy-instructions.md` against `AUDIENCE` in `lib/slack-post.js` and confirm every job listed in the doc appears in the table and vice versa.

- [ ] **Step 5: Commit**

```bash
git add deploy-instructions.md docs/handover/04-REPORTING-AND-SLACK.md .planning/codebase/INTEGRATIONS.md .planning/todos
git commit -m "docs(slack): audience routing runbook and operator prerequisites

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deployment note (not a task)

Do not deploy until the operator has completed the three Slack actions in Task 8 Step 1 and the `.env` is updated. Deploying the code with `SLACK_STATUS_CHANNEL` unset makes every business reporter throw on its next fire — the fallback covers ops only, deliberately, because a business report landing in the ops channel is noise rather than safety.
