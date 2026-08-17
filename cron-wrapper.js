const { createClient } = require('./db');
const { postAlert } = require('./lib/slack-post');

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
    try {
      const res = await postAlert(`[${label}] ${message}`);
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

module.exports = { runJob, makeFatalHandlers };

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

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
