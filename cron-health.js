const { createClient } = require('./db');

const SCRIPTS = ['cohort-track', 'cohort-create', 'age-census-monthly'];

// Expected schedule: how often each script should run.
// sfpl-region-snapshot was RETIRED 2026-08-13 (removed from the droplet crontab, no
// consumer) and dropped from this list 2026-08-14 — it was reporting a standing
// "No runs found" issue for a job that is meant not to run.
const EXPECTED = {
  'cohort-track': { frequency: 'daily', label: 'Daily' },
  'cohort-create': { frequency: 'weekly', label: 'Weekly (Mon)' },
  // First fire 02:00 UTC 2026-09-01; `notBefore` suppresses the not-yet-due window.
  'age-census-monthly': { frequency: 'monthly', label: 'Monthly (1st)', notBefore: '2026-09-02' },
};

// A monthly job's last run can be 31 days old on a healthy system, so the query window
// must cover it regardless of --days (which defaults to 7).
const MIN_LOOKBACK_DAYS = 35;

function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ts) {
  if (!ts) return '-';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function summarizeResult(scriptName, summary) {
  if (!summary) return '-';
  switch (scriptName) {
    case 'cohort-track': {
      let s = `tracked=${summary.totalTracked || 0} cohorts=${summary.cohortsTracked || 0}`;
      if (summary.perCohortNull) {
        for (const c of summary.perCohortNull) {
          const bPct = Math.round((c.nullBooli / c.tracked) * 100);
          const hPct = Math.round((c.nullHemnet / c.tracked) * 100);
          s += `\n      ${c.cohortId}: null_b=${c.nullBooli}(${bPct}%) null_h=${c.nullHemnet}(${hPct}%)`;
        }
      } else if (summary.totalNullBooli || summary.totalNullHemnet) {
        s += ` null_b=${summary.totalNullBooli || 0} null_h=${summary.totalNullHemnet || 0}`;
      }
      return s;
    }
    case 'cohort-create':
      if (summary.skipped) return `skipped (${summary.cohortId} exists)`;
      return `${summary.cohortId} matched=${summary.matched || 0} unmatched=${summary.unmatched || 0} rate=${summary.matchRate || '-'}`;
    case 'age-census-monthly': {
      const persisted = summary.persisted != null ? summary.persisted : '?';
      let s = `${persisted}/4 pools persisted`;
      if (summary.pools) {
        s += '\n      ' + summary.pools
          .map(p => `${p.platform}:${p.pool}=${p.status}${p.nTotal != null ? ` n=${p.nTotal}` : ''}`)
          .join('  ');
      }
      if (summary.gateFailed && summary.gateFailed.length) s += `\n      gate_failed: ${summary.gateFailed.join(', ')}`;
      if (summary.failed && summary.failed.length) s += `\n      failed: ${summary.failed.join(', ')}`;
      return s;
    }
    default:
      return JSON.stringify(summary);
  }
}

async function run() {
  const daysArg = process.argv.indexOf('--days');
  const lookbackDays = daysArg !== -1 ? parseInt(process.argv[daysArg + 1]) || 7 : 7;

  const client = createClient();
  await client.connect();

  // Check if cron_job_log table exists
  const tableCheck = await client.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'cron_job_log'
  `);
  if (tableCheck.rows.length === 0) {
    console.log('ERROR: cron_job_log table does not exist. Run: node cron-setup.js');
    await client.end();
    process.exit(1);
  }

  const rows = await client.query(`
    SELECT id, script_name, started_at, finished_at, duration_ms, status, error_message, result_summary
    FROM cron_job_log
    WHERE started_at >= NOW() - INTERVAL '1 day' * $1
    ORDER BY started_at DESC
  `, [Math.max(lookbackDays, MIN_LOOKBACK_DAYS)]);

  const issues = [];

  // Group by script
  const byScript = {};
  for (const s of SCRIPTS) byScript[s] = [];
  for (const r of rows.rows) {
    if (byScript[r.script_name]) {
      byScript[r.script_name].push(r);
    }
  }

  // Display runs per script
  for (const scriptName of SCRIPTS) {
    const runs = byScript[scriptName];
    const spec = EXPECTED[scriptName];
    console.log(`\n=== ${scriptName} (${spec.label}) ===`);

    if (runs.length === 0) {
      // Deployed but not yet due (see EXPECTED.notBefore) is pending, not broken.
      if (spec.notBefore && new Date().toISOString().slice(0, 10) < spec.notBefore) {
        console.log(`  Deployed, no runs yet — first run due ${spec.notBefore}`);
        continue;
      }
      console.log('  No runs found in the last ' + lookbackDays + ' days');
      issues.push(`No runs found for ${scriptName} in the last ${lookbackDays} days`);
      continue;
    }

    // Show last 5 runs
    const display = runs.slice(0, 5);
    for (const r of display) {
      const statusIcon = r.status === 'success' ? 'OK' : r.status === 'warning' ? 'WARN' : 'FAIL';
      const line = `  ${formatTimestamp(r.started_at)}  ${statusIcon.padEnd(4)}  ${formatDuration(r.duration_ms).padEnd(8)}  ${summarizeResult(scriptName, r.result_summary)}`;
      console.log(line);
      if (r.error_message) {
        console.log(`    -> ${r.error_message}`);
      }
    }

    // Check for failures/warnings
    for (const r of runs) {
      if (r.status === 'failure') {
        issues.push(`${scriptName} FAILED at ${formatTimestamp(r.started_at)}: ${r.error_message}`);
      }
      if (r.status === 'warning') {
        issues.push(`${scriptName} WARNING at ${formatTimestamp(r.started_at)}: ${r.error_message}`);
      }
    }

    // Check for missing daily runs (last 3 days)
    if (spec.frequency === 'daily') {
      for (let d = 0; d < Math.min(3, lookbackDays); d++) {
        const checkDate = new Date();
        checkDate.setUTCDate(checkDate.getUTCDate() - d);
        const dateStr = checkDate.toISOString().slice(0, 10);

        const hasRun = runs.some(r => {
          const runDate = new Date(r.started_at).toISOString().slice(0, 10);
          return runDate === dateStr && r.status !== 'failure';
        });

        if (!hasRun) {
          // Don't flag today if it's early in the day
          if (d === 0) continue;
          issues.push(`No successful ${scriptName} run on ${dateStr}`);
        }
      }
    }

    // Check for missing weekly runs (cohort-create)
    if (spec.frequency === 'weekly') {
      const lastSuccess = runs.find(r => r.status === 'success' || r.status === 'warning');
      if (lastSuccess) {
        const daysSince = (Date.now() - new Date(lastSuccess.started_at)) / 86400000;
        if (daysSince > 8) {
          issues.push(`Last successful ${scriptName} was ${Math.floor(daysSince)} days ago (expected weekly)`);
        }
      }
    }

    // Check for a missed monthly run. 31 days is the longest healthy gap (Jan->Feb etc.),
    // so 33 gives two days of grace before flagging — long enough to absorb a same-day
    // re-run, short enough to catch a cron that stopped firing.
    if (spec.frequency === 'monthly') {
      const lastSuccess = runs.find(r => r.status === 'success' || r.status === 'warning');
      if (lastSuccess) {
        const daysSince = (Date.now() - new Date(lastSuccess.started_at)) / 86400000;
        if (daysSince > 33) {
          issues.push(`Last successful ${scriptName} was ${Math.floor(daysSince)} days ago (expected monthly, on the 1st)`);
        }
      }
    }

    // Check result anomalies
    const lastSuccess = runs.find(r => r.status === 'success' && r.result_summary);
    if (lastSuccess && lastSuccess.result_summary) {
      const s = lastSuccess.result_summary;
      if (scriptName === 'cohort-track' && s.totalTracked === 0 && s.cohortsTracked > 0) {
        issues.push(`${scriptName}: last success tracked 0 pairs with ${s.cohortsTracked} active cohorts`);
      }
      if (scriptName === 'cohort-track' && s.perCohortNull) {
        for (const c of s.perCohortNull) {
          const bPct = Math.round((c.nullBooli / c.tracked) * 100);
          const hPct = Math.round((c.nullHemnet / c.tracked) * 100);
          if (bPct > 50) issues.push(`${scriptName}: ${c.cohortId} has ${bPct}% null Booli views (${c.nullBooli}/${c.tracked})`);
          if (hPct > 50) issues.push(`${scriptName}: ${c.cohortId} has ${hPct}% null Hemnet views (${c.nullHemnet}/${c.tracked})`);
        }
      } else if (scriptName === 'cohort-track' && s.totalTracked > 0) {
        // Fallback for older log entries without perCohortNull
        const nullBooliPct = Math.round(((s.totalNullBooli || 0) / s.totalTracked) * 100);
        const nullHemnetPct = Math.round(((s.totalNullHemnet || 0) / s.totalTracked) * 100);
        if (nullBooliPct > 50) issues.push(`${scriptName}: ${nullBooliPct}% of pairs had null Booli views`);
        if (nullHemnetPct > 50) issues.push(`${scriptName}: ${nullHemnetPct}% of pairs had null Hemnet views`);
      }
      // Age-census: 4 pools must persist. Fewer means a pool failed outright; a pool whose
      // gates failed still persists, so `gateFailed` is reported separately rather than
      // reducing the count.
      if (scriptName === 'age-census-monthly') {
        if (s.persisted != null && s.persisted < 4) {
          issues.push(`${scriptName}: only ${s.persisted}/4 pools persisted (failed: ${(s.failed || []).join(', ') || 'unknown'})`);
        }
        if (s.gateFailed && s.gateFailed.length) {
          issues.push(`${scriptName}: validation gates failed for ${s.gateFailed.join(', ')} — numbers stored but not trustworthy`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  if (issues.length === 0) {
    console.log('All OK — no issues found');
  } else {
    console.log(`${issues.length} issue(s) found:\n`);
    for (const issue of issues) {
      console.log(`  ! ${issue}`);
    }
  }

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
