#!/bin/bash
# Run this on the Droplet after git pull to add the chart generator cron job

# Add cron entry if not already present
CRON_LINE="30 9 * * 1  cd /opt/hemnet-cohort-tracker && node generate-pool-flow-charts.js"

if crontab -l 2>/dev/null | grep -qF "generate-pool-flow-charts"; then
  echo "Cron entry already exists, skipping"
else
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "Added cron: $CRON_LINE"
fi

# Run it once now to generate the initial dashboard
echo "Generating dashboard..."
cd /opt/hemnet-cohort-tracker && node generate-pool-flow-charts.js

echo "Done. Dashboard at http://170.64.197.241:3800/pool-flow-dashboard.html"
