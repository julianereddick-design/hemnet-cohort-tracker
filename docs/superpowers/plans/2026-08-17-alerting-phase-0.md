# Alerting Phase 0 — make today honest and quiet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `cron-wrapper` from silently swallowing the failure modes that kill long-running jobs, cut the spot-check review queue's channel volume by ~90% via threading, and make tier-1 alerts the only thing that notifies a human.

**Architecture:** Three independent changes to existing files plus one new data file. `lib/job-registry.js` becomes the single source of truth for job tier (Phase 2 of the design extends the same file with cron/command/assert — it is created here with `tier` only, deliberately). `cron-wrapper.js` gains one shared alert path that both the normal try/catch and the fatal/signal handlers use, so there is exactly one place that decides what an alert looks like. `lib/spotcheck-slack-bot.js` gains an optional `threadTs` and `cohort-spotcheck-gate.js` posts one parent before the per-pair loop.

**Tech Stack:** Node.js (CommonJS), `pg`, raw `https` for Slack. **No test framework** — this repo's convention is an offline `--smoke` self-test block at the bottom of each module, run as `node <file> --smoke`. Follow it exactly; do not introduce jest/mocha/node:test.

**Spec:** `docs/superpowers/specs/2026-08-17-alerting-structure-design.md` (§4.2 wrapper bug, §4.5 delivery, §7 Phase 0)

## Global Constraints

- **Test convention:** offline `--smoke` block guarded by `if (require.main === module && process.argv.includes('--smoke'))`. No network, no DB, no real Slack. Ends with `console.log(\`smoke: ${pass} pass, ${fail} fail\`)` and `process.exit(fail === 0 ? 0 : 1)`.
- **Existing smoke suites must stay green.** After every task run all three: `node lib/slack-post.js --smoke`, `node lib/spotcheck-slack-bot.js --smoke`, `node spotcheck-reaction-poller.js --smoke`.
- **`postAlert` and `postMessage` signal failure by RETURNING `{ok:false}`, never by throwing** — except `postAlert` can *reject* on a malformed `SLACK_WEBHOOK_URL` (`new URL()` inside an async function). Every call site needs both a `result.ok` branch and a `try/catch`.
- **Never regress the per-pair `ts` model.** Each reviewable pair must keep its own Slack `ts`; `spotcheck_review` rows are keyed on it and `partitionSharedTs` refuses to act on any rows sharing one `(channel, ts)`.
- **Job names are exact `cron_job_log.script_name` values**, i.e. the `scriptName:` string passed to `runJob`. A registry key that does not match one is dead weight.
- **Windows dev box, Linux droplet.** Use forward slashes in `require()` paths. Commit messages use the repo's conventional-commit style (`fix(scope): ...`).
- `DRY_RUN=1` / `SLACK_DRY_RUN=1` are the only reliable post guards — `dotenv` re-injects `SLACK_BOT_TOKEN`, so `env -u` does **not** prevent a real post.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/job-registry.js` | **create** | The tier of every scheduled job, keyed by `script_name`. Phase 2 adds `cron`/`command`/`assert` to the same records. |
| `cron-wrapper.js` | modify | One shared alert path; fatal/signal handlers alert before exiting; tier decides the mention. |
| `lib/spotcheck-slack-bot.js` | modify | Optional `threadTs` on `postReviewMessage` / `postInfoMessage`. |
| `cohort-spotcheck-gate.js` | modify (~L395-444) | Post one parent, thread every pair under it, degrade to top-level if the parent fails. |
| `spotcheck-reaction-poller.js` | modify (smoke block only) | Prove threaded replies survive the `partitionSharedTs` guard. |

---

### Task 1: `lib/job-registry.js` — tier as a single source of truth

**Files:**
- Create: `lib/job-registry.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `module.exports = { JOBS, tierOf }`.
  - `JOBS`: `Record<string, { tier: 1|2, deprecated?: true, note?: string }>` keyed by `cron_job_log.script_name`.
  - `tierOf(scriptName: string) => 1 | 2 | null` — `null` means "not in the registry", which callers must treat as a loud failure, never as a default tier.

Tiers are copied verbatim from spec §3. The two "corrected to tier 1" jobs (`cohort-spotcheck-gate`, `sold-match-batch`) are the whole point of that table — do not re-classify them.

- [ ] **Step 1: Write the failing test**

Create `lib/job-registry.js` containing **only** the smoke block below (no implementation yet), so the first run fails for the right reason:

```js
'use strict';

module.exports = {};

// ---------------------------------------------------------------
// --smoke self-test (offline: no network, no DB, no Slack)
//   node lib/job-registry.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');
  const { JOBS, tierOf } = module.exports;
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('exports JOBS and tierOf', () => {
    assert.strictEqual(typeof JOBS, 'object', 'JOBS is not an object');
    assert.strictEqual(typeof tierOf, 'function', 'tierOf is not a function');
  });

  check('every tier is exactly 1 or 2', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      assert.ok(rec.tier === 1 || rec.tier === 2, `${job} has tier ${JSON.stringify(rec.tier)}`);
    }
  });

  // The spec's §3 tier-1 table, verbatim. Two of these were *corrected* to tier 1
  // during design (the gate re-fetches live pages; the sold-match sampler uses a
  // sliding 14d lookback) — a silent demotion here would undo that decision.
  check('every tier-1 job from the design doc is tier 1', () => {
    const TIER1 = [
      'cohort-create', 'market-totals-daily', 'premarket-flow-measure',
      'premarket-quality-measure', 'age-census-monthly', 'cohort-track',
      'hemnet-targeted-refresh', 'booli-targeted-refresh', 'booli-targeted-discovery',
      'hemnet-targeted-match', 'cohort-spotcheck-gate', 'sold-match-batch',
    ];
    for (const job of TIER1) {
      assert.ok(JOBS[job], `${job} is missing from the registry entirely`);
      assert.strictEqual(JOBS[job].tier, 1, `${job} must be tier 1 (spec §3)`);
    }
  });

  check('the recoverable reporters are tier 2', () => {
    for (const job of ['spotcheck-reaction-poller', 'weekly-view-report', 'sold-match-report']) {
      assert.strictEqual(JOBS[job] && JOBS[job].tier, 2, `${job} must be tier 2 (spec §3)`);
    }
  });

  check('tierOf returns null for an unknown job, never a default', () => {
    assert.strictEqual(tierOf('not-a-real-job'), null);
    assert.strictEqual(tierOf(undefined), null);
    assert.strictEqual(tierOf('cohort-create'), 1);
    assert.strictEqual(tierOf('spotcheck-reaction-poller'), 2);
  });

  // Coverage: a job that runs under runJob but is absent here would alert as a
  // registry gap on every single run. Catch that here instead of in the channel.
  check('every runJob scriptName in the repo is in the registry', () => {
    const root = path.join(__dirname, '..');
    const found = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (!/require\(['"][^'"]*cron-wrapper['"]\)/.test(src)) continue;
        for (const m of src.matchAll(/scriptName:\s*['"]([a-z0-9-]+)['"]/g)) found.add(m[1]);
      }
    };
    walk(path.join(root, 'lib'));
    walk(path.join(root, 'scripts'));
    walk(root);
    for (const job of found) {
      assert.ok(JOBS[job], `${job} runs under runJob but is not in lib/job-registry.js`);
    }
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/job-registry.js --smoke`
Expected: FAIL — `smoke: 0 pass, 6 fail`, first line `SMOKE FAIL [exports JOBS and tierOf]: JOBS is not an object`.

- [ ] **Step 3: Write minimal implementation**

Replace `module.exports = {};` with the registry. Keep the smoke block exactly as written.

```js
'use strict';

// lib/job-registry.js
//
// The single source of truth for what each scheduled job IS. Read by
// cron-wrapper.js (tier decides whether an alert @-mentions) and, from Phase 2
// of docs/superpowers/specs/2026-08-17-alerting-structure-design.md, by the
// crontab renderer and the watchdog.
//
// Keys are exact `cron_job_log.script_name` values — the `scriptName:` string
// passed to runJob. A key that matches no runJob call is dead weight; a runJob
// call with no key here alerts as a registry gap on every run (both are caught
// by the --smoke coverage check below).
//
// tier 1 = perishable. A missed run destroys an observation that can never be
//          recovered, because the window closed. Interrupts a human.
// tier 2 = recoverable. Pure renders from our own DB, or state that persists
//          elsewhere. Re-runnable at any time, so it waits for the digest.
//
// The tier line falls almost exactly on capture-vs-render (spec §3): anything
// that reaches out and observes the market is perishable; anything that reads
// our own DB and draws a picture is not.
//
//   node lib/job-registry.js --smoke

const JOBS = {
  // ---- tier 1: capture ----
  'cohort-create':             { tier: 1 },  // Mon 06:00 — a missed week can never exist
  'market-totals-daily':       { tier: 1 },  // daily 08:30 — yesterday is unscrapeable
  'premarket-flow-measure':    { tier: 1 },  // Mon 08:50 — the 2026-07-20 loss
  'premarket-quality-measure': { tier: 1 },  // Mon 09:00 — samples live listings; they churn
  'age-census-monthly':        { tier: 1 },  // 1st 02:00 — a missed month is blank forever
  'cohort-track':              { tier: 1 },  // every 2d 22:00 — the interval increment is lost
  'hemnet-targeted-refresh':   { tier: 1 },  // every 2d 14:00 — feeds cohort-track 8h later
  'booli-targeted-refresh':    { tier: 1 },  // every 2d 14:00 — same, Booli side
  'booli-targeted-discovery':  { tier: 1 },  // Sun 22:00 — the pool Monday draws from
  'hemnet-targeted-match':     { tier: 1 },  // Mon 03:00 — 3h before cohort-create

  // Corrected to tier 1 during design (spec §3). Both LOOK like QA/reporting and
  // are not: they re-observe live pages, so a late re-run measures something else.
  'cohort-spotcheck-gate':     { tier: 1 },  // re-fetches both listing pages live; delisted
                                             // pairs become permanently unreviewable
  'sold-match-batch':          { tier: 1 },  // sliding 14d lookback + even-ISO-week gate, so a
                                             // later re-run samples a different fortnight

  // ---- tier 2: render / recoverable ----
  'spotcheck-reaction-poller':    { tier: 2 },  // reactions persist in Slack
  'weekly-view-report':           { tier: 2 },
  'market-totals-weekly-report':  { tier: 2 },
  'premarket-flow-weekly-report': { tier: 2 },
  'sold-match-report':            { tier: 2 },
  'age-census-report':            { tier: 2 },
  'sold-match-trend-chart':       { tier: 2 },
  'sold-match-xlsx':              { tier: 2 },
  'cron-health-slack':            { tier: 2 },  // the watchdog itself; its own death is an
                                                // accepted limit (spec §5), not a tier-1 alert

  // Deprecated 2026-08-13, unscheduled, no downstream consumer. Listed only so
  // the coverage check stays honest — it still requires cron-wrapper.
  'sfpl-region-snapshot': { tier: 2, deprecated: true, note: 'removed from the crontab 2026-08-13' },
};

// tierOf(scriptName) -> 1 | 2 | null
// null means "not in the registry". Callers MUST treat that as a fault to be
// surfaced, never as a default tier — guessing tier 2 would silence a new
// perishable job, and guessing tier 1 would hide the registry gap behind noise.
function tierOf(scriptName) {
  const rec = JOBS[scriptName];
  return rec ? rec.tier : null;
}

module.exports = { JOBS, tierOf };
```

> The five reporters, `sold-match-trend-chart` and `sold-match-xlsx` do not run under
> `runJob` yet (that is Phase 1 of the spec). They are listed now because their tier is a
> design decision, not an implementation detail, and Phase 1 should not have to re-litigate it.
> The coverage check only requires the reverse direction, so listing them early is safe.

- [ ] **Step 4: Run test to verify it passes**

Run: `node lib/job-registry.js --smoke`
Expected: PASS — `smoke: 6 pass, 0 fail`.

If the coverage check names a job you did not expect, **do not invent a tier for it.** Stop and report it — an unclassified scheduled job is a finding, not a merge conflict.

- [ ] **Step 5: Commit**

```bash
git add lib/job-registry.js
git commit -m "feat(alerting): job registry carrying tier as the single source of truth"
```

---

### Task 2: `cron-wrapper` alerts before it dies

**Files:**
- Modify: `cron-wrapper.js:59-82` (the handlers) and `cron-wrapper.js:128-143` (the alert path)

**Interfaces:**
- Consumes: `postAlert` from `lib/slack-post` (already imported at `cron-wrapper.js:2`).
- Produces (module-internal, exported **only** for the smoke block):
  - `makeFatalHandlers({ scriptName, log, recoverRow, alert, exit }) => { handleFatal, handleSignal }`
    - `recoverRow(status: 'failure'|'killed', message: string) => Promise<void>`
    - `alert(status: 'failure'|'killed', message: string) => Promise<void>` — must never throw
    - `exit(code: number) => void`
  - Both handlers are `async` and **await `alert` before `recoverRow` before `exit`**.

**Why a factory:** the handlers are registered on `process`, so they cannot be reached from a test. Extracting them behind injected deps makes the ordering testable offline, which is the only property that actually matters here. Injecting `exit` is what stops the smoke run from killing itself.

**Why alert first:** `recoverRow` opens a *second* DB connection. If the DB is what broke, it can hang for up to `statement_timeout` and a SIGKILL may land first. The alert is the part that reaches a human, so it goes first. Neither can prevent the other — each is individually guarded.

- [ ] **Step 1: Write the failing test**

Append to `cron-wrapper.js`, after `module.exports`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cron-wrapper.js --smoke`
Expected: FAIL — every case errors with `makeFatalHandlers is not a function`.

- [ ] **Step 3: Write minimal implementation**

**3a.** Replace `cron-wrapper.js:59-82` (from `// Process-level safety` through the last `process.on('SIGINT', ...)` line) with:

```js
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
```

Also delete the now-unused `let shuttingDown = false;` at `cron-wrapper.js:38` — re-entrancy state now lives inside the factory.

**3b.** Add the factory and the shared alert helper *above* `async function runJob(...)`:

```js
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
```

**3c.** Inside `runJob`, add the shared alert helper next to `recoverRow` (it closes over `scriptName` and `log`, and is the *only* place an alert is built — the normal path and the fatal path must not drift apart):

```js
  // The single alert path. Both the normal try/catch below and the fatal/signal
  // handlers above go through here, so there is exactly one place that decides
  // what an alert looks like.
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
```

**3d.** Replace the normal-path alert block at `cron-wrapper.js:128-143` with:

```js
  // Slack alert on failure/warning. Webhook only, by design — see lib/slack-post.js postAlert.
  if (status === 'failure' || status === 'warning') {
    await sendAlert(status === 'failure' ? 'FAILURE' : 'WARNING', `${scriptName}: ${errorMessage}`);
  }
```

**3e.** Export the factory for the smoke block, keeping `runJob` first:

```js
module.exports = { runJob, makeFatalHandlers };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node cron-wrapper.js --smoke
node lib/slack-post.js --smoke
```
Expected: `smoke: 6 pass, 0 fail` from the wrapper. `lib/slack-post.js --smoke` must still end `0 failed` — it asserts that `cron-wrapper.js` contains no `sendSlackAlert(`, does contain `postAlert`, and that `await postAlert()` sits inside a `try {...} catch`. Step 3c keeps all three true; if its regex assertion trips, check that the `try` block around `await postAlert` in `sendAlert` has no intervening `}` within 400 chars.

- [ ] **Step 5: Commit**

```bash
git add cron-wrapper.js
git commit -m "fix(alerting): uncaught exceptions and signals must alert, not just log

handleFatal/handleSignal called recoverRow then process.exit(1) and never
reached postAlert, so every OOM kill and SIGTERM wrote a cron_job_log row and
alerted nobody. Both paths now share one guarded sendAlert, alert-first."
```

---

### Task 3: thread the spot-check review queue

**Files:**
- Modify: `lib/spotcheck-slack-bot.js` (`slackApiPost` call sites in `postReviewMessage`, `postInfoMessage`)
- Modify: `cohort-spotcheck-gate.js:419-444`
- Modify: `spotcheck-reaction-poller.js` (smoke block only)

**Interfaces:**
- Consumes: `resolveChannel('cohort-spotcheck-gate')` from `lib/slack-post` (already wired at `cohort-spotcheck-gate.js:37`).
- Produces:
  - `postReviewMessage(channel, pair, opts = {}) => { ok, ts, channel } | null` — `opts.threadTs?: string`
  - `postInfoMessage(channel, text, opts = {}) => { ok, ts, channel } | null` — `opts.threadTs?: string`

The parent is posted with `postInfoMessage` (no `threadTs`), deliberately: it carries no emoji legend and gets no `spotcheck_review` row, so a stray reaction on it does nothing. Every reply keeps its **own** `ts` — Slack assigns one per message in a thread — so `spotcheck_review` rows, `getReactions(channel, ts)` and the `partitionSharedTs` guard are all unchanged.

- [ ] **Step 1: Write the failing test**

**1a.** Add to the `--smoke` block in `lib/spotcheck-slack-bot.js`, before the `if (savedToken !== undefined)` restore line.

The smoke block runs with `SLACK_BOT_TOKEN` deleted, so every `post*` function short-circuits to `null` and the request body is never observable. Rather than stub `https.request`, extract the body builders as pure functions — `reviewBody(channel, pair, opts)` and `infoBody(channel, text, opts)` — and assert on what they return. The body is where threading lives, so that is the thing worth testing.

```js
    // ---- threading (Phase 0): the gate posts ONE parent and threads every pair
    // under it. The dominant channel volume was the gate posting one top-level
    // message per reviewable pair — dozens every Monday.
    check('reviewBody omits thread_ts when not threading', () => {
      const b = reviewBody('C1', { pair_id: 1, hemnet_id: 2, booli_id: 3 });
      assert.strictEqual(b.channel, 'C1');
      assert.ok(!('thread_ts' in b), 'thread_ts must be absent, not undefined-valued');
    });

    check('reviewBody threads under the parent when given a threadTs', () => {
      const b = reviewBody('C1', { pair_id: 1, hemnet_id: 2, booli_id: 3 }, { threadTs: '1755.0001' });
      assert.strictEqual(b.thread_ts, '1755.0001');
      assert.ok(/hemnet\.se\/bostad\/2/.test(b.text), 'threading must not change the message body');
      assert.ok(/booli\.se\/annons\/3/.test(b.text));
      assert.ok(b.text.includes(EMOJI_LEGEND_FOR_TEST), 'the emoji legend must survive threading');
    });

    check('reviewBody never sets reply_broadcast — replies stay inside the thread', () => {
      const b = reviewBody('C1', { pair_id: 1, hemnet_id: 2, booli_id: 3 }, { threadTs: '1755.0001' });
      assert.ok(!('reply_broadcast' in b),
        'reply_broadcast would re-post every reply to the channel, undoing the whole change');
    });

    check('infoBody threads too, so the unreviewable summary joins the parent', () => {
      const b = infoBody('C1', 'summary', { threadTs: '1755.0001' });
      assert.strictEqual(b.thread_ts, '1755.0001');
      assert.strictEqual(b.text, 'summary');
      assert.ok(!('thread_ts' in infoBody('C1', 'parent')), 'the parent itself must be top-level');
    });
```

Add near the top of the smoke block (after `const assert = require('assert');`):

```js
  const { reviewBody, infoBody } = module.exports;
  const EMOJI_LEGEND_FOR_TEST = 'React: ✅ confirm mismatch';
```

**1b.** Add to the `--smoke` block in `spotcheck-reaction-poller.js`, after the existing `partitionSharedTs` checks:

```js
  // Phase 0 threading: replies in a thread each get their OWN ts, so they must
  // all land in `safe`. If Slack ever returned the parent ts for replies, this
  // check turns the whole cohort into unactionable `shared` rows — which is the
  // failure we would rather see here than in production.
  check('partitionSharedTs: threaded per-pair replies are all safe', () => {
    const rows = [
      { pair_id: 1, channel: 'C1', ts: '1755000000.000100' },
      { pair_id: 2, channel: 'C1', ts: '1755000000.000200' },
      { pair_id: 3, channel: 'C1', ts: '1755000000.000300' },
    ];
    const { safe, shared } = partitionSharedTs(rows);
    assert.deepStrictEqual(safe.map(r => r.pair_id), [1, 2, 3]);
    assert.deepStrictEqual(shared, []);
  });

  check('partitionSharedTs: a regression to the parent ts is caught, not acted on', () => {
    const rows = [
      { pair_id: 1, channel: 'C1', ts: '1755000000.000001' },  // parent ts reused —
      { pair_id: 2, channel: 'C1', ts: '1755000000.000001' },  //   the digest-era bug
    ];
    const { safe, shared } = partitionSharedTs(rows);
    assert.deepStrictEqual(safe, []);
    assert.deepStrictEqual(shared.map(r => r.pair_id), [1, 2]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node lib/spotcheck-slack-bot.js --smoke
node spotcheck-reaction-poller.js --smoke
```
Expected: the bot smoke fails 4 cases with `reviewBody is not a function`. The poller smoke **passes** both new cases already — `partitionSharedTs` is unchanged and correct; those two cases are regression locks, not new behaviour. That is the intended outcome; note it and move on.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `lib/spotcheck-slack-bot.js`, extract the two body builders and use them. Replace `postReviewMessage` (from `async function postReviewMessage`) with:

```js
// reviewBody(channel, pair, opts) — PURE chat.postMessage body builder.
// Extracted so threading is testable without a token or a network call.
// opts.threadTs threads the reply under the gate's parent message; each reply
// still gets its own ts from Slack, so spotcheck_review rows and getReactions()
// are unaffected. reply_broadcast is deliberately never set — it would re-post
// every reply to the channel and undo the volume reduction entirely.
function reviewBody(channel, pair, opts = {}) {
  const text = [
    `[REVIEW] ${reviewLabel(pair)} pair ${pair.pair_id} — ${pair.street_address || '(no address)'}`,
    `Hemnet: ${buildHemnetUrl(pair.hemnet_id)}`,
    `Booli:  ${buildBooliUrl(pair.booli_id)}`,
    `${dhashSummary(pair)} | ${visionSummary(pair)}`,
    ...(pair.verdict_reason ? [`Why: ${pair.verdict_reason}`] : []),
    EMOJI_LEGEND,
  ].join('\n');
  const body = { channel, text };
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  return body;
}

async function postReviewMessage(channel, pair, opts = {}) {
  if (!token()) return null;
  const json = await slackApiPost('chat.postMessage', reviewBody(channel, pair, opts));
  if (!json) return null;
  return { ok: json.ok, ts: json.ts, channel: json.channel };
}
```

Replace `postInfoMessage` with:

```js
// infoBody(channel, text, opts) — PURE body builder for a plain post.
function infoBody(channel, text, opts = {}) {
  const body = { channel, text };
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  return body;
}

async function postInfoMessage(channel, text, opts = {}) {
  if (!token()) return null;
  const json = await slackApiPost('chat.postMessage', infoBody(channel, text, opts));
  if (!json) return null;
  return { ok: json.ok, ts: json.ts, channel: json.channel };
}
```

Extend the exports:

```js
module.exports = { postReviewMessage, postDigestMessage, postInfoMessage, getReactions, dhashSummary, visionSummary, reviewLabel, reviewBody, infoBody };
```

**3b.** In `cohort-spotcheck-gate.js`, replace the body of the `if (botToken && reviewChannel) {` block (lines ~419-440) with:

```js
  if (botToken && reviewChannel) {
    const uncertainPairs = uncertainAll.filter(v => !isUnreviewable(v));
    const mismatchPairs  = verdicts.filter(v => v.verdict === 'CONFIRMED_MISMATCH');
    const reviewable     = [...uncertainPairs, ...mismatchPairs];

    // Phase 0 (2026-08-17 alerting design §4.5): ONE parent message, every pair
    // threaded under it. This was the dominant volume in the ops channel — one
    // top-level message per reviewable pair, dozens on a bad Monday — which is
    // what buried three cohort-spotcheck-gate failures in a stream of 59 alerts.
    // Threading removes ~90% of channel-level volume and changes nothing about
    // the reaction protocol: each reply still gets its own ts.
    let threadTs = null;
    if (reviewable.length > 0 || unreviewablePairs.length > 0) {
      const parent = await postInfoMessage(reviewChannel,
        `[REVIEW] ${cohortId}: ${reviewable.length} pair(s) need review` +
        (unreviewablePairs.length > 0 ? `, ${unreviewablePairs.length} unreviewable` : ''));
      // A failed parent must NOT cost us the queue — fall back to top-level posts.
      if (parent && parent.ts) threadTs = parent.ts;
      else log('WARN', 'review queue: parent post failed — posting pairs top-level this run');
    }
    const threadOpts = threadTs ? { threadTs } : {};

    // One message per reviewable pair — UNCERTAIN and MISMATCH alike (own ts each).
    for (const p of reviewable) {
      const res = await postReviewMessage(reviewChannel, p, threadOpts);
      if (res && res.ts) {
        await upsertReviewMessage(client, {
          pairId: p.pair_id, cohortId, channel: reviewChannel, ts: res.ts,
          visionVerdict: p.verdict === 'CONFIRMED_MISMATCH' ? 'MISMATCH'
            : (p.vision ? (p.vision.sharedPhoto === false ? 'MISMATCH' : p.vision.sharedPhoto === true ? 'MATCH' : null) : null),
        });
      }
    }
    // Unreviewable (delisted) pairs: ONE informational post, no review rows.
    if (unreviewablePairs.length > 0) {
      await postInfoMessage(reviewChannel,
        `[SPOT-CHECK] ${cohortId}: ${unreviewablePairs.length} pair(s) unreviewable — listing removed since cohort build: ` +
        unreviewablePairs.map(p => p.pair_id).join(', '), threadOpts);
    }
    log('INFO', `review queue: ${uncertainPairs.length} UNCERTAIN + ${mismatchPairs.length} MISMATCH posted${threadTs ? ` threaded under ${threadTs}` : ' top-level'}; ${unreviewablePairs.length} unreviewable (delisted) diverted`);
  } else if (!botToken) {
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node lib/spotcheck-slack-bot.js --smoke
node spotcheck-reaction-poller.js --smoke
node lib/slack-post.js --smoke
node cron-wrapper.js --smoke
node lib/job-registry.js --smoke
```
Expected: all five end `0 fail` / `0 failed`.

Then syntax-check the gate without executing it:
```bash
node --check cohort-spotcheck-gate.js
```
Expected: no output, exit 0. (`node --check` parses only — it never runs the file, so there is no risk of starting a real gate run.)

- [ ] **Step 5: Commit**

```bash
git add lib/spotcheck-slack-bot.js cohort-spotcheck-gate.js spotcheck-reaction-poller.js
git commit -m "feat(spotcheck): thread the review queue under one parent per cohort

One top-level message per reviewable pair was the dominant ops-channel volume.
Each reply keeps its own ts, so spotcheck_review rows, getReactions and the
partitionSharedTs guard are unchanged — locked by two new regression checks."
```

---

### Task 4: `@`-mention on tier 1 only

**Files:**
- Modify: `cron-wrapper.js` (the `sendAlert` helper from Task 2, plus the two call sites' label arguments)

**Interfaces:**
- Consumes: `tierOf` from `lib/job-registry` (Task 1); `sendAlert` (Task 2).
- Produces: `buildAlertText(scriptName, label, message, tier) => string`, exported for the smoke block.

**Mention syntax:** `<!channel>`, not `@here` or a plain `@name`. The spec flagged uncertainty about whether `link_names` is honoured on the webhook path — `<!channel>` is the escaped form Slack resolves without `link_names`, so it sidesteps that entirely. It still needs a live confirmation (see the verification step).

**Unknown tier is loud, not quiet.** `tierOf` returns `null` for a job absent from the registry. Per spec §4.2 that alerts *and* flags the gap. Defaulting to tier 2 would silence a newly-added perishable job — the exact class of bug the registry exists to prevent.

- [ ] **Step 1: Write the failing test**

Add to the `--smoke` block in `cron-wrapper.js`, before the `console.log(\`smoke: ...\`)` line:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cron-wrapper.js --smoke`
Expected: FAIL — the four `buildAlertText` cases error with `buildAlertText is not a function`. The `digest never mentions` case passes already (regression lock).

- [ ] **Step 3: Write minimal implementation**

**3a.** Add the import at the top of `cron-wrapper.js`, under the existing two:

```js
const { tierOf } = require('./lib/job-registry');
```

**3b.** Add `buildAlertText` next to `makeFatalHandlers` (module scope, above `runJob`):

```js
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
```

**3c.** Rewrite `sendAlert` inside `runJob` to use it:

```js
  async function sendAlert(label, message) {
    const text = buildAlertText(scriptName, label, message, tierOf(scriptName));
    try {
      const res = await postAlert(text);
      log(res.ok ? 'INFO' : 'ERROR', res.ok ? 'Slack alert sent' : 'Slack alert failed');
    } catch (err) {
      log('ERROR', `Slack alert failed: ${err.message}`);
    }
  }
```

**3d.** Export it:

```js
module.exports = { runJob, makeFatalHandlers, buildAlertText };
```

- [ ] **Step 4: Run the full suite to verify it passes**

```bash
node cron-wrapper.js --smoke
node lib/job-registry.js --smoke
node lib/spotcheck-slack-bot.js --smoke
node spotcheck-reaction-poller.js --smoke
node lib/slack-post.js --smoke
node lib/spotcheck-review-store.js --smoke
```
Expected: every one ends `0 fail` / `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cron-wrapper.js
git commit -m "feat(alerting): @-mention tier-1 alerts only, behind a greppable prefix

Tier 1 and the digest share #hemnet-ops, so the mention is what separates a
permanently-lost observation from a late report. An unregistered job is treated
as perishable and names the registry gap rather than defaulting to quiet."
```

---

### Task 5: live verification on the droplet

The spec's Phase 0 acceptance criteria are behavioural and cannot be met by offline smoke tests alone. Do not mark Phase 0 complete without these.

**Files:** none — this is a verification task.

- [ ] **Step 1: Confirm `<!channel>` actually notifies over the webhook**

The webhook path is the one thing this design has never proven live (spec §4.6). On the droplet:

```bash
node -e "require('dotenv').config(); require('./lib/slack-post').postAlert('🚨 TIER1 <!channel> [TEST] webhook mention check — ignore').then(r => console.log(r))"
```
Expected: `{ ok: true }`, and the message in `#hemnet-ops` renders as a highlighted **@channel** that produces a notification — not the literal text `<!channel>`.

**If it renders literally**, stop and report it. The fallback is adding `link_names: 1` to the webhook payload in `lib/slack-post.js:webhookPostMessage`; do not guess at it silently.

- [ ] **Step 2: Confirm a SIGTERM produces an alert**

The incident this phase exists to fix. Run a real job and kill it mid-flight:

```bash
node cohort-track.js &
sleep 20 && kill -TERM %1
```
Expected, in order:
1. stdout logs `Received SIGTERM — marking cron_job_log row killed`, then `Slack alert sent`.
2. `#hemnet-ops` shows `🚨 TIER1 @channel [KILLED] cohort-track: killed by SIGTERM` **with a notification**.
3. The `cron_job_log` row is `killed`, not stranded at `running`:
   ```bash
   node scripts/verify-cron-job-log.js
   ```

Before the fix, step 2 produced nothing at all. That is the whole test.

- [ ] **Step 3: Confirm the gate threads, and that the poller still adjudicates**

On the next Monday gate run (or a manual run against the current cohort), confirm in `#hemnet-ops`:
- **one** top-level `[REVIEW] 2026-Wnn: N pair(s) need review`, with N replies inside its thread — not N top-level messages;
- reactions on a threaded reply behave normally.

Then confirm the guard is satisfied rather than assuming it:
```bash
node -e "require('dotenv').config(); const {createClient}=require('./db'); (async()=>{const c=createClient(); await c.connect(); const r=await c.query(\"SELECT channel, ts, count(*) FROM spotcheck_review WHERE human_verdict IS NULL GROUP BY 1,2 HAVING count(*) > 1\"); console.log(r.rows.length === 0 ? 'OK: no shared-ts rows' : r.rows); await c.end();})()"
```
Expected: `OK: no shared-ts rows`. Any row here means threaded replies shared a `ts` and `partitionSharedTs` will refuse to act on the whole cohort.

- [ ] **Step 4: Confirm the digest does not notify**

```bash
node cron-health-slack.js
```
Expected: the digest lands in `#hemnet-ops` with **no** notification and no `@channel` highlight.

- [ ] **Step 5: Record the result**

Append a dated **"Verified live 2026-MM-DD"** note to the Phase 0 block of
`docs/superpowers/specs/2026-08-17-alerting-structure-design.md` §7, quoting the actual Slack
message text from steps 1–4 (not a paraphrase). Commit it with the plan's final commit.
Do not mark the phase done on green smoke tests alone —
every incident in §1 was a case of something reporting success it had not achieved.

---

## Deviations from the spec worth flagging to the operator

1. **`lib/job-registry.js` is created in Phase 0, not Phase 2.** Phase 0's `@`-mention rule needs tier data, and a throwaway tier map would be the second source of truth the spec's §2.5 principle forbids. The file ships here with `tier` only; Phase 2 adds `cron`, `command`, `log`, `expectedDurationMin` and `assert` to the same records.
2. **`sfpl-region-snapshot` is not in the spec's §3 tier tables** but still requires `cron-wrapper`. It was deprecated and removed from the crontab on 2026-08-13, so it is registered tier 2 with `deprecated: true`. If it is ever revived, its tier needs a real decision.
3. **`cron-health-slack` is registered tier 2.** The watchdog's own death is an accepted limit in spec §5, not something a tier-1 self-alert can fix.
4. **Tier 2 still alerts in Phase 0**, just without a mention. Suppressing tier-2 Slack entirely is Phase 4 (`tier-gated cron-wrapper`), and doing it early would remove the alerts before the digest that replaces them exists.
