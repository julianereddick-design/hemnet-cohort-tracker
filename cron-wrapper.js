const { createClient } = require('./db');
const { postAlert } = require('./lib/slack-post');
const { tierOf } = require('./lib/job-registry');

function makeLogger(scriptName) {
  return function log(level, message) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${scriptName}: ${message}`;
    if (level === 'ERROR') {
      console.error(line);
    } else {
      console.log(line);
    }
  };
}

async function connectWithRetry(client, log, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.connect();
      return;
    } catch (err) {
      log('ERROR', `DB connect attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// buildAlertText(scriptName, label, message, tier) — PURE alert renderer.
//
// Tier 1 and the daily digest share one channel by operator decision. Slack
// notifies on MENTIONS, not on channels, so the mention is what gives the
// two-channel effect inside one channel at no cost — and it is the only thing
// separating "a perishable observation was just lost forever" from "a report
// is late". Everything else keeps today's exact `[LABEL] text` shape.
//
// <!channel> is the escaped form Slack resolves without needing link_names on
// the webhook payload, which `@channel` as plain text would.
//
// tier === null means the job is not in lib/job-registry.js. That alerts AND
// names the gap: defaulting it to tier 2 would silence a newly added
// perishable job, which is precisely what the registry exists to prevent.
function buildAlertText(scriptName, label, message, tier) {
  if (tier === 2) return `[${label}] ${message}`;
  const gap = tier == null
    ? ` (job "${scriptName}" is not in lib/job-registry.js — add it with an explicit tier)`
    : '';
  return `🚨 TIER1 <!channel> [${label}] ${message}${gap}`;
}

// makeFatalHandlers({ scriptName, log, recoverRow, alert, exit })
//
// The process-level death handlers, behind injected deps so their ordering is
// testable offline (they are registered on `process`, so a test can never reach
// the real ones). Each step is individually guarded: a throwing alert must not
// strand the log row at 'running', and a hung DB must not eat the alert.
function makeFatalHandlers({ scriptName, log, recoverRow, alert, exit }) {
  let shuttingDown = false;

  async function die(rowStatus, logLevel, logMessage, alertMessage, rowMessage) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(logLevel, logMessage);
    try {
      await alert(rowStatus, alertMessage);
    } catch (e) {
      log('ERROR', `Slack alert failed: ${e.message}`);
    }
    try {
      await recoverRow(rowStatus, rowMessage);
    } catch (e) {
      log('ERROR', `Recovery UPDATE failed: ${e.message}`);
    }
    exit(1);
  }

  const handleFatal = (err) => {
    const text = String((err && (err.message || err)) || 'unknown');
    return die('failure', 'ERROR', `Uncaught: ${text}`, `${scriptName}: ${text}`, text);
  };

  const handleSignal = (sig) =>
    die('killed', 'WARN', `Received ${sig} — marking cron_job_log row killed`,
        `${scriptName}: killed by ${sig}`, `killed by ${sig}`);

  return { handleFatal, handleSignal };
}

async function runJob({ scriptName, main, validate }) {
  const log = makeLogger(scriptName);
  const startTime = Date.now();
  let client;
  let logId;
  let status = 'success';
  let errorMessage = null;
  let resultSummary = null;

  // Best-effort UPDATE on cron_job_log when the process is going down unexpectedly.
  // Uses a fresh client because the main `client` may be mid-query (concurrent queries
  // on one node-pg client throw "another query is already in progress").
  async function recoverRow(rowStatus, rowError) {
    if (!logId) return;
    const recoveryClient = createClient();
    try {
      await recoveryClient.connect();
      await recoveryClient.query(
        `UPDATE cron_job_log SET finished_at = NOW(), duration_ms = $1, status = $2, error_message = $3 WHERE id = $4 AND status = 'running'`,
        [Date.now() - startTime, rowStatus, rowError, logId]
      );
    } catch (e) {
      log('ERROR', `Recovery UPDATE failed: ${e.message}`);
    } finally {
      try { await recoveryClient.end(); } catch (_) { /* best effort */ }
    }
  }

  // The single alert path. Both the normal try/catch below and the fatal/signal
  // handlers go through here, so there is exactly one place that decides what an
  // alert looks like.
  //
  // postAlert signals failure by RETURNING {ok:false}, but can also REJECT:
  // webhookPostMessage calls new URL(webhookUrl) synchronously inside an async
  // function, so a malformed SLACK_WEBHOOK_URL (a scheme dropped in an .env edit)
  // rejects. Unguarded, that rejection would escape as an unhandledRejection for
  // every one of the ~13 jobs routed through runJob.
  async function sendAlert(label, message) {
    const text = buildAlertText(scriptName, label, message, tierOf(scriptName));
    try {
      const res = await postAlert(text);
      log(res.ok ? 'INFO' : 'ERROR', res.ok ? 'Slack alert sent' : 'Slack alert failed');
    } catch (err) {
      log('ERROR', `Slack alert failed: ${err.message}`);
    }
  }

  // Process-level safety.
  //
  // Until 2026-08, these handlers called recoverRow() then process.exit(1) and
  // never reached the alert — so uncaught exceptions, unhandled rejections and
  // SIGTERM/SIGHUP/SIGINT (including OOM kills on the ~3h age census) wrote a
  // log row and alerted NOBODY. That made "tier 1 interrupts immediately" false
  // for exactly the failure modes that kill long-running jobs.
  //
  // Order is deliberate: alert FIRST. recoverRow opens a second DB connection,
  // so if the DB is what broke it can block until statement_timeout — and a
  // SIGKILL may land before we get to the part a human actually sees.
  const handlers = makeFatalHandlers({
    scriptName,
    log,
    recoverRow,
    alert: (rowStatus, message) => sendAlert(rowStatus === 'killed' ? 'KILLED' : 'FAILURE', message),
    exit: (code) => process.exit(code),
  });
  process.on('uncaughtException', handlers.handleFatal);
  process.on('unhandledRejection', handlers.handleFatal);
  process.on('SIGHUP', () => handlers.handleSignal('SIGHUP'));
  process.on('SIGTERM', () => handlers.handleSignal('SIGTERM'));
  process.on('SIGINT', () => handlers.handleSignal('SIGINT'));

  try {
    client = createClient();
    await connectWithRetry(client, log);
    log('INFO', 'Connected to DB');

    await client.query("SET statement_timeout = '120000'");

    // Insert running log row
    const logRes = await client.query(
      `INSERT INTO cron_job_log (script_name, started_at, status) VALUES ($1, NOW(), 'running') RETURNING id`,
      [scriptName]
    );
    logId = logRes.rows[0].id;

    // Run the main logic
    resultSummary = await main(client, log);

    // Validate result
    if (validate) {
      const warning = validate(resultSummary);
      if (warning) {
        status = 'warning';
        errorMessage = warning;
        log('WARN', warning);
      }
    }
  } catch (err) {
    status = 'failure';
    errorMessage = err.message;
    log('ERROR', err.message);
  }

  // Update log row
  try {
    if (client && logId) {
      await client.query(
        `UPDATE cron_job_log SET finished_at = NOW(), duration_ms = $1, status = $2, error_message = $3, result_summary = $4 WHERE id = $5`,
        [Date.now() - startTime, status, errorMessage, resultSummary ? JSON.stringify(resultSummary) : null, logId]
      );
    }
  } catch (err) {
    log('ERROR', `Failed to update job log: ${err.message}`);
  }

  // Slack alert on failure/warning. Webhook only, by design — see lib/slack-post.js postAlert.
  if (status === 'failure' || status === 'warning') {
    await sendAlert(status === 'failure' ? 'FAILURE' : 'WARNING', `${scriptName}: ${errorMessage}`);
  }

  // Cleanup
  try {
    if (client) await client.end();
  } catch (_) { /* best effort */ }

  log('INFO', `Finished with status: ${status} (${Date.now() - startTime}ms)`);
  process.exit(status === 'failure' ? 1 : 0);
}

// buildReporterMain(scriptName, run) — the pure inner half of runReporter,
// exported so the exitCode bridge is testable without a DB.
//
// The seven reporters wrapped in Phase 1 are self-contained: each opens its own
// client and signals a FAILED Slack delivery by setting process.exitCode = 1 and
// continuing, rather than by throwing. (That contract is asserted by
// lib/slack-post.js --smoke, so it must not be removed.) Without this bridge a
// lost report would still be recorded as a `success` row.
//
// Only a transition to 1 DURING run() counts — a value already set before the
// run began belongs to something else and must not be blamed on this job.
function buildReporterMain(scriptName, run) {
  return async function main(_client, _log) {
    const before = process.exitCode;
    await run();
    const after = process.exitCode;
    if (after === 1 && before !== 1) {
      throw new Error(
        `${scriptName}: reporter set process.exitCode=1 — Slack delivery failed (see the log above)`
      );
    }
    return { reporter: true, exitCode: after == null ? 0 : after };
  };
}

// runReporter({ scriptName, run }) — wrap a legacy self-contained reporter in
// runJob without touching its body. It keeps its own DB client; runJob's client
// is used only for the cron_job_log row, which also means runJob's 120s
// statement_timeout does not constrain the reporter's own heavy queries.
function runReporter({ scriptName, run }) {
  return runJob({ scriptName, main: buildReporterMain(scriptName, run) });
}

module.exports = { runJob, makeFatalHandlers, buildAlertText, runReporter, buildReporterMain };

// ---------------------------------------------------------------
// --smoke self-test (offline: no network, no DB, no Slack, no exit)
//   node cron-wrapper.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { makeFatalHandlers } = module.exports;
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  function spy() {
    const calls = [];
    return {
      calls,
      log: (level, msg) => calls.push(['log', level, msg]),
      recoverRow: async (s, m) => { calls.push(['recoverRow', s, m]); },
      alert: async (s, m) => { calls.push(['alert', s, m]); },
      exit: (c) => { calls.push(['exit', c]); },
    };
  }

  (async () => {
    // The 2026 incident this exists to fix: handleFatal called recoverRow then
    // process.exit(1), so an uncaught exception wrote a log row and alerted NOBODY.
    await checkAsync('an uncaught exception alerts before exiting', async () => {
      const s = spy();
      const { handleFatal } = makeFatalHandlers({ scriptName: 'test-job', ...s });
      await handleFatal(new Error('boom'));
      const names = s.calls.filter(c => c[0] !== 'log').map(c => c[0]);
      assert.deepStrictEqual(names, ['alert', 'recoverRow', 'exit'],
        `expected alert→recoverRow→exit, got ${names.join('→')}`);
      assert.strictEqual(s.calls.find(c => c[0] === 'alert')[1], 'failure');
      assert.ok(/boom/.test(s.calls.find(c => c[0] === 'alert')[2]), 'the alert must carry the error text');
    });

    // OOM kills on the ~3h age census arrive as a signal, not an exception.
    await checkAsync('a signal alerts before exiting, as killed', async () => {
      const s = spy();
      const { handleSignal } = makeFatalHandlers({ scriptName: 'age-census-monthly', ...s });
      await handleSignal('SIGTERM');
      const names = s.calls.filter(c => c[0] !== 'log').map(c => c[0]);
      assert.deepStrictEqual(names, ['alert', 'recoverRow', 'exit']);
      assert.strictEqual(s.calls.find(c => c[0] === 'alert')[1], 'killed');
      assert.ok(/SIGTERM/.test(s.calls.find(c => c[0] === 'alert')[2]));
      assert.strictEqual(s.calls.find(c => c[0] === 'recoverRow')[1], 'killed',
        'the cron_job_log status must stay `killed`, not become `failure`');
    });

    await checkAsync('exits 1 on both paths', async () => {
      const s1 = spy(), s2 = spy();
      await makeFatalHandlers({ scriptName: 't', ...s1 }).handleFatal(new Error('x'));
      await makeFatalHandlers({ scriptName: 't', ...s2 }).handleSignal('SIGINT');
      assert.deepStrictEqual(s1.calls.find(c => c[0] === 'exit'), ['exit', 1]);
      assert.deepStrictEqual(s2.calls.find(c => c[0] === 'exit'), ['exit', 1]);
    });

    // Re-entrancy: SIGTERM then SIGKILL-ish follow-ups, or an exception thrown
    // from inside the handler, must not produce a second alert.
    await checkAsync('re-entry is suppressed — one alert per death', async () => {
      const s = spy();
      const h = makeFatalHandlers({ scriptName: 't', ...s });
      await h.handleSignal('SIGTERM');
      await h.handleSignal('SIGTERM');
      await h.handleFatal(new Error('secondary'));
      assert.strictEqual(s.calls.filter(c => c[0] === 'alert').length, 1);
      assert.strictEqual(s.calls.filter(c => c[0] === 'exit').length, 1);
    });

    // postAlert can REJECT (new URL on a malformed SLACK_WEBHOOK_URL). A throw
    // here would skip recoverRow AND exit, leaving the row stuck at 'running'
    // forever — the exact orphan state the watchdog then has to clean up.
    await checkAsync('a throwing alert still lets recoverRow and exit run', async () => {
      const s = spy();
      const { handleFatal } = makeFatalHandlers({
        scriptName: 't', ...s,
        alert: async () => { throw new Error('malformed webhook'); },
      });
      await handleFatal(new Error('boom'));
      const names = s.calls.filter(c => c[0] !== 'log').map(c => c[0]);
      assert.deepStrictEqual(names, ['recoverRow', 'exit'],
        `alert threw, so it logs nothing; recoverRow and exit must still run — got ${names.join('→')}`);
    });

    // Symmetrically: a hung/throwing DB recovery must not eat the alert.
    await checkAsync('a throwing recoverRow still lets the alert and exit run', async () => {
      const s = spy();
      const { handleFatal } = makeFatalHandlers({
        scriptName: 't', ...s,
        recoverRow: async () => { throw new Error('db gone'); },
      });
      await handleFatal(new Error('boom'));
      const names = s.calls.filter(c => c[0] !== 'log').map(c => c[0]);
      assert.deepStrictEqual(names, ['alert', 'exit']);
    });

    const { buildAlertText } = module.exports;

    // Slack notifies on mentions, not on channels. Tier 1 and the digest share
    // #hemnet-ops by operator decision, so the mention IS the two-channel effect.
    await checkAsync('tier 1 carries the greppable prefix and the mention', async () => {
      const t = buildAlertText('cohort-create', 'FAILURE', 'cohort-create: 0 matched', 1);
      assert.ok(t.startsWith('🚨 TIER1 '), `expected the 🚨 TIER1 prefix, got: ${t}`);
      assert.ok(t.includes('<!channel>'), 'a tier-1 alert must notify');
      assert.ok(t.includes('[FAILURE]'), 'the existing [LABEL] shape must survive');
      assert.ok(t.includes('cohort-create: 0 matched'));
    });

    await checkAsync('tier 2 never mentions — it must not interrupt', async () => {
      const t = buildAlertText('spotcheck-reaction-poller', 'WARNING', 'x: 4 stale', 2);
      assert.ok(!t.includes('<!channel>'), 'a tier-2 alert must never notify');
      assert.ok(!t.includes('!here') && !t.includes('@here'), 'no @here either');
      assert.ok(!t.startsWith('🚨 TIER1'), 'TIER1 is a reserved, greppable prefix');
      assert.strictEqual(t, '[WARNING] x: 4 stale', 'tier 2 keeps today\'s exact shape');
    });

    // A job absent from the registry is a fault. Silence would hide a newly
    // added perishable job; this alerts AND names the gap.
    await checkAsync('an unregistered job alerts loudly and flags the registry gap', async () => {
      const t = buildAlertText('brand-new-job', 'FAILURE', 'brand-new-job: boom', null);
      assert.ok(t.includes('<!channel>'), 'an unknown tier must be treated as perishable');
      assert.ok(/not in lib\/job-registry\.js/.test(t), `the gap must be named, got: ${t}`);
    });

    await checkAsync('the KILLED label from the signal path is tiered too', async () => {
      const t = buildAlertText('age-census-monthly', 'KILLED', 'age-census-monthly: killed by SIGTERM', 1);
      assert.ok(t.includes('<!channel>') && t.includes('[KILLED]'));
    });

    // The digest is a report, not an interrupt. It posts via postMessage in
    // cron-health-slack.js and must never acquire a mention.
    check('the digest never mentions', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.join(__dirname, 'cron-health-slack.js'), 'utf8');
      assert.ok(!/<!channel>|<!here>/.test(src),
        'cron-health-slack.js contains a mention — the daily digest must not interrupt');
    });

    const { runReporter, buildReporterMain } = module.exports;

    // These seven reporters are self-contained: each opens its own client and
    // signals a failed Slack delivery with process.exitCode = 1 rather than by
    // throwing. runReporter is the bridge that turns that into a failure row.
    await checkAsync('runReporter is exported and is a function', async () => {
      assert.strictEqual(typeof runReporter, 'function');
    });

    await checkAsync('a reporter that sets exitCode=1 is turned into a throw', async () => {
      const main = buildReporterMain('weekly-view-report', async () => { process.exitCode = 1; });
      const saved = process.exitCode;
      await assert.rejects(() => main(null, () => {}), /exitCode/,
        'a failed Slack delivery must become a failure row, not a silent success');
      process.exitCode = saved;
    });

    await checkAsync('a clean reporter run resolves and reports its exit code', async () => {
      let ran = false;
      const main = buildReporterMain('sold-match-xlsx', async () => { ran = true; });
      const res = await main(null, () => {});
      assert.strictEqual(ran, true, 'run() must actually be invoked');
      assert.strictEqual(res.reporter, true);
    });

    await checkAsync('a throwing reporter propagates its own error unchanged', async () => {
      const main = buildReporterMain('sold-match-report', async () => { throw new Error('db exploded'); });
      await assert.rejects(() => main(null, () => {}), /db exploded/,
        'the original error must survive — it is what lands in cron_job_log.error_message');
    });

    // A reporter left exitCode=1 from a PREVIOUS unrelated cause would otherwise
    // be misreported. Only a transition during run() counts.
    await checkAsync('a pre-existing non-zero exitCode is not blamed on this run', async () => {
      const saved = process.exitCode;
      process.exitCode = 1;
      const main = buildReporterMain('age-census-report', async () => { /* clean run */ });
      const res = await main(null, () => {});
      assert.strictEqual(res.reporter, true, 'a clean run must not inherit an earlier exitCode');
      process.exitCode = saved;
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
