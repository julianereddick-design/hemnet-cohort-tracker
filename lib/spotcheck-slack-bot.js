// lib/spotcheck-slack-bot.js
//
// Bot-token Slack I/O for the spot-check review queue (D-07/D-08/D-09).
// Outbound chat.postMessage + inbound reactions.get. Uses the NEW
// SLACK_BOT_TOKEN — never the write-only incoming webhook env var (that stays
// for Phase 12 threshold/fetch-failure alerts; see deploy-instructions.md).
//
// Scopes required: chat:write, reactions:read.
// Missing SLACK_BOT_TOKEN → every exported function returns null silently.
//
// Usage:
//   const { postReviewMessage, postDigestMessage, getReactions } =
//     require('./lib/spotcheck-slack-bot');
//   node lib/spotcheck-slack-bot.js --smoke

'use strict';

const https = require('https');

// ---------------------------------------------------------------
// token() — guard helper (mirrors lib/spotcheck-vision.js getClient)
// Returns the bot token or null when the env var is absent.
// Every exported function returns null immediately when token() is null.
// ---------------------------------------------------------------
function token() {
  return process.env.SLACK_BOT_TOKEN || null;
}

// ---------------------------------------------------------------
// slackApiPost(method, bodyObj) — raw HTTPS POST to slack.com/api/<method>
// Adapted from cron-wrapper.js sendSlackAlert (lines 38-50).
// Returns the parsed JSON response or null on any error.
// ---------------------------------------------------------------
async function slackApiPost(method, bodyObj) {
  const tok = token();
  if (!tok) return null;

  const payload = JSON.stringify(bodyObj);

  return new Promise((resolve) => {
    const options = {
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.ok) {
            console.warn(`[spotcheck-slack-bot] ${method} returned ok=false: ${json.error || body}`);
            return resolve(null);
          }
          resolve(json);
        } catch (e) {
          console.warn(`[spotcheck-slack-bot] ${method} parse error: ${e.message}`);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.warn(`[spotcheck-slack-bot] ${method} request error: ${err.message}`);
      resolve(null);
    });

    // 10s timeout — T-13-10 DoS mitigation (matches cron-wrapper.js pattern)
    req.setTimeout(10000, () => {
      req.destroy();
      console.warn(`[spotcheck-slack-bot] ${method} request timeout`);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------
// slackApiGet(method, queryObj) — raw HTTPS GET to slack.com/api/<method>
// Returns the parsed JSON response or null on any error.
// ---------------------------------------------------------------
async function slackApiGet(method, queryObj) {
  const tok = token();
  if (!tok) return null;

  const qs = new URLSearchParams(queryObj).toString();

  return new Promise((resolve) => {
    const options = {
      hostname: 'slack.com',
      path: `/api/${method}?${qs}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tok}`,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.ok) {
            console.warn(`[spotcheck-slack-bot] ${method} returned ok=false: ${json.error || body}`);
            return resolve(null);
          }
          resolve(json);
        } catch (e) {
          console.warn(`[spotcheck-slack-bot] ${method} parse error: ${e.message}`);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.warn(`[spotcheck-slack-bot] ${method} request error: ${err.message}`);
      resolve(null);
    });

    // 10s timeout — T-13-10 DoS mitigation
    req.setTimeout(10000, () => {
      req.destroy();
      console.warn(`[spotcheck-slack-bot] ${method} request timeout`);
      resolve(null);
    });

    req.end();
  });
}

// ---------------------------------------------------------------
// EMOJI LEGEND — included in every review/digest message (D-08)
// so the operator knows the reaction protocol.
// ---------------------------------------------------------------
const EMOJI_LEGEND = 'React: ✅ confirm mismatch (remove) · ❌ override, valid match (keep) · ❓ unsure (leave)';

// ---------------------------------------------------------------
// buildHemnetUrl(hemnetId) — canonical listing URL
// ---------------------------------------------------------------
function buildHemnetUrl(hemnetId) {
  return `https://www.hemnet.se/bostad/${hemnetId}`;
}

// ---------------------------------------------------------------
// buildBooliUrl(booliId) — canonical current-ad URL
// Per COHORT-SPOTCHECK.md §4: /annons/<booli_id> always resolves
// to the live listing.
// ---------------------------------------------------------------
function buildBooliUrl(booliId) {
  return `https://www.booli.se/annons/${booliId}`;
}

// ---------------------------------------------------------------
// dhashSummary(pair) / visionSummary(pair) — pure renderers.
// The gate stores evidence at pair.dhash.minDist / pair.vision.sharedPhoto;
// the legacy flat fields (pair.dhash_min_dist / pair.vision_verdict) never
// existed in any verdict record — every Phase-13 message rendered "n/a".
// Read the nested fields first-class; keep the flat names as fallbacks so
// old fixtures stay green.
// ---------------------------------------------------------------
function dhashSummary(pair) {
  const d = pair.dhash || {};
  const minDist = pair.dhash_min_dist != null ? pair.dhash_min_dist
    : (d.minDist != null ? d.minDist : null);
  if (minDist == null) return 'dHash n/a (no galleries)';
  if (d.confirmed) return `dHash minDist ${minDist}, ${d.sharedCount} shared scene(s)`;
  return `dHash: no shared photo (minDist ${minDist})`;
}

function visionSummary(pair) {
  if (pair.vision_verdict) return `vision: ${pair.vision_verdict}`;
  const v = pair.vision;
  if (!v) return 'vision: not run';
  if (v.sharedPhoto === true) return 'vision: shared photo';
  if (v.sharedPhoto === false) return 'vision: no shared photo';
  return 'vision: inconclusive';
}

// ---------------------------------------------------------------
// postReviewMessage(channel, pair) → { ok, ts, channel } | null
//   pair: a verdict record { pair_id, street_address, hemnet_id, booli_id, ... }
//   Posts a high-stakes single-pair MISMATCH message with both ad URLs,
//   the dHash/vision summary, the verdict reason, and the emoji legend.
// ---------------------------------------------------------------
async function postReviewMessage(channel, pair) {
  if (!token()) return null;

  const hemnetUrl = buildHemnetUrl(pair.hemnet_id);
  const booliUrl  = buildBooliUrl(pair.booli_id);

  const text = [
    `[REVIEW] MISMATCH pair ${pair.pair_id} — ${pair.street_address || '(no address)'}`,
    `Hemnet: ${hemnetUrl}`,
    `Booli:  ${booliUrl}`,
    `${dhashSummary(pair)} | ${visionSummary(pair)}`,
    ...(pair.verdict_reason ? [`Why: ${pair.verdict_reason}`] : []),
    EMOJI_LEGEND,
  ].join('\n');

  const json = await slackApiPost('chat.postMessage', { channel, text });
  if (!json) return null;
  return { ok: json.ok, ts: json.ts, channel: json.channel };
}

// ---------------------------------------------------------------
// postDigestMessage(channel, pairs, opts) → { ok, ts, channel } | null
//   Renders one weekly digest listing every pair: pair_id, address,
//   BOTH ad URLs (hemnet.se + booli.se/annons), dHash + vision summary,
//   and the verdict reason ("why is this pair in front of me").
//   opts.unreviewablePairIds: pair_ids diverted from the queue because a
//   listing was removed since cohort build — rendered as ONE summary line
//   (nothing to react to; no spotcheck_review rows are written for them).
// ---------------------------------------------------------------
async function postDigestMessage(channel, pairs, opts = {}) {
  if (!token()) return null;

  const lines = [
    `[SPOT-CHECK DIGEST] ${pairs.length} pair(s) need review`,
    '',
  ];

  for (const pair of pairs) {
    const hemnetUrl = buildHemnetUrl(pair.hemnet_id);
    const booliUrl  = buildBooliUrl(pair.booli_id);

    lines.push(
      `• Pair ${pair.pair_id} — ${pair.street_address || '(no address)'}`,
      `  Hemnet: ${hemnetUrl}`,
      `  Booli:  ${booliUrl}`,
      `  ${dhashSummary(pair)} | ${visionSummary(pair)}`,
    );
    if (pair.verdict_reason) lines.push(`  Why: ${pair.verdict_reason}`);
  }

  const unreviewable = opts.unreviewablePairIds || [];
  if (unreviewable.length > 0) {
    lines.push('', `⚠ ${unreviewable.length} pair(s) unreviewable — listing removed since cohort build: ${unreviewable.join(', ')}`);
  }

  lines.push('', EMOJI_LEGEND);

  const text = lines.join('\n');
  const json = await slackApiPost('chat.postMessage', { channel, text });
  if (!json) return null;
  return { ok: json.ok, ts: json.ts, channel: json.channel };
}

// ---------------------------------------------------------------
// parseReactions(json) — pure helper: extract [{ name, users }] from
// a reactions.get response. Exposed for direct smoke testing (no network).
// ---------------------------------------------------------------
function parseReactions(json) {
  if (!json || !json.ok) return null;
  const reactions = (json.message && json.message.reactions) || [];
  return reactions.map(r => ({ name: r.name, users: r.users || [] }));
}

// ---------------------------------------------------------------
// getReactions(channel, ts) → [{ name, users }] | null
//   Calls reactions.get; returns the mapped array, [] if no reactions,
//   or null on any error.
// ---------------------------------------------------------------
async function getReactions(channel, ts) {
  if (!token()) return null;

  const json = await slackApiGet('reactions.get', { channel, timestamp: ts });
  if (!json) return null;
  return parseReactions(json) || [];
}

module.exports = { postReviewMessage, postDigestMessage, getReactions, dhashSummary, visionSummary };

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network, no real images required).
//   node lib/spotcheck-slack-bot.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  // Ensure no bot token is active for the offline smoke run
  const savedToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;

  const assert = require('assert');
  let pass = 0;
  let fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  (async () => {
    // 1. Module exports the three required functions
    check('module exports postReviewMessage', () => {
      assert.strictEqual(typeof postReviewMessage, 'function');
    });
    check('module exports postDigestMessage', () => {
      assert.strictEqual(typeof postDigestMessage, 'function');
    });
    check('module exports getReactions', () => {
      assert.strictEqual(typeof getReactions, 'function');
    });

    // 2. Missing SLACK_BOT_TOKEN → all three return null without throwing
    await checkAsync('no token → postReviewMessage returns null', async () => {
      const result = await postReviewMessage('C0test', {
        pair_id: 1, street_address: 'Testgatan 1', hemnet_id: 111, booli_id: 222,
      });
      assert.strictEqual(result, null, `expected null, got ${JSON.stringify(result)}`);
    });

    await checkAsync('no token → postDigestMessage returns null', async () => {
      const result = await postDigestMessage('C0test', [
        { pair_id: 1, street_address: 'Testgatan 1', hemnet_id: 111, booli_id: 222 },
      ]);
      assert.strictEqual(result, null, `expected null, got ${JSON.stringify(result)}`);
    });

    await checkAsync('no token → getReactions returns null', async () => {
      const result = await getReactions('C0test', '1234567890.000100');
      assert.strictEqual(result, null, `expected null, got ${JSON.stringify(result)}`);
    });

    // 3. Digest text contains hemnet.se and booli.se/annons (URL shape test)
    check('digest text contains hemnet.se URL', () => {
      // Simulate what postDigestMessage builds (without network)
      const pair = { pair_id: 99, street_address: 'Urlgatan 1', hemnet_id: 42, booli_id: 43 };
      const hemnetUrl = buildHemnetUrl(pair.hemnet_id);
      const booliUrl  = buildBooliUrl(pair.booli_id);
      assert.ok(hemnetUrl.includes('hemnet.se'), `expected hemnet.se in ${hemnetUrl}`);
      assert.ok(booliUrl.includes('booli.se/annons'), `expected booli.se/annons in ${booliUrl}`);
    });

    check('buildBooliUrl uses /annons/ not /bostad/', () => {
      const url = buildBooliUrl(9999);
      assert.ok(url.includes('/annons/9999'), `expected /annons/9999, got ${url}`);
      assert.ok(!url.includes('/bostad/'), `should not contain /bostad/, got ${url}`);
    });

    // 4. parseReactions parser against canned reactions.get JSON (no network)
    check('parseReactions: canned response → [{ name, users }]', () => {
      const canned = {
        ok: true,
        message: {
          reactions: [
            { name: 'x', users: ['U1'], count: 1 },
          ],
        },
      };
      const result = parseReactions(canned);
      assert.ok(Array.isArray(result), 'expected array');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'x');
      assert.deepStrictEqual(result[0].users, ['U1']);
    });

    check('parseReactions: no reactions → []', () => {
      const canned = { ok: true, message: {} };
      const result = parseReactions(canned);
      assert.ok(Array.isArray(result), 'expected array');
      assert.strictEqual(result.length, 0);
    });

    check('parseReactions: ok=false → null', () => {
      const result = parseReactions({ ok: false, error: 'channel_not_found' });
      assert.strictEqual(result, null);
    });

    // 5. dHash/vision summary renderers — read the gate's nested fields
    //    (pair.dhash.minDist / pair.vision.sharedPhoto), legacy flat fallbacks.
    check('dhashSummary: confirmed nested dhash → minDist + shared scenes', () => {
      const s = dhashSummary({ dhash: { minDist: 5, sharedCount: 3, confirmed: true } });
      assert.strictEqual(s, 'dHash minDist 5, 3 shared scene(s)');
    });
    check('dhashSummary: unconfirmed nested dhash → no shared photo', () => {
      const s = dhashSummary({ dhash: { minDist: 23, sharedCount: 0, confirmed: false } });
      assert.strictEqual(s, 'dHash: no shared photo (minDist 23)');
    });
    check('dhashSummary: no dhash at all → n/a', () => {
      assert.strictEqual(dhashSummary({}), 'dHash n/a (no galleries)');
    });
    check('dhashSummary: legacy flat dhash_min_dist still read', () => {
      assert.strictEqual(dhashSummary({ dhash_min_dist: 7 }), 'dHash: no shared photo (minDist 7)');
    });
    check('visionSummary: sharedPhoto true/false/null/absent', () => {
      assert.strictEqual(visionSummary({ vision: { sharedPhoto: true } }), 'vision: shared photo');
      assert.strictEqual(visionSummary({ vision: { sharedPhoto: false } }), 'vision: no shared photo');
      assert.strictEqual(visionSummary({ vision: { sharedPhoto: null } }), 'vision: inconclusive');
      assert.strictEqual(visionSummary({}), 'vision: not run');
    });
    check('visionSummary: legacy flat vision_verdict still read', () => {
      assert.strictEqual(visionSummary({ vision_verdict: 'MATCH' }), 'vision: MATCH');
    });

    check('parseReactions: white_check_mark emoji mapped correctly', () => {
      const canned = {
        ok: true,
        message: {
          reactions: [
            { name: 'white_check_mark', users: ['U2', 'U3'], count: 2 },
          ],
        },
      };
      const result = parseReactions(canned);
      assert.strictEqual(result[0].name, 'white_check_mark');
      assert.deepStrictEqual(result[0].users, ['U2', 'U3']);
    });

    // Restore saved token if any
    if (savedToken !== undefined) process.env.SLACK_BOT_TOKEN = savedToken;

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
