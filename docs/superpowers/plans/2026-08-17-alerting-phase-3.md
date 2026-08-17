# Alerting Phase 3 — assertions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tier-1 job asserts on its *output*, not on its exit code — because "exit 0" is not evidence of work done (incident 3: `downloadImage` never settled, node exited 0 with `main()` pending, and all write-back was skipped).

**Architecture:** Three pieces. `lib/job-cron.js` computes `lastExpectedFire(cron, now)` purely. `lib/job-assertions.js` holds one SQL assertion per tier-1 job plus a runner that decides *whether* to evaluate. `cron-health-slack.js` gains an Assertions section, with the two cross-cutting detectors kept in an explicit slot.

**The trap this phase exists to avoid.** The digest runs at 03:00 UTC. An assertion phrased against a *calendar period* — "a `market_totals` row for today" — fails every single day, because that job fires at 08:30. Assertions are therefore evaluated relative to **`last_expected_fire + grace`**, never to a calendar period, and are skipped entirely for a job whose current row is `running` inside its duration budget. `cron-health-slack.js` already carries a scar comment about a flat 25h window producing two standing false alarms; this is the same mistake one layer up.

**Tech Stack:** Node.js (CommonJS), `pg`. Offline `--smoke` blocks.

**Spec:** `docs/superpowers/specs/2026-08-17-alerting-structure-design.md` §3, §4.3, §7 Phase 3

## Global Constraints

- **Cron is evaluated in UTC.** The droplet runs UTC (confirmed: health report timestamps are UTC). Document the assumption; do not silently use local time.
- **`*/2` in the day-of-month field means odd days (1,3,…,31), not "every 48h."** After the 31st it fires again on the 1st — a one-day gap. `cohort-track` and both refreshes use this.
- **Never assert on a calendar period.** Always `>= lastExpectedFire`.
- **Schema facts** (verified live 2026-08-17): `crawled` is the live refresh timestamp on `hemnet_listingv2` and `booli_listing` — `updated` froze in April 2026 and must not be used. `cohorts` has **no** `matched` column; pair counts come from `cohort_pairs`. `cohort_pairs` has **no** created_at.
- **`age_census_run` is empty** — the job is deployed but first fires 2026-09-01. Its assertion must be skipped until then via `notBefore`, or it produces a standing false alarm on day one. That is the failure mode this whole design exists to avoid.
- **Do not drop the cross-cutting checks.** The zero-growth check is the only detector for a *successful but degraded* scrape. The newest-cohort canary's comment records the measured decay curve (7% at 14d → 64% at 63d) and is the fix for incident 4 — losing it re-introduces it.
- Existing suites stay green.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/job-cron.js` | **create** | Pure cron parsing + `lastExpectedFire` |
| `lib/job-assertions.js` | **create** | One assertion per tier-1 job + the runner's skip rules |
| `lib/job-registry.js` | modify | `assert:` name per tier-1 job; `notBefore` for age-census |
| `cron-health-slack.js` | modify | Assertions section + explicit cross-cutting slot |

---

### Task 1: `lib/job-cron.js` — when *should* it have fired?

**Files:** Create `lib/job-cron.js`

**Interfaces:**
- `parseCron(spec) => { minutes:number[], hours:number[], doms:number[]|null, months:number[], dows:number[]|null }` (`null` = unrestricted)
- `lastExpectedFire(spec, now: Date) => Date | null` — the most recent instant at or before `now` at which this cron should have fired. Searches back 400 days (covers monthly plus safety).

- [ ] **Step 1: Write the failing test**

Create `lib/job-cron.js` with `module.exports = {};` plus:

```js
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { parseCron, lastExpectedFire } = module.exports;
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };
  const iso = (d) => (d ? d.toISOString().slice(0, 16) + 'Z' : null);

  check('parseCron: field types', () => {
    const p = parseCron('30 8 * * *');
    assert.deepStrictEqual(p.minutes, [30]);
    assert.deepStrictEqual(p.hours, [8]);
    assert.strictEqual(p.doms, null, '* must mean unrestricted, not every value');
    assert.strictEqual(p.dows, null);
  });

  check('parseCron: */2 in day-of-month expands to odd days', () => {
    const p = parseCron('0 22 */2 * *');
    assert.deepStrictEqual(p.doms.slice(0, 4), [1, 3, 5, 7]);
    assert.strictEqual(p.doms[p.doms.length - 1], 31);
  });

  // THE trap. The digest runs at 03:00; market-totals-daily fires at 08:30.
  // "a row for today" would fail every single day.
  check('daily job at 03:00 resolves to YESTERDAY 08:30, not today', () => {
    const now = new Date('2026-08-17T03:00:00Z');
    assert.strictEqual(iso(lastExpectedFire('30 8 * * *', now)), '2026-08-16T08:30Z');
  });

  check('daily job just after its fire resolves to today', () => {
    const now = new Date('2026-08-17T09:00:00Z');
    assert.strictEqual(iso(lastExpectedFire('30 8 * * *', now)), '2026-08-17T08:30Z');
  });

  check('weekly Monday job at Monday 03:00 resolves to LAST Monday', () => {
    const now = new Date('2026-08-17T03:00:00Z'); // a Monday
    assert.strictEqual(iso(lastExpectedFire('0 6 * * 1', now)), '2026-08-10T06:00Z');
  });

  check('weekly Monday job later that Monday resolves to today', () => {
    const now = new Date('2026-08-17T07:00:00Z');
    assert.strictEqual(iso(lastExpectedFire('0 6 * * 1', now)), '2026-08-17T06:00Z');
  });

  check('weekly Sunday job (dow=0)', () => {
    const now = new Date('2026-08-17T03:00:00Z'); // Monday
    assert.strictEqual(iso(lastExpectedFire('0 22 * * 0', now)), '2026-08-16T22:00Z');
  });

  // Monthly on the 1st: at 03:00 on the 1st it HAS fired (02:00); at 01:00 it has not.
  check('monthly job after its fire on the 1st', () => {
    assert.strictEqual(iso(lastExpectedFire('0 2 1 * *', new Date('2026-09-01T03:00:00Z'))), '2026-09-01T02:00Z');
  });

  check('monthly job before its fire on the 1st resolves to the previous month', () => {
    assert.strictEqual(iso(lastExpectedFire('0 2 1 * *', new Date('2026-09-01T01:00:00Z'))), '2026-08-01T02:00Z');
  });

  check('every-2-days job on an even day resolves to the previous odd day', () => {
    // 2026-08-16 is even, so the last fire was the 15th at 22:00.
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-08-16T12:00:00Z'))), '2026-08-15T22:00Z');
  });

  check('every-2-days job on an odd day before 22:00 resolves to the previous odd day', () => {
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-08-17T12:00:00Z'))), '2026-08-15T22:00Z');
  });

  check('every-2-days job on an odd day after 22:00 resolves to today', () => {
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-08-17T23:00:00Z'))), '2026-08-17T22:00Z');
  });

  // The 31st->1st wrap: */2 is odd-days-of-month, so Sep 1 follows Aug 31 with a
  // ONE day gap, not two. A window sized on "every 48h" would be wrong here.
  check('every-2-days wraps 31st -> 1st with a one-day gap', () => {
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-09-01T12:00:00Z'))), '2026-08-31T22:00Z');
  });

  check('every registry cron parses and resolves', () => {
    const { JOBS } = require('./job-registry');
    const now = new Date('2026-08-17T03:00:00Z');
    for (const [job, rec] of Object.entries(JOBS)) {
      if (!rec.cron) continue;
      const t = lastExpectedFire(rec.cron, now);
      assert.ok(t instanceof Date, `${job} (${rec.cron}) did not resolve to a Date`);
      assert.ok(t <= now, `${job} resolved to a FUTURE time ${iso(t)}`);
    }
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run to verify it fails**

`node lib/job-cron.js --smoke` → FAIL, `parseCron is not a function`.

- [ ] **Step 3: Implement**

```js
'use strict';

// lib/job-cron.js
//
// "When SHOULD this job have last fired?" — the question every assertion is
// phrased against. Assertions must never be phrased against a calendar period:
// the digest runs at 03:00 UTC, so "a market_totals row for today" would fail
// every single day for a job that fires at 08:30.
//
// TIMEZONE: cron on the droplet runs in UTC (confirmed — the health report
// timestamps are UTC). All arithmetic here is UTC.
//
// NOTE on `*/2` in the day-of-month field: cron expands it over the field's
// range, so it means the ODD days 1,3,...,31 — NOT "every 48 hours". After the
// 31st the next fire is the 1st, a ONE-day gap.
//
//   node lib/job-cron.js --smoke

function expandField(field, min, max) {
  if (field === '*') return null;                       // null = unrestricted
  const out = new Set();
  for (const part of field.split(',')) {
    const step = part.includes('/') ? parseInt(part.split('/')[1], 10) : 1;
    const range = part.split('/')[0];
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); }
    else { lo = hi = parseInt(range, 10); if (step > 1) hi = max; }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function parseCron(spec) {
  const f = String(spec).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron "${spec}" does not have 5 fields`);
  return {
    minutes: expandField(f[0], 0, 59) || Array.from({ length: 60 }, (_, i) => i),
    hours: expandField(f[1], 0, 23) || Array.from({ length: 24 }, (_, i) => i),
    doms: expandField(f[2], 1, 31),
    months: expandField(f[3], 1, 12),
    dows: expandField(f[4], 0, 6),
  };
}

// Standard cron semantics: when BOTH day-of-month and day-of-week are
// restricted, a day matches if EITHER matches. When one is '*', it is ignored.
function dayMatches(d, p) {
  if (p.months && !p.months.includes(d.getUTCMonth() + 1)) return false;
  const domOk = p.doms ? p.doms.includes(d.getUTCDate()) : null;
  const dowOk = p.dows ? p.dows.includes(d.getUTCDay()) : null;
  if (domOk === null && dowOk === null) return true;
  if (domOk === null) return dowOk;
  if (dowOk === null) return domOk;
  return domOk || dowOk;
}

function lastExpectedFire(spec, now) {
  const p = parseCron(spec);
  const hours = [...p.hours].sort((a, b) => b - a);
  const minutes = [...p.minutes].sort((a, b) => b - a);
  for (let back = 0; back <= 400; back++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    if (!dayMatches(day, p)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
        if (t <= now) return t;
      }
    }
  }
  return null;
}

module.exports = { parseCron, lastExpectedFire, expandField, dayMatches };
```

- [ ] **Step 4: Verify** — `node lib/job-cron.js --smoke` → `14 pass, 0 fail`.

- [ ] **Step 5: Commit** — `git commit -m "feat(alerting): lastExpectedFire, so assertions are never phrased against a calendar period"`

---

### Task 2: `lib/job-assertions.js`

**Files:** Create `lib/job-assertions.js`; modify `lib/job-registry.js` (add `assert` + `notBefore`)

**Interfaces:**
- `ASSERTIONS: Record<string, (client, ctx) => Promise<{ok:boolean, detail:string}>>` where `ctx = { lastFire: Date, now: Date }`
- `shouldEvaluate(rec, { lastFire, now, lastRow }) => { evaluate:boolean, reason?:string }`
- `runAssertions(client, jobs, { now, rows }) => Promise<Array<{job,ok,detail,skipped,reason}>>`

**Skip rules** (each prevents a specific false alarm):
1. No `assert` name → skip.
2. `notBefore` in the future → skip ("deployed, not yet due"). `age_census_run` is empty today; without this the assertion is red from the moment it ships.
3. Current row is `running` **and** started within `expectedDurationMin` → skip ("in flight"). This is the acceptance case: a digest on the 1st with the age census mid-flight must raise **no** issue.
4. `now < lastFire + expectedDurationMin + 15min grace` → skip ("too soon"). A job that fires at 02:00 and takes 3h has not failed at 02:05.

- [ ] **Step 1: Write the failing test**

Create the file with `module.exports = {};` plus a smoke block covering the skip rules with a fake client (assertions themselves are SQL and are proven live in Task 4):

```js
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { ASSERTIONS, shouldEvaluate, runAssertions } = module.exports;
  const { JOBS } = require('./job-registry');
  const { lastExpectedFire } = require('./job-cron');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };
  const checkA = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  check('every tier-1 job names an assertion that exists', () => {
    for (const [job, rec] of Object.entries(JOBS)) {
      if (rec.tier !== 1) continue;
      assert.ok(rec.assert, `tier-1 job ${job} has no assert name`);
      assert.strictEqual(typeof ASSERTIONS[rec.assert], 'function',
        `${job} names assertion "${rec.assert}" which does not exist`);
    }
  });

  const now = new Date('2026-09-01T03:00:00Z');

  check('skip: a job deployed but not yet due', () => {
    const rec = { assert: 'ageCensusMonth', notBefore: '2026-09-02', expectedDurationMin: 240 };
    const r = shouldEvaluate(rec, { lastFire: new Date('2026-09-01T02:00:00Z'), now, lastRow: null });
    assert.strictEqual(r.evaluate, false);
    assert.match(r.reason, /not yet due/i);
  });

  // The acceptance case from the spec: a full digest on the 1st of a month with
  // the age census MID-FLIGHT must raise no issue.
  check('skip: a job still running inside its duration budget', () => {
    const rec = { assert: 'ageCensusMonth', expectedDurationMin: 240 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-09-01T02:00:00Z'), now,
      lastRow: { status: 'running', started_at: '2026-09-01T02:00:00Z' },
    });
    assert.strictEqual(r.evaluate, false);
    assert.match(r.reason, /in flight/i);
  });

  check('evaluate: a job whose running row has blown its budget is NOT skipped', () => {
    const rec = { assert: 'ageCensusMonth', expectedDurationMin: 60 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-09-01T02:00:00Z'), now,
      lastRow: { status: 'running', started_at: '2026-08-31T02:00:00Z' },
    });
    assert.strictEqual(r.evaluate, true, 'an orphan must not hide behind "in flight" forever');
  });

  check('skip: too soon after the expected fire', () => {
    const rec = { assert: 'marketTotalsDay', expectedDurationMin: 10 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-09-01T02:55:00Z'), now, lastRow: null,
    });
    assert.strictEqual(r.evaluate, false);
    assert.match(r.reason, /too soon/i);
  });

  check('evaluate: well after the expected fire with a finished row', () => {
    const rec = { assert: 'marketTotalsDay', expectedDurationMin: 10 };
    const r = shouldEvaluate(rec, {
      lastFire: new Date('2026-08-31T08:30:00Z'), now,
      lastRow: { status: 'success', started_at: '2026-08-31T08:30:00Z' },
    });
    assert.strictEqual(r.evaluate, true);
  });

  checkA('runAssertions skips tier-2 jobs entirely', async () => {
    const fakeClient = { query: async () => { throw new Error('no assertion should query here'); } };
    const res = await runAssertions(fakeClient, {
      'sold-match-report': { tier: 2, cron: '0 11 * * 1', expectedDurationMin: 15 },
    }, { now, rows: [] });
    assert.deepStrictEqual(res, [], 'tier 2 is digest-only; it has no assertion');
  }).then(() => {
    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  });
}
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — see the source written in execution; every assertion is `>= lastFire`, never a calendar period, and uses only the columns verified live on 2026-08-17.

- [ ] **Step 4: Verify** all suites green.

- [ ] **Step 5: Commit.**

---

### Task 3: Wire the digest

**Files:** Modify `cron-health-slack.js`

Extend `SCRIPTS`/`EXPECTED` to be driven by the registry, add an Assertions section, and put the two cross-cutting detectors in an explicit slot with their comments intact.

- [ ] **Step 1:** Replace the hardcoded `SCRIPTS`/`EXPECTED` with registry-derived values, keeping `notBefore` behaviour.
- [ ] **Step 2:** Add the `:dart: *Assertions*` section rendering `runAssertions` output; failures push to `issues`.
- [ ] **Step 3:** Add a `--- CROSS-CUTTING ---` banner comment above the zero-growth and canary blocks, marking them as belonging to no single job so a future registry-shaped rewrite cannot drop them as "not registry-shaped".
- [ ] **Step 4:** Verify `node cron-health-slack.js --dry-run` renders without posting.
- [ ] **Step 5:** Commit.

---

### Task 4: Live verification

- [ ] **Step 1:** `node cron-health-slack.js --dry-run` on the droplet. Read every assertion line.
- [ ] **Step 2:** Confirm `age-census-monthly` shows **skipped / not yet due**, not a failure.
- [ ] **Step 3:** Simulate a partial `market_totals` write (delete one of the 4 rows for a day in a transaction, assert it is caught, ROLLBACK) — the spec's "3-of-4" acceptance case.
- [ ] **Step 4:** Confirm the zero-growth check and canary still render.
