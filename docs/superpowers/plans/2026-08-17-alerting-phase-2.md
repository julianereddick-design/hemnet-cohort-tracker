# Alerting Phase 2 — registry and drift — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lib/job-registry.js` carries enough to *generate* the crontab, and `scripts/render-crontab.js --check` fails when the droplet's live crontab drifts from it.

**Architecture:** The registry gains scheduling fields (`cron`, `command`, `env`, `log`, `cwd`, `frequency`, `label`, `expectedDurationMin`). A pure `renderCrontab(jobs)` function turns those into crontab text; the CLI wraps it with `--check`, which shells out to `crontab -l` and diffs. Keeping the renderer pure is what makes it testable on Windows, where there is no `crontab` at all.

**Why generate rather than describe:** a registry that merely *describes* a hand-maintained crontab is a third source of truth. Generation is also the only mechanism that catches a line hand-added or deleted on the droplet — "a job absent from the registry alerts" only catches a job that *ran and logged*, i.e. the already-visible case. It cannot catch a crontab line that never runs and never logs, which is the invisible half.

**Tech Stack:** Node.js (CommonJS). Offline `--smoke` blocks; no test framework.

**Spec:** `docs/superpowers/specs/2026-08-17-alerting-structure-design.md` §4.1, §7 Phase 2

## Global Constraints

- The droplet repo root is `/opt/hemnet-cohort-tracker` (verified). Make it a constant, overridable via `HEMNET_ROOT` so tests do not depend on it.
- **Byte-identical is achieved by reconciliation, not by mimicry.** The live crontab has irregular spacing and hand-written comments. Render canonically, install once, and `--check` is clean thereafter. Do NOT contort the renderer to reproduce today's whitespace.
- The three shell retention lines are real scheduled work and must be in the registry, flagged `shell: true` so Phase 1's "must be wrapped in runJob" check skips them.
- `sfpl-region-snapshot` is deprecated and has **no** `cron` — the renderer must omit it. That is the test for "a registry entry without a schedule is not emitted".
- Existing suites stay green: `node lib/job-registry.js --smoke`, `node cron-wrapper.js --smoke`, `node lib/slack-post.js --smoke`.
- `--check` can only run on Linux. Windows tests exercise `renderCrontab` and `diffCrontab` purely.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/job-registry.js` | modify | Add scheduling fields to every entry; add the 3 shell jobs |
| `scripts/render-crontab.js` | **create** | Pure `renderCrontab`/`diffCrontab` + CLI with `--check` |

---

### Task 1: Scheduling fields on every registry entry

**Files:**
- Modify: `lib/job-registry.js`

**Interfaces:**
- Produces: each `JOBS[name]` gains
  - `cron?: string` — 5-field spec. Absent ⇒ not scheduled, never rendered.
  - `command?: string` — the command after `cd <root> && `, e.g. `node cohort-create.js`
  - `env?: Record<string,string>` — rendered as `K=V ` before the command
  - `log?: string` — absolute path; renders ` >> <log> 2>&1`
  - `cwd?: false` — suppress the `cd <root> && ` prefix (the two `find` lines)
  - `shell?: true` — not a Node job; never writes a `cron_job_log` row
  - `frequency`, `label` — for the digest
  - `expectedDurationMin` — so the watchdog can tell "still running" from "orphaned"

- [ ] **Step 1: Write the failing test**

Add to the `--smoke` block in `lib/job-registry.js`, before its `console.log`:

```js
  check('every scheduled job has cron + command; unscheduled ones have neither', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.cron == null) {
        assert.ok(rec.deprecated, `${job} has no cron but is not marked deprecated`);
        continue;
      }
      assert.match(rec.cron, /^\S+ \S+ \S+ \S+ \S+$/, `${job} cron "${rec.cron}" is not 5 fields`);
      assert.ok(rec.command, `${job} has a cron but no command`);
    }
  });

  check('every scheduled Node job has an expectedDurationMin the watchdog can use', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.cron == null || rec.shell) continue;
      assert.ok(Number.isInteger(rec.expectedDurationMin) && rec.expectedDurationMin > 0,
        `${job} has no usable expectedDurationMin (needed to tell "still running" from "orphaned")`);
    }
  });

  check('the three retention lines are registered and flagged shell', () => {
    for (const job of ['spotcheck-artifact-retention', 'soldmatch-cache-retention', 'premarket-quality-retention']) {
      assert.ok(JOBS[job], `${job} is a real crontab line but is missing from the registry`);
      assert.strictEqual(JOBS[job].shell, true, `${job} must be shell:true — it writes no cron_job_log row`);
    }
  });

  // premarket-quality-measure is the PROVEN live drift: deployed, runJob-wrapped,
  // running weekly, and absent from deploy-instructions.md. It must be here.
  check('premarket-quality-measure is scheduled in the registry', () => {
    assert.ok(JOBS['premarket-quality-measure'].cron, 'the proven live drift is still undocumented');
    assert.strictEqual(JOBS['premarket-quality-measure'].command, 'node scripts/premarket-quality-measure.js');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/job-registry.js --smoke`
Expected: FAIL on all four new checks (no `cron` fields exist yet; the 3 shell jobs are absent).

- [ ] **Step 3: Write the implementation**

Rewrite the `JOBS` object, preserving every existing `tier` exactly. Values below are transcribed from the live droplet `crontab -l` captured 2026-08-17.

```js
const JOBS = {
  // ---- tier 1: capture ----
  'cohort-create': {
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 06:00)',
    cron: '0 6 * * 1', command: 'node cohort-create.js',
    expectedDurationMin: 10,
  },
  'market-totals-daily': {
    tier: 1, frequency: 'daily', label: 'Daily (08:30)',
    cron: '30 8 * * *', command: 'node market-totals-daily.js',
    log: '/var/log/hemnet/market-totals.log', expectedDurationMin: 10,
  },
  'premarket-flow-measure': {
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 08:50)',
    cron: '50 8 * * 1', command: 'node scripts/premarket-flow-measure.js',
    env: { SCRAPE_FORCE_OXYLABS: '1' },
    log: '/var/log/hemnet/premarket-flow-measure.log', expectedDurationMin: 45,
  },
  'premarket-quality-measure': {
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 09:00)',
    cron: '0 9 * * 1', command: 'node scripts/premarket-quality-measure.js',
    log: '/var/log/hemnet/premarket-quality.log', expectedDurationMin: 45,
  },
  'age-census-monthly': {
    tier: 1, frequency: 'monthly', label: 'Monthly (1st 02:00)',
    cron: '0 2 1 * *', command: 'node scripts/age-census-monthly.js',
    log: '/var/log/hemnet/age-census.log', expectedDurationMin: 240,
  },
  'cohort-track': {
    tier: 1, frequency: 'every2days', label: 'Every 2 days (22:00)',
    cron: '0 22 */2 * *', command: 'node cohort-track.js',
    log: '/var/log/hemnet/cohort-track.log', expectedDurationMin: 30,
  },
  'hemnet-targeted-refresh': {
    tier: 1, frequency: 'every2days', label: 'Every 2 days (14:00)',
    cron: '0 14 */2 * *', command: 'node hemnet-targeted-refresh.js',
    log: '/var/log/hemnet/job-a.log', expectedDurationMin: 60,
  },
  'booli-targeted-refresh': {
    tier: 1, frequency: 'every2days', label: 'Every 2 days (14:00)',
    cron: '0 14 */2 * *', command: 'node booli-targeted-refresh.js',
    log: '/var/log/hemnet/job-d.log', expectedDurationMin: 60,
  },
  'booli-targeted-discovery': {
    tier: 1, frequency: 'weekly', label: 'Weekly (Sun 22:00)',
    cron: '0 22 * * 0', command: 'node booli-targeted-discovery.js',
    expectedDurationMin: 60,
  },
  'hemnet-targeted-match': {
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 03:00)',
    cron: '0 3 * * 1', command: 'node hemnet-targeted-match.js',
    expectedDurationMin: 60,
  },
  'cohort-spotcheck-gate': {
    tier: 1, frequency: 'weekly', label: 'Weekly (Mon 06:30)',
    cron: '30 6 * * 1', command: 'node cohort-spotcheck-gate.js',
    log: '/var/log/hemnet/spotcheck-gate.log', expectedDurationMin: 60,
  },
  'sold-match-batch': {
    // Fires weekly in cron; the EVEN-ISO-week gate lives inside the script.
    tier: 1, frequency: 'fortnightly', label: 'Fortnightly (even ISO weeks, Mon 07:30)',
    cron: '30 7 * * 1', command: 'node sold-match-batch.js',
    log: '/var/log/hemnet/sold-match-batch.log', expectedDurationMin: 120,
  },

  // ---- tier 2: render / recoverable ----
  'spotcheck-reaction-poller': {
    tier: 2, frequency: 'daily', label: 'Daily (12:00)',
    cron: '0 12 * * *', command: 'node spotcheck-reaction-poller.js',
    log: '/var/log/hemnet/spotcheck-poller.log', expectedDurationMin: 15,
  },
  'weekly-view-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 09:30)',
    cron: '30 9 * * 1', command: 'node weekly-view-report.js',
    expectedDurationMin: 30,
  },
  'market-totals-weekly-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 09:35)',
    cron: '35 9 * * 1', command: 'node market-totals-weekly-report.js',
    log: '/var/log/hemnet/market-totals-weekly.log', expectedDurationMin: 15,
  },
  'premarket-flow-weekly-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 10:30)',
    cron: '30 10 * * 1', command: 'node premarket-flow-weekly-report.js',
    log: '/var/log/hemnet/premarket-flow-report.log', expectedDurationMin: 15,
  },
  'sold-match-report': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 11:00)',
    cron: '0 11 * * 1', command: 'node sold-match-report.js',
    log: '/var/log/hemnet/sold-match-report.log', expectedDurationMin: 15,
  },
  'age-census-report': {
    tier: 2, frequency: 'monthly', label: 'Monthly (1st 07:00)',
    cron: '0 7 1 * *', command: 'node age-census-report.js',
    log: '/var/log/hemnet/age-census-report.log', expectedDurationMin: 15,
  },
  'sold-match-trend-chart': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 11:05)',
    cron: '5 11 * * 1', command: 'node sold-match-trend-chart.js',
    log: '/var/log/hemnet/sold-match-chart.log', expectedDurationMin: 15,
  },
  'sold-match-xlsx': {
    tier: 2, frequency: 'weekly', label: 'Weekly (Mon 11:10)',
    cron: '10 11 * * 1', command: 'node sold-match-xlsx.js',
    log: '/var/log/hemnet/sold-match-xlsx.log', expectedDurationMin: 15,
  },
  'cron-health-slack': {
    tier: 2, frequency: 'daily', label: 'Daily (03:00)',
    cron: '0 3 * * *', command: 'node cron-health-slack.js',
    expectedDurationMin: 15,
  },

  // ---- shell retention jobs: real scheduled work, but never a cron_job_log row.
  // Their OUTCOME is monitored as disk headroom instead (spec §2 principle 4).
  'spotcheck-artifact-retention': {
    tier: 2, shell: true, frequency: 'daily', label: 'Daily (06:20)',
    cron: '20 6 * * *',
    command: "ls -dt verf-spotcheck-* 2>/dev/null | tail -n +4 | xargs -r rm -rf",
    log: '/var/log/hemnet/spotcheck-retention.log',
  },
  'soldmatch-cache-retention': {
    tier: 2, shell: true, cwd: false, frequency: 'daily', label: 'Daily (06:30)',
    cron: '30 6 * * *',
    command: "find /opt/hemnet-cohort-tracker/verf-soldspike/cache -type f ! -name '_*' -mtime +3 -delete",
    log: '/var/log/hemnet/retention.log',
  },
  'premarket-quality-retention': {
    tier: 2, shell: true, cwd: false, frequency: 'daily', label: 'Daily (06:35)',
    cron: '35 6 * * *',
    command: "find /opt/hemnet-cohort-tracker/verf-premarket-quality -maxdepth 1 -name 'quality-*.json' -mtime +70 -delete",
    log: '/var/log/hemnet/retention.log',
  },

  // Deprecated 2026-08-13, unscheduled (no `cron`), no downstream consumer.
  // Listed only so the runJob coverage check stays honest.
  'sfpl-region-snapshot': { tier: 2, deprecated: true, note: 'removed from the crontab 2026-08-13' },
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node lib/job-registry.js --smoke
node cron-wrapper.js --smoke
```
Expected: registry `smoke: 11 pass, 0 fail`; wrapper unchanged at 16.

The Phase 1 coverage check must still pass — the 3 new shell jobs are skipped via `shell: true`, and `sfpl-region-snapshot` via `deprecated`.

- [ ] **Step 5: Commit**

```bash
git add lib/job-registry.js
git commit -m "feat(alerting): registry carries the schedule, not just the tier"
```

---

### Task 2: `scripts/render-crontab.js`

**Files:**
- Create: `scripts/render-crontab.js`

**Interfaces:**
- Consumes: `JOBS` from `lib/job-registry`.
- Produces: `module.exports = { renderCrontab, renderLine, diffCrontab, HEADER }`
  - `renderLine(name, rec, root) => string`
  - `renderCrontab(jobs, root) => string` — header + one line per scheduled job, sorted by job name, trailing newline
  - `diffCrontab(rendered, live) => { inSync: boolean, missing: string[], extra: string[] }` — compares non-comment, non-blank lines as sets

- [ ] **Step 1: Write the failing test**

Create `scripts/render-crontab.js` containing only the smoke block plus `module.exports = {}`:

```js
'use strict';

module.exports = {};

// ---------------------------------------------------------------
//   node scripts/render-crontab.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { renderCrontab, renderLine, diffCrontab } = module.exports;
  const { JOBS } = require('../lib/job-registry');
  const ROOT = '/opt/hemnet-cohort-tracker';
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  };

  check('a plain node job renders schedule + cd + command', () => {
    const line = renderLine('cohort-create', { cron: '0 6 * * 1', command: 'node cohort-create.js' }, ROOT);
    assert.strictEqual(line, '0 6 * * 1 cd /opt/hemnet-cohort-tracker && node cohort-create.js');
  });

  check('a log path renders the append + stderr redirect', () => {
    const line = renderLine('cohort-track', {
      cron: '0 22 */2 * *', command: 'node cohort-track.js', log: '/var/log/hemnet/cohort-track.log',
    }, ROOT);
    assert.strictEqual(line,
      '0 22 */2 * * cd /opt/hemnet-cohort-tracker && node cohort-track.js >> /var/log/hemnet/cohort-track.log 2>&1');
  });

  check('env vars render before the command', () => {
    const line = renderLine('premarket-flow-measure', {
      cron: '50 8 * * 1', command: 'node scripts/premarket-flow-measure.js',
      env: { SCRAPE_FORCE_OXYLABS: '1' }, log: '/var/log/hemnet/premarket-flow-measure.log',
    }, ROOT);
    assert.ok(line.includes('&& SCRAPE_FORCE_OXYLABS=1 node scripts/premarket-flow-measure.js'),
      `env prefix misplaced: ${line}`);
  });

  check('cwd:false omits the cd prefix (the find lines run from anywhere)', () => {
    const line = renderLine('soldmatch-cache-retention', {
      cron: '30 6 * * *', cwd: false, command: "find /x -mtime +3 -delete", log: '/var/log/hemnet/retention.log',
    }, ROOT);
    assert.strictEqual(line, "30 6 * * * find /x -mtime +3 -delete >> /var/log/hemnet/retention.log 2>&1");
    assert.ok(!line.includes('cd '), 'cwd:false must not emit a cd');
  });

  check('an unscheduled job is never emitted', () => {
    const out = renderCrontab(JOBS, ROOT);
    assert.ok(!out.includes('sfpl-region-snapshot'),
      'a registry entry with no cron must not reach the crontab');
  });

  check('every scheduled job appears exactly once', () => {
    const out = renderCrontab(JOBS, ROOT);
    const body = out.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const scheduled = Object.values(JOBS).filter(r => r.cron).length;
    assert.strictEqual(body.length, scheduled, `expected ${scheduled} lines, got ${body.length}`);
  });

  check('the proven live drift is present in the output', () => {
    const out = renderCrontab(JOBS, ROOT);
    assert.ok(out.includes('node scripts/premarket-quality-measure.js'),
      'premarket-quality-measure is deployed and running weekly — it must be rendered');
  });

  check('output is deterministic — rendering twice is identical', () => {
    assert.strictEqual(renderCrontab(JOBS, ROOT), renderCrontab(JOBS, ROOT));
  });

  check('output carries a do-not-hand-edit header and ends with a newline', () => {
    const out = renderCrontab(JOBS, ROOT);
    assert.ok(out.startsWith('#'), 'must start with a comment header');
    assert.ok(/GENERATED/.test(out), 'header must say it is generated');
    assert.ok(out.endsWith('\n'), 'crontab files must end with a newline or cron ignores the last line');
  });

  check('diffCrontab: identical input is in sync', () => {
    const out = renderCrontab(JOBS, ROOT);
    const d = diffCrontab(out, out);
    assert.strictEqual(d.inSync, true);
    assert.deepStrictEqual(d.missing, []);
    assert.deepStrictEqual(d.extra, []);
  });

  // The invisible half: a line hand-DELETED on the droplet never runs and never
  // logs, so no amount of log-watching can see it. Only this diff can.
  check('diffCrontab: a hand-deleted line is reported missing', () => {
    const out = renderCrontab(JOBS, ROOT);
    const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const live = lines.slice(1).join('\n') + '\n';
    const d = diffCrontab(out, live);
    assert.strictEqual(d.inSync, false);
    assert.deepStrictEqual(d.missing, [lines[0]]);
  });

  check('diffCrontab: a hand-added line is reported extra', () => {
    const out = renderCrontab(JOBS, ROOT);
    const live = out + '0 0 * * * node /opt/rogue.js\n';
    const d = diffCrontab(out, live);
    assert.strictEqual(d.inSync, false);
    assert.deepStrictEqual(d.extra, ['0 0 * * * node /opt/rogue.js']);
  });

  check('diffCrontab ignores comments and blank lines on both sides', () => {
    const out = renderCrontab(JOBS, ROOT);
    const live = '# a human note\n\n' + out.split('\n').filter(l => l.trim() && !l.startsWith('#')).join('\n') + '\n';
    assert.strictEqual(diffCrontab(out, live).inSync, true,
      'comments are not schedule; they must not trip drift detection');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/render-crontab.js --smoke`
Expected: FAIL — every case errors with `renderLine is not a function` / `renderCrontab is not a function`.

- [ ] **Step 3: Write the implementation**

Replace `module.exports = {};` with:

```js
// scripts/render-crontab.js
//
// The crontab is GENERATED from lib/job-registry.js. A registry that merely
// describes a hand-maintained crontab would be a third source of truth.
//
// This is also the only mechanism that catches a line hand-added or deleted on
// the droplet. "A job absent from the registry alerts" only catches a job that
// RAN AND LOGGED under an unknown name — the already-visible case. A crontab
// line that never runs and never logs is the invisible half, and only a diff
// against the rendered output can see it.
//
//   node scripts/render-crontab.js            # print the crontab
//   node scripts/render-crontab.js --check    # diff against `crontab -l`, exit 1 on drift
//   node scripts/render-crontab.js --smoke    # offline self-test
//
// Deploy:  node scripts/render-crontab.js | crontab -

const { JOBS } = require('../lib/job-registry');

const ROOT = process.env.HEMNET_ROOT || '/opt/hemnet-cohort-tracker';

const HEADER = [
  '# ---------------------------------------------------------------',
  '# GENERATED by scripts/render-crontab.js from lib/job-registry.js',
  '# Do NOT hand-edit. `node scripts/render-crontab.js --check` fails on drift',
  '# and runs as an assertion in the daily digest.',
  '# Regenerate:  node scripts/render-crontab.js | crontab -',
  '# ---------------------------------------------------------------',
];

// renderLine(name, rec, root) — one crontab line. Order is fixed:
//   <cron> [cd <root> && ][ENV=v ]<command>[ >> <log> 2>&1]
function renderLine(name, rec, root) {
  const parts = [rec.cron];
  const prefix = rec.cwd === false ? '' : `cd ${root} && `;
  const env = rec.env
    ? Object.entries(rec.env).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
    : '';
  parts.push(`${prefix}${env}${rec.command}`);
  let line = parts.join(' ');
  if (rec.log) line += ` >> ${rec.log} 2>&1`;
  return line;
}

// renderCrontab(jobs, root) — sorted by job name so the output is stable and
// diffs are readable. Trailing newline is required: cron silently ignores a
// final line with no newline after it.
function renderCrontab(jobs, root) {
  const names = Object.keys(jobs).filter(n => jobs[n].cron).sort();
  const lines = names.map(n => renderLine(n, jobs[n], root));
  return [...HEADER, '', ...lines, ''].join('\n');
}

// diffCrontab(rendered, live) — set comparison over schedule lines only.
// Comments and blanks are not schedule, so they never trip drift detection.
function significant(text) {
  return (text || '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim() && !l.trim().startsWith('#'));
}

function diffCrontab(rendered, live) {
  const want = significant(rendered);
  const have = significant(live);
  const haveSet = new Set(have);
  const wantSet = new Set(want);
  const missing = want.filter(l => !haveSet.has(l));   // in registry, not on the box
  const extra = have.filter(l => !wantSet.has(l));     // on the box, not in the registry
  return { inSync: missing.length === 0 && extra.length === 0, missing, extra };
}

module.exports = { renderCrontab, renderLine, diffCrontab, HEADER, ROOT };

if (require.main === module && !process.argv.includes('--smoke')) {
  if (process.argv.includes('--check')) {
    const { execFileSync } = require('child_process');
    let live = '';
    try {
      live = execFileSync('crontab', ['-l'], { encoding: 'utf8' });
    } catch (err) {
      console.error(`render-crontab --check: could not read the live crontab: ${err.message}`);
      process.exit(1);
    }
    const d = diffCrontab(renderCrontab(JOBS, ROOT), live);
    if (d.inSync) {
      console.log('crontab in sync with lib/job-registry.js');
      process.exit(0);
    }
    console.error('CRONTAB DRIFT detected:');
    for (const l of d.missing) console.error(`  MISSING (in registry, not on the box): ${l}`);
    for (const l of d.extra) console.error(`  EXTRA   (on the box, not in registry):  ${l}`);
    process.exit(1);
  }
  process.stdout.write(renderCrontab(JOBS, ROOT));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node scripts/render-crontab.js --smoke
node scripts/render-crontab.js | head -20
node lib/job-registry.js --smoke
```
Expected: `smoke: 13 pass, 0 fail`; the printed crontab shows the header plus one line per scheduled job.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-crontab.js
git commit -m "feat(alerting): generate the crontab from the registry, with --check for drift"
```

---

### Task 3: Reconcile the droplet

**Files:** none — deployment.

Phase 2's acceptance: *"rendered crontab is byte-identical to the droplet's live `crontab -l` after one reconciliation; `--check` fails when a line is hand-edited; `premarket-quality-measure` is present."*

- [ ] **Step 1: Diff before changing anything**

```bash
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && node scripts/render-crontab.js --check'
```
Expected: **drift, listing differences**. Read every `MISSING`/`EXTRA` line. `MISSING` should be only formatting normalisation (whitespace). Any `EXTRA` line is a real finding — a job running on the box that the registry does not know about. **Stop and report if an EXTRA line is a genuine job**, rather than deleting it.

- [ ] **Step 2: Back up the live crontab before replacing it**

```bash
ssh cohort-droplet 'crontab -l > /root/crontab-backup-2026-08-17.txt && wc -l /root/crontab-backup-2026-08-17.txt'
```

- [ ] **Step 3: Install the rendered crontab**

```bash
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && node scripts/render-crontab.js | crontab -'
```

- [ ] **Step 4: Prove it is now in sync**

```bash
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && node scripts/render-crontab.js --check'
```
Expected: `crontab in sync with lib/job-registry.js`, exit 0.

- [ ] **Step 5: Prove `--check` actually catches a hand edit**

A green check proves nothing unless it can go red. Add a rogue line, confirm detection, then restore:

```bash
ssh cohort-droplet '(crontab -l; echo "0 0 * * * node /opt/rogue.js") | crontab -'
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && node scripts/render-crontab.js --check; echo "exit=$?"'
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && node scripts/render-crontab.js | crontab -'
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && node scripts/render-crontab.js --check'
```
Expected: the middle command reports `EXTRA … node /opt/rogue.js` and `exit=1`; the last returns to in-sync.

- [ ] **Step 6: Confirm the job count is unchanged**

```bash
ssh cohort-droplet 'crontab -l | grep -vc "^#\|^$"'
```
Expected: 24 — the same number of scheduled lines as the pre-change backup. If it dropped, a job was lost; restore from `/root/crontab-backup-2026-08-17.txt` immediately.
