# Coding Conventions

**Analysis Date:** 2026-03-09

## Naming Patterns

**Files:**
- Use kebab-case for all script files: `cohort-track.js`, `cron-wrapper.js`, `sfpl-region-snapshot.js`
- Prefix with domain area: `cohort-*` for cohort scripts, `cron-*` for cron infrastructure, `sfpl-*` for SFPL ratio scripts
- Setup/schema scripts use `-setup` suffix: `cohort-setup.js`, `cron-setup.js`
- Report/analysis scripts use `-report` or `-analysis` suffix: `cohort-report.js`, `sfpl-region-analysis.js`

**Functions:**
- Use camelCase: `createClient()`, `daysBetween()`, `getCohortWeek()`, `normalizeCounty()`
- Entry-point async functions named `run()` or `main()`:
  - `main(client, log)` for cron-wrapped scripts (receives DB client and logger)
  - `run()` for standalone scripts (manages own DB connection)
- Helper/utility functions are plain camelCase: `median()`, `mean()`, `percentile()`, `fmtNum()`, `fmtPct()`

**Variables:**
- Use camelCase: `totalTracked`, `booliViews`, `hemnetDelta`, `matchRate`
- Constants use UPPER_SNAKE_CASE: `BOOLI_COUNTIES`, `HEMNET_COUNTIES`, `BUCKET_ORDER`, `MIN_PAIRS`, `CHUNK`
- SQL query string constants use UPPER_SNAKE_CASE: `CREATE_TABLE`, `BOOLI_QUERY`, `HEMNET_QUERY`, `UPSERT`
- Short variable names acceptable in tight loops: `c`, `r`, `d`, `p`, `b`
- Abbreviated prefixes for platform distinction: `booli*` / `hemnet*` / `h*` / `b*`

**Database tables/columns:**
- Tables use snake_case: `cohort_pairs`, `cohort_daily_views`, `cron_job_log`
- Columns use snake_case: `booli_views_day0`, `dropped_booli_on`, `snapshot_date`

## Code Style

**Formatting:**
- No formatter configured (no Prettier, ESLint, or Biome)
- Consistent 2-space indentation throughout all files
- Single quotes for strings
- Trailing commas in array/object literals
- No semicolons -- wait, semicolons ARE used consistently at end of statements

**Linting:**
- No linter configured
- No `.eslintrc`, `.prettierrc`, or `biome.json` present

**Language:**
- CommonJS modules (`require()` / `module.exports`), not ES modules
- Node.js built-ins used directly (`https`, `http`, `url`, `fs`) -- no third-party HTTP client
- Only two dependencies: `pg` and `dotenv`

## Import Organization

**Order:**
1. Node.js built-ins: `require('https')`, `require('fs')`
2. Third-party packages: `require('dotenv').config()`, `require('pg')`
3. Local modules: `require('./db')`, `require('./cron-wrapper')`

**Pattern:**
- Destructure on import: `const { Client } = require('pg')`, `const { createClient } = require('./db')`
- `dotenv` always loaded at the top of entry-point files: `require('dotenv').config()`
- `dotenv` loaded in `db.js` (shared module), so cron-wrapped scripts get it transitively

**Path Aliases:**
- None. All imports use relative paths (`./db`, `./cron-wrapper`)

## Error Handling

**Two patterns based on script type:**

**Pattern 1: Cron-wrapped scripts** (used by `cohort-track.js`, `cohort-create.js`, `sfpl-region-snapshot.js`):
- Call `runJob({ scriptName, main, validate })` from `cron-wrapper.js`
- `cron-wrapper.js` handles: DB connection with retry (3x exponential backoff), `try/catch` around `main()`, uncaught exception/rejection handlers, logging to `cron_job_log` table, Slack alerts on failure/warning
- The `validate` callback inspects the result summary and returns a warning string or `null`
- Process exits with code 1 on failure, 0 on success/warning

```javascript
// Pattern: cron-wrapped script
const { runJob } = require('./cron-wrapper');

async function main(client, log) {
  // ... business logic ...
  return { /* summary object */ };
}

runJob({
  scriptName: 'script-name',
  main,
  validate: (summary) => {
    if (/* anomaly */) return 'Warning message';
    return null;
  },
});
```

**Pattern 2: Standalone scripts** (used by `cohort-report.js`, `cohort-views-report.js`, `cron-health.js`, `export-cohort-csv.js`, `cohort-backfill.js`, `sfpl-region-analysis.js`, `cohort-summary.js`):
- Wrap in `async function run()` with `.catch()` at bottom
- Create own DB client, connect, do work, `await client.end()`
- Single top-level catch: `run().catch(err => { console.error('Error:', err.message); process.exit(1); })`

```javascript
// Pattern: standalone script
const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  // ... work ...
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

**Best-effort cleanup:**
- DB client `end()` calls wrapped in try/catch with empty catch: `catch (_) { /* best effort */ }`
- Used in `cron-wrapper.js` for cleanup after failures

## Logging

**Framework:** Custom logger in `cron-wrapper.js`, `console.log`/`console.error` elsewhere

**Cron-wrapped scripts:**
- Use the `log(level, message)` function injected by `cron-wrapper.js`
- Levels: `INFO`, `WARN`, `ERROR`
- Format: `[ISO-timestamp] [LEVEL] script-name: message`
- All runs logged to `cron_job_log` DB table with status, duration, result summary

**Standalone scripts:**
- Use `console.log()` directly for output
- Use `console.error()` for errors
- No structured logging

## Comments

**When to Comment:**
- Inline comments for SQL table schema (column purpose): `-- e.g. "2026-W10"`, `-- Monday`, `-- views - day0 views`
- Step-by-step comments in complex flows: `// Step 1: Clear existing daily views`, `// Step 2: Batch-fetch all historical snapshots`
- Brief rationale comments: `// Process-level safety`, `// Don't flag today if it's early in the day`
- No JSDoc or TSDoc usage anywhere

**Style:**
- Single-line `//` comments, never `/* */` blocks (except `/* best effort */`)
- Comments placed on the line above the code they describe

## Function Design

**Size:**
- `main()` functions are long (50-120 lines) -- they contain the full business logic for each script
- Helper functions are short (3-15 lines): `median()`, `mean()`, `daysBetween()`, `formatDuration()`

**Parameters:**
- Cron `main()` always receives `(client, log)` -- DB client and logger
- Standalone `run()` takes no parameters, creates own client
- CLI arguments read via `process.argv[2]` (positional) or `process.argv.indexOf('--flag')` (named)

**Return Values:**
- Cron `main()` returns a summary object with key metrics (used by `validate` and logged to DB)
- Standalone `run()` returns nothing (outputs to console)

## Module Design

**Exports:**
- Only two shared modules export anything:
  - `db.js`: exports `{ createClient }`
  - `cron-wrapper.js`: exports `{ runJob }`
- All other files are standalone scripts (no exports)

**Barrel Files:**
- None. No `index.js` aggregating exports.

## SQL Query Patterns

**Parameterized queries:**
- Always use `$1, $2, ...` placeholders with parameter arrays -- never string interpolation for values
- Example: `client.query('SELECT 1 FROM cohorts WHERE cohort_id = $1', [cohortId])`

**Idempotent writes:**
- Use `ON CONFLICT ... DO NOTHING` for duplicate protection on inserts
- Use `ON CONFLICT ... DO UPDATE SET` for upserts (`sfpl-region-snapshot.js`)
- Use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` in setup scripts

**Date handling:**
- Dates stored as `DATE` type in PostgreSQL
- Cast to text with `::text` when reading to avoid JS timezone mangling: `cp.booli_listed::text AS booli_listed`
- Today computed as `new Date().toISOString().slice(0, 10)`
- Day differences computed with `daysBetween()` helper using `86400000` ms constant

**Query style:**
- Multi-line SQL strings use template literals with consistent indentation
- SQL keywords in UPPERCASE: `SELECT`, `FROM`, `WHERE`, `INSERT INTO`, `ON CONFLICT`

## Console Output Patterns

**Report scripts use padded column formatting:**
```javascript
console.log(
  'Day'.padStart(4) +
  'Pairs'.padStart(7) +
  'H Med'.padStart(8) +
  'B Med'.padStart(8)
);
console.log('-'.repeat(67));
```

**Progress logging pattern:**
```javascript
log('INFO', `Tracking ${cohorts.rows.length} active cohort(s) for ${today}`);
// ... work ...
log('INFO', `Done. Tracked ${totalTracked} pairs total.`);
```

---

*Convention analysis: 2026-03-09*
