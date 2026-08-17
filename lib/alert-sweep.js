'use strict';

// lib/alert-sweep.js
//
// The pure half of `cron-health-slack.js --sweep` (spec §4.4).
//
// WHY A SWEEP AT ALL. The daily 03:00 digest would find a Monday 08:50
// premarket-flow miss at 03:00 on TUESDAY — eighteen hours after the perishable
// thing stopped being recoverable. The sweep closes that latency gap and carries
// ONLY tier-1 jobs, because a late tier-2 render loses nothing by waiting.
//
// WHY IT IS THE SAME SCRIPT. Spec §4.4 is explicit: two scripts sharing 90% of
// their logic is how the null-view check came to be re-implemented badly in one
// place after being fixed in another. The sweep therefore reuses
// lib/job-liveness.js wholesale and adds only the three things below.
//
// THE STORM CAP is the reason renderSweep takes a LIST and returns ONE string. A
// DB outage or an expired credential fails every tier-1 job at once; one message
// per job would rebuild the 56-warning pathology out of its own fix.
//
//   node lib/alert-sweep.js --smoke

// Deliberately outside the Monday 03:00-09:00 capture cluster, where a sweep
// would read half the pipeline as not-yet-run and alert about jobs that are
// merely still queued.
const SWEEP_HOURS = [1, 11, 17, 23];

// The liveness states that mean a perishable observation is at risk right now.
// 'pending', 'in-flight' and 'too-soon' are explicitly NOT here: each is a job
// behaving correctly, and alerting on them is the standing-noise failure.
const SWEEPABLE = new Set(['missing', 'orphan', 'failed']);

function selectSweepTargets(results) {
  return results.filter(r => r.tier === 1 && SWEEPABLE.has(r.state));
}

// The condition identity for a sweep incident. Keys on the STATE, never on the
// detail text: the detail carries expected-fire timestamps and live counts, so a
// text key would never match itself twice and would suppress nothing at all.
function sweepConditionKey(result) {
  return `sweep:${result.state}`;
}

const STATE_WORD = { missing: 'silent', orphan: 'orphaned', failed: 'failing' };

// renderSweep(targets) -> one message, or null when there is nothing to say.
function renderSweep(targets) {
  if (!targets || targets.length === 0) return null;
  const n = targets.length;
  const noun = n === 1 ? 'job' : 'jobs';
  const detail = targets
    .map(t => `• ${t.job} (${t.label}) — ${STATE_WORD[t.state] || t.state}: ${t.detail}`)
    .join('\n');
  return `🚨 TIER1 <!channel> [SWEEP] ${n} tier-1 ${noun} unhealthy\n${detail}`;
}

module.exports = { SWEEP_HOURS, SWEEPABLE, selectSweepTargets, sweepConditionKey, renderSweep };

// ---------------------------------------------------------------
//   node lib/alert-sweep.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { selectSweepTargets, sweepConditionKey, renderSweep, SWEEP_HOURS } = module.exports;
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  const r = (job, state, tier = 1, extra = {}) =>
    Object.assign({ job, state, tier, label: 'Weekly (Mon 06:00)', detail: `${state} detail` }, extra);

  // ---- selectSweepTargets ----

  // The sweep exists to close a LATENCY gap (§4.4): a daily 03:00 watchdog finds
  // a Monday 08:50 miss at 03:00 Tuesday, by which time the perishable thing is
  // gone. So it carries only what is perishable.
  check('only tier 1 is swept — tier 2 waits for the digest', () => {
    const out = selectSweepTargets([r('a', 'missing', 1), r('b', 'missing', 2)]);
    assert.deepStrictEqual(out.map(t => t.job), ['a']);
  });

  check('healthy, pending, in-flight and too-soon are never swept', () => {
    const states = ['ok', 'pending', 'in-flight', 'too-soon'];
    const out = selectSweepTargets(states.map((s, i) => r(`j${i}`, s, 1)));
    assert.deepStrictEqual(out, []);
  });

  check('missing, orphan and failed are all swept', () => {
    const out = selectSweepTargets([r('a', 'missing'), r('b', 'orphan'), r('c', 'failed')]);
    assert.deepStrictEqual(out.map(t => t.job), ['a', 'b', 'c']);
  });

  // ---- sweepConditionKey ----

  // Suppression must key on the STATE, never on the detail text — the detail
  // carries timestamps and live counts, so a text key would never match itself
  // twice and would suppress nothing.
  check('the sweep key is the state, not the volatile detail text', () => {
    const k1 = sweepConditionKey(r('a', 'missing', 1, { detail: 'nothing since 2026-08-17 06:00 UTC' }));
    const k2 = sweepConditionKey(r('a', 'missing', 1, { detail: 'nothing since 2026-08-24 06:00 UTC' }));
    assert.strictEqual(k1, k2, 'the same incident a week later must share a key');
    assert.ok(/missing/.test(k1), `the key should name the state, got ${k1}`);
  });

  check('a job that changes from missing to failed gets a different key', () => {
    assert.notStrictEqual(sweepConditionKey(r('a', 'missing')), sweepConditionKey(r('a', 'failed')));
  });

  // ---- renderSweep: the storm cap ----

  // A DB outage or an expired credential fails every tier-1 job at once. Without
  // this the sweep emits one message per job — the 56-warning pathology rebuilt
  // out of its own fix.
  check('twelve simultaneous failures render as ONE message', () => {
    const targets = Array.from({ length: 12 }, (_, i) => r(`job-${i}`, 'missing'));
    const msg = renderSweep(targets);
    assert.strictEqual(typeof msg, 'string');
    assert.ok(msg.includes('12'), `the roll-up must state the count: ${msg}`);
  });

  check('the rolled-up message names every affected job', () => {
    const msg = renderSweep([r('cohort-create', 'missing'), r('market-totals-daily', 'orphan')]);
    assert.ok(msg.includes('cohort-create') && msg.includes('market-totals-daily'));
  });

  // Tier 1 and the digest share one channel; the mention is what separates "a
  // perishable observation was just lost" from "a report is late".
  check('a sweep alert notifies and carries the greppable TIER1 prefix', () => {
    const msg = renderSweep([r('cohort-create', 'missing')]);
    assert.ok(msg.startsWith('🚨 TIER1 '), `got: ${msg}`);
    assert.ok(msg.includes('<!channel>'));
  });

  check('the singular case does not say "1 jobs"', () => {
    const msg = renderSweep([r('cohort-create', 'missing')]);
    assert.ok(!/1 jobs/.test(msg), `got: ${msg}`);
  });

  check('nothing to report renders nothing at all', () => {
    assert.strictEqual(renderSweep([]), null);
  });

  // §4.4: deliberately OUTSIDE the Monday 03:00-09:00 capture cluster, where a
  // sweep would read half the pipeline as not-yet-run.
  check('the sweep hours avoid the Monday capture cluster', () => {
    assert.deepStrictEqual(SWEEP_HOURS, [1, 11, 17, 23]);
    for (const h of SWEEP_HOURS) {
      assert.ok(h < 3 || h > 9, `${h}:00 falls inside the 03:00-09:00 capture cluster`);
    }
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
