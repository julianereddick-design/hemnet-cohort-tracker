'use strict';
// adcost-crawl.js — monthly Hemnet ad-cost crawl, run ON THIS DROPLET.
//
// Ported 2026-08-18: the crawl used to run via Celery on the price droplet
// (170.64.181.89), which is being destroyed. scripts/adcost-crawl.py is now a
// self-contained script (Bright Data Web Unlocker, no browser, no Django, no
// Celery) and this file is the thin Node wrapper that gives it a cron_job_log
// row and Slack alerting, same as every other scheduled job in this repo. All
// of the actual crawl logic — retry, session-rebuild, the completeness gate —
// lives in the Python; this file only shells out to it and surfaces its
// stderr.
//
// Cron: 00:30 UTC on the 1st (lib/job-registry.js — see the comment there for
// why 00:30 and not 02:00, which 'age-census-monthly' already owns).
// Self-test: node adcost-crawl.js --smoke   (offline: no DB, no Python, no network)
require('dotenv').config();
const path = require('path');
const assert = require('assert');
const { runJob } = require('./cron-wrapper');

const PY_SCRIPT = path.join(__dirname, 'scripts', 'adcost-crawl.py');

const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] INFO ${msg}`),
};

// ⚠ ONE constant. subprocess.run DISCARDS the child's stdout on timeout, so an
// overrun loses the ENTIRE month's harvest rather than its tail — a permanent
// hole in an unbackfillable monthly series. The crawler derives its own
// TIME_BUDGET from ADCOST_SUBPROCESS_TIMEOUT, so these must never drift apart.
// Must equal scripts/adcost-crawl.py's DEFAULT_SUBPROCESS_TIMEOUT (2700).
const SUBPROCESS_TIMEOUT_SEC = 2700;

function runPython(extraArgs, deps = {}) {
  const spawnSync = deps.spawnSync || require('child_process').spawnSync;
  const bins = process.env.PYTHON_BIN ? [process.env.PYTHON_BIN] : ['python3', 'python'];
  let last = null;
  for (const bin of bins) {
    const res = spawnSync(bin, [PY_SCRIPT, ...extraArgs], {
      encoding: 'utf8',
      timeout: (SUBPROCESS_TIMEOUT_SEC + 60) * 1000,
      env: { ...process.env, ADCOST_SUBPROCESS_TIMEOUT: String(SUBPROCESS_TIMEOUT_SEC) },
    });
    // Fall through ONLY when the interpreter is absent. A python that exists and
    // fails must fail loudly, never be silently retried under another one.
    if (res.error && res.error.code === 'ENOENT') { last = res; continue; }
    if (res.error) throw new Error(`${bin} failed to start: ${res.error.message}`);
    // ALWAYS surface stderr, not only on non-zero exit: every degraded run so far
    // exited 0, and its "price fetch failed" lines were captured and thrown away.
    if (res.stderr) log.info(`adcost-crawl stderr: ${res.stderr.slice(-8000)}`);
    if (res.status !== 0) {
      // The thrown message is what reaches SLACK; the log line above only reaches
      // the droplet. "exited 1" on its own forces an ssh to answer the one
      // question that decides what to do next: a WARMUP_FAILED run wrote nothing
      // and is cheap to re-run now, while a short grid ALREADY WROTE its rows and
      // must NOT be re-crawled. The crawler's last stderr lines carry exactly
      // that — rows=n/420, VERDICT:, the budget warning — so carry them over.
      // (The Python scrubs the proxy credential out of its own exception text
      // before printing, so this tail cannot leak it.)
      const tail = String(res.stderr || '').trim().slice(-300);
      throw new Error(`${bin} ${PY_SCRIPT} exited ${res.status}`
        + (tail ? ` — stderr tail: ${tail}` : ''));
    }
    return res.stdout;
  }
  throw new Error(`no usable python interpreter (tried ${bins.join(', ')})`);
}

// makeMain(extraArgs) -> the runJob entry point. The crawler is entirely
// self-contained (its own DB connection, its own completeness gate raising a
// non-zero exit on a degraded month), so this is a thin bridge: run it, and
// let a non-zero exit propagate as a runJob failure + Slack alert. The
// cron-wrapper `client`/`log` args are unused — the crawler owns its own DB
// connection so its writes are never entangled with runJob's cron_job_log
// connection, and the crawler's OWN stderr is what actually matters here.
function makeMain(extraArgs = []) {
  return async function main() {
    const stdout = runPython(extraArgs);
    if (stdout && stdout.trim()) log.info(`adcost-crawl stdout: ${stdout.trim()}`);
    return { ok: true, dryRun: extraArgs.length > 0 };
  };
}

module.exports = { runPython, makeMain, SUBPROCESS_TIMEOUT_SEC };

// ---------------------------------------------------------------
// --smoke self-test (offline: no DB, no Python, no network — spawnSync is
// ALWAYS injected, never the real child_process one)
// ---------------------------------------------------------------
function smoke() {
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fail++; console.log(`SMOKE FAIL [${name}]: ${e.message}`); }
  };

  // The checks below set and clear PYTHON_BIN to drive the interpreter
  // fall-through. The registry EXPORTS PYTHON_BIN for this job, so an operator
  // running the smoke during a deploy arrives with it already set — capture it
  // and put it back, rather than leaking this suite's value into the process.
  const savedPythonBin = process.env.PYTHON_BIN;

  check('a missing interpreter falls through, a failing one does NOT', () => {
    const calls = [];
    const fakeSpawn = (bin) => {
      calls.push(bin);
      if (bin === 'python3') return { error: { code: 'ENOENT' } };
      return { status: 1, stderr: 'boom', stdout: '' };
    };
    delete process.env.PYTHON_BIN;
    assert.throws(() => runPython([], { spawnSync: fakeSpawn }), /exited 1/);
    assert.deepStrictEqual(calls, ['python3', 'python']);
  });

  check('a non-ENOENT spawn error is never retried', () => {
    const calls = [];
    const fakeSpawn = (bin) => { calls.push(bin); return { error: { code: 'EACCES', message: 'denied' } }; };
    assert.throws(() => runPython([], { spawnSync: fakeSpawn }), /failed to start/);
    assert.strictEqual(calls.length, 1, 'must not try a second interpreter');
  });

  check('the subprocess timeout is passed to the child from ONE constant', () => {
    let seenEnv = null;
    const fakeSpawn = (_b, _a, opts) => { seenEnv = opts.env; return { status: 0, stdout: '{}' }; };
    process.env.PYTHON_BIN = 'python';
    runPython([], { spawnSync: fakeSpawn });
    assert.strictEqual(seenEnv.ADCOST_SUBPROCESS_TIMEOUT, String(SUBPROCESS_TIMEOUT_SEC));
  });

  // CRITICAL: every degraded run so far exited 0 with its diagnostic lines on
  // stderr, and those lines were captured and thrown away unread — that is
  // WHY the August failures had to be diagnosed from timing instead of a
  // stack. This check pins stderr reaching the log on an exit-0 run so a
  // refactor that moves the log call inside `if (res.status !== 0)` fails
  // --smoke instead of silently reintroducing that hole.
  check('CRITICAL: stderr is logged on an exit-0 run, not only on failure', () => {
    const seen = [];
    const originalInfo = log.info;
    log.info = (msg) => seen.push(msg);
    try {
      const fakeSpawn = () => ({ status: 0, stdout: 'ok', stderr: 'price fetch failed for cell 12' });
      process.env.PYTHON_BIN = 'python';
      runPython([], { spawnSync: fakeSpawn });
      assert.ok(seen.some(m => m.includes('price fetch failed for cell 12')),
        `stderr on an exit-0 run must reach the log, not be silently discarded: ${JSON.stringify(seen)}`);
    } finally {
      log.info = originalInfo;
    }
  });

  // The alert an operator actually reads is the THROWN message, not the droplet
  // log. "exited 1" alone cannot distinguish a warm-up failure (nothing written,
  // re-run now) from a short grid (rows already written, do NOT re-crawl), so
  // the tail of stderr must ride along with it.
  check('CRITICAL: the thrown message carries the stderr tail, not just the exit code', () => {
    const stderr = [
      'transport=unlocker',
      'warm-up HTTP 403 in 4s len=812 challenged=True cleared=False',
      'VERDICT: WARMUP_FAILED',
    ].join('\n');
    process.env.PYTHON_BIN = 'python';
    let thrown = null;
    const originalInfo = log.info;
    log.info = () => {};          // the stderr echo is the previous check's subject
    try { runPython([], { spawnSync: () => ({ status: 4, stdout: '', stderr }) }); }
    catch (e) { thrown = e; }
    finally { log.info = originalInfo; }
    assert.ok(thrown, 'a non-zero exit must throw');
    assert.match(thrown.message, /exited 4/);
    assert.match(thrown.message, /VERDICT: WARMUP_FAILED/,
      `the diagnosis must reach Slack, not only the droplet log: ${thrown.message}`);
    assert.ok(thrown.message.length < 500, 'the tail is bounded, not the whole stderr');
  });

  check('a non-zero exit with empty stderr still throws a clean message', () => {
    process.env.PYTHON_BIN = 'python';
    assert.throws(
      () => runPython([], { spawnSync: () => ({ status: 1, stdout: '', stderr: '' }) }),
      /exited 1$/);
  });

  // FIX 7: leave the environment as we found it. adcost-report.js --smoke has
  // the same requirement and now guards it the same way.
  if (savedPythonBin === undefined) delete process.env.PYTHON_BIN;
  else process.env.PYTHON_BIN = savedPythonBin;

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  return fail === 0 ? 0 : 1;
}

// Entry gate. Only --smoke is a real offline path here — there is no --dry-run
// distinct from the real thing at the Node layer: the crawl is a single
// subprocess call and the Python script owns its own --dry-run (crawl fully,
// write nothing). Accepting an unrecognised flag must not silently fall
// through to a live paid run, so anything else is rejected.
const ACCEPTED_ARGV = new Set(['--smoke', '--dry-run']);
const USAGE = 'Usage: node adcost-crawl.js [--smoke] [--dry-run]';
function validateArgv(argv) {
  return argv.every(a => ACCEPTED_ARGV.has(a));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!validateArgv(argv)) {
    console.error(`Unrecognised argument(s): ${argv.filter(a => !ACCEPTED_ARGV.has(a)).join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  } else if (argv.includes('--smoke')) {
    process.exit(smoke());
  } else {
    // --dry-run passes straight through to the Python, which crawls fully
    // (still spends provider $) but writes nothing and prints a diff instead —
    // see scripts/adcost-crawl.py's own --dry-run. It is NOT a no-op offline
    // check; --smoke is the only offline path here.
    const extraArgs = argv.includes('--dry-run') ? ['--dry-run'] : [];
    runJob({ scriptName: 'ad-cost-crawler', main: makeMain(extraArgs) });
  }
}
