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
//   - Vision is called ONLY for `suspect` pairs (cost gate; see WR-01 note in main).
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
const { adjudicatePairs, adjudicatePair } = require('./lib/spotcheck-adjudicate');
const { computeSummary, renderSlackAlert, renderSummaryMd } = require('./lib/spotcheck-summary');
const { sharedPhotoPairs, filterDiscriminating } = require('./lib/spotcheck-dhash');
const { postReviewMessage, postDigestMessage } = require('./lib/spotcheck-slack-bot');
const { upsertReviewMessage } = require('./lib/spotcheck-review-store');

// ---------------------------------------------------------------
// isoWeekId(date) — ISO-8601 week identifier (Thursday-anchored).
// Returns the same format as cohorts.cohort_id, e.g. '2026-W24'.
// D-13: used to guard against silently re-running on a stale cohort.
// ---------------------------------------------------------------
function isoWeekId(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;          // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);  // shift to Thursday of this ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------
// CLI argument parsing (mirrors cohort-spotcheck.js parseArgs)
// --cohort <id>      — override cohort; default: latest in DB
// --rate <f>         — sampling rate 0-1; default 0.20 (20% weekly sample)
//                      Sized against Oxylabs budget headroom so the >5% gate
//                      is statistically meaningful on ~110+ pairs.
// --threshold <f>    — escalation threshold; default 0.05 (5%)
// --conc <n>         — concurrency for child tools; default 5
// --max <n>          — gallery photo cap per pair; default 20 (Phase 14 probe:
//                      119 of 246 shared-photo pairs had their best match BEYOND
//                      the old cap of 6; 25 sat at position 18+. Images are
//                      CDN-direct (no Oxylabs cost) — only hash time.)
// --mode-b / --mode-a — vision adjudication on residue pairs. Phase 14 (D-13):
//                      DEFAULT ON when ANTHROPIC_API_KEY is set (the prod cron
//                      line carries no flags, so the default governs); --mode-a
//                      forces deterministic-only.
// ---------------------------------------------------------------
function parseArgs(argv) {
  const a = { rate: 0.20, threshold: 0.05, conc: 5, max: 20, modeB: true };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--cohort') a.cohort = argv[++i];
    else if (t === '--rate') a.rate = parseFloat(argv[++i]);
    else if (t === '--threshold') a.threshold = parseFloat(argv[++i]);
    else if (t === '--conc') a.conc = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (t === '--max') a.max = Math.max(1, parseInt(argv[++i], 10) || 6);
    else if (t === '--mode-b') a.modeB = true;
    else if (t === '--mode-a') a.modeB = false;  // deterministic-only override
  }
  if (!Number.isFinite(a.rate) || a.rate <= 0 || a.rate > 1) a.rate = 0.20;
  // WR-03: allow --threshold 0 ("always escalate", a valid test value); only reject < 0 or > 1.
  if (!Number.isFinite(a.threshold) || a.threshold < 0 || a.threshold > 1) a.threshold = 0.05;
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

  // D-13: current-ISO-week guard. cohort-create runs Mon 06:00 UTC, the gate Mon 06:30 UTC; if
  // this week's cohort isn't created yet, do NOT silently re-check last week's cohort — skip+alert.
  // Only guard AUTO-resolution — an explicit --cohort is an operator override and must run.
  if (!args.cohort) {
    const currentIsoWeek = isoWeekId(new Date());
    if (cohortId !== currentIsoWeek) {
      const reason = `resolved cohort ${cohortId} != current ISO week ${currentIsoWeek} — this week's cohort not created yet?`;
      log('WARN', `cohort-spotcheck-gate: ${reason} — skipping`);
      return { skipped: true, staleCohort: true, reason, cohortId, currentIsoWeek,
               slackMsg: `[WARNING] cohort-spotcheck-gate skipped: ${reason}` };
    }
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
  // WR-04: a write-interrupted/corrupt artifact would otherwise throw a context-free
  // SyntaxError. Wrap with the file path and validate the pairs shape we rely on.
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse spot-check artifact ${jsonPath}: ${err.message}`);
  }
  if (!Array.isArray(artifact.pairs)) {
    throw new Error(`Spot-check artifact ${jsonPath} has no pairs[] array`);
  }

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

  // 6a-bis. Multi-unit address set (Phase 14 D-05/D-09): one cheap read-only query
  //     over the FULL cohort — any (street, postcode) with >1 pair this week is a
  //     multi-unit risk. Stamped onto each sampled pair for the adjudicator/report.
  const muRes = await client.query(
    `SELECT LOWER(TRIM(street_address)) AS addr, postcode
     FROM cohort_pairs WHERE cohort_id = $1
     GROUP BY LOWER(TRIM(street_address)), postcode HAVING COUNT(*) > 1`,
    [cohortId]
  );
  const multiUnitAddrs = new Set(muRes.rows.map((r) => `${r.addr}|${r.postcode}`));
  for (const p of (artifact.pairs || [])) {
    p.isMultiUnit = multiUnitAddrs.has(`${String(p.street_address || '').toLowerCase().trim()}|${p.postcode}`);
  }
  log('INFO', `multi-unit addresses in cohort: ${multiUnitAddrs.size}; flagged sampled pairs: ${(artifact.pairs || []).filter((p) => p.isMultiUnit).length}`);

  // 6b. dHash photo-correspondence (Phase 14 D-02/D-05/D-10). For each pair with both
  //     galleries: exclude non-discriminating images (floorplan/render/map labels on
  //     either platform), then find ALL shared scenes within DHASH_THRESHOLD with a
  //     distinct-scene dedup. confirmed = >=2 distinct shared scenes (>=1 when either
  //     filtered side has <=2 images — tiny-gallery relaxation). The result is an
  //     INPUT to adjudicatePair — there is no post-verdict promotion loop any more.
  const DHASH_THRESHOLD = parseInt(process.env.DHASH_THRESHOLD || '6', 10);
  const dhashResults = {};
  for (const p of (artifact.pairs || [])) {
    const photos = p.photos || {};
    const bAll = (photos.booli_gallery  || []);
    const hAll = (photos.hemnet_gallery || []);
    if (bAll.length === 0 || hAll.length === 0) {
      log('INFO', `dHash pair ${p.pair_id}: skipped (no gallery on one side)`);
      continue;
    }
    const bUse = filterDiscriminating(bAll);
    const hUse = filterDiscriminating(hAll);
    const excluded = (bAll.length - bUse.length) + (hAll.length - hUse.length);
    if (bUse.length === 0 || hUse.length === 0) {
      dhashResults[p.pair_id] = { minDist: 64, confirmed: false, sharedCount: 0, threshold: DHASH_THRESHOLD, excluded };
      p.dhash = dhashResults[p.pair_id];
      log('INFO', `dHash pair ${p.pair_id}: only non-discriminating images on one side (excluded=${excluded}) — no photo signal`);
      continue;
    }
    const r = await sharedPhotoPairs(
      bUse.map((g) => path.join(artifactDir, g.file)),
      hUse.map((g) => path.join(artifactDir, g.file)),
      DHASH_THRESHOLD
    );
    const needed = (bUse.length <= 2 || hUse.length <= 2) ? 1 : 2;
    const confirmed = r.sharedCount >= needed;
    dhashResults[p.pair_id] = { minDist: r.minDist, confirmed, sharedCount: r.sharedCount, needed, threshold: DHASH_THRESHOLD, excluded };
    p.dhash = dhashResults[p.pair_id];  // persisted into VERDICTS json
    log('INFO', `dHash pair ${p.pair_id}: minDist=${r.minDist} sharedScenes=${r.sharedCount}/${needed} excludedImgs=${excluded} ${confirmed ? 'PHOTO-CONFIRMED' : 'no-photo-signal'}`);
  }

  // 7. Adjudicate pairs — Mode A (deterministic) or Mode B (Claude vision).
  //    Mode B is engaged ONLY when --mode-b is passed AND ANTHROPIC_API_KEY is set.
  //    Without either, the gate runs Mode A unchanged (graceful fallback).
  //
  //    COST GATE (T-12-11 / WR-01): vision is called only for `suspect` pairs.
  //    likely-match pairs are already resolved; low-signal pairs can only ever be
  //    UNCERTAIN (Booli fields null → price never agrees) — neither is sent to the API.
  // 7. Adjudicate (Phase 14 identity model). FIRST PASS without vision finds the
  //    residue; vision then runs only on residue pairs per the routing rule; the
  //    FINAL pass feeds fee/floor fields + dHash + vision into adjudicatePair.
  //
  //    ROUTING (D-13, sized by the 14-01 probe): vision is spent on first-pass
  //    UNCERTAIN pairs that (a) have usable galleries on both sides and (b) have
  //    an agreeing price — exactly the old Branch-2 population that no longer
  //    free-confirms. Cap via VISION_MAX_CALLS (cost ceiling per run).
  const VISION_MAX_CALLS = parseInt(process.env.VISION_MAX_CALLS || '60', 10);
  let visionResults = undefined;
  let adjudicationMode = 'mode-a-deterministic';
  const firstPass = {};
  for (const p of (artifact.pairs || [])) {
    firstPass[p.pair_id] = adjudicatePair(p, { dhashResult: dhashResults[p.pair_id] });
  }
  if (args.modeB && process.env.ANTHROPIC_API_KEY) {
    const { adjudicateWithVision } = require('./lib/spotcheck-vision');
    adjudicationMode = 'mode-b-vision';
    visionResults = {};
    // WR-02: log the resolved model so a future deprecation is visible in cron logs.
    log('INFO', `mode-b model: ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6 (default)'}`);
    const candidates = (artifact.pairs || []).filter((p) => {
      const fp = firstPass[p.pair_id];
      if (!fp || fp.verdict !== 'UNCERTAIN') return false;
      const priceAgrees = p.deltas && p.deltas.price_pct_diff != null && p.deltas.price_pct_diff <= 0.05;
      const hasGalleries = (p.photos?.hemnet_gallery?.length > 0) && (p.photos?.booli_gallery?.length > 0);
      return priceAgrees && hasGalleries;
    });
    const needVision = candidates.slice(0, VISION_MAX_CALLS);
    if (candidates.length > needVision.length) {
      log('WARN', `mode-b: ${candidates.length} vision candidates capped at VISION_MAX_CALLS=${VISION_MAX_CALLS} — ${candidates.length - needVision.length} stay UNCERTAIN this run`);
    }
    log('INFO', `mode-b: ${needVision.length} residue pair(s) routed to vision (of ${(artifact.pairs || []).length} sampled)`);
    for (const p of needVision) {
      const vr = await adjudicateWithVision(p, { artifactDir });
      if (vr) {
        visionResults[p.pair_id] = vr;
        p.vision = { sharedPhoto: vr.sharedPhoto, confidence: vr.confidence, reasoning: vr.reasoning };
        log('INFO', `vision pair ${p.pair_id}: sharedPhoto=${vr.sharedPhoto} conf=${vr.confidence}`);
      }
    }
  } else if (args.modeB) {
    log('INFO', 'vision unavailable (ANTHROPIC_API_KEY not set) — deterministic only');
  }

  const verdicts = adjudicatePairs(artifact.pairs || [], { visionResults, dhashResults });

  // D-04: photo evidence disagreeing with a field-confirmed MATCH is surfaced,
  // never silently discarded.
  for (const v of verdicts) {
    if (v.verdict_challenge) {
      log('WARN', `pair ${v.pair_id}: CONFIRMED_MATCH challenged by photos — ${v.verdict_challenge} (${v.verdict_reason})`);
    }
  }

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

  // 9b. Slack review queue (D-07): weekly digest of UNCERTAIN pairs + one message per CONFIRMED_MISMATCH.
  //     Each posted message ref is persisted (channel, ts, pair_id, cohort, vision verdict) so the
  //     daily poller (spotcheck-reaction-poller.js) can read reactions and apply human verdicts.
  const botToken = process.env.SLACK_BOT_TOKEN;
  const reviewChannel = process.env.SLACK_REVIEW_CHANNEL;
  if (botToken && reviewChannel) {
    const uncertainPairs = verdicts.filter(v => v.verdict === 'UNCERTAIN');
    const mismatchPairs  = verdicts.filter(v => v.verdict === 'CONFIRMED_MISMATCH');

    if (uncertainPairs.length > 0) {
      const res = await postDigestMessage(reviewChannel, uncertainPairs);
      if (res && res.ts) {
        for (const p of uncertainPairs) {
          await upsertReviewMessage(client, {
            pairId: p.pair_id, cohortId, channel: reviewChannel, ts: res.ts,
            visionVerdict: p.vision ? (p.vision.sharedPhoto === false ? 'MISMATCH' : p.vision.sharedPhoto === true ? 'MATCH' : null) : null,
          });
        }
      }
    }
    for (const p of mismatchPairs) {
      const res = await postReviewMessage(reviewChannel, p);
      if (res && res.ts) {
        await upsertReviewMessage(client, {
          pairId: p.pair_id, cohortId, channel: reviewChannel, ts: res.ts, visionVerdict: 'MISMATCH',
        });
      }
    }
    log('INFO', `review queue: ${uncertainPairs.length} UNCERTAIN (digest) + ${mismatchPairs.length} MISMATCH (individual) posted`);
  } else {
    log('INFO', 'review queue: SLACK_BOT_TOKEN/SLACK_REVIEW_CHANNEL not set — skipping Slack post (verdicts still written)');
  }

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
    if (!summary) return null;
    if (summary.skipped) return summary.staleCohort ? summary.slackMsg : null;
    if (summary.fetchFailures > 0) {
      return `${summary.fetchFailures} fetch failure(s) during spot-check gate (cohort ${summary.cohortId})`;
    }
    if (summary.confirmedMismatchRate > summary.threshold) {
      return summary.slackMsg;
    }
    return null;
  },
});
