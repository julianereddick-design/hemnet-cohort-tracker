# Phase 14: Spot-check verdict quality — Research

**Researched:** 2026-06-11
**Domain:** Spot-check adjudication pipeline — deterministic verdict logic, dHash image hashing, vision adjudicator, floorplan detection, multi-unit address detection
**Confidence:** HIGH (all findings verified from live codebase + probe data)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 (Probe before routing):** First plan = sizing probe on N=200+ pairs from a full recent cohort. Must measure: triage class × dHash minDist × current verdict distribution, and price implied vision calls in $ per routing option. Doubles as operator's verdict-trust dataset.
- **D-02 (Branch 2 rework):** adjudicatePair Branch 2 must require `priceAgrees && likely-match && dHash-confirmed (minDist ≤ threshold)` → CONFIRMED_MATCH. dHash result becomes an INPUT to adjudicatePair. `hasPhotos` retired as a confirmation signal.
- **D-03 (No silent confirm without photo correspondence):** `likely-match + priceAgrees + dHash finds NO shared photo` → must NOT silently confirm. Routes onward to vision and/or human. Exact routing split decided AFTER probe results with $ figures.
- **D-04 (dHash can challenge, not only upgrade):** High dHash distance on a price-confirmed pair must raise a visible flag, not be logged and discarded.
- **D-05 (Auto-confirm hardening ships WITH Branch 2 rework):** Exclude non-discriminating images (floorplans/`planlösning`, nyproduktion renders) from dHash compare set. Require ≥2 distinct shared photos before auto-confirm. Never auto-confirm at multi-unit addresses. Same image exclusion guards apply to vision `sharedPhoto`.
- **D-06 (Dependency posture):** Do not block on Phase 13.2. Pull minimal delisted-vs-transient classification into the probe if needed.

### Claude's Discretion

- dHash threshold value (currently 6) — recalibrate from probe data if warranted.
- HOW to detect floorplans/renders: image labels/categories where available, aspect-ratio/color heuristics, or small classifier.
- HOW to detect multi-unit addresses: e.g. >1 cohort pair at same street_address+postcode, or apartment housing-form.
- Probe artifact format and location (follow existing `verf-spotcheck-*/` conventions).
- Whether the ≥2-shared-photos rule needs a relaxation for pairs with tiny galleries.

### Deferred Ideas (OUT OF SCOPE)

- Soft-delete pair removal + individual per-pair UNCERTAIN Slack messages + shared-`ts` poller guard → Phase 13.1
- Fetch-outcome classification, review-queue filtering, stale-review aging alert → Phase 13.2 (except minimal classification the probe must pull forward per D-06)
- `cohort-create.js` matcher tie-break fix → still deferred (PRD §9)
- Phase 10 remainder (10-04 + 10-05) and Phase 11 SC-5 formal soak closure
</user_constraints>

---

## Summary

Phase 14 closes the two dominant false-confirm paths in the spot-check adjudicator. The codebase analysis revealed the exact current behavior: Branch 2 of `adjudicatePair` (`lib/spotcheck-adjudicate.js` lines 77-83) silently confirms ~265 of ~288 sampled pairs per run using `priceAgrees + hasPhotos + likely-match` — where `hasPhotos` means any gallery exists, not that the two galleries contain shared photos. The dHash cross-compare in `cohort-spotcheck-gate.js` (lines 206-224) already runs on every pair with both galleries and logs per-pair distances, but the UNCERTAIN→CONFIRMED_MATCH promotion loop (lines 270-279) only rescues UNCERTAIN verdicts; it never challenges a Branch 2 CONFIRMED_MATCH. A pair can be silently confirmed with a dHash distance of 63 (totally different photos) and the distance is logged to cron output and discarded.

The probe (D-01) must quantify the redistribution of the ~265 silent confirms by running the current pipeline AND the proposed rules side-by-side on N=200+ pairs from a recent cohort with full galleries. The probe is also the operator's first clear view of WHY each verdict happened, making it a trust deliverable as much as a sizing input. W23 has 1,434 pairs; at the gate's default 20% sample rate (~287 pairs), this covers the N=200+ requirement. The probe re-uses existing tooling (cohort-spotcheck.js + spotcheck-photos.js + spotcheck-dhash.js) and adds comparison logic showing current vs proposed verdict per pair.

The hardening changes (D-02, D-03, D-04, D-05) are fully planned: Booli's `Image.primaryLabel` field in the Apollo state exposes `floorplan` as a known label value (confirmed in live data). Hemnet gallery images have no per-image type label in the extracted URL path or Apollo state — only the raw hash paths appear in the HTML. Multi-unit address detection is cheapest and most reliable via a single SQL query against `cohort_pairs` for duplicate `(street_address, postcode)` within the same `cohort_id`.

**Primary recommendation:** Build the probe as Plan 14-01 using cohort-spotcheck.js --rate 0.20 + spotcheck-photos.js --all --gallery --max 6 + a new probe script that runs dHash on all pairs and reports the distribution. Then design the routing split (Plans 14-02+) using the probe's $ figures.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Verdict decision logic | `lib/spotcheck-adjudicate.js` | — | Pure function, no I/O — adjudicatePair takes injected inputs |
| dHash cross-compare | `lib/spotcheck-dhash.js` | — | Pure jimp computation, no DB/network |
| floorplan/render image exclusion | `lib/spotcheck-dhash.js` (filter before compare) | `lib/spotcheck-photos.js` (label extraction) | Labels come from Booli Apollo state at gallery-fetch time; heuristics in dhash module |
| Vision adjudicator | `lib/spotcheck-vision.js` | — | Lazy SDK load; guards for floorplan exclusion added here |
| Gate orchestration (dHash input + routing) | `cohort-spotcheck-gate.js` | — | Passes dHash result to adjudicatePair; contains multi-unit lookup |
| Multi-unit address detection | `cohort-spotcheck-gate.js` | `cohort-spotcheck.js` (probe only) | Gate has DB client for full cohort query; probe uses in-memory sample |
| Probe script | `scripts/probe-dhash-sizing.js` (new) | — | One-off; reads existing artifact or kicks full run |

---

## Standard Stack

### Core (all already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| jimp | ^1.6.1 [VERIFIED: package.json] | Pure-JS image hashing (dHash) | No native build deps; v1.x named-class API `{ Jimp }` + `resize({ w, h })` already in use |
| @anthropic-ai/sdk | ^0.104.1 [VERIFIED: package.json] | Claude vision API | Lazy-loaded inside getClient(); offline smoke/Mode-A fallback work without it |
| pg | ^8.0.0 [VERIFIED: package.json] | DB access for multi-unit lookup + probe | Already the project's DB client |
| dotenv | ^17.0.0 [VERIFIED: package.json] | Env var loading | Project standard |

### No New Dependencies Needed
All Phase 14 work uses libraries already in `package.json`. [VERIFIED: package.json scan]

---

## Current Code — Exact Behavior Map

### adjudicatePair Decision Tree (lib/spotcheck-adjudicate.js)
[VERIFIED: read full file]

```
adjudicatePair(record, { visionResult } = {})

Inputs:
  record.deltas.price_pct_diff   ← from computeDeltas(); null if Hemnet 404
  record.photos.hemnet_gallery   ← array; empty if fetch failed
  record.photos.booli_gallery    ← array; empty if fetch failed
  record.provisional             ← 'suspect' | 'low-signal' | 'likely-match'
  visionResult                   ← { sharedPhoto: true|false|null } OR undefined

priceAgrees = price_pct_diff != null && price_pct_diff <= 0.05   ← TIGHT (5%)
hasPhotos   = hemnet_gallery.length > 0 && booli_gallery.length > 0
sharedPhoto = visionResult?.sharedPhoto ?? null

Decision order (first match wins):
  Branch 1: priceAgrees && sharedPhoto === true             → CONFIRMED_MATCH / 'mode-b-vision'
  Branch 2: priceAgrees && hasPhotos && provisional==='likely-match' && sharedPhoto==null
                                                            → CONFIRMED_MATCH / 'deterministic'
  Branch 3: provisional==='suspect' && sharedPhoto===false && !priceAgrees
                                                            → CONFIRMED_MISMATCH / 'mode-b-vision'
  Branch 4: !hasPhotos                                      → UNCERTAIN / 'no-photos'
  Branch 5: else                                            → UNCERTAIN / 'no-vision'
```

**The problem:** Branch 2 fires when `sharedPhoto == null` (vision not run) — which is the case for ALL likely-match pairs since vision only runs on `suspect` pairs (gate line 246). So every likely-match pair with price ≤5% and any gallery present silently confirms, regardless of dHash distance.

**Note on price thresholds:** `priceAgrees` in adjudicate = ≤5% (tight). `classifyDeterministic` uses `PRICE_PCT_THRESHOLD = 0.12` (12%) to flag `price_gap`. The 5–12% band pairs are triaged `likely-match` (no price_gap flag) but have `priceAgrees=false` in adjudicate — they fall to Branch 5 (UNCERTAIN), not Branch 2. [VERIFIED: lib/spotcheck-evidence.js lines 31-32, lib/spotcheck-adjudicate.js lines 53-54]

### cohort-spotcheck-gate.js: dHash and Promotion Flow
[VERIFIED: read full file]

```
Step 6b (lines 206-224): dHash cross-compare
  - Runs for every pair that has BOTH booli_gallery and hemnet_gallery
  - Resolves gallery .file (relative to artifactDir) → absolute paths
  - Calls minDHashDistance(booliFiles, hemnetFiles)
  - Logs: "dHash pair <id>: minDist=<n> threshold=<t> AUTO-CONFIRM|escalate"
  - Stores p.dhash = { minDist, confirmed, threshold } in pair record
  - dhashResults[pair_id] = { minDist, confirmed, bFile, hFile }
  THRESHOLD: DHASH_THRESHOLD = parseInt(process.env.DHASH_THRESHOLD || '6', 10)

Step 7 (lines 227-268): adjudication
  - Vision runs ONLY for 'suspect' pairs (cost gate, line 246)
  - adjudicatePairs called with visionResults (likely-match pairs have no vision result → sharedPhoto=null)
  - Vision result stamped onto p.vision for advisory logging

Promotion loop (lines 270-279): dHash → promote UNCERTAIN only
  for (const v of verdicts) {
    const dr = dhashResults[v.pair_id];
    if (dr && dr.confirmed && v.verdict === 'UNCERTAIN') {   ← KEY: only UNCERTAIN
      v.verdict = 'CONFIRMED_MATCH'; v.verdict_source = 'dhash';
    }
  }
```

**The asymmetry:** dHash only promotes UNCERTAIN→CONFIRMED_MATCH. It never challenges a Branch 2 CONFIRMED_MATCH. A pair with `likely-match + priceAgrees` exits Branch 2 as CONFIRMED_MATCH before the promotion loop even sees it. The dHash distance is logged but has no effect on Branch 2 verdicts. [VERIFIED: cohort-spotcheck-gate.js lines 270-279]

### W23 Funnel (empirical baseline)
[VERIFIED: W23 artifact + probe scripts]

```
Cohort 2026-W23: 1,434 pairs total
At gate's --rate 0.20: ~287 sampled (current default since Phase 12)
W23 8% sample = 116 pairs:
  likely-match:  109 (94%)
  low-signal:      4  (3%)
  suspect:         3  (3%)

Price agrees (≤5%): 110 of 116 (95%)
Would silently confirm under current Branch 2:
  = likely-match AND priceAgrees = 109 pairs
  (All ~109 branch-2-confirm if hasPhotos is true, which it is for all live listings)
```

**Gallery coverage note:** The W23 artifact only fetched photos for 11 "flagged" pairs (spotcheck-photos.js default = non-likely-match only). For the probe, `--all` flag is required to get galleries for all sampled pairs.

---

## Image Metadata Availability

### Booli Image Labels
[VERIFIED: live Apollo state from verf-totals/booli.html + booli-all.html]

Booli's `Listing.images` array in the Apollo state contains `Image:N` refs. Each `Image` object has a `primaryLabel` field. **Confirmed label values from live data:**

```
exterior, balcony/view, interior, kitchen/dining_room, bathroom/laundry,
fireplace, pool, facade, wooden_deck, property_map, nearby_area, floorplan
```

**`floorplan` is a valid, explicitly labeled value.** [VERIFIED: Apollo state scan, 7 floorplan images out of 668 in booli-all.html sample = ~1%]

Booli's `booliGalleryUrls()` in `lib/spotcheck-photos.js` (lines 99-118) already extracts `primaryLabel` for each image and returns `{ url, label }` entries. The label is stored in the artifact as `photos.booli_gallery[i].label`. [VERIFIED: spotcheck-photos.js lines 112, W23 artifact data]

**Labels seen in W23 artifact (flagged pairs only):** `kitchen/dining_room`, `interior`, `bathroom/laundry`. No floorplan in this small flagged-only sample, but `floorplan` is confirmed present in the broader corpus.

**New-build / nyproduktion detection:** Booli Listing objects have `isNewConstruction: boolean` in the Apollo state. [VERIFIED: booli-all.html Apollo state scan, 35 of 70 listings had `isNewConstruction: true`]. This field is NOT currently stored in `booli_listing` (schema confirmed: no `is_new_construction` column). At gallery-fetch time (spotcheck-photos.js), the Booli Apollo state is already available in `bp.apollo` — `isNewConstruction` can be read and attached to the pair record.

### Hemnet Image Labels
[VERIFIED: hemnet HTML inspection + hemnet-fetch.js analysis]

Hemnet does NOT expose per-image type labels. The `hemnetGalleryUrls()` function (lib/spotcheck-photos.js lines 78-94) extracts gallery URLs from the raw HTML via a regex matching `itemgallery_<size>/<aa>/<bb>/<hash>.jpg` paths. These hash-path filenames carry no semantic label. The Apollo state on Hemnet detail pages does not contain `Image:*` nodes with label fields — only `ActivePropertyListing` nodes.

**Result:** Hemnet gallery entries are stored as `{ file, label: null }` in the artifact. [VERIFIED: W23 artifact — all `hemnet_gallery[i].label === null`]

**Floorplan detection for Hemnet images:** Must rely on image analysis heuristics since no label is available:
1. **Aspect ratio:** Floorplans are typically wider than tall (landscape orientation), often with unusual aspect ratios.
2. **Color histogram via jimp:** Floorplans are typically high-white images with low color saturation — greyscale histogram skewed toward white.
3. **Edge density:** Floorplans have distinctive thin-line patterns; interior photos are smoother.
4. **Pragmatic approach:** Since Booli labels are available, exclude Booli-side floorplans (reliable, labeled) and use a lightweight jimp heuristic for Hemnet-side floorplan detection.

### Floorplan Heuristic via jimp (Claude's Discretion)
[ASSUMED — based on standard image processing knowledge; not verified against real Hemnet floorplan images]

A simple two-test heuristic with jimp (already a dependency):
1. **Whiteness ratio:** After resize to 32x32 greyscale, count pixels with brightness > 220 — if > 60% are near-white, flag as possible floorplan.
2. **Color saturation:** Convert to HSL; if median saturation < 20, flag as likely non-photo (floorplan/diagram).

This heuristic can be validated on the probe data. The probe should log the heuristic score for each image alongside the Booli label to calibrate the threshold.

---

## dHash Robustness Facts

### Current Implementation
[VERIFIED: lib/spotcheck-dhash.js — full read]

```javascript
dhash algorithm:
  - Resize to 9x8 (jimp v1.x: resize({ w: 9, h: 8 }))
  - Greyscale
  - For each row y in 0..7, for each col x in 0..7:
      bit = (pixel[y][x] > pixel[y][x+1]) ? '1' : '0'
  - Result: 64-bit string

minDHashDistance(booliFiles, hemnetFiles):
  - Hash all readable files on both sides
  - Nested-loop all-pairs Hamming distance
  - Return { minDist, bFile, hFile } (minDist=64 sentinel if either side has 0 readable files)
  - Never throws; unreadable files skipped with console.warn
```

**Hash resolution:** 64 bits. Threshold 6 means ≤9.4% bit difference — near-identical images only. [VERIFIED: spotcheck-dhash.js + STATE.md decision 13-02]

**The --max 6 gallery cap:** cohort-spotcheck-gate.js runs `spotcheck-photos.js --max 6` (default at gate line 64). This means at most 6 images per side enter the dHash comparison. If the shared photo is the 7th or later in gallery order, it is missed entirely. [VERIFIED: cohort-spotcheck-gate.js line 64 `max: 6`; spotcheck-photos.js booliGalleryUrls uses `interiorFirst: true` sorting, so interior shots come first]

**Distinct-shared-photos requirement (D-05):** To require ≥2 distinct shared photos, the probe needs to identify ALL pairs in the matched set (all (bFile, hFile) pairs with distance ≤ threshold) and then verify the matched pairs are NOT near-duplicates of each other. This requires a secondary within-set dHash check: among matched pairs, are all matches the same scene (same bFile appearing multiple times, or all matches within distance ≤6 of each other)?

Implementation approach: `minDHashDistance` returns only the single closest pair. A new function `sharedPhotoPairs(booliFiles, hemnetFiles, threshold)` should return ALL cross-pairs within the threshold, then check diversity (are the matched booli images and matched hemnet images themselves dissimilar enough from each other?).

---

## Vision Adjudicator — Current State and Guards Needed

### Current Behavior
[VERIFIED: lib/spotcheck-vision.js — full read]

```
adjudicateWithVision(pair, { artifactDir, maxImagesPerSide=6 }):
  - Builds image blocks from photos.booli_gallery (first 6) + photos.hemnet_gallery (first 6)
  - Total up to 12 images per API call
  - Model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
  - Prompt: asks "do these two listings show the SAME physical property?"
  - Returns { sharedPhoto: true|false|null, confidence, reasoning }
  - Returns null on: no key, API error, parse error, empty gallery on either side
```

**Current triage gate in cohort-spotcheck-gate.js:** Vision only runs on `provisional === 'suspect'` pairs (gate line 246). `likely-match` and `low-signal` pairs never get vision. [VERIFIED: cohort-spotcheck-gate.js lines 245-248]

**What guards are needed for D-05:**
1. The floorplan image exclusion must apply BEFORE building image blocks in `adjudicateWithVision`.
2. A shared floorplan returning `sharedPhoto: true` from vision is a Type 3 false confirm. The prompt already says "Find a shared interior or exterior detail" and notes hero/cover photos are unreliable, but does not specifically warn about floorplans.
3. Guard options: (a) exclude floorplan-labeled images from the payload before calling the API; (b) add "if the only shared feature is a floorplan or building diagram, report null not true" to the prompt.

**Option (a) is more reliable** — it prevents the model from seeing floorplans at all. Option (b) relies on the model identifying the floorplan in the context of comparing rooms.

### Vision Cost
[VERIFIED: calculated from token formula + SDK pricing]

- Image size: 1200×900 (Booli default, Hemnet itemgallery_L)
- Tiles per image: ceil(1200/512) × ceil(900/512) = 3 × 2 = 6 tiles → 6×170 + 85 = 1,105 tokens
- 12 images: 13,260 image tokens + ~200 text tokens ≈ 13,460 input tokens per call
- Output: ~100 tokens (JSON response)
- **claude-sonnet-4-6 pricing: ~$3/MTok input, ~$15/MTok output** [ASSUMED — matches claude-sonnet-4-5 pricing tier; verify at Anthropic pricing page before probe report]
- **Per-call cost: ~$0.042** (13,460 × $3/M + 100 × $15/M)

Weekly vision cost projections (based on ~265 silent confirms per run, 20% sample of ~1,300 cohort):

| dHash fail rate | Vision calls/week | Cost/week |
|----------------|-------------------|-----------|
| 10% | 27 | ~$1.13 |
| 30% | 80 | ~$3.35 |
| 50% | 133 | ~$5.57 |
| 80% | 212 | ~$8.88 |
| 100% | 265 | ~$11.10 |

The probe's dHash distance distribution over N=200+ pairs will reveal the actual fail rate, collapsing these projections to a point estimate with Wilson CI.

**Important nuance:** The true vision call volume depends on routing design (vision on ALL dHash-fail + likely-match pairs? Only those with narrow price gap? Only with positive triage signals?). The probe must measure the distribution to enable this decision.

---

## Multi-Unit Address Detection

### What Exists
[VERIFIED: cohort-spotcheck.js SQL query lines 152-168; booli_listing schema from booli-targeted-refresh.js]

`cohort_pairs` columns available: `id, cohort_id, booli_id, hemnet_id, street_address, postcode, municipality, county, booli_listed, hemnet_listed`

**Option 1 (recommended for production): DB query at gate runtime**
```sql
SELECT street_address, postcode
FROM cohort_pairs
WHERE cohort_id = $1
GROUP BY street_address, postcode
HAVING COUNT(*) > 1
```
Returns the set of (street_address, postcode) pairs that have >1 listing in the cohort. The gate can build a `Set` of these keys and flag any sampled pair whose key is in the set. Cost: 1 extra query per run. The gate already has a DB client. [VERIFIED: cohort-spotcheck-gate.js has `client` parameter in main()]

**Option 2 (probe only): In-memory from sample**
The sample data already has `street_address` and `postcode` fields. Build `addressCount` map from the sample; any pair at an address with count > 1 in the sample is a candidate. This under-counts multi-unit risk (the OTHER unit sharing the address may not be in the sample) but is sufficient for the probe's sizing purpose.

**Option 3: Housing type from Booli/Hemnet fields**
`booli_listing.object_type` = `'Lägenhet'` (apartment) is a necessary but not sufficient condition for multi-unit risk. All apartments in Swedish multi-unit buildings share a street+postcode. But this flag would mark ALL apartments, which is too broad (~70% of cohort pairs). The address-count approach is more targeted. [VERIFIED: booli-listing schema + cohort-spotcheck.js evidence logic]

**Recommendation for D-05:** Use Option 1 (full cohort query). Multi-unit flag = `isMultiUnit: bool` stored on each pair record before adjudication. The gate passes this flag into adjudicatePair or uses it in the pre-adjudication routing step.

---

## Sizing Probe Design (D-01)

### What the Probe Must Measure

1. **Per-pair record:** `{ pair_id, provisional, triage_flags, priceAgrees, dHash: { minDist, confirmed, matchedPairs }, current_verdict, proposed_verdict, vision_cost_est: bool, isMultiUnit: bool, booliIsNewConstruction: bool, hasFloorplanBooli: bool }`
2. **Distribution table:** triage × current_verdict × proposed_verdict (count + pct)
3. **dHash distance histogram:** bins 0-3, 4-6, 7-10, 11-15, 16-30, 31-64 — for ALL pairs with both galleries
4. **Vision call projection:** N_vision_calls = count(pairs where proposed_verdict would route to vision) × $0.042/call
5. **Summary metrics:** how many of the ~265 silent confirms would remain CONFIRMED_MATCH, become vision-routed, become UNCERTAIN

### Sample Size
[VERIFIED: W23 data analysis]

W23 cohort: 1,434 pairs. At `--rate 0.20`: ~287 sampled. This exceeds N=200+ operator preference. [VERIFIED: cohort-spotcheck.js parseArgs, gate parseArgs — both support `--rate` flag]

### Can the Probe Reuse Existing Artifacts?

The W23 `verf-spotcheck-2026-W23-20260610-131907/` artifact has 116 pairs but only 11 have photos (flagged-only fetch). To get the full distribution, the probe needs:

1. Re-run `cohort-spotcheck.js --cohort 2026-W23 --rate 0.20 --conc 5` → new artifact with ~287 pairs and field evidence. (~47s for field evidence based on W23 baseline of 405ms/pair)
2. Run `spotcheck-photos.js <new-dir> --gallery --all --max 6 --conc 5` → gallery for all 287 pairs.
3. Run dHash on all pairs + apply proposed rules → distribution report.

**Cost estimate:** [VERIFIED: W23 oxylabs stats + math]
- W23 direct-curl worked (0 Oxylabs calls). Post-2026-05-21 Hemnet requires Oxylabs.
- Hemnet field evidence: ~287 Oxylabs calls × $0.005 = $1.44
- Gallery HTML (Hemnet + Booli detail pages): ~287 × 2 = 574 calls × $0.005 = $2.87
- Gallery images (bilder.hemnet.se, bcdn.se): direct, no Oxylabs, ~287×12 = 3,444 downloads
- **Total Oxylabs for full probe: ~861 calls ≈ $4.31**
- **Wall-clock estimate: ~3–5 minutes** (field evidence ~2 min at 287 pairs, gallery download concurrent)

**Alternative: use W23 artifact at 8% sample (116 pairs)**
Not recommended — below N=200 operator preference and misses the full distribution at the gate's actual 20% sample rate.

### Probe Script Location
Follow convention: `scripts/probe-dhash-sizing.js` as a one-off (not a cron script). Output dir: `verf-spotcheck-<cohortId>-<ts>/` following existing convention. The script should either (a) accept a pre-run artifact dir as argument (skip field-evidence and gallery steps), or (b) run the full pipeline itself. Option (a) is faster for iterating.

### Operator-Readable Artifact Format
[VERIFIED: 14-CONTEXT.md §specifics]

The probe output should be a `PROBE-DHASH-<cohortId>.md` that the operator can read and understand:
- One row per pair showing: address, provisional, priceAgrees, dHash minDist, current verdict, proposed verdict, multi-unit flag, booli labels
- Summary table: triage × verdict redistribution
- Vision cost table at multiple routing options
- Wilson 95% CI for the "would fail dHash" rate

---

## Common Pitfalls

### Pitfall 1: dHash Confirms via Floorplan
**What goes wrong:** Two apartments in the same new-build development share identical floorplan images. Booli's `Image.primaryLabel = 'floorplan'` for these images. minDHashDistance finds them near-identical (distance ≤ 6). The pair auto-confirms as CONFIRMED_MATCH even though it's two different apartments.
**Why it happens:** The current dHash compare set includes ALL images without filtering by label.
**How to avoid:** Filter Booli images by `label !== 'floorplan'` before passing to minDHashDistance. For Hemnet images (no label), apply the whiteness/saturation heuristic.
**Warning signs:** Two new-build apartments at the same address both confirm with minDist=0 and the matched files are both small (floorplan images are typically smaller than room photos).

### Pitfall 2: shared-photos Requirement on Tiny Galleries
**What goes wrong:** A pair with only 1 image per side (both galleries length=1) would fail the ≥2-distinct-shared-photos requirement regardless of what the images show. This is too strict for tiny galleries.
**Why it happens:** ≥2 distinct matches requires at least 2 images per side to match against.
**How to avoid:** Relax the ≥2-shared-photos rule when BOTH galleries have ≤2 images: in that case, 1 confirmed match suffices (but the ≥2-distinct-images guard still applies). This relaxation should be validated against probe data.
**Warning signs:** If probe shows many pairs with 1-image galleries that would fail the guard.

### Pitfall 3: Probe Measures Gallery-Fetched Pairs Only
**What goes wrong:** The probe computes dHash only for pairs where spotcheck-photos succeeded in downloading galleries. Pairs where Hemnet is 404 (inactive/delisted) or Booli fetch fails have empty galleries → minDist sentinel (64). These would all route to UNCERTAIN in the proposed system. But including them in the "fail dHash" count inflates the vision-routing projection.
**Why it happens:** The probe must measure separately: (a) pairs with NO galleries (UNCERTAIN regardless), (b) pairs with galleries but dHash fail (candidate for vision), (c) pairs with galleries and dHash confirm (CONFIRMED_MATCH).
**How to avoid:** The probe distribution table must show gallery coverage first: total sampled → has both galleries → dHash result within that subset.
**Warning signs:** Probe reports inflated vision call count because it includes gallery-miss pairs.

### Pitfall 4: dHash All-Pairs-Min Finds the Same Image Twice
**What goes wrong:** Booli listing has a hero image repeated as image 1 and image 2 (some listings duplicate the hero). The all-pairs-min cross-compare finds match (booli_01, hemnet_01) and match (booli_02, hemnet_01) — both near-identical distance. The "≥2 distinct shared photos" rule might count this as 2 matches but they're really 1 scene.
**Why it happens:** No deduplication step in the matched-pair set.
**How to avoid:** After finding all cross-pairs within threshold, check that the matched booli images are themselves dissimilar from each other (Hamming distance > threshold among matched booli files). Same for matched hemnet files.

### Pitfall 5: Hemnet Gallery Label Null — Wrong Heuristic Exclusion
**What goes wrong:** Hemnet labels are all null. A Hemnet bathroom photo (high-white, high-brightness due to tiles) gets flagged as a floorplan by the whiteness heuristic and excluded from the dHash set. This reduces the dHash compare set and can cause a true match to be missed.
**Why it happens:** Overly aggressive whiteness threshold for floorplan detection.
**How to avoid:** Calibrate the whiteness threshold on the probe data. Include both the heuristic result and the original image in the probe artifact so the operator can eyeball false positives. Start with a conservative threshold (e.g., >80% near-white pixels) rather than an aggressive one.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Image hashing | Custom hash | `lib/spotcheck-dhash.js minDHashDistance` | Already validated on W23 data; jimp dependency committed |
| Vision adjudication | Custom vision prompt pipeline | `lib/spotcheck-vision.js adjudicateWithVision` | Lazy SDK load, null-fallback, offline smoke — all in place |
| Field triage | New classification logic | `lib/spotcheck-evidence.js classifyDeterministic` | Already handles boarea convention, null guards, type families |
| Wilson CI | Custom statistics | `lib/spotcheck-summary.js computeSummary` | Already exports `wilson95`, by-county breakdown |
| Slack posting | New webhook client | `lib/spotcheck-slack-bot.js` | `postReviewMessage`/`postDigestMessage` already handle null-safety |
| DB review store | Custom upsert | `lib/spotcheck-review-store.js upsertReviewMessage` | Handles ON CONFLICT, parameterized queries, dedup |

---

## Code Examples

### Current dHash flow in gate (lines 206-224)
[VERIFIED: cohort-spotcheck-gate.js]

```javascript
// CURRENT (Phase 13 shipped code):
const DHASH_THRESHOLD = parseInt(process.env.DHASH_THRESHOLD || '6', 10);
const dhashResults = {};
for (const p of (artifact.pairs || [])) {
  const photos = p.photos || {};
  const booliFiles  = (photos.booli_gallery  || []).map(g => path.join(artifactDir, g.file));
  const hemnetFiles = (photos.hemnet_gallery || []).map(g => path.join(artifactDir, g.file));
  if (booliFiles.length === 0 || hemnetFiles.length === 0) { continue; }
  const { minDist, bFile, hFile } = await minDHashDistance(booliFiles, hemnetFiles);
  const confirmed = minDist <= DHASH_THRESHOLD;
  dhashResults[p.pair_id] = { minDist, confirmed, bFile, hFile };
  p.dhash = { minDist, confirmed, threshold: DHASH_THRESHOLD };
}
// ... (promotion loop at line 270 only promotes UNCERTAIN→MATCH)
```

### What Phase 14 Changes — Proposed adjudicatePair signature
[ASSUMED — planner's implementation decision]

```javascript
// PROPOSED Phase 14 changes to adjudicatePair:
// New 3rd parameter: dhashResult
adjudicatePair(record, { visionResult } = {}, dhashResult = null)
//   dhashResult: { minDist, confirmed, sharedCount, hasFloorplanOnly } | null
//
// Branch 2 rework (D-02):
//   OLD: priceAgrees && hasPhotos && provisional==='likely-match' && sharedPhoto==null
//   NEW: priceAgrees && provisional==='likely-match' && dhashResult?.confirmed
//        AND dhashResult?.sharedCount >= 2 (D-05: distinct shared photos)
//        AND !dhashResult?.hasFloorplanOnly (D-05: floorplan exclusion)
//        AND !isMultiUnit (D-05: multi-unit guard)
```

### Booli Label Filtering (floorplan exclusion)
[VERIFIED: lib/spotcheck-photos.js booliGalleryUrls returns label field]

```javascript
// Filter non-discriminating images before dHash compare (D-05):
const NON_DISCRIMINATING = new Set(['floorplan', 'property_map', 'nearby_area']);

function filterDiscriminating(galleryFiles) {
  // galleryFiles: [{ file: 'photos/pairNNN/booli_01_floorplan.jpg', label: 'floorplan' }]
  // Returns only files whose label is not in the non-discriminating set
  // For null labels (Hemnet), applies heuristic
  return galleryFiles.filter(g => {
    if (g.label && NON_DISCRIMINATING.has(g.label)) return false;
    // Hemnet: null label — apply whiteness heuristic (calibrate from probe data)
    return true;  // default: include
  });
}
```

### Multi-Unit Detection SQL
[VERIFIED: cohort_pairs schema from cohort-spotcheck.js SQL]

```javascript
// In cohort-spotcheck-gate.js main(), after cohortId is resolved:
const multiUnitRes = await client.query(
  `SELECT LOWER(TRIM(street_address)) as addr, postcode
   FROM cohort_pairs
   WHERE cohort_id = $1
   GROUP BY LOWER(TRIM(street_address)), postcode
   HAVING COUNT(*) > 1`,
  [cohortId]
);
const multiUnitAddrs = new Set(
  multiUnitRes.rows.map(r => `${r.addr}|${r.postcode}`)
);
// Then per pair: p.isMultiUnit = multiUnitAddrs.has(...)
```

---

## Regression Safety

### Named Regression Fixtures
[VERIFIED: lib/spotcheck-adjudicate.js smoke tests lines 253-268; STATE.md decision 13-02]

| Pair | Address | Scenario | Expected verdict | What must keep passing |
|------|---------|----------|-----------------|----------------------|
| 15647 | Storvretsvägen 44 | True match; boarea vs total area convention; price exact; sharedPhoto=false (prior-sale photos) | UNCERTAIN (not CONFIRMED_MISMATCH) | Branch 3 price guard (`!priceAgrees`) |
| 16347 | Bollmoravägen 2, Tyresö | True mismatch; same building, different units; price diverges 16%; no shared photo | CONFIRMED_MISMATCH | Branch 3 fires on suspect+sharedPhoto=false+!priceAgrees |

Both fixtures are in `lib/spotcheck-adjudicate.js --smoke` (15 tests currently pass). [VERIFIED: smoke run = 15 pass, 0 fail]

**Phase 14 must not break these.** The Branch 2 rework changes the silent-confirm path but must not alter Branch 3 behavior. Pair 15647 gets `provisional='suspect'` (area gap + price agrees) and would still be a suspect pair — the new dHash-requiring Branch 2 doesn't apply to suspects (they must go through Branch 1 or 3), so the regression is preserved.

### Existing Smoke Tests to Preserve
[VERIFIED: running all smokes]

```
node lib/spotcheck-dhash.js --smoke          → 7 pass, 0 fail
node lib/spotcheck-adjudicate.js --smoke     → 15 pass, 0 fail
node lib/spotcheck-vision.js --smoke         → 4 pass, 0 fail
node lib/spotcheck-photos.js --smoke         → 10 pass, 0 fail
node lib/spotcheck-evidence.js --smoke       → 30+ pass (not run here but stable)
```

The `--smoke` pattern is the test framework for this project. All smoke tests run offline (no DB, no network). Phase 14 adds new `--smoke` cases to `lib/spotcheck-adjudicate.js` (for Branch 2 rework) and `lib/spotcheck-dhash.js` (for `sharedPhotoPairs` and floorplan-filter functions if added there).

---

## State of the Art

| Old Approach | Current Approach | Phase | Impact |
|--------------|------------------|-------|--------|
| Manual in-session adjudication | Automated gate with deterministic Branch 2 | Phase 12 | Branch 2 silent confirms introduced |
| No photo correspondence check | dHash cross-compare (Phase 13) | Phase 13 | dHash runs but only rescues UNCERTAIN |
| No mismatch price guard | D-03 price guard in Branch 3 | Phase 13 | Pair 15647 correctly stays UNCERTAIN |
| hasPhotos as confirmation signal | Must replace with dHash confirmed | Phase 14 (this) | Core Branch 2 fix |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | claude-sonnet-4-6 priced at ~$3/MTok input, ~$15/MTok output | Vision Cost | Vision cost projections in probe report would be wrong; verify at anthropic.com/pricing before finalizing probe report |
| A2 | The ≥2-distinct-shared-photos rule needs relaxation for 1-image galleries | Pitfall 2 / D-05 | Could be overly strict or overly lenient; calibrate from probe data |
| A3 | Jimp whiteness/saturation heuristic can detect Hemnet floorplans with acceptable false-positive rate | Image Metadata / Floorplan heuristic | Could over-exclude legitimate white-tile bathroom photos; validate on probe data before shipping |
| A4 | `isNewConstruction` from Booli Apollo state is reliably available at gallery-fetch time (spotcheck-photos.js already fetches the page) | Booli new-build detection | If some Booli pages don't expose this field in the detail-page Apollo state, detection would fail silently; acceptable |
| A5 | W23 cohort listings are still live on 2026-06-11 (1 day old) and galleries are fetchable | Probe sizing | If some listings have already been taken down (unusual for a 1-day-old cohort), gallery coverage would be < 100%; still sufficient for N=200+ |

---

## Open Questions

1. **Routing split design (held for probe)**
   - What we know: the probe will measure N_vision_calls for each routing option and price it.
   - What's unclear: which routing (all dHash-fail → vision; or vision only for narrower-price-gap dHash-fail pairs; or all to human) the operator will choose.
   - Recommendation: The probe artifact presents the $ figures; the operator chooses at the D-01 gate.

2. **dHash threshold recalibration**
   - What we know: current threshold is 6 (near-identical only). CONTEXT.md notes "likely → ≤10 from real data after a few weeks."
   - What's unclear: whether 6 is already too strict (missing true matches) or appropriate.
   - Recommendation: The probe's dHash distance histogram will show the distribution. If most true matches cluster at 0-3 and most non-matches at 15+, raising to 8-10 is safe. This is Claude's Discretion.

3. **Hemnet floorplan heuristic threshold**
   - What we know: Hemnet provides no image labels; jimp is available.
   - What's unclear: the whiteness/saturation thresholds that reliably distinguish floorplans from white-tile bathrooms in Hemnet's specific image corpus.
   - Recommendation: Ship the probe with floorplan heuristic disabled (treat all Hemnet images as non-floorplan). The probe will show how many false confirms would remain after Booli-only floorplan filtering. Revisit Hemnet heuristic in Phase 14 hardening if needed.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| jimp | dHash computation | Yes [VERIFIED] | ^1.6.1 (committed dependency) | — |
| @anthropic-ai/sdk | Vision adjudicator | Yes [VERIFIED] | ^0.104.1 | Mode A fallback (null return) |
| ANTHROPIC_API_KEY | Vision calls | Not in .env locally | — | Mode A; probe can price vision without calling API |
| OXYLABS creds | Field evidence + gallery HTML | Yes [VERIFIED: .env] | — | Direct curl fallback (may fail on Hemnet post-2026-05-21) |
| DB connection | Multi-unit query + cohort resolution | Not reachable locally (IP whitelist) | — | Run on droplet |
| Node.js | All scripts | Yes | — | — |

**Missing dependencies with no fallback:**
- DB connection: must run on droplet (not a blocker — all scripts already designed for droplet deployment)
- ANTHROPIC_API_KEY on droplet: needed for Mode B vision in live gate, but not for the sizing probe (probe can project costs without calling the API)

---

## Validation Architecture

`workflow.nyquist_validation` key is absent from `.planning/config.json` (only `workflow.research: false` is set) — treat as enabled. [VERIFIED: .planning/config.json]

However, this project's test framework is the `--smoke` inline self-test pattern, not a separate test runner. There is no `pytest.ini`, `jest.config.*`, or `vitest.config.*`. All tests run as `node <module> --smoke` and exit 0 on pass.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Inline `--smoke` self-tests (no separate test runner) |
| Config file | none |
| Quick run command | `node lib/spotcheck-adjudicate.js --smoke && node lib/spotcheck-dhash.js --smoke && node lib/spotcheck-vision.js --smoke && node lib/spotcheck-photos.js --smoke` |
| Full suite command | same (all --smoke modules) |

### Phase Requirements → Test Map

| Req | Behavior | Test Type | Command | Status |
|-----|----------|-----------|---------|--------|
| D-02 | Branch 2 requires dHash confirmed | unit (smoke) | `node lib/spotcheck-adjudicate.js --smoke` | Add new cases |
| D-03 | dHash challenge on price-confirmed pair | unit (smoke) | `node lib/spotcheck-adjudicate.js --smoke` | Add new cases |
| D-04 | dHash can challenge (not only upgrade) | integration | probe run + log inspection | Manual |
| D-05/floorplan | Floorplan images excluded from dHash | unit (smoke) | `node lib/spotcheck-dhash.js --smoke` | Add new cases |
| D-05/multi-unit | Multi-unit addresses never auto-confirm | unit (smoke) | `node lib/spotcheck-adjudicate.js --smoke` | Add new cases |
| D-05/distinct | ≥2 distinct shared photos required | unit (smoke) | `node lib/spotcheck-dhash.js --smoke` | Add new cases |
| Regressions | pair 15647 UNCERTAIN, pair 16347 CONFIRMED_MISMATCH | unit (smoke) | `node lib/spotcheck-adjudicate.js --smoke` | Currently passing |

### Wave 0 Gaps
- New `--smoke` cases for `lib/spotcheck-adjudicate.js`: Branch 2 with dHash input (confirmed, not confirmed, multi-unit, floorplan-only match)
- New `--smoke` cases for `lib/spotcheck-dhash.js`: `sharedPhotoPairs()` function (if added), floorplan-filter function

---

## Security Domain

The Phase 14 scope is limited to pure in-process logic (no new endpoints, no new auth surfaces, no new data storage). Existing security posture from Phases 12-13 applies:

| ASVS Category | Applies | Control |
|---------------|---------|---------|
| V5 Input Validation | Yes (image bytes) | jimp's try/catch in hashAll skips corrupt images; never passes user-controlled strings to shell |
| V6 Cryptography | No | dHash is not a security hash |
| SQL injection | Scoped (multi-unit query) | Use parameterized queries ($1 placeholders) per existing convention in all spotcheck modules |

---

## Sources

### Primary (HIGH confidence)
- `lib/spotcheck-adjudicate.js` — complete decision tree, exact branch conditions
- `lib/spotcheck-dhash.js` — dHash algorithm, minDHashDistance signature
- `lib/spotcheck-vision.js` — prompt text, model, token limits, fallback behavior
- `lib/spotcheck-photos.js` — booliGalleryUrls label extraction, hemnetGalleryUrls no-label behavior
- `cohort-spotcheck-gate.js` — exact line numbers for dHash step, promotion loop, vision gating
- `lib/spotcheck-evidence.js` — classifyDeterministic, PRICE/AREA thresholds
- `verf-spotcheck-2026-W23-20260610-131907/spotcheck-2026-W23.json` — empirical W23 distribution
- `verf-totals/booli.html` + `verf-totals/booli-all.html` — Booli Apollo state, confirmed `floorplan` label
- `package.json` — exact dependency versions
- `.planning/phases/14-spot-check-verdict-quality/14-CONTEXT.md` — locked decisions
- `.planning/todos/pending/branch2-use-dhash-not-hasphotos.md`
- `.planning/todos/pending/harden-dhash-autoconfirm-shared-stock-floorplan.md`

### Secondary (MEDIUM confidence)
- `COHORT-SPOTCHECK.md` — methodology spec, confirmation rule, §3 asymmetric logic
- `.planning/STATE.md` — Phase 13 decisions (13-02 threshold, 13-04 gate wiring)
- Phase 13 plan files (13-02-PLAN.md, 13-04-PLAN.md) — implementation history and rationale

---

## Metadata

**Confidence breakdown:**
- Current code behavior: HIGH — read every line of every relevant file
- W23 empirical distribution: HIGH — verified from live artifact
- Image label availability: HIGH — verified from live Booli Apollo state
- Vision cost estimates: MEDIUM — calculated from token formula; model pricing from training knowledge (A1 assumption)
- Floorplan heuristic design: LOW — theory only; needs calibration on probe data
- dHash threshold recalibration: MEDIUM — current threshold verified; optimal value depends on probe data

**Research date:** 2026-06-11
**Valid until:** 2026-07-11 (code is stable; Booli Apollo schema could change but unlikely within 30 days)
