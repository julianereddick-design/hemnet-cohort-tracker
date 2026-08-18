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
    // notBefore removed 2026-08-18: the job's first fire (Mon 2026-08-17 09:00 UTC)
    // ran for 848s, walked 78 pages and wrote its premarket_quality_weekly row, so
    // the assertion now has real data to key off. It finished `warning`, not
    // `success` — 621/621 ambiguous listings unresolved — but that is a data-quality
    // condition, not a liveness one, and suppressing liveness for it would hide a
    // genuinely missed run.
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
    log: '/var/log/hemnet/spotcheck-gate.log',
    // 60 was a guess and it is too low. MEASURED on the first healthy run since
    // the 8496706 fix (2026-08-17, cohort 2026-W33): 323 pairs photo-enriched at
    // ~3/min, i.e. ~105 minutes. At 60 the watchdog's orphan threshold
    // (expectedDurationMin x 2) would have been 120 minutes — fifteen minutes of
    // headroom on a job whose cost scales with cohort size, so a larger cohort
    // would be declared orphaned WHILE STILL RUNNING and alert as tier 1.
    expectedDurationMin: 180,
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

  // Cadence changed weekly -> MONTHLY on 2026-08-17. The assertion window moved
  // 8d -> 40d with it; leaving it at 8 days would have gone red about three
  // weeks in every four.
  //
  // Migrated OFF celery-beat on the price droplet and onto THIS droplet's cron
  // 2026-08-18 (that droplet is being destroyed) — `external: true` is removed,
  // the job now runs here and writes its own cron_job_log row like every other
  // job in this file.
  'ad-cost-crawler': {
    // 00:30, NOT 02:00. 'age-census-monthly' already owns `0 2 1 * *` and runs
    // ~3h (expectedDurationMin: 240), so 02:00 would start two never-before-run
    // tier-1 monthly jobs on the same minute, on one vCPU / 2GB with no swap.
    // The crawler's TIME_BUDGET leaves only ~31% headroom at its own measured
    // rate, and subprocess.run DISCARDS stdout on timeout — contention costs the
    // whole month, not the tail. 00:30 + the 45-min ceiling ends by 01:15, which
    // is 45 min clear of the census and 6h40m ahead of the 07:10 report, and it
    // stays inside one UTC date so the day-scoped write cannot straddle midnight.
    tier: 1, frequency: 'monthly', label: 'Monthly (1st 00:30)',
    cron: '30 0 1 * *', command: 'node adcost-crawl.js',
    file: 'adcost-crawl.js',
    env: { PYTHON_BIN: '/opt/hemnet-cohort-tracker/.venv-adcost/bin/python' },
    log: '/var/log/hemnet/adcost-crawl.log',
    // 45 min = the 2700s subprocess ceiling, NOT the ~21 min expected runtime, so a
    // slow-but-successful month is not alerted as an overrun.
    expectedDurationMin: 45,
    assert: 'adCostMonth',
    notBefore: '2026-09-02',
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
    // Only became able to write a cron_job_log row on 2026-08-17 (Phase 1 wrapped
    // it in runJob). Its last expected fire was 2026-08-01, BEFORE that, so it has
    // no row and cannot have one — and its next fire is not until 2026-09-01. The
    // liveness check would therefore report it silent every single day for two
    // weeks over a job that is fine. The five WEEKLY reporters wrapped in the same
    // phase need no such key: they fire the same day and self-heal within hours.
    // Delete this key once it has run once.
    notBefore: '2026-09-02',
  },
  'adcost-report': {
    // 07:10, five hours after the 02:00 UTC ad-cost scrape on the price droplet
    // (a warm grid took 227s; a cold one budgets to ~1,884s, so five hours is
    // ample). Offset ten minutes from age-census-report rather than sharing its
    // 07:00 slot: this droplet has 458MB of RAM and already OOM-kills the weekly
    // xlsx export, so two report jobs building workbooks at the same instant is a
    // risk with no upside.
    // PYTHON_BIN is explicit because the numbers come from scripts/adcost-report.py,
    // and the droplet's SYSTEM python3 has neither psycopg nor openpyxl (verified
    // 2026-08-17 — that script had only ever been run from a workstation). Ubuntu's
    // python3.12 is PEP-668 externally-managed, so the deps live in a venv rather
    // than being force-installed system-wide. Without this the job fails on its
    // first fire with ModuleNotFoundError.
    tier: 2, frequency: 'monthly', label: 'Monthly (1st 07:10)',
    cron: '10 7 1 * *', command: 'node adcost-report.js',
    env: { PYTHON_BIN: '/opt/hemnet-cohort-tracker/.venv-adcost/bin/python' },
    log: '/var/log/hemnet/adcost-report.log', expectedDurationMin: 15,
    // Deployed 2026-08-17; first fire is 2026-09-01 07:10. Its last EXPECTED fire
    // by the cron spec is 2026-08-01, which predates the job existing, so it has no
    // cron_job_log row and cannot have one. Without this key the liveness check
    // reports it silent every day for two weeks over a job that is fine — the same
    // false alarm age-census-report needed the key for.
    // Delete this key once it has run once.
    notBefore: '2026-09-02',
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
  'cron-health-sweep': {
    // The SAME script in --sweep mode, not a second script (spec §4.4): two
    // scripts sharing 90% of their logic is how the null-view check came to be
    // re-implemented badly in one place after being fixed in another. `file`
    // records that sharing so the runJob coverage check can find it.
    //
    // 01/11/17/23 is deliberately OUTSIDE the Monday 03:00-09:00 capture
    // cluster, where a sweep would read half the pipeline as not-yet-run.
    // It closes the latency gap the daily digest cannot: a Monday 08:50
    // premarket-flow miss would otherwise surface at 03:00 on Tuesday, 18h after
    // the perishable thing stopped being recoverable.
    tier: 2, frequency: 'daily', label: 'Sweep (01/11/17/23)',
    cron: '0 1,11,17,23 * * *', command: 'node cron-health-slack.js --sweep',
    file: 'cron-health-slack.js', expectedDurationMin: 10,
  },
  'alerting-heartbeat': {
    // Proof of life over the WEBHOOK path specifically (spec §4.6). Once tier 2
    // goes quiet nothing else exercises that path, and a tier-1 alert whose
    // delivery failed is simply gone — postAlert returns {ok:false}, the run
    // logs "Slack alert failed", and still exits 0. Weekly, Thursday 12:00, so
    // it lands on a quiet day well away from the Monday capture cluster.
    tier: 2, frequency: 'weekly', label: 'Weekly (Thu 12:00)',
    cron: '0 12 * * 4', command: 'node cron-health-slack.js --heartbeat',
    file: 'cron-health-slack.js', expectedDurationMin: 5,
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
      // `file` lets two registry entries share ONE script — cron-health-slack.js
      // is both the daily digest and, with --sweep, the sweep. Spec §4.4 requires
      // that sharing, so the coverage check has to be able to express it.
      const candidates = rec.file
        ? [path.join(root, rec.file), path.join(root, 'scripts', rec.file)]
        : [path.join(root, `${job}.js`), path.join(root, 'scripts', `${job}.js`)];
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
