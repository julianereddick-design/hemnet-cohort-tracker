# Weekly Pre-Market Quality Measurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the August one-off Booli pre-market quality rubric into a weekly Monday cron job whose result is appended to the existing pre-market flow Slack pulse, showing at which rung of Booli's quality ladder Hemnet's total pre-market flow reaches parity.

**Architecture:** A pure-function rubric library (`lib/premarket-quality.js`) is consumed by one cron-wrapped measurement job (`scripts/premarket-quality-measure.js`) that walks the week's Booli pre-market cards, opens the ambiguous ones, and persists a single row per week to `premarket_quality_weekly`. The existing `premarket-flow-weekly-report.js` grows a second block that joins that row against Hemnet's already-captured `adds_window_secondhand`.

**Tech Stack:** Node.js (CommonJS), `pg`, existing repo libs (`lib/premarket-flow.js`, `lib/booli-image-labels.js`, `lib/scrape-http.js`, `cron-wrapper.js`, `db.js`). Oxylabs for fetching.

**Spec:** `docs/superpowers/specs/2026-08-13-premarket-quality-weekly-design.md`

## Global Constraints

- **No test framework exists in this repo.** Tests are in-script `--smoke` self-tests run as `node <script> --smoke`, printing `PASS`/`FAIL` lines and exiting non-zero on failure. Pattern: `sold-match-report.js:513-528`. Do NOT add jest, mocha, or a `tests/` tree.
- **Do NOT modify `parseBooliSearchCards`** (`lib/booli-fetch.js:203-249`). The Monday 08:50 production flow job calls it; a regression silently corrupts the weekly flow series.
- **Do NOT modify `lib/premarket-flow.js`.** `walkFlow` already returns the full card array.
- **Booli search URL takes no `sort` param.** Any `sort=*` flips Booli to oldest-first. Use exactly `https://www.booli.se/sok/till-salu?upcomingSale=1&page=${p}`.
- **Pre-market detail pages are `/annons/<id>`, not `/bostad/<id>`.** Always use the card's canonical `url` field; constructing one 404s.
- **Set `process.env.SCRAPE_FORCE_OXYLABS = '1'`** at the top of the measure script, before `require('dotenv').config()`, matching `scripts/premarket-quality-week.js:2`.
- **Percentages in Slack output render to 0 decimal places.** Percentages stored in the DB keep 1 decimal place.
- **The Hemnet cumulative cell is blank (`—`) wherever the ratio exceeds 100%.**
- **Never launch a live Oxylabs run without Julian's explicit go-ahead for that specific run.** Every task below is offline except Task 8, which is explicitly gated.
- **Cohort is second-hand only, national.** New-builds excluded via the card's `isNewBuild` flag.
- Window is **7 days**; walk ceiling **130 calls / 120 pages**; resolve ceiling **700 calls**.

---

### Task 1: The rubric library

**Files:**
- Create: `lib/premarket-quality.js`

**Interfaces:**
- Consumes: `lib/booli-image-labels.js` → `interiorVerdict(labels)`, `unknownLabels(labelCounts)`
- Produces:
  - `bucketOf(verdict, nPhotos) → 'zero_photos'|'has_interior'|'unlabelled'|'ambiguous'|'no_interior_confirmed'`
  - `NEEDS_PAGE: Set<string>` — buckets requiring a detail fetch
  - `LADDER: Array<{key, label, rule, match}>` — ordered best→worst
  - `categorise(listing) → string` (one of the six ladder keys)
  - `tally(listings) → counts object` (the DB row shape, minus provenance)
  - `ladderRows(counts, hemnetAdds) → Array<{key, label, n, cumN, cumPct, hemnetPct|null}>`

- [ ] **Step 1: Write the failing smoke test**

Create `lib/premarket-quality.js` containing ONLY the smoke block for now:

```js
'use strict';
// lib/premarket-quality.js — the Booli pre-market quality rubric.
// Pure functions, no I/O. Single source of truth for the rubric; the measure
// job and the weekly report both consume it.
//
// Rubric (Julian's definition): a quality pre-market listing has (1) an asking
// price that is not Booli's own AVM, (2) >=1 real interior photo, (3) a viewing
// date. See docs/superpowers/specs/2026-08-13-premarket-quality-weekly-design.md
//
// Self-test: node lib/premarket-quality.js --smoke

module.exports = {};

if (require.main === module && process.argv.includes('--smoke')) {
  smoke();
}

function smoke() {
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }
  };
  const eq = (a, b, m) => {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error(`${m || ''} expected ${B}, got ${A}`);
  };

  console.log('=== lib/premarket-quality.js --smoke ===');

  // --- bucketOf: the four-branch rule -------------------------------------
  check('bucketOf: no images -> zero_photos', () => eq(bucketOf('none', 0), 'zero_photos'));
  check('bucketOf: interior label -> has_interior', () => eq(bucketOf('yes', 5), 'has_interior'));
  check('bucketOf: all labels null -> unlabelled', () => eq(bucketOf('unknown', 3), 'unlabelled'));
  check('bucketOf: 4 images none interior -> confirmed', () => eq(bucketOf('no', 4), 'no_interior_confirmed'));
  check('bucketOf: exactly 5 none interior -> ambiguous', () => eq(bucketOf('no', 5), 'ambiguous'));
  check('bucketOf: 5-cap is >=5 not ==5', () => eq(bucketOf('no', 9), 'ambiguous'));

  // --- categorise: the six-rung ladder ------------------------------------
  const L = (interior, price, viewing) => ({
    interiorVerdict: interior ? 'yes' : 'no',
    price: price ? 3300000 : null,
    nextShowing: viewing ? '2026-08-18 12:00' : null,
  });
  check('categorise: interior+price+viewing -> high', () => eq(categorise(L(1, 1, 1)), 'high'));
  check('categorise: interior+viewing, no price -> mid_high', () => eq(categorise(L(1, 0, 1)), 'mid_high'));
  check('categorise: interior+price, no viewing -> mid_sell', () => eq(categorise(L(1, 1, 0)), 'mid_sell'));
  check('categorise: interior only -> mid_fish', () => eq(categorise(L(1, 0, 0)), 'mid_fish'));
  check('categorise: nothing -> low', () => eq(categorise(L(0, 0, 0)), 'low'));
  check('categorise: no interior but priced -> other', () => eq(categorise(L(0, 1, 0)), 'other'));
  check('categorise: no interior but viewing -> other', () => eq(categorise(L(0, 0, 1)), 'other'));

  // --- ladderRows: cumulative + Hemnet suppression -------------------------
  const counts = {
    n_total: 100, high: 10, mid_high: 10, mid_sell: 30, mid_fish: 30, other: 10, low: 10,
  };
  check('ladderRows: cumulative counts accumulate', () => {
    const r = ladderRows(counts, null);
    eq(r.map(x => x.cumN), [10, 20, 50, 80, 90, 100]);
  });
  check('ladderRows: cumulative pct rounds to 0dp', () => {
    const r = ladderRows(counts, null);
    eq(r.map(x => x.cumPct), [10, 20, 50, 80, 90, 100]);
  });
  check('ladderRows: hemnet cell blank above 100%', () => {
    // hemnet=40 vs cum 10 -> 400% (blank), vs cum 50 -> 80% (shown)
    const r = ladderRows(counts, 40);
    eq(r.map(x => x.hemnetPct), [null, null, 80, 50, 44, 40]);
  });
  check('ladderRows: hemnet null when adds unavailable', () => {
    const r = ladderRows(counts, null);
    eq(r.every(x => x.hemnetPct === null), true);
  });
  check('ladderRows: zero-total cohort does not divide by zero', () => {
    const r = ladderRows({ n_total: 0, high: 0, mid_high: 0, mid_sell: 0, mid_fish: 0, other: 0, low: 0 }, 5);
    eq(r.every(x => x.cumPct === 0 && x.hemnetPct === null), true);
  });

  // --- tally: DB row shape -------------------------------------------------
  check('tally: counts, signal rates and provenance', () => {
    const t = tally([
      { interiorVerdict: 'yes', price: 1, nextShowing: 1, priceMissingAvmShown: false, bucket: 'has_interior', cardLabels: {} },
      { interiorVerdict: 'yes', price: null, nextShowing: null, priceMissingAvmShown: true, bucket: 'has_interior', cardLabels: {} },
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false, bucket: 'no_interior_confirmed', cardLabels: {} },
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false, bucket: 'ambiguous', cardLabels: {}, resolved: true },
    ]);
    eq(t.n_total, 4);
    eq(t.high, 1);
    eq(t.mid_fish, 1);
    eq(t.low, 2);
    eq(t.pct_interior, 50.0);
    eq(t.pct_price, 25.0);
    eq(t.pct_avm_shown, 25.0);
    eq(t.pct_viewing, 25.0);
    eq(t.n_ambiguous, 1);
    eq(t.n_resolved, 1);
  });
  check('tally: unknown labels surface as the taxonomy canary', () => {
    const t = tally([
      { interiorVerdict: 'no', price: null, nextShowing: null, priceMissingAvmShown: false,
        bucket: 'no_interior_confirmed', cardLabels: { some_new_label: 2, facade: 1 } },
    ]);
    eq(t.n_unknown_labels, 1);
  });

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `node lib/premarket-quality.js --smoke`
Expected: FAIL — `ReferenceError: bucketOf is not defined` (the functions do not exist yet).

- [ ] **Step 3: Write the implementation**

Insert above `module.exports` in `lib/premarket-quality.js`:

```js
const { interiorVerdict, unknownLabels } = require('./booli-image-labels');

const WINDOW_DAYS = 7;

// The four-branch rule this whole measurement rests on. The search card caps
// images at 5, so it can only ever UNDERCOUNT interiors: three verdicts are safe,
// one needs the listing page opened.
//   >=1 interior label      -> genuine; more photos can't unfind it     (safe)
//   0 images                -> empty / broker withheld                  (safe)
//   1-4 images, no interior -> that IS the whole gallery                (safe)
//   >=5 images, no interior -> cap hit, could be 5 photos or 71     (AMBIGUOUS)
function bucketOf(verdict, nPhotos) {
  if (verdict === 'none') return 'zero_photos';
  if (verdict === 'yes') return 'has_interior';
  if (verdict === 'unknown') return 'unlabelled';
  return nPhotos >= 5 ? 'ambiguous' : 'no_interior_confirmed';
}

// Buckets that cannot be categorised from the card alone. `unlabelled` (images
// present, every label null) measured 0 in August but is included here so it can
// never silently fall out of the cohort.
const NEEDS_PAGE = new Set(['ambiguous', 'unlabelled']);

const INT = c => c.interiorVerdict === 'yes';
const P   = c => c.price != null;
const V   = c => c.nextShowing != null;

// Ordered best -> worst. Each listing falls in exactly one; `match` is evaluated
// in order, so the ladder is a partition by construction.
const LADDER = [
  { key: 'high',     label: 'High — interior + price + viewing',   rule: 'interior + price + viewing',        match: c => INT(c) && P(c) && V(c) },
  { key: 'mid_high', label: 'Mid-high — interior + viewing',       rule: 'interior + viewing, no price',      match: c => INT(c) && !P(c) && V(c) },
  { key: 'mid_sell', label: 'Mid — interior + price',              rule: 'interior + price, no viewing',      match: c => INT(c) && P(c) && !V(c) },
  { key: 'mid_fish', label: 'Mid — interior only ("fishing")',     rule: 'interior only',                     match: c => INT(c) && !P(c) && !V(c) },
  // Commitment signals but no interior photos — kept visible rather than folded
  // into Low, since a priced listing with a booked viewing is not filler.
  { key: 'other',    label: 'Other — no interior, priced/booked',  rule: 'no interior, but price or viewing', match: c => !INT(c) && (P(c) || V(c)) },
  { key: 'low',      label: 'Low — marketing filler',              rule: 'none of the three',                 match: () => true },
];

function categorise(c) {
  for (const r of LADDER) if (r.match(c)) return r.key;
  return 'low';
}

const round1 = n => Math.round(n * 10) / 10;

// Aggregate a categorised cohort into the premarket_quality_weekly row shape
// (provenance columns are added by the caller, which knows about pages/calls).
function tally(listings) {
  const n = listings.length;
  const counts = { high: 0, mid_high: 0, mid_sell: 0, mid_fish: 0, other: 0, low: 0 };
  let interior = 0, price = 0, avm = 0, viewing = 0, ambiguous = 0, resolved = 0;
  const unknown = new Set();

  for (const c of listings) {
    counts[categorise(c)]++;
    if (INT(c)) interior++;
    if (P(c)) price++;
    if (c.priceMissingAvmShown) avm++;
    if (V(c)) viewing++;
    if (NEEDS_PAGE.has(c.bucket)) {
      ambiguous++;
      if (c.resolved) resolved++;
    }
    for (const l of unknownLabels(c.cardLabels)) unknown.add(l);
  }

  const pct = x => (n ? round1(100 * x / n) : 0);
  return {
    n_total: n,
    ...counts,
    pct_interior: pct(interior),
    pct_price: pct(price),
    pct_avm_shown: pct(avm),
    pct_viewing: pct(viewing),
    n_ambiguous: ambiguous,
    n_resolved: resolved,
    n_unknown_labels: unknown.size,
  };
}

// The report table: cumulative counts best-first, plus Hemnet's single total
// expressed as a % of each cumulative rung. Cells above 100% render blank — the
// first row carrying a number IS the parity point.
function ladderRows(counts, hemnetAdds) {
  let cum = 0;
  return LADDER.map(r => {
    const n = counts[r.key] || 0;
    cum += n;
    const cumPct = counts.n_total ? Math.round(100 * cum / counts.n_total) : 0;
    let hemnetPct = null;
    if (hemnetAdds != null && cum > 0) {
      const p = 100 * hemnetAdds / cum;
      hemnetPct = p > 100 ? null : Math.round(p);
    }
    return { key: r.key, label: r.label, n, cumN: cum, cumPct, hemnetPct };
  });
}
```

Then replace the empty export with:

```js
module.exports = {
  WINDOW_DAYS, bucketOf, NEEDS_PAGE, LADDER, categorise, tally, ladderRows,
};
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node lib/premarket-quality.js --smoke`
Expected: every line `PASS`, final line `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/premarket-quality.js
git commit -m "feat(premarket-quality): rubric library — four-branch rule, six-rung ladder, cumulative table"
```

---

### Task 2: August regression fixture and oracle

The rewrite must reproduce the audited August result. The source artifact is ~2 MB and **untracked**, so this task derives a committed fixture BEFORE Task 8 deletes the scripts that produced it.

**Files:**
- Create: `test-fixtures/premarket-quality-2026-08-11.json`
- Create: `scripts/premarket-quality-oracle.js`
- Read (untracked, must exist locally): `verf-premarket-quality/week-2026-08-11-resolved-fixed-categorised.json`

**Interfaces:**
- Consumes: `lib/premarket-quality.js` → `categorise`, `tally`
- Produces: nothing consumed by later tasks; this is a standalone regression gate

- [ ] **Step 1: Derive the trimmed fixture**

Run this one-off from the repo root. It keeps only the seven fields the rubric reads, plus the stored `category` to assert against:

```bash
node -e "
const fs=require('fs');
const src='verf-premarket-quality/week-2026-08-11-resolved-fixed-categorised.json';
if(!fs.existsSync(src)){console.error('MISSING '+src+' — cannot build the oracle fixture. STOP.');process.exit(1);}
const D=JSON.parse(fs.readFileSync(src,'utf8'));
const rows=D.listings.map(l=>({
  booli_id:l.booli_id, interiorVerdict:l.interiorVerdict, price:l.price,
  nextShowing:l.nextShowing?1:null, priceMissingAvmShown:!!l.priceMissingAvmShown,
  bucket:l.bucket, cardLabels:l.cardLabels||{}, category:l.category,
}));
fs.mkdirSync('test-fixtures',{recursive:true});
fs.writeFileSync('test-fixtures/premarket-quality-2026-08-11.json',
  JSON.stringify({meta:{source:src,derived:'2026-08-13',n:rows.length},listings:rows}));
console.log('wrote '+rows.length+' rows');
"
```

Expected: `wrote 2264 rows`. If the count differs, STOP and reconcile against `docs/handover/booli-premarket-quality.md` §3 before continuing.

- [ ] **Step 2: Write the failing oracle**

Create `scripts/premarket-quality-oracle.js`:

```js
'use strict';
// scripts/premarket-quality-oracle.js — regression gate.
// Replays the audited August 2026 cohort (n=2,264) through lib/premarket-quality.js
// and asserts it reproduces the published figures in
// docs/handover/booli-premarket-quality.md §3. If this fails, the rubric changed.
//
// Run: node scripts/premarket-quality-oracle.js
const fs = require('fs');
const path = require('path');
const { categorise, tally } = require('../lib/premarket-quality');

const FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'premarket-quality-2026-08-11.json');

// Published August figures. Tolerance 0.1pp absorbs rounding only.
const EXPECTED = {
  n_total: 2264,
  pct_interior: 87.1,
  pct_price: 54.3,
  pct_avm_shown: 39.7,
  pct_viewing: 21.1,
  pct_coming_to_market: 19.7,   // high + mid_high
  pct_low: 6.4,
};
const TOL = 0.1;

function run() {
  const D = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const settled = D.listings.filter(l => l.category && l.category !== 'unresolved');
  let failed = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log(`  PASS  ${name}`);
    else { failed++; console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); }
  };

  console.log(`=== premarket-quality oracle — ${D.listings.length} listings ===`);

  // Strictest check: every stored per-listing category must be reproduced.
  const mismatches = settled.filter(l => categorise(l) !== l.category);
  check(`per-listing categories reproduce (${settled.length} settled)`,
    mismatches.length === 0,
    mismatches.length ? `${mismatches.length} mismatched, first booli_id=${mismatches[0].booli_id} ` +
      `stored=${mismatches[0].category} got=${categorise(mismatches[0])}` : '');

  const t = tally(settled);
  const near = (a, b) => Math.abs(a - b) <= TOL;
  check('n_total', t.n_total === EXPECTED.n_total, `expected ${EXPECTED.n_total}, got ${t.n_total}`);
  for (const k of ['pct_interior', 'pct_price', 'pct_avm_shown', 'pct_viewing']) {
    check(k, near(t[k], EXPECTED[k]), `expected ${EXPECTED[k]}, got ${t[k]}`);
  }
  const coming = Math.round(1000 * (t.high + t.mid_high) / t.n_total) / 10;
  check('pct genuinely coming to market', near(coming, EXPECTED.pct_coming_to_market),
    `expected ${EXPECTED.pct_coming_to_market}, got ${coming}`);
  const low = Math.round(1000 * t.low / t.n_total) / 10;
  check('pct marketing filler', near(low, EXPECTED.pct_low),
    `expected ${EXPECTED.pct_low}, got ${low}`);

  console.log(failed === 0 ? '\nORACLE PASS' : `\n${failed} FAILED — the rubric no longer reproduces August`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
```

- [ ] **Step 3: Run the oracle**

Run: `node scripts/premarket-quality-oracle.js`
Expected: `ORACLE PASS`.

If the per-listing check fails, the ladder ordering or the `other` rule differs from August — compare against `scripts/premarket-quality-categorise.js:42-49` before changing anything. Do not adjust `EXPECTED` to make the test pass; those are audited published numbers.

- [ ] **Step 4: Commit**

```bash
git add test-fixtures/premarket-quality-2026-08-11.json scripts/premarket-quality-oracle.js
git commit -m "test(premarket-quality): August regression oracle over the audited 2,264-listing cohort"
```

---

### Task 3: Database table

**Files:**
- Create: `migrate-premarket-quality.js`

**Interfaces:**
- Consumes: `db.js` → `createClient()` (synchronous; caller must `await client.connect()`)
- Produces: table `premarket_quality_weekly`, PK `snapshot_date`

- [ ] **Step 1: Write the migration**

Create `migrate-premarket-quality.js`, mirroring `migrate-premarket-flow.js`:

```js
// migrate-premarket-quality.js — creates premarket_quality_weekly (idempotent).
// Run manually: node migrate-premarket-quality.js
// Spec: docs/superpowers/specs/2026-08-13-premarket-quality-weekly-design.md
//
// One row per snapshot_date. Written by scripts/premarket-quality-measure.js,
// read by premarket-flow-weekly-report.js and joined against premarket_flow_weekly
// on snapshot_date to place Hemnet's total on Booli's quality ladder.
const { createClient } = require('./db');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS premarket_quality_weekly (
    snapshot_date      DATE        NOT NULL PRIMARY KEY,
    window_days        INTEGER     NOT NULL,
    n_total            INTEGER     NOT NULL,
    n_high             INTEGER     NOT NULL,
    n_mid_high         INTEGER     NOT NULL,
    n_mid_sell         INTEGER     NOT NULL,
    n_mid_fish         INTEGER     NOT NULL,
    n_other            INTEGER     NOT NULL,
    n_low              INTEGER     NOT NULL,
    pct_interior       NUMERIC     NOT NULL,
    pct_price          NUMERIC     NOT NULL,
    pct_avm_shown      NUMERIC     NOT NULL,
    pct_viewing        NUMERIC     NOT NULL,
    n_ambiguous        INTEGER     NOT NULL,
    n_resolved         INTEGER     NOT NULL,
    n_unknown_labels   INTEGER     NOT NULL,
    pages_walked       INTEGER     NOT NULL,
    oxylabs_calls      INTEGER     NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_TABLE);
    console.log('Created table: premarket_quality_weekly');
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'premarket_quality_weekly'
        ORDER BY ordinal_position`
    );
    console.log(`Columns (${check.rows.length}): ${check.rows.map(r => r.column_name).join(', ')}`);
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Verify it parses**

Run: `node --check migrate-premarket-quality.js`
Expected: no output, exit 0.

Do NOT run it against the database yet — Task 6 runs it as part of the first end-to-end check, and the local machine may not be IP-whitelisted.

- [ ] **Step 3: Commit**

```bash
git add migrate-premarket-quality.js
git commit -m "feat(premarket-quality): premarket_quality_weekly table migration"
```

---

### Task 4: Measure job — walk and classify

**Files:**
- Create: `scripts/premarket-quality-measure.js`

**Interfaces:**
- Consumes: `lib/premarket-flow.js` → `walkFlow({fetchPage, nowSec, windowDays, maxPages, logger})` returning `{addsSecondhand, newbuildInWindow, datedInWindow, pagesWalked, cards}`; `lib/scrape-http.js` → `getWithRetry(url, {logger})` returning `{html}`, `extractNextData(html)`, `getOxylabsStats()`; `lib/booli-image-labels.js` → `interiorVerdict(labels)`; `lib/premarket-quality.js` → `bucketOf`
- Produces: `richCard(L, S) → listing object`, `parsePage(S) → {cards, totalCount}`, `collectWeek({fetchPage, nowSec, logger}) → {listings, pagesWalked}`

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/premarket-quality-measure.js` with the header and smoke block only:

```js
'use strict';
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/premarket-quality-measure.js — weekly Booli pre-market quality measurement.
//
// Walks one week of new pre-market listings, classifies each from its search card,
// opens the ambiguous ones (card image cap hides interiors), categorises the cohort
// on the six-rung ladder, and persists one row to premarket_quality_weekly.
//
// Replaces the manual four-script pipeline (premarket-quality-week / -resolve /
// -recompute / -categorise). Rubric lives in lib/premarket-quality.js.
//
// Cron: Mon 09:00 UTC, after premarket-flow-measure (08:50), before the report (09:40).
// Cost: ~604 Oxylabs calls ≈ $1.51/week.
//
// Self-test: node scripts/premarket-quality-measure.js --smoke   (offline, no DB, no network)

const { walkFlow } = require('../lib/premarket-flow');
const { getWithRetry, extractNextData, getOxylabsStats } = require('../lib/scrape-http');
const { interiorVerdict } = require('../lib/booli-image-labels');
const { bucketOf, NEEDS_PAGE, tally, WINDOW_DAYS } = require('../lib/premarket-quality');

const MAX_PAGES = 120;          // flow job uses 80; ~71 expected, so 80 could truncate
const WALK_CALL_CEILING = 130;

// No `sort` param — any sort=* flips Booli to oldest-first.
const searchUrl = p => `https://www.booli.se/sok/till-salu?upcomingSale=1&page=${p}`;

if (require.main === module && process.argv.includes('--smoke')) {
  smoke();
}

function smoke() {
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

  console.log('=== premarket-quality-measure --smoke ===');

  check('searchUrl carries upcomingSale and no sort param', () => {
    const u = searchUrl(3);
    assert(u.includes('upcomingSale=1'), 'missing upcomingSale');
    assert(u.includes('page=3'), 'missing page');
    assert(!/[?&]sort=/.test(u), 'sort param would flip Booli to oldest-first');
  });

  // Minimal Apollo state: one listing with a 5-image all-exterior gallery.
  const S = {
    ROOT_QUERY: { 'searchForSale({"x":1})': { result: [{ __ref: 'Listing:1' }], totalCount: 1 } },
    'Listing:1': {
      __typename: 'Listing', id: 1, url: 'https://www.booli.se/annons/1',
      published: 1786000000, isNewConstruction: false, upcomingSale: true,
      listPrice: { raw: 3300000 }, nextShowing: { fullDateAndTime: '2026-08-18 12:00' },
      'images(x)': [{ __ref: 'Img:1' }, { __ref: 'Img:2' }, { __ref: 'Img:3' },
                    { __ref: 'Img:4' }, { __ref: 'Img:5' }],
    },
    'Img:1': { primaryLabel: 'facade' }, 'Img:2': { primaryLabel: 'floorplan' },
    'Img:3': { primaryLabel: 'nearby_area' }, 'Img:4': { primaryLabel: 'facade' },
    'Img:5': { primaryLabel: 'garden' },
  };

  check('parsePage extracts one card', () => {
    const { cards } = parsePage(S);
    assert(cards.length === 1, `expected 1 card, got ${cards.length}`);
  });
  check('5 exterior images classify as ambiguous', () => {
    const c = parsePage(S).cards[0];
    assert(c.bucket === 'ambiguous', `expected ambiguous, got ${c.bucket}`);
    assert(NEEDS_PAGE.has(c.bucket), 'ambiguous must need the page');
  });
  check('card fields carry through', () => {
    const c = parsePage(S).cards[0];
    assert(c.booli_id === '1', 'booli_id');
    assert(c.url === 'https://www.booli.se/annons/1', 'canonical /annons url');
    assert(c.price === 3300000, 'price');
    assert(c.nextShowing !== null, 'nextShowing');
    assert(c.priceMissingAvmShown === false, 'priced listing is not AVM-shown');
  });
  check('AVM-shown detected when price absent but estimate present', () => {
    const S2 = JSON.parse(JSON.stringify(S));
    delete S2['Listing:1'].listPrice;
    S2['Listing:1'].estimate = { price: { raw: 2900000 } };
    const c = parsePage(S2).cards[0];
    assert(c.price === null, 'price should be null');
    assert(c.priceMissingAvmShown === true, 'AVM should be flagged');
  });
  check('interior label settles the card without a page fetch', () => {
    const S3 = JSON.parse(JSON.stringify(S));
    S3['Img:3'].primaryLabel = 'kitchen';
    const c = parsePage(S3).cards[0];
    assert(c.bucket === 'has_interior', `expected has_interior, got ${c.bucket}`);
  });
  check('new-build cards are flagged for exclusion', () => {
    const S4 = JSON.parse(JSON.stringify(S));
    S4['Listing:1'].isNewConstruction = true;
    const c = parsePage(S4).cards[0];
    assert(c.isNewBuild === true, 'isNewBuild must be set for walkFlow and the filter');
  });

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `node scripts/premarket-quality-measure.js --smoke`
Expected: FAIL — `parsePage is not defined`.

- [ ] **Step 3: Write the implementation**

Insert before the `if (require.main === module ...)` gate. `richCard` and `parsePage` are lifted verbatim from `scripts/premarket-quality-week.js:60-130` with `bucketOf` now imported rather than local:

Add `parsePublishedToUnix` to the imports — it is already exported by `lib/booli-fetch.js:321`.
Import it; do NOT modify that file, and do NOT hand-roll a second date parser:

```js
const { parsePublishedToUnix } = require('../lib/booli-fetch');
```

```js
function apolloFrom(html) {
  const d = extractNextData(html);
  const a = d && d.props && d.props.pageProps && d.props.pageProps.__APOLLO_STATE__;
  if (!a) throw new Error('__APOLLO_STATE__ missing');
  return a;
}

function dataPoints(L) {
  const k = Object.keys(L).find(x => x.startsWith('displayAttributes('));
  const d = L[k];
  return (d && Array.isArray(d.dataPoints) ? d.dataPoints : [])
    .map(p => p && p.value && p.value.plainText).filter(Boolean);
}

function richCard(L, S) {
  const imgKey = Object.keys(L).find(k => k.startsWith('images('));
  const imgs = (Array.isArray(L[imgKey]) ? L[imgKey] : [])
    .map(r => (r && r.__ref ? S[r.__ref] : r)).filter(Boolean);
  const labels = imgs.map(i => (i.primaryLabel === undefined ? null : i.primaryLabel));
  const verdict = interiorVerdict(labels);

  const loc = L.location && L.location.__ref ? S[L.location.__ref] : L.location;
  const muni = (loc && loc.region && loc.region.municipalityName) || null;
  const agKey = Object.keys(L).find(k => k.startsWith('agency('));

  const dp = dataPoints(L);
  const price = L.listPrice && typeof L.listPrice.raw === 'number' ? L.listPrice.raw : null;
  const estimate = L.estimate && L.estimate.price && typeof L.estimate.price.raw === 'number'
    ? L.estimate.price.raw : null;

  const labelCounts = {};
  for (const l of labels) { const k = l == null ? 'NULL' : l; labelCounts[k] = (labelCounts[k] || 0) + 1; }

  return {
    booli_id: L.id != null ? String(L.id) : null,
    url: L.url || null,
    // 🚨 Booli serves `published` as a 'YYYY-MM-DD HH:MM:SS' STRING on search
    // cards, not Unix seconds. Passing it through raw makes every downstream
    // numeric comparison (`published >= cutoff`) false, which empties the cohort
    // AND stops walkFlow's `pageEntirelyOld` from ever firing — so the walk runs
    // to maxPages. parsePublishedToUnix accepts both forms defensively.
    published: parsePublishedToUnix(L.published),
    publishedRaw: L.published || null,
    // walkFlow reads exactly these two keys — everything else rides along free.
    isNewBuild: L.isNewConstruction === true,
    upcomingSale: L.upcomingSale === true,
    price, estimate,
    priceMissingAvmShown: price == null && estimate != null,
    cardPhotos: imgs.length,
    blockedImages: L.blockedImages === true,
    cardLabels: labelCounts,
    interiorVerdict: verdict,
    bucket: bucketOf(verdict, imgs.length),
    resolved: false,
    nextShowing: L.nextShowing ? (L.nextShowing.fullDateAndTime || true) : null,
    objectType: L.objectType || null,
    municipality: muni,
    agency: (L[agKey] && L[agKey].name) || null,
    sizeM2: dp.find(x => /m²/.test(x) && !/tomt/.test(x)) || null,
  };
}

function parsePage(S) {
  const root = S.ROOT_QUERY || {};
  const key = Object.keys(root).find(k => k.startsWith('searchForSale') && Array.isArray(root[k].result));
  if (!key) throw new Error('no searchForSale result node');
  const cards = [];
  for (const ref of root[key].result) {
    const L = ref && ref.__ref ? S[ref.__ref] : null;
    if (L && L.__typename === 'Listing') cards.push(richCard(L, S));
  }
  return { cards, totalCount: root[key].totalCount };
}

// Walk the week newest-first. Reuses walkFlow so the window boundary logic is
// identical to the production flow job — the two numerators must be comparable.
async function collectWeek({ fetchPage, nowSec, logger }) {
  const res = await walkFlow({ fetchPage, nowSec, windowDays: WINDOW_DAYS, maxPages: MAX_PAGES, logger });
  const cutoff = nowSec - WINDOW_DAYS * 86400;
  const listings = res.cards.filter(c =>
    c.upcomingSale && !c.isNewBuild && c.published != null && c.published >= cutoff);
  return { listings, pagesWalked: res.pagesWalked };
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node scripts/premarket-quality-measure.js --smoke`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/premarket-quality-measure.js
git commit -m "feat(premarket-quality): measure job — week walk and card classification"
```

---

### Task 5: Measure job — resolve the ambiguous bucket

Every listing whose card shows ≥5 images with no interior label gets its detail page opened. No sampling, no cap beyond the spend guard.

**Files:**
- Modify: `scripts/premarket-quality-measure.js`

**Interfaces:**
- Consumes: `richCard`/`parsePage` from Task 4; `lib/booli-image-labels.js` → `INTERIOR`
- Produces: `galleryOf(S) → {photos, labels, labelCounts, interiorN} | null`, `resolveAmbiguous({listings, fetchDetail, logger}) → {opened, failed}`

- [ ] **Step 1: Add the failing smoke cases**

Add these inside `smoke()`, before the final `console.log`:

```js
  // --- resolve stage --------------------------------------------------------
  const detailS = {
    'Listing:9': {
      __typename: 'Listing', id: 9,
      'images(full)': [{ __ref: 'D1' }, { __ref: 'D2' }, { __ref: 'D3' }],
      'images(small)': [{ __ref: 'D1' }],
    },
    D1: { primaryLabel: 'facade' }, D2: { primaryLabel: 'bedroom' }, D3: { primaryLabel: 'facade' },
  };
  check('galleryOf takes the longest images array', () => {
    const g = galleryOf(detailS);
    assert(g.photos === 3, `expected 3 photos, got ${g && g.photos}`);
    assert(g.interiorN === 1, `expected 1 interior, got ${g && g.interiorN}`);
  });

  check('resolve rescues an ambiguous listing that has interiors', async () => {
    const listings = [{ booli_id: '9', url: 'https://www.booli.se/annons/9',
      bucket: 'ambiguous', interiorVerdict: 'no', resolved: false, cardLabels: {} }];
    const r = await resolveAmbiguous({
      listings, logger: () => {},
      fetchDetail: async () => detailS,
    });
    assert(r.opened === 1, `opened ${r.opened}`);
    assert(r.failed === 0, `failed ${r.failed}`);
    assert(listings[0].interiorVerdict === 'yes', 'should be rescued to yes');
    assert(listings[0].resolved === true, 'should be marked resolved');
  });

  check('resolve confirms no-interior when the full gallery has none', async () => {
    const noInt = { 'Listing:8': { __typename: 'Listing', id: 8, 'images(full)': [{ __ref: 'E1' }] },
      E1: { primaryLabel: 'facade' } };
    const listings = [{ booli_id: '8', url: 'https://www.booli.se/annons/8',
      bucket: 'ambiguous', interiorVerdict: 'no', resolved: false, cardLabels: {} }];
    await resolveAmbiguous({ listings, logger: () => {}, fetchDetail: async () => noInt });
    assert(listings[0].interiorVerdict === 'no', 'should stay no');
    assert(listings[0].resolved === true, 'should still be marked resolved');
  });

  check('a failed detail fetch is tolerated, not fatal', async () => {
    const listings = [{ booli_id: '7', url: 'https://www.booli.se/annons/7',
      bucket: 'ambiguous', interiorVerdict: 'no', resolved: false, cardLabels: {} }];
    const r = await resolveAmbiguous({
      listings, logger: () => {},
      fetchDetail: async () => { throw new Error('timeout'); },
    });
    assert(r.failed === 1, `expected 1 failure, got ${r.failed}`);
    assert(listings[0].resolved === false, 'unresolved listing must not be marked resolved');
  });

  check('settled listings are never opened', async () => {
    let calls = 0;
    const listings = [{ booli_id: '6', url: 'u', bucket: 'has_interior',
      interiorVerdict: 'yes', resolved: false, cardLabels: {} }];
    await resolveAmbiguous({ listings, logger: () => {},
      fetchDetail: async () => { calls++; return detailS; } });
    assert(calls === 0, `settled listing must not be fetched, got ${calls} calls`);
  });
```

Because these cases are `async`, change the `check` helper in `smoke()` to await:

```js
  const results = [];
  const check = (name, fn) => {
    results.push(Promise.resolve().then(fn).then(
      () => console.log(`  PASS  ${name}`),
      e => { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }));
  };
```

and make `smoke()` `async`, ending with `await Promise.all(results);` before the summary line.

- [ ] **Step 2: Run to verify the new cases fail**

Run: `node scripts/premarket-quality-measure.js --smoke`
Expected: the Task 4 cases still PASS; the five new cases FAIL with `galleryOf is not defined` / `resolveAmbiguous is not defined`.

- [ ] **Step 3: Write the implementation**

Add `INTERIOR` to the label import:

```js
const { interiorVerdict, INTERIOR } = require('../lib/booli-image-labels');
```

Add the resolve constants and functions:

```js
const RESOLVE_CALL_CEILING = 700;
const RESOLVE_CONCURRENCY = 4;

// The detail gallery is NOT limit-capped. Take the longest images array on the
// canonical Listing node. (Lifted from scripts/premarket-quality-resolve.js:41-60.)
function galleryOf(S) {
  let L = null;
  for (const k of Object.keys(S)) {
    if (k.startsWith('Listing:') && S[k] && S[k].__typename === 'Listing') { L = S[k]; break; }
  }
  if (!L) return null;
  let imgs = [];
  for (const k of Object.keys(L)) {
    if (!k.startsWith('images')) continue;
    const r = (Array.isArray(L[k]) ? L[k] : []).map(x => (x && x.__ref ? S[x.__ref] : x)).filter(Boolean);
    if (r.length > imgs.length) imgs = r;
  }
  const labels = imgs.map(i => (i.primaryLabel === undefined ? null : i.primaryLabel));
  const labelCounts = {};
  for (const l of labels) { const k = l == null ? 'NULL' : l; labelCounts[k] = (labelCounts[k] || 0) + 1; }
  return { photos: imgs.length, labels, labelCounts, interiorN: labels.filter(l => INTERIOR.has(l)).length };
}

// Open EVERY listing the card could not settle. A failure leaves the listing
// unresolved rather than mis-categorised — tally() counts the shortfall and
// validate() escalates it.
async function resolveAmbiguous({ listings, fetchDetail, logger }) {
  const queue = listings.filter(l => NEEDS_PAGE.has(l.bucket));
  let opened = 0, failed = 0, next = 0;

  async function worker() {
    while (next < queue.length) {
      const l = queue[next++];
      if (opened + failed >= RESOLVE_CALL_CEILING) {
        logger('WARN', `resolve ceiling ${RESOLVE_CALL_CEILING} hit — ${queue.length - next} left unopened`);
        return;
      }
      try {
        const g = galleryOf(await fetchDetail(l.url));
        if (!g) throw new Error('no Listing node in detail page');
        l.interiorVerdict = g.interiorN > 0 ? 'yes' : 'no';
        l.galleryPhotos = g.photos;
        l.cardLabels = g.labelCounts;   // full gallery labels feed the taxonomy canary
        l.resolved = true;
        opened++;
      } catch (e) {
        failed++;
        logger('WARN', `resolve failed for ${l.url}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, worker));
  logger('INFO', `resolve: ${opened} opened, ${failed} failed, of ${queue.length} needing a page`);
  return { opened, failed };
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node scripts/premarket-quality-measure.js --smoke`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/premarket-quality-measure.js
git commit -m "feat(premarket-quality): resolve stage — open every card-ambiguous listing"
```

---

### Task 6: Measure job — persist, guards and cron wiring

**Files:**
- Modify: `scripts/premarket-quality-measure.js`

**Interfaces:**
- Consumes: `cron-wrapper.js` → `runJob({scriptName, main, validate})`; `main(client, log)` receives a connected pg client and a logger; `validate(summary)` returns a string to mark the run a warning, or falsy for success
- Produces: DB row in `premarket_quality_weekly`; `result_summary` in `cron_job_log`

- [ ] **Step 1: Add the failing guard smoke cases**

Add inside `smoke()`:

```js
  // --- validate() thresholds ------------------------------------------------
  const base = { n_total: 2264, n_ambiguous: 537, n_resolved: 537, n_unknown_labels: 0, volumeAnomaly: null };
  check('validate: clean run returns nothing', () => {
    assert(!validate(base), 'clean run should not warn');
  });
  check('validate: >10% unresolved warns', () => {
    const v = validate({ ...base, n_resolved: 480 });   // 57/537 = 10.6%
    assert(/unresolved/i.test(v || ''), `expected unresolved warning, got ${v}`);
  });
  check('validate: exactly 10% unresolved does not warn', () => {
    const v = validate({ ...base, n_ambiguous: 100, n_resolved: 90 });
    assert(!v, `10% should be within tolerance, got ${v}`);
  });
  check('validate: unknown labels warn (taxonomy drift canary)', () => {
    const v = validate({ ...base, n_unknown_labels: 2 });
    assert(/label/i.test(v || ''), `expected label warning, got ${v}`);
  });
  check('validate: volume anomaly warns', () => {
    const v = validate({ ...base, volumeAnomaly: 'n_total 900 is -60% vs 4-week mean 2250' });
    assert(/vs 4-week mean/.test(v || ''), `expected volume warning, got ${v}`);
  });
  check('validate: zero listings is a hard failure not a warning', () => {
    let threw = false;
    try { assertCohortNonEmpty(0); } catch (e) { threw = true; }
    assert(threw, 'empty cohort must throw');
  });
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `node scripts/premarket-quality-measure.js --smoke`
Expected: new cases FAIL with `validate is not defined` / `assertCohortNonEmpty is not defined`.

- [ ] **Step 3: Write the implementation**

Add before the smoke gate:

```js
const UNRESOLVED_WARN_PCT = 10;
const VOLUME_ANOMALY_PCT = 40;
const VOLUME_HISTORY_WEEKS = 4;

// A zero-listing cohort means the walk or the parser broke, not that Sweden
// stopped selling houses. Fail hard and persist nothing — the same guard that
// was missing when spotcheck-photos.js wrote back an empty result set.
function assertCohortNonEmpty(n) {
  if (!n) throw new Error('walk produced 0 in-window listings — refusing to persist');
}

// Compare this week's volume against the trailing mean. Silent until enough
// history exists; a short series must not manufacture an alarm.
function volumeAnomaly(nTotal, priorTotals) {
  if (priorTotals.length < VOLUME_HISTORY_WEEKS) return null;
  const mean = priorTotals.reduce((a, b) => a + b, 0) / priorTotals.length;
  if (!mean) return null;
  const deltaPct = Math.round(100 * (nTotal - mean) / mean);
  if (Math.abs(deltaPct) <= VOLUME_ANOMALY_PCT) return null;
  return `n_total ${nTotal} is ${deltaPct > 0 ? '+' : ''}${deltaPct}% vs ${VOLUME_HISTORY_WEEKS}-week mean ${Math.round(mean)}`;
}

function validate(summary) {
  const problems = [];
  if (summary.n_ambiguous > 0) {
    const unresolvedPct = 100 * (summary.n_ambiguous - summary.n_resolved) / summary.n_ambiguous;
    if (unresolvedPct > UNRESOLVED_WARN_PCT) {
      problems.push(`${summary.n_ambiguous - summary.n_resolved}/${summary.n_ambiguous} ambiguous listings unresolved (${unresolvedPct.toFixed(1)}%)`);
    }
  }
  if (summary.n_unknown_labels > 0) {
    problems.push(`${summary.n_unknown_labels} unknown image label(s) — Booli taxonomy may have changed, check lib/booli-image-labels.js`);
  }
  if (summary.volumeAnomaly) problems.push(summary.volumeAnomaly);
  return problems.length ? problems.join(' · ') : null;
}

const UPSERT = `
  INSERT INTO premarket_quality_weekly (
    snapshot_date, window_days, n_total,
    n_high, n_mid_high, n_mid_sell, n_mid_fish, n_other, n_low,
    pct_interior, pct_price, pct_avm_shown, pct_viewing,
    n_ambiguous, n_resolved, n_unknown_labels, pages_walked, oxylabs_calls
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  ON CONFLICT (snapshot_date) DO UPDATE SET
    window_days = EXCLUDED.window_days, n_total = EXCLUDED.n_total,
    n_high = EXCLUDED.n_high, n_mid_high = EXCLUDED.n_mid_high,
    n_mid_sell = EXCLUDED.n_mid_sell, n_mid_fish = EXCLUDED.n_mid_fish,
    n_other = EXCLUDED.n_other, n_low = EXCLUDED.n_low,
    pct_interior = EXCLUDED.pct_interior, pct_price = EXCLUDED.pct_price,
    pct_avm_shown = EXCLUDED.pct_avm_shown, pct_viewing = EXCLUDED.pct_viewing,
    n_ambiguous = EXCLUDED.n_ambiguous, n_resolved = EXCLUDED.n_resolved,
    n_unknown_labels = EXCLUDED.n_unknown_labels,
    pages_walked = EXCLUDED.pages_walked, oxylabs_calls = EXCLUDED.oxylabs_calls,
    created_at = NOW()
`;

// 🚨 getOxylabsStats() exposes { oxylabsCallCount, oxylabsFailureCount,
// directSuccessCount, oxylabsFallbackRate } — there is NO `requests` field.
// Reading `.requests` yields undefined, so the subtraction yields NaN, and
// node-pg serialises NaN as the string "NaN", which Postgres rejects on an
// INTEGER column (22P02). The job would spend the full ~$1.51 and THEN fail on
// the final insert, every week, persisting nothing. Total calls = Oxylabs +
// direct, matching scripts/premarket-flow-measure.js:103.
const oxCallsTotal = () => {
  const s = getOxylabsStats();
  return s.oxylabsCallCount + s.directSuccessCount;
};

async function main(client, log) {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  const callsAtStart = oxCallsTotal();

  let walkCalls = 0;
  const fetchPage = async (p) => {
    if (++walkCalls > WALK_CALL_CEILING) throw new Error(`walk ceiling ${WALK_CALL_CEILING} exceeded`);
    return parsePage(apolloFrom((await getWithRetry(searchUrl(p), { logger: () => {} })).html)).cards;
  };
  const fetchDetail = async (url) => apolloFrom((await getWithRetry(url, { logger: () => {} })).html);

  const { listings, pagesWalked } = await collectWeek({ fetchPage, nowSec, logger: log });
  log('INFO', `walked ${pagesWalked} pages -> ${listings.length} in-window 2nd-hand listings`);
  assertCohortNonEmpty(listings.length);

  await resolveAmbiguous({ listings, fetchDetail, logger: log });

  const counts = tally(listings);
  const oxylabsCalls = oxCallsTotal() - callsAtStart;

  const prior = await client.query(
    `SELECT n_total FROM premarket_quality_weekly
      WHERE snapshot_date < $1::date ORDER BY snapshot_date DESC LIMIT $2`,
    [today, VOLUME_HISTORY_WEEKS]
  );
  const anomaly = volumeAnomaly(counts.n_total, prior.rows.map(r => Number(r.n_total)));

  await client.query(UPSERT, [
    today, WINDOW_DAYS, counts.n_total,
    counts.high, counts.mid_high, counts.mid_sell, counts.mid_fish, counts.other, counts.low,
    counts.pct_interior, counts.pct_price, counts.pct_avm_shown, counts.pct_viewing,
    counts.n_ambiguous, counts.n_resolved, counts.n_unknown_labels, pagesWalked, oxylabsCalls,
  ]);

  log('INFO', `persisted ${today}: coming-to-market ${counts.high + counts.mid_high}/${counts.n_total}, ` +
    `filler ${counts.low}, ${oxylabsCalls} Oxylabs calls`);

  return { ...counts, pagesWalked, oxylabsCalls, volumeAnomaly: anomaly };
}
```

Replace the smoke gate at the bottom with an entry gate that runs the job when `--smoke` is absent:

```js
// Entry gate: --smoke runs the offline self-test; otherwise the job runs under cron-wrapper.
if (require.main === module && process.argv.includes('--smoke')) {
  smoke();
} else if (require.main === module) {
  require('../cron-wrapper').runJob({
    scriptName: 'premarket-quality-measure',
    main,
    validate,
  });
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node scripts/premarket-quality-measure.js --smoke`
Expected: `ALL PASS`, exit 0. Confirm it did NOT attempt a DB connection or a network call.

- [ ] **Step 5: Commit**

```bash
git add scripts/premarket-quality-measure.js
git commit -m "feat(premarket-quality): persist weekly row, guards and cron-wrapper wiring"
```

---

### Task 7: Report — the quality block

**Files:**
- Modify: `premarket-flow-weekly-report.js`

**Interfaces:**
- Consumes: `lib/premarket-quality.js` → `ladderRows(counts, hemnetAdds)`; existing helpers in the file — `fmtNumber`, `lpad`, `rpad`
- Produces: `qualityBlock({quality, hemnetAdds, flowWindowDays}) → string[]`

- [ ] **Step 1: Write the failing smoke test**

`premarket-flow-weekly-report.js` has no `--smoke` today. Add one at the bottom, before the final `run().catch(...)` line, and change that line to an entry gate:

```js
// Entry gate: --smoke runs the offline self-test; otherwise the report runs.
if (require.main === module && process.argv.includes('--smoke')) {
  smoke();
} else if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}

// --smoke self-test — fully offline (no DB, no network, no Slack post).
function smoke() {
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

  console.log('=== premarket-flow-weekly-report --smoke ===');

  const quality = {
    window_days: 7, n_total: 2264,
    n_high: 340, n_mid_high: 106, n_mid_sell: 758, n_mid_fish: 767, n_other: 145, n_low: 148,
    pct_interior: 87.1, pct_price: 54.3, pct_avm_shown: 39.7, pct_viewing: 21.1,
    n_ambiguous: 537, n_resolved: 537,
  };

  check('renders one row per ladder rung plus header and signals', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 7 });
    assert(out.some(l => /High — interior \+ price \+ viewing/.test(l)), 'missing High row');
    assert(out.some(l => /Low — marketing filler/.test(l)), 'missing Low row');
    assert(out.some(l => /interior 87%/.test(l)), 'missing signals line');
  });
  check('percentages render to 0 decimal places', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 7 }).join('\n');
    assert(!/\d\.\d%/.test(out), `found a decimal percentage in:\n${out}`);
  });
  check('Hemnet cell blank above 100%, present at parity', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 7 });
    const high = out.find(l => /High — interior/.test(l));
    const midSell = out.find(l => /Mid — interior \+ price/.test(l));
    assert(/—\s*$/.test(high), `High row should end with an em dash: "${high}"`);
    assert(/96%\s*$/.test(midSell), `Mid row should end with 96%: "${midSell}"`);
  });
  check('missing quality row degrades to one line', () => {
    const out = qualityBlock({ quality: null, hemnetAdds: 1150, flowWindowDays: 7 });
    assert(out.length === 2, `expected a blank line plus one message, got ${out.length}`);
    assert(/did not land/i.test(out.join(' ')), 'should say the measurement did not land');
  });
  check('missing Hemnet total renders the ladder without the Hemnet column', () => {
    const out = qualityBlock({ quality, hemnetAdds: null, flowWindowDays: 7 }).join('\n');
    assert(/High — interior/.test(out), 'ladder should still render');
    assert(/Hemnet total unavailable/i.test(out), 'should explain the missing column');
  });
  check('missing flow window degrades like a missing total', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: null }).join('\n');
    assert(/Hemnet total unavailable/i.test(out), 'null window must not render "flow window nulld"');
    assert(!/nulld/.test(out), 'must never print a null window length');
  });
  check('mismatched windows refuse the Hemnet column', () => {
    const out = qualityBlock({ quality, hemnetAdds: 1150, flowWindowDays: 14 }).join('\n');
    assert(/not comparable/i.test(out), 'should state the two measurements are not comparable');
    assert(!/96%/.test(out), 'must not render a Hemnet ratio across mismatched windows');
  });
  check('partial resolution is disclosed', () => {
    const out = qualityBlock({ quality: { ...quality, n_resolved: 500 }, hemnetAdds: 1150, flowWindowDays: 7 }).join('\n');
    assert(/500 of 537/.test(out), 'should disclose the resolution shortfall');
  });

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node premarket-flow-weekly-report.js --smoke`
Expected: FAIL — `qualityBlock is not defined`.

- [ ] **Step 3: Write the implementation**

Add the import at the top of the file, beside the existing requires:

```js
const { ladderRows } = require('./lib/premarket-quality');
```

Add `qualityBlock` beside the other render helpers (after `wowAdds`):

```js
// The quality ladder: Booli's weekly cohort by tier, with Hemnet's single total
// expressed against each cumulative rung. The first row carrying a number is the
// parity point — the sub-segment where the two platforms actually compete.
function qualityBlock({ quality, hemnetAdds, flowWindowDays }) {
  if (!quality) {
    return ['', 'Pre-market quality — measurement did not land this week (see cron_job_log).'];
  }

  // Only compare like with like. A window mismatch makes the numerators incomparable.
  const comparable = hemnetAdds != null && flowWindowDays === quality.window_days;
  const counts = {
    n_total: Number(quality.n_total),
    high: Number(quality.n_high), mid_high: Number(quality.n_mid_high),
    mid_sell: Number(quality.n_mid_sell), mid_fish: Number(quality.n_mid_fish),
    other: Number(quality.n_other), low: Number(quality.n_low),
  };
  const rows = ladderRows(counts, comparable ? hemnetAdds : null);

  const out = [
    '',
    `Pre-market quality — Booli cohort of ${fmtNumber(counts.n_total)}`,
    '',
    `${rpad('Booli tier (best first)', 38)}${lpad('this wk', 9)}${lpad('cum n', 8)}${lpad('cum %', 7)}${lpad('Hemnet', 9)}`,
  ];
  for (const r of rows) {
    out.push(
      rpad('  ' + r.label, 38) +
      lpad(fmtNumber(r.n), 9) +
      lpad(fmtNumber(r.cumN), 8) +
      lpad(r.cumPct + '%', 7) +
      lpad(r.hemnetPct == null ? '—' : r.hemnetPct + '%', 9)
    );
  }

  if (!comparable) {
    out.push('');
    out.push(hemnetAdds == null || flowWindowDays == null
      ? 'Hemnet total unavailable this week — ladder shown without the comparison column.'
      : `Not comparable: quality window ${quality.window_days}d vs flow window ${flowWindowDays}d.`);
  }

  out.push('');
  out.push(`Signals: interior ${Math.round(quality.pct_interior)}% · asking price ${Math.round(quality.pct_price)}%` +
    ` · viewing ${Math.round(quality.pct_viewing)}%`);
  out.push(`         Booli AVM shown where a price would be: ${Math.round(quality.pct_avm_shown)}%`);

  if (Number(quality.n_resolved) < Number(quality.n_ambiguous)) {
    out.push(`         Based on ${fmtNumber(quality.n_resolved)} of ${fmtNumber(quality.n_ambiguous)} ambiguous listings opened.`);
  }
  return out;
}
```

Wire it into `run()`. This needs three edits.

**(a)** The existing flow query does not select `window_days`, so the comparability check would be
asserting against a hardcoded literal — i.e. not asserting anything. Add the column. In the
`SELECT` inside `run()`, change:

```js
      SELECT platform, to_char(snapshot_date, 'YYYY-MM-DD') AS day,
             stock_secondhand_est, adds_window_secondhand, mean_dwell_days, flow_per_day
```

to:

```js
      SELECT platform, to_char(snapshot_date, 'YYYY-MM-DD') AS day,
             stock_secondhand_est, adds_window_secondhand, mean_dwell_days, flow_per_day,
             window_days
```

**(b)** Carry it into the shaped object. In the loop that builds `P`, add `windowDays` beside the
existing keys:

```js
      P[r.platform][slot] = {
        stock: r.stock_secondhand_est == null ? null : Number(r.stock_secondhand_est),
        adds:  r.adds_window_secondhand == null ? null : Number(r.adds_window_secondhand),
        dwell: r.mean_dwell_days == null ? null : Number(r.mean_dwell_days),
        windowDays: r.window_days == null ? null : Number(r.window_days),
      };
```

**(c)** After the existing `bodyLines` array is built, and before `const message = ...`, add:

```js
  // Quality ladder — read the week's row and join Hemnet's adds from the flow table.
  let qRow = null;
  const qClient = createClient();
  try {
    await qClient.connect();
    const q = await qClient.query(
      `SELECT * FROM premarket_quality_weekly WHERE snapshot_date = $1::date`, [today]);
    qRow = q.rows[0] || null;
  } catch (err) {
    console.error(`Quality block unavailable: ${err.message}`);
  } finally {
    try { await qClient.end(); } catch (_) { /* best effort */ }
  }
  bodyLines.push(...qualityBlock({
    quality: qRow,
    hemnetAdds: hc && hc.adds != null ? hc.adds : null,
    // Hemnet's OWN measurement window — the thing that must match the quality
    // window for the two numerators to be comparable. Never hardcode this.
    flowWindowDays: hc && hc.windowDays != null ? hc.windowDays : null,
  }));
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `node premarket-flow-weekly-report.js --smoke`
Expected: `ALL PASS`, exit 0, and no Slack post (the smoke path never reaches `run()`).

- [ ] **Step 5: Commit**

```bash
git add premarket-flow-weekly-report.js
git commit -m "feat(premarket-flow-report): append the Booli quality ladder with Hemnet parity column"
```

---

### Task 8: Live validation, cron wiring and retirement

**⚠️ This task spends money and mutates production. Steps 2 and 5 require Julian's explicit go-ahead.**

**Files:**
- Delete: `scripts/premarket-quality-week.js`, `scripts/premarket-quality-resolve.js`, `scripts/premarket-quality-recompute.js`, `scripts/premarket-quality-categorise.js`
- Modify: `deploy-instructions.md`, `docs/handover/02-DATA-STREAMS-AND-JOBS.md`, `docs/handover/04-REPORTING-AND-SLACK.md`

- [ ] **Step 1: Run the migration against the database**

Run: `node migrate-premarket-quality.js`
Expected: `Created table: premarket_quality_weekly` then a 19-column listing.

If the connection is refused, the local IP needs whitelisting — see `project_ip_whitelist` in memory, or run it from the droplet after deploying.

- [ ] **Step 2: Gated live validation run — DECLINED 2026-08-13**

**Julian declined this step**: the Oxylabs transport was exercised only days earlier, so a
one-off proof run was judged unnecessary. The first live execution is therefore the Monday
09:00 UTC cron itself.

**Consequence to accept knowingly:** the first real run is unattended. Its guards are the ones
that must catch a bad first week — `assertCohortNonEmpty` hard-fails rather than persisting an
empty cohort, `validate()` escalates unresolved >10% / unknown labels / duplicates / ceiling
hit / walk truncation to Slack via cron-wrapper, and the row is idempotent so a re-run after a
fix simply overwrites. The volume-anomaly check is silent for the first four weeks by design,
so week one has no volume guard.

Skipped command, retained for a future manual run: `node scripts/premarket-quality-measure.js`

Expected: a `cron_job_log` row with status `success`, and one row in `premarket_quality_weekly`. Verify with:

```bash
node -e "
const {createClient}=require('./db');(async()=>{const c=createClient();await c.connect();
const r=await c.query('SELECT * FROM premarket_quality_weekly ORDER BY snapshot_date DESC LIMIT 1');
console.log(JSON.stringify(r.rows[0],null,2));await c.end();})();
"
```

Sanity-check against August: `n_total` should land near 2,300, `n_ambiguous` near 24% of it, and `n_unknown_labels` should be 0. A non-zero `n_unknown_labels` means Booli changed its image taxonomy — investigate before trusting the row. `oxylabs_calls` must be a positive integer; if it is null or the insert failed on it, the call-counter wiring regressed (see the `oxCallsTotal` note in Task 6).

- [ ] **Step 3: Verify the report renders the real row**

Run: `node premarket-flow-weekly-report.js`

Read the printed message before it posts. Confirm the ladder renders, the Hemnet column suppresses above 100%, and the parity row looks plausible.

Note: this DOES post to Slack if `SLACK_WEBHOOK_URL` is set — dotenv re-injects it, so `env -u` will not stop the post. To render without posting, run it from a directory whose `.env` lacks the webhook.

- [ ] **Step 4: Delete the superseded scripts and update docs**

```bash
git rm scripts/premarket-quality-week.js scripts/premarket-quality-resolve.js \
       scripts/premarket-quality-recompute.js scripts/premarket-quality-categorise.js
```

In `docs/handover/02-DATA-STREAMS-AND-JOBS.md`, add a row to the jobs table:

```markdown
| `scripts/premarket-quality-measure.js` | Weekly Booli pre-market quality ladder | Booli · Oxylabs · Apollo | Mon 09:00 | `premarket_quality_weekly` |
```

In `docs/handover/04-REPORTING-AND-SLACK.md` §2.5, note that the pre-market pulse now carries a second block, and add `node premarket-flow-weekly-report.js --smoke` to the §6 safe-self-test list.

In `deploy-instructions.md`, add beside the existing pre-market flow lines:

```
0 9 * * 1   cd /opt/hemnet-cohort-tracker && node scripts/premarket-quality-measure.js >> /var/log/hemnet/premarket-quality.log 2>&1
```

- [ ] **Step 5: Install the cron line on the droplet**

**STOP. This mutates production. Confirm with Julian first.**

Back up, append the line, and reinstall — non-interactive, since `crontab -e` opens an editor
this environment cannot drive:

```bash
ssh cohort-droplet "crontab -l > /tmp/crontab.bak.\$(date +%s) && crontab -l > /tmp/ct.new && \
  echo '0 9 * * 1   cd /opt/hemnet-cohort-tracker && node scripts/premarket-quality-measure.js >> /var/log/hemnet/premarket-quality.log 2>&1' >> /tmp/ct.new && \
  crontab /tmp/ct.new && crontab -l | grep premarket-quality"
```

Expected: the grep echoes exactly one matching line. Confirm the backup exists
(`ssh cohort-droplet "ls -t /tmp/crontab.bak.*"`) before moving on.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(premarket-quality): retire the manual pipeline, wire the weekly cron, update docs"
```

---

## Notes for the implementer

- **`getOxylabsStats()`** returns `{ oxylabsCallCount, oxylabsFailureCount, directSuccessCount, oxylabsFallbackRate }` — cumulative for the process, and with **no `requests` field**. Total calls = `oxylabsCallCount + directSuccessCount`. Snapshot at the start of `main` and subtract; do not assume it starts at zero.
- **`createClient()` is synchronous.** It returns a `pg.Client`; you must `await client.connect()`. Calling `.query()` without connecting hangs silently rather than throwing.
- **`cron-wrapper.runJob` passes `main(client, log)` an already-connected client.** Do not create your own inside `main`.
- **The `other` rule changed shape from August.** `scripts/premarket-quality-categorise.js` used a catch-all `match: () => true` for `other` with `low` above it; Task 1 makes `other` explicit (`!INT && (P || V)`) and `low` the catch-all. The two are equivalent because the earlier rungs already consumed every interior-bearing case — the oracle in Task 2 proves it on 2,264 real listings. If the oracle fails on this, revert to the August ordering rather than editing expectations.
- **Cost accounting:** ~67 walk calls + ~537 resolve calls. If `oxylabs_calls` lands materially above ~650, something is re-fetching; investigate before the next run.
