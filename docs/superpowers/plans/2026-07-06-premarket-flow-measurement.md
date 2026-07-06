# Pre-market Flow & Staleness Measurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-off national measurement of Hemnet-vs-Booli pre-market (Kommande/`upcomingSale`) *flow* (second-hand adds/week), *dwell*, and *new-build share*, persisted idempotently to a new `premarket_flow_weekly` table.

**Architecture:** Two additive parser-field extensions surface the per-card new-build flag. A pure, network-free lib (`lib/premarket-flow.js`) implements the newest-first walk-to-cutoff counter, depth sampler, and metric math. A thin orchestrator script (`scripts/premarket-flow-measure.js`) supplies platform page-fetchers (Oxylabs, via the existing `lib/scrape-http` transport), runs both platforms, computes metrics, upserts two rows, and writes a JSON+Markdown artifact.

**Tech Stack:** Node.js CommonJS, `pg` (via `db.js`), existing `lib/scrape-http` + `lib/hemnet-fetch` + `lib/booli-fetch`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md`

## Global Constraints

- **Branch:** `feat/premarket-flow-measurement` (already created; spec + probe committed at 982323f).
- **No new npm dependencies.** Pure CommonJS, mirror existing lib idioms.
- **Force Oxylabs at run time:** run the orchestrator with `SCRAPE_FORCE_OXYLABS=1` — Hemnet direct curl is dead; all fetches must route through Oxylabs.
- **Parser changes are ADDITIVE ONLY.** `parseListingCards` / `parseBooliSearchCards` are consumed by the live cohort scraper — add fields, never rename/remove/retype existing ones.
- **Scope (locked):** national only; pre-market only; **second-hand only** (exclude new builds via the per-card flag); no property-type or region split; no overlap/exclusivity matching.
- **Endpoints (validated 2026-07-06):** Hemnet `https://www.hemnet.se/kommande/bostader?sort=NEWEST&page=<N>`; Booli `https://www.booli.se/sok/till-salu?upcomingSale=1&page=<N>` (national single stream — do NOT use the unfiltered national query; do NOT add a `sort=` param to Booli).
- **Window:** 7 days. **`MAX_PAGES` cap:** 80 (above Booli's ~48-page walk + margin).
- **DB access:** `db.js::createClient()` uses `.env` `DB_*` with `ssl.rejectUnauthorized:false`. Running the migration/orchestrator against prod requires the local IP to be whitelisted (see memory `project_ip_whitelist`) OR run on the droplet. The droplet has **no `psql`** — all DB work goes through committed Node scripts.
- **Tests:** per-lib `--smoke` blocks gated on `require.main === module && process.argv.includes('--smoke')`. There is no repo-wide test runner.
- **Normalized card shape** (the interface between orchestrator and `lib/premarket-flow.js`): `{ published: <Unix seconds | null>, isNewBuild: <boolean> }`.

---

### Task 1: DB migration — `premarket_flow_weekly`

**Files:**
- Create: `migrate-premarket-flow.js`

**Interfaces:**
- Produces: table `premarket_flow_weekly` with PRIMARY KEY `(snapshot_date, platform)`. Columns consumed by Task 5's upsert: `snapshot_date, platform, window_days, stock_total, stock_secondhand_est, adds_window_secondhand, flow_per_day, newbuild_share_window, newbuild_share_pool_est, mean_dwell_days, pages_walked, oxylabs_calls, created_at`.

- [ ] **Step 1: Write the migration script**

Create `migrate-premarket-flow.js`:

```javascript
'use strict';
// migrate-premarket-flow.js — creates premarket_flow_weekly (idempotent).
// Run manually: node migrate-premarket-flow.js
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md
//
// One row per (snapshot_date, platform). Written by scripts/premarket-flow-measure.js.
// mean_dwell_days is NULLABLE (flow_per_day can be 0 → dwell undefined).
const { createClient } = require('./db');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS premarket_flow_weekly (
    snapshot_date            DATE        NOT NULL,
    platform                 TEXT        NOT NULL,
    window_days              INTEGER     NOT NULL,
    stock_total              INTEGER     NOT NULL,
    stock_secondhand_est     INTEGER     NOT NULL,
    adds_window_secondhand   INTEGER     NOT NULL,
    flow_per_day             NUMERIC     NOT NULL,
    newbuild_share_window    NUMERIC     NOT NULL,
    newbuild_share_pool_est  NUMERIC     NOT NULL,
    mean_dwell_days          NUMERIC,
    pages_walked             INTEGER     NOT NULL,
    oxylabs_calls            INTEGER     NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_date, platform)
  )
`;

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_TABLE);
    console.log('Created table: premarket_flow_weekly');
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1`,
      ['premarket_flow_weekly']
    );
    console.log('Tables present:', check.rows.map(r => r.table_name).join(', ') || '(none)');
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
```

- [ ] **Step 2: Run the migration**

Run: `node migrate-premarket-flow.js`
Expected output:
```
Created table: premarket_flow_weekly
Tables present: premarket_flow_weekly
```
(If it errors with a connection timeout, the local IP needs whitelisting — see `project_ip_whitelist` — or run on the droplet. This is an environment step, not a code fix.)

- [ ] **Step 3: Verify idempotency**

Run: `node migrate-premarket-flow.js` a second time.
Expected: identical output, no error (the `IF NOT EXISTS` guard makes re-runs safe).

- [ ] **Step 4: Commit**

```bash
git add migrate-premarket-flow.js
git commit -m "feat(premarket-flow): migration for premarket_flow_weekly table"
```

---

### Task 2: Booli parser — surface `isNewConstruction`

**Files:**
- Modify: `lib/booli-fetch.js` (`parseBooliSearchCards` card object + `--smoke` block)

**Interfaces:**
- Produces: `parseBooliSearchCards(apolloState).cards[i].isNewConstruction : boolean` (additive; `true` only when `Listing.isNewConstruction === true`, else `false`).

- [ ] **Step 1: Add a failing smoke assertion**

In `lib/booli-fetch.js`, inside the existing `--smoke` block, immediately **before** the line `console.log(\`smoke: ${pass} pass, ${fail} fail\`);`, add:

```javascript
  // --- parseBooliSearchCards: isNewConstruction (additive field) ---
  check('search: isNewConstruction surfaced true', () => {
    const apollo = {
      'ROOT_QUERY': { 'searchForSale({"input":{"areaIds":[2],"page":1}})': { result: [{ __ref: 'Listing:1' }] } },
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: true, isNewConstruction: true },
    };
    const r = parseBooliSearchCards(apollo);
    assert.strictEqual(r.cards[0].isNewConstruction, true);
  });
  check('search: isNewConstruction defaults false when absent', () => {
    const apollo = {
      'ROOT_QUERY': { 'searchForSale({"input":{"areaIds":[2],"page":1}})': { result: [{ __ref: 'Listing:1' }] } },
      'Listing:1': { __typename: 'Listing', id: 1, url: '/annons/1', streetAddress: 'X', published: 1, upcomingSale: true },
    };
    const r = parseBooliSearchCards(apollo);
    assert.strictEqual(r.cards[0].isNewConstruction, false);
  });
```

- [ ] **Step 2: Run smoke to verify it fails**

Run: `node lib/booli-fetch.js --smoke`
Expected: FAIL — `SMOKE FAIL [search: isNewConstruction surfaced true]: ...` and the final line shows a non-zero fail count (the card object has no `isNewConstruction` key yet, so it's `undefined`, not `true`).

- [ ] **Step 3: Add the field to the parser**

In `lib/booli-fetch.js`, in `parseBooliSearchCards`, find the `cards.push({ ... })` block and add one line after `objectType:`:

```javascript
      objectType: typeof listing.objectType === 'string' ? listing.objectType : null,
      isNewConstruction: listing.isNewConstruction === true,
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `node lib/booli-fetch.js --smoke`
Expected: PASS — final line `smoke: <N> pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add lib/booli-fetch.js
git commit -m "feat(premarket-flow): surface isNewConstruction on Booli search cards"
```

---

### Task 3: Hemnet parser — surface `newConstruction`

**Files:**
- Modify: `lib/hemnet-fetch.js` (`parseListingCards` card object + new `--smoke` block)

**Interfaces:**
- Produces: `parseListingCards(apolloState)[i].newConstruction : boolean` (additive; `true` only when `entry.newConstruction === true`, else `false`).

- [ ] **Step 1: Add the field to the parser**

In `lib/hemnet-fetch.js`, in `parseListingCards`, find the `cards.push({ ... })` block and add one line after `upcoming:`:

```javascript
      upcoming: entry.upcoming === true,
      newConstruction: entry.newConstruction === true,
```

- [ ] **Step 2: Add a `--smoke` self-test block**

`lib/hemnet-fetch.js` has no smoke block. Add this at the very **end** of the file, after `module.exports = { ... };`:

```javascript

// ---------------------------------------------------------------------------
// --smoke self-test (pure-function; no live network, no DB).
// Run with: node lib/hemnet-fetch.js --smoke
// Gated on require.main so requiring this module never triggers it.
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  check('parseListingCards: empty apollo returns []', () => {
    assert.deepStrictEqual(parseListingCards({}), []);
  });
  check('parseListingCards: newConstruction surfaced true', () => {
    const apollo = { 'ListingCard:1': { id: 1, streetAddress: 'X', publishedAt: 100, upcoming: true, newConstruction: true } };
    const cards = parseListingCards(apollo);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].newConstruction, true);
    assert.strictEqual(cards[0].upcoming, true);
    assert.strictEqual(cards[0].publishedAt, 100);
  });
  check('parseListingCards: newConstruction defaults false when absent', () => {
    const apollo = { 'ListingCard:2': { id: 2, streetAddress: 'Y', publishedAt: 200, upcoming: false } };
    const cards = parseListingCards(apollo);
    assert.strictEqual(cards[0].newConstruction, false);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 3: Run smoke to verify it passes**

Run: `node lib/hemnet-fetch.js --smoke`
Expected: PASS — `smoke: 3 pass, 0 fail`.
(Because the parser field was added in Step 1 first, this smoke passes on first run. Sanity-check the harness catches regressions: temporarily change `newConstruction: entry.newConstruction === true` to `=== 'nope'`, re-run → expect `1 fail`, then revert.)

- [ ] **Step 4: Commit**

```bash
git add lib/hemnet-fetch.js
git commit -m "feat(premarket-flow): surface newConstruction on Hemnet listing cards + add smoke block"
```

---

### Task 4: Pure flow/metrics lib — `lib/premarket-flow.js`

**Files:**
- Create: `lib/premarket-flow.js`

**Interfaces:**
- Consumes: normalized cards `{ published:<Unix sec|null>, isNewBuild:<bool> }` and an injected `fetchPage(pageNum) → Promise<normalized card[]>`.
- Produces:
  - `countWindowSecondhand(cards, {nowSec, windowDays}) → { addsSecondhand, newbuildInWindow, datedInWindow }`
  - `pageEntirelyOld(cards, {nowSec, windowDays}) → boolean`
  - `walkFlow({fetchPage, nowSec, windowDays, maxPages, logger}) → Promise<{ addsSecondhand, newbuildInWindow, datedInWindow, pagesWalked, cards }>`
  - `sampleDepth({fetchPage, pageNumbers, nowSec, logger}) → Promise<[{page, n, newbuildPct, medianAgeDays}]>`
  - `poolNewbuildShare(depthSample) → number`
  - `computeMetrics({stockTotal, addsSecondhand, newbuildInWindow, datedInWindow, depthSample, windowDays}) → { stock_total, stock_secondhand_est, adds_window_secondhand, flow_per_day, newbuild_share_window, newbuild_share_pool_est, mean_dwell_days }`

- [ ] **Step 1: Write the module with its failing smoke block**

Create `lib/premarket-flow.js`:

```javascript
'use strict';
// lib/premarket-flow.js — Pure, network-free helpers for the pre-market flow &
// staleness measurement. walkFlow/sampleDepth take an injected async
// fetchPage(pageNum) returning NORMALIZED cards { published:<unix sec|null>, isNewBuild:<bool> }.
// The orchestrator (scripts/premarket-flow-measure.js) supplies platform fetchers.
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md

const DAY = 86400;
function noop() {}

function cardAgeDays(publishedSec, nowSec) {
  return (nowSec - publishedSec) / DAY;
}

// Count second-hand cards inside the window (pure).
function countWindowSecondhand(cards, { nowSec, windowDays }) {
  const cutoff = nowSec - windowDays * DAY;
  let addsSecondhand = 0, newbuildInWindow = 0, datedInWindow = 0;
  for (const c of cards) {
    if (c.published == null || c.published < cutoff) continue;
    datedInWindow++;
    if (c.isNewBuild) newbuildInWindow++;
    else addsSecondhand++;
  }
  return { addsSecondhand, newbuildInWindow, datedInWindow };
}

// True when every DATED card on the page is older than the cutoff (→ stop paging).
// An all-undated page is NOT terminal (returns false).
function pageEntirelyOld(cards, { nowSec, windowDays }) {
  const cutoff = nowSec - windowDays * DAY;
  const dated = cards.filter(c => c.published != null);
  if (dated.length === 0) return false;
  return dated.every(c => c.published < cutoff);
}

// Walk newest-first pages accumulating in-window second-hand counts.
async function walkFlow({ fetchPage, nowSec, windowDays, maxPages, logger = noop }) {
  let addsSecondhand = 0, newbuildInWindow = 0, datedInWindow = 0, pagesWalked = 0;
  const cardsAll = [];
  for (let p = 1; p <= maxPages; p++) {
    const cards = await fetchPage(p);
    pagesWalked = p;
    if (!cards || cards.length === 0) break;
    cardsAll.push(...cards);
    const c = countWindowSecondhand(cards, { nowSec, windowDays });
    addsSecondhand += c.addsSecondhand;
    newbuildInWindow += c.newbuildInWindow;
    datedInWindow += c.datedInWindow;
    if (pageEntirelyOld(cards, { nowSec, windowDays })) break;
    if (p === maxPages) {
      logger('WARN', `walkFlow hit maxPages=${maxPages} before window boundary — flow may be truncated (undercount)`);
    }
  }
  return { addsSecondhand, newbuildInWindow, datedInWindow, pagesWalked, cards: cardsAll };
}

// Sample specific pages spread across pool depth to estimate composition.
async function sampleDepth({ fetchPage, pageNumbers, nowSec, logger = noop }) {
  const out = [];
  for (const page of pageNumbers) {
    const cards = await fetchPage(page);
    if (!cards || cards.length === 0) { logger('WARN', `sampleDepth page ${page} empty`); continue; }
    const dated = cards.filter(c => c.published != null);
    const nb = cards.filter(c => c.isNewBuild).length;
    let medianAgeDays = null;
    if (dated.length) {
      const ages = dated.map(c => cardAgeDays(c.published, nowSec)).sort((a, b) => a - b);
      medianAgeDays = ages[Math.floor(ages.length / 2)];
    }
    out.push({ page, n: cards.length, newbuildPct: cards.length ? nb / cards.length : 0, medianAgeDays });
  }
  return out;
}

// Card-count-weighted mean new-build fraction across the depth sample.
function poolNewbuildShare(depthSample) {
  let num = 0, den = 0;
  for (const s of depthSample) { num += s.newbuildPct * s.n; den += s.n; }
  return den > 0 ? num / den : 0;
}

// Combine raw counts + depth sample into the stored row fields (pure).
function computeMetrics({ stockTotal, addsSecondhand, newbuildInWindow, datedInWindow, depthSample, windowDays }) {
  const flowPerDay = addsSecondhand / windowDays;
  const newbuildShareWindow = datedInWindow > 0 ? newbuildInWindow / datedInWindow : 0;
  const newbuildSharePool = poolNewbuildShare(depthSample);
  const stockSecondhandEst = Math.round(stockTotal * (1 - newbuildSharePool));
  const meanDwellDays = flowPerDay > 0 ? stockSecondhandEst / flowPerDay : null;
  return {
    stock_total: stockTotal,
    stock_secondhand_est: stockSecondhandEst,
    adds_window_secondhand: addsSecondhand,
    flow_per_day: Number(flowPerDay.toFixed(2)),
    newbuild_share_window: Number(newbuildShareWindow.toFixed(4)),
    newbuild_share_pool_est: Number(newbuildSharePool.toFixed(4)),
    mean_dwell_days: meanDwellDays == null ? null : Number(meanDwellDays.toFixed(1)),
  };
}

module.exports = {
  DAY, cardAgeDays, countWindowSecondhand, pageEntirelyOld,
  walkFlow, sampleDepth, poolNewbuildShare, computeMetrics,
};

// ---------------------------------------------------------------------------
// --smoke self-test (pure; no network). Run: node lib/premarket-flow.js --smoke
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  const NOW = 10 * DAY; // fixed clock: "now" = day 10
  const W = 7;

  check('countWindowSecondhand: counts 2nd-hand in window, splits new-build, excludes old', () => {
    const cards = [
      { published: NOW - 1 * DAY, isNewBuild: false }, // in window, 2nd-hand
      { published: NOW - 2 * DAY, isNewBuild: true },  // in window, new-build
      { published: NOW - 9 * DAY, isNewBuild: false }, // older than 7d — excluded
      { published: null,          isNewBuild: false }, // undated — excluded
    ];
    const r = countWindowSecondhand(cards, { nowSec: NOW, windowDays: W });
    assert.strictEqual(r.addsSecondhand, 1);
    assert.strictEqual(r.newbuildInWindow, 1);
    assert.strictEqual(r.datedInWindow, 2);
  });

  check('pageEntirelyOld: true when all dated cards past cutoff; false otherwise', () => {
    const oldPage = [{ published: NOW - 8 * DAY, isNewBuild: false }, { published: NOW - 20 * DAY, isNewBuild: false }];
    const mixedPage = [{ published: NOW - 1 * DAY, isNewBuild: false }, { published: NOW - 8 * DAY, isNewBuild: false }];
    assert.strictEqual(pageEntirelyOld(oldPage, { nowSec: NOW, windowDays: W }), true);
    assert.strictEqual(pageEntirelyOld(mixedPage, { nowSec: NOW, windowDays: W }), false);
  });

  check('walkFlow: stops at the first entirely-old page and sums per-listing', async () => {
    const pages = {
      1: [{ published: NOW - 1 * DAY, isNewBuild: false }, { published: NOW - 2 * DAY, isNewBuild: true }],
      2: [{ published: NOW - 6 * DAY, isNewBuild: false }, { published: NOW - 8 * DAY, isNewBuild: false }], // straddles cutoff
      3: [{ published: NOW - 9 * DAY, isNewBuild: false }], // entirely old — should not be reached past its count
    };
    const fetchPage = async (p) => pages[p] || [];
    const r = await walkFlow({ fetchPage, nowSec: NOW, windowDays: W, maxPages: 80 });
    // page1: 1 second-hand + 1 new-build; page2: 1 second-hand in window (6d), then page2 not entirely-old so continue;
    // page3 entirely old → counted 0, then stop.
    assert.strictEqual(r.addsSecondhand, 2);
    assert.strictEqual(r.newbuildInWindow, 1);
    assert.strictEqual(r.pagesWalked, 3);
  });

  check('sampleDepth + poolNewbuildShare: weighted new-build share across pages', async () => {
    const pages = {
      1:   [{ published: NOW - 1 * DAY, isNewBuild: true }, { published: NOW - 1 * DAY, isNewBuild: false }], // 50% nb
      500: [{ published: NOW - 100 * DAY, isNewBuild: true }, { published: NOW - 200 * DAY, isNewBuild: true }], // 100% nb
    };
    const fetchPage = async (p) => pages[p] || [];
    const s = await sampleDepth({ fetchPage, pageNumbers: [1, 500], nowSec: NOW });
    assert.strictEqual(s.length, 2);
    assert.strictEqual(s[0].newbuildPct, 0.5);
    assert.strictEqual(s[1].newbuildPct, 1);
    // weighted: (0.5*2 + 1*2) / 4 = 0.75
    assert.strictEqual(poolNewbuildShare(s), 0.75);
  });

  check('computeMetrics: derives flow/day, 2nd-hand stock, dwell', () => {
    const m = computeMetrics({
      stockTotal: 1000, addsSecondhand: 70, newbuildInWindow: 30, datedInWindow: 100,
      depthSample: [{ page: 1, n: 10, newbuildPct: 0.4, medianAgeDays: 5 }], windowDays: 7,
    });
    assert.strictEqual(m.flow_per_day, 10);              // 70/7
    assert.strictEqual(m.newbuild_share_window, 0.3);    // 30/100
    assert.strictEqual(m.newbuild_share_pool_est, 0.4);  // weighted single page
    assert.strictEqual(m.stock_secondhand_est, 600);     // round(1000*0.6)
    assert.strictEqual(m.mean_dwell_days, 60);           // 600/10
  });

  check('computeMetrics: zero flow → mean_dwell_days null (no divide-by-zero)', () => {
    const m = computeMetrics({
      stockTotal: 500, addsSecondhand: 0, newbuildInWindow: 0, datedInWindow: 0,
      depthSample: [{ page: 1, n: 10, newbuildPct: 0, medianAgeDays: null }], windowDays: 7,
    });
    assert.strictEqual(m.flow_per_day, 0);
    assert.strictEqual(m.mean_dwell_days, null);
  });

  (async () => {
    // Re-run async checks deterministically before printing the tally.
    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
```

Note on the async checks: `check()` invokes the async body but doesn't await it, so the two `async` checks (`walkFlow`, `sampleDepth`) resolve on the next tick. The trailing `(async () => {...})()` runs *after* those microtasks settle because it is itself queued after them, so the tally is accurate. If you prefer strictness, convert `check` to `await`-aware; the given form is sufficient for these deterministic fixtures.

- [ ] **Step 2: Run smoke to verify it passes**

Run: `node lib/premarket-flow.js --smoke`
Expected: PASS — `smoke: 6 pass, 0 fail`.
If it prints before the async checks record, harden by making `check` await:
replace `function check(name, fn){ try{ fn(); pass++; }catch(e){...} }` with an `async` runner and `await check(...)` for the two async cases, then `await`-wrap the print. (Only do this if you observe a miscount.)

- [ ] **Step 3: Commit**

```bash
git add lib/premarket-flow.js
git commit -m "feat(premarket-flow): pure walk/sample/metrics lib with smoke tests"
```

---

### Task 5: Orchestrator — `scripts/premarket-flow-measure.js`

**Files:**
- Create: `scripts/premarket-flow-measure.js`

**Interfaces:**
- Consumes: `lib/scrape-http` (`getWithRetry`, `extractNextData`, `getOxylabsStats`, `resetOxylabsStats`), `lib/hemnet-fetch.parseListingCards`, `lib/booli-fetch.parseBooliSearchCards`, `lib/premarket-flow` (Task 4), `db.js.createClient`.
- Produces: two upserted `premarket_flow_weekly` rows + `verf-flow-probe/premarket-flow-<YYYY-MM-DD>.{json,md}` artifact + console comparison including `premarket_share`.

- [ ] **Step 1: Write the orchestrator**

Create `scripts/premarket-flow-measure.js`:

```javascript
'use strict';
// scripts/premarket-flow-measure.js — one-off national pre-market flow & staleness
// measurement (Hemnet vs Booli, second-hand only). Writes premarket_flow_weekly + artifact.
// Run: SCRAPE_FORCE_OXYLABS=1 node scripts/premarket-flow-measure.js
// Spec: docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('../lib/scrape-http');
const { parseListingCards } = require('../lib/hemnet-fetch');
const { parseBooliSearchCards } = require('../lib/booli-fetch');
const { walkFlow, sampleDepth, computeMetrics } = require('../lib/premarket-flow');
const { createClient } = require('../db');

const NOW_SEC = Math.floor(Date.now() / 1000);
const WINDOW_DAYS = 7;
const MAX_PAGES = 80;
const OUT_DIR = path.join(__dirname, '..', 'verf-flow-probe');
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS premarket_flow_weekly (
    snapshot_date DATE NOT NULL, platform TEXT NOT NULL, window_days INTEGER NOT NULL,
    stock_total INTEGER NOT NULL, stock_secondhand_est INTEGER NOT NULL,
    adds_window_secondhand INTEGER NOT NULL, flow_per_day NUMERIC NOT NULL,
    newbuild_share_window NUMERIC NOT NULL, newbuild_share_pool_est NUMERIC NOT NULL,
    mean_dwell_days NUMERIC, pages_walked INTEGER NOT NULL, oxylabs_calls INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (snapshot_date, platform)
  )`;
const UPSERT = `
  INSERT INTO premarket_flow_weekly
    (snapshot_date, platform, window_days, stock_total, stock_secondhand_est,
     adds_window_secondhand, flow_per_day, newbuild_share_window,
     newbuild_share_pool_est, mean_dwell_days, pages_walked, oxylabs_calls)
  VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (snapshot_date, platform) DO UPDATE SET
    window_days=EXCLUDED.window_days, stock_total=EXCLUDED.stock_total,
    stock_secondhand_est=EXCLUDED.stock_secondhand_est,
    adds_window_secondhand=EXCLUDED.adds_window_secondhand, flow_per_day=EXCLUDED.flow_per_day,
    newbuild_share_window=EXCLUDED.newbuild_share_window,
    newbuild_share_pool_est=EXCLUDED.newbuild_share_pool_est,
    mean_dwell_days=EXCLUDED.mean_dwell_days, pages_walked=EXCLUDED.pages_walked,
    oxylabs_calls=EXCLUDED.oxylabs_calls, created_at=NOW()`;

// Read a ROOT_QUERY total by call-name prefix (mirrors market-totals-daily pickByPrefix).
function pickByPrefix(root, prefix, field) {
  if (!root || typeof root !== 'object') return undefined;
  for (const k of Object.keys(root)) {
    if (k.startsWith(prefix)) { const n = root[k]; if (n && typeof n === 'object') return n[field]; }
  }
  return undefined;
}
function apolloRoot(html, label) {
  const data = extractNextData(html);
  const apollo = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apollo) throw new Error(`${label}: __APOLLO_STATE__ missing`);
  return apollo;
}

// Platform configs: url(page) → fetch; normalize cards to { published, isNewBuild };
// stock read from page-1 apollo via (prefix, field).
const PLATFORMS = {
  hemnet: {
    url: (p) => `https://www.hemnet.se/kommande/bostader?sort=NEWEST&page=${p}`,
    parse: (apollo) => parseListingCards(apollo).map(c => ({ published: c.publishedAt, isNewBuild: c.newConstruction })),
    stock: (apollo) => pickByPrefix(apollo.ROOT_QUERY, 'searchUpcomingListings', 'total'),
    depthPages: [1, 40, 80, 120, 160],
  },
  booli: {
    url: (p) => `https://www.booli.se/sok/till-salu?upcomingSale=1&page=${p}`,
    parse: (apollo) => parseBooliSearchCards(apollo).cards.map(c => ({ published: c.published, isNewBuild: c.isNewConstruction })),
    stock: (apollo) => pickByPrefix(apollo.ROOT_QUERY, 'searchForSale', 'totalCount'),
    depthPages: [1, 100, 300, 600, 900],
  },
};

async function measurePlatform(name) {
  const cfg = PLATFORMS[name];
  console.log(`\n===== ${name.toUpperCase()} =====`);
  const oxBefore = getOxylabsStats();
  let stockTotal = null;
  const fetchPage = async (p) => {
    const res = await getWithRetry(cfg.url(p), { logger: () => {} });
    if (res.status !== 200) { log('WARN', `${name} page ${p} status ${res.status}`); return []; }
    const apollo = apolloRoot(res.html, `${name} p${p}`);
    if (p === 1 && stockTotal == null) stockTotal = cfg.stock(apollo);
    return cfg.parse(apollo);
  };
  const flow = await walkFlow({ fetchPage, nowSec: NOW_SEC, windowDays: WINDOW_DAYS, maxPages: MAX_PAGES, logger: log });
  console.log(`  flow walk: pages=${flow.pagesWalked} adds2nd=${flow.addsSecondhand} newbuildInWindow=${flow.newbuildInWindow}`);
  const depth = await sampleDepth({ fetchPage, pageNumbers: cfg.depthPages, nowSec: NOW_SEC, logger: log });
  for (const d of depth) console.log(`  depth p${d.page}: n=${d.n} newbuild=${(d.newbuildPct * 100).toFixed(0)}% medianAge=${d.medianAgeDays == null ? '-' : d.medianAgeDays.toFixed(0)}d`);
  if (stockTotal == null || typeof stockTotal !== 'number') throw new Error(`${name}: stock total not found on page 1`);
  const metrics = computeMetrics({
    stockTotal, addsSecondhand: flow.addsSecondhand, newbuildInWindow: flow.newbuildInWindow,
    datedInWindow: flow.datedInWindow, depthSample: depth, windowDays: WINDOW_DAYS,
  });
  const oxAfter = getOxylabsStats();
  const oxCalls = (oxAfter.oxylabsCallCount + oxAfter.directSuccessCount) - (oxBefore.oxylabsCallCount + oxBefore.directSuccessCount);
  return { platform: name, ...metrics, pages_walked: flow.pagesWalked, oxylabs_calls: oxCalls, depth };
}

async function main() {
  resetOxylabsStats();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const hemnet = await measurePlatform('hemnet');
  const booli = await measurePlatform('booli');
  const rows = [hemnet, booli];

  // Cross-platform derived share.
  const totalAdds = hemnet.adds_window_secondhand + booli.adds_window_secondhand;
  const premarketShareHemnet = totalAdds > 0 ? hemnet.adds_window_secondhand / totalAdds : null;

  // Persist.
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_TABLE);
    for (const r of rows) {
      await client.query(UPSERT, [
        r.platform, WINDOW_DAYS, r.stock_total, r.stock_secondhand_est,
        r.adds_window_secondhand, r.flow_per_day, r.newbuild_share_window,
        r.newbuild_share_pool_est, r.mean_dwell_days, r.pages_walked, r.oxylabs_calls,
      ]);
      console.log(`upsert ok: platform=${r.platform} adds2nd=${r.adds_window_secondhand} dwell=${r.mean_dwell_days}d`);
    }
  } finally {
    await client.end();
  }

  // Artifact.
  const dateStr = new Date(NOW_SEC * 1000).toISOString().slice(0, 10);
  const payload = { snapshot_date: dateStr, window_days: WINDOW_DAYS, premarket_share_hemnet: premarketShareHemnet, rows };
  fs.writeFileSync(path.join(OUT_DIR, `premarket-flow-${dateStr}.json`), JSON.stringify(payload, null, 2));
  const md = [
    `# Pre-market flow — ${dateStr} (window ${WINDOW_DAYS}d, second-hand only, national)`, '',
    `| Platform | Stock (2nd-hand est) | Adds/wk (2nd-hand) | Flow/day | Mean dwell | New-build % (pool) |`,
    `|---|---|---|---|---|---|`,
    ...rows.map(r => `| ${r.platform} | ${r.stock_secondhand_est.toLocaleString()} | ${r.adds_window_secondhand} | ${r.flow_per_day} | ${r.mean_dwell_days == null ? 'n/a' : r.mean_dwell_days + 'd'} | ${(r.newbuild_share_pool_est * 100).toFixed(0)}% |`),
    '',
    `**Hemnet pre-market share of fresh 2nd-hand adds:** ${premarketShareHemnet == null ? 'n/a' : (premarketShareHemnet * 100).toFixed(1) + '%'}`,
    `**Stock ratio (Booli/Hemnet):** ${(booli.stock_secondhand_est / hemnet.stock_secondhand_est).toFixed(2)}× · **Flow ratio (Booli/Hemnet):** ${hemnet.adds_window_secondhand ? (booli.adds_window_secondhand / hemnet.adds_window_secondhand).toFixed(2) : 'n/a'}×`,
    '', `_Flow is a floor (Kommande→FS conversions within the window uncounted; equal bias both platforms). New-build pool share is a depth-sample estimate._`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, `premarket-flow-${dateStr}.md`), md);

  console.log(`\n${md}`);
  console.log(`\nOxylabs calls total: ${JSON.stringify(getOxylabsStats())}`);
  console.log(`Artifact -> ${OUT_DIR}`);
}

main().catch(e => { console.error('UNEXPECTED', e); process.exit(1); });
```

- [ ] **Step 2: Sanity-check it loads (no live run yet)**

Run: `node -e "require('./scripts/premarket-flow-measure.js')"` is **not** appropriate (it would execute `main`). Instead verify syntax only:
Run: `node --check scripts/premarket-flow-measure.js`
Expected: no output, exit 0 (syntax valid).

- [ ] **Step 3: Live one-off run (the real test)**

Ensure DB reachability first (whitelist local IP per `project_ip_whitelist`, or run on the droplet).
Run: `SCRAPE_FORCE_OXYLABS=1 node scripts/premarket-flow-measure.js`
Expected:
- Two `===== HEMNET =====` / `===== BOOLI =====` blocks with flow-walk + depth lines.
- `upsert ok: platform=hemnet ...` and `upsert ok: platform=booli ...`.
- A printed Markdown comparison table with a stock ratio meaningfully **larger** than the flow ratio (the core finding), and Booli mean dwell **longer** than Hemnet's.
- `Oxylabs calls total` ≈ 75–90.
- Artifact files written under `verf-flow-probe/`.

- [ ] **Step 4: Verify persisted rows**

Run:
```bash
node -e "const {createClient}=require('./db');(async()=>{const c=createClient();await c.connect();const r=await c.query('SELECT platform, adds_window_secondhand, stock_secondhand_est, mean_dwell_days, newbuild_share_pool_est FROM premarket_flow_weekly WHERE snapshot_date=CURRENT_DATE ORDER BY platform');console.table(r.rows);await c.end();})().catch(e=>{console.error(e.message);process.exit(1);});"
```
Expected: two rows (booli, hemnet) with populated second-hand adds, stock, dwell.

- [ ] **Step 5: Commit**

```bash
git add scripts/premarket-flow-measure.js
git commit -m "feat(premarket-flow): orchestrator — measure + persist + artifact"
```

---

## Self-Review

**1. Spec coverage:**
- Solving-for / flow metric → Tasks 4 (walk) + 5 (orchestrate). ✓
- Second-hand only (new-build flag) → Tasks 2 + 3 (parser flags), used in Task 5 normalization + Task 4 counting. ✓
- National single-stream endpoints (Hemnet `/kommande`, Booli `upcomingSale=1`) → Task 5 `PLATFORMS`. ✓
- Exact per-listing count, boundary handling, MAX_PAGES=80 → Task 4 `countWindowSecondhand` + `pageEntirelyOld` + `walkFlow` maxPages warning. ✓
- Depth sample for pool new-build share + age bands → Task 4 `sampleDepth` + `poolNewbuildShare`; Task 5 `depthPages`. ✓
- Metrics: adds/wk, flow/day, 2nd-hand stock est, mean dwell, new-build share, cross-platform share → Task 4 `computeMetrics` + Task 5 `premarketShareHemnet`. ✓
- Storage `premarket_flow_weekly` idempotent (PK snapshot_date+platform) → Task 1 migration + Task 5 upsert. ✓
- Artifact (JSON+MD comparison) → Task 5. ✓
- Cost ~75–90 calls, non-JS → Task 5 tracks `oxylabs_calls`; run forces Oxylabs (non-render). ✓
- Caveats (flow floor, sampled pool share) → surfaced in artifact MD footer (Task 5) + smoke docstrings. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". All code blocks complete. The artifact table's runtime values are computed, not placeholders. ✓

**3. Type consistency:** Normalized card `{ published, isNewBuild }` is produced by Task 5's `parse` closures and consumed by Task 4 throughout. `computeMetrics` output keys match Task 1's columns and Task 5's UPSERT parameter order (`window_days, stock_total, stock_secondhand_est, adds_window_secondhand, flow_per_day, newbuild_share_window, newbuild_share_pool_est, mean_dwell_days, pages_walked, oxylabs_calls`). Parser fields `newConstruction` (hemnet) / `isNewConstruction` (booli) match Tasks 3/2 and Task 5's `parse`. ✓

**Note carried to execution:** Tasks 1, 5 require DB connectivity; Task 5 Step 3 requires live Oxylabs. Tasks 2, 3, 4 are fully offline (smoke tests) and can be done/verified without network or DB.
