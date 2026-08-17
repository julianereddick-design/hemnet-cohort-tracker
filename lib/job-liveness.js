'use strict';

// lib/job-liveness.js
//
// "Did it fire at all?" — the one question event-driven alerting structurally
// cannot answer, because a job that never started never reached cron-wrapper.
// Spec §4.3.1 of docs/superpowers/specs/2026-08-17-alerting-structure-design.md.
//
// WHY THIS FILE EXISTS. Until 2026-08-17 the check lived inline in
// cron-health-slack.js behind a hardcoded
//     SCRIPTS = ['cohort-track', 'cohort-create', 'age-census-monthly']
// so "it never ran at all" was detected for 3 jobs out of ~21. Phase 3 asserted
// tier-1 OUTPUT for all 12 tier-1 jobs but left that liveness list untouched, so
// eighteen scheduled jobs could stop firing entirely and nothing would say so.
// The set is now derived from lib/job-registry.js: adding a job to the registry
// monitors it, with no second edit anywhere.
//
// ANCHORING. Every judgement here is phrased against `lastExpectedFire + grace`
// (lib/job-cron.js), NEVER against a fixed lookback window. That is not a
// stylistic choice — it is the fix for two measured false alarms. Before
// 2026-08-13 every script was judged against a flat 25h window, which made
// weekly `cohort-create` warn on the six non-Mondays and every-2-days
// `cohort-track` (22:00 UTC on odd days) warn on alternate days because its last
// run was ~29h old when the 03:00 check ran. The frequency-keyed WINDOW_HOURS map
// that replaced it fixed those two but was still a parallel source of truth: it
// had no entry for `fortnightly`, so `sold-match-batch` would have had an
// undefined window and reported "no runs" forever the day it was added.
//
// A ROW IS NOT ENOUGH. The state must be a TERMINAL row with status success or
// warning. Incident 3 (the `downloadImage` hang) leaves a row stuck at `running`
// forever; orphan `running` rows are a recurring class here, which is why
// scripts/unstick-cron-row.js ships with --all-orphans.
//
//   node lib/job-liveness.js --smoke

const { lastExpectedFire } = require('./job-cron');

const GRACE_MIN = 15;        // breathing room on top of expectedDurationMin
const ORPHAN_BUDGETS = 2;    // spec §4.3.2: `running` past expectedDurationMin x 2

// A terminal outcome that proves the job ran to completion. `killed` and
// `failure` are terminal too, but they mean something different — see classify.
const FIRED = new Set(['success', 'warning']);
const TERMINAL = new Set(['success', 'warning', 'failure', 'killed']);

// selectJobs(jobs) — the jobs whose liveness is answerable from cron_job_log.
//
// Each exclusion is a job that would otherwise report "never ran" forever:
//   * shell:true      — find/xargs retention lines; no node, so no row. Their
//                       OUTCOME is monitored as disk headroom instead (§2.4).
//   * external:true   — the ad-cost crawler runs on a DIFFERENT droplet and
//                       writes no row into this database. Its DB assertion is
//                       the only possible monitor for it.
//   * no cron         — deprecated/unscheduled. Not supposed to run.
function selectJobs(jobs) {
  return Object.entries(jobs)
    .filter(([, rec]) => rec.cron && !rec.shell && !rec.external && !rec.deprecated)
    .map(([job, rec]) => ({ job, rec, label: rec.label || '', tier: rec.tier }))
    .sort((a, b) => a.job.localeCompare(b.job));
}

// classify(job, rec, { now, rows }) -> { state, detail, lastRow, lastStatus, lastFire }
//
// states, in the order they are decided:
//   pending    — deployed but not yet due (rec.notBefore)
//   in-flight  — a `running` row inside expectedDurationMin x 2
//   orphan     — a `running` row past that; it will never settle on its own
//   too-soon   — the expected fire is too recent for absence to mean anything
//   ok         — a terminal success/warning at or after the expected fire
//   failed     — it DID fire since then, and the outcome was failure/killed
//   missing    — nothing at all since the expected fire. This is the gap.
function classify(job, rec, { now, rows = [] }) {
  const lastFire = lastExpectedFire(rec.cron, now);
  const mine = rows.filter(r => r.script_name === job);
  const lastRow = mine.length ? mine.reduce((a, b) =>
    (new Date(a.started_at) >= new Date(b.started_at) ? a : b)) : null;
  const base = { lastRow, lastStatus: lastRow ? lastRow.status : null, lastFire };

  // A job deployed but not yet due is pending, not broken. Flagging it daily
  // until its first fire trains the reader to ignore this report, which is the
  // one failure mode a monitor cannot afford.
  if (rec.notBefore && now.toISOString().slice(0, 10) < rec.notBefore) {
    return Object.assign(base, { state: 'pending', detail: `deployed, first run due ${rec.notBefore}` });
  }

  if (!lastFire) return Object.assign(base, { state: 'too-soon', detail: 'no expected fire yet' });

  const budgetMs = (rec.expectedDurationMin || 15) * 60 * 1000;

  if (lastRow && lastRow.status === 'running') {
    const age = now - new Date(lastRow.started_at);
    if (age <= budgetMs * ORPHAN_BUDGETS) {
      return Object.assign(base, { state: 'in-flight', detail: `running for ${Math.round(age / 60000)}min` });
    }
    return Object.assign(base, {
      state: 'orphan',
      detail: `stuck at running for ${Math.round(age / 60000)}min (budget ${rec.expectedDurationMin}min)`,
    });
  }

  // A 3h job has not failed five minutes after it started. Without this the
  // whole Monday capture cluster reads as missing at 09:00 every week.
  if (now - lastFire < budgetMs + GRACE_MIN * 60 * 1000) {
    return Object.assign(base, { state: 'too-soon', detail: 'too soon after the expected fire' });
  }

  const since = mine.filter(r => new Date(r.started_at) >= lastFire && TERMINAL.has(r.status));
  const fired = since.find(r => FIRED.has(r.status));
  if (fired) {
    return Object.assign(base, {
      state: 'ok',
      detail: `${fmtTime(fired.started_at)}  ${fmtDuration(fired.duration_ms)}`,
    });
  }
  if (since.length) {
    return Object.assign(base, {
      state: 'failed',
      detail: `${since[0].status}: ${(since[0].error_message || '').slice(0, 160) || 'no message'}`,
    });
  }
  return Object.assign(base, {
    state: 'missing',
    detail: `nothing since the expected fire at ${fmtTime(lastFire)}`,
  });
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

const HEALTHY = new Set(['ok', 'in-flight', 'too-soon', 'pending']);

const ICON = {
  ok: ':white_check_mark:', failed: ':x:', missing: ':warning:', orphan: ':warning:',
  'in-flight': ':hourglass_flowing_sand:', 'too-soon': ':hourglass_flowing_sand:',
  pending: ':hourglass_flowing_sand:',
};

// buildLiveness(jobs, { now, rows, summarize }) -> { lines, issues, results }
//
// Rendering rule: anything unhealthy gets its own line; everything healthy is
// rolled up into ONE line that still NAMES every job. 21 jobs x 2 lines would
// bury the assertions and the cross-cutting checks under a wall of green, and a
// digest nobody reads is the failure this design exists to escape (§8) — but a
// roll-up that hides which jobs it covered would not be evidence of anything.
function buildLiveness(jobs, { now, rows = [], summarize = null }) {
  const results = selectJobs(jobs).map(({ job, rec, label, tier }) =>
    Object.assign({ job, label, tier }, classify(job, rec, { now, rows })));

  const lines = [];
  const issues = [];
  const healthy = [];

  for (const r of results) {
    if (r.state === 'ok') { healthy.push(r.job); continue; }
    if (r.state === 'in-flight' || r.state === 'too-soon') { healthy.push(`${r.job}*`); continue; }

    if (r.state === 'pending') {
      lines.push(`      ${ICON.pending} *${r.job}* (${r.label})  —  ${r.detail}`);
      continue;
    }

    // summarize is per-script and returns '' for scripts it has no shape for.
    const summarized = summarize && r.lastRow && r.lastRow.result_summary
      ? summarize(r.job, r.lastRow.result_summary) : '';
    const extra = summarized ? `  ${summarized}` : '';
    lines.push(`      ${ICON[r.state]} *${r.job}* (${r.label})  —  ${r.detail}${extra}`);

    const tierTag = r.tier === 1 ? 'tier 1' : 'tier 2';
    if (r.state === 'missing') {
      issues.push(`${r.job} (${tierTag}) is silent — ${r.detail}`);
    } else if (r.state === 'orphan') {
      issues.push(`${r.job} (${tierTag}) is orphaned — ${r.detail}`);
    } else if (r.state === 'failed') {
      issues.push(`${r.job} (${tierTag}) last run ${r.detail}`);
    }
  }

  if (healthy.length) {
    lines.push(`      :white_check_mark: ${healthy.length} ran on schedule: ${healthy.join(', ')}`);
  }

  return { lines, issues, results };
}

module.exports = { selectJobs, classify, buildLiveness, GRACE_MIN, ORPHAN_BUDGETS, fmtDuration, fmtTime };

// ---------------------------------------------------------------
//   node lib/job-liveness.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { selectJobs, classify, buildLiveness } = module.exports;
  const { JOBS } = require('./job-registry');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  // ---- selectJobs: WHICH jobs the watchdog can answer "did it fire?" for ----

  // The whole point of this module. Before it, cron-health-slack.js carried a
  // hardcoded SCRIPTS = ['cohort-track','cohort-create','age-census-monthly'],
  // so "it never ran at all" was detected for 3 jobs out of ~21. A job added to
  // the registry must become monitored with no second edit.
  check('selectJobs is registry-derived, not a hardcoded list of 3', () => {
    const names = selectJobs(JOBS).map(j => j.job);
    assert.ok(names.length >= 20, `expected the whole schedule, got ${names.length}: ${names.join(',')}`);
    for (const j of ['cohort-track', 'cohort-create', 'age-census-monthly']) {
      assert.ok(names.includes(j), `${j} was monitored before this change and must stay monitored`);
    }
    for (const j of ['sold-match-report', 'weekly-view-report', 'premarket-flow-measure',
                     'cohort-spotcheck-gate', 'sold-match-batch', 'market-totals-daily']) {
      assert.ok(names.includes(j), `${j} is scheduled and writes a row — it must now be monitored`);
    }
  });

  // Each exclusion is a job that would report "never ran" forever if included.
  check('selectJobs excludes what cannot write a cron_job_log row', () => {
    const names = selectJobs(JOBS).map(j => j.job);
    for (const j of ['spotcheck-artifact-retention', 'soldmatch-cache-retention', 'premarket-quality-retention']) {
      assert.ok(!names.includes(j), `${j} is a shell line — it can never write a row`);
    }
    assert.ok(!names.includes('ad-cost-crawler'), 'the ad-cost crawler runs on ANOTHER droplet and logs nothing here');
    assert.ok(!names.includes('sfpl-region-snapshot'), 'deprecated + unscheduled — it is not supposed to run');
  });

  check('every selected job carries the label and cron the renderer needs', () => {
    for (const j of selectJobs(JOBS)) {
      assert.ok(j.label, `${j.job} has no label`);
      assert.ok(j.rec.cron, `${j.job} has no cron`);
      assert.ok(j.rec.expectedDurationMin > 0, `${j.job} has no expectedDurationMin`);
    }
  });

  // ---- classify: the six states ----

  const rec = (over) => Object.assign({ cron: '0 6 * * 1', expectedDurationMin: 10, label: 'Weekly (Mon 06:00)' }, over);
  const row = (status, started_at, script_name = 'j') => ({ script_name, status, started_at });

  check('a terminal success at the expected fire is ok', () => {
    const r = classify('j', rec(), {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [row('success', '2026-08-17T06:00:05Z')],
    });
    assert.strictEqual(r.state, 'ok', r.detail);
  });

  // THE gap this module closes: no rows at all must be detected, for every job.
  check('no rows at all is missing, not silently ok', () => {
    const r = classify('j', rec(), { now: new Date('2026-08-18T03:00:00Z'), rows: [] });
    assert.strictEqual(r.state, 'missing');
  });

  // Spec §4.3.1: a row is not enough — incident 3 leaves a row stuck at `running`
  // forever, and the current code gets this right only by accident.
  check('a stale running row is an orphan, never ok', () => {
    const r = classify('j', rec({ expectedDurationMin: 10 }), {
      now: new Date('2026-08-17T09:00:00Z'),
      rows: [row('running', '2026-08-17T06:00:00Z')],   // 3h into a 10min budget
    });
    assert.strictEqual(r.state, 'orphan');
  });

  check('a running row inside 2x its budget is in flight, not an orphan', () => {
    const r = classify('j', rec({ expectedDurationMin: 240 }), {
      now: new Date('2026-08-17T08:00:00Z'),
      rows: [row('running', '2026-08-17T06:00:00Z')],
    });
    assert.strictEqual(r.state, 'in-flight');
  });

  // The false alarm that would otherwise arrive the moment this ships: a 60-minute
  // job checked 5 minutes after it started has not failed.
  check('too soon after the expected fire is not missing', () => {
    const r = classify('j', rec({ cron: '30 6 * * 1', expectedDurationMin: 60 }), {
      now: new Date('2026-08-17T06:35:00Z'),
      rows: [],
    });
    assert.strictEqual(r.state, 'too-soon');
  });

  check('notBefore keeps a deployed-but-not-yet-due job pending', () => {
    const r = classify('j', rec({ notBefore: '2026-09-02' }), {
      now: new Date('2026-08-18T03:00:00Z'), rows: [],
    });
    assert.strictEqual(r.state, 'pending');
    assert.match(r.detail, /2026-09-02/);
  });

  // A failure row means it DID fire. Reporting that as "no runs" would be a lie,
  // and would collide with the event-driven alert that already went out.
  check('a failure since the last fire is failed, not missing', () => {
    const r = classify('j', rec(), {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [row('failure', '2026-08-17T06:00:05Z')],
    });
    assert.strictEqual(r.state, 'failed');
  });

  check('a killed row is also not missing', () => {
    const r = classify('j', rec(), {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [row('killed', '2026-08-17T06:00:05Z')],
    });
    assert.strictEqual(r.state, 'failed');
  });

  // Spec §4.3.1 says success OR warning counts as "it fired". The old code tested
  // only 'success', so a job that always warns read as "no successful run".
  check('a warning counts as having fired', () => {
    const r = classify('j', rec(), {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [row('warning', '2026-08-17T06:00:05Z')],
    });
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.lastStatus, 'warning', 'the warning must still be reportable');
  });

  // The two ORIGINAL false alarms, from the flat-25h-window era. They are the
  // reason this check is anchored on lastExpectedFire and not on a lookback.
  check('a weekly job on a Wednesday is ok, not "no runs"', () => {
    const r = classify('cohort-create', rec({ cron: '0 6 * * 1' }), {
      now: new Date('2026-08-19T03:00:00Z'),                            // Wednesday
      rows: [row('success', '2026-08-17T06:00:05Z', 'cohort-create')],  // Monday
    });
    assert.strictEqual(r.state, 'ok');
  });

  check('an every-2-days job on an even day is ok, not "no runs"', () => {
    const r = classify('cohort-track', rec({ cron: '0 22 */2 * *', expectedDurationMin: 30 }), {
      now: new Date('2026-08-18T03:00:00Z'),          // even day, 5h after the odd-day fire
      rows: [row('success', '2026-08-17T22:00:05Z', 'cohort-track')],
    });
    assert.strictEqual(r.state, 'ok');
  });

  // sold-match-batch is frequency:'fortnightly', which the old WINDOW_HOURS map
  // had no entry for. Under the old shape its cutoff would have been NaN and every
  // row filtered out, i.e. a permanent false "no runs" the day it was added.
  check('an unknown frequency string cannot produce a false "no runs"', () => {
    const r = classify('sold-match-batch', rec({ cron: '30 7 * * 1', frequency: 'fortnightly', expectedDurationMin: 120 }), {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [row('success', '2026-08-17T07:30:05Z', 'sold-match-batch')],
    });
    assert.strictEqual(r.state, 'ok');
  });

  check('only rows for THIS script are considered', () => {
    const r = classify('j', rec(), {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [{ script_name: 'some-other-job', status: 'success', started_at: '2026-08-17T06:00:05Z' }],
    });
    assert.strictEqual(r.state, 'missing');
  });

  // ---- buildLiveness: rendering ----

  const JOBS_FIXTURE = {
    good: { tier: 2, cron: '0 6 * * 1', label: 'Weekly (Mon 06:00)', expectedDurationMin: 10 },
    silent: { tier: 1, cron: '0 6 * * 1', label: 'Weekly (Mon 06:00)', expectedDurationMin: 10 },
  };

  check('a healthy job raises no issue and a silent one does', () => {
    const out = buildLiveness(JOBS_FIXTURE, {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [{ script_name: 'good', status: 'success', started_at: '2026-08-17T06:00:05Z', duration_ms: 1200 }],
    });
    assert.strictEqual(out.issues.length, 1, `expected exactly one issue, got ${JSON.stringify(out.issues)}`);
    assert.match(out.issues[0], /silent/);
    assert.ok(!out.issues.join(' ').includes('good'), 'a healthy job must not raise an issue');
  });

  // §8: the channel is only trustworthy if it is readable. 21 jobs x 2 lines would
  // bury the assertions and the cross-cutting checks under a wall of green.
  check('healthy jobs roll up to one line but are still named', () => {
    const out = buildLiveness(JOBS_FIXTURE, {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [
        { script_name: 'good', status: 'success', started_at: '2026-08-17T06:00:05Z', duration_ms: 1200 },
        { script_name: 'silent', status: 'success', started_at: '2026-08-17T06:00:05Z', duration_ms: 1200 },
      ],
    });
    const rollup = out.lines.filter(l => /ran on schedule/i.test(l));
    assert.strictEqual(rollup.length, 1, `expected one roll-up line, got ${JSON.stringify(out.lines)}`);
    assert.match(rollup[0], /good/);
    assert.match(rollup[0], /silent/);
  });

  check('an unhealthy job gets its own line, never the roll-up', () => {
    const out = buildLiveness(JOBS_FIXTURE, {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [{ script_name: 'good', status: 'success', started_at: '2026-08-17T06:00:05Z', duration_ms: 1200 }],
    });
    const own = out.lines.filter(l => l.includes('*silent*'));
    assert.strictEqual(own.length, 1, `expected a dedicated line for the silent job, got ${JSON.stringify(out.lines)}`);
    const rollup = out.lines.find(l => /ran on schedule/i.test(l));
    assert.ok(!rollup.includes('silent'), 'an unhealthy job must not also appear as healthy');
  });

  // A tier-1 job going silent is a lost observation; a tier-2 report is late.
  // The digest does not interrupt either way, but the reader must be able to tell.
  check('the issue text distinguishes tier 1 from tier 2', () => {
    const out = buildLiveness(JOBS_FIXTURE, { now: new Date('2026-08-18T03:00:00Z'), rows: [] });
    const t1 = out.issues.find(i => i.startsWith('silent'));   // the tier-1 job is NAMED "silent"
    const t2 = out.issues.find(i => i.startsWith('good'));      // the tier-2 one
    assert.match(t1, /tier ?1/i, `a tier-1 silence must say so: ${t1}`);
    assert.match(t2, /tier ?2/i, `a tier-2 silence must say so: ${t2}`);
  });

  check('a summarize callback decorates the line when one is supplied', () => {
    const out = buildLiveness({ good: JOBS_FIXTURE.good }, {
      now: new Date('2026-08-18T03:00:00Z'),
      rows: [{ script_name: 'good', status: 'failure', started_at: '2026-08-17T06:00:05Z',
               duration_ms: 1200, error_message: 'boom', result_summary: { n: 7 } }],
      summarize: (name, s) => `n=${s.n}`,
    });
    assert.ok(out.lines.some(l => l.includes('n=7')), `summarize output missing: ${JSON.stringify(out.lines)}`);
  });

  // A total blackout over the REAL registry: everything monitored must be
  // reported, and the two legitimate skips must still be skipped.
  check('a total blackout over the real registry reports every job but the legitimate skips', () => {
    const out = buildLiveness(JOBS, { now: new Date('2026-08-18T03:00:00Z'), rows: [] });
    assert.ok(out.issues.length >= 15,
      `expected the whole schedule to be reported silent, got ${out.issues.length}`);

    // notBefore 2026-09-02 — deployed, first fire 2026-09-01. Pending, not broken.
    assert.ok(!out.issues.some(i => i.startsWith('age-census-monthly')),
      'a job that is not yet due must not be reported silent');
    assert.ok(out.lines.some(l => l.includes('age-census-monthly') && /first run due/.test(l)),
      'it must still be VISIBLE as pending, not simply omitted');

    // The digest fires at 03:00 and is itself in the registry; at 03:00 sharp its
    // own expected fire is 0 minutes old, so absence proves nothing yet.
    assert.ok(!out.issues.some(i => i.startsWith('cron-health-slack')),
      'a job whose expected fire is this minute cannot be judged silent');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
