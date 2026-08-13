# Booli pre-market listing quality — state of play + the Hemnet comparison

**Status:** Booli side complete (2026-08-11). Hemnet comparison not started, and
has one blocking unknown — see §5.
**Cost so far:** 659 Oxylabs calls ≈ $1.65.
**Artifacts:** `verf-premarket-quality/`

---

## 1. The question

Booli publishes ~2,300–2,450 new pre-market ("Kommande" / `upcomingSale=1`)
listings a week against Hemnet's ~1,150 — a ~2x flow advantage measured by the
existing weekly job (`scripts/premarket-flow-measure.js`, Mon 08:50 cron).

That was a bare headcount. This work asks whether Booli's listings are genuine
transactable properties or marketing filler.

Note the scope: the **weekly NEW cohort**, not the ~32k standing pre-market pool.
The pool's staleness was measured separately in July (29% >12mo old, 14% >24mo,
mean dwell 95d vs Hemnet's 50d; new-builds refuted as an explanation at 0.2%).

## 2. The rubric (Julian's definition, his words)

A quality pre-market listing has:

1. **An asking price that isn't Booli's own AVM** — `listPrice`, as distinct from
   `estimate` (Booli's automated valuation)
2. **At least one actual interior photo** — filler listings show the building, the
   local area, and a floor plan
3. **A viewing date** — a booked first open home means the sale is real

Validated against two controls he supplied: `/bostad/3152240` (no price, 7 photos
all exterior/nearby_area/floorplan) scores low; `/bostad/4416057` (3.3M kr, 27
photos incl. interior/kitchen/bathroom, viewing 18 Aug) scores high.

**Rejected:** an invented weighted composite, and a "<20% of gallery is interior =
low quality" refinement. The latter would move Low from 6.4% to 8.0%, but interior
share is only measurable for the 24% of listings whose full gallery we opened,
giving a useless 8–21% band. Closing that needs ~1,629 calls ≈ $4.07 — judged not
worth it. **The agreed interior measure is binary.**

## 3. Result — week of 4–11 Aug 2026, n=2,264 second-hand, national

| Category | Rule | % |
|---|---|--:|
| High — for sale coming soon | interior + price + viewing | **15.0%** |
| Mid-high — for sale, price TBD | interior + viewing, no price | **4.7%** |
| Mid — looking to sell | interior + price, no viewing | **33.5%** |
| Mid — fishing | interior only | **33.9%** |
| Low — marketing filler | none of the three | **6.4%** |
| Other — no interior but priced/booked | | 6.4% |

**Genuinely coming to market (high + mid-high) = 19.7%.**

Signals: interior photos **87.1% yes / 12.9% no** · asking price 54.3% · **no
price but Booli's AVM displayed in its place 39.7%** · no price and nothing shown
6.0% · viewing date 21.1% · zero photos 1.2%.

**Reading it.** The strong "it's all padding" hypothesis does not survive a full
week — outright filler is 6.4%. But only ~1 in 5 is genuinely coming to market,
and **67% sit in a middle state: real interior photography, no viewing booked.**

Two findings worth carrying:

- **129 of the 292 no-interior listings have ten or more photos** — facade, floor
  plan, street, garden, never a room. Not "photos aren't ready"; a choice.
- **Nearly 40% of listings display a Booli-generated valuation where a seller's
  asking price would be.** To a browsing consumer the listing looks priced. This
  is the single most quotable finding — *but see §5, it is not yet known whether
  Booli does this on live for-sale listings too.*

Caveat: one week in August, volume 8% below July's 2,453. Not a settled rate
until a second week exists.

## 4. Method and pipeline

All three signals are on the **search card** — no detail fetch needed for most
listings. But the card caps images at 5, so it can only ever *undercount*
interiors. Hence a four-branch rule:

| Card shows | Verdict | Open the page? |
|---|---|---|
| ≥1 interior label | genuine — more photos can't unfind it | no |
| 0 images | empty / broker withheld | no |
| 1–4 images, none interior | that IS the whole gallery (confirmed 6/6) | no |
| **exactly 5, none interior** | cap hit — could be 5 photos or 71 | **yes** |

The ambiguous bucket was 23.6% of the cohort. Opening all 537 found **61.1% did
have interiors** (a 25-listing probe had predicted 60%). Galleries behind a
5-image card ran 8→99 photos, so hitting the cap says nothing about depth.

Scripts, in order:

| Script | What | Cost |
|---|---|---|
| `scripts/premarket-quality-week.js` | walks 7 days of `?upcomingSale=1`, classifies from cards | 67 calls / $0.17 / 3 min |
| `scripts/premarket-quality-resolve.js` | opens ONLY the ambiguous bucket; resumable via JSONL | 537 calls / $1.34 / 15 min |
| `scripts/premarket-quality-recompute.js` | re-derives verdicts from stored labels | free |
| `scripts/premarket-quality-categorise.js` | applies the 5-category ladder | free |
| `lib/booli-image-labels.js` | the image taxonomy — single source of truth | — |

Reuses `walkFlow` (`lib/premarket-flow.js:38`) unchanged — it already returns the
full card array and only reads `published`/`isNewBuild`, so richer cards ride
through free. **Do not modify `parseBooliSearchCards`** (`lib/booli-fetch.js:203-249`):
the Monday 08:50 production flow job calls it and a regression there silently
corrupts the weekly series.

Final data: `verf-premarket-quality/week-2026-08-11-resolved-fixed-categorised.json`
— one row per listing with every card field, labels, bucket and category.

## 5. Traps — each of these caused a real error

🚨 **Booli serves TWO coexisting image-label vocabularies.** A coarse one
(`interior`, `kitchen/dining_room`, `bathroom/laundry`) and a fine-grained
per-room one (`bedroom`, `kitchen`, `wc`, `livingroom`, `dining_room`, `hall`,
`laundry`, `closet`, `tiled_stove`). Building the interior set from a couple of
sample pages misses the second entirely and scores fully-photographed homes as
having NO interior. Cost: 24 wrong verdicts, ~1pp on the headline. The taxonomy
now lives in `lib/booli-image-labels.js` (34 labels enumerated from 537 real
galleries) and `classifyLabel` returns `'unknown'` for anything new so it
surfaces rather than silently defaulting to non-interior.

⚠️ **Single-page samples mislead on rare events.** Page 1 alone gave zero-photos
20% (true 1.2%), blockedImages 20% (true 1.0%), viewing 11% (true 21.1%).
Structural rates were fine from n=35 (ambiguous share 23% vs 23.6%, rescue rate
60% vs 61.1%); rare events were not. Always walk the week.

⚠️ **Pre-market detail pages are `/annons/<id>`, not `/bostad/<id>`.** Always use
the card's canonical `url`; constructing one 404s (`lib/booli-fetch.js:175`). A
`/bostad/` property page can also serve a different image set from the listing
gallery.

⚠️ **Svensk Fastighetsförmedling had 0 viewing dates across 125 listings** —
near-certainly a feed integration gap. Do not rank brokers on viewing date.

❌ **Retracted:** an "empty gap between 8% and 35% interior share" seen at n=20
did not survive n=537. Report the distribution; don't assert a cutoff.

**Dead ends proven:** Booli hosts no broker write-up at all (0/27 pages — it links
out to the agent), so description is not a usable signal. Pageviews do not
discriminate quality (the low-quality control drew 119 views in a day).

---

## 6. NEXT: the Hemnet comparison — feasibility PROBED 2026-08-11

`scripts/probe-hemnet-premarket-quality.js` (4 Oxylabs calls; `--cached` re-runs
the card analysis free). Dumps in `verf-premarket-quality/hemnet-probe/`.
Sample: 50 cards from `/kommande/bostader?sort=NEWEST` page 1 + 3 detail pages.
**Hemnet Kommande pool total = 7,827** (vs Booli's 31,919 — the ~4x gap holds).

**Headline: of the three signals, only PRICE transfers cleanly. The rubric cannot
be applied to Hemnet as-is.**

| Signal | Hemnet | Verdict |
|---|---|---|
| **Asking price** | on the card, **68% real** / 30% "Pris på förfrågan" / 2% empty | ✅ **comparable** |
| **Interior photo** | detail-page labels are **FLOOR_PLAN only** (127 unlabelled vs 5 FLOOR_PLAN across 3 galleries of 42/39/51) | ❌ **not measurable from labels** |
| **Viewing date** | `showings: []` on **0/50** cards; `upcomingOpenHouses: []` on 3/3 detail pages | ❌ **structurally absent** |

### What each verdict means

**Price — comparable, and the finding is sharp.** Hemnet 68% real asking price vs
Booli 54.3%. More interesting is what fills the gap: **Hemnet writes "Pris på
förfrågan" (price on request) — Booli displays its own AVM valuation.** Both fill
the slot; only one fabricates a number. That contrast is arguably the strongest
comparative result available and it is cheap to scale.
⚠️ Hemnet n=50, one page — get a full week before quoting (§3 shows how badly
single pages mislead).

**Interior photos — needs vision, or drop the signal.** Hemnet has an
`images[].labels` array and `hemnetGalleryFromApollo` (`lib/spotcheck-photos.js:203`)
already reads it, but the only value Hemnet populates is `FLOOR_PLAN`. There is no
room-type taxonomy. Options: (a) **vision classification** —
`lib/spotcheck-vision.js` + `downloadImage` (`:122`) exist, and
`bilder.hemnet.se` serves directly with no Cloudflare challenge, so images are
free to fetch; costs Anthropic calls, not Oxylabs; (b) drop the signal and state
plainly it is not comparable. Note Booli's advantage here is purely that it
publishes labels — it says nothing about actual photo quality.

**Viewing date — must be dropped from any cross-platform claim.** Zero of 50
Hemnet Kommande cards carry a showing, and all three detail pages returned an
empty `upcomingOpenHouses`.

🔑 **Julian (domain knowledge, 2026-08-11): the viewing date DOES exist — it lives
on the broker's own website, not on Hemnet.** So Hemnet's zero is a platform
*disclosure* decision, not an absence of viewings. Comparing Booli's 21.1% against
it would manufacture a gap that does not exist. The signal remains valid as an
**intra-Booli** discriminator (21% vs 79% under one policy); it is never a
cross-platform one. Generalise the lesson: before comparing any signal across
platforms, establish whether it reflects platform policy or seller behaviour.

### 🔑 The structural framing this points to

**Hemnet's Kommande is a standardised teaser product** — every listing the same
shape: photos, a full description, often no price, never a viewing date.
**Booli's is an aggregation with variable completeness.**

That is *why* Booli's listings spread across five quality categories and Hemnet's
would not, and it is a more useful characterisation of the two platforms than any
single rate. It also reframes the question: not "whose listings are better", but
what each platform **chooses to show**, and whether Booli's variability reflects
real differences in seller commitment or merely looser aggregation. The conversion
work in §8 is what separates those two explanations.

### The reverse asymmetry — worth knowing

**100% of Hemnet cards carry a full description** (all ≥200 chars, on the *card*,
no detail fetch needed). Booli hosts **no broker write-up at all**. The signal
declared dead on Booli in §5 is a strong Hemnet feature. Again: a platform
convention, not a quality verdict — but it means "does the consumer get a written
description of the property" has a stark answer, and it is free to measure.

### Practical notes for whoever runs this

- Hemnet search cards are **`ListingCard:<id>`** in Apollo — *not*
  `*PropertyListing`, which is the detail-page typename. `parseListingCards`
  (`lib/hemnet-fetch.js:127-146`) uses the right convention; my first probe pass
  did not and found zero cards.
- The card's `askingPrice` is a **display string**, not a number — `"2 995 000 kr"`
  or `"Pris på förfrågan"`. Testing `!= null` counts price-less listings as
  priced (it gave a false 98%). Test for a digit.
- Detail URL is `/bostad/<slug>`; `slug` is on the card and already ends in the id.
- Hemnet card images are also **capped at 5**, and carry only `filename` +
  `lqipBase64` — no labels at card level.
- The card additionally carries `fee`, `floor`, `rooms`, `squareMeterPrice`,
  `landArea`, `livingAndSupplementalAreas`, `brokerName`, `brokerAgencyName`,
  `activePackage` (PREMIUM/MAX), `coordinates`, `teaser`, `removedBeforeShowing`,
  and a `labels[]` of STATE/PRODUCT/FEATURE tags (`UPCOMING`, `PREMIUM`,
  `BALCONY`, `ELEVATOR`, `VIDEO`…). `teaser` was false on all 50 — but the search
  query itself passes `"teaser":"INCLUDE"`, so teaser listings are a first-class
  Hemnet concept and **may be worth investigating as Hemnet's own filler marker**.
- ⚠️ **Hemnet `/kommande` pagination is shallow** — caps around page 40–50, page
  80+ empty (`premarket-flow-measure.js:68-70`). At ~1,150 listings/week and 50
  cards/page that is ~23 pages, so it should fit — but verify. The muni-partition
  approach in `scripts/hemnet-age-census.js` (290 munis, 656 calls) is the proven
  fallback.
- ⚠️ **Hemnet refreshes `publishedAt` when a seller buys a new advertising
  package**, biasing its age distribution young. Documented for `/bostader`, never
  verified for `/kommande`. Matters because the cohort is defined by publish date.

### The agreed comparison basis (Julian, 2026-08-11)

Compare **all** of Hemnet's Kommande inventory against Booli's **High + Mid-high +
both Mid** categories — everything with interior photos. Booli's Low and Other sit
below Hemnet's minimum shape (photos + description), so they don't belong in a
like-for-like; excluding them is exactly excluding the no-interior population.

- Booli comparable = **1,972 of 2,264 = 87.1%**
- **Quality-adjusted flow ratio: 2.13x → 1.85x** (July-on-July), or 1.96x → 1.71x
  using this week's Booli count against July's Hemnet figure.
- **The haircut is 12.9% and does not overturn the story** — Booli still takes
  materially more new pre-market supply.

⚠️ **Treat 1.85x as a floor, not a point estimate.** It assumes every Hemnet
listing clears the interior-photo bar. We know 100% have photos; we do NOT know
they all have *interior* photos, because Hemnet publishes no room labels. On Booli
12.9% had photos but nothing inside. If Hemnet has a comparable sub-population the
haircut applies to both sides and the ratio moves back toward raw. The vision job
is what settles it.

⚠️ Cross-week: Booli 4–11 Aug vs Hemnet's July flow figure. A same-week Hemnet
card walk (~30 calls) removes this.

### Share framing — NOT a market share yet

| Reading | this week | July-on-July |
|---|--:|--:|
| Hemnet as % of **Booli's** comparable flow | **58.5%** | 54.0% |
| Hemnet as % of **combined** universe (zero overlap assumed) | 36.9% | 35.0% |

🚨 **Platform overlap has never been measured** — explicitly ruled out as too
brittle in the July flow work. "Booli does not ingest Hemnet's feed" means the
captures are independent, not that listings don't duplicate; a broker can post to
both. Overlap swings the share from 37% to 58%, so **do not state either as a
market share** until it is settled.

Defensible today: *"Hemnet's new pre-market flow is ~55–58% the size of Booli's,
once Booli is filtered to listings meeting Hemnet's minimum shape"*, or
equivalently *"Booli takes ~1.7–1.85x Hemnet's quality-comparable pre-market
flow."*

An overlap test is more tractable now than when it was dropped: we hold 2,264
Booli listings with street address, coordinates, price, size and rooms.

### Suggested scope

A Hemnet card walk for one week is ~23–30 calls (~$0.08) and yields price,
description, fee/rooms/area, broker, and the label tags — enough for a real
price-and-substance comparison. **Do that first.** Treat interior photos as a
separate, optional vision exercise, and leave viewing dates out of any
cross-platform claim.

## 7. Intended as a WEEKLY process

Julian is folding this into the weekly routine separately (decided 2026-08-11).
The run is cheap and already scripted: card walk **67 calls / $0.17 / 3 min**, plus
the ambiguous resolve **~537 calls / $1.34 / 15 min** only if that week needs the
precise interior rate — the card walk alone bounds it. Categorise and recompute are
free.

Notes for whoever wires it up:

- The existing pre-market flow job (`scripts/premarket-flow-measure.js`, Mon 08:50)
  **already walks these exact Booli pages every week and discards the cards.**
  Folding Tier-0 scoring into that job makes the weekly quality read nearly free.
  This is the obvious consolidation — but do **not** regress
  `parseBooliSearchCards`; add a parser alongside it (see §5).
- **Keep dumping per-listing rows every week.** Two payoffs already proven: the
  label-taxonomy fix cost zero re-scraping, and week-over-week ID diffs are exactly
  what the conversion question in §8 needs.
- **Watch for taxonomy drift.** `classifyLabel` returns `'unknown'` for unrecognised
  labels and `premarket-quality-recompute.js` prints them. Investigate, don't ignore
  — a silent vocabulary change would shift the interior rate without warning.

## 8. Other open items

1. **Booli for-sale benchmark** (~65 calls, $0.54) — never run. Needed to tell
   whether 39.7% AVM-substitution and 21% viewing-date are pre-market-specific or
   just how Booli renders any listing. **The headline finding in §3 cannot be
   stated strongly without this**, and it is cheaper than the Hemnet arm.
2. **Conversion** — the two mid buckets are 67% of the cohort. Whether that's a
   healthy pipeline or a holding pen needs "do fishing listings become live
   for-sale listings, and how fast". `week-2026-08-11.json` is the first snapshot
   that work needs; a second walk (~$0.17) plus an ID diff answers it. This is
   arguably the most valuable open question.
3. **A second week** before quoting any rate externally.

## 9. Standing rules

- **Never launch an Oxylabs run without Julian's explicit go-ahead for that
  specific run.** Offline re-scoring of existing artifacts is free and fine.
- Oxylabs cap ~262k non-JS requests/month, sitting near 86% utilisation. Non-JS
  only — do not route through `render` (smaller bucket, already exceeded).
- Dump **per-listing rows, not aggregates.** Fixing the label taxonomy above cost
  zero scraping precisely because labels were persisted per listing. Every prior
  census in this repo stored only histograms and would have needed a full
  re-scrape.
