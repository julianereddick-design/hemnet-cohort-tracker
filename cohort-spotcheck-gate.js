// cohort-spotcheck-gate.js
//
// Weekly orchestration entrypoint for the cohort-match spot-check QA gate.
// Runs the full deterministic pipeline:
//   1. Resolve latest cohort
//   2. Run cohort-spotcheck.js (field evidence) as a child process
//   3. Run spotcheck-photos.js (photo galleries) as a child process
//   4. Adjudicate pairs (Mode A — deterministic, or Mode B — Claude vision)
//   5. Compute summary + Wilson 95% CI
//   6. Write VERDICTS-<cohort>.json + SUMMARY-<cohort>.md
//   7. Return result_summary to cron-wrapper (logged to cron_job_log)
//
// Escalation: validate() returns a warning string when confirmedMismatchRate >
// threshold (default 5%) OR fetchFailures > 0. cron-wrapper fires SLACK_WEBHOOK_URL
// automatically — NO custom Slack sender needed here.
//
// Mode B (Claude vision): enabled via --mode-b AND ANTHROPIC_API_KEY set.
//   - Vision is called ONLY for suspect/low-signal pairs (cost gate).
//   - When --mode-b is absent OR ANTHROPIC_API_KEY is unset, falls back to Mode A.
//   - lib/spotcheck-vision.js provides adjudicateWithVision.
//
// Usage:
//   node cohort-spotcheck-gate.js [--cohort <id>] [--rate <f>] [--threshold <f>]
//                                  [--conc <n>] [--max <n>] [--mode-b]

'use strict';

const { runJob } = require('./cron-wrapper');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { adjudicatePairs } = require('./lib/spotcheck-adjudicate');
const { computeSummary, renderSlackAlert, renderSummaryMd } = require('./lib/spotcheck-summary');

// ---------------------------------------------------------------
// CLI argument parsing (mirrors cohort-spotcheck.js parseArgs)
// --cohort <id>      — override cohort; default: latest in DB
// --rate <f>         — sampling rate 0-1; default 0.20 (20% weekly sample)
//                      Sized against Oxylabs budget headroom so the >5% gate
//                      is statistically meaningful on ~110+ pairs.
// --threshold <f>    — escalation threshold; default 0.05 (5%)
// --conc <n>         — concurrency for child tools; default 5
// --max <n>          — gallery photo cap per pair; default 6
// --mode-b           — enable Claude vision adjudication (requires ANTHROPIC_API_KEY)
// ---------------------------------------------------------------
function parseArgs(argv) {
  const a = { rate: 0.20, threshold: 0.05, conc: 5, max: 6, modeB: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--cohort') a.cohort = argv[++i];
    else if (t === '--rate') a.rate = parseFloat(argv[++i]);
    else if (t === '--threshold') a.threshold = parseFloat(argv[++i]);
    else if (t === '--conc') a.conc = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (t === '--max') a.max = Math.max(1, parseInt(argv[++i], 10) || 6);
    else if (t === '--mode-b') a.modeB = true;  // enables Claude vision (requires ANTHROPIC_API_KEY)
  }
  if (!Number.isFinite(a.rate) || a.rate <= 0 || a.rate > 1) a.rate = 0.20;
  if (!Number.isFinite(a.threshold) || a.threshold <= 0 || a.threshold > 1) a.threshold = 0.05;
  return a;
}

const args = parseArgs(process.argv);
const ESCALATION_THRESHOLD = args.threshold;

// ---------------------------------------------------------------
// Locate the newest artifact dir written by cohort-spotcheck.js
// for a given cohortId. Returns null if none found.
//
// Mirrors the latestArtifactDir() idiom in spotcheck-photos.js
// but scoped to the specific cohortId (not just any verf-spotcheck dir).
// ---------------------------------------------------------------
function findArtifactDir(cohortId) {
  const prefix = `verf-spotcheck-${cohortId}-`;
  const cwd = process.cwd();
  let dirs;
  try {
    dirs = fs.readdirSync(cwd).filter(
      (d) => d.startsWith(prefix) && fs.statSync(path.join(cwd, d)).isDirectory()
    );
  } catch (_) {
    return null;
  }
  if (dirs.length === 0) return null;
  // Lexically greatest = newest timestamp (format: YYYYmmdd-HHmmss)
  return path.join(cwd, dirs.sort().pop());
}

// ---------------------------------------------------------------
// main(client, log) — receives the cron-wrapper connected pg client
// and structured logger. Returns result_summary plain object.
// ---------------------------------------------------------------
async function main(client, log) {
  // 1. Resolve cohort: --cohort flag or latest by week_start.
  let cohortId = args.cohort;
  if (!cohortId) {
    const r = await client.query('SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1');
    if (r.rows.length === 0) {
      log('WARN', 'No cohorts found in DB — skipping spot-check gate');
      return { skipped: true, reason: 'no cohorts' };
    }
    cohortId = r.rows[0].cohort_id;
  }
  log('INFO', `cohort-spotcheck-gate: cohortId=${cohortId} rate=${args.rate} threshold=${args.threshold} modeB=${args.modeB}`);

  // 2. Run field-evidence tool (cohort-spotcheck.js) as child process.
  //    Uses argv array (NOT shell string) — T-12-04: cohortId from own DB, not user input.
  log('INFO', 'Running cohort-spotcheck.js (field evidence)...');
  execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), 'cohort-spotcheck.js'),
      '--cohort', cohortId,
      '--rate', String(args.rate),
      '--conc', String(args.conc),
    ],
    { stdio: 'inherit', cwd: process.cwd() }
  );

  // 3. Locate the artifact dir just created.
  const artifactDir = findArtifactDir(cohortId);
  if (!artifactDir) {
    throw new Error(`No verf-spotcheck-${cohortId}-* artifact dir found after cohort-spotcheck.js run`);
  }
  log('INFO', `Artifact dir: ${artifactDir}`);

  // 4. Run photo-gallery tool (spotcheck-photos.js) as child process.
  log('INFO', 'Running spotcheck-photos.js (photo galleries)...');
  execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), 'spotcheck-photos.js'),
      artifactDir,
      '--gallery',
      '--all',
      '--max', String(args.max),
      '--conc', String(args.conc),
    ],
    { stdio: 'inherit', cwd: process.cwd() }
  );

  // 5. Read artifact JSON produced by cohort-spotcheck.js (and enriched by
  //    spotcheck-photos.js with photos.hemnet_gallery / booli_gallery arrays).
  const jsonFiles = fs.readdirSync(artifactDir).filter((f) => /^spotcheck-.+\.json$/.test(f));
  if (jsonFiles.length === 0) {
    throw new Error(`No spotcheck-*.json found in ${artifactDir}`);
  }
  const jsonPath = path.join(artifactDir, jsonFiles[0]);
  const artifact = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  // 6. Count fetch failures: pairs where Hemnet re-fetch failed.
  //    The meta.hemnet.error counter is the authoritative source; fall back to
  //    counting individual pair hemnet.status === 'error' entries.
  let fetchFailures = 0;
  if (artifact.meta && artifact.meta.hemnet && typeof artifact.meta.hemnet.error === 'number') {
    fetchFailures = artifact.meta.hemnet.error;
  } else if (Array.isArray(artifact.pairs)) {
    fetchFailures = artifact.pairs.filter(
      (p) => p.hemnet && p.hemnet.status === 'error'
    ).length;
  }
  log('INFO', `Fetch failures: ${fetchFailures}`);

  // 7. Adjudicate pairs — Mode A (deterministic) or Mode B (Claude vision).
  //    Mode B is engaged ONLY when --mode-b is passed AND ANTHROPIC_API_KEY is set.
  //    Without either, the gate runs Mode A unchanged (graceful fallback).
  //
  //    COST GATE (T-12-11): vision is called only for pairs the deterministic triage
  //    flagged as needing it (provisional === 'suspect' or 'low-signal').
  //    likely-match pairs with price+photos already resolved are NEVER sent to the API.
  let visionResults = undefined;
  let adjudicationMode = 'mode-a-human';
  if (args.modeB && process.env.ANTHROPIC_API_KEY) {
    const { adjudicateWithVision } = require('./lib/spotcheck-vision');
    adjudicationMode = 'mode-b-vision';
    visionResults = {};
    // COST GATE: only pairs the deterministic triage flagged need the model.
    const needVision = (artifact.pairs || []).filter(
      (p) => p.provisional === 'suspect' || p.provisional === 'low-signal'
    );
    log('INFO', `mode-b: ${needVision.length} pair(s) need vision (of ${(artifact.pairs || []).length})`);
    for (const p of needVision) {
      const vr = await adjudicateWithVision(p, { artifactDir });
      if (vr) visionResults[p.pair_id] = vr;
    }
  } else if (args.modeB) {
    log('WARN', 'mode-b requested but ANTHROPIC_API_KEY not set — falling back to Mode A');
  }
  const verdicts = adjudicatePairs(artifact.pairs || [], { visionResults });
  log('INFO', `Adjudicated ${verdicts.length} pairs (${adjudicationMode})`);

  // 8. Compute summary (rate + Wilson CI + by-county + mismatch list).
  const summary = computeSummary(verdicts);
  log('INFO', `Rate: ${(summary.confirmedMismatchRate * 100).toFixed(2)}% (${summary.confirmedMismatch}/${summary.confirmedMatch + summary.confirmedMismatch}) UNCERTAIN=${summary.uncertain}`);

  // 9. Write VERDICTS-<cohortId>.json and SUMMARY-<cohortId>.md into the artifact dir.
  const generatedAt = new Date().toISOString();

  const verdictsPath = path.join(artifactDir, `VERDICTS-${cohortId}.json`);
  fs.writeFileSync(
    verdictsPath,
    JSON.stringify(
      {
        cohortId,
        adjudicationMode,
        generated_at: generatedAt,
        summary,
        pairs: verdicts,
      },
      null,
      2
    )
  );

  const summaryMdPath = path.join(artifactDir, `SUMMARY-${cohortId}.md`);
  fs.writeFileSync(summaryMdPath, renderSummaryMd(summary, cohortId));

  log('INFO', `Wrote:\n  ${verdictsPath}\n  ${summaryMdPath}`);

  // 10. Build escalation message (passed through validate() → cron-wrapper Slack path).
  const slackMsg = renderSlackAlert(summary, cohortId);

  // 11. Return result_summary (logged to cron_job_log.result_summary).
  return {
    cohortId,
    sampled: summary.sampled,
    confirmedMatch: summary.confirmedMatch,
    confirmedMismatch: summary.confirmedMismatch,
    uncertain: summary.uncertain,
    confirmedMismatchRate: summary.confirmedMismatchRate,
    wilsonLo: summary.wilsonLo,
    wilsonHi: summary.wilsonHi,
    fetchFailures,
    artifactDir,
    adjudicationMode,
    threshold: ESCALATION_THRESHOLD,
    slackMsg,
    skipped: false,
  };
}

// ---------------------------------------------------------------
// Wire runJob (mirrors cohort-create.js lines 224-237).
// validate() returns a non-null string on:
//   - fetch failures (> 0 Hemnet errors during the run)
//   - confirmed false-match rate exceeds ESCALATION_THRESHOLD
// cron-wrapper's existing Slack path fires on any non-null string —
// NO custom Slack sender needed in this file. T-12-05 satisfied.
// ---------------------------------------------------------------
runJob({
  scriptName: 'cohort-spotcheck-gate',
  main,
  validate: (summary) => {
    if (!summary || summary.skipped) return null;
    if (summary.fetchFailures > 0) {
      return `${summary.fetchFailures} fetch failure(s) during spot-check gate (cohort ${summary.cohortId})`;
    }
    if (summary.confirmedMismatchRate > summary.threshold) {
      return summary.slackMsg;
    }
    return null;
  },
});
