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

async function runJob({ scriptName, main, validate }) {
  const log = makeLogger(scriptName);
  const startTime = Date.now();
  let client;
  let logId;
  let status = 'success';
  let errorMessage = null;
  let resultSummary = null;
  let shuttingDown = false;

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

  // Process-level safety
  const handleFatal = (err) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('ERROR', `Uncaught: ${err && (err.message || err)}`);
    (async () => {
      await recoverRow('failure', String((err && (err.message || err)) || 'unknown'));
      process.exit(1);
    })();
  };
  const handleSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('WARN', `Received ${sig} — marking cron_job_log row killed`);
    (async () => {
      await recoverRow('killed', `killed by ${sig}`);
      process.exit(1);
    })();
  };
  process.on('uncaughtException', handleFatal);
  process.on('unhandledRejection', handleFatal);
  process.on('SIGHUP', () => handleSignal('SIGHUP'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

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
    const emoji = status === 'failure' ? 'FAILURE' : 'WARNING';
    // Guarded because postAlert can REJECT, not just resolve falsy: webhookPostMessage
    // calls new URL(webhookUrl) synchronously inside an async function, so a malformed
    // SLACK_WEBHOOK_URL (a scheme dropped in an .env edit) rejects. Unguarded, that
    // rejection skips client.end() and the process.exit() below and escapes as an
    // unhandledRejection — turning a 'warning' run into a hard failure for every one of
    // the ~13 jobs that route through runJob. The old sendSlackAlert had this try/catch.
    try {
      const res = await postAlert(`[${emoji}] ${scriptName}: ${errorMessage}`);
      log(res.ok ? 'INFO' : 'ERROR', res.ok ? 'Slack alert sent' : 'Slack alert failed');
    } catch (err) {
      log('ERROR', `Slack alert failed: ${err.message}`);
    }
  }

  // Cleanup
  try {
    if (client) await client.end();
  } catch (_) { /* best effort */ }

  log('INFO', `Finished with status: ${status} (${Date.now() - startTime}ms)`);
  process.exit(status === 'failure' ? 1 : 0);
}

module.exports = { runJob };
