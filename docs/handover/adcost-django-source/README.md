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

## 🔴 DO snapshot: NOT TAKEN

**No snapshot of the price-scraper droplet exists.** It was attempted on 2026-08-18 and the
DigitalOcean API refused it — `403 not authorized` — because the available API token is
**read-only**. Nothing was retried and no snapshot id was ever issued, so there is no
`PENDING` id to look up later.

- Droplet id: **`357087018`** (`170.64.181.89`, the price-scraper / Django box).
- Required before that droplet is destroyed: take the snapshot with a **write-scoped**
  DigitalOcean token, then record the id here in place of this section.
- Hold the snapshot to ~2026-11-18 (spec decision D7), then delete it.

Until that happens, the two files in this directory are the **only** copy of the crawler
source that ever existed outside that host — they were uncommitted, on a branch with no
remote. Destroying the droplet without the snapshot is irreversible for everything else on
it (the venv, the crontab, the Celery config, `.env`).
