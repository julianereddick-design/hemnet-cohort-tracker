// spotcheck-reaction-poller.js
//
// Daily cron-wrapper.runJob poller that reads emoji reactions on open Slack review
// messages and applies the human verdict to the spot-check dataset:
//
//   ✅ (white_check_mark) → CONFIRMED_MISMATCH: audit + hard-remove pair from cohort_pairs (D-11)
//   ❌ (x)                → OVERRIDE_MATCH:     keep pair + record override
//   ❓ (question)         → UNCERTAIN:          leave pair, mark adjudicated
//
// Implements D-08 (emoji → verdict), D-10 (daily poller as its own runJob),
// D-11 (audit-first hard-remove on ✅), D-12 (dedup via review store).
//
// Security: T-13-12 authorization gate — only reactions from a reactor listed in
// SLACK_ALLOWED_REACTORS trigger the destructive path. A contested message (both
// ✅ and ❌ from allowed reactors) is never auto-deleted. When SLACK_ALLOWED_REACTORS
// is unset all reactors are allowed (documented fallback for first-run convenience;
// operator runbook instructs setting it before relying on auto-removal in production).
//
// T-13-15: removal only flows through removeConfirmedMismatchPair (audit-first,
// BEGIN/COMMIT, recoverable from spotcheck_removed_pairs). No raw DELETEs here.
// T-13-16: reactor + reason persisted on both spotcheck_review and spotcheck_removed_pairs.
// T-13-17: all SQL parameterised ($1,$2,...) — no string interpolation.
// T-13-18: getReactions null → skip cycle; absent pair → mark adjudicated (idempotent re-run).
//
// Usage:
//   node spotcheck-reaction-poller.js          (registered cron job)
//   node spotcheck-reaction-poller.js --smoke  (offline self-test, no DB/network)

'use strict';

// ---------------------------------------------------------------
// D-08 emoji → verdict resolver (PURE, authorization-gated)
// ---------------------------------------------------------------

const EMOJI = { confirm: 'white_check_mark', override: 'x', unsure: 'question' };

// reactorAllowed(user, allowedReactors) — T-13-12 authorization gate.
// When allowedReactors is empty or undefined, all reactors are allowed (fallback).
function reactorAllowed(user, allowedReactors) {
  if (!allowedReactors || allowedReactors.length === 0) return true;
  return allowedReactors.includes(user);
}

// firstAllowed(reaction, allowedReactors) — returns the first user in the reaction
// who passes the authorization gate, or null if none.
function firstAllowed(reaction, allowedReactors) {
  if (!reaction) return null;
  return (reaction.users || []).find(u => reactorAllowed(u, allowedReactors)) || null;
}

// resolveReaction(reactions, allowedReactors) — maps emoji reactions to a verdict action.
//
// Returns one of:
//   { action: 'remove', humanVerdict: 'CONFIRMED_MISMATCH', reactor: '<userId>' }
//   { action: 'keep',   humanVerdict: 'OVERRIDE_MATCH',     reactor: '<userId>' }
//   { action: 'leave',  humanVerdict: 'UNCERTAIN',           reactor: '<userId>' }
//   { action: 'none' }                          (no qualifying reaction)
//   { action: 'none', conflict: true }          (both ✅ and ❌ from allowed reactors)
//
// Conflict tie-break (T-13-12): a contested message is NEVER auto-removed.
function resolveReaction(reactions, allowedReactors) {
  const arr = reactions || [];
  const confirmUser  = firstAllowed(arr.find(r => r.name === EMOJI.confirm),  allowedReactors);
  const overrideUser = firstAllowed(arr.find(r => r.name === EMOJI.override), allowedReactors);
  if (confirmUser && overrideUser) return { action: 'none', conflict: true };
  if (confirmUser)  return { action: 'remove', humanVerdict: 'CONFIRMED_MISMATCH', reactor: confirmUser };
  if (overrideUser) return { action: 'keep',   humanVerdict: 'OVERRIDE_MATCH',     reactor: overrideUser };
  const unsureUser = firstAllowed(arr.find(r => r.name === EMOJI.unsure), allowedReactors);
  if (unsureUser)   return { action: 'leave',  humanVerdict: 'UNCERTAIN',           reactor: unsureUser };
  return { action: 'none' };
}

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network, no Slack).
// Covers every resolveReaction behavior + the two anchor regression fixtures
// (pair 15647 = UNCERTAIN, pair 16347 = CONFIRMED_MISMATCH).
//   node spotcheck-reaction-poller.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // 1. ✅ from allowed reactor → remove / CONFIRMED_MISMATCH
  check('white_check_mark from allowed reactor → remove/CONFIRMED_MISMATCH', () => {
    const r = resolveReaction([{ name: 'white_check_mark', users: ['U1'] }], ['U1']);
    assert.strictEqual(r.action, 'remove');
    assert.strictEqual(r.humanVerdict, 'CONFIRMED_MISMATCH');
    assert.strictEqual(r.reactor, 'U1');
  });

  // 2. ❌ from allowed reactor → keep / OVERRIDE_MATCH
  check('x from allowed reactor → keep/OVERRIDE_MATCH', () => {
    const r = resolveReaction([{ name: 'x', users: ['U1'] }], ['U1']);
    assert.strictEqual(r.action, 'keep');
    assert.strictEqual(r.humanVerdict, 'OVERRIDE_MATCH');
    assert.strictEqual(r.reactor, 'U1');
  });

  // 3. ❓ from allowed reactor → leave / UNCERTAIN
  check('question from allowed reactor → leave/UNCERTAIN', () => {
    const r = resolveReaction([{ name: 'question', users: ['U1'] }], ['U1']);
    assert.strictEqual(r.action, 'leave');
    assert.strictEqual(r.humanVerdict, 'UNCERTAIN');
    assert.strictEqual(r.reactor, 'U1');
  });

  // 4. No reactions → { action: 'none' }
  check('no reactions → action none', () => {
    const r = resolveReaction([], ['U1']);
    assert.strictEqual(r.action, 'none');
    assert.ok(!r.conflict, 'no conflict flag expected');
  });

  // 5. ✅ from UNAUTHORIZED reactor → { action: 'none' } (T-13-12 security gate)
  check('white_check_mark from UNAUTHORIZED reactor → action none (T-13-12)', () => {
    const r = resolveReaction([{ name: 'white_check_mark', users: ['EVIL'] }], ['U1']);
    assert.strictEqual(r.action, 'none', `Expected 'none', got '${r.action}' — unauthorized reactor must not trigger removal`);
    assert.ok(!r.conflict);
  });

  // 6. Contested: both ✅ and ❌ from allowed reactors → { action: 'none', conflict: true }
  check('contested white_check_mark + x from allowed reactors → none + conflict:true', () => {
    const r = resolveReaction([
      { name: 'white_check_mark', users: ['U1'] },
      { name: 'x', users: ['U1'] },
    ], ['U1']);
    assert.strictEqual(r.action, 'none');
    assert.strictEqual(r.conflict, true, 'Expected conflict:true for contested message');
  });

  // 7. Empty allowedReactors → all reactors allowed (documented fallback)
  check('empty allowedReactors → all reactors allowed (fallback)', () => {
    const r = resolveReaction([{ name: 'white_check_mark', users: ['ANYONE'] }], []);
    assert.strictEqual(r.action, 'remove');
    assert.strictEqual(r.reactor, 'ANYONE');
  });

  // 8. undefined allowedReactors → all reactors allowed
  check('undefined allowedReactors → all reactors allowed', () => {
    const r = resolveReaction([{ name: 'x', users: ['ANYUSER'] }], undefined);
    assert.strictEqual(r.action, 'keep');
    assert.strictEqual(r.reactor, 'ANYUSER');
  });

  // 9. Regression fixture: pair 16347 (Bollmoravägen — price diverges 16%) style.
  //    A ✅ from an allowed reactor on a "16347-style" CONFIRMED_MISMATCH message → remove.
  check('16347-style: allowed ✅ on CONFIRMED_MISMATCH review message → remove/CONFIRMED_MISMATCH', () => {
    // Pair 16347: price diverges 16%, vision found no shared photo → CONFIRMED_MISMATCH.
    // Human reviews the Slack message and reacts ✅ to confirm.
    const r = resolveReaction(
      [{ name: 'white_check_mark', users: ['U_OPERATOR'] }],
      ['U_OPERATOR']
    );
    assert.strictEqual(r.action, 'remove', `16347-style: expected remove, got ${r.action}`);
    assert.strictEqual(r.humanVerdict, 'CONFIRMED_MISMATCH');
    assert.strictEqual(r.reactor, 'U_OPERATOR');
  });

  // 10. Regression fixture: pair 15647 (Storvretsvägen — identical price, prior-sale photos) style.
  //     A ❓ on a "15647-style" UNCERTAIN message → leave/UNCERTAIN (not auto-removed).
  check('15647-style: ❓ on UNCERTAIN review message → leave/UNCERTAIN (never CONFIRMED_MISMATCH)', () => {
    // Pair 15647: price agrees, prior-sale photos → UNCERTAIN. Human is unsure → reacts ❓.
    const r = resolveReaction(
      [{ name: 'question', users: ['U_OPERATOR'] }],
      ['U_OPERATOR']
    );
    assert.strictEqual(r.action, 'leave', `15647-style: expected leave, got ${r.action}`);
    assert.strictEqual(r.humanVerdict, 'UNCERTAIN');
    assert.notStrictEqual(r.humanVerdict, 'CONFIRMED_MISMATCH', '15647-style must never be CONFIRMED_MISMATCH');
  });

  // 11. ✅ from UNAUTHORIZED reactor on 16347-style message → none (security gate still holds)
  check('16347-style: ✅ from UNAUTHORIZED reactor → none (T-13-12 blocks spoofed removal)', () => {
    const r = resolveReaction(
      [{ name: 'white_check_mark', users: ['EVIL_SPOOFER'] }],
      ['U_OPERATOR']
    );
    assert.strictEqual(r.action, 'none', `Expected none for unauthorized reactor on 16347-style message`);
  });

  // 12. Contested 16347-style (✅ + ❌ both from allowed) → none + conflict (never auto-delete)
  check('16347-style: contested ✅+❌ from allowed reactors → none+conflict (no auto-delete)', () => {
    const r = resolveReaction([
      { name: 'white_check_mark', users: ['U_OPERATOR'] },
      { name: 'x', users: ['U_OPERATOR2'] },
    ], ['U_OPERATOR', 'U_OPERATOR2']);
    assert.strictEqual(r.action, 'none');
    assert.strictEqual(r.conflict, true);
  });

  // 13. null reactions array → { action: 'none' } (graceful null handling)
  check('null reactions → action none (graceful)', () => {
    const r = resolveReaction(null, ['U1']);
    assert.strictEqual(r.action, 'none');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------
// Poller main(client, log) — cron-wrapper.runJob entry point (D-10)
// ---------------------------------------------------------------

const { runJob }              = require('./cron-wrapper');
const { getReactions }        = require('./lib/spotcheck-slack-bot');
const { getOpenReviewMessages, markAdjudicated, removeConfirmedMismatchPair, isAlreadyAdjudicated }
                              = require('./lib/spotcheck-review-store');

async function main(client, log) {
  const channel = process.env.SLACK_REVIEW_CHANNEL;
  if (!process.env.SLACK_BOT_TOKEN || !channel) {
    log('WARN', 'SLACK_BOT_TOKEN or SLACK_REVIEW_CHANNEL not set — poller skipping');
    return { skipped: true, reason: 'no bot token/channel', applied: 0 };
  }

  const allowedReactors = (process.env.SLACK_ALLOWED_REACTORS || '')
    .split(',').map(s => s.trim()).filter(Boolean); // empty = allow all (documented fallback)

  const open = await getOpenReviewMessages(client);
  log('INFO', `reaction-poller: ${open.length} open review message(s)`);
  let applied = 0, removed = 0, kept = 0, left = 0, conflicts = 0;

  for (const msg of open) {
    // D-12 dedup: skip if already adjudicated (human_verdict IS NOT NULL)
    if (await isAlreadyAdjudicated(client, { pairId: msg.pair_id, cohortId: msg.cohort_id })) continue;

    const reactions = await getReactions(msg.channel, msg.ts);
    if (reactions == null) {
      // T-13-18: null on error → skip this cycle, retry tomorrow
      log('WARN', `getReactions null for pair ${msg.pair_id} — skip this cycle`);
      continue;
    }

    const r = resolveReaction(reactions, allowedReactors);

    if (r.conflict) {
      conflicts++;
      log('WARN', `pair ${msg.pair_id}: contested (✅ and ❌) — leaving open`);
      continue;
    }

    if (r.action === 'none') continue;

    if (r.action === 'remove') {
      // T-13-15: resolve audit fields BEFORE deletion; never issue raw DELETE
      const row = await client.query('SELECT booli_id, hemnet_id FROM cohort_pairs WHERE id = $1', [msg.pair_id]);
      if (row.rows.length === 0) {
        // T-13-18 idempotency: pair already absent — mark adjudicated rather than erroring
        await markAdjudicated(client, {
          pairId: msg.pair_id, cohortId: msg.cohort_id,
          humanVerdict: 'CONFIRMED_MISMATCH', reactor: r.reactor,
          reason: 'pair already absent',
        });
        log('INFO', `pair ${msg.pair_id}: already absent — marked adjudicated`);
        applied++;
        continue;
      }
      const { booli_id, hemnet_id } = row.rows[0];
      // D-11: audit-first transactional hard-remove
      await removeConfirmedMismatchPair(client, {
        pairId: msg.pair_id, cohortId: msg.cohort_id,
        booliId: booli_id, hemnetId: hemnet_id,
        visionVerdict: msg.vision_verdict, humanVerdict: 'CONFIRMED_MISMATCH',
        reactor: r.reactor,
        reason: 'human ✅ confirmed mismatch via Slack reaction',
      });
      // T-13-16: mark adjudicated (reactor + reason both persisted)
      await markAdjudicated(client, {
        pairId: msg.pair_id, cohortId: msg.cohort_id,
        humanVerdict: 'CONFIRMED_MISMATCH', reactor: r.reactor,
        reason: 'removed',
      });
      removed++;
      applied++;
      log('INFO', `pair ${msg.pair_id}: ✅ confirmed mismatch — audited + removed (reactor ${r.reactor})`);

    } else if (r.action === 'keep') {
      await markAdjudicated(client, {
        pairId: msg.pair_id, cohortId: msg.cohort_id,
        humanVerdict: 'OVERRIDE_MATCH', reactor: r.reactor,
        reason: 'human ❌ override — valid match',
      });
      kept++;
      applied++;
      log('INFO', `pair ${msg.pair_id}: ❌ override — kept (reactor ${r.reactor})`);

    } else if (r.action === 'leave') {
      await markAdjudicated(client, {
        pairId: msg.pair_id, cohortId: msg.cohort_id,
        humanVerdict: 'UNCERTAIN', reactor: r.reactor,
        reason: 'human ❓ unsure',
      });
      left++;
      applied++;
      log('INFO', `pair ${msg.pair_id}: ❓ unsure — left UNCERTAIN (reactor ${r.reactor})`);
    }
  }

  return { skipped: false, checked: open.length, applied, removed, kept, left, conflicts };
}

// Guard the runJob registration so --smoke does NOT trigger a real DB connection.
// Task 1's smoke exercises only the pure resolver and must not connect.
if (!process.argv.includes('--smoke')) {
  runJob({
    scriptName: 'spotcheck-reaction-poller',
    main,
    validate: (summary) => {
      if (!summary || summary.skipped) return null;
      // Poller outcomes logged to cron_job_log; no Slack escalation needed for normal runs
      return null;
    },
  });
}
