#!/usr/bin/env bash
# scripts/deploy-09-2.5.sh — droplet-side deploy script for Plan 09-2.5 Task 8.
#
# What this does (all idempotent — safe to re-run):
#   1. cd to /opt/hemnet-cohort-tracker
#   2. git fetch + pull, show before/after HEAD
#   3. Run both schema migrations (add-fields + drop-agent-fk) — idempotent
#   4. Run all 5 smoke tests required by the plan
#
# Run it on the droplet (after ssh):
#   bash /opt/hemnet-cohort-tracker/scripts/deploy-09-2.5.sh
# Or pipe it without committing:
#   ssh dropletuser@droplet 'bash -s' < scripts/deploy-09-2.5.sh
#
# Exit code 0 = deploy clean, ready for Sun 22:00 UTC Job C cron.
# Any non-zero exit = halt; investigate before next cron fires.

set -euo pipefail

REPO_DIR="/opt/hemnet-cohort-tracker"
EXPECTED_BRANCH="master"

cd "$REPO_DIR"

# ---------------------------------------------------------------
# 1. Capture pre-pull state
# ---------------------------------------------------------------
echo "=== Plan 09-2.5 deploy ==="
echo "Repo:    $(pwd)"
echo "Branch:  $(git rev-parse --abbrev-ref HEAD)"
echo "Pre-HEAD: $(git rev-parse HEAD)"
echo

if [ "$(git rev-parse --abbrev-ref HEAD)" != "$EXPECTED_BRANCH" ]; then
  echo "ERROR: not on $EXPECTED_BRANCH branch. Refusing to deploy."
  exit 1
fi

# ---------------------------------------------------------------
# 2. Pull
# ---------------------------------------------------------------
echo "=== git fetch + pull ==="
git fetch
git pull --ff-only
echo "Post-HEAD: $(git rev-parse HEAD)"
echo

# ---------------------------------------------------------------
# 3. Migrations (idempotent — both safe to re-run)
# ---------------------------------------------------------------
echo "=== migration: add-fields (idempotent — should report all columns present) ==="
node migrate-booli-listing-add-fields.js
echo

echo "=== migration: drop-agent-fk (idempotent — should report ABSENT) ==="
node migrate-booli-listing-drop-agent-fk.js
echo

# ---------------------------------------------------------------
# 4. Smoke tests (no DB writes — safe to re-run)
# ---------------------------------------------------------------
echo "=== smoke: lib/booli-fetch.js ==="
node lib/booli-fetch.js --smoke
echo

echo "=== smoke: lib/booli-to-hemnet-mapping.js ==="
node lib/booli-to-hemnet-mapping.js --smoke
echo

echo "=== smoke: booli-targeted-discovery.js (Job C) ==="
node booli-targeted-discovery.js --smoke
echo

echo "=== smoke: booli-targeted-refresh.js (Job D) ==="
node booli-targeted-refresh.js --smoke
echo

echo "=== smoke: hemnet-targeted-match.js (Job B) ==="
node hemnet-targeted-match.js --smoke
echo

# ---------------------------------------------------------------
# 5. Done
# ---------------------------------------------------------------
echo "=== Deploy complete ==="
echo "HEAD: $(git rev-parse HEAD)"
echo
echo "Next cron firings (UTC):"
echo "  Sun 22:00  — Job C (booli-targeted-discovery)"
echo "  Mon 03:00  — Job B (hemnet-targeted-match)"
echo "  Mon 06:00  — cohort-create"
echo
echo "Per Plan 09-2.5 Task 9: monitor Slack + cron_job_log; report success/partial/failed."
