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
  'cohort-create': {
    // Mon 06:00 — builds the week's cohort from that week's NEW listings;
    // a missed week can never exist.
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 06:00)',
    cron: '0 6 * * 1', command: 'node cohort-create.js',
    expectedDurationMin: 10, assert: 'cohortCreated',
  },
  'market-totals-daily': {
    // daily 08:30 — one site-headline snapshot per day; yesterday is unscrapeable.
    tier: 1, frequency: 'daily', label: 'Daily (08:30)',
    cron: '30 8 * * *', command: 'node market-totals-daily.js',
    log: '/var/log/hemnet/market-totals.log', expectedDurationMin: 10,
    assert: 'marketTotalsDay',
  },
  'premarket-flow-measure': {
    // Mon 08:50 — the weekly pre-market snapshot; the 2026-07-20 loss.
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 08:50)',
    cron: '50 8 * * 1', command: 'node scripts/premarket-flow-measure.js',
    env: { SCRAPE_FORCE_OXYLABS: '1' },
    log: '/var/log/hemnet/premarket-flow-measure.log', expectedDurationMin: 45,
    assert: 'premarketFlowWeek',
  },
  'premarket-quality-measure': {
    // Mon 09:00 — samples live pre-market listings; they churn. Takes 22-27 min.
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 09:00)',
    cron: '0 9 * * 1', command: 'node scripts/premarket-quality-measure.js',
    log: '/var/log/hemnet/premarket-quality.log', expectedDurationMin: 45,
    assert: 'premarketQualityWeek',
    // Deployed 2026-08-13 (a Thursday) and has NEVER run — cron_job_log has zero
    // rows for it and premarket_quality_weekly is empty. Its first fire is Mon
    // 2026-08-17 09:00 UTC. Without notBefore the assertion is red on day one,
    // for a job that is working fine. Delete this key once it has run once.
    notBefore: '2026-08-18',
  },
  'age-census-monthly': {
    // 1st 02:00, ~3h — monthly census of live pools; a missed month is blank forever.
    tier: 1, frequency: 'monthly', label: 'Monthly (1st 02:00)',
    cron: '0 2 1 * *', command: 'node scripts/age-census-monthly.js',
    log: '/var/log/hemnet/age-census.log', expectedDurationMin: 240,
    assert: 'ageCensusMonth',
    // Deployed 2026-08-14 but has NEVER run — first fire is 02:00 UTC on
    // 2026-09-01, and age_census_run is empty. Without notBefore the assertion
    // is red from the day it ships, which is exactly the standing noise this
    // design exists to escape. Delete this key once it has run once.
    notBefore: '2026-09-02',
  },
  'cohort-track': {
    // every 2d 22:00 — view counters are cumulative so the LEVEL survives, but the
    // interval increment is lost, and incremental view rate is the core metric.
    tier: 1, frequency: 'every2days', label: 'Every 2 days (22:00)',
    cron: '0 22 */2 * *', command: 'node cohort-track.js',
    log: '/var/log/hemnet/cohort-track.log', expectedDurationMin: 30,
    assert: 'cohortTrackViews',
  },
  'hemnet-targeted-refresh': {
    // every 2d 14:00 — writes the view counts cohort-track reads 8h later.
    tier: 1, frequency: 'every2days', label: 'Every 2 days (14:00)',
    cron: '0 14 */2 * *', command: 'node hemnet-targeted-refresh.js',
    log: '/var/log/hemnet/job-a.log', expectedDurationMin: 60,
    assert: 'hemnetRefreshRecent',
  },
  'booli-targeted-refresh': {
    tier: 1, frequency: 'every2days', label: 'Every 2 days (14:00)',
    cron: '0 14 */2 * *', command: 'node booli-targeted-refresh.js',
    log: '/var/log/hemnet/job-d.log', expectedDurationMin: 60,
    assert: 'booliRefreshRecent',
  },
  'booli-targeted-discovery': {
    // Sun 22:00 — discovers the new-listing pool Monday's cohort-create draws from.
    tier: 1, frequency: 'weekly', label: 'Weekly (Sun 22:00)',
    cron: '0 22 * * 0', command: 'node booli-targeted-discovery.js',
    expectedDurationMin: 60, assert: 'booliDiscoveryRecent',
  },
  'hemnet-targeted-match': {
    // Mon 03:00 — matches Hemnet<->Booli 3h before cohort-create.
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 03:00)',
    cron: '0 3 * * 1', command: 'node hemnet-targeted-match.js',
    expectedDurationMin: 60, assert: 'hemnetMatchRecent',
  },

  // Corrected to tier 1 during design (spec §3). Both LOOK like QA/reporting and
  // are not: they re-observe live pages, so a late re-run measures something else.
  'cohort-spotcheck-gate': {
    // Re-fetches both listing pages LIVE; delisted pairs are diverted as
    // unreviewable, so that cohort's false-match rate is never measurable again.
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 06:30)',
    cron: '30 6 * * 1', command: 'node cohort-spotcheck-gate.js',
    log: '/var/log/hemnet/spotcheck-gate.log', expectedDurationMin: 60,
    assert: 'spotcheckGateRan',
  },
  'sold-match-batch': {
    // Fires weekly in cron; the EVEN-ISO-week gate lives inside the script. The
    // sampler uses a sliding 14-day lookback, so a later re-run samples a
    // different fortnight.
    tier: 1, frequency: 'fortnightly', label: 'Fortnightly (even ISO weeks, Mon 07:30)',
    cron: '30 7 * * 1', command: 'node sold-match-batch.js',
    log: '/var/log/hemnet/sold-match-batch.log', expectedDurationMin: 120,
    assert: 'soldMatchFortnight',
  },

  // Runs on a DIFFERENT droplet and writes no cron_job_log row here, so it has
  // no cron/command in this crontab and a DB assertion is the ONLY possible
  // monitor for it. `external: true` exempts it from the crontab renderer, the
  // runJob coverage check, and the cron-timing skip rules.
  'ad-cost-crawler': {
    tier: 1, external: true, frequency: 'weekly', label: 'Weekly (other droplet)',
    assert: 'adCostWeek',
  },

  // ---- tier 2: render / recoverable ----
  'spotcheck-reaction-poller': {
    tier: 2, frequency: 'daily', label: 'Daily (12:00)',      // reactions persist in Slack
    cron: '0 12 * * *', command: 'node spotcheck-reaction-poller.js',
    log: '/var/log/hemnet/spotcheck-poller.log', expectedDurationMin: 15,
  },
  'weekly-view-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 09:30)',
    cron: '30 9 * * 1', command: 'node weekly-view-report.js',
    expectedDurationMin: 30,
  },
  'market-totals-weekly-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 09:35)',
    cron: '35 9 * * 1', command: 'node market-totals-weekly-report.js',
    log: '/var/log/hemnet/market-totals-weekly.log', expectedDurationMin: 15,
  },
  'premarket-flow-weekly-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 10:30)',
    cron: '30 10 * * 1', command: 'node premarket-flow-weekly-report.js',
    log: '/var/log/hemnet/premarket-flow-report.log', expectedDurationMin: 15,
  },
  'sold-match-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 11:00)',
    cron: '0 11 * * 1', command: 'node sold-match-report.js',
    log: '/var/log/hemnet/sold-match-report.log', expectedDurationMin: 15,
  },
  'age-census-report': {
    tier: 2, frequency: 'monthly', label: 'Monthly (1st 07:00)',
    cron: '0 7 1 * *', command: 'node age-census-report.js',
    log: '/var/log/hemnet/age-census-report.log', expectedDurationMin: 15,
  },
  'sold-match-trend-chart': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 11:05)',
    cron: '5 11 * * 1', command: 'node sold-match-trend-chart.js',
    log: '/var/log/hemnet/sold-match-chart.log', expectedDurationMin: 15,
  },
  'sold-match-xlsx': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 11:10)',
    cron: '10 11 * * 1', command: 'node sold-match-xlsx.js',
    log: '/var/log/hemnet/sold-match-xlsx.log', expectedDurationMin: 15,
  },
  'cron-health-slack': {
    // the watchdog itself; its own death is an accepted limit (spec §5),
    // not a tier-1 alert.
    tier: 2, frequency: 'daily', label: 'Daily (03:00)',
    cron: '0 3 * * *', command: 'node cron-health-slack.js',
    expectedDurationMin: 15,
  },

  // ---- shell retention jobs: real scheduled work, but never a cron_job_log row.
  // Their OUTCOME is monitored as disk headroom instead (spec §2 principle 4).
  'spotcheck-artifact-retention': {
    tier: 2, shell: true, frequency: 'daily', label: 'Daily (06:20)',
    cron: '20 6 * * *',
    command: "ls -dt verf-spotcheck-* 2>/dev/null | tail -n +4 | xargs -r rm -rf",
    log: '/var/log/hemnet/spotcheck-retention.log',
  },
  'soldmatch-cache-retention': {
    tier: 2, shell: true, cwd: false, frequency: 'daily', label: 'Daily (06:30)',
    cron: '30 6 * * *',
    command: "find /opt/hemnet-cohort-tracker/verf-soldspike/cache -type f ! -name '_*' -mtime +3 -delete",
    log: '/var/log/hemnet/retention.log',
  },
  'premarket-quality-retention': {
    tier: 2, shell: true, cwd: false, frequency: 'daily', label: 'Daily (06:35)',
    cron: '35 6 * * *',
    command: "find /opt/hemnet-cohort-tracker/verf-premarket-quality -maxdepth 1 -name 'quality-*.json' -mtime +70 -delete",
    log: '/var/log/hemnet/retention.log',
  },

  // Deprecated 2026-08-13, unscheduled (no `cron`), no downstream consumer.
  // Listed only so the runJob coverage check stays honest.
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

  // Phase 1: every registered job that is a Node script must write a cron_job_log
  // row. Before this phase only 12 of ~23 did; the rest could fail indefinitely
  // in silence. `shell: true` jobs (find/xargs retention lines) never can.
  check('every non-shell, non-deprecated registry job is wrapped in runJob', () => {
    const root = path.join(__dirname, '..');
    const missing = [];
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.shell || rec.deprecated || rec.external) continue;
      const candidates = [
        path.join(root, `${job}.js`),
        path.join(root, 'scripts', `${job}.js`),
      ];
      const file = candidates.find(p => fs.existsSync(p));
      if (!file) { missing.push(`${job} (no script found)`); continue; }
      const src = fs.readFileSync(file, 'utf8');
      const wrapped = /require\(['"][^'"]*cron-wrapper['"]\)/.test(src)
        && new RegExp(`scriptName:\\s*['"]${job}['"]`).test(src);
      if (!wrapped) missing.push(job);
    }
    assert.deepStrictEqual(missing, [], `these jobs write no cron_job_log row: ${missing.join(', ')}`);
  });

  check('every scheduled job has cron + command; unscheduled ones have neither', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.cron == null) {
        assert.ok(rec.deprecated || rec.external,
          `${job} has no cron but is neither deprecated nor external`);
        continue;
      }
      assert.match(rec.cron, /^\S+ \S+ \S+ \S+ \S+$/, `${job} cron "${rec.cron}" is not 5 fields`);
      assert.ok(rec.command, `${job} has a cron but no command`);
    }
  });

  check('every scheduled Node job has an expectedDurationMin the watchdog can use', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.cron == null || rec.shell) continue;
      assert.ok(Number.isInteger(rec.expectedDurationMin) && rec.expectedDurationMin > 0,
        `${job} has no usable expectedDurationMin (needed to tell "still running" from "orphaned")`);
    }
  });

  check('the three retention lines are registered and flagged shell', () => {
    for (const job of ['spotcheck-artifact-retention', 'soldmatch-cache-retention', 'premarket-quality-retention']) {
      assert.ok(JOBS[job], `${job} is a real crontab line but is missing from the registry`);
      assert.strictEqual(JOBS[job].shell, true, `${job} must be shell:true — it writes no cron_job_log row`);
    }
  });

  // premarket-quality-measure is the PROVEN live drift: deployed, runJob-wrapped,
  // running weekly, and absent from deploy-instructions.md. It must be here.
  check('premarket-quality-measure is scheduled in the registry', () => {
    assert.ok(JOBS['premarket-quality-measure'].cron, 'the proven live drift is still undocumented');
    assert.strictEqual(JOBS['premarket-quality-measure'].command, 'node scripts/premarket-quality-measure.js');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
