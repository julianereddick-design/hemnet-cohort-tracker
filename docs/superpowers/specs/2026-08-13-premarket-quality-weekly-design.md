# Weekly pre-market quality measurement — design

**Date:** 2026-08-13
**Status:** approved (design); spec pending review
**Supersedes:** the manual four-script pipeline documented in `docs/handover/booli-premarket-quality.md`
**Companion to:** `docs/superpowers/specs/2026-07-06-premarket-flow-measurement-design.md`

---

## 1. The question this answers

The Monday flow job (`scripts/premarket-flow-measure.js`) reports that Booli publishes
roughly twice Hemnet's new pre-market listings each week — ~2,264 against ~1,150 in the week
to 2026-08-11. That is a bare headcount, and it treats a fully photographed home with a
booked viewing as equivalent to a listing with a facade shot and no price.

The August one-off measurement showed the two are not equivalent: only **19.7%** of Booli's
weekly cohort is genuinely coming to market, **6.4%** is outright filler, and **67%** sits in
a middle state with real interior photography but no viewing booked.

This design makes that measurement weekly and, more importantly, turns it into a comparison:
**at which rung of Booli's quality ladder does Hemnet's total pre-market flow reach parity?**
That crossover names the sub-segment where the two platforms actually compete, and everything
below it is Booli's padding.

## 2. The rubric

Unchanged from the August work (Julian's definition). A quality pre-market listing has:

1. **An asking price that isn't Booli's own AVM** — `listPrice` as distinct from `estimate`
2. **At least one real interior photo** — binary; filler shows building, area, floor plan
3. **A viewing date** — a booked first open home means the sale is real

The five-category ladder, plus `other`, exactly as implemented in
`scripts/premarket-quality-categorise.js`:

| Key | Label | Rule |
|---|---|---|
| `high` | High — for sale coming soon | interior + price + viewing |
| `mid_high` | Mid-high — for sale, price TBD | interior + viewing, no price |
| `mid_sell` | Mid — looking to sell | interior + price, no viewing |
| `mid_fish` | Mid — fishing | interior only |
| `other` | Other — no interior but priced/booked | no interior, but price or viewing |
| `low` | Low — marketing filler | none of the three |

**Not in scope:** a weighted composite score, and an interior-share threshold. Both were
considered and rejected in August — interior share is only measurable for the ~24% of
listings whose full gallery is opened, giving a useless 8–21% band. The interior measure is
binary and stays binary.

## 3. Output

Appended as a second block to the existing Monday pre-market pulse — one post, since the
quality table needs the flow numbers anyway and both answer the same question.

```
Pre-market quality — week to 2026-08-17  (2nd-hand, national)

Booli new pre-market   2,264          Hemnet new pre-market   1,150

                                       Booli     Booli cum      Hemnet
Booli tier (best first)                this wk   n       %    as % of cum
  High — interior + price + viewing        340    340    15%        —
  Mid-high — interior + viewing            106    446    20%        —
  Mid — interior + price                   758  1,204    53%       96%
  Mid — interior only ("fishing")          767  1,971    87%       58%
  Other — no interior, priced/booked       145  2,116    94%       54%
  Low — marketing filler                   145  2,264   100%       51%

Signals: interior 87% · asking price 54% · viewing 21%
         Booli AVM shown where a price would be: 40%
```

Rendering rules, agreed:

- **Percentages to 0 decimal places.**
- **The Hemnet column is blank where the ratio exceeds 100%.** The first row carrying a
  number is the parity point, so suppression makes the eye land on it unaided.
- Hemnet's figure is a single total (`adds_window_secondhand`), not a per-tier breakdown —
  the rubric does not transfer to Hemnet (interior labels there are `FLOOR_PLAN`-only and
  viewing dates live on the broker's own site).

## 4. Components

| Piece | Role |
|---|---|
| `lib/premarket-quality.js` | **New.** The rubric: card → three signals, the 4-branch ambiguity rule, the 6-rung ladder. Pure functions, no I/O. One definition of the rubric, testable offline. |
| `scripts/premarket-quality-measure.js` | **New.** The Monday job: walk → classify → resolve ambiguous → categorise → persist. Wrapped by `cron-wrapper.runJob`. |
| `migrate-premarket-quality.js` | **New.** Idempotent DDL, mirroring `migrate-premarket-flow.js`. |
| `premarket-flow-weekly-report.js` | **Extended.** Renders the quality block beneath the flow block. |
| `lib/booli-image-labels.js` | **Unchanged.** The 34-label taxonomy; `classifyLabel` returns `'unknown'` for anything new. |
| `lib/premarket-flow.js` | **Unchanged.** `walkFlow` already returns full cards and reads only `published`/`isNewBuild`, so richer cards ride through free. |

🚨 **Do not modify `parseBooliSearchCards`** (`lib/booli-fetch.js:203-249`). The Monday 08:50
production flow job calls it; a regression there silently corrupts the weekly flow series.

**Retired:** `scripts/premarket-quality-week.js`, `-resolve.js`, `-recompute.js`,
`-categorise.js`. Their logic moves into `lib/premarket-quality.js`. Keeping them would leave
two implementations of the same rubric to drift apart. Git history and
`docs/handover/booli-premarket-quality.md` preserve the provenance of the August result.

🚨 **The August artifact is NOT in git.** `verf-premarket-quality/` is entirely untracked, and
`week-2026-08-11-resolved-fixed-categorised.json` is ~2 MB of raw scrape output. Since the
regression oracle (§9) depends on it, the implementation must first derive a **trimmed,
committed fixture** — the seven fields the rubric actually reads, for all 2,264 listings
(~250 KB) — before the old scripts are deleted. Deleting them while the only copy of their
output sits untracked on one laptop would destroy the oracle.

## 5. Method — the four-branch rule

All three signals are on the search card, so most listings need no detail fetch. But the card
caps images at 5, so it can only ever **undercount** interiors:

| Card shows | Verdict | Open the page? |
|---|---|---|
| ≥1 interior label | genuine — more photos can't unfind it | no |
| 0 images | empty / broker withheld | no |
| 1–4 images, none interior | that IS the whole gallery (confirmed 6/6) | no |
| **exactly 5, none interior** | cap hit — could be 5 photos or 71 | **yes** |

The ambiguous bucket ran 23.6% of the August cohort; opening all 537 found 61.1% did have
interiors. Galleries behind a 5-image card ran 8→99 photos, so hitting the cap says nothing
about depth.

**Requirement: every ambiguous listing is opened, every week.** All listings whose card shows
exactly 5 images with no interior label get a detail fetch — no cap on how many, no sampling.
The only limit is the 700-call spend guard (§8), and hitting it is an alarm condition, not a
normal operating mode.

Sampling ~150 of the bucket was considered and **rejected** (Julian, 2026-08-13): it would cut
the job to ~$0.55 and 6 minutes, but it puts a confidence interval on the headline every week
to save about $50 a year, and it makes the tier counts estimates rather than counts.

## 6. Data model

One row per week. The ladder is a fixed, agreed six-rung taxonomy, so columns beat rows and
week-over-week becomes a trivial self-join.

```sql
CREATE TABLE IF NOT EXISTS premarket_quality_weekly (
  snapshot_date      DATE    NOT NULL PRIMARY KEY,
  window_days        INTEGER NOT NULL,
  n_total            INTEGER NOT NULL,   -- second-hand listings in the window
  n_high             INTEGER NOT NULL,
  n_mid_high         INTEGER NOT NULL,
  n_mid_sell         INTEGER NOT NULL,
  n_mid_fish         INTEGER NOT NULL,
  n_other            INTEGER NOT NULL,
  n_low              INTEGER NOT NULL,
  pct_interior       NUMERIC NOT NULL,
  pct_price          NUMERIC NOT NULL,
  pct_avm_shown      NUMERIC NOT NULL,   -- the 39.7% finding
  pct_viewing        NUMERIC NOT NULL,
  n_ambiguous        INTEGER NOT NULL,   -- 5-image cap bucket
  n_resolved         INTEGER NOT NULL,   -- of those, successfully opened
  n_unknown_labels   INTEGER NOT NULL,   -- taxonomy drift canary
  pages_walked       INTEGER NOT NULL,
  oxylabs_calls      INTEGER NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

`n_resolved` against `n_ambiguous` lets the report state that a week's ladder rests on, say,
512 of 537 ambiguous listings opened — rather than presenting a degraded number as complete.

New columns use `ADD COLUMN IF NOT EXISTS`, the established pattern in this repo.

## 7. Schedule and the join

```
Mon 08:50 UTC  premarket-flow-measure       → premarket_flow_weekly     (existing, unchanged)
Mon 09:00 UTC  premarket-quality-measure    → premarket_quality_weekly  (new, ~18 min, ~$1.51)
Mon 09:40 UTC  premarket-flow-weekly-report → Slack                     (existing, extended)
```

All times UTC, matching the rest of the crontab. The 09:00 slot leaves the flow job ten
minutes and finishes around 09:18, ~22 minutes clear of the report.

**Cohort definition:** second-hand only, national. New-builds are excluded via the card's
`isNewBuild` flag, the same filter the flow job applies — they ran 0.2% of the pre-market
pool in July and were refuted as an explanation for Booli's staleness.

Both measurement jobs anchor on the same 7-day window and stamp the same `snapshot_date`, so
the report joins on that date alone: Hemnet's `adds_window_secondhand` from
`premarket_flow_weekly` becomes the cumulative column; Booli's tier counts come from
`premarket_quality_weekly`.

**Comparability assertion:** before rendering, the report checks both rows carry the same
`snapshot_date` and `window_days`. If they differ the numerators are not comparable, and the
report says so instead of rendering a misleading table.

**Deliberate simplification:** the job is atomic — walk, resolve, then a single persist at the
end. No cross-stage resume cache. A mid-run crash costs $1.51 to re-run, cheaper than
maintaining staging state, and it avoids the chained-write-back shape that caused the
2026-W27 spot-check incident (a child process died before its JSON write-back and flooded 86
false reviews).

## 8. Failure handling

**Hard fail, nothing persisted:**
- walk returns zero listings (the "abort if 0 galleries" guard from the spot-check incident)
- walk exceeds its 130-call ceiling

**Tolerated, job continues and persists:**
- an individual detail fetch fails during resolve → that listing stays `unresolved`,
  `n_resolved` records the shortfall

**Warning to Slack via `cron-wrapper` (row still persisted):**
- unresolved exceeds 10% of the ambiguous bucket
- `n_unknown_labels > 0` — the taxonomy-drift canary. Booli serves two coexisting image-label
  vocabularies; missing the second scored fully photographed homes as having no interior and
  cost 24 wrong verdicts in August
- `n_total` more than ±40% off the trailing four-week mean. Skipped entirely until four prior
  weeks exist — the check is silent, not warning, on a short history

**Spend guard:** the resolve stage is capped at 700 calls, so a pagination bug cannot run up
spend. Hitting the cap is a warning, and the job persists what it resolved.

**Report degradation** — three distinct cases, none of which crash the post (the established
`?` convention):

| Missing | Behaviour |
|---|---|
| Quality row absent | Flow block posts exactly as today; quality block prints one line saying the measurement did not land |
| Hemnet flow row absent | Booli ladder renders in full with the Hemnet column blank and a note that Hemnet's total is unavailable for the week |
| `window_days` or `snapshot_date` disagree between the two rows | Ladder renders without the Hemnet column, stating the two measurements are not comparable |

## 9. Testing

**Offline `--smoke`** (no DB, no network — the repo convention): signal extraction from
fixture cards, the 4-branch bucket rule, the six-rung ladder, cumulative arithmetic,
suppression of >100% Hemnet cells, 0-dp rounding, and report rendering with a missing quality
row.

**Regression oracle.** Replay the trimmed August fixture — 2,264 real listings — through
`lib/premarket-quality.js` and assert it reproduces the audited published figures: 19.7%
genuinely coming to market, 6.4% filler, 87.1% interior, 54.3% price, 39.7% AVM shown, 21.1%
viewing. Also assert the per-listing category assignment matches the stored `category` for
every row, which is a far stricter check than the aggregates alone. If the rewrite cannot
reproduce the August result, the rewrite is wrong.

**Test tooling:** this repo has no test framework. The convention is an in-script `--smoke`
self-test run as `node <script> --smoke` (see `sold-match-report.js:513-528`). Follow it —
do not introduce jest, mocha, or a `tests/` tree.

**Live validation.** One gated wet run (~$1.51, requires explicit go-ahead) before the cron
line is installed, compared against the same week's manual pipeline output.

## 10. Known limitations, carried forward

- **One data point is not a rate.** The August figures come from a single week whose volume
  ran 8% below July's. The weekly series is what settles them.
- **Svensk Fastighetsförmedling showed 0 viewing dates across 125 listings** — near-certainly
  a feed integration gap, not broker behaviour. Do not rank brokers on viewing date.
- **Card image cap can only undercount interiors**, never overcount. The measured quality is
  therefore a floor.
- **The rubric does not transfer to Hemnet.** Only the price signal has a Hemnet equivalent;
  this design deliberately uses Hemnet as a single total rather than pretending otherwise.
- **Pre-market detail pages are `/annons/<id>`, not `/bostad/<id>`.** Always use the card's
  canonical `url`; constructing one 404s.

## 11. Cost

~604 Oxylabs calls per week (67 walk + ~537 resolve) ≈ **$1.51/week, ~$78/year**. About
2,600 calls a month against a 262k monthly cap currently running near 86% — roughly 1% of
remaining headroom. Approved by Julian on 2026-08-13.
