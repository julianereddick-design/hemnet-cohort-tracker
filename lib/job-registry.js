'use strict';

// lib/job-registry.js
//
// The single source of truth for what each scheduled job IS. Read by
// cron-wrapper.js (tier decides whether an alert @-mentions) and, from Phase 2
// of docs/superpowers/specs/2026-08-17-alerting-structure-design.md, by the
// crontab renderer and the watchdog.
//
// Keys are exact `cron_job_log.script_name` values — the `scriptName:` string
// passed to runJob. A key that matches no runJob call is dead weight; a runJob
// call with no key here alerts as a registry gap on every run (both are caught
// by the --smoke coverage check below).
//
// tier 1 = perishable. A missed run destroys an observation that can never be
//          recovered, because the window closed. Interrupts a human.
// tier 2 = recoverable. Pure renders from our own DB, or state that persists
//          elsewhere. Re-runnable at any time, so it waits for the digest.
//
// The tier line falls almost exactly on capture-vs-render (spec §3): anything
// that reaches out and observes the market is perishable; anything that reads
// our own DB and draws a picture is not.
//
//   node lib/job-registry.js --smoke

const JOBS = {
  // ---- tier 1: capture ----
  'cohort-create':             { tier: 1 },  // Mon 06:00 — a missed week can never exist
  'market-totals-daily':       { tier: 1 },  // daily 08:30 — yesterday is unscrapeable
  'premarket-flow-measure':    { tier: 1 },  // Mon 08:50 — the 2026-07-20 loss
  'premarket-quality-measure': { tier: 1 },  // Mon 09:00 — samples live listings; they churn
  'age-census-monthly':        { tier: 1 },  // 1st 02:00 — a missed month is blank forever
  'cohort-track':              { tier: 1 },  // every 2d 22:00 — the interval increment is lost
  'hemnet-targeted-refresh':   { tier: 1 },  // every 2d 14:00 — feeds cohort-track 8h later
  'booli-targeted-refresh':    { tier: 1 },  // every 2d 14:00 — same, Booli side
  'booli-targeted-discovery':  { tier: 1 },  // Sun 22:00 — the pool Monday draws from
  'hemnet-targeted-match':     { tier: 1 },  // Mon 03:00 — 3h before cohort-create

  // Corrected to tier 1 during design (spec §3). Both LOOK like QA/reporting and
  // are not: they re-observe live pages, so a late re-run measures something else.
  'cohort-spotcheck-gate':     { tier: 1 },  // re-fetches both listing pages live; delisted
                                             // pairs become permanently unreviewable
  'sold-match-batch':          { tier: 1 },  // sliding 14d lookback + even-ISO-week gate, so a
                                             // later re-run samples a different fortnight

  // ---- tier 2: render / recoverable ----
  'spotcheck-reaction-poller':    { tier: 2 },  // reactions persist in Slack
  'weekly-view-report':           { tier: 2 },
  'market-totals-weekly-report':  { tier: 2 },
  'premarket-flow-weekly-report': { tier: 2 },
  'sold-match-report':            { tier: 2 },
  'age-census-report':            { tier: 2 },
  'sold-match-trend-chart':       { tier: 2 },
  'sold-match-xlsx':              { tier: 2 },
  'cron-health-slack':            { tier: 2 },  // the watchdog itself; its own death is an
                                                // accepted limit (spec §5), not a tier-1 alert

  // Deprecated 2026-08-13, unscheduled, no downstream consumer. Listed only so
  // the coverage check stays honest — it still requires cron-wrapper.
  'sfpl-region-snapshot': { tier: 2, deprecated: true, note: 'removed from the crontab 2026-08-13' },
};

// tierOf(scriptName) -> 1 | 2 | null
// null means "not in the registry". Callers MUST treat that as a fault to be
// surfaced, never as a default tier — guessing tier 2 would silence a new
// perishable job, and guessing tier 1 would hide the registry gap behind noise.
function tierOf(scriptName) {
  const rec = JOBS[scriptName];
  return rec ? rec.tier : null;
}

module.exports = { JOBS, tierOf };

// ---------------------------------------------------------------
// --smoke self-test (offline: no network, no DB, no Slack)
//   node lib/job-registry.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');
  const { JOBS, tierOf } = module.exports;
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('exports JOBS and tierOf', () => {
    assert.strictEqual(typeof JOBS, 'object', 'JOBS is not an object');
    assert.strictEqual(typeof tierOf, 'function', 'tierOf is not a function');
  });

  check('every tier is exactly 1 or 2', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      assert.ok(rec.tier === 1 || rec.tier === 2, `${job} has tier ${JSON.stringify(rec.tier)}`);
    }
  });

  // The spec's §3 tier-1 table, verbatim. Two of these were *corrected* to tier 1
  // during design (the gate re-fetches live pages; the sold-match sampler uses a
  // sliding 14d lookback) — a silent demotion here would undo that decision.
  check('every tier-1 job from the design doc is tier 1', () => {
    const TIER1 = [
      'cohort-create', 'market-totals-daily', 'premarket-flow-measure',
      'premarket-quality-measure', 'age-census-monthly', 'cohort-track',
      'hemnet-targeted-refresh', 'booli-targeted-refresh', 'booli-targeted-discovery',
      'hemnet-targeted-match', 'cohort-spotcheck-gate', 'sold-match-batch',
    ];
    for (const job of TIER1) {
      assert.ok(JOBS[job], `${job} is missing from the registry entirely`);
      assert.strictEqual(JOBS[job].tier, 1, `${job} must be tier 1 (spec §3)`);
    }
  });

  check('the recoverable reporters are tier 2', () => {
    for (const job of ['spotcheck-reaction-poller', 'weekly-view-report', 'sold-match-report']) {
      assert.strictEqual(JOBS[job] && JOBS[job].tier, 2, `${job} must be tier 2 (spec §3)`);
    }
  });

  check('tierOf returns null for an unknown job, never a default', () => {
    assert.strictEqual(tierOf('not-a-real-job'), null);
    assert.strictEqual(tierOf(undefined), null);
    assert.strictEqual(tierOf('cohort-create'), 1);
    assert.strictEqual(tierOf('spotcheck-reaction-poller'), 2);
  });

  // Coverage: a job that runs under runJob but is absent here would alert as a
  // registry gap on every single run. Catch that here instead of in the channel.
  check('every runJob scriptName in the repo is in the registry', () => {
    const root = path.join(__dirname, '..');
    const found = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (!/require\(['"][^'"]*cron-wrapper['"]\)/.test(src)) continue;
        for (const m of src.matchAll(/scriptName:\s*['"]([a-z0-9-]+)['"]/g)) found.add(m[1]);
      }
    };
    walk(path.join(root, 'lib'));
    walk(path.join(root, 'scripts'));
    walk(root);
    for (const job of found) {
      assert.ok(JOBS[job], `${job} runs under runJob but is not in lib/job-registry.js`);
    }
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
