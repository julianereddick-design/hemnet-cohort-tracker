'use strict';

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

module.exports = { AUDIENCE, resolveChannel, isDryRun, postMessage, postAlert };

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

  async function checkAsync(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); pass++; }
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

    process.env.SLACK_STATUS_CHANNEL = saved.status || '';
    process.env.SLACK_OPS_CHANNEL = saved.ops || '';
    process.env.SLACK_REVIEW_CHANNEL = saved.review || '';
    if (saved.dry) process.env.SLACK_DRY_RUN = saved.dry;

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
