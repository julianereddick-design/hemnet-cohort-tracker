# Ad-cost Django source — preserved 2026-08-18

Verbatim copies of the two files the ad-cost scrape actually ran from on the
price-scraper droplet `170.64.181.89`, taken before that droplet was destroyed.

**These were UNCOMMITTED when copied.** The droplet's checkout of
`github.com/tt7676/hem-bol-scrapers.git` sat on branch `feat/adcost-steel-resume`
@ `328dc3d` with no upstream, carrying +1,226 uncommitted lines in
`adcost_steel.py` and +115 in `tasks.py` — the whole Bright Data Web Unlocker fix.
That commit was on no remote branch. This directory was the first time any of it
existed anywhere but that one host.

The remote is a third party's repository, so the branch could not be pushed upstream.

- `adcost_steel.py` — the crawler. Its `unlocker` transport is what
  `scripts/adcost-crawl.py` is ported from.
- `tasks.py` — contains `search_ad_cost_2`, whose grid read and idempotent write
  became `scripts/lib/adcost_grid.py` and `scripts/lib/adcost_write.py`.

Reference only. Nothing in this repo imports or executes these files.

## ✅ DO snapshot: TAKEN 2026-08-18

| | |
|---|---|
| Snapshot id | **`241648610`** |
| Name | `hemnet-price-scraper-predecommission-20260818` |
| Droplet | `357087018` (`170.64.181.89`, the price-scraper / Django box) |
| Size / region | 22.73 GiB · `syd1` · min disk 50 GB |
| Taken | 2026-08-18 06:58:46 → 07:02:01 UTC (action `3353705284`) |
| Cost | ~$1.36/month at $0.06/GiB |

**Retention: hold to ~2026-11-18 (spec decision D7), then delete.** That covers three monthly
crawl cycles, so a seasonal or cadence-related failure surfaces while the fallback still exists.

This snapshot **is** the rollback. Decision D2 deleted the Steel and Browser-API transports from
the port, which retired the documented `ADCOST_TRANSPORT=steel` fallback — so restoring this image
is the only way back to the pre-migration system.

It was taken live (the droplet was running), which is supported; its one enabled scrape beat row
had already been disabled at cutover, so nothing was mid-write.

⚠ First attempt returned `403 not authorized` — the default DigitalOcean token is **read-only**.
A write-scoped token (`droplet: update`, or Full Access) is required for droplet actions, and will
be needed again to destroy the droplet. Note `doctl auth init` silently re-validates an existing
token instead of prompting; forcing a new named context (`doctl auth init --context <name>`) is
what makes it ask.

The two files in this directory remain the only copy of the crawler *source* that ever existed
outside that host — they were uncommitted, on a branch with no remote. The snapshot now covers
everything else on the box (the venv, the crontab, the Celery config, `.env`).
