const https = require('https');
const http = require('http');
const url = require('url');
const { createClient } = require('./db');

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

async function sendSlackAlert(webhookUrl, text, log) {
  try {
    const parsed = new URL(webhookUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ text });

    await new Promise((resolve, reject) => {
      const req = transport.request(parsed, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Slack request timeout')); });
      req.write(payload);
      req.end();
    });
    log('INFO', 'Slack alert sent');
  } catch (err) {
    log('ERROR', `Slack alert failed: ${err.message}`);
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

  // Process-level safety
  const handleFatal = async (err) => {
    log('ERROR', `Uncaught: ${err.message || err}`);
    try {
      if (client && logId) {
        await client.query(
          `UPDATE cron_job_log SET finished_at = NOW(), duration_ms = $1, status = 'failure', error_message = $2 WHERE id = $3`,
          [Date.now() - startTime, String(err.message || err), logId]
        );
      }
    } catch (_) { /* best effort */ }
    process.exit(1);
  };
  process.on('uncaughtException', handleFatal);
  process.on('unhandledRejection', handleFatal);

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

  // Slack alert on failure/warning
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl && (status === 'failure' || status === 'warning')) {
    const emoji = status === 'failure' ? 'FAILURE' : 'WARNING';
    const text = `[${emoji}] ${scriptName}: ${errorMessage}`;
    await sendSlackAlert(webhookUrl, text, log);
  }

  // Cleanup
  try {
    if (client) await client.end();
  } catch (_) { /* best effort */ }

  log('INFO', `Finished with status: ${status} (${Date.now() - startTime}ms)`);
  process.exit(status === 'failure' ? 1 : 0);
}

module.exports = { runJob };
