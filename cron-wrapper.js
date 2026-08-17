const { createClient } = require('./db');
const { postAlert } = require('./lib/slack-post');
const { tierOf } = require('./lib/job-registry');
const { normalizeValidation, decideAlert, applyOutcome } = require('./lib/alert-policy');
const { loadOpen, saveState } = require('./lib/alert-state');

// conditionOf({ status, errorMessage, validation, error }) -> condition | null
//
// The three ways a run can end badly, reduced to one shape for the policy.
//
// A thrown error's MESSAGE is not a stable identity — it carries pair ids, live
// counts and timestamps — so a failure is keyless by default and therefore
// alerts every time. A job that knows its own failure modes can opt into the
// ladder by attaching `err.conditionKey`, which is the only way to declare a
// stable identity without the policy ever parsing prose.
function conditionOf({ status, errorMessage, validation, error }) {
  if (status === 'failure' || status === 'killed') {
    return {
      key: (error && error.conditionKey) || null,
      severity: status === 'killed' ? 'killed' : 'failure',
      message: errorMessage || (error && error.message) || 'unknown',
    };
  }
  if (status === 'warning') {
    const v = normalizeValidation(validation != null ? validation : errorMessage);
    return v || { key: null, severity: 'warning', message: errorMessage || 'unknown' };
  }
  return null;
}

// evaluateAlert({ scriptName, tier, condition, now, load, save }) -> { alert, reason }
//
// Load -> decide -> record. `load(scriptName)` returns EVERY open condition for
// the script, not just the one that fired. That is load-bearing: the N=2 flap
// debounce only works if a run that is CLEAN still ticks the open incidents
// forward. Loading by key alone would mean a clean run saw no state, resolved
// nothing, and the debounce never happened — so an oscillating job would restart
// its ladder on every swing, which is the exact volume-doubling this rule exists
// to prevent.
//
// `load`/`save` are injected so this is testable offline against a fake store,
// and so a broken store cannot fail the job it is only observing.
//
// FAILURE POSTURE: if the store throws, this returns alert:true. Phase 4 exists
// to make the channel quiet, which means a bug that makes it quiet for the WRONG
// reason is indistinguishable from success until an incident is missed.
async function evaluateAlert({ scriptName, tier, condition, now = new Date(), load, save }) {
  let open = [];
  try {
    open = (await load(scriptName)) || [];
  } catch (_) {
    return { alert: !!condition && tier !== 2, reason: 'state store unavailable — alerting' };
  }

  const state = condition && condition.key
    ? open.find(s => s.condition_key === condition.key) || null
    : null;

  const decision = decideAlert({ tier, condition, state, now });

  try {
    if (condition && condition.key) {
      await save(applyOutcome(state, { condition, alerted: decision.alert, now }));
    }
    // Every OTHER open condition did not recur this run: tick its clear streak.
    for (const s of open) {
      if (condition && condition.key && s.condition_key === condition.key) continue;
      await save(Object.assign(
        { condition_key: s.condition_key },
        applyOutcome(s, { condition: null, alerted: false, now }),
      ));
    }
  } catch (_) { /* the store must never fail the job it is observing */ }

  return decision;
}

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
  let validation = null;
  let caughtError = null;

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

    // Validate result. A validator may return a plain string (all twelve live
    // jobs do today) or a structured { key, severity, message } — see
    // lib/alert-policy.js normalizeValidation. `severity: 'failure'` lets a
    // validator declare that a bad OUTPUT is a failure rather than a warning.
    if (validate) {
      validation = normalizeValidation(validate(resultSummary));
      if (validation) {
        status = validation.severity === 'failure' ? 'failure' : 'warning';
        errorMessage = validation.message;
        log(status === 'failure' ? 'ERROR' : 'WARN', validation.message);
      }
    }
  } catch (err) {
    status = 'failure';
    errorMessage = err.message;
    caughtError = err;
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

  // Slack alert on failure/warning, GATED BY POLICY (Phase 4). Webhook only, by
  // design — see lib/slack-post.js postAlert.
  //
  // This runs on EVERY outcome including success, not just on failure: the N=2
  // flap debounce needs a clean run to tick open incidents forward, or an
  // oscillating condition never clears and its ladder never restarts.
  if (client) {
    const condition = conditionOf({ status, errorMessage, validation, error: caughtError });
    const decision = await evaluateAlert({
      scriptName, tier: tierOf(scriptName), condition, now: new Date(),
      load: (name) => loadOpen(client, 'run', name),
      save: (state) => saveState(client, 'run', scriptName, state),
    });
    if (decision.alert) {
      await sendAlert(status === 'failure' ? 'FAILURE' : 'WARNING', `${scriptName}: ${errorMessage}`);
    } else if (condition) {
      log('INFO', `alert not sent — ${decision.reason}`);
    }
  } else if (status === 'failure' || status === 'warning') {
    // No DB client at all, so no suppression state is readable. Alert rather
    // than stay quiet: a quiet channel for the wrong reason is indistinguishable
    // from a healthy one until an incident is missed.
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

module.exports = {
  runJob, makeFatalHandlers, buildAlertText, runReporter, buildReporterMain,
  conditionOf, evaluateAlert, connectWithRetry,
};

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

    // ---------------------------------------------------------------
    // Phase 4 — tier gating, conditionKey suppression, ladder, debounce.
    // ---------------------------------------------------------------
    const { conditionOf, evaluateAlert } = module.exports;

    // conditionOf turns the THREE ways a run can end badly into one shape.
    check('a thrown error becomes an un-keyed condition, so it always alerts', () => {
      const c = conditionOf({ status: 'failure', errorMessage: 'boom', error: new Error('boom') });
      assert.strictEqual(c.severity, 'failure');
      assert.strictEqual(c.key, null, 'an arbitrary error message is not a stable identity');
    });

    // A job CAN declare a stable identity for its own failure, and then it gets
    // the ladder instead of alerting on every single run.
    check('a thrown error may declare its own conditionKey', () => {
      const err = Object.assign(new Error('0 galleries'), { conditionKey: 'photo-enrichment-empty' });
      assert.strictEqual(conditionOf({ status: 'failure', errorMessage: '0 galleries', error: err }).key,
        'photo-enrichment-empty');
    });

    check('a legacy string validator becomes a keyless warning', () => {
      const c = conditionOf({ status: 'warning', errorMessage: '4 stale', validation: '4 stale' });
      assert.strictEqual(c.severity, 'warning');
      assert.strictEqual(c.key, null);
    });

    check('a successful run has no condition', () => {
      assert.strictEqual(conditionOf({ status: 'success' }), null);
    });

    // The integration proper, with the store injected so it runs offline.
    // load() returns EVERY open condition for the script — see evaluateAlert on
    // why loading by key alone breaks the debounce.
    function fakeStore(initial) {
      const rows = new Map(initial ? [[initial.condition_key, initial]] : []);
      return {
        load: async () => [...rows.values()],
        save: async (s) => {
          if (!s || !s.condition_key) return;
          if (s.resolved) rows.delete(s.condition_key); else rows.set(s.condition_key, s);
        },
        peek: (k) => rows.get(k) || null,
        openCount: () => rows.size,
      };
    }
    const now = new Date('2026-08-17T00:00:00Z');

    // The single change that removes ~56 of the 59 baseline alerts in 60 days.
    await checkAsync('a tier-2 warning does not post, however many times it repeats', async () => {
      const store = fakeStore();
      const cond = { key: 'stale-reviews', severity: 'warning', message: '17 unanswered' };
      let alerts = 0;
      for (let i = 0; i < 5; i++) {
        const d = await evaluateAlert({
          scriptName: 'spotcheck-reaction-poller', tier: 2, condition: cond,
          now: new Date(now.getTime() + i * 86400000), ...store,
        });
        if (d.alert) alerts++;
      }
      assert.strictEqual(alerts, 0, 'tier 2 is digest-only — it must never interrupt');
    });

    await checkAsync('a tier-1 failure repeated 5 days alerts on the ladder, never silence', async () => {
      const store = fakeStore();
      const cond = { key: 'partial-upsert', severity: 'failure', message: 'got 3 of 4' };
      const days = [];
      for (let i = 0; i < 5; i++) {
        const d = await evaluateAlert({
          scriptName: 'market-totals-daily', tier: 1, condition: cond,
          now: new Date(now.getTime() + i * 86400000), ...store,
        });
        if (d.alert) days.push(i);
      }
      assert.deepStrictEqual(days, [0, 1, 3, 4],
        `expected the 0h/+24h/+72h/daily ladder over 5 daily runs, got ${days}`);
    });

    // The market-totals-daily case from §4.2: a perfectly stable error signature
    // on a tier-1 DAILY job. Naive suppression alerts once and then silently eats
    // every subsequent permanently-lost snapshot.
    await checkAsync('a standing tier-1 failure is still reported on day 30', async () => {
      const store = fakeStore();
      const cond = { key: 'partial-upsert', severity: 'failure', message: 'got 3 of 4' };
      let last = -1;
      for (let i = 0; i < 30; i++) {
        const d = await evaluateAlert({
          scriptName: 'market-totals-daily', tier: 1, condition: cond,
          now: new Date(now.getTime() + i * 86400000), ...store,
        });
        if (d.alert) last = i;
      }
      assert.strictEqual(last, 29, 'a permanently-lost daily snapshot must never go quiet');
    });

    await checkAsync('an unregistered job alerts — an unknown tier is treated as perishable', async () => {
      const store = fakeStore();
      const d = await evaluateAlert({
        scriptName: 'brand-new-job', tier: null,
        condition: { key: 'k', severity: 'failure', message: 'm' }, now, ...store,
      });
      assert.strictEqual(d.alert, true);
    });

    // cohort-track straddles a hard >50% boundary as a cohort decays, every 2
    // days. Without N=2 debounce this alerts in BOTH directions and DOUBLES
    // today's volume rather than reducing it.
    await checkAsync('a flapping tier-1 condition alerts once, not once per oscillation', async () => {
      const store = fakeStore();
      const cond = { key: 'null-views', severity: 'warning', message: '51% null' };
      let alerts = 0;
      // bad, good, bad, good, bad — two hours apart, well inside the ladder.
      for (const [i, c] of [cond, null, cond, null, cond].entries()) {
        const d = await evaluateAlert({
          scriptName: 'cohort-track', tier: 1, condition: c,
          now: new Date(now.getTime() + i * 7200000), ...store,
        });
        if (d.alert) alerts++;
      }
      assert.strictEqual(alerts, 1, 'an oscillation is one incident, not three');
    });

    await checkAsync('two clean runs clear the incident, so a later recurrence alerts again', async () => {
      const store = fakeStore();
      const cond = { key: 'null-views', severity: 'warning', message: '51% null' };
      const seq = [cond, null, null, cond];
      let alerts = 0;
      for (const [i, c] of seq.entries()) {
        const d = await evaluateAlert({
          scriptName: 'cohort-track', tier: 1, condition: c,
          now: new Date(now.getTime() + i * 7200000), ...store,
        });
        if (d.alert) alerts++;
      }
      assert.strictEqual(alerts, 2, 'a genuinely new incident after a clean spell must be heard');
      const reopened = store.peek('null-views');
      assert.strictEqual(reopened.alert_count, 1,
        'the second incident must start a FRESH ladder, not resume the first one');
    });

    // If the suppression store is broken or absent, the system must get LOUDER,
    // not quieter. A quiet channel for the wrong reason is indistinguishable from
    // success until an incident is missed.
    await checkAsync('a broken state store degrades to alerting, not to silence', async () => {
      const d = await evaluateAlert({
        scriptName: 'cohort-create', tier: 1,
        condition: { key: 'k', severity: 'failure', message: 'm' }, now,
        load: async () => { throw new Error('db gone'); },
        save: async () => { throw new Error('db gone'); },
      });
      assert.strictEqual(d.alert, true);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
