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
    if (res.status !== 0) throw new Error(`${bin} ${PY_SCRIPT} exited ${res.status}`);
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
