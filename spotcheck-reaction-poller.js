// spotcheck-reaction-poller.js
//
// Daily cron-wrapper.runJob poller that reads emoji reactions on open Slack review
// messages and applies the human verdict to the spot-check dataset:
//
//   ✅ (white_check_mark) → CONFIRMED_MISMATCH: audit + SOFT-remove pair (cohort_pairs.removed_at; D-11 reversed in 13.1)
//   ❌ (x)                → OVERRIDE_MATCH:     keep pair + record override
//   ❓ (question)         → UNCERTAIN:          leave pair, mark adjudicated
//
// Phase 13.1/13.2 additions: legacy shared-ts (digest-era) review rows are never
// acted on (partitionSharedTs guard); open rows unanswered >STALE_REVIEW_DAYS
// (default 7) escalate to Slack via validate().
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

// partitionSharedTs(rows) — Phase 13.1 guard: any spotcheck_review rows that
// SHARE one (channel, ts) come from the retired multi-pair digest, where a
// single reaction would be applied to every pair on that message. Those rows
// are never acted on automatically — they stay open for manual SQL disposition.
function partitionSharedTs(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    const k = `${r.channel}|${r.ts}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const safe = [], shared = [];
  for (const r of rows || []) {
    (counts.get(`${r.channel}|${r.ts}`) > 1 ? shared : safe).push(r);
  }
  return { safe, shared };
}

// staleOpenRows(rows, nowMs, days) — Phase 13.2 aging: open review rows older
// than `days` with still no human verdict. Delisted pairs never get review rows
// (diverted by the gate since Phase 14.1), so everything here is human-answerable.
function staleOpenRows(rows, nowMs, days) {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return (rows || []).filter(r => r.created_at && new Date(r.created_at).getTime() < cutoff);
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

  // 14. partitionSharedTs: digest-era rows (same channel+ts) split out, per-pair rows kept
  check('partitionSharedTs: shared-ts rows ignored, unique-ts rows safe', () => {
    const rows = [
      { pair_id: 1, channel: 'C1', ts: '111.1' },   // digest era —
      { pair_id: 2, channel: 'C1', ts: '111.1' },   //   same ts → both shared
      { pair_id: 3, channel: 'C1', ts: '222.2' },   // per-pair → safe
      { pair_id: 4, channel: 'C2', ts: '111.1' },   // same ts, DIFFERENT channel → safe
    ];
    const { safe, shared } = partitionSharedTs(rows);
    assert.deepStrictEqual(shared.map(r => r.pair_id), [1, 2]);
    assert.deepStrictEqual(safe.map(r => r.pair_id), [3, 4]);
  });

  check('partitionSharedTs: empty/null input → empty partitions', () => {
    assert.deepStrictEqual(partitionSharedTs([]), { safe: [], shared: [] });
    assert.deepStrictEqual(partitionSharedTs(null), { safe: [], shared: [] });
  });

  // 15. staleOpenRows: only rows older than the cutoff are stale
  check('staleOpenRows: >7d old rows flagged, fresh rows not', () => {
    const now = Date.parse('2026-06-12T12:00:00Z');
    const rows = [
      { pair_id: 1, created_at: '2026-06-01T00:00:00Z' },  // 11.5d old → stale
      { pair_id: 2, created_at: '2026-06-10T00:00:00Z' },  // 2.5d old → fresh
      { pair_id: 3, created_at: null },                     // no created_at → never stale
    ];
    const stale = staleOpenRows(rows, now, 7);
    assert.deepStrictEqual(stale.map(r => r.pair_id), [1]);
  });

  check('staleOpenRows: exactly-at-cutoff row is not stale (strict <)', () => {
    const now = Date.parse('2026-06-12T12:00:00Z');
    const rows = [{ pair_id: 1, created_at: '2026-06-05T12:00:00Z' }]; // exactly 7d
    assert.deepStrictEqual(staleOpenRows(rows, now, 7), []);
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

  const allOpen = await getOpenReviewMessages(client);

  // Phase 13.1 guard: rows sharing one (channel, ts) are legacy multi-pair digest
  // rows — a reaction there is ambiguous (it would hit every pair). Never act on
  // them; surface the count so the operator can dispose of them via SQL.
  const { safe: open, shared } = partitionSharedTs(allOpen);
  if (shared.length > 0) {
    log('WARN', `reaction-poller: ${shared.length} legacy shared-ts review row(s) ignored (multi-pair digest era) — pairs ${shared.map(m => m.pair_id).join(', ')}`);
  }

  log('INFO', `reaction-poller: ${open.length} open review message(s)`);
  let applied = 0, removed = 0, kept = 0, left = 0, conflicts = 0;
  const adjudicatedNow = new Set(); // pair_ids resolved this cycle — excluded from the stale count

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

    if (r.action !== 'none') adjudicatedNow.add(msg.pair_id);

    if (r.conflict) {
      conflicts++;
      log('WARN', `pair ${msg.pair_id}: contested (✅ and ❌) — leaving open`);
      continue;
    }

    if (r.action === 'none') continue;

    if (r.action === 'remove') {
      // T-13-15: resolve audit fields BEFORE removal; never issue raw DELETE
      const row = await client.query('SELECT booli_id, hemnet_id, removed_at FROM cohort_pairs WHERE id = $1', [msg.pair_id]);
      if (row.rows.length === 0 || row.rows[0].removed_at != null) {
        // T-13-18 idempotency: pair already gone (hard-deleted pre-13.1 or already
        // soft-removed) — mark adjudicated rather than erroring
        await markAdjudicated(client, {
          pairId: msg.pair_id, cohortId: msg.cohort_id,
          humanVerdict: 'CONFIRMED_MISMATCH', reactor: r.reactor,
          reason: row.rows.length === 0 ? 'pair already absent' : 'pair already soft-removed',
        });
        log('INFO', `pair ${msg.pair_id}: already removed/absent — marked adjudicated`);
        applied++;
        continue;
      }
      const { booli_id, hemnet_id } = row.rows[0];
      // D-11 (reversed in 13.1): audit-first transactional SOFT-remove —
      // UPDATE cohort_pairs.removed_at, view history preserved, recoverable.
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
      log('INFO', `pair ${msg.pair_id}: ✅ confirmed mismatch — audited + soft-removed (reactor ${r.reactor})`);

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

  // Phase 13.2: stale-review aging — open rows still unanswered after N days
  // (default 7, STALE_REVIEW_DAYS overrides). Escalated via validate() → Slack.
  const staleDays = parseInt(process.env.STALE_REVIEW_DAYS, 10) || 7;
  const stale = staleOpenRows(open.filter(m => !adjudicatedNow.has(m.pair_id)), Date.now(), staleDays);
  if (stale.length > 0) {
    log('WARN', `reaction-poller: ${stale.length} review item(s) unanswered for >${staleDays} days — pairs ${stale.map(m => m.pair_id).join(', ')}`);
  }

  return {
    skipped: false, checked: open.length, applied, removed, kept, left, conflicts,
    sharedTsIgnored: shared.length,
    staleDays, staleCount: stale.length, stalePairIds: stale.map(m => m.pair_id),
  };
}

// Guard the runJob registration so --smoke does NOT trigger a real DB connection.
// Task 1's smoke exercises only the pure resolver and must not connect.
if (!process.argv.includes('--smoke')) {
  runJob({
    scriptName: 'spotcheck-reaction-poller',
    main,
    validate: (summary) => {
      if (!summary || summary.skipped) return null;
      // Phase 13.2: stale-review aging alert — unanswered review items rot into
      // silent misses; escalate through cron-wrapper's existing Slack path.
      if (summary.staleCount > 0) {
        return `${summary.staleCount} spot-check review item(s) unanswered for >${summary.staleDays} days: pairs ${summary.stalePairIds.join(', ')} — react ✅/❌/❓ in the review channel`;
      }
      return null;
    },
  });
}
