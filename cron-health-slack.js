require('dotenv').config();
const { createClient } = require('./db');
const { postMessage, postAlert } = require('./lib/slack-post');
const { runReporter, evaluateAlert, connectWithRetry } = require('./cron-wrapper');
const { loadOpen, listOpen, saveState } = require('./lib/alert-state');
const { selectSweepTargets, sweepConditionKey, renderSweep } = require('./lib/alert-sweep');
const { parseDf, assessDisk, recordSample, recentSamples } = require('./lib/disk-floor');
const { execFileSync } = require('child_process');

// connectHardened (Phase 5, spec §4.3 "Hardening")
//
// The watchdog was the LEAST hardened process in the system: a bare
// createClient() + connect() with no retry and no statement_timeout, where
// cron-wrapper has had connectWithRetry (3 attempts, backoff) and a 120s timeout
// for months. One transient DB blip meant no digest — and no digest is
// indistinguishable from health, which is the accepted limit in §5 made worse
// than it needs to be.
async function connectHardened(log = () => {}) {
  const client = createClient();
  await connectWithRetry(client, log);
  await client.query("SET statement_timeout = '120000'");
  return client;
}

// readDisk() — free space as an OUTCOME, not as a job (spec §2 principle 4).
// Monitoring headroom rather than the prune jobs that protect it also catches
// pressure from causes nobody thought of. Returns null on any failure: a digest
// that cannot read df must still deliver everything else.
function readDisk() {
  try {
    const bytes = parseDf(execFileSync('df', ['-P', '-k', '/'], { encoding: 'utf8' }));
    const inodes = parseDf(execFileSync('df', ['-P', '-i', '/'], { encoding: 'utf8' }), { blockSize: 1 });
    return bytes && inodes ? { bytes, inodes } : null;
  } catch (_) {
    return null;
  }
}
const { JOBS } = require('./lib/job-registry');
const { runAssertions } = require('./lib/job-assertions');
const { buildLiveness } = require('./lib/job-liveness');

// FETCH_DAYS must cover the longest gap between two fires of any registered job.
// The monthly age census is the widest at 31 days, so a shorter window would put
// a healthy monthly job's last run outside this query and read it as "never ran".
const FETCH_DAYS = 34;

// The liveness check — "did it fire at all?" — used to live here behind a
// hardcoded SCRIPTS = ['cohort-track','cohort-create','age-census-monthly'] and a
// frequency-keyed WINDOW_HOURS map. It now lives in lib/job-liveness.js and is
// derived from lib/job-registry.js, so all ~21 scheduled Node jobs are covered
// rather than 3. The two false alarms the WINDOW_HOURS map existed to fix (weekly
// `cohort-create` warning on the six non-Mondays; every-2-days `cohort-track`
// warning on alternate days because its last run was ~29h old at the 03:00 check)
// are pinned as smoke checks there, phrased against lastExpectedFire instead of a
// lookback window. `notBefore` moved to the registry entry.

function summarizeResult(scriptName, summary) {
  if (!summary) return '';
  switch (scriptName) {
    case 'cohort-track': {
      let s = `tracked=${summary.totalTracked || 0} cohorts=${summary.cohortsTracked || 0}`;
      if (summary.totalNullBooli || summary.totalNullHemnet) {
        s += ` null_b=${summary.totalNullBooli || 0} null_h=${summary.totalNullHemnet || 0}`;
      }
      return s;
    }
    case 'cohort-create':
      if (summary.skipped) return `skipped (${summary.cohortId} exists)`;
      return `${summary.cohortId} matched=${summary.matched || 0} rate=${summary.matchRate || '-'}`;
    case 'age-census-monthly': {
      // Summary shape from scripts/age-census-monthly.js: { runDate, pools:[{platform,
      // pool, status, nTotal}], persisted, failed:[key], gateFailed:[key] }.
      const persisted = summary.persisted != null ? summary.persisted : '?';
      let s = `${persisted}/4 pools persisted`;
      if (summary.gateFailed && summary.gateFailed.length) s += ` gate_failed=${summary.gateFailed.join(',')}`;
      if (summary.failed && summary.failed.length) s += ` failed=${summary.failed.join(',')}`;
      return s;
    }
    default:
      return '';
  }
}

async function run() {
  const client = await connectHardened((lvl, m) => console.error(`[${lvl}] ${m}`));

  const rows = await client.query(`
    SELECT script_name, started_at, duration_ms, status, error_message, result_summary
    FROM cron_job_log
    WHERE started_at >= NOW() - INTERVAL '1 day' * $1
    ORDER BY started_at DESC
  `, [FETCH_DAYS]);

  const now = new Date();

  // ---------------------------------------------------------------
  // LIVENESS (Phase 3.1) — "did it fire at all?"
  //
  // The one question event-driven alerting structurally cannot answer: a job
  // that never started never reached cron-wrapper, so nothing alerted. Derived
  // from the registry, so adding a job monitors it. See lib/job-liveness.js for
  // the anchoring rules and the false alarms they exist to prevent.
  // ---------------------------------------------------------------
  const liveness = buildLiveness(JOBS, { now, rows: rows.rows, summarize: summarizeResult });
  const issues = [...liveness.issues];
  const lines = [':satellite_antenna:  *Liveness* (did each scheduled job fire?)', ...liveness.lines];

  // cohort-track anomaly: a run can succeed having tracked nothing at all, which
  // no liveness or status check can see — it is a result-shape fault.
  const trackRow = liveness.results.find(r => r.job === 'cohort-track');
  const trackSummary = trackRow && trackRow.lastRow && trackRow.lastRow.result_summary;
  if (trackSummary && trackSummary.totalTracked === 0 && trackSummary.cohortsTracked > 0) {
    issues.push(`cohort-track: 0 pairs tracked with ${trackSummary.cohortsTracked} active cohorts`);
  }

  // ---------------------------------------------------------------
  // ASSERTIONS (Phase 3) — "did the work actually produce output?"
  //
  // Exit code 0 is not evidence of work done. Each tier-1 job asserts on its own
  // output, evaluated against last_expected_fire + grace — NEVER against a
  // calendar period, because this digest runs at 03:00 and most jobs fire later.
  // Jobs in flight inside their duration budget are skipped, not failed.
  // ---------------------------------------------------------------
  const assertions = await runAssertions(client, JOBS, { now, rows: rows.rows });
  if (assertions.length > 0) {
    lines.push('');
    lines.push(':dart:  *Assertions* (tier 1 — did the data actually arrive?)');
    for (const a of assertions) {
      if (a.skipped) {
        lines.push(`      :heavy_minus_sign: ${a.job} — skipped: ${a.reason}`);
        continue;
      }
      lines.push(`      ${a.ok ? ':white_check_mark:' : ':x:'} ${a.job} — ${a.detail}`);
      if (!a.ok) issues.push(`${a.job} assertion FAILED: ${a.detail}`);
    }
  }

  // ---------------------------------------------------------------
  // OPEN CONDITIONS (Phase 4, §7 acceptance)
  //
  // "a tier-2 warning repeated 5 runs produces ... a digest line reading
  // 'continuing since X, 5 consecutive'".
  //
  // This is what makes tier-2 silence honest rather than merely quiet: the
  // condition is still visible, as a GAUGE with a start date and a run count,
  // which is exactly the shape §2 principle 2 asks for. seen_count is used, not
  // alert_count — a tier-2 condition never alerts, so its alert_count is 0 no
  // matter how long it has persisted.
  // ---------------------------------------------------------------
  const openConditions = await listOpen(client, 'run');
  if (openConditions.length > 0) {
    lines.push('');
    lines.push(':repeat:  *Open conditions* (suppressed, still true)');
    for (const c of openConditions) {
      const tier = JOBS[c.script_name] ? `tier ${JOBS[c.script_name].tier}` : 'unregistered';
      const since = new Date(c.first_seen_at).toISOString().slice(0, 10);
      const alerted = c.alert_count > 0 ? `${c.alert_count} alert(s)` : 'never alerted';
      lines.push(`      ${c.script_name} / ${c.condition_key} (${tier}) — continuing since ${since}, ${c.seen_count} consecutive, ${alerted}`);
    }
  }

  // ---------------------------------------------------------------
  // TIER-1 BACKSTOP (Phase 5, spec §4.6)
  //
  // Re-states every tier-1 failure/warning/kill in the last 24h REGARDLESS of
  // whether an alert was attempted or delivered. Once tier 2 goes quiet,
  // incidental chatter no longer proves the channel works — and a tier-1 alert
  // whose webhook delivery failed is simply gone: postAlert returns {ok:false},
  // cron-wrapper logs "Slack alert failed", and a warning run still exits 0.
  //
  // This is deliberately a BACKSTOP over the same facts, not a parallel channel:
  // it reads cron_job_log, which is written before any Slack call is made, so it
  // survives exactly the failure that loses the alert.
  // ---------------------------------------------------------------
  const since24h = new Date(now.getTime() - 24 * 3600 * 1000);
  const tier1Bad = rows.rows.filter(r =>
    JOBS[r.script_name] && JOBS[r.script_name].tier === 1 &&
    ['failure', 'warning', 'killed'].includes(r.status) &&
    new Date(r.started_at) >= since24h);

  lines.push('');
  if (tier1Bad.length === 0) {
    lines.push(':shield:  *Tier-1 backstop* (last 24h)  —  no tier-1 failures or warnings');
  } else {
    lines.push(`:shield:  *Tier-1 backstop* (last 24h)  —  ${tier1Bad.length} event(s), re-stated whether or not an alert was delivered`);
    for (const r of tier1Bad) {
      lines.push(`      ${r.status === 'warning' ? ':warning:' : ':x:'} ${r.script_name} ${r.status} — ${(r.error_message || '').slice(0, 140)}`);
    }
  }

  // ---------------------------------------------------------------
  // DISK HEADROOM (Phase 5, spec §3 and §2 principle 4)
  //
  // Monitored as an OUTCOME rather than by watching the three prune jobs, which
  // also catches pressure from causes nobody thought of. Bytes AND inodes: the
  // spot-check gate writes thousands of small JPEGs a week, which exhausts
  // inodes long before gigabytes. days_to_full is reported as context, never as
  // a breach in itself.
  // ---------------------------------------------------------------
  const diskRaw = readDisk();
  if (diskRaw) {
    await recordSample(client, diskRaw);
    const samples = await recentSamples(client, 30);
    const disk = assessDisk(Object.assign({ samples }, diskRaw));
    lines.push('');
    lines.push(`:floppy_disk:  *Disk headroom*  —  ${disk.detail}`);
    for (const b of disk.breaches) issues.push(`Disk: ${b}`);
  }

  // ---------------------------------------------------------------
  // CROSS-CUTTING CHECKS — these belong to NO single job and must keep an
  // explicit slot here. A registry-shaped rewrite that iterates jobs would
  // otherwise drop them as "not registry-shaped", and they are the only
  // detectors for their respective failures:
  //   * zero-growth  — the only detector for a SUCCESSFUL but degraded scrape
  //   * newest-cohort canary — the fix for the age-decay false alarms; its
  //     comment records the measured decay curve and why a flat all-cohort
  //     threshold was wrong. Losing that comment re-introduces the bug.
  // ---------------------------------------------------------------

  // Check cohort view growth — flag if most pairs had zero incremental views
  const growthRes = await client.query(`
    WITH latest_two AS (
      SELECT dv.pair_id, dv.date, dv.booli_views, dv.hemnet_views,
             ROW_NUMBER() OVER (PARTITION BY dv.pair_id ORDER BY dv.date DESC) AS rn
      FROM cohort_daily_views dv
      JOIN cohort_pairs cp ON cp.id = dv.pair_id
      JOIN cohorts c ON c.cohort_id = cp.cohort_id
      WHERE c.week_start >= CURRENT_DATE - INTERVAL '63 days'
        AND cp.removed_at IS NULL
        AND dv.booli_views IS NOT NULL
        AND dv.hemnet_views IS NOT NULL
    )
    SELECT
      COUNT(*) AS total_pairs,
      COUNT(*) FILTER (
        WHERE curr.booli_views = prev.booli_views
          AND curr.hemnet_views = prev.hemnet_views
      ) AS zero_growth_pairs
    FROM latest_two curr
    JOIN latest_two prev ON prev.pair_id = curr.pair_id AND prev.rn = 2
    WHERE curr.rn = 1
      AND curr.date - prev.date = 1
  `);

  if (growthRes.rows.length > 0 && growthRes.rows[0].total_pairs > 0) {
    const { total_pairs, zero_growth_pairs } = growthRes.rows[0];
    const zeroPct = Math.round((zero_growth_pairs / total_pairs) * 100);
    lines.push('');
    lines.push(`:bar_chart:  *View Growth Check*  —  ${zero_growth_pairs}/${total_pairs} pairs (${zeroPct}%) had zero growth`);
    if (zeroPct >= 80) {
      issues.push(`Stale view data: ${zeroPct}% of pairs had zero incremental views — scrapers may be down`);
    }
  }

  // Check per-cohort null view rates
  const nullViewRes = await client.query(`
    SELECT
      cp.cohort_id,
      COUNT(*) AS total_pairs,
      COUNT(*) FILTER (WHERE hemnet_views IS NULL) AS null_hemnet,
      COUNT(*) FILTER (WHERE booli_views IS NULL) AS null_booli
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    JOIN cohorts c ON c.cohort_id = cp.cohort_id
    WHERE c.week_start >= CURRENT_DATE - INTERVAL '63 days'
      AND cp.removed_at IS NULL
      AND dv.date = (SELECT MAX(date) FROM cohort_daily_views)
    GROUP BY cp.cohort_id
    ORDER BY cp.cohort_id
  `);

  if (nullViewRes.rows.length > 0) {
    lines.push('');
    lines.push(`:mag:  *View Data Quality* (latest data)`);
    const lastIdx = nullViewRes.rows.length - 1;
    for (let i = 0; i < nullViewRes.rows.length; i++) {
      const r = nullViewRes.rows[i];
      const bPct = Math.round((r.null_booli / r.total_pairs) * 100);
      const hPct = Math.round((r.null_hemnet / r.total_pairs) * 100);
      const canary = (i === lastIdx) ? '  ← canary' : '';
      // No per-cohort warning marker and no issue is raised off these rows. A high null
      // rate on an OLD cohort is not a fault: a null means the listing had no active row
      // when cohort-track asked, i.e. the ad is gone — sold, withdrawn or expired. Cohorts
      // therefore decay monotonically with age (measured 2026-08-17: 7% at 14d, 25% at 21d,
      // 33% at 28d, 41% at 42d, 52% at 56d, 64% at 63d), so ANY flat threshold is crossed by
      // every cohort eventually and the alert never stops. cohort-track.js already settled
      // this — see its "10-03 retarget" (line ~292), which scopes null-view alerting to the
      // most recent 4 cohorts and additionally requires a >10pp jump vs the same cohort's
      // previous run. This block used to re-implement the check with neither refinement,
      // and so re-fired exactly the alarms that retarget existed to silence.
      //
      // Two further reasons the numbers here were not trustworthy as an alert: the query
      // filters on `removed_at IS NULL`, but removed_at is set on only 5 of ~5,200 pairs —
      // the real liveness flags are dropped_booli_on/dropped_hemnet_on, which it ignores;
      // and for cohorts past the 56d tracking window the denominator is a straggler tail
      // (W25 showed n=55 against 672 real pairs).
      //
      // The rows stay — they are useful context, and the canary check below is the live
      // detector: the NEWEST cohort's listings are still on the market, so a high null rate
      // there is a genuine scraper signal rather than market decay.
      lines.push(`      ${r.cohort_id}: ${r.null_booli}/${r.total_pairs} null Booli (${bPct}%), ${r.null_hemnet}/${r.total_pairs} null Hemnet (${hPct}%)${canary}`);
    }

    // Canary check: newest cohort should have low null rates
    const newest = nullViewRes.rows[lastIdx];
    const newestBPct = Math.round((newest.null_booli / newest.total_pairs) * 100);
    const newestHPct = Math.round((newest.null_hemnet / newest.total_pairs) * 100);
    if (newestBPct > 30) issues.push(`Newest cohort ${newest.cohort_id}: ${newestBPct}% null Booli views — scraper may be down`);
    if (newestHPct > 30) issues.push(`Newest cohort ${newest.cohort_id}: ${newestHPct}% null Hemnet views — scraper may be down`);
  }

  await client.end();

  // Build Slack message
  const today = now.toISOString().slice(0, 10);
  const overall = issues.length === 0 ? ':white_check_mark: All healthy' : `:warning: ${issues.length} issue(s)`;

  let message = `*Hemnet Monitor — Daily Health Report*\n${today}  |  ${overall}\n\n${lines.join('\n')}`;

  if (issues.length > 0) {
    message += '\n\n*Issues:*\n' + issues.map(i => `• ${i}`).join('\n');
  }

  // The health monitor must never report success it did not deliver. postMessage
  // RETURNS {ok:false} on a failed delivery rather than throwing, and this script is
  // NOT wrapped by cron-wrapper.runJob — so without this branch a monitor that could
  // not reach Slack still exits 0 printing "All healthy", which is precisely the blind
  // spot it exists to close. The exit code is the only signal available here.
  const result = await postMessage('cron-health-slack', message);
  const summary = issues.length === 0 ? 'All healthy' : `${issues.length} issue(s) flagged`;
  if (result.dryRun) {
    console.log(`${summary} (dry run — not posted)`);
  } else if (result.ok) {
    console.log(summary);
  } else {
    console.error(`${summary} — but the Slack post FAILED on both the bot and the webhook fallback`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------
// SWEEP MODE (Phase 4, spec §4.4)
//
// The SAME script, not a second one — two scripts sharing 90% of their logic is
// how the null-view check came to be re-implemented badly in one place after
// being fixed in another.
//
// It closes a LATENCY gap the daily digest cannot: a Monday 08:50
// premarket-flow miss surfaces at 03:00 on Tuesday, eighteen hours after the
// perishable thing stopped being recoverable.
//
// CHEAP QUERIES ONLY. One indexed read of cron_job_log, and nothing else. The
// expensive quality queries — the ROW_NUMBER() over 63 days of
// cohort_daily_views and the per-cohort GROUP BY at the table max date — stay in
// the daily digest. They run once a day today; 4x/day against a managed Postgres
// shared with the other droplet is a real change, not a rounding error.
// ---------------------------------------------------------------
async function runSweep() {
  const client = await connectHardened((lvl, m) => console.error(`[${lvl}] ${m}`));
  try {
    const rows = await client.query(`
      SELECT script_name, started_at, duration_ms, status, error_message, result_summary
      FROM cron_job_log
      WHERE started_at >= NOW() - INTERVAL '1 day' * $1
      ORDER BY started_at DESC
    `, [FETCH_DAYS]);

    const now = new Date();
    const { results } = buildLiveness(JOBS, { now, rows: rows.rows });
    const targets = selectSweepTargets(results);

    // Each target is decided independently against its own incident ladder, but
    // only ONE message goes out. A DB outage or an expired credential fails every
    // tier-1 job at once; one message per job would rebuild the 56-warning
    // pathology out of its own fix.
    const due = [];
    for (const t of targets) {
      const key = sweepConditionKey(t);
      const decision = await evaluateAlert({
        scriptName: t.job, tier: 1,
        condition: { key, severity: 'failure', message: t.detail }, now,
        load: (name) => loadOpen(client, 'sweep', name),
        save: (state) => saveState(client, 'sweep', t.job, state),
      });
      if (decision.alert) due.push(t);
    }

    // Jobs that recovered must have their sweep incidents ticked forward too, or
    // the N=2 debounce never clears and the ladder never restarts.
    const unhealthy = new Set(targets.map(t => t.job));
    for (const rec of results) {
      if (rec.tier !== 1 || unhealthy.has(rec.job)) continue;
      await evaluateAlert({
        scriptName: rec.job, tier: 1, condition: null, now,
        load: (name) => loadOpen(client, 'sweep', name),
        save: (state) => saveState(client, 'sweep', rec.job, state),
      });
    }

    const message = renderSweep(due);
    if (!message) {
      console.log(`sweep: ${targets.length} unhealthy, 0 due to alert`);
      return;
    }
    const res = await postAlert(message);
    if (res && res.ok === false) {
      console.error(`sweep: ${due.length} tier-1 job(s) unhealthy — but the Slack post FAILED`);
      process.exitCode = 1;
      return;
    }
    console.log(`sweep: alerted on ${due.length} of ${targets.length} unhealthy tier-1 job(s)`);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------
// HEARTBEAT (Phase 5, spec §4.6 "Proof of life")
//
// Goes out over the WEBHOOK path specifically — postAlert, not postMessage.
// That is the whole point: the webhook is the path tier-1 alerts take, and once
// tier 2 goes quiet nothing else exercises it. A tier-1 alert whose delivery
// failed is simply gone, so the last line of defence has to be tested on a
// schedule rather than assumed.
//
// Dated, so a stale pinned message cannot be mistaken for a fresh one. No
// mention: proof of life is not an interrupt.
// ---------------------------------------------------------------
async function runHeartbeat() {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const res = await postAlert(
    `:green_heart: [HEARTBEAT] alerting webhook alive — ${stamp} UTC. ` +
    `If this stops arriving weekly, tier-1 alerts are not being delivered either.`);
  if (res && res.ok === false) {
    console.error('heartbeat: the webhook path is DOWN — tier-1 alerts would not be delivered');
    process.exitCode = 1;
    return;
  }
  console.log(`heartbeat sent ${stamp} UTC`);
}

// Entry gate. Without this, an unrecognised flag falls straight through to the
// live path and POSTS: dotenv re-injects the token, so unsetting env vars does
// not prevent a post. Same pattern as age-census-report.js. Folds in the
// --dry-run -> SLACK_DRY_RUN mapping that used to run at module load, unguarded
// by require.main (so requiring this file for tests would set it as a side effect).
const ACCEPTED_ARGV = new Set(['--dry-run', '--sweep', '--heartbeat']);
const USAGE = 'Usage: node cron-health-slack.js [--dry-run] [--sweep | --heartbeat]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  }
  if (argv.includes('--dry-run')) process.env.SLACK_DRY_RUN = '1';
  // Separate scriptName so the sweep's own liveness is answerable independently
  // of the digest's — they run on different schedules and can fail separately.
  if (argv.includes('--sweep')) {
    runReporter({ scriptName: 'cron-health-sweep', run: runSweep });
  } else if (argv.includes('--heartbeat')) {
    runReporter({ scriptName: 'alerting-heartbeat', run: runHeartbeat });
  } else {
    runReporter({ scriptName: 'cron-health-slack', run });
  }
}
