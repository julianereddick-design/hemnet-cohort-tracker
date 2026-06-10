# Cohort Match Spot-Check — Overview, Findings & Weekly-Process Design

**Status:** tools built and validated against cohort 2026-W23 (2026-06-10). Run today as a
manual, in-session QA. This doc is the input for a GSD build that turns it into a weekly,
automated quality gate that runs after each cohort is created.

---

## 1. Why this exists

The tracker pairs a Booli for-sale listing with a Hemnet listing and treats the two as the
**same physical property** for the entire H/B view-ratio analysis. If a pair is wrong, the
ratio for that pair is meaningless and silently pollutes the dataset. This spot-check
samples a slice of each cohort and verifies the pairs are genuinely the same property,
catching the false matches the matcher produces.

---

## 2. How cohorts are built — and the structural flaw

Pipeline (functional job names):

1. **Booli fetch cohort** (`booli-targeted-discovery.js`) — walks Booli's for-sale search for
   the 4 counties (Stockholm, Västra Götaland, Skåne, Uppsala) and stores each recently-listed
   property in `booli_listing` (address, postcode, **price, living area, rooms, type**, listed
   date, views).
2. **Hemnet match cohort** (`hemnet-targeted-match.js`) — for each Booli listing, *searches*
   Hemnet with the candidate set **narrowed** by price ±5%, exact rooms, property type, and
   municipality, then **accepts** a candidate only if **street address matches AND listed date
   is within ±7 days**. Accepted Hemnet listings land in `hemnet_listingv2`.
3. **Cohort create** (`cohort-create.js`) — pairs the week's Booli listings to `hemnet_listingv2`
   rows on **postcode (exact) + street_address (exact, case-insensitive) + listed date within
   ±7 days**; tie-break = closest listed date. Writes `cohort_pairs (booli_id, hemnet_id, …)`.

**The flaw:** at every stage the metric that *decides* a pair is **address (street + postcode)
+ listed-date proximity**. Price / area / rooms / type only ever *narrow the Hemnet search*
during seeding — they are **never re-checked at pairing time**, and `cohort-create` matches
against the whole `hemnet_listingv2` pool by address+date. So when two different units share a
street + postcode + listing week (common in apartment buildings), the pairing key cannot tell
them apart and can grab the wrong unit. Example caught this run: **Bollmoravägen 2, Tyresö**
— two different flats, paired wrongly.

---

## 3. The spot-check method

Three layers, applied in order. Each later layer only runs where the previous can't settle it.

### Layer 1 — Sample
`cohort-spotcheck.js` takes a **5–10% sample stratified by county**, deterministic via a seeded
md5 ordering (same seed → same sample; seed defaults to the cohort_id). ~8% of ~1,400 pairs ≈
~110, min 2 per county.

### Layer 2 — Field test (the independent signals the matcher ignored)
Re-fetch each Hemnet listing **live** (`lib/hemnet-fetch.js fetchDetail`) for its current asking
price, living area, and housing form; Booli's price/area/type are already stored. Compute
deltas (`lib/spotcheck-evidence.js`):

- **Living area** — used *nowhere* in matching → the cleanest independent check.
- **Price** — only a soft ±5% *seed hint*, never enforced at pairing → divergence is a valid flag.
- **Type/family** — apartment-vs-house is a strong discriminator.

Triage each pair (ordering only, not the verdict):
- **area gap ALONE, price agrees** → `likely-match` (this is the boarea-vs-total measurement
  convention — Booli reports *boarea*, Hemnet sometimes includes supplementary area; **not** a
  different unit). Pair 15647 proved this.
- **area AND price both diverge** (or price missing, or apartment-vs-house, or postcode
  mismatch) → `suspect` (the genuine different-unit case). Pair 16347.
- can't verify (re-fetch failed + Booli fields null) → `low-signal`.

### Layer 3 — Photo confirmation (the decisive layer)
Pull both galleries (`spotcheck-photos.js --gallery`) and look for one shared room.

**Confirmation rule (final):**

| Verdict | Requires |
|---|---|
| **CONFIRMED MATCH** | price agrees **AND** ≥1 photo is clearly the same place (one shared room or exterior) |
| **CONFIRMED MISMATCH** | area and/or price diverge **AND** no shared photo across the galleries |
| **UNCERTAIN** | no photos available, or fields agree but no shared shot found, or photos ambiguous |

Two rules that matter:
- **Price alone never confirms a match.** Two similar units in one building can share an asking
  price — exactly the case we're worried about. A shared photo is the unique confirmer.
- **The logic is asymmetric.** One shared photo *confirms* a match; a *mismatch* cannot be
  concluded from photos alone (different photo sets / angles / staging) — it needs field
  divergence **plus** no shared photo.

---

## 4. The Booli URL insight (critical for the photo layer)

`booli_listing.url` is Booli's server-chosen canonical URL, and it is **deterministic, not
random**:

- **`/annons/<id>`** — the raw for-sale ad; `<id>` **is** our `booli_id`. Returned when the
  listing isn't linked to a residence record.
- **`/bostad/<residenceId>`** — the persistent *residence* page; the path number is the
  **residence id, not the booli_id**. Returned when Booli has matched the ad to a known
  residence (most established metro properties).

Latest cohort: **62% `/bostad/`, 38% `/annons/`.** A `/bostad/` residence page can show photos
from a **prior sale**, so comparing against it produces "different photos" on *true* matches.

**The fix (applied):** our `booli_id` is **always the ad id**, so
`https://www.booli.se/annons/<booli_id>` **always resolves to the current listing**.
`spotcheck-photos.js` now fetches Booli photos from `/annons/<booli_id>` (fallback to the stored
URL), so the photo layer always compares the live listing. NOTE: the stored *field data*
(price/area/listed) is **current**, not stale — only `/bostad/` *photos* can lag.

---

## 5. The tools

| File | Role |
|---|---|
| `lib/spotcheck-evidence.js` | Pure delta + triage logic. `--smoke` (30 tests). |
| `cohort-spotcheck.js` | Sample + field evidence. Read-only. Writes `verf-spotcheck-<cohort>-<ts>/spotcheck-<cohort>.json` + `.md`. |
| `lib/spotcheck-photos.js` | Hero + gallery URL extraction (Hemnet og:image / itemgallery; Booli `/annons` + bcdn cache URLs) + image download. `--smoke` (10 tests). |
| `spotcheck-photos.js` | Enriches the artifact with photos, writes `PHOTOS-<cohort>.md` + `photos/`. |

Canonical commands:
```bash
# 1. field evidence (read-only)
node cohort-spotcheck.js                 # latest cohort, 8% stratified sample
node cohort-spotcheck.js --dry-run       # print the sample, fetch nothing

# 2. photo confirmation on ALL sampled pairs (fresh cohort → all listings live)
node spotcheck-photos.js --gallery --all --max 6

# 3. adjudicate: open photos/ + PHOTOS-<cohort>.md and label each pair
#    CONFIRMED MATCH / CONFIRMED MISMATCH / UNCERTAIN per the rule above.
```

Reuses existing infra: `db.js`, `lib/scrape-http.js` (direct→Oxylabs), `lib/hemnet-fetch.js`,
`lib/booli-fetch.js`. Image CDNs (`bilder.hemnet.se`, `bcdn.se`) download directly — only the
HTML pages need the scrape layer / Oxylabs.

---

## 6. What we ran and learned (cohort 2026-W23)

- Sample: 116 of 1,434 pairs (8.1%). Field-test false-match rate **≈ 1.8% (2/112, 95% CI
  0.5–6.3%)**.
- **Confirmed false match — 16347 Bollmoravägen 2:** current Booli ad 64.5 m²/2,150,000 vs
  Hemnet 75.5 m²/2,495,000 at the same building → different units.
- **True match flagged in error — 15647 Storvretsvägen 44:** identical price + listed date;
  the 61.5 vs 72.3 m² gap was boarea-vs-total convention. Drove the triage refinement (area
  gap alone no longer escalates).
- **Photos:** hero-vs-hero is often inconclusive because the two sites pick different cover
  photos (one test pair had Hemnet's hero photoshopped with king penguins). Full-gallery +
  "one shared room" is the robust method.
- **Booli URL distribution + the `/annons/<booli_id>` fix** (section 4).

---

## 7. Weekly process design (the GSD build target)

**Trigger:** immediately after `cohort-create` succeeds each week (the new cohort's listings
are freshly live, so photo coverage is near-complete and UNCERTAIN should be rare).

**Steps:**
1. `cohort-spotcheck.js --cohort <new>` → sample + field evidence (JSON+MD artifact).
2. `spotcheck-photos.js --gallery --all` → pull current-ad galleries for **every** sampled pair.
3. **Adjudicate** each pair to CONFIRMED MATCH / CONFIRMED MISMATCH / UNCERTAIN per the rule.
4. Summarise: confirmed false-match rate + Wilson CI, by county, list of mismatches (pair_id,
   both URLs, why). Escalate (Slack) if the rate exceeds a threshold (e.g. > 5%).

**The one non-Node step — adjudication needs vision.** Deciding "is this the same room" is a
Claude-vision judgment. Two delivery modes:
- **Mode A (today):** a human opens the artifact in a Claude Code session and labels the pairs.
  Zero new deps; good for the first weeks while thresholds settle.
- **Mode B (automated target):** the weekly job calls the **Claude API with the downloaded
  images** (vision) to render the per-pair verdict and structured output, gated behind the
  field triage so the model only sees pairs that need it. Requires `@anthropic-ai/sdk` + key.
  This is what makes the weekly run fully hands-off. Gate API/vision calls behind the
  deterministic triage to control cost.

**Parameters to lock in the build:** sample rate (default 8%), county stratification, price-
agreement tolerance (≤5%), area boarea-tolerance (~7–12%), escalation threshold, retention of
artifacts.

**Success criteria for the gate:** every sampled pair gets a verdict; confirmed false-match
rate is computed with a CI; mismatches are listed with evidence; the run is logged
(`cron_job_log` via `cron-wrapper.js`) and alerts on a high rate or on fetch failure.

---

## 8. Confidence (the "99.9%" question)

- **Photo-confirmed pairs → ~99.9%:** price agreement + one shared distinctive room is
  essentially conclusive; two different units won't share an interior shot.
- **UNCERTAIN pairs:** accepted as a valid output; on fresh cohorts these should be few (no
  removed listings yet). They fall back to field evidence (~95%).
- **It's a sample:** 99.9% applies to the pairs checked. The 8% sample *estimates* the cohort's
  false-match rate with a confidence interval — it does not certify every unsampled pair. For
  100% certainty you'd run it on all pairs, not a sample.

---

## 9. Open follow-up (separate from this spot-check)

**Fix the matcher, not just measure it:** add an area/price tie-break to `cohort-create.js` —
among same-postcode+street candidates, prefer the closest living area, and drop/flag pairs with
a large area **and** price gap. This would have prevented 16347 at creation time. The spot-check
then verifies the fix holds.
