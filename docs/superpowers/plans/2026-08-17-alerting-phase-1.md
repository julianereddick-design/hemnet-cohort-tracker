# Alerting Phase 1 — make liveness answerable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scheduled Node script writes a `cron_job_log` row, so "did it run?" becomes an answerable question. Today only 12 of ~23 do; the other eleven can fail indefinitely in silence.

**Architecture:** The seven unwrapped scripts share one exact shape: a self-contained `run()` (or `main()`) that opens its own client, and an entry gate ending `run().catch(err => { …; process.exit(1) })`. Rather than refactor seven different client lifecycles — one has *two* clients — we wrap only at the entry point with a new `runReporter()` helper. The body of every reporter is untouched, so regression risk is near zero.

**The failure-signal bridge:** these scripts already signal a failed Slack delivery by setting `process.exitCode = 1` and continuing (a contract locked by existing assertions in `lib/slack-post.js --smoke`). `runReporter` reads that after `run()` resolves and converts it into a thrown error, which `runJob` records as `failure`. This satisfies the acceptance criterion without touching the post logic or breaking the existing assertions.

**Tech Stack:** Node.js (CommonJS), `pg`. **No test framework** — offline `--smoke` blocks, run as `node <file> --smoke`.

**Spec:** `docs/superpowers/specs/2026-08-17-alerting-structure-design.md` §7 Phase 1

## Global Constraints

- Offline `--smoke` blocks only. No network, no DB, no real Slack in tests.
- These suites must stay green after every task: `node cron-wrapper.js --smoke`, `node lib/job-registry.js --smoke`, `node lib/slack-post.js --smoke`, `node lib/spotcheck-slack-bot.js --smoke`, `node spotcheck-reaction-poller.js --smoke`, `node lib/spotcheck-review-store.js --smoke`.
- Plus the reporters' own smoke suites: `node sold-match-report.js --smoke`, `node sold-match-trend-chart.js --smoke`, `node sold-match-xlsx.js --smoke`, `node premarket-flow-weekly-report.js --smoke`.
- **Do NOT remove any `process.exitCode = 1`** — `lib/slack-post.js --smoke` asserts its presence in all six posting reporters. Removing it turns a green suite red and drops the failure signal.
- **Do NOT move `runJob` into the `--smoke` branch** of any script. The smoke path must stay fully offline; a `runJob` there would try to reach the DB.
- `scriptName` strings must exactly match the keys already in `lib/job-registry.js`.
- Windows dev box, Linux droplet. Forward slashes in `require()`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `cron-wrapper.js` | modify | Add + export `runReporter()`; smoke coverage for it |
| `weekly-view-report.js` | modify (entry only) | wrap |
| `market-totals-weekly-report.js` | modify (entry only) | wrap |
| `premarket-flow-weekly-report.js` | modify (entry only) | wrap |
| `sold-match-report.js` | modify (entry only) | wrap |
| `age-census-report.js` | modify (entry only) | wrap |
| `sold-match-trend-chart.js` | modify (entry only) | wrap |
| `sold-match-xlsx.js` | modify (entry only) | wrap |
| `lib/job-registry.js` | modify (smoke only) | assert every non-shell job is wrapped |

---

### Task 1: `runReporter()` — the wrapping helper

**Files:**
- Modify: `cron-wrapper.js`

**Interfaces:**
- Consumes: `runJob` (same module).
- Produces: `runReporter({ scriptName: string, run: () => Promise<any> }) => Promise<void>`
  - Calls `run()` inside `runJob`'s `main`. Throws if `process.exitCode === 1` on return.
  - Returns a result summary `{ reporter: true, exitCode }` for `cron_job_log.result_summary`.

- [ ] **Step 1: Write the failing test**

Add to the `--smoke` block in `cron-wrapper.js`, immediately before the `console.log(\`smoke: …\`)` line:

```js
    const { runReporter } = module.exports;

    // These seven reporters are self-contained: each opens its own client and
    // signals a failed Slack delivery with process.exitCode = 1 rather than by
    // throwing. runReporter is the bridge that turns that into a failure row.
    await checkAsync('runReporter is exported and is a function', async () => {
      assert.strictEqual(typeof runReporter, 'function');
    });

    await checkAsync('a reporter that sets exitCode=1 is turned into a throw', async () => {
      // buildReporterMain is the pure inner half — no DB, no runJob.
      const { buildReporterMain } = module.exports;
      const main = buildReporterMain('weekly-view-report', async () => { process.exitCode = 1; });
      const saved = process.exitCode;
      await assert.rejects(() => main(null, () => {}), /exitCode/,
        'a failed Slack delivery must become a failure row, not a silent success');
      process.exitCode = saved;
    });

    await checkAsync('a clean reporter run resolves and reports its exit code', async () => {
      const { buildReporterMain } = module.exports;
      let ran = false;
      const main = buildReporterMain('sold-match-xlsx', async () => { ran = true; });
      const res = await main(null, () => {});
      assert.strictEqual(ran, true, 'run() must actually be invoked');
      assert.strictEqual(res.reporter, true);
    });

    await checkAsync('a throwing reporter propagates its own error unchanged', async () => {
      const { buildReporterMain } = module.exports;
      const main = buildReporterMain('sold-match-report', async () => { throw new Error('db exploded'); });
      await assert.rejects(() => main(null, () => {}), /db exploded/,
        'the original error must survive — it is what lands in cron_job_log.error_message');
    });

    // A reporter left exitCode=1 from a PREVIOUS unrelated cause would otherwise
    // be misreported. Only a transition during run() counts.
    await checkAsync('a pre-existing non-zero exitCode is not blamed on this run', async () => {
      const { buildReporterMain } = module.exports;
      const saved = process.exitCode;
      process.exitCode = 1;
      const main = buildReporterMain('age-census-report', async () => { /* clean run */ });
      const res = await main(null, () => {});
      assert.strictEqual(res.reporter, true, 'a clean run must not inherit an earlier exitCode');
      process.exitCode = saved;
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cron-wrapper.js --smoke`
Expected: FAIL — 5 new cases error with `runReporter is not a function` / `buildReporterMain is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add above `module.exports` in `cron-wrapper.js`:

```js
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
```

Extend the exports:

```js
module.exports = { runJob, makeFatalHandlers, buildAlertText, runReporter, buildReporterMain };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node cron-wrapper.js --smoke
node lib/slack-post.js --smoke
```
Expected: wrapper `smoke: 16 pass, 0 fail`; slack-post `22 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cron-wrapper.js
git commit -m "feat(alerting): runReporter wraps a self-contained reporter in runJob"
```

---

### Task 2: Wrap the five reporters

**Files:**
- Modify (entry gate only): `weekly-view-report.js`, `market-totals-weekly-report.js`, `premarket-flow-weekly-report.js`, `sold-match-report.js`, `age-census-report.js`

**Interfaces:**
- Consumes: `runReporter` from `./cron-wrapper` (Task 1).
- Produces: nothing new — these are leaf scripts.

Each edit is the same two changes: add the `require`, and replace the single `X().catch(...)` line. **Nothing else in these files changes.**

- [ ] **Step 1: Write the failing test**

Add to the `--smoke` block in `lib/job-registry.js`, before its `console.log`:

```js
  // Phase 1: every registered job that is a Node script must write a cron_job_log
  // row. Before this phase only 12 of ~23 did; the rest could fail indefinitely
  // in silence. `shell: true` jobs (find/xargs retention lines) never can.
  check('every non-shell, non-deprecated registry job is wrapped in runJob', () => {
    const root = path.join(__dirname, '..');
    const missing = [];
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.shell || rec.deprecated) continue;
      const candidates = [
        path.join(root, `${job}.js`),
        path.join(root, 'scripts', `${job}.js`),
      ];
      const file = candidates.find(p => fs.existsSync(p));
      if (!file) { missing.push(`${job} (no script found)`); continue; }
      const src = fs.readFileSync(file, 'utf8');
      const wrapped = /require\(['"][^'"]*cron-wrapper['"]\)/.test(src)
        && new RegExp(`scriptName:\\s*['"]${job}['"]`).test(src);
      if (!wrapped) missing.push(job);
    }
    assert.deepStrictEqual(missing, [], `these jobs write no cron_job_log row: ${missing.join(', ')}`);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/job-registry.js --smoke`
Expected: FAIL — lists the seven unwrapped jobs (`weekly-view-report, market-totals-weekly-report, premarket-flow-weekly-report, sold-match-report, age-census-report, sold-match-trend-chart, sold-match-xlsx`). `cron-health-slack` may also appear; leave it — Task 4 handles it.

- [ ] **Step 3: Write minimal implementation**

**3a. `weekly-view-report.js`** — add after line 4 (`const { postMessage } = …`):

```js
const { runReporter } = require('./cron-wrapper');
```

Replace line 128:

```js
  run().catch(err => { console.error('Error:', err.message); process.exit(1); });
```

with:

```js
  runReporter({ scriptName: 'weekly-view-report', run });
```

**3b. `market-totals-weekly-report.js`** — add the same `require` next to its other top-level requires, then replace line 169:

```js
  run().catch(err => { console.error(err); process.exit(1); });
```
with:
```js
  runReporter({ scriptName: 'market-totals-weekly-report', run });
```

**3c. `premarket-flow-weekly-report.js`** — add the same `require`, then replace line 310 (inside the `else` branch, **not** the `--smoke` branch):

```js
    run().catch(err => { console.error(err); process.exit(1); });
```
with:
```js
    runReporter({ scriptName: 'premarket-flow-weekly-report', run });
```

**3d. `sold-match-report.js`** — add the same `require`, then replace line 546 (inside the `else` branch):

```js
    run().catch((err) => { console.error(err); process.exit(1); });
```
with:
```js
    runReporter({ scriptName: 'sold-match-report', run });
```

**3e. `age-census-report.js`** — note this one's entry function is `main`, not `run`. Add the same `require`, then replace line 663:

```js
    main().catch(e => { console.error('Error:', e.message); process.exit(1); });
```
with:
```js
    runReporter({ scriptName: 'age-census-report', run: main });
```

- [ ] **Step 4: Run tests to verify**

```bash
node lib/job-registry.js --smoke
node lib/slack-post.js --smoke
node sold-match-report.js --smoke
node premarket-flow-weekly-report.js --smoke
node --check weekly-view-report.js
node --check market-totals-weekly-report.js
node --check age-census-report.js
```
Expected: registry smoke now lists only `sold-match-trend-chart`, `sold-match-xlsx` (and possibly `cron-health-slack`) as missing; every other command exits 0 with no failures.

- [ ] **Step 5: Commit**

```bash
git add weekly-view-report.js market-totals-weekly-report.js premarket-flow-weekly-report.js sold-match-report.js age-census-report.js lib/job-registry.js
git commit -m "feat(alerting): wrap the five Slack reporters in runJob"
```

---

### Task 3: Wrap the two sold-match artifact jobs

**Files:**
- Modify (entry gate only): `sold-match-trend-chart.js`, `sold-match-xlsx.js`

**Interfaces:**
- Consumes: `runReporter` from `./cron-wrapper`.
- Produces: nothing new.

These two use a different entry shape — `if (require.main === module && process.argv.includes('--smoke'))` followed by `else if (require.main === module)`. The `runJob` call goes only in the second branch.

- [ ] **Step 1: Confirm the test still fails for these two**

Run: `node lib/job-registry.js --smoke`
Expected: FAIL, naming `sold-match-trend-chart` and `sold-match-xlsx`.

- [ ] **Step 2: Write the implementation**

**2a. `sold-match-trend-chart.js`** — add near the top-level requires:

```js
const { runReporter } = require('./cron-wrapper');
```

Replace line 249:

```js
  run().catch((err) => { console.error('Error:', err.message); process.exit(1); });
```
with:
```js
  runReporter({ scriptName: 'sold-match-trend-chart', run });
```

**2b. `sold-match-xlsx.js`** — add the same `require`, then replace line 232:

```js
  run().catch((err) => { console.error('Error:', err.message); process.exit(1); });
```
with:
```js
  runReporter({ scriptName: 'sold-match-xlsx', run });
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
node sold-match-trend-chart.js --smoke
node sold-match-xlsx.js --smoke
node lib/job-registry.js --smoke
```
Expected: both script smokes pass offline (proving `runJob` did NOT leak into the `--smoke` branch — if it had, they would try to reach the DB and hang or fail). Registry smoke now names at most `cron-health-slack`.

- [ ] **Step 4: Commit**

```bash
git add sold-match-trend-chart.js sold-match-xlsx.js
git commit -m "feat(alerting): wrap sold-match-trend-chart and sold-match-xlsx in runJob"
```

---

### Task 4: Wrap the watchdog itself

**Files:**
- Modify (entry gate only): `cron-health-slack.js`

**Interfaces:**
- Consumes: `runReporter` from `./cron-wrapper`.

Spec §4.3 (Hardening): *"wrap the watchdog in `runJob` so its own death is at least forensically visible."* The watchdog cannot detect its own death — that is an accepted limit in §5 — but a `cron_job_log` row makes it visible afterwards. It is registered tier 2, so a failure logs and posts without a mention.

- [ ] **Step 1: Write the implementation**

Add near the top-level requires of `cron-health-slack.js`:

```js
const { runReporter } = require('./cron-wrapper');
```

Replace line 287:

```js
  run().catch(err => { console.error('Error:', err.message); process.exit(1); });
```
with:
```js
  runReporter({ scriptName: 'cron-health-slack', run });
```

- [ ] **Step 2: Verify no circular-require breakage**

`cron-health-slack.js` requires `cron-wrapper`, which requires `lib/job-registry` and `lib/slack-post`. None of those require `cron-health-slack`, so there is no cycle. Confirm:

```bash
node --check cron-health-slack.js
node -e "require('./cron-health-slack.js'); console.log('loaded without cycle or side effect')"
```
Expected: exits 0, prints the message, and does **not** start a run (the `require.main` gate prevents it).

- [ ] **Step 3: Run the full suite**

```bash
node lib/job-registry.js --smoke
node cron-wrapper.js --smoke
node lib/slack-post.js --smoke
node lib/spotcheck-slack-bot.js --smoke
node spotcheck-reaction-poller.js --smoke
node lib/spotcheck-review-store.js --smoke
node sold-match-report.js --smoke
node sold-match-trend-chart.js --smoke
node sold-match-xlsx.js --smoke
node premarket-flow-weekly-report.js --smoke
```
Expected: every one ends with `0 fail` / `0 failed`. The registry coverage check must now report **no** unwrapped jobs — that is the Phase 1 acceptance criterion.

- [ ] **Step 4: Commit**

```bash
git add cron-health-slack.js
git commit -m "feat(alerting): wrap the watchdog in runJob so its own death is visible"
```

---

### Task 5: Live verification

**Files:** none.

Phase 1's acceptance is behavioural: *"all ~23 scheduled scripts write a `cron_job_log` row; a deliberately failed reporter post produces a `failure` row."*

- [ ] **Step 1: Prove a clean wrapped run writes a success row**

On the droplet, pick the cheapest reporter (`sold-match-xlsx` is DB-only, no Slack post):

```bash
cd /opt/hemnet-cohort-tracker && node sold-match-xlsx.js
```
Then confirm a terminal row exists:
```bash
node -e "require('dotenv').config(); const {createClient}=require('./db'); (async()=>{const c=createClient(); await c.connect(); const r=await c.query(\"SELECT script_name, status, duration_ms FROM cron_job_log WHERE script_name='sold-match-xlsx' ORDER BY id DESC LIMIT 1\"); console.log(r.rows); await c.end();})()"
```
Expected: one row, `status='success'`, non-null `duration_ms`. Before Phase 1 this script wrote no row at all.

- [ ] **Step 2: Prove a failed post writes a `failure` row**

Force a Slack failure by pointing the bot at a bad token *for one run only*, on a reporter that posts:

```bash
cd /opt/hemnet-cohort-tracker && SLACK_BOT_TOKEN=xoxb-invalid SLACK_WEBHOOK_URL=https://hooks.slack.com/services/INVALID node market-totals-weekly-report.js
```
Expected: exit code 1, and a `cron_job_log` row with `status='failure'` whose `error_message` names the reporter and `process.exitCode=1`. Confirm with the same query, substituting the script name.

**This is the criterion that matters** — before Phase 1 a lost report exited non-zero into a log file nobody read and wrote no row at all.

- [ ] **Step 3: Confirm the full job count**

```bash
node -e "require('dotenv').config(); const {createClient}=require('./db'); (async()=>{const c=createClient(); await c.connect(); const r=await c.query(\"SELECT count(DISTINCT script_name)::int AS n FROM cron_job_log WHERE started_at > NOW() - INTERVAL '30 days'\"); console.log('distinct jobs logging in last 30d:', r.rows[0].n); await c.end();})()"
```
Note this only rises as each job next fires on its own schedule — a weekly job will not appear until its next Monday. Record the number and the date; the full set is not expected same-day.

- [ ] **Step 4: Clean up any test rows you created**

Delete only rows you caused, by `script_name` and `id`, after inspecting them.
