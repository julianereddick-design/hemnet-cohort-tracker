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

DO snapshot of the droplet: `PENDING — see report` — hold to ~2026-11-18 (spec decision D7).
