#!/usr/bin/env bash
# scripts/deploy-09-2.6.sh — droplet-side deploy script for Plan 09-2.6.
#
# What this does (all idempotent — safe to re-run):
#   1. cd to /opt/hemnet-cohort-tracker
#   2. git fetch + pull --ff-only, show before/after HEAD
#   3. Run Hemnet match cohort smoke test (no DB writes — safe to re-run)
#
# No schema migrations this time — Plan 09-2.6 code changes do not touch schema.
#
# Run it on the droplet (after ssh):
#   bash /opt/hemnet-cohort-tracker/scripts/deploy-09-2.6.sh
#
# Exit code 0 = deploy clean, ready for W20 recovery (Task 5).
# Any non-zero exit = halt; investigate before running recovery.

set -euo pipefail

REPO_DIR="/opt/hemnet-cohort-tracker"
EXPECTED_BRANCH="master"

cd "$REPO_DIR"

# ---------------------------------------------------------------
# 1. Capture pre-pull state
# ---------------------------------------------------------------
echo "=== Plan 09-2.6 deploy ==="
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
# 3. Smoke test (no DB writes — safe to re-run)
# ---------------------------------------------------------------
echo "=== smoke: hemnet-targeted-match.js (Hemnet match cohort) ==="
node hemnet-targeted-match.js --smoke
echo

# ---------------------------------------------------------------
# 4. Done
# ---------------------------------------------------------------
echo "=== Deploy complete ==="
echo "HEAD: $(git rev-parse HEAD)"
echo
echo "Next step: Task 5 — W20 recovery (kill stuck job, re-run Hemnet match cohort, rebuild cohort)."
echo "Expected wall-clock post-D-32/D-33: ~50 min (vs prior 30+ hours)."
