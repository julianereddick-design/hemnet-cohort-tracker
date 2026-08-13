# Monthly Age-Penetration Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn four one-off July age censuses into an unattended monthly job that persists a per-pool age histogram to Postgres and posts a Slack pulse.

**Architecture:** Four existing scraper scripts each gain an exported `run()` returning a standard result object; a thin orchestrator (`scripts/age-census-monthly.js`) calls them cheapest-first and persists each pool the moment it completes; a separate report job (`age-census-report.js`) reads the DB and posts. Age-band maths stays in `lib/premarket-flow.js` (untouched) so July's numbers and September's are computed identically. New pure helpers live in `lib/age-census.js`; all DB writes live in `age-census-store.js`.

**Tech Stack:** Node.js (CommonJS), `pg` via `./db` `createClient()`, Oxylabs via `lib/scrape-http` `getWithRetry`, cron via `./cron-wrapper` `runJob`, Slack via incoming webhook (`SLACK_WEBHOOK_URL`).

**Spec:** `docs/superpowers/specs/2026-08-13-age-penetration-monthly-design.md`

## Global Constraints

- Age bands are fixed and shared: `EDGES = [30, 90, 180, 365, 548, 730]`, labels `['≤1mo','1–3mo','3–6mo','6–12mo','12–18mo','18–24mo','>24mo']`. Never redefine these — import from `lib/age-census.js`.
- Band keys used in every JSONB column and every API: `le1m, m1_3, m3_6, m6_12, m12_18, m18_24, gt24` plus `undated`.
- `platform` ∈ `{'booli','hemnet'}`; `pool` ∈ `{'premarket','forsale'}`; `method` ∈ `{'binary-search','sort-flip','muni-partition'}`.
- Any script that hits the network live must refuse to run unless `SCRAPE_FORCE_OXYLABS === '1'` (existing convention in all four scripts). Keep that guard.
- **Never fire a live Oxylabs run without Julian's explicit go-ahead for that specific run.** Every step in this plan is offline except Task 11, which is explicitly gated.
- Cron-scheduled scripts call `require('./cron-wrapper').runJob` at module load; the crontab invokes the script directly (`node scripts/age-census-monthly.js`), never `node cron-wrapper.js <script>`.
- Artifacts go to `verf-flow-probe/` (existing convention, already git-tracked).
- Existing self-tests must keep passing untouched: `--selftest` on all four scripts, `node lib/premarket-flow.js --smoke`.
- Do not modify `lib/premarket-flow.js`. If you think you need to, you have taken a wrong turn.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/age-census.js` | create | Pure: band constants, per-run accumulator, dual (all / 2nd-hand) bucket shaping, gate evaluation. No I/O. |
| `age-census-store.js` | create | All DB writes/reads for the two tables. Takes an injected client so it is unit-testable offline. |
| `migrate-age-census.js` | create | Idempotent DDL for `age_census_run` + `age_census_muni`. |
| `scripts/age-census-monthly.js` | create | Orchestrator: runs four pools cheapest-first, persists each on completion, tolerates per-pool failure. |
| `age-census-report.js` | create | Reads the DB for a run date, renders the Slack post + md/json artifacts. |
| `scripts/booli-age-census.js` | modify | Add `run()` (estimate-only, ~60 calls) + `--estimate` CLI flag. Keep bake-off default + `--selftest`. |
| `scripts/forsale-age-penetration.js` | modify | Add `run()` wrapping the Booli two-pass estimate. Keep all existing CLI modes. |
| `scripts/hemnet-age-census.js` | modify | Per-muni accumulators (replacing module globals) + `run()`. Keep `--probe` / `--selftest`. |
| `scripts/hemnet-forsale-age-census.js` | modify | Per-muni accumulators + `run()`. Keep `--sizes` / `--probe` / `--selftest`. |

---

### Task 1: Rebase the four census commits onto a current base

The droplet runs `origin/master`, which contains none of the four census scripts. Local `master` is 24 behind / 2 ahead. Three commits on the current branch duplicate work already upstream and must be dropped, not merged.

**Files:** no source changes — git history only.

**Interfaces:**
- Consumes: nothing.
- Produces: a branch `feat/age-penetration-monthly` whose base is `origin/master` and which contains exactly four commits — `2b4bf65` (Booli pre-market census), `cdb53b4` (Hemnet pre-market census), `3d911eb` (Booli FS + Hemnet FS census tools), `76ee076` (Hemnet FS outputs + runbook). All later tasks build on this.

- [ ] **Step 1: Record the current state before touching anything**

```bash
git status --short > /tmp/age-census-pre-rebase-status.txt
git log --oneline origin/master..feat/age-penetration-monthly
git branch backup/age-penetration-pre-rebase feat/age-penetration-monthly
```

Expected: 7 commits listed; a backup branch now exists. If the count is not 7, STOP and re-read the log before continuing.

- [ ] **Step 2: Confirm the three duplicate commits really are upstream**

```bash
git log --oneline origin/master --grep="view-charts"          # expect ce4dbca
git log --oneline origin/master --grep="sfpl-region-snapshot" # expect 3e56610
git ls-tree --name-only origin/master docs/superpowers/specs/ | grep premarket-quality
```

Expected: `ce4dbca` exists, `3e56610` exists, and the premarket-quality spec is present upstream. These three confirm `70ba1c5`, `6d2eeb3`, and the quality-doc commits (`d98dfe2`, `0432dea`, `5e16866`) are redundant. If any is missing upstream, STOP and ask — dropping it would lose work.

- [ ] **Step 3: Rebase, keeping only the four census commits**

```bash
git fetch origin
git checkout -B feat/age-penetration-monthly origin/master
git cherry-pick 2b4bf65 cdb53b4 3d911eb 76ee076
```

If a cherry-pick conflicts, resolve in favour of the incoming census-script content (these files do not exist upstream, so conflicts should only occur in shared docs — take upstream for docs, incoming for `scripts/` and `lib/`).

- [ ] **Step 4: Verify the four scripts are present and the duplicates are gone**

```bash
git log --oneline origin/master..HEAD                    # expect exactly 4 commits
ls scripts/booli-age-census.js scripts/hemnet-age-census.js \
   scripts/forsale-age-penetration.js scripts/hemnet-forsale-age-census.js
ls lib/hemnet-locations-full.json
```

Expected: 4 commits, all five files present.

- [ ] **Step 5: Clean-clone gate — prove nothing is untracked**

This is the step that catches the `lib/booli-image-labels.js` failure mode, where six review passes missed an untracked file because every local run had it on disk.

```bash
rm -rf /tmp/age-census-clone && git clone -q . /tmp/age-census-clone
cd /tmp/age-census-clone && git checkout -q feat/age-penetration-monthly && npm ci --silent
node scripts/booli-age-census.js --selftest
node scripts/hemnet-age-census.js --selftest
node scripts/forsale-age-penetration.js --selftest
node scripts/hemnet-forsale-age-census.js --selftest
node lib/premarket-flow.js --smoke
cd -
```

Expected: all five print PASS / `0 fail`. A `MODULE_NOT_FOUND` here means a required file is untracked — `git add` it and re-run before proceeding.

- [ ] **Step 6: Commit nothing, push the branch**

```bash
git push -u origin feat/age-penetration-monthly
```

---

### Task 2: Migration for the two tables

**Files:**
- Create: `migrate-age-census.js`

**Interfaces:**
- Consumes: `createClient` from `./db`.
- Produces: tables `age_census_run` (unique on `run_date, platform, pool`) and `age_census_muni` (unique on `run_id, muni_id`), used by Task 4's store and Task 10's report.

- [ ] **Step 1: Write the migration**

```js
'use strict';
// migrate-age-census.js — creates age_census_run + age_census_muni (idempotent).
// Run manually: node migrate-age-census.js
// Spec: docs/superpowers/specs/2026-08-13-age-penetration-monthly-design.md
//
// One row per (run_date, platform, pool). Written by scripts/age-census-monthly.js.
// buckets_secondhand is NULLABLE: binary-search methods (both Booli pools) cannot
// resolve new-builds per band, so only the muni-partition (Hemnet) pools populate it.
const { createClient } = require('./db');

const CREATE_RUN = `
  CREATE TABLE IF NOT EXISTS age_census_run (
    id                  SERIAL      PRIMARY KEY,
    run_date            DATE        NOT NULL,
    platform            TEXT        NOT NULL,
    pool                TEXT        NOT NULL,
    method              TEXT        NOT NULL,
    n_total             INTEGER     NOT NULL,
    n_newbuild          INTEGER,
    n_newbuild_sampled  BOOLEAN     NOT NULL DEFAULT FALSE,
    n_newbuild_sample_n INTEGER,
    n_undated           INTEGER     NOT NULL,
    buckets             JSONB       NOT NULL,
    buckets_secondhand  JSONB,
    ox_calls            INTEGER     NOT NULL,
    error_pages         INTEGER     NOT NULL DEFAULT 0,
    runtime_s           INTEGER,
    status              TEXT        NOT NULL,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_date, platform, pool)
  )`;

const CREATE_MUNI = `
  CREATE TABLE IF NOT EXISTS age_census_muni (
    id                 SERIAL  PRIMARY KEY,
    run_id             INTEGER NOT NULL REFERENCES age_census_run(id) ON DELETE CASCADE,
    muni_name          TEXT    NOT NULL,
    muni_id            INTEGER NOT NULL,
    headline_n         INTEGER NOT NULL,
    counted_n          INTEGER NOT NULL,
    buckets            JSONB   NOT NULL,
    buckets_secondhand JSONB   NOT NULL,
    UNIQUE (run_id, muni_id)
  )`;

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_RUN);
    await client.query(CREATE_MUNI);
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [['age_census_run', 'age_census_muni']]
    );
    console.log('Tables present:', check.rows.map(r => r.table_name).sort().join(', ') || '(none)');
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
```

- [ ] **Step 2: Verify it parses (offline)**

Run: `node --check migrate-age-census.js`
Expected: no output, exit 0.

Do NOT run the migration against the DB yet — that happens in Task 11 with the deploy.

- [ ] **Step 3: Commit**

```bash
git add migrate-age-census.js
git commit -m "feat(age-census): migration for age_census_run + age_census_muni"
```

---

### Task 3: Pure helpers — `lib/age-census.js`

The heart of the dual tally. Both Hemnet scripts already track `newbuild[k]` per band, so the 2nd-hand histogram is `buckets[k] - newbuild[k]` — no extra scraping.

**Files:**
- Create: `lib/age-census.js`

**Interfaces:**
- Consumes: `bandIndex`, `cardAgeDays`, `DAY` from `lib/premarket-flow.js`.
- Produces:
  - `EDGES: number[]`, `LABELS: string[]`, `BAND_KEYS: string[]`
  - `newAccumulator({ seen })` → `{ buckets:number[7], newbuild:number[7], seen:Set, distinct:number, undated:number, anomalies:number }`
  - `addCardTo(acc, card, nowSec)` → `boolean` (true when newly counted); `card` is `{ id, published, isNewBuild }`
  - `mergeAccumulators(accs)` → a new accumulator with summed bands
  - `bucketsToObject(buckets, undated)` → `{ le1m, …, gt24, undated }`
  - `secondhandToObject(buckets, newbuild, undated)` → same shape, band-wise difference
  - `gateReconciliation({ headlineSum, distinct, maxPct })` → gate
  - `gateCrosscheck({ newestPass, oldestPass, headlineTotal, maxPct })` → gate
  - `gateTotalDrift({ nTotal, priorTotal, maxPct })` → gate
  - `gateErrorPages({ errorPages, oxCalls, maxPct })` → gate
  - `evaluateGates(gates)` → `{ passed:boolean, failures:string[], detail:object }`
  - A gate is `{ name:string, passed:boolean, detail:string }`.

- [ ] **Step 1: Write the failing smoke test**

Append this to `lib/age-census.js` (the file starts as just this block; the implementation lands in Step 3):

```js
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { DAY } = require('./premarket-flow');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  const NOW = 5000 * DAY;

  check('addCardTo: bands, new-build split, global dedupe, undated', () => {
    const acc = newAccumulator();
    assert.strictEqual(addCardTo(acc, { id: 'a', published: NOW - 10 * DAY, isNewBuild: false }, NOW), true);
    assert.strictEqual(addCardTo(acc, { id: 'a', published: NOW - 10 * DAY, isNewBuild: false }, NOW), false, 'duplicate id must not recount');
    addCardTo(acc, { id: 'b', published: NOW - 40 * DAY, isNewBuild: true }, NOW);
    addCardTo(acc, { id: 'c', published: null, isNewBuild: false }, NOW);
    assert.strictEqual(acc.buckets[0], 1);
    assert.strictEqual(acc.buckets[1], 1);
    assert.strictEqual(acc.newbuild[1], 1);
    assert.strictEqual(acc.undated, 1);
    assert.strictEqual(acc.distinct, 3);
  });

  check('addCardTo: mangled/future publishedAt counts as anomaly + undated, never a band', () => {
    const acc = newAccumulator();
    addCardTo(acc, { id: 'x', published: NOW + 5 * DAY, isNewBuild: false }, NOW);
    addCardTo(acc, { id: 'y', published: 'not-a-number', isNewBuild: false }, NOW);
    assert.strictEqual(acc.anomalies, 2);
    assert.strictEqual(acc.undated, 2);
    assert.strictEqual(acc.buckets.reduce((a, b) => a + b, 0), 0);
  });

  check('shared seen Set: per-muni accumulators dedupe globally but bucket separately', () => {
    const seen = new Set();
    const m1 = newAccumulator({ seen }), m2 = newAccumulator({ seen });
    addCardTo(m1, { id: 'dup', published: NOW - 5 * DAY, isNewBuild: false }, NOW);
    assert.strictEqual(addCardTo(m2, { id: 'dup', published: NOW - 5 * DAY, isNewBuild: false }, NOW), false);
    addCardTo(m2, { id: 'own', published: NOW - 5 * DAY, isNewBuild: false }, NOW);
    assert.strictEqual(m1.buckets[0], 1);
    assert.strictEqual(m2.buckets[0], 1);
    const nat = mergeAccumulators([m1, m2]);
    assert.strictEqual(nat.buckets[0], 2, 'national = sum of per-muni');
  });

  check('bucketsToObject / secondhandToObject: 2nd-hand = all minus new-build, band-wise', () => {
    const buckets = [10, 20, 0, 0, 0, 0, 5];
    const newbuild = [1, 4, 0, 0, 0, 0, 5];
    const all = bucketsToObject(buckets, 3);
    const sec = secondhandToObject(buckets, newbuild, 3);
    assert.strictEqual(all.le1m, 10);
    assert.strictEqual(all.gt24, 5);
    assert.strictEqual(all.undated, 3);
    assert.strictEqual(sec.le1m, 9);
    assert.strictEqual(sec.m1_3, 16);
    assert.strictEqual(sec.gt24, 0, 'a band that is all new-build goes to zero, not negative');
    assert.deepStrictEqual(Object.keys(all), [...BAND_KEYS, 'undated']);
  });

  check('gateReconciliation: passes inside tolerance, fails outside', () => {
    assert.strictEqual(gateReconciliation({ headlineSum: 8368, distinct: 8368, maxPct: 2 }).passed, true);
    assert.strictEqual(gateReconciliation({ headlineSum: 8368, distinct: 8000, maxPct: 2 }).passed, false);
  });

  check('gateCrosscheck: July Booli FS numbers pass; a 10% split fails', () => {
    assert.strictEqual(gateCrosscheck({ newestPass: 26454, oldestPass: 26939, headlineTotal: 52349, maxPct: 3 }).passed, true);
    assert.strictEqual(gateCrosscheck({ newestPass: 20000, oldestPass: 26000, headlineTotal: 52349, maxPct: 3 }).passed, false);
  });

  check('gateTotalDrift: no prior month always passes (first run must not trip)', () => {
    assert.strictEqual(gateTotalDrift({ nTotal: 33742, priorTotal: null, maxPct: 25 }).passed, true);
    assert.strictEqual(gateTotalDrift({ nTotal: 33742, priorTotal: 33000, maxPct: 25 }).passed, true);
    assert.strictEqual(gateTotalDrift({ nTotal: 16000, priorTotal: 33000, maxPct: 25 }).passed, false);
  });

  check('gateErrorPages: 0 passes; >2% fails; 0 calls never divides by zero', () => {
    assert.strictEqual(gateErrorPages({ errorPages: 0, oxCalls: 656, maxPct: 2 }).passed, true);
    assert.strictEqual(gateErrorPages({ errorPages: 50, oxCalls: 656, maxPct: 2 }).passed, false);
    assert.strictEqual(gateErrorPages({ errorPages: 0, oxCalls: 0, maxPct: 2 }).passed, true);
  });

  check('evaluateGates: collects failures by name', () => {
    const r = evaluateGates([
      gateErrorPages({ errorPages: 0, oxCalls: 10, maxPct: 2 }),
      gateTotalDrift({ nTotal: 10, priorTotal: 100, maxPct: 25 }),
    ]);
    assert.strictEqual(r.passed, false);
    assert.deepStrictEqual(r.failures, ['total_drift']);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node lib/age-census.js --smoke`
Expected: FAIL — `ReferenceError: newAccumulator is not defined`.

- [ ] **Step 3: Write the implementation above the smoke block**

```js
'use strict';
// lib/age-census.js — pure helpers for the monthly age-penetration census.
// No network, no DB. Band maths is delegated to lib/premarket-flow.js so the monthly
// series is computed identically to the July one-off censuses.
//
// The dual tally: scripts already track newbuild[k] per band, so the 2nd-hand histogram
// is a band-wise subtraction. Binary-search methods cannot do this (they never see most
// cards) — those pools pass newbuild=null and store buckets_secondhand=NULL. See spec §5.
//
// Self-test: node lib/age-census.js --smoke
const { bandIndex, cardAgeDays, DAY } = require('./premarket-flow');

const EDGES = [30, 90, 180, 365, 548, 730];
const LABELS = ['≤1mo', '1–3mo', '3–6mo', '6–12mo', '12–18mo', '18–24mo', '>24mo'];
const BAND_KEYS = ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24'];
const N_BANDS = EDGES.length + 1;

// `seen` is injectable so per-muni accumulators dedupe against ONE global id set while
// keeping their own bands — national totals are then the sum of the per-muni bands.
function newAccumulator({ seen } = {}) {
  return {
    buckets: new Array(N_BANDS).fill(0),
    newbuild: new Array(N_BANDS).fill(0),
    seen: seen || new Set(),
    distinct: 0,
    undated: 0,
    anomalies: 0,
  };
}

// Fold one normalized card { id, published:<unix sec|null>, isNewBuild } into an accumulator.
// Returns false when the id was already counted anywhere (global dedupe).
function addCardTo(acc, card, nowSec) {
  if (card.id != null) {
    if (acc.seen.has(card.id)) return false;
    acc.seen.add(card.id);
  }
  acc.distinct++;
  const p = card.published;
  // A mangled (ISO string, garbage coercion) or future timestamp is an anomaly, never a band.
  if (p == null || typeof p !== 'number' || !isFinite(p) || p <= 0 || p > nowSec + DAY) {
    if (p != null) acc.anomalies++;
    acc.undated++;
    return true;
  }
  const k = bandIndex(cardAgeDays(p, nowSec), EDGES);
  acc.buckets[k]++;
  if (card.isNewBuild) acc.newbuild[k]++;
  return true;
}

function mergeAccumulators(accs) {
  const out = newAccumulator();
  for (const a of accs) {
    for (let k = 0; k < N_BANDS; k++) { out.buckets[k] += a.buckets[k]; out.newbuild[k] += a.newbuild[k]; }
    out.distinct += a.distinct;
    out.undated += a.undated;
    out.anomalies += a.anomalies;
  }
  return out;
}

function bucketsToObject(buckets, undated) {
  const o = {};
  BAND_KEYS.forEach((key, k) => { o[key] = buckets[k] || 0; });
  o.undated = undated || 0;
  return o;
}

// Band-wise all-minus-new-build. Clamped at 0: a band whose cards are all new-builds must
// read 0, never negative, even if a upstream counter double-counts.
function secondhandToObject(buckets, newbuild, undated) {
  const o = {};
  BAND_KEYS.forEach((key, k) => { o[key] = Math.max(0, (buckets[k] || 0) - (newbuild[k] || 0)); });
  o.undated = undated || 0;
  return o;
}

const gate = (name, passed, detail) => ({ name, passed, detail });

// Hemnet muni-partition: Σ per-muni headline totals must match the distinct union.
function gateReconciliation({ headlineSum, distinct, maxPct = 2 }) {
  if (!headlineSum) return gate('reconciliation', true, 'no headline total to reconcile');
  const deltaPct = Math.abs(headlineSum - distinct) / headlineSum * 100;
  return gate('reconciliation', deltaPct <= maxPct,
    `Σ headline ${headlineSum} vs distinct ${distinct} (Δ ${deltaPct.toFixed(2)}%, max ${maxPct}%)`);
}

// Booli FS two-pass: the 90d cutoff computed from both ends must agree.
function gateCrosscheck({ newestPass, oldestPass, headlineTotal, maxPct = 3 }) {
  if (newestPass == null || oldestPass == null || !headlineTotal) {
    return gate('crosscheck', false, 'crosscheck values missing');
  }
  const deltaPct = Math.abs(newestPass - oldestPass) / headlineTotal * 100;
  return gate('crosscheck', deltaPct <= maxPct,
    `90d newest-pass ${Math.round(newestPass)} vs oldest-pass ${Math.round(oldestPass)} (Δ ${deltaPct.toFixed(2)}% of pool, max ${maxPct}%)`);
}

// Catches a scrape-shape regression that silently halves a pool. No prior month → pass.
function gateTotalDrift({ nTotal, priorTotal, maxPct = 25 }) {
  if (priorTotal == null) return gate('total_drift', true, 'no prior month — nothing to compare');
  const deltaPct = Math.abs(nTotal - priorTotal) / priorTotal * 100;
  return gate('total_drift', deltaPct <= maxPct,
    `n_total ${nTotal} vs prior ${priorTotal} (Δ ${deltaPct.toFixed(1)}%, max ${maxPct}%)`);
}

function gateErrorPages({ errorPages, oxCalls, maxPct = 2 }) {
  if (!oxCalls) return gate('error_pages', true, 'no calls made');
  const pct = errorPages / oxCalls * 100;
  return gate('error_pages', pct <= maxPct, `${errorPages}/${oxCalls} error pages (${pct.toFixed(2)}%, max ${maxPct}%)`);
}

function evaluateGates(gates) {
  const failures = gates.filter(g => !g.passed).map(g => g.name);
  const detail = {};
  for (const g of gates) detail[g.name] = { passed: g.passed, detail: g.detail };
  return { passed: failures.length === 0, failures, detail };
}

module.exports = {
  EDGES, LABELS, BAND_KEYS, N_BANDS,
  newAccumulator, addCardTo, mergeAccumulators,
  bucketsToObject, secondhandToObject,
  gateReconciliation, gateCrosscheck, gateTotalDrift, gateErrorPages, evaluateGates,
};
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node lib/age-census.js --smoke`
Expected: `smoke: 8 pass, 0 fail`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/age-census.js
git commit -m "feat(age-census): pure accumulator, dual-tally bucket shaping, validation gates"
```

---

### Task 4: DB store — `age-census-store.js`

**Files:**
- Create: `age-census-store.js`

**Interfaces:**
- Consumes: `createClient` from `./db`; the result shape produced by Tasks 5-8.
- Produces:
  - `upsertRun(client, row)` → `Promise<number>` (the `age_census_run.id`)
  - `insertMuniRows(client, runId, muniRows)` → `Promise<number>` (rows written)
  - `getPriorTotal(client, { platform, pool, runDate })` → `Promise<number|null>`
  - `persistPool(result, { runDate })` → `Promise<{ runId, muniRows }>` — opens its own client, upserts, replaces muni rows, closes. Called once per pool by Task 9.
  - `row` shape: `{ run_date, platform, pool, method, n_total, n_newbuild, n_newbuild_sampled, n_newbuild_sample_n, n_undated, buckets, buckets_secondhand, ox_calls, error_pages, runtime_s, status, notes }`

- [ ] **Step 1: Write the failing smoke test**

Create `age-census-store.js` containing only this block for now:

```js
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  // Stub client: records queries, returns canned results. No DB, no network.
  function stubClient(returns = {}) {
    const calls = [];
    return {
      calls,
      async query(sql, params) {
        calls.push({ sql, params });
        if (/INSERT INTO age_census_run/.test(sql)) return { rows: [{ id: returns.runId || 42 }] };
        if (/SELECT n_total/.test(sql)) return { rows: returns.priorRows || [] };
        return { rows: [], rowCount: (params && params.length) || 0 };
      },
    };
  }
  const ROW = {
    run_date: '2026-09-01', platform: 'hemnet', pool: 'forsale', method: 'muni-partition',
    n_total: 43338, n_newbuild: 2789, n_newbuild_sampled: false, n_newbuild_sample_n: null,
    n_undated: 0,
    buckets: { le1m: 20889, m1_3: 11224, m3_6: 3164, m6_12: 2600, m12_18: 1950, m18_24: 911, gt24: 2600, undated: 0 },
    buckets_secondhand: { le1m: 19000, m1_3: 10500, m3_6: 3000, m6_12: 2500, m12_18: 1900, m18_24: 900, gt24: 2549, undated: 0 },
    ox_calls: 1208, error_pages: 0, runtime_s: 7200, status: 'ok', notes: null,
  };

  (async () => {
    await check('upsertRun: returns the row id and passes JSONB as objects', async () => {
      const c = stubClient({ runId: 7 });
      const id = await upsertRun(c, ROW);
      assert.strictEqual(id, 7);
      const q = c.calls.find(x => /INSERT INTO age_census_run/.test(x.sql));
      assert.ok(/ON CONFLICT \(run_date, platform, pool\) DO UPDATE/.test(q.sql), 'must upsert, not just insert');
      assert.ok(q.params.includes(43338), 'n_total must be bound');
      assert.strictEqual(typeof q.params[q.params.indexOf(ROW.buckets)], 'object');
    });

    await check('insertMuniRows: deletes prior rows for the run, then inserts each muni', async () => {
      const c = stubClient();
      const n = await insertMuniRows(c, 7, [
        { name: 'Stockholm', id: 17744, headlineN: 5000, countedN: 4998, buckets: {}, bucketsSecondhand: {} },
        { name: 'Alingsås', id: 17920, headlineN: 7, countedN: 7, buckets: {}, bucketsSecondhand: {} },
      ]);
      assert.strictEqual(n, 2);
      assert.ok(c.calls.some(x => /DELETE FROM age_census_muni/.test(x.sql)), 'must clear before insert so a re-run is idempotent');
      assert.strictEqual(c.calls.filter(x => /INSERT INTO age_census_muni/.test(x.sql)).length, 2);
    });

    await check('insertMuniRows: empty list is a no-op returning 0', async () => {
      const c = stubClient();
      assert.strictEqual(await insertMuniRows(c, 7, []), 0);
      assert.strictEqual(c.calls.filter(x => /INSERT INTO age_census_muni/.test(x.sql)).length, 0);
    });

    await check('getPriorTotal: returns the most recent earlier total, or null when none', async () => {
      const c1 = stubClient({ priorRows: [{ n_total: 33000 }] });
      assert.strictEqual(await getPriorTotal(c1, { platform: 'booli', pool: 'premarket', runDate: '2026-09-01' }), 33000);
      const c2 = stubClient({ priorRows: [] });
      assert.strictEqual(await getPriorTotal(c2, { platform: 'booli', pool: 'premarket', runDate: '2026-09-01' }), null);
      const q = c1.calls[0];
      assert.ok(/run_date < \$3/.test(q.sql), 'must exclude the current run date');
      assert.ok(/ORDER BY run_date DESC/.test(q.sql), 'must take the most recent prior');
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node age-census-store.js --smoke`
Expected: FAIL — `ReferenceError: upsertRun is not defined`.

- [ ] **Step 3: Write the implementation above the smoke block**

```js
'use strict';
// age-census-store.js — every DB write/read for the monthly age census.
// Functions take an injected client so they unit-test offline against a stub;
// persistPool() is the one entry point that owns a connection.
// Spec: docs/superpowers/specs/2026-08-13-age-penetration-monthly-design.md
const { createClient } = require('./db');

const UPSERT_RUN = `
  INSERT INTO age_census_run
    (run_date, platform, pool, method, n_total, n_newbuild, n_newbuild_sampled,
     n_newbuild_sample_n, n_undated, buckets, buckets_secondhand, ox_calls,
     error_pages, runtime_s, status, notes)
  VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (run_date, platform, pool) DO UPDATE SET
    method=EXCLUDED.method, n_total=EXCLUDED.n_total, n_newbuild=EXCLUDED.n_newbuild,
    n_newbuild_sampled=EXCLUDED.n_newbuild_sampled,
    n_newbuild_sample_n=EXCLUDED.n_newbuild_sample_n, n_undated=EXCLUDED.n_undated,
    buckets=EXCLUDED.buckets, buckets_secondhand=EXCLUDED.buckets_secondhand,
    ox_calls=EXCLUDED.ox_calls, error_pages=EXCLUDED.error_pages,
    runtime_s=EXCLUDED.runtime_s, status=EXCLUDED.status, notes=EXCLUDED.notes,
    created_at=NOW()
  RETURNING id`;

const DELETE_MUNI = `DELETE FROM age_census_muni WHERE run_id = $1`;
const INSERT_MUNI = `
  INSERT INTO age_census_muni
    (run_id, muni_name, muni_id, headline_n, counted_n, buckets, buckets_secondhand)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (run_id, muni_id) DO UPDATE SET
    muni_name=EXCLUDED.muni_name, headline_n=EXCLUDED.headline_n,
    counted_n=EXCLUDED.counted_n, buckets=EXCLUDED.buckets,
    buckets_secondhand=EXCLUDED.buckets_secondhand`;

const SELECT_PRIOR = `
  SELECT n_total FROM age_census_run
   WHERE platform = $1 AND pool = $2 AND run_date < $3::date
   ORDER BY run_date DESC LIMIT 1`;

async function upsertRun(client, row) {
  const res = await client.query(UPSERT_RUN, [
    row.run_date, row.platform, row.pool, row.method, row.n_total, row.n_newbuild,
    row.n_newbuild_sampled, row.n_newbuild_sample_n, row.n_undated, row.buckets,
    row.buckets_secondhand, row.ox_calls, row.error_pages, row.runtime_s,
    row.status, row.notes,
  ]);
  return res.rows[0].id;
}

// Replace-then-insert so a re-run of a partially-written month leaves no orphan munis.
async function insertMuniRows(client, runId, muniRows) {
  if (!muniRows || muniRows.length === 0) return 0;
  await client.query(DELETE_MUNI, [runId]);
  let n = 0;
  for (const m of muniRows) {
    await client.query(INSERT_MUNI, [runId, m.name, m.id, m.headlineN, m.countedN, m.buckets, m.bucketsSecondhand]);
    n++;
  }
  return n;
}

async function getPriorTotal(client, { platform, pool, runDate }) {
  const res = await client.query(SELECT_PRIOR, [platform, pool, runDate]);
  return res.rows.length ? Number(res.rows[0].n_total) : null;
}

// One pool's full persistence. Owns its connection so a later pool's failure cannot
// roll back or block an earlier pool's already-banked row (spec §3).
async function persistPool(result, { runDate }) {
  const client = createClient();
  await client.connect();
  try {
    const runId = await upsertRun(client, {
      run_date: runDate,
      platform: result.platform,
      pool: result.pool,
      method: result.method,
      n_total: result.nTotal,
      n_newbuild: result.nNewbuild == null ? null : Math.round(result.nNewbuild),
      n_newbuild_sampled: !!result.newbuildSampled,
      n_newbuild_sample_n: result.newbuildSampleN == null ? null : result.newbuildSampleN,
      n_undated: result.nUndated,
      buckets: result.buckets,
      buckets_secondhand: result.bucketsSecondhand || null,
      ox_calls: result.oxCalls,
      error_pages: result.errorPages || 0,
      runtime_s: result.runtimeS == null ? null : Math.round(result.runtimeS),
      status: result.status,
      notes: result.notes || null,
    });
    const muniRows = await insertMuniRows(client, runId, result.muni || []);
    return { runId, muniRows };
  } finally {
    await client.end();
  }
}

module.exports = { upsertRun, insertMuniRows, getPriorTotal, persistPool };
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node age-census-store.js --smoke`
Expected: `smoke: 4 pass, 0 fail`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add age-census-store.js
git commit -m "feat(age-census): DB store with injected-client unit tests"
```

---

### Task 5: `run()` for the Booli pre-market census (estimate-only)

**The cost fix.** The script's default path is the July *bake-off*: preflight + binary-search + a full 963-page census (~1,023 calls, ~76 min). The monthly job must run the validated cheap half only (~60 calls). The bake-off stays reachable for revalidation but is never what the orchestrator calls.

**Files:**
- Modify: `scripts/booli-age-census.js`

**Interfaces:**
- Consumes: `newAccumulator`… not needed here (binary-search produces bands directly); uses `bucketsToObject` and gates from `lib/age-census.js`.
- Produces: `module.exports = { run }` where `run({ nowSec, logger })` resolves to:

```js
{
  platform: 'booli', pool: 'premarket', method: 'binary-search',
  nTotal, nUndated, nNewbuild, newbuildSampled: true, newbuildSampleN,
  buckets: { le1m, …, gt24, undated },
  bucketsSecondhand: null,          // binary-search cannot resolve new-builds per band
  muni: [],
  oxCalls, errorPages, runtimeS,
  gates: [ …gate objects… ],
  status: 'ok' | 'gate_failed',
  notes: string|null,
}
```

- [ ] **Step 1: Extend the existing self-test with the new expectations**

In `selftest()` in `scripts/booli-age-census.js`, after the existing assertions (which must stay), add:

```js
  // --- run() estimate-only contract (monthly job path) ---
  const res = await run({ nowSec: CLOCK, logger: () => {} });
  assert.strictEqual(res.platform, 'booli');
  assert.strictEqual(res.pool, 'premarket');
  assert.strictEqual(res.method, 'binary-search');
  assert.strictEqual(res.bucketsSecondhand, null, 'binary-search must NOT claim a 2nd-hand histogram');
  assert.strictEqual(res.newbuildSampled, true);
  assert.ok(res.newbuildSampleN > 0, 'sampled new-build rate needs a sample size');
  assert.deepStrictEqual(Object.keys(res.buckets), ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24', 'undated']);
  const bandSum = ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24'].reduce((a, k) => a + res.buckets[k], 0);
  assert.ok(Math.abs(bandSum + res.buckets.undated - res.nTotal) <= 1, `bands+undated ${bandSum + res.buckets.undated} must reconcile to nTotal ${res.nTotal}`);
  assert.ok(res.muni.length === 0, 'Booli is national-only — no muni rows');
  console.log('SELFTEST PASS — run() estimate contract holds.');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/booli-age-census.js --selftest`
Expected: FAIL — `run is not defined`.

- [ ] **Step 3: Implement `run()` and the `--estimate` CLI flag**

Add after `binarySearch()`, before `census()`:

```js
const { bucketsToObject, gateTotalDrift, gateErrorPages, evaluateGates } = require('../lib/age-census');

// Estimate-only path used by the monthly job: preflight + binary-search, NO full census.
// ~60 calls vs the bake-off's ~1,023. The census stage stays available via the default CLI
// for method revalidation; it is never on the monthly path.
async function run({ nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  const memo = new Map();
  const pf = await preflight(memo);
  const lastPage = stockTotal ? Math.ceil(stockTotal / pf.pageSize) : MAX_PAGES;
  const bs = await binarySearch(memo, pf.pageSize, lastPage);

  // New-build share across every card the search actually fetched (sampled, not exact).
  let sampleN = 0, sampleNewbuild = 0;
  for (const cards of memo.values()) for (const c of cards) { sampleN++; if (c.isNewBuild) sampleNewbuild++; }
  const newbuildRate = sampleN ? sampleNewbuild / sampleN : 0;

  const bands = bs.buckets.map(v => Math.max(0, Math.round(v)));
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const gates = [
    gateErrorPages({ errorPages: 0, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: stockTotal, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  logger('INFO', `run() bands=${JSON.stringify(bands)} undated=${bs.undatedEst} calls=${oxCalls} gates=${ev.passed ? 'ok' : ev.failures.join(',')}`);
  return {
    platform: 'booli', pool: 'premarket', method: 'binary-search',
    nTotal: stockTotal, nUndated: bs.undatedEst,
    nNewbuild: Math.round(stockTotal * newbuildRate),
    newbuildSampled: true, newbuildSampleN: sampleN,
    buckets: bucketsToObject(bands, bs.undatedEst),
    bucketsSecondhand: null,
    muni: [],
    oxCalls, errorPages: 0, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed',
    notes: ev.passed ? null : `gates failed: ${ev.failures.join(', ')}`,
  };
}
```

Wire the CLI flag in `main()`, immediately after the `--probe` branch:

```js
  if (process.argv.includes('--estimate')) {
    if (process.env.SCRAPE_FORCE_OXYLABS !== '1') {
      console.error('Refusing to run un-proxied. Set SCRAPE_FORCE_OXYLABS=1.');
      process.exit(1);
    }
    console.log(JSON.stringify(await run({}), null, 2));
    return;
  }
```

Export at the bottom of the file, replacing the bare `main()` call line with:

```js
module.exports = { run };
if (require.main === module) main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
```

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `node scripts/booli-age-census.js --selftest`
Expected: existing assertions plus `SELFTEST PASS — run() estimate contract holds.`

- [ ] **Step 5: Commit**

```bash
git add scripts/booli-age-census.js
git commit -m "feat(age-census): booli pre-market run() — estimate-only, ~60 calls not ~1023"
```

---

### Task 6: `run()` for the Booli for-sale two-pass estimate

**Files:**
- Modify: `scripts/forsale-age-penetration.js`

**Interfaces:**
- Consumes: existing `probeEnd`, `estimateTwoPass`, `bandsFromCumulative`, `booli` adapter (all already in the file); `bucketsToObject`, `gateCrosscheck`, `gateTotalDrift`, `gateErrorPages`, `evaluateGates` from `lib/age-census.js`.
- Produces: adds `run` to the existing `module.exports`. Same result shape as Task 5, with `pool: 'forsale'`, `method: 'sort-flip'`, `bucketsSecondhand: null`, `muni: []`, and a `crosscheck` gate.

- [ ] **Step 1: Add the failing assertions to `selftest()`**

Append inside `selftest()`, before the final `console.log`:

```js
  await check('run(): returns the standard result shape with a crosscheck gate', async () => {
    const res = await run({ platform: cleanPlat, nowSec: CLOCK, logger: () => {} });
    assert.strictEqual(res.pool, 'forsale');
    assert.strictEqual(res.method, 'sort-flip');
    assert.strictEqual(res.bucketsSecondhand, null);
    assert.ok(res.gates.some(g => g.name === 'crosscheck'), 'two-pass must report a crosscheck gate');
    const keys = ['le1m', 'm1_3', 'm3_6', 'm6_12', 'm12_18', 'm18_24', 'gt24'];
    assert.deepStrictEqual(Object.keys(res.buckets), [...keys, 'undated']);
    const sum = keys.reduce((a, k) => a + res.buckets[k], 0);
    assert.ok(Math.abs(sum + res.buckets.undated - res.nTotal) <= 1, 'bands must reconcile to nTotal');
  });
```

Note: `cleanPlat` already exists in `selftest()` — it is the synthetic non-clamped pool. It needs an `asc` parameter to serve both passes; extend its `fetch(p, asc)` so that when `asc` is true it returns the pool reversed:

```js
    async fetch(p, asc = false) {
      if (p < 1 || p > LAST) return { status: 200, cards: [], total: TOTAL };
      const cards = [];
      for (let j = 0; j < PAGE; j++) {
        const idx = (p - 1) * PAGE + j;
        const age = asc ? (TOTAL - 1 - idx) : idx;      // oldest-first reverses the age axis
        cards.push({ id: `c${age}`, published: CLOCK - age * DAY, isNewBuild: false, upcoming: false });
      }
      return { status: 200, cards, total: p === 1 ? TOTAL : undefined };
    },
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/forsale-age-penetration.js --selftest`
Expected: FAIL — `run is not defined`.

- [ ] **Step 3: Implement `run()`**

Add before `runFull()`:

```js
const { bucketsToObject, gateCrosscheck, gateTotalDrift, gateErrorPages, evaluateGates } = require('../lib/age-census');

// Monthly-job entry point: Booli FS two-pass estimate (newest-first for the young bands,
// oldest-first for the deep ones). `platform` is injectable so --selftest drives a synthetic
// pool; production always passes the module's `booli` adapter.
async function run({ platform = booli, nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  const newest = await probeEnd(platform, false);
  const oldest = await probeEnd(platform, true);
  const overlap = newest.reachableListings + oldest.reachableListings - newest.total;
  if (overlap <= 0) throw new Error(`two-pass ends do not overlap (gap ${-overlap}) — cannot cover the age axis`);

  const est = await estimateTwoPass(platform, {
    newestHi: newest.reachablePage, oldestHi: oldest.reachablePage,
    pageSize: newest.pageSize, headlineTotal: newest.total,
  });
  const { bands, undatedEst } = bandsFromCumulative(est.cumulative, newest.total, est.undatedRate);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const cc = est.crosscheck;
  const gates = [
    gateCrosscheck({ newestPass: cc.newestPass, oldestPass: cc.oldestPass, headlineTotal: newest.total, maxPct: 3 }),
    gateErrorPages({ errorPages: 0, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: newest.total, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  logger('INFO', `run() bands=${JSON.stringify(bands)} calls=${oxCalls} gates=${ev.passed ? 'ok' : ev.failures.join(',')}`);
  return {
    platform: 'booli', pool: 'forsale', method: 'sort-flip',
    nTotal: newest.total, nUndated: undatedEst,
    nNewbuild: Math.round(newest.total * est.newbuildRate),
    newbuildSampled: true, newbuildSampleN: est.seenPages * (newest.pageSize || 0),
    buckets: bucketsToObject(bands, undatedEst),
    bucketsSecondhand: null,
    muni: [],
    oxCalls, errorPages: 0, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed',
    notes: ev.passed ? null : `gates failed: ${ev.failures.join(', ')}`,
  };
}
```

Add `run` to the existing export line:

```js
module.exports = { preflightPlatform, estimatePlatform, estimateTwoPass, findCrossoverOlder, bandsFromCumulative, hemnet, booli, run };
```

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `node scripts/forsale-age-penetration.js --selftest`
Expected: `selftest: N pass, 0 fail` with N one higher than before.

- [ ] **Step 5: Commit**

```bash
git add scripts/forsale-age-penetration.js
git commit -m "feat(age-census): booli for-sale run() with two-pass crosscheck gate"
```

---

### Task 7: Per-muni accumulators + `run()` for the Hemnet pre-market census

This script currently folds every listing into **module-level** `buckets` / `newbuild` / `seen` globals, which makes per-muni storage impossible and `run()` non-re-entrant. Replace them with one accumulator per municipality, sharing a single global `seen` Set so dedupe stays global while bands stay per-muni. The national histogram is then `mergeAccumulators(perMuni)` — which is also what makes the reconciliation gate meaningful.

**Files:**
- Modify: `scripts/hemnet-age-census.js`

**Interfaces:**
- Consumes: `newAccumulator`, `addCardTo`, `mergeAccumulators`, `bucketsToObject`, `secondhandToObject`, `gateReconciliation`, `gateTotalDrift`, `gateErrorPages`, `evaluateGates` from `lib/age-census.js`.
- Produces: `module.exports = { run }`; result shape as Task 5 but with `platform: 'hemnet'`, `pool: 'premarket'`, `method: 'muni-partition'`, a populated `bucketsSecondhand`, and `muni: [{ name, id, headlineN, countedN, buckets, bucketsSecondhand }]`.

- [ ] **Step 1: Add the failing assertions to `selftest()`**

The existing selftest asserts against the module globals. Rewrite its tail (keeping the synthetic `pageFetcher` and the clamp/injection assertions) so it drives `run()` instead:

```js
  const res = await run({ locations: { Big: 'Big', Small: 'Small', Undated: 'Undated', Empty: 'Empty' }, nowSec: CLOCK, logger: () => {} });
  // National bands must equal ground truth built from the synthetic store.
  for (let k = 0; k < truth.length; k++) {
    assert.strictEqual(res.buckets[BAND_KEYS[k]], truth[k], `band ${BAND_KEYS[k]}: ${res.buckets[BAND_KEYS[k]]} != ${truth[k]}`);
  }
  assert.strictEqual(res.buckets.undated, truthUndated, 'undated mismatch');
  assert.strictEqual(res.nTotal, Object.keys(store).length, 'nTotal must equal distinct listings');
  // Per-muni rows exist and sum back to the national histogram.
  assert.strictEqual(res.muni.length, 4, 'one row per muni, including empties');
  const perMuniSum = res.muni.reduce((a, m) => a + BAND_KEYS.reduce((s, k) => s + m.buckets[k], 0), 0);
  const nationalSum = BAND_KEYS.reduce((s, k) => s + res.buckets[k], 0);
  assert.strictEqual(perMuniSum, nationalSum, 'Σ per-muni bands must equal the national histogram');
  // 2nd-hand histogram is exact here (every card is walked).
  assert.ok(res.bucketsSecondhand != null, 'muni-partition must produce an exact 2nd-hand histogram');
  assert.strictEqual(res.newbuildSampled, false);
  assert.ok(res.gates.some(g => g.name === 'reconciliation'));
  assert.ok(!seenGlobal.has('INJECT'), 'injected non-upcoming card must not be counted');
```

`BAND_KEYS` must be imported at the top of the file; `seenGlobal` is the shared Set `run()` exposes on its result as `res._seen` for the test (add that field, documented as test-only).

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/hemnet-age-census.js --selftest`
Expected: FAIL — `run is not defined`.

- [ ] **Step 3: Replace the module globals with per-muni accumulators**

Delete the module-level `buckets` / `newbuild` / `seen` / `undated` / `distinct` block and the `addCard()` function. Rewrite `walkMuni` to take an accumulator, and add `run()`:

```js
const {
  BAND_KEYS, newAccumulator, addCardTo, mergeAccumulators, bucketsToObject, secondhandToObject,
  gateReconciliation, gateTotalDrift, gateErrorPages, evaluateGates,
} = require('../lib/age-census');

// Walk one muni into ITS OWN accumulator. `acc.seen` is the shared global id set, so a
// listing that somehow appears under two munis is counted once, in the first one seen.
async function walkMuni(name, id, acc, nowSec, ctx) {
  let pages = 0, total = null, counted = 0, p1Error = false;
  for (let p = 1; p <= MAX_PAGES_PER_MUNI; p++) {
    const r = await fetchPage(id, p);
    pages = p;
    if (r.cards == null) { ctx.errorPages++; if (p === 1) p1Error = true; log('WARN', `${name} p${p} status ${r.status} — gap, continuing`); continue; }
    if (p === 1) total = r.total;
    if (r.cards.length === 0) break;
    const up = r.cards.filter(c => c.upcoming);
    const nonUp = r.cards.length - up.length;
    if (nonUp) { ctx.nonUpcoming += nonUp; log('WARN', `${name} p${p}: ${nonUp} non-upcoming card(s) filtered out`); }
    let fresh = 0;
    for (const c of up) if (addCardTo(acc, c, nowSec)) { fresh++; counted++; }
    if (fresh === 0) break;
    if (p === MAX_PAGES_PER_MUNI) log('WARN', `${name} hit MAX_PAGES_PER_MUNI=${MAX_PAGES_PER_MUNI} — muni may exceed cap (unexpected)`);
  }
  return { name, id, pages, total, counted, p1Error };
}

async function run({ locations = LOCATIONS, nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  const seen = new Set();
  const ctx = { errorPages: 0, nonUpcoming: 0 };
  const names = Object.keys(locations);
  const accs = [], stats = [];
  let headlineSum = 0, done = 0;

  for (const name of names) {
    const acc = newAccumulator({ seen });
    const st = await walkMuni(name, locations[name], acc, nowSec, ctx);
    if (typeof st.total === 'number') headlineSum += st.total;
    accs.push(acc); stats.push(st);
    if (++done % 25 === 0) logger('INFO', `${done}/${names.length} munis, distinct=${seen.size}`);
  }
  // Retry munis whose page 1 errored — a whole-muni coverage gap. Global dedupe makes a
  // re-walk safe; the accumulator is replaced so bands are not double-counted.
  const p1errs = stats.map((s, i) => ({ s, i })).filter(x => x.s.p1Error);
  if (p1errs.length) {
    logger('WARN', `retrying ${p1errs.length} munis whose p1 errored: ${p1errs.map(x => x.s.name).join(', ')}`);
    for (const { s, i } of p1errs) {
      const acc = newAccumulator({ seen });
      const st = await walkMuni(s.name, locations[s.name], acc, nowSec, ctx);
      if (typeof st.total === 'number') headlineSum += st.total;
      accs[i] = acc; stats[i] = st;
    }
  }

  const nat = mergeAccumulators(accs);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const stillFailed = stats.filter(s => s.p1Error).map(s => s.name);
  const gates = [
    gateReconciliation({ headlineSum, distinct: nat.distinct, maxPct: 2 }),
    gateErrorPages({ errorPages: ctx.errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: nat.distinct, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  const notes = [
    stillFailed.length ? `munis still failing p1: ${stillFailed.join(', ')}` : null,
    ctx.nonUpcoming ? `${ctx.nonUpcoming} non-upcoming cards filtered` : null,
    nat.anomalies ? `${nat.anomalies} publishedAt anomalies` : null,
    ev.passed ? null : `gates failed: ${ev.failures.join(', ')}`,
  ].filter(Boolean).join('; ') || null;

  return {
    platform: 'hemnet', pool: 'premarket', method: 'muni-partition',
    nTotal: nat.distinct, nUndated: nat.undated,
    nNewbuild: nat.newbuild.reduce((a, b) => a + b, 0),
    newbuildSampled: false, newbuildSampleN: null,
    buckets: bucketsToObject(nat.buckets, nat.undated),
    bucketsSecondhand: secondhandToObject(nat.buckets, nat.newbuild, nat.undated),
    muni: stats.map((s, i) => ({
      name: s.name, id: Number(s.id) || 0,
      headlineN: s.total == null ? 0 : s.total, countedN: s.counted,
      buckets: bucketsToObject(accs[i].buckets, accs[i].undated),
      bucketsSecondhand: secondhandToObject(accs[i].buckets, accs[i].newbuild, accs[i].undated),
    })),
    oxCalls, errorPages: ctx.errorPages, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed', notes,
    _seen: seen,   // test-only: lets --selftest assert on global dedupe
  };
}
```

Rewrite `main()` and `buildMd()` to consume the `run()` result rather than the deleted globals: `main()` becomes `const res = await run({}); …write artifact from res…`, and `buildMd(dateStr, res, booli)` reads `res.buckets[BAND_KEYS[k]]` instead of `buckets[k]`. `probe()` becomes `run({ locations: { 'Alingsås': LOCATIONS['Alingsås'] } })`.

Export at the bottom:

```js
module.exports = { run };
if (require.main === module) main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
```

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `node scripts/hemnet-age-census.js --selftest`
Expected: `SELFTEST PASS` with the per-muni and reconciliation assertions included.

- [ ] **Step 5: Commit**

```bash
git add scripts/hemnet-age-census.js
git commit -m "feat(age-census): hemnet pre-market per-muni accumulators + run()"
```

---

### Task 8: Per-muni accumulators + `run()` for the Hemnet for-sale census

Same refactor as Task 7, complicated by the recursive sub-partition (`censusScope` splits a big muni by `item_types[]`, then by price band). The whole recursion for one municipality folds into **that municipality's** accumulator; the shared `seen` Set makes overlapping sub-scopes harmless, exactly as it does today.

**Files:**
- Modify: `scripts/hemnet-forsale-age-census.js`

**Interfaces:**
- Consumes: same `lib/age-census.js` helpers as Task 7.
- Produces: `module.exports = { run, censusScope, censusMuni }`; result shape identical to Task 7 with `pool: 'forsale'`.

- [ ] **Step 1: Add the failing assertions to `selftest()`**

Keep all three existing checks (small muni, big-muni sub-partition beats the clamp, naive walk proves the clamp is real) — they must still pass. Add:

```js
  await check('run(): per-muni rows sum to the national histogram, 2nd-hand exact', async () => {
    const res = await run({ locations: { Small: 9001, Big: 9002 }, nowSec: NOW_SEC, logger: () => {} });
    assert.strictEqual(res.pool, 'forsale');
    assert.strictEqual(res.method, 'muni-partition');
    assert.strictEqual(res.muni.length, 2);
    const perMuni = res.muni.reduce((a, m) => a + BAND_KEYS.reduce((s, k) => s + m.buckets[k], 0), 0);
    const national = BAND_KEYS.reduce((s, k) => s + res.buckets[k], 0);
    assert.strictEqual(perMuni, national, 'Σ per-muni must equal national');
    assert.strictEqual(res.nTotal, 120 + BIG_TOTAL, 'sub-partition must recover the full count, not the 2,500 clamp');
    assert.ok(res.bucketsSecondhand != null);
    assert.strictEqual(res.newbuildSampled, false);
  });
```

Because `run()` builds its own accumulators, the earlier checks that read module globals must be updated to use the accumulator returned by `censusMuni(name, id, acc, nowSec, ctx)` instead.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/hemnet-forsale-age-census.js --selftest`
Expected: FAIL — `run is not defined`.

- [ ] **Step 3: Thread an accumulator through the recursion, then add `run()`**

Delete the module-level `buckets` / `newbuild` / `seen` / counters and `addCard()`. Give `censusScope`, `walkScope`, and `censusMuni` two extra parameters — `acc` (this muni's accumulator) and `ctx` (`{ errorPages, nonUpcoming }`) — and replace every `addCard(c)` with `addCardTo(acc, c, nowSec)`. Signatures become:

```js
async function walkScope(scope, acc, nowSec, ctx)
async function censusScope(scope, level, acc, nowSec, ctx)
async function censusMuni(name, id, acc, nowSec, ctx)   // returns { name, id, headline, counted }
```

Then add, mirroring Task 7:

```js
const {
  BAND_KEYS, newAccumulator, addCardTo, mergeAccumulators, bucketsToObject, secondhandToObject,
  gateReconciliation, gateTotalDrift, gateErrorPages, evaluateGates,
} = require('../lib/age-census');

async function run({ locations = LOCATIONS, nowSec = NOW_SEC, logger = log, priorTotal = null } = {}) {
  const t0 = Math.floor(Date.now() / 1000);
  resetOxylabsStats();
  const seen = new Set();
  const ctx = { errorPages: 0, nonUpcoming: 0 };
  const names = Object.keys(locations);
  const accs = [], stats = [];
  let headlineSum = 0, i = 0;

  for (const name of names) {
    const acc = newAccumulator({ seen });
    const st = await censusMuni(name, locations[name], acc, nowSec, ctx);
    headlineSum += st.headline || 0;
    accs.push(acc); stats.push(st);
    if (++i % 25 === 0) logger('INFO', `…${i}/${names.length} munis, distinct=${seen.size}`);
  }

  const nat = mergeAccumulators(accs);
  const ox = getOxylabsStats();
  const oxCalls = ox.oxylabsCallCount + ox.directSuccessCount;
  const gates = [
    gateReconciliation({ headlineSum, distinct: nat.distinct, maxPct: 2 }),
    gateErrorPages({ errorPages: ctx.errorPages, oxCalls, maxPct: 2 }),
    gateTotalDrift({ nTotal: nat.distinct, priorTotal, maxPct: 25 }),
  ];
  const ev = evaluateGates(gates);
  const notes = [
    ctx.nonUpcoming ? `${ctx.nonUpcoming} upcoming cards filtered` : null,
    nat.anomalies ? `${nat.anomalies} publishedAt anomalies` : null,
    ev.passed ? null : `gates failed: ${ev.failures.join(', ')}`,
  ].filter(Boolean).join('; ') || null;

  return {
    platform: 'hemnet', pool: 'forsale', method: 'muni-partition',
    nTotal: nat.distinct, nUndated: nat.undated,
    nNewbuild: nat.newbuild.reduce((a, b) => a + b, 0),
    newbuildSampled: false, newbuildSampleN: null,
    buckets: bucketsToObject(nat.buckets, nat.undated),
    bucketsSecondhand: secondhandToObject(nat.buckets, nat.newbuild, nat.undated),
    muni: stats.map((s, k) => ({
      name: s.name, id: Number(s.id) || 0,
      headlineN: s.headline || 0, countedN: s.counted,
      buckets: bucketsToObject(accs[k].buckets, accs[k].undated),
      bucketsSecondhand: secondhandToObject(accs[k].buckets, accs[k].newbuild, accs[k].undated),
    })),
    oxCalls, errorPages: ctx.errorPages, runtimeS: Math.floor(Date.now() / 1000) - t0,
    gates, status: ev.passed ? 'ok' : 'gate_failed', notes,
    _seen: seen,
  };
}
```

Update `runFull()` to `const res = await run({});` and have `buildMd` read from `res`. Update the export line to `module.exports = { run, censusScope, censusMuni };`.

Note on the reconciliation gate here: unlike the pre-market census, Σ headline legitimately exceeds distinct when sub-partitions overlap, and July's run reconciled exactly (43,338 = 43,338). Keep `maxPct: 2` and let a breach be visible; do not widen it to make a red gate go away.

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `node scripts/hemnet-forsale-age-census.js --selftest`
Expected: `selftest: 4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add scripts/hemnet-forsale-age-census.js
git commit -m "feat(age-census): hemnet for-sale per-muni accumulators + run()"
```

---

### Task 9: The orchestrator — `scripts/age-census-monthly.js`

**Files:**
- Create: `scripts/age-census-monthly.js`

**Interfaces:**
- Consumes: `run` from all four scripts; `persistPool`, `getPriorTotal` from `../age-census-store`; `runJob` from `../cron-wrapper`; `createClient` from `../db`.
- Produces: a cron-invocable job. `main()` resolves to `{ pools: [{ platform, pool, status }], persisted: number, failed: string[] }` for `validate()`.

- [ ] **Step 1: Write the failing smoke test**

Create the file with only this block:

```js
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  const mkResult = (platform, pool) => ({
    platform, pool, method: 'binary-search', nTotal: 100, nUndated: 0, nNewbuild: 1,
    newbuildSampled: true, newbuildSampleN: 50,
    buckets: { le1m: 100, m1_3: 0, m3_6: 0, m6_12: 0, m12_18: 0, m18_24: 0, gt24: 0, undated: 0 },
    bucketsSecondhand: null, muni: [], oxCalls: 60, errorPages: 0, runtimeS: 10,
    gates: [], status: 'ok', notes: null,
  });

  (async () => {
    await check('runs pools cheapest-first and persists each as it completes', async () => {
      const order = [], persisted = [];
      const pools = [
        { platform: 'booli', pool: 'premarket', run: async () => { order.push('bp'); return mkResult('booli', 'premarket'); } },
        { platform: 'booli', pool: 'forsale', run: async () => { order.push('bf'); return mkResult('booli', 'forsale'); } },
        { platform: 'hemnet', pool: 'premarket', run: async () => { order.push('hp'); return mkResult('hemnet', 'premarket'); } },
        { platform: 'hemnet', pool: 'forsale', run: async () => { order.push('hf'); return mkResult('hemnet', 'forsale'); } },
      ];
      const summary = await orchestrate({
        pools, runDate: '2026-09-01',
        persist: async (r) => { persisted.push(`${r.platform}:${r.pool}`); return { runId: 1, muniRows: 0 }; },
        priorTotal: async () => null,
        logger: () => {},
      });
      assert.deepStrictEqual(order, ['bp', 'bf', 'hp', 'hf'], 'must run cheapest-first, sequentially');
      assert.deepStrictEqual(persisted, ['booli:premarket', 'booli:forsale', 'hemnet:premarket', 'hemnet:forsale']);
      assert.strictEqual(summary.persisted, 4);
      assert.deepStrictEqual(summary.failed, []);
    });

    await check('one failing pool does not abort the others, and is named in the summary', async () => {
      const persisted = [];
      const pools = [
        { platform: 'booli', pool: 'premarket', run: async () => mkResult('booli', 'premarket') },
        { platform: 'hemnet', pool: 'forsale', run: async () => { throw new Error('Oxylabs 613'); } },
        { platform: 'hemnet', pool: 'premarket', run: async () => mkResult('hemnet', 'premarket') },
      ];
      const summary = await orchestrate({
        pools, runDate: '2026-09-01',
        persist: async (r) => { persisted.push(`${r.platform}:${r.pool}`); return { runId: 1, muniRows: 0 }; },
        priorTotal: async () => null,
        logger: () => {},
      });
      assert.strictEqual(summary.persisted, 2, 'the two healthy pools must still bank');
      assert.deepStrictEqual(summary.failed, ['hemnet:forsale']);
      assert.ok(persisted.includes('hemnet:premarket'), 'a later pool must still run after an earlier failure');
    });

    await check('a gate_failed pool is still persisted, with its status preserved', async () => {
      const rows = [];
      const pools = [{
        platform: 'booli', pool: 'premarket',
        run: async () => ({ ...mkResult('booli', 'premarket'), status: 'gate_failed', notes: 'gates failed: total_drift' }),
      }];
      const summary = await orchestrate({
        pools, runDate: '2026-09-01',
        persist: async (r) => { rows.push(r); return { runId: 1, muniRows: 0 }; },
        priorTotal: async () => null, logger: () => {},
      });
      assert.strictEqual(rows[0].status, 'gate_failed', 'a wrong number must land visibly, not be dropped');
      assert.strictEqual(summary.persisted, 1);
      assert.deepStrictEqual(summary.gateFailed, ['booli:premarket']);
    });

    await check('prior total is fetched per pool and passed into run()', async () => {
      let sawPrior = null;
      const pools = [{
        platform: 'booli', pool: 'premarket',
        run: async ({ priorTotal }) => { sawPrior = priorTotal; return mkResult('booli', 'premarket'); },
      }];
      await orchestrate({
        pools, runDate: '2026-09-01',
        persist: async () => ({ runId: 1, muniRows: 0 }),
        priorTotal: async () => 33742, logger: () => {},
      });
      assert.strictEqual(sawPrior, 33742);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/age-census-monthly.js --smoke`
Expected: FAIL — `orchestrate is not defined`.

- [ ] **Step 3: Write the implementation above the smoke block**

```js
'use strict';
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/age-census-monthly.js — monthly age-penetration census across all four pools.
//
// Runs cheapest-first (Booli PM ~60 calls → Booli FS ~84 → Hemnet PM ~656 → Hemnet FS
// ~1,208) and PERSISTS EACH POOL THE MOMENT IT COMPLETES. That ordering plus per-pool
// persistence is deliberate: on 2026-07-20 a transient Oxylabs 613 on one platform cost the
// entire weekly flow datapoint. A Hemnet failure must never cost the banked Booli rows.
//
// Cron: 02:00 UTC on the 1st of each month. Runtime ~2.5-3h, so it lands ~05:00, well before
// the report job at 07:00 and clear of the Monday 08:50/09:00/10:30 jobs.
// Cost: ~2,000 Oxylabs calls ≈ $5/month.
//
// Self-test: node scripts/age-census-monthly.js --smoke   (offline, no DB, no network)
const { runJob } = require('../cron-wrapper');
const { createClient } = require('../db');
const { persistPool, getPriorTotal } = require('../age-census-store');

const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

// Cheapest-first. Each entry lazily requires its script so --smoke never loads a scraper.
const POOLS = [
  { platform: 'booli', pool: 'premarket', run: (o) => require('./booli-age-census').run(o) },
  { platform: 'booli', pool: 'forsale', run: (o) => require('./forsale-age-penetration').run(o) },
  { platform: 'hemnet', pool: 'premarket', run: (o) => require('./hemnet-age-census').run(o) },
  { platform: 'hemnet', pool: 'forsale', run: (o) => require('./hemnet-forsale-age-census').run(o) },
];

// Pure-ish orchestration: every side effect is injected so --smoke drives it offline.
async function orchestrate({ pools, runDate, persist, priorTotal, logger = log }) {
  const summary = { runDate, pools: [], persisted: 0, failed: [], gateFailed: [] };
  for (const p of pools) {
    const key = `${p.platform}:${p.pool}`;
    try {
      logger('INFO', `=== ${key} — starting ===`);
      const prior = await priorTotal(p);
      const result = await p.run({ priorTotal: prior, logger });
      await persist(result);
      summary.persisted++;
      summary.pools.push({ platform: p.platform, pool: p.pool, status: result.status, nTotal: result.nTotal });
      if (result.status !== 'ok') {
        summary.gateFailed.push(key);
        logger('WARN', `${key} persisted with status=${result.status}: ${result.notes || ''}`);
      } else {
        logger('INFO', `${key} ok — n=${result.nTotal}, ${result.oxCalls} calls, ${result.runtimeS}s`);
      }
    } catch (e) {
      summary.failed.push(key);
      summary.pools.push({ platform: p.platform, pool: p.pool, status: 'failed', error: e.message });
      logger('ERROR', `${key} FAILED: ${e.message} — continuing with the remaining pools`);
    }
  }
  return summary;
}

async function main() {
  const runDate = process.env.RUN_DATE || new Date().toISOString().slice(0, 10);
  const summary = await orchestrate({
    pools: POOLS,
    runDate,
    persist: (result) => persistPool(result, { runDate }),
    priorTotal: async (p) => {
      const client = createClient();
      await client.connect();
      try { return await getPriorTotal(client, { platform: p.platform, pool: p.pool, runDate }); }
      finally { await client.end(); }
    },
    logger: log,
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module && !process.argv.includes('--smoke')) {
  runJob({
    scriptName: 'age-census-monthly',
    main,
    validate: (summary) => {
      if (!summary) return 'no summary returned';
      if (summary.failed.length) return `pools failed: ${summary.failed.join(', ')}`;
      if (summary.gateFailed.length) return `pools failed validation gates: ${summary.gateFailed.join(', ')}`;
      if (summary.persisted !== 4) return `expected 4 pools persisted, got ${summary.persisted}`;
      return null;
    },
  });
}

module.exports = { orchestrate, POOLS };
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node scripts/age-census-monthly.js --smoke`
Expected: `smoke: 4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add scripts/age-census-monthly.js
git commit -m "feat(age-census): monthly orchestrator with per-pool persistence and failure isolation"
```

---

### Task 10: The report job — `age-census-report.js`

**Files:**
- Create: `age-census-report.js`

**Interfaces:**
- Consumes: `createClient` from `./db`; `BAND_KEYS` from `./lib/age-census`; `SLACK_WEBHOOK_URL`.
- Produces: `renderReport(rows, priorRows)` → string (pure, testable); `main()` posts it and writes `verf-flow-probe/age-census-<runDate>.{md,json}`. `REPORT_DATE` env overrides the date, matching `premarket-flow-weekly-report.js`.

- [ ] **Step 1: Write the failing smoke test**

Create the file with only this block:

```js
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  const row = (platform, pool, n, le1m, m1_3, gt24, extra = {}) => ({
    platform, pool, n_total: n, status: 'ok', method: 'muni-partition',
    buckets: { le1m, m1_3, m3_6: 0, m6_12: 0, m12_18: 0, m18_24: 0, gt24, undated: 0 },
    buckets_secondhand: { le1m, m1_3, m3_6: 0, m6_12: 0, m12_18: 0, m18_24: 0, gt24, undated: 0 },
    ...extra,
  });

  check('renders one line per pool, fresh-end first', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'premarket', 33742, 8155, 7280, 4809),
      row('hemnet', 'premarket', 8368, 3272, 1908, 778),
    ], []);
    assert.ok(out.includes('Age penetration — 2026-09-01'));
    assert.ok(/Booli pre-market/.test(out));
    assert.ok(/Hemnet pre-market/.test(out));
    assert.ok(out.indexOf('≤1mo') < out.indexOf('>24mo'), 'fresh end must lead');
  });

  check('Hemnet rows carry the publishedAt-refresh clock caveat; Booli rows do not', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'forsale', 52349, 9684, 16751, 3246),
      row('hemnet', 'forsale', 43338, 20889, 11224, 2600),
    ], []);
    const hemnetLine = out.split('\n').find(l => /Hemnet for-sale/.test(l));
    const booliLine = out.split('\n').find(l => /Booli for-sale/.test(l));
    assert.ok(/clock/.test(hemnetLine), 'Hemnet tail must be flagged');
    assert.ok(!/clock/.test(booliLine), 'Booli clock is sound — no caveat');
    assert.ok(/publishedAt/.test(out), 'the caveat must be explained once in the footer');
  });

  check('month-on-month delta appears only when a prior row exists', () => {
    const curr = [row('booli', 'premarket', 33742, 8155, 7280, 4809)];
    const noPrior = renderReport('2026-09-01', curr, []);
    assert.ok(!/Δ/.test(noPrior), 'first month must not fake a delta');
    const withPrior = renderReport('2026-09-01', curr, [row('booli', 'premarket', 33000, 8000, 7000, 4700)]);
    assert.ok(/Δ/.test(withPrior));
  });

  check('a missing pool is named explicitly, never silently omitted', () => {
    const out = renderReport('2026-09-01', [row('booli', 'premarket', 33742, 8155, 7280, 4809)], []);
    assert.ok(/Hemnet for-sale: MISSING/.test(out), 'a partial month must be visible');
  });

  check('a gate_failed row is rendered with its failure, not as a clean number', () => {
    const out = renderReport('2026-09-01', [
      row('booli', 'premarket', 16000, 8155, 7280, 4809, { status: 'gate_failed', notes: 'gates failed: total_drift' }),
    ], []);
    assert.ok(/GATE FAILED/.test(out));
    assert.ok(/total_drift/.test(out));
  });

  check('Booli rows report the all-listings tally, Hemnet the 2nd-hand one', () => {
    const b = row('booli', 'premarket', 1000, 500, 300, 100);
    b.buckets_secondhand = null;                      // binary-search: not available
    const out = renderReport('2026-09-01', [b], []);
    assert.ok(/incl\. new-build/.test(out), 'the definitional difference must be stated');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node age-census-report.js --smoke`
Expected: FAIL — `renderReport is not defined`.

- [ ] **Step 3: Write the implementation above the smoke block**

Reuse the `sendSlack` helper verbatim from `premarket-flow-weekly-report.js:16-37` (same webhook pattern, same 10s timeout). Then:

```js
'use strict';
// age-census-report.js — monthly Slack pulse for the age-penetration census.
// Reads age_census_run for a run date (+ the prior month for deltas) and posts the fresh-end
// summary. Companion to scripts/age-census-monthly.js, which populates the table.
//
// Reporting rules (spec §7, from Julian 2026-07-09):
//  - Lead with the FRESH end (≤1mo, ≤3mo) and absolute counts. Share and absolute tell
//    opposite stories: Hemnet looks fresher by share while Booli's pre-market pool is ~4×
//    bigger. Both appear.
//  - Hemnet's >24mo tail carries a standing caveat. Hemnet refreshes publishedAt on ad-package
//    renewal, so Hemnet age = "days since last package purchase". NEVER headline "Hemnet has
//    fewer zombies" — that is the refresh artifact.
//  - Hemnet headline = 2nd-hand only; Booli = all listings (binary-search cannot exclude
//    new-builds per band). At Booli's ~0.2-0.7% new-build share this is below noise, but it
//    is a definitional difference and is stated, not hidden.
//
// Cron: 07:00 UTC on the 1st of each month, after the 02:00 measure job.
// Self-test: node age-census-report.js --smoke   (offline, no DB, no Slack)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createClient } = require('./db');
const { BAND_KEYS } = require('./lib/age-census');

const OUT_DIR = path.join(__dirname, 'verf-flow-probe');
const POOL_LABELS = [
  { platform: 'booli', pool: 'premarket', label: 'Booli pre-market' },
  { platform: 'hemnet', pool: 'premarket', label: 'Hemnet pre-market' },
  { platform: 'booli', pool: 'forsale', label: 'Booli for-sale' },
  { platform: 'hemnet', pool: 'forsale', label: 'Hemnet for-sale' },
];

// …sendSlack copied verbatim from premarket-flow-weekly-report.js:16-37…

function lpad(s, w) { return (' '.repeat(w) + s).slice(-w); }
function rpad(s, w) { return (s + ' '.repeat(w)).slice(0, w); }
function fmtN(n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : Number(n).toLocaleString('en-US'); }

// Headline histogram: 2nd-hand where the method can produce it, all-listings otherwise.
function headlineBuckets(row) { return row.buckets_secondhand || row.buckets; }
function share(row, keys) {
  const b = headlineBuckets(row);
  const dated = BAND_KEYS.reduce((a, k) => a + (b[k] || 0), 0);
  if (!dated) return null;
  return 100 * keys.reduce((a, k) => a + (b[k] || 0), 0) / dated;
}
function pct(x) { return x == null ? '?' : x.toFixed(1) + '%'; }
function delta(curr, prior, keys) {
  if (!prior) return '';
  const c = share(curr, keys), p = share(prior, keys);
  if (c == null || p == null) return '';
  const d = c - p;
  return ` (Δ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}pt)`;
}

function renderReport(runDate, rows, priorRows) {
  const find = (list, t) => list.find(r => r.platform === t.platform && r.pool === t.pool);
  const L = [];
  L.push(`Age penetration — ${runDate}`);
  L.push('```');
  L.push(`${rpad('', 20)}${lpad('n', 8)}${lpad('≤1mo', 9)}${lpad('≤3mo', 9)}${lpad('>24mo', 9)}`);
  for (const t of POOL_LABELS) {
    const r = find(rows, t);
    if (!r) { L.push(`${rpad(t.label, 20)}  MISSING — no row for this run`); continue; }
    const prior = find(priorRows, t);
    const clock = t.platform === 'hemnet' ? '  ⚠ clock' : '';
    const basis = r.buckets_secondhand ? '' : '  incl. new-build';
    L.push(`${rpad(t.label, 20)}${lpad(fmtN(r.n_total), 8)}${lpad(pct(share(r, ['le1m'])), 9)}` +
      `${lpad(pct(share(r, ['le1m', 'm1_3'])), 9)}${lpad(pct(share(r, ['gt24'])), 9)}` +
      `${delta(r, prior, ['le1m', 'm1_3'])}${clock}${basis}`);
    if (r.status !== 'ok') L.push(`${rpad('', 20)}  ⛔ GATE FAILED — ${r.notes || r.status}`);
  }
  L.push('```');
  L.push('Hemnet headline = 2nd-hand only; Booli = all listings (binary-search cannot exclude new-builds per band).');
  L.push('⚠ Hemnet age = days since last ad-package purchase (publishedAt refreshes on renewal), so the Hemnet >24mo tail is not a real clock — read the fresh end.');
  return L.join('\n');
}

async function main() {
  const runDate = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  const client = createClient();
  let rows = [], priorRows = [];
  try {
    await client.connect();
    const q = `SELECT platform, pool, method, n_total, buckets, buckets_secondhand, status, notes
                 FROM age_census_run WHERE run_date = $1::date`;
    rows = (await client.query(q, [runDate])).rows;
    priorRows = (await client.query(
      `SELECT DISTINCT ON (platform, pool) platform, pool, n_total, buckets, buckets_secondhand, status
         FROM age_census_run WHERE run_date < $1::date
        ORDER BY platform, pool, run_date DESC`, [runDate])).rows;
  } finally {
    await client.end();
  }

  const text = renderReport(runDate, rows, priorRows);
  console.log(text);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `age-census-${runDate}.md`), text);
  fs.writeFileSync(path.join(OUT_DIR, `age-census-${runDate}.json`), JSON.stringify({ runDate, rows, priorRows }, null, 2));

  if (process.env.DRY_RUN === '1') { console.log('DRY_RUN=1 — not posting to Slack'); return; }
  if (!process.env.SLACK_WEBHOOK_URL) { console.log('No SLACK_WEBHOOK_URL — not posting'); return; }
  await sendSlack(process.env.SLACK_WEBHOOK_URL, text);
  console.log('Posted to Slack.');
}

module.exports = { renderReport };
if (require.main === module && !process.argv.includes('--smoke')) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node age-census-report.js --smoke`
Expected: `smoke: 6 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add age-census-report.js
git commit -m "feat(age-census): monthly Slack report with fresh-end framing and clock caveat"
```

---

### Task 11: Deploy, first live run, enable cron

**GATED.** Steps 4 onward spend money and must not start without Julian's explicit go-ahead for that specific run (~2,000 Oxylabs calls, ~$5, ~3h).

**Files:**
- Modify: `deploy-instructions.md` (register the two crontab entries)

**Interfaces:**
- Consumes: everything from Tasks 1-10.
- Produces: two live cron entries and one verified monthly datapoint.

- [ ] **Step 1: Full offline test sweep on a clean clone**

```bash
rm -rf /tmp/age-census-verify && git clone -q . /tmp/age-census-verify
cd /tmp/age-census-verify && git checkout -q feat/age-penetration-monthly && npm ci --silent
node lib/premarket-flow.js --smoke
node lib/age-census.js --smoke
node age-census-store.js --smoke
node age-census-report.js --smoke
node scripts/age-census-monthly.js --smoke
node scripts/booli-age-census.js --selftest
node scripts/forsale-age-penetration.js --selftest
node scripts/hemnet-age-census.js --selftest
node scripts/hemnet-forsale-age-census.js --selftest
node --check migrate-age-census.js
cd -
```

Expected: every command exits 0. Any `MODULE_NOT_FOUND` means an untracked file — `git add` and repeat.

- [ ] **Step 2: Merge to master and push**

```bash
git checkout master && git reset --hard origin/master
git merge --ff-only feat/age-penetration-monthly
git push origin master
```

- [ ] **Step 3: Deploy and migrate on the droplet**

```bash
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && git pull && git rev-parse HEAD'
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && node migrate-age-census.js'
```

Expected: the droplet's HEAD matches `origin/master`, and the migration prints `Tables present: age_census_muni, age_census_run`.

- [ ] **Step 4: 🚦 STOP — get explicit go-ahead for the first live run**

Report to Julian: scope (4 pools), cost (~2,000 calls ≈ $5), runtime (~3h), and that it runs in tmux so a disconnect cannot orphan the `cron_job_log` row. Do not proceed without a yes.

- [ ] **Step 5: First live run, attended, in tmux**

```bash
ssh cohort-droplet
tmux new -s age-census
cd /opt/hemnet-cohort-tracker && RUN_DATE=$(date +%F) node scripts/age-census-monthly.js 2>&1 | tee /tmp/age-census-first-run.log
```

Expected: four `ok` pools in the JSON summary; ~2,000 calls; no `failed` entries.

- [ ] **Step 6: Verify the persisted rows and the report**

```bash
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && REPORT_DATE=$(date +%F) DRY_RUN=1 node age-census-report.js'
```

Expected: four pool lines, no `MISSING`, no `GATE FAILED`, the Hemnet clock caveat present. Compare each `n_total` against July's baseline (Booli PM 33,742 · Hemnet PM 8,368 · Booli FS 52,349 · Hemnet FS 43,338) — a swing beyond ~25% means investigate before posting, not after.

Note `DRY_RUN=1` above: `dotenv` re-injects Slack credentials, so `env -u SLACK_WEBHOOK_URL` does NOT prevent a post — that mistake has posted to Slack before. Use the explicit flag.

- [ ] **Step 7: Post the first report for real**

```bash
ssh cohort-droplet 'cd /opt/hemnet-cohort-tracker && REPORT_DATE=$(date +%F) node age-census-report.js'
```

- [ ] **Step 8: Install the two cron entries**

`crontab -e` is interactive — do this in a real SSH/tmux session, not a non-interactive shell. Back up first.

```bash
crontab -l > /tmp/crontab-backup-$(date +%s).txt
crontab -e
```

Add:

```cron
# Monthly age-penetration census — all four pools, ~3h, ~$5/month
0 2 1 * * cd /opt/hemnet-cohort-tracker && /usr/bin/node scripts/age-census-monthly.js >> /var/log/hemnet/age-census.log 2>&1
0 7 1 * * cd /opt/hemnet-cohort-tracker && /usr/bin/node age-census-report.js >> /var/log/hemnet/age-census-report.log 2>&1
```

Then `crontab -l` to verify. Note `/var/log/hemnet` has no logrotate (a known open item) — these two files are small, but they add to that pile.

- [ ] **Step 9: Register the entries in the repo docs and commit**

Add both crontab lines to `deploy-instructions.md` alongside the existing job registry, then:

```bash
git add deploy-instructions.md
git commit -m "docs(age-census): register the monthly census + report crontab entries"
git push origin master
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 scope — four pools, bands, out-of-scope | Tasks 5-8 (one each); bands fixed in Task 3 |
| §3 measure/report split, cheapest-first, per-pool persist | Task 9 (orchestrator), Task 10 (report) |
| §3 `run()` contract + `lib/age-census.js` | Tasks 3, 5-8 |
| §4 data model, idempotent migration | Tasks 2, 4 |
| §5 new-builds exact vs sampled | Task 3 (`secondhandToObject`), Tasks 5-6 (`bucketsSecondhand: null`, sampled rate), Tasks 7-8 (exact) |
| §6 validation gates | Task 3 (all four gates), Tasks 5-8 (wired per pool) |
| §7 report rules — fresh end, clock caveat, deltas | Task 10 |
| §8 failure handling — retry, per-pool isolation, cron-wrapper, partial visibility | Task 9 (isolation, `runJob`), Task 10 (`MISSING` lines); `getWithRetry` already in all four scripts |
| §9 delivery — rebase, clean-clone gate, migrate, gated first run, cron last | Tasks 1, 11 |
| §10 testing | Every task's TDD steps; Task 11 Step 1 runs the full sweep |
| §11 limitations | Booli `muni: []` (Tasks 5-6); clock caveat in Task 10 |

**One deliberate deviation from the spec, flagged for the reviewer:** the spec's §2 quotes ~60 calls for the Booli pre-market census. The script's default path is the July bake-off at ~1,023 calls, because it runs a full census alongside the binary-search. Task 5 adds an estimate-only `run()` and leaves the bake-off reachable via the default CLI. Without that task the monthly job would cost ~17× the specced calls for that pool.

**Placeholder scan:** no TBDs; every code step carries runnable code; every test step names the exact command and expected output.

**Type consistency:** `run()` returns the same keys in all four scripts (`platform, pool, method, nTotal, nUndated, nNewbuild, newbuildSampled, newbuildSampleN, buckets, bucketsSecondhand, muni, oxCalls, errorPages, runtimeS, gates, status, notes`); `persistPool` in Task 4 reads exactly those; the report in Task 10 reads the snake_case DB columns from Task 2. Muni rows use `{ name, id, headlineN, countedN, buckets, bucketsSecondhand }` in Tasks 7-8 and are consumed under those names by `insertMuniRows` in Task 4.
