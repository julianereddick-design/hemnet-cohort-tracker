# Testing Patterns

**Analysis Date:** 2026-03-09

## Test Framework

**Runner:**
- None. No test framework is installed or configured.
- No `jest`, `vitest`, `mocha`, `tap`, or any other test runner in `package.json` dependencies.
- No test configuration files exist.

**Assertion Library:**
- None installed.

**Run Commands:**
```bash
# No test commands defined in package.json scripts
# There is no "test" script
```

## Test File Organization

**Location:**
- No test files exist in the project.
- The only `.test.js` files found are inside `node_modules/pg-protocol/` (dependency internals).

**Naming:**
- Not applicable.

## Test Structure

**No tests exist.** The codebase has zero automated tests.

## Current Validation Approach

In lieu of automated tests, the codebase uses runtime validation:

**1. Cron job result validation** (`cron-wrapper.js`):
```javascript
// Each cron-wrapped script provides a validate callback
runJob({
  scriptName: 'cohort-track',
  main,
  validate: (summary) => {
    if (summary.totalTracked === 0 && summary.cohortsTracked > 0) {
      return `0 pairs tracked across ${summary.cohortsTracked} active cohort(s) — expected hundreds`;
    }
    return null;  // null = no issues
  },
});
```

Scripts with validation:
- `cohort-track.js`: Warns if 0 pairs tracked with active cohorts
- `cohort-create.js`: Warns if 0 Booli listings found, or 0 matches from available listings
- `sfpl-region-snapshot.js`: Warns if row count is not exactly 18

**2. Idempotent duplicate protection** (database-level):
- `ON CONFLICT (pair_id, date) DO NOTHING` in `cohort-track.js` and `cohort-create.js`
- `ON CONFLICT ... DO UPDATE` in `sfpl-region-snapshot.js`
- Multiple cron runs per day are safe due to these constraints

**3. Existence checks before operations:**
```javascript
// Check if cohort already exists before creating
const existing = await client.query('SELECT 1 FROM cohorts WHERE cohort_id = $1', [cohortId]);
if (existing.rows.length > 0) {
  log('INFO', `Cohort ${cohortId} already exists. Skipping.`);
  return { ...summary, skipped: true };
}

// Check if daily view already recorded
const exists = await client.query(
  'SELECT 1 FROM cohort_daily_views WHERE pair_id = $1 AND date = $2',
  [pair.id, today]
);
if (exists.rows.length > 0) continue;
```

**4. Health monitoring** (`cron-health.js`):
- Queries `cron_job_log` table to check for missing runs, failures, and anomalous results
- Checks daily scripts ran within expected windows
- Checks weekly scripts ran within 8 days
- Reports issues to console (or Slack via `cron-health-slack.js`)

## Mocking

**Framework:** None.

**Patterns:** Not applicable -- no tests exist.

## Fixtures and Factories

**Test Data:** None.

**Location:** Not applicable.

## Coverage

**Requirements:** None enforced. No coverage tool configured.

## Test Types

**Unit Tests:**
- None exist.
- Pure utility functions that would be good candidates for unit tests:
  - `daysBetween()` in `cohort-track.js` and `cohort-backfill.js`
  - `getCohortWeek()` in `cohort-create.js`
  - `median()`, `mean()`, `percentile()` in `cohort-report.js` and `cohort-views-report.js`
  - `normalizeCounty()`, `countyToRegion()` in `sfpl-region-snapshot.js`
  - `formatDuration()`, `formatTimestamp()` in `cron-health.js`

**Integration Tests:**
- None exist.
- All scripts require a live PostgreSQL database connection to function.
- No test database, fixtures, or database mocking is set up.

**E2E Tests:**
- None exist.

## Recommendations for Adding Tests

**If introducing tests, follow these patterns to match the codebase style:**

**Framework choice:** `vitest` or `jest` (either works; project is CommonJS so use appropriate config).

**Test file location:** Co-locate with source as `{script-name}.test.js` (flat project structure makes this natural).

**Priority targets for first tests:**
1. Pure functions (no DB dependency): `daysBetween()`, `getCohortWeek()`, `median()`, `mean()`, `percentile()`, `normalizeCounty()`, `countyToRegion()`
2. Validation callbacks: Extract and test the `validate` functions from each `runJob()` call
3. `cron-wrapper.js` `runJob()` flow: Mock `createClient()` to test retry logic, logging, and status tracking

**Suggested structure:**
```javascript
const { describe, it, expect } = require('vitest'); // or jest

describe('daysBetween', () => {
  it('returns 0 for same date', () => {
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0);
  });

  it('returns positive days for future date', () => {
    expect(daysBetween('2026-03-01', '2026-03-05')).toBe(4);
  });

  it('returns negative days for past date', () => {
    expect(daysBetween('2026-03-05', '2026-03-01')).toBe(-4);
  });
});
```

**Key challenge:** Most business logic is tightly coupled to the database client. To test `main()` functions, you would need to either:
- Mock `client.query()` with expected SQL responses
- Use a test database with seeded data
- Extract business logic into pure functions that transform data (preferred approach)

---

*Testing analysis: 2026-03-09*
