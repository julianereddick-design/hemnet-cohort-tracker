# Deploy Instructions for Hemnet Cohort Tracker

The droplet has a git clone at `/opt/hemnet-cohort-tracker/`. Cron jobs run from that directory.

## Deploy changes

1. Commit and push to `master` on GitHub
2. SSH into the droplet and pull:

```bash
cd /opt/hemnet-cohort-tracker && git pull
```

That's it — cron jobs will pick up the new code on their next run.

## Crontab

The current crontab schedule (set up once, rarely changes):

```
30 23 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-track.js
0 2 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-track.js
0 6 * * 1 cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-create.js
0 8 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js sfpl-region-snapshot.js
```

To update the crontab if needed:

```bash
crontab -e
```
