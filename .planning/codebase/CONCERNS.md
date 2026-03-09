# Codebase Concerns

**Analysis Date:** 2026-03-09

## Tech Debt

**N+1 Query Pattern in `cohort-track.js`:**
- Issue: Each pair triggers 2 individual SELECT queries (one for Booli, one for Hemnet) plus an existence check and an INSERT, resulting in ~4 queries per pair. With ~1,000 pairs per cohort, this means ~4,000 queries per tracking run.
- Files: `cohort-track.js` (lines 47-102)
- Impact: Slow execution, high DB load. Currently tolerable at ~1,000 pairs but will degrade as cohort count grows or if multiple cohorts overlap.
- Fix approach: Batch-fetch all Booli and Hemnet views in two queries using `WHERE booli_id = ANY($1)` / `WHERE hemnet_id = ANY($1)`, then loop in-memory. Use batch INSERT with `VALUES` lists (like `cohort-backfill.js` already does at line 147-163).

**N+1 Query Pattern in `cohort-create.js`:**
- Issue: Each Booli listing triggers an individual Hemnet matching query. With ~1,000+ Booli listings, this is ~1,000 queries.
- Files: `cohort-create.js` (lines 116-138)
- Impact: Slow cohort creation. Less critical since it runs weekly, but still inefficient.
- Fix approach: Pre-fetch all Hemnet candidates for target counties/date range in one query, then match in-memory using a postcode+address index.

**Duplicated Utility Functions:**
- Issue: `median()`, `mean()`, `percentile()` are copy-pasted across three files. `daysBetween()` is duplicated in two files.
- Files: `cohort-report.js` (lines 3-20), `cohort-views-report.js` (lines 3-20), `cohort-backfill.js` (line 192-197), `cohort-track.js` (lines 3-7)
- Impact: Bug fixes or changes must be applied in multiple places. Risk of drift.
- Fix approach: Extract shared functions into a `utils.js` module.

**Inconsistent DB Client Pattern:**
- Issue: `sfpl-region-analysis.js` creates its own `Client` directly (line 4-11) instead of using `createClient()` from `db.js`. It also does not use the `cron-wrapper.js` pattern.
- Files: `sfpl-region-analysis.js` (lines 1-11)
- Impact: If DB connection config changes (e.g., SSL settings, timeouts), this file will break while others work. No retry logic or structured logging.
- Fix approach: Refactor to use `createClient()` from `db.js`.

**Hardcoded Cohort ID in `cohort-summary.js`:**
- Issue: The query hardcodes `'2026-W09'` as the cohort ID instead of accepting a CLI argument or defaulting to the latest cohort.
- Files: `cohort-summary.js` (line 17)
- Impact: Script becomes stale as new cohorts are created. Must edit source code to use with different cohorts.
- Fix approach: Accept `process.argv[2]` like other scripts, or query for latest cohort.

**`sfpl-region-snapshot.js` Deploys Inside Cohort Tracker Repo:**
- Issue: The SFPL snapshot script is part of a separate logical project but is deployed within the `hemnet-cohort-tracker` path on the Droplet.
- Files: `sfpl-region-snapshot.js`, `sfpl-region-analysis.js`
- Impact: Deployment coupling. Changes to one project's dependencies or deployment may break the other.
- Fix approach: Give the SFPL project its own deployment directory on the Droplet.

## Known Bugs

**`sfpl-region-snapshot.js` Hemnet Count Duplication:**
- Symptoms: Each row in `sfpl_region_daily` stores the full `hemnet_fs_count` for the region, but this same count is repeated for all 6 age buckets. The table design conflates Booli bucket-level data with region-level Hemnet data.
- Files: `sfpl-region-snapshot.js` (lines 93-95)
- Trigger: Every snapshot run. The data is not wrong per se, but the schema is misleading -- `hemnet_fs_count` is not per-bucket, it is per-region duplicated 6 times.
- Workaround: Consumers must know to pick any single bucket row for the Hemnet count, or divide by 6 when summing.

**Date Calculation Timezone Sensitivity:**
- Symptoms: `new Date().toISOString().slice(0, 10)` returns UTC date, not Stockholm time. If the script runs near midnight UTC, the "today" date may be wrong relative to the listing data (which uses Stockholm dates).
- Files: `cohort-track.js` (line 10), `cohort-create.js` (line 200), `sfpl-region-snapshot.js` (line 78)
- Trigger: Cron runs at 20:00 UTC (safe) and 23:00 UTC (safe for Stockholm = UTC+1/+2). Currently not triggered because runs are well before midnight UTC, but fragile if schedules change.
- Workaround: Current cron times avoid the problem. Do not schedule runs after 22:00 UTC.

## Security Considerations

**SSL Certificate Verification Disabled:**
- Risk: `ssl: { rejectUnauthorized: false }` in `db.js` disables SSL certificate verification, allowing potential MITM attacks on the database connection.
- Files: `db.js` (line 11)
- Current mitigation: DigitalOcean managed database uses trusted sources (IP allowlisting) which limits exposure.
- Recommendations: Set `rejectUnauthorized: true` and provide the DigitalOcean CA certificate via `ssl: { ca: fs.readFileSync('ca-certificate.crt') }`.

**`.gitignore` is Minimal:**
- Risk: Only `node_modules/` and `.env` are ignored. CSV exports (e.g., `cohort-2026-W09-views.csv`), any future `.pem` files, or other generated artifacts could be accidentally committed.
- Files: `.gitignore`
- Current mitigation: Repo is small and manually managed.
- Recommendations: Add `*.csv`, `*.log`, `*.pem`, `.env*` (except `.env.example`) to `.gitignore`.

**No Input Validation on CLI Arguments:**
- Risk: Scripts accept CLI arguments (`process.argv[2]`) without sanitization. While these flow into parameterized queries (safe from SQL injection), malformed input causes unhelpful crashes.
- Files: `cohort-create.js` (line 48), `cohort-backfill.js` (line 3), `cohort-views-report.js` (line 39), `export-cohort-csv.js` (line 8)
- Current mitigation: Scripts are run manually by a single operator.
- Recommendations: Add basic validation (e.g., check format matches `YYYY-WNN` for cohort IDs).

## Performance Bottlenecks

**Sequential Per-Pair DB Queries in `cohort-track.js`:**
- Problem: For ~1,000 pairs, the script issues ~4,000 sequential database queries with network round-trip to a remote DigitalOcean managed DB.
- Files: `cohort-track.js` (lines 43-105)
- Cause: Each pair is processed sequentially with individual SELECTs, an existence check, and an INSERT.
- Improvement path: Batch-fetch all listing views in 2 queries, batch-fetch existing daily_views in 1 query, batch-insert results in chunks of 500 (pattern already used in `cohort-backfill.js` lines 147-163).

**Sequential Per-Pair Matching in `cohort-create.js`:**
- Problem: Each Booli listing triggers an individual Hemnet query, resulting in ~1,000+ sequential queries during cohort creation.
- Files: `cohort-create.js` (lines 110-138)
- Cause: Matching is done one listing at a time.
- Improvement path: Fetch all Hemnet candidates for the date/county range in one query, build an in-memory lookup keyed on `postcode + lowercase(street_address)`.

**Sequential Per-Pair Updates in `cohort-backfill.js`:**
- Problem: Day 0 view updates are done one pair at a time (~1,000 individual UPDATE queries).
- Files: `cohort-backfill.js` (lines 137-142)
- Cause: Loop with individual UPDATE per pair.
- Improvement path: Use a single UPDATE with a VALUES CTE or `unnest()` arrays.

## Fragile Areas

**Cohort Matching Logic:**
- Files: `cohort-create.js` (lines 110-138)
- Why fragile: Matching depends on exact postcode equality and case-insensitive street address match between Booli `title` field and Hemnet `street_address`. Any data format change from either platform (e.g., different address formatting, postcode encoding) silently reduces match rate. The 7-day date window is also hardcoded.
- Safe modification: Always check match rate in the result summary after changes. If rate drops below ~70%, investigate.
- Test coverage: No automated tests. Match rate is validated in `cron-wrapper.js` but only warns at 0%.

**ISO Week Calculation:**
- Files: `cohort-create.js` (lines 17-43, `getCohortWeek()`)
- Why fragile: Custom ISO week calculation using manual date arithmetic. Edge cases around year boundaries (Week 52/53 of December, Week 1 of January) are particularly tricky. The function has no test coverage.
- Safe modification: Consider using a well-tested library like `date-fns` with `getISOWeek()` / `getISOWeekYear()`.
- Test coverage: None.

**`cohort-backfill.js` Destructive DELETE:**
- Files: `cohort-backfill.js` (lines 28-32)
- Why fragile: The backfill script does a `DELETE FROM cohort_daily_views WHERE cohort_id = $1` before re-inserting. If the script fails mid-execution (e.g., DB timeout, network error), the cohort loses all its daily view data with no recovery path.
- Safe modification: Wrap in a transaction (`BEGIN`/`COMMIT`), or use a temp table and swap approach.
- Test coverage: None.

**Cron Job Single Point of Failure:**
- Files: All cron scripts, deployed on a single DigitalOcean Droplet
- Why fragile: If the Droplet reboots or goes down, all data collection stops. Daily cohort tracking data is permanently lost for missed days (cannot be retroactively collected once the listing view counters change). This already happened on 2026-03-07.
- Safe modification: Backup cron runs at 23:00 UTC partially mitigate this. Scripts have duplicate protection via `ON CONFLICT DO NOTHING`.
- Test coverage: `cron-health.js` detects missed runs after the fact but cannot prevent data loss.

## Scaling Limits

**Cohort Pair Volume:**
- Current capacity: ~1,000 pairs per weekly cohort, with up to ~6 overlapping cohorts (44-day window).
- Limit: The N+1 query pattern in `cohort-track.js` means ~4,000 queries per cohort. With 6 overlapping cohorts, that is ~24,000 queries per run. The 120-second statement timeout (`cron-wrapper.js` line 87) may be hit.
- Scaling path: Batch queries (see Performance Bottlenecks above). Adding more counties beyond the current 4 would linearly increase pair counts.

**`sfpl_region_daily` Table Growth:**
- Current capacity: 18 rows per day (3 regions x 6 buckets).
- Limit: No concern for years. ~6,500 rows per year.
- Scaling path: Not needed.

## Dependencies at Risk

**No Pinned Dependency Versions:**
- Risk: `package.json` uses caret ranges (`^17.0.0` for dotenv, `^8.0.0` for pg). A breaking change in a minor/patch release could cause failures on the next `npm install`.
- Impact: Deployment to Droplet or new environment could pull different versions.
- Migration plan: Pin exact versions in `package.json` or rely on `package-lock.json` (which is present and should be committed).

## Missing Critical Features

**No Automated Testing:**
- Problem: Zero test files exist. No test framework installed. All validation is manual or via runtime checks in `cron-wrapper.js`.
- Blocks: Cannot safely refactor any code. Cannot verify ISO week calculation edge cases. Cannot validate matching logic changes.

**No Transaction Usage:**
- Problem: Multi-step operations (e.g., creating a cohort + inserting pairs + recording day 0 views in `cohort-create.js`) are not wrapped in database transactions. A failure mid-way leaves the database in a partial state.
- Blocks: Safe recovery from failures. For example, if `cohort-create.js` inserts the cohort row and some pairs but crashes before inserting day 0 views, the cohort exists in a broken state. Re-running skips it because `existing.rows.length > 0` (line 64).

**Slack Alerting Not Connected:**
- Problem: `SLACK_WEBHOOK_URL` is not configured on the Droplet. Alert code exists in `cron-wrapper.js` and `cron-health-slack.js` but is inactive.
- Blocks: Real-time failure notification. Failures are only discovered by manually running `node cron-health.js`.

**No Database Migration System:**
- Problem: Schema changes are applied manually (e.g., the `UNIQUE(pair_id, day)` to `UNIQUE(pair_id, date)` migration). `cohort-setup.js` uses `CREATE TABLE IF NOT EXISTS` which does not handle column additions or constraint changes.
- Blocks: Safe, reproducible schema evolution. Risk of production schema drifting from code expectations.

## Test Coverage Gaps

**All Code is Untested:**
- What's not tested: Every file in the project -- matching logic, ISO week calculation, day calculation, cron wrapper, report generation, SFPL snapshot logic.
- Files: All `.js` files
- Risk: Any refactoring could silently break critical cron jobs. The ISO week calculation in `cohort-create.js` (lines 17-43) is especially risky around year boundaries. The matching logic in `cohort-create.js` (lines 110-138) has no regression protection.
- Priority: High for `getCohortWeek()` and matching logic; Medium for report scripts; Low for setup scripts.

---

*Concerns audit: 2026-03-09*
