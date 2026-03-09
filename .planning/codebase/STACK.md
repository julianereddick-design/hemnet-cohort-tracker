# Technology Stack

**Analysis Date:** 2026-03-09

## Languages

**Primary:**
- JavaScript (Node.js) - All application code, no TypeScript

**Secondary:**
- SQL (PostgreSQL dialect) - Inline queries throughout all scripts
- Bash - `update-db-access.sh` for DigitalOcean firewall management (at project root of parent directory)

## Runtime

**Environment:**
- Node.js (no `.nvmrc` or version pin detected; uses CommonJS `require()` throughout)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present (lockfileVersion 3)

## Frameworks

**Core:**
- None - Plain Node.js scripts, no web framework. All scripts are standalone CLI entry points.

**Testing:**
- None detected - No test framework, no test files, no test configuration.

**Build/Dev:**
- None - No build step, no transpilation, no bundler. Scripts run directly with `node`.

## Key Dependencies

**Critical:**
- `pg` 8.20.0 - PostgreSQL client. Only external runtime dependency. Used via `Client` class (not `Pool`).
- `dotenv` 17.3.1 - Environment variable loading from `.env` file.

**Infrastructure:**
- No other dependencies. The project has exactly 2 production dependencies.

## Configuration

**Environment:**
- `.env` file at project root (loaded by `dotenv` at script startup)
- `.env.example` documents required variables:
  - `DB_HOST` - DigitalOcean managed PostgreSQL host
  - `DB_PORT` - `25060` (DO managed DB default)
  - `DB_USER` - `doadmin`
  - `DB_PASSWORD` - Database password
  - `DB_NAME` - `defaultdb`
  - `DB_SSL` - `require`
- Optional: `SLACK_WEBHOOK_URL` - For failure/warning alerts (not yet configured on Droplet)

**Build:**
- No build configuration. All scripts execute directly.

**Database Connection:**
- Centralized in `db.js` - creates `pg.Client` with SSL (`rejectUnauthorized: false`)
- Connection timeout: 10,000ms
- Statement timeout: 120,000ms (set in `cron-wrapper.js`)

## npm Scripts

Defined in `package.json`:
```
npm run setup       → node cohort-setup.js      # Create DB tables
npm run create      → node cohort-create.js      # Create weekly cohort
npm run track       → node cohort-track.js       # Daily view tracking
npm run report      → node cohort-report.js      # Generate report
npm run setup-cron  → node cron-setup.js         # Create cron_job_log table
npm run health      → node cron-health.js        # Check cron job status
npm run views-report → node cohort-views-report.js # Cohort views analysis
```

## Platform Requirements

**Development:**
- Node.js with npm
- Network access to DigitalOcean managed PostgreSQL (IP must be whitelisted via `update-db-access.sh`)
- `.env` file with database credentials

**Production:**
- DigitalOcean Droplet (Ubuntu)
- Cron scheduler (system crontab)
- Node.js installed on Droplet
- Scripts deployed to `/opt/hemnet-cohort-tracker` on Droplet

---

*Stack analysis: 2026-03-09*
