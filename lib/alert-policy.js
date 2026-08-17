'use strict';

// lib/alert-policy.js
//
// WHEN does a failing job actually interrupt a human? Phase 4 of
// docs/superpowers/specs/2026-08-17-alerting-structure-design.md §4.2.
//
// Phases 0-3 made the channel HONEST. This file is what makes it QUIET. The
// baseline to beat (§8): 59 alerts in 60 days, of which 3 mattered and were
// missed. 56 of those 59 came from one tier-2 job — spotcheck-reaction-poller
// warned on 93% of its runs about a standing condition, i.e. a gauge reported
// as an event.
//
// Everything here is PURE: no DB, no Slack, no clock. `now` is always injected.
// That is what lets the ladder and the debounce be tested over simulated days
// instead of waited out in production, which is how the previous generation of
// these rules shipped unverified.
//
// FOUR RULES, each of which is wrong on its own:
//
//   1. Tier gating       — tier 2 posts nothing. Alone: a tier-1 job repeating a
//                          real failure would be suppressed too.
//   2. conditionKey      — suppress a repeat of the SAME declared condition.
//                          Alone: it is just the old noise on a timer.
//   3. Re-notify ladder  — 0h, +24h, +72h, then daily while unresolved. Alone:
//                          it re-alerts forever about a resolved flap.
//   4. Flap debounce     — a condition clears only after N=2 clean runs. Alone:
//                          a stuck condition never clears at all.
//
// WHY SUPPRESSION KEYS ON A DECLARED KEY AND NEVER ON MESSAGE TEXT: the four
// highest-volume validators in this repo all embed volatile content — pair-id
// lists, live counts, the week's cohort id. A text signature would suppress
// almost nothing, and would break silently the first time someone edited a log
// line. So the JOB declares the condition; the policy never parses prose.
//
//   node lib/alert-policy.js --smoke

// Offsets from the FIRST alert, in hours, then every 24h beyond the last rung.
// Anchored on the first alert rather than the previous one so that a missed
// sweep cycle cannot slide the whole schedule to the right.
const LADDER_HOURS = [0, 24, 72];

// A condition is only "cleared" after this many consecutive runs without it.
// cohort-track straddles a hard >50% boundary as a cohort decays, every 2 days;
// without this it alerts in BOTH directions and doubles today's volume.
const CLEAR_RUNS = 2;

// Spec §4.2: "tier 2 -> log row only, no Slack. Standing state appears in the
// digest." Tier-2 standing state IS already visible — Phase 3.1's liveness
// section renders `age-census-report (tier 2) last run failure: ...` daily.
//
// NOTE: §7's acceptance line for this phase says a tier-2 warning repeated 5
// runs should produce "exactly 1 alert", which contradicts §4.2. Built to §4.2
// (the normative mechanism section) and behind this one constant, so switching
// to first-occurrence-only is a one-line change rather than a rewrite.
const TIER2_ALERTS_ENABLED = false;

// normalizeValidation(v) -> { key, severity, message } | null
//
// Every validator in the repo today returns a STRING or falsy, and all twelve
// live jobs must keep working unchanged. A string normalises to key:null, which
// by design can never be suppressed — an un-keyed condition is an UNKNOWN
// condition, and swallowing an unknown is the failure mode this whole design
// exists to escape. It also puts pressure on adding keys rather than letting
// them rot.
function normalizeValidation(v) {
  if (!v) return null;
  if (typeof v === 'string') return { key: null, severity: 'warning', message: v };
  if (!v.message) return null;
  return {
    key: v.key || null,
    severity: v.severity || 'warning',
    message: v.message,
  };
}

// ladderDue(state, now) -> boolean
// state: { alert_count, first_alerted_at }
function ladderDue(state, now) {
  if (!state || !state.alert_count || !state.first_alerted_at) return true;   // never alerted
  const elapsedH = (now - new Date(state.first_alerted_at)) / 3600000;
  const n = state.alert_count;
  // Rungs already climbed = n. The next rung is LADDER_HOURS[n] if one remains,
  // otherwise daily beyond the final rung.
  const nextH = n < LADDER_HOURS.length
    ? LADDER_HOURS[n]
    : LADDER_HOURS[LADDER_HOURS.length - 1] + 24 * (n - LADDER_HOURS.length + 1);
  return elapsedH >= nextH;
}

// decideAlert({ tier, condition, state, now }) -> { alert, reason }
//
// `state` is the stored alert_state row for this (scope, script, key), or null
// if this condition is not currently open.
function decideAlert({ tier, condition, state, now }) {
  if (!condition) return { alert: false, reason: 'no condition' };

  // tier === null means the job is not in lib/job-registry.js. That is a fault,
  // and it is treated as perishable: defaulting to quiet would silence a newly
  // added tier-1 job, which is precisely what the registry exists to prevent.
  if (tier === 2 && !TIER2_ALERTS_ENABLED) {
    return { alert: false, reason: 'tier 2 — digest only, never an interrupt' };
  }

  // An un-keyed condition has no identity, so it cannot be matched against the
  // stored one. Alert every time rather than guess.
  if (!condition.key) return { alert: true, reason: 'no condition key — cannot suppress' };

  // A DIFFERENT failure on the same job is a new fact, whatever the ladder says.
  if (!state || state.condition_key !== condition.key) {
    return { alert: true, reason: 'new condition' };
  }

  return ladderDue(state, now)
    ? { alert: true, reason: `ladder rung ${state.alert_count}` }
    : { alert: false, reason: `suppressed — same condition "${condition.key}", ladder not due` };
}

// applyOutcome(state, { condition, alerted, now }) -> next state
//
// Pure state transition. The caller persists whatever comes back. `resolved:true`
// means the row may be deleted: the condition has been absent for CLEAR_RUNS
// consecutive runs.
function applyOutcome(state, { condition, alerted, now }) {
  // Absent this run -> advance the clear streak, but do NOT drop the incident
  // until the streak reaches CLEAR_RUNS. One clean run is a flap, not a fix.
  if (!condition) {
    if (!state) return { resolved: true, consecutive_clear: CLEAR_RUNS };
    const consecutive_clear = (state.consecutive_clear || 0) + 1;
    return Object.assign({}, state, {
      consecutive_clear,
      last_seen_at: state.last_seen_at || null,
      resolved: consecutive_clear >= CLEAR_RUNS,
    });
  }

  // Present this run. A condition returning at consecutive_clear = 1 is the SAME
  // incident: the clear streak resets and first_alerted_at survives, so the
  // ladder is not restarted by an oscillation.
  const sameIncident = state && state.condition_key === condition.key;
  const base = sameIncident ? state : {
    condition_key: condition.key,
    first_seen_at: now,
    first_alerted_at: null,
    alert_count: 0,
  };

  return Object.assign({}, base, {
    condition_key: condition.key,
    last_seen_at: now,
    consecutive_clear: 0,
    resolved: false,
    first_alerted_at: alerted ? (base.first_alerted_at || now) : base.first_alerted_at,
    last_alerted_at: alerted ? now : (base.last_alerted_at || null),
    alert_count: (base.alert_count || 0) + (alerted ? 1 : 0),
  });
}

module.exports = {
  normalizeValidation, ladderDue, decideAlert, applyOutcome,
  LADDER_HOURS, CLEAR_RUNS, TIER2_ALERTS_ENABLED,
};

// ---------------------------------------------------------------
//   node lib/alert-policy.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { normalizeValidation, ladderDue, decideAlert, applyOutcome, LADDER_HOURS, CLEAR_RUNS } = module.exports;
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  const T = (s) => new Date(s);
  const t0 = T('2026-08-17T00:00:00Z');
  const hours = (h) => new Date(t0.getTime() + h * 3600 * 1000);

  // ---- normalizeValidation: the backward-compatible conditionKey contract ----

  // Every validator in the repo today returns a STRING or falsy. They must keep
  // working unchanged, or Phase 4 is a breaking change to twelve live jobs.
  check('a legacy string validator still produces a warning', () => {
    const v = normalizeValidation('4 stale reviews');
    assert.strictEqual(v.severity, 'warning');
    assert.strictEqual(v.message, '4 stale reviews');
  });

  // Suppression MUST key on something the job declares. Spec §4.2: the four
  // highest-volume validators all embed pair-id lists, live counts and the week's
  // cohort id, so a text signature would suppress almost nothing AND would break
  // silently the first time someone edits a log line.
  check('a legacy string validator gets NO condition key, so it can never be suppressed', () => {
    assert.strictEqual(normalizeValidation('4 stale reviews').key, null);
  });

  check('falsy means no condition at all', () => {
    for (const v of [null, undefined, false, '']) assert.strictEqual(normalizeValidation(v), null);
  });

  check('a structured validator carries its key through', () => {
    const v = normalizeValidation({ key: 'partial-upsert', severity: 'failure', message: 'got 3 of 4' });
    assert.deepStrictEqual([v.key, v.severity, v.message], ['partial-upsert', 'failure', 'got 3 of 4']);
  });

  check('severity defaults to warning when a structured validator omits it', () => {
    assert.strictEqual(normalizeValidation({ key: 'k', message: 'm' }).severity, 'warning');
  });

  // ---- ladderDue: now, +24h, +72h, then daily ----

  check('the first sighting of a condition always alerts', () => {
    assert.strictEqual(ladderDue({ alert_count: 0, first_alerted_at: null }, t0), true);
  });

  check('a second run one hour later does NOT re-alert', () => {
    assert.strictEqual(ladderDue({ alert_count: 1, first_alerted_at: t0 }, hours(1)), false);
  });

  check('the ladder re-alerts at +24h', () => {
    assert.strictEqual(ladderDue({ alert_count: 1, first_alerted_at: t0 }, hours(23.9)), false);
    assert.strictEqual(ladderDue({ alert_count: 1, first_alerted_at: t0 }, hours(24)), true);
  });

  check('the ladder re-alerts at +72h, not at +48h', () => {
    assert.strictEqual(ladderDue({ alert_count: 2, first_alerted_at: t0 }, hours(48)), false);
    assert.strictEqual(ladderDue({ alert_count: 2, first_alerted_at: t0 }, hours(72)), true);
  });

  check('after the ladder is exhausted it re-alerts daily', () => {
    assert.strictEqual(ladderDue({ alert_count: 3, first_alerted_at: t0 }, hours(95)), false);
    assert.strictEqual(ladderDue({ alert_count: 3, first_alerted_at: t0 }, hours(96)), true);
    assert.strictEqual(ladderDue({ alert_count: 4, first_alerted_at: t0 }, hours(120)), true);
  });

  // Offsets are measured from the FIRST alert, so a missed sweep cycle cannot
  // slide the whole schedule to the right and stretch a 24h gap into 48h.
  check('the ladder is anchored on the first alert, not on the previous one', () => {
    const late = { alert_count: 1, first_alerted_at: t0, last_alerted_at: hours(20) };
    assert.strictEqual(ladderDue(late, hours(24)), true,
      'a late first alert must not push the +24h rung out to +44h');
  });

  // ---- decideAlert: the tier gate ----

  const cond = { key: 'partial-upsert', severity: 'failure', message: 'got 3 of 4' };

  // This single rule removes ~56 of the 59 baseline alerts in 60 days:
  // spotcheck-reaction-poller is tier 2 and warned on 93% of its runs.
  check('tier 2 never posts to Slack', () => {
    const d = decideAlert({ tier: 2, condition: cond, state: null, now: t0 });
    assert.strictEqual(d.alert, false);
    assert.match(d.reason, /tier 2/i);
  });

  check('tier 1 alerts on a brand new condition', () => {
    const d = decideAlert({ tier: 1, condition: cond, state: null, now: t0 });
    assert.strictEqual(d.alert, true);
  });

  // Spec §4.2 required default: a job absent from the registry is a FAULT.
  // Silence would hide a newly added perishable job.
  check('an unknown tier is treated as perishable and alerts', () => {
    const d = decideAlert({ tier: null, condition: cond, state: null, now: t0 });
    assert.strictEqual(d.alert, true);
  });

  check('no condition means no alert, whatever the tier', () => {
    assert.strictEqual(decideAlert({ tier: 1, condition: null, state: null, now: t0 }).alert, false);
  });

  // The suppression rule proper: same key, too soon on the ladder.
  check('tier 1 suppresses a repeat of the SAME condition inside the ladder', () => {
    const state = { condition_key: 'partial-upsert', alert_count: 1, first_alerted_at: t0 };
    assert.strictEqual(decideAlert({ tier: 1, condition: cond, state, now: hours(2) }).alert, false);
  });

  // ...but a DIFFERENT failure on the same job is a new fact and must get through.
  check('a different condition key on the same job is not suppressed', () => {
    const state = { condition_key: 'frozen-scrape', alert_count: 1, first_alerted_at: t0 };
    assert.strictEqual(decideAlert({ tier: 1, condition: cond, state, now: hours(2) }).alert, true);
  });

  // The market-totals-daily case from §4.2: a perfectly stable error signature on a
  // tier-1 DAILY job. Naive suppression alerts once and then silently eats every
  // subsequent permanently-lost snapshot.
  check('a standing tier-1 failure is never permanently silenced', () => {
    let state = { condition_key: 'partial-upsert', alert_count: 1, first_alerted_at: t0 };
    const fired = [];
    for (let day = 1; day <= 10; day++) {
      const now = hours(24 * day);
      const d = decideAlert({ tier: 1, condition: cond, state, now });
      if (d.alert) { fired.push(day); state = applyOutcome(state, { condition: cond, alerted: true, now }); }
      else state = applyOutcome(state, { condition: cond, alerted: false, now });
    }
    // The ladder is 0h / +24h / +72h then daily, so over ten daily runs starting
    // from an already-alerted incident: day 1 (+24h), day 3 (+72h), then daily.
    // Day 2 is the rung that proves suppression is real — a naive "alert every
    // run" implementation passes every other assertion in this file but not this.
    assert.ok(!fired.includes(2), `+48h is not a rung; fired on days ${fired}`);
    assert.deepStrictEqual(fired, [1, 3, 4, 5, 6, 7, 8, 9, 10],
      `expected the 24h/72h/daily ladder, fired on days ${fired}`);
  });

  // ---- applyOutcome: flap debounce N=2 ----

  // cohort-track straddles a hard >50% boundary as a cohort decays, every 2 days.
  // Without debounce that alerts in BOTH directions and doubles today's volume.
  check('one clean run does not clear a condition', () => {
    const state = { condition_key: 'null-views', alert_count: 1, first_alerted_at: t0, consecutive_clear: 0 };
    const after = applyOutcome(state, { condition: null, alerted: false, now: hours(2) });
    assert.strictEqual(after.resolved, false, 'a single clean run is a flap, not a fix');
    assert.strictEqual(after.consecutive_clear, 1);
  });

  check('two consecutive clean runs clear it', () => {
    let state = { condition_key: 'null-views', alert_count: 1, first_alerted_at: t0, consecutive_clear: 0 };
    state = applyOutcome(state, { condition: null, alerted: false, now: hours(2) });
    state = applyOutcome(state, { condition: null, alerted: false, now: hours(4) });
    assert.strictEqual(state.resolved, true);
    assert.strictEqual(CLEAR_RUNS, 2);
  });

  // The flap itself: bad, good, bad. That is ONE incident, so the ladder must not
  // restart — otherwise every oscillation produces a fresh "first sighting" alert.
  check('a condition reappearing mid-debounce continues the same incident', () => {
    let state = { condition_key: 'null-views', alert_count: 1, first_alerted_at: t0, consecutive_clear: 0 };
    state = applyOutcome(state, { condition: null, alerted: false, now: hours(2) });
    const c = { key: 'null-views', severity: 'warning', message: '51% null' };
    const d = decideAlert({ tier: 1, condition: c, state, now: hours(4) });
    assert.strictEqual(d.alert, false, 'a flap must not re-alert as if it were new');
    const after = applyOutcome(state, { condition: c, alerted: false, now: hours(4) });
    assert.strictEqual(after.consecutive_clear, 0, 'the clear streak resets');
    assert.strictEqual(after.first_alerted_at.getTime(), t0.getTime(), 'the ladder anchor survives the flap');
  });

  check('a cleared condition that returns later is a NEW incident and alerts', () => {
    let state = { condition_key: 'null-views', alert_count: 1, first_alerted_at: t0, consecutive_clear: 0 };
    state = applyOutcome(state, { condition: null, alerted: false, now: hours(2) });
    state = applyOutcome(state, { condition: null, alerted: false, now: hours(4) });
    assert.strictEqual(state.resolved, true);
    const c = { key: 'null-views', severity: 'warning', message: '51% null' };
    assert.strictEqual(decideAlert({ tier: 1, condition: c, state: null, now: hours(200) }).alert, true);
  });

  check('LADDER_HOURS is the documented 0/24/72 shape', () => {
    assert.deepStrictEqual(LADDER_HOURS, [0, 24, 72]);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
