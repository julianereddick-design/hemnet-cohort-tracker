#!/usr/bin/env node
/**
 * mem-profile.js — sample memory while a command runs, so "it OOMed" becomes a curve.
 *
 * This box has 458MB and no swap, and three separate production failures traced back
 * to that one fact (see docs/handover/05-MONITORING-AND-ALERTS.md and the 2026-08-18
 * diagnosis). The question a post-mortem cannot answer from a kernel OOM line is the
 * one that decides the fix: does the process *plateau* (needs more RAM) or does it
 * *climb with the work* (needs a code fix)? That is a curve, not a number.
 *
 *   node scripts/mem-profile.js -- node export-hb-ratio-xlsx.js --cohort 2026-W32
 *   node scripts/mem-profile.js --interval 500 -- node some-job.js
 *   node scripts/mem-profile.js --watch          # sample the whole box, no child
 *
 * Samples the child's whole process tree (a job that spawns children hides its real
 * peak otherwise) plus system-wide MemAvailable, which is what the OOM killer acts on.
 * Linux only — reads /proc. Never fails the run it is measuring: sampling errors are
 * swallowed, because a profiler that breaks the thing it profiles is worse than none.
 *
 * Exit code is the child's, so this is safe to wrap around anything.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const PAGE_KB = 4;

function parseArgs(argv) {
  const out = { interval: 250, watch: false, cmd: [] };
  const sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  if (sep !== -1) out.cmd = argv.slice(sep + 1);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--interval') out.interval = Math.max(50, parseInt(head[++i], 10) || 250);
    else if (head[i] === '--watch') out.watch = true;
  }
  return out;
}

// RSS in MB for one pid, from /proc/<pid>/statm (field 2 = resident pages).
function rssMb(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
    return (parseInt(f[1], 10) * PAGE_KB) / 1024;
  } catch (_) { return 0; }
}

function commOf(pid) {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch (_) { return '?'; }
}

// Every pid whose ancestry reaches root — a job that shells out hides its peak otherwise.
function descendants(root) {
  const parent = new Map();
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number); } catch (_) { return [root]; }
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm can contain spaces and parens; PPid is the field after the state char.
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parent.set(pid, parseInt(tail[1], 10));
    } catch (_) { /* process exited mid-scan */ }
  }
  const tree = [root];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) {
      if (!tree.includes(pid) && tree.includes(ppid)) { tree.push(pid); grew = true; }
    }
  }
  return tree;
}

function memAvailableMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+) kB/);
    return m ? parseInt(m[1], 10) / 1024 : 0;
  } catch (_) { return 0; }
}

function sparkline(values, width = 60) {
  const bars = '▁▂▃▄▅▆▇█';
  if (!values.length) return '';
  const step = Math.max(1, Math.ceil(values.length / width));
  const buckets = [];
  for (let i = 0; i < values.length; i += step) {
    buckets.push(Math.max(...values.slice(i, i + step)));
  }
  const max = Math.max(...buckets, 1);
  return buckets.map((v) => bars[Math.min(bars.length - 1, Math.round((v / max) * (bars.length - 1)))]).join('');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.watch && !args.cmd.length) {
    console.error('usage: node scripts/mem-profile.js [--interval ms] -- <command...>');
    console.error('       node scripts/mem-profile.js --watch');
    process.exit(2);
  }

  const samples = [];       // { t, treeMb, availMb, nprocs }
  let peak = { treeMb: 0, availMb: Infinity, at: 0, procs: [] };
  const started = Date.now();

  const child = args.watch ? null : spawn(args.cmd[0], args.cmd.slice(1), { stdio: 'inherit' });
  const rootPid = child ? child.pid : process.pid;

  const timer = setInterval(() => {
    try {
      const t = (Date.now() - started) / 1000;
      const pids = args.watch
        ? fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)
        : descendants(rootPid);
      const procs = pids.map((p) => ({ pid: p, mb: rssMb(p), comm: commOf(p) })).filter((p) => p.mb > 0.5);
      const treeMb = procs.reduce((a, p) => a + p.mb, 0);
      const availMb = memAvailableMb();
      samples.push({ t, treeMb, availMb });
      if (treeMb > peak.treeMb) {
        peak = { treeMb, availMb, at: t, procs: procs.sort((a, b) => b.mb - a.mb).slice(0, 6) };
      }
      if (availMb < peak.availMb) peak.availMb = availMb;
    } catch (_) { /* never break the run being measured */ }
  }, args.interval);

  const report = (code, signal) => {
    clearInterval(timer);
    const dur = (Date.now() - started) / 1000;
    const tree = samples.map((s) => s.treeMb);
    const avail = samples.map((s) => s.availMb);

    console.log('\n' + '='.repeat(72));
    console.log(`mem-profile: ${args.watch ? '(watch mode)' : args.cmd.join(' ')}`);
    console.log('='.repeat(72));
    console.log(`duration        ${dur.toFixed(1)}s over ${samples.length} samples @${args.interval}ms`);
    if (signal) console.log(`exit            KILLED BY ${signal}${signal === 'SIGKILL' ? '  <-- consistent with an OOM kill; confirm in journalctl' : ''}`);
    else console.log(`exit            code ${code}`);
    if (!samples.length) { console.log('(no samples)'); process.exit(code || 0); }

    console.log(`peak tree RSS   ${peak.treeMb.toFixed(1)} MB   at t=${peak.at.toFixed(1)}s`);
    console.log(`min available   ${peak.availMb.toFixed(1)} MB  (what the OOM killer watches)`);
    console.log('');
    console.log(`tree RSS  ${sparkline(tree)}  0 -> ${Math.max(...tree).toFixed(0)}MB`);
    console.log(`available ${sparkline(avail)}  min ${Math.min(...avail).toFixed(0)}MB`);
    console.log('');

    // Leak vs plateau. A job whose RSS is still climbing in its final third is
    // retaining per-item state; one that flattens simply needs the headroom.
    const third = Math.floor(tree.length / 3);
    if (third >= 2) {
      const early = Math.max(...tree.slice(0, third));
      const late = Math.max(...tree.slice(-third));
      const growth = late - early;
      console.log(`first third max ${early.toFixed(1)} MB`);
      console.log(`last  third max ${late.toFixed(1)} MB`);
      console.log(`verdict         ${growth > early * 0.25
        ? `CLIMBING (+${growth.toFixed(1)}MB, +${((growth / early) * 100).toFixed(0)}%) — retains per-item state; more RAM only delays this`
        : `PLATEAU (${growth >= 0 ? '+' : ''}${growth.toFixed(1)}MB) — steady-state cost; this is a sizing problem, not a leak`}`);
    }

    if (peak.procs.length) {
      console.log('\ntop processes at peak:');
      for (const p of peak.procs) console.log(`  ${p.mb.toFixed(1).padStart(7)} MB  ${p.comm} (${p.pid})`);
    }
    console.log('='.repeat(72));
    process.exit(signal ? 1 : (code || 0));
  };

  if (child) {
    child.on('exit', report);
    child.on('error', (e) => { clearInterval(timer); console.error(`spawn failed: ${e.message}`); process.exit(2); });
  } else {
    process.on('SIGINT', () => report(0, null));
    console.log('watch mode — Ctrl-C to stop and report');
  }
}

module.exports = { sparkline, parseArgs, rssMb, memAvailableMb, descendants };

// ---------------------------------------------------------------
//   node scripts/mem-profile.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
  };

  check('--interval is parsed and floored at 50ms', () => {
    assert.strictEqual(parseArgs(['--interval', '500', '--', 'node', 'x.js']).interval, 500);
    assert.strictEqual(parseArgs(['--interval', '1', '--', 'node', 'x.js']).interval, 50);
  });

  // The `--` separator is what keeps the child's own flags out of ours: profiling
  // `node job.js --interval 5` must not silently retune the sampler.
  check('everything after -- is the child command, flags included', () => {
    const a = parseArgs(['--interval', '100', '--', 'node', 'job.js', '--interval', '9', '--cohort', 'X']);
    assert.strictEqual(a.interval, 100);
    assert.deepStrictEqual(a.cmd, ['node', 'job.js', '--interval', '9', '--cohort', 'X']);
  });

  check('--watch needs no command', () => {
    const a = parseArgs(['--watch']);
    assert.strictEqual(a.watch, true);
    assert.deepStrictEqual(a.cmd, []);
  });

  check('sparkline is one glyph per bucket and empty input is safe', () => {
    assert.strictEqual(sparkline([]), '');
    assert.strictEqual(sparkline([1, 2, 3]).length, 3);
    assert.ok(sparkline(new Array(500).fill(1)).length <= 60);
  });

  // A flat series must not render as a ramp — that is the exact misread this tool
  // exists to prevent (plateau vs climb decides sizing vs code fix).
  check('a flat series renders flat', () => {
    const s = sparkline([50, 50, 50, 50]);
    assert.strictEqual(new Set(s.split('')).size, 1);
  });

  check('a rising series ends higher than it starts', () => {
    const s = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(s.charCodeAt(s.length - 1) > s.charCodeAt(0));
  });

  check('rssMb returns 0 for a pid that cannot exist, never throws', () => {
    assert.strictEqual(rssMb(999999999), 0);
  });

  if (process.platform === 'linux') {
    check('this process reports a non-zero RSS', () => assert.ok(rssMb(process.pid) > 0));
    check('MemAvailable is readable', () => assert.ok(memAvailableMb() > 0));
    check('descendants includes the root pid', () => assert.ok(descendants(process.pid).includes(process.pid)));
  }

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

if (require.main === module) main();
