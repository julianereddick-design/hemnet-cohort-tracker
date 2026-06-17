# Phase 17: Match Pipeline Orchestration - Research

**Researched:** 2026-06-17
**Domain:** Node.js orchestration — wiring existing lib modules into a config-driven runner
**Confidence:** HIGH (all findings from direct codebase reads, not assumed)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Segments live in `config/sold-segments.json` (data edit to add a segment, not code). Migrate current `SEGMENTS` const from `lib/sold-config.js` into this file, seeding with `stockholm-apt` + `taby-villa`. Same shape: `{label, family, booli:{areaIds,objectType}, hemnet:{locationId,itemType}}`. One loader used by both runner and any CLI wrappers.
- **D-02:** Default run = one month (most-recent ~30-day window ending at `READ_TIME_EXCLUDE_DAYS` = 90 days ago). `--min-sold-date` / `--max-sold-date` override. No multi-month loop in one invocation.
- **D-03:** Defer the recall pass. Emit `verdict = booli_only` for non-matched records without a second loose-recall search.
- **D-04:** On completion persist to `sold_match` AND print a per-segment run summary: records adjudicated, matched/booli_only/uncertain counts, match rate, Oxylabs calls spent. No per-run REPORT.md file.

### Claude's Discretion

- **D-05:** Call `adjudicatePair(record, {})` — no dHash/vision. Feed empty gallery arrays (`photos: { hemnet_gallery: [], booli_gallery: [] }`). Verdicts rest purely on fee-exact (apartments, within fee window) and address+price+area (houses).
- **D-06:** Reuse `fetchBooliSold` detail gate (`detailScope='fee-window'`) for apartment `rent`. **RESOLVED BELOW — the gate is INVERTED; see D-06 analysis section.** Planner must decide fix vs workaround.
- **D-07:** Persist matched Hemnet card via `upsertHemnetSold`. Do not persist non-matched candidates.
- **D-08:** Verdict mapping: `CONFIRMED_MATCH` → `matched`; no candidate OR `CONFIRMED_MISMATCH` → `booli_only`; `UNCERTAIN` → `uncertain`. `match_method` from adjudicator `source`: `fee_exact` (apt) / `address_key` (house). `evidence` (JSONB) = signals + deltas + matched-card brief + window dates.
- **D-09:** Call `setSpendClient(pgClient)` once at start. Bounded worker pool (~6 concurrent) with `CeilingError` early-stop.
- **D-10:** New script `scripts/sold-match-run.js`. Set `process.env.SCRAPE_FORCE_OXYLABS = '1'` before any require of sold-transport.

### Deferred Ideas (OUT OF SCOPE)

- Booli-only recall pass
- Listing-stage funnel / Hemnet suppression-rate tracking
- County expansion (Norrbotten / Dalarna)
- Photo/dHash/vision enrichment
- Scheduling/cron automation
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MATCH-01 | Each non-deed-transfer Booli sold record adjudicated against Hemnet candidates using fee-exact (apts) / address-key (villas), reusing `adjudicatePair` | Confirmed: `adjudicatePair` works with empty photos; fee-exact via `hemnet_unit.fee` vs `booli_unit.rent`; address-key via `addrCandidates` filter from spike |
| MATCH-03 | Apartment matches confirmed only within fee-available window; house matches use address key at any age | D-06 gate is INVERTED in `sold-fetch-booli.js` — apartments in the default 30-day window do NOT get detail fetched by `fetchBooliSoldPage`; runner must fetch detail inline for the matched candidate, not rely on seed-time detail |
| MATCH-04 | Each Booli record receives a persisted verdict (matched/booli_only/uncertain) with evidence | Confirmed: `persistVerdictForRecord` + `upsertSoldVerdict` are ready; verdict shape documented below |
| CONFIG-01 | Segments as configuration; add segment = data edit | `SEGMENTS` const in `lib/sold-config.js` must be migrated to `config/sold-segments.json`; no file exists yet |
| CONFIG-02 | Rolling-window params defaulting to monthly; runnable manually end-to-end | Window = `daysAgoISO(READ_TIME_EXCLUDE_DAYS)` (maxSoldDate) and `daysAgoISO(READ_TIME_EXCLUDE_DAYS + 30)` (minSoldDate); overridable via CLI args |
</phase_requirements>

---

## Summary

Phase 17 is an orchestration phase: all algorithms exist. The runner assembles `fetchBooliSoldPage` (in-memory seed per window), `upsertBooliSold` (persist seed), `searchSoldPaged` (Hemnet search per record), `adjudicatePair` (verdict), and `persistVerdictForRecord` (persist verdict) into a single config-driven loop with a bounded worker pool and DB-atomic spend ceiling.

The single highest-risk finding is **D-06: the `shouldFetchDetail` gate in `sold-fetch-booli.js` is inverted relative to the MATCH-03 requirement**. The gate fetches detail for apartments sold MORE than 270 days ago (i.e., old sales outside the fee-available window), and SKIPS detail for apartments sold less than 270 days ago (i.e., the recent monthly window the runner targets). This means the default `detailScope='fee-window'` in `fetchBooliSold`/`fetchBooliSoldPage` does NOT deliver `rent` for records in the standard 30-day window. The runner must fetch apartment detail inline during the match loop, independent of the seed-time gate.

The second structural finding: `fetchBooliSold` writes to a JSONL file and is designed for the spike's file-based workflow. The Phase 16 pattern used `fetchBooliSoldPage` (in-memory, no JSONL write) for DB pipelines. The runner should use `fetchBooliSoldPage` page by page, calling `upsertBooliSold` per card, matching the `persist-sold.js` pattern.

**Primary recommendation:** Build the runner around `fetchBooliSoldPage` + inline `upsertBooliSold`, then per-record `searchSoldPaged` + inline apartment detail fetch + `adjudicatePair` + `persistVerdictForRecord`, with `~6`-concurrent worker pool mirroring the spike. Fix the fee-window gate issue by fetching apartment detail in the runner's match loop, not relying on the seed-time `detailScope` flag.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Segment configuration | Config file (`config/sold-segments.json`) | Runner loader | D-01: adding a segment is data, not code |
| Booli seed ingestion | `lib/sold-fetch-booli.js` (fetchBooliSoldPage) | `lib/sold-store.js` (upsertBooliSold) | In-memory page primitive; runner persists |
| Hemnet search | `lib/sold-fetch-hemnet.js` (searchSoldPaged) | — | Per-record narrowed search with early-stop |
| Address candidate filter | Runner (inline, from spike `addrCandidates` logic) | — | Not yet extracted to lib; spike has the logic |
| Adjudication | `lib/spotcheck-adjudicate.js` (adjudicatePair) | — | Caller-agnostic; runner assembles the record shape |
| Verdict persistence | `lib/sold-store.js` (persistVerdictForRecord) | — | D-02 title-transfer gate lives here |
| Spend ceiling | `lib/sold-transport.js` (setSpendClient) | `lib/sold-spend.js` (DB-atomic tally) | One call at runner start; atomic in prod |
| Run summary / stdout | Runner (inline) | — | D-04: no file output |
| Config loading | Runner loader (one function) | — | Reads `config/sold-segments.json` at start |

---

## D-06 RESOLVED: Fee-Window Gate Analysis

**This is the highest-value finding in this research.**

### What the code actually does

In `lib/sold-fetch-booli.js`, `shouldFetchDetail` with `detailScope='fee-window'`:

```javascript
// Fee window check: sold_date older than FEE_WINDOW_DAYS ago
if (!card.sold_date) return true; // unknown date → attempt (safe)
const cutoff = daysAgoISO(FEE_WINDOW_DAYS, maxSoldDate);
return card.sold_date <= cutoff;
```

`FEE_WINDOW_DAYS = 270`. `maxSoldDate` defaults to `daysAgoISO(READ_TIME_EXCLUDE_DAYS)` = 90 days ago.

So `cutoff = daysAgoISO(270, maxSoldDate)` = approximately 360 days ago from today.

**Condition:** `return card.sold_date <= cutoff` — i.e., fetch detail when `sold_date` is MORE than 360 days in the past.

### For the standard 30-day window (D-02)

The runner's default window spans roughly 90–120 days ago (the most recent 30 days ending at the `READ_TIME_EXCLUDE_DAYS` boundary). All records in this window have `sold_date` between approximately `daysAgoISO(120)` and `daysAgoISO(90)`. These dates are all NEWER than the 360-day cutoff, so `card.sold_date <= cutoff` is FALSE for every record in the standard window.

**Result: `shouldFetchDetail` returns `false` for every apartment in the standard 30-day window.** No `rent` is populated at seed time.

### Is the gate buggy?

The smoke test comment confirms the intended semantics:

```javascript
check('shouldFetchDetail: fee-window fetches old apartment (>270d ago)', () => {
  // maxSoldDate = 2026-03-19 (90d ago); cutoff = 270d before that = 2025-06-22; sold_date 2025-01-01 <= cutoff
  assert.strictEqual(shouldFetchDetail(card, aptSeg, 'fee-window', '2026-03-19'), true);
});
check('shouldFetchDetail: fee-window skips recent apartment (<270d ago)', () => {
  const card = { is_title_transfer: false, sold_date: '2026-03-18' };
  assert.strictEqual(shouldFetchDetail(card, aptSeg, 'fee-window', '2026-03-19'), false);
});
```

The gate description says "fee window = within FEE_WINDOW_DAYS" but the implementation fetches for records OLDER than `FEE_WINDOW_DAYS` from `maxSoldDate`, which means older than ~360 days from today. This is genuinely inverted relative to what MATCH-03 requires.

**However:** The gate's design intent may have been "only fetch detail for records old enough that Booli has had time to post fee data" — i.e., a maturation window. The 270-day constant was described as "~9 months back is the practical Booli fee horizon." This interpretation makes the gate mean "don't bother fetching detail for very recent sales because Booli hasn't populated fee yet." Under this reading the gate is trying to be conservative about spend — but it means the monthly window (90–120 days back) falls in the "too recent for fee" zone, which contradicts the MATCH-03 requirement that apartment matches are confirmed within the fee-available window (stated as "≤~6–9 months back").

**Planner recommendation:** The runner must NOT rely on seed-time detail population for apartment `rent`. Instead:
1. Fetch Booli detail inline during the match loop, after finding an address candidate, using `fetchBooliDetail` directly (it is not exported but its pattern can be reproduced, or the runner uses `cachedFetch` + `parseBooliSoldDetail` directly).
2. Alternatively, use `detailScope='all'` for the seed pass — but this requires the operator-approval guard from the RECON doc (15-SOLD-IN-ADVANCE-RECON.md approval marker) and fetches detail for every non-transfer record, not just those with candidates.
3. The spike (`spike-hemnet-match.js`) used the inline approach (option 1): it fetched `/bostad/<residenceId>` after finding a candidate, independent of any seed-time gate.

**Recommended approach:** Mirror the spike — fetch apartment detail inline after finding an address candidate (not at seed time). This is the pattern that actually produced the validated 64% match rate. The `detailScope='fee-window'` path at seed time is a spend-optimization for batch runs that does not deliver rent for the target window.

---

## Standard Stack

No external dependencies beyond what is already installed. All libraries used are internal project modules.

| Module | Location | Purpose |
|--------|----------|---------|
| `lib/sold-fetch-booli.js` | repo | Booli /slutpriser seed fetch; `fetchBooliSoldPage` for in-memory pages |
| `lib/sold-fetch-hemnet.js` | repo | Hemnet /salda per-record search; `searchSoldPaged`, `searchOptsFor` |
| `lib/sold-store.js` | repo | DB upserts; `upsertBooliSold`, `upsertHemnetSold`, `persistVerdictForRecord` |
| `lib/sold-config.js` | repo | `READ_TIME_EXCLUDE_DAYS`, `daysAgoISO`, `SOLD_DATE_WINDOW_DAYS`, `isTitleTransfer` |
| `lib/sold-transport.js` | repo | `setSpendClient`, `CeilingError`, `remainingCalls`, `stdoutLogger` |
| `lib/spotcheck-adjudicate.js` | repo | `adjudicatePair(record, opts)` |
| `lib/spotcheck-evidence.js` | repo | `computeDeltas(booli, hemnet)`, `pctDiff` |
| `db.js` | repo | `createClient()` for pg Client |

---

## Exact Function Signatures

### `adjudicatePair(record, { visionResult, dhashResult } = {})`
**File:** `lib/spotcheck-adjudicate.js`

**`record` shape required by the adjudicator:**
```javascript
{
  pair_id:      any,            // used for logging only; can be booli_id
  deltas:  {
    price_pct_diff:  number|null,   // from computeDeltas
    area_pct_diff:   number|null,   // from computeDeltas
    family_match:    bool|null,     // from computeDeltas
  },
  photos:  {
    hemnet_gallery: [],             // EMPTY for sold pages (D-05)
    booli_gallery:  [],
  },
  hemnet_unit: {
    fee:   number|null,             // from Hemnet SaleCard.fee
    floor: number|null,             // optional
  },
  booli_unit: {
    rent:  number|null,             // from fetchBooliDetail result.rent
    floor: number|null,             // from booli seed card.floor
  },
}
```

**`opts` shape:** `{ visionResult?: { sharedPhoto: bool|null }, dhashResult?: { minDist, confirmed, sharedCount, threshold } }`. For sold pages, pass `{}` (D-05). The function does NOT crash on missing opts.

**Return shape:**
```javascript
{
  verdict:   'CONFIRMED_MATCH' | 'CONFIRMED_MISMATCH' | 'UNCERTAIN',
  source:    'unit-fields' | 'field-divergence' | 'conflict' | 'no-photos' |
             'insufficient-evidence' | 'dhash' | 'mode-b-vision',
  reason:    string,
  signals:   { priceAgrees, areaAgrees, feeBoth, feeMatch, feeContradict,
               floorBoth, floorContradict, familyMismatch, bothFieldGap,
               hasPhotos, photoShared, visionShared, fees, floors },
  challenge?: string,   // present only when D-04 fires (not relevant for sold)
}
```

**D-08 verdict→sold_match mapping (CONFIRMED against enum strings):**
- `'CONFIRMED_MATCH'` → `verdict = 'matched'`; `match_method = 'fee_exact'` when `source === 'unit-fields'`, `'address_key'` when source indicates house-only signals
- `'CONFIRMED_MISMATCH'` or no address candidate → `verdict = 'booli_only'`
- `'UNCERTAIN'` → `verdict = 'uncertain'`

**Note on `match_method` derivation:** The adjudicator `source` field does not directly map 1:1 to `fee_exact`/`address_key`. The runner must derive `match_method` from context:
- Apartment segment + `CONFIRMED_MATCH` → `fee_exact` (the only unit signal available)
- House segment + `CONFIRMED_MATCH` → `address_key` (no fee available for houses)
- The spike used a custom `source` string (`'house-address+area+price'`) for houses that bypassed `adjudicatePair` entirely. The runner should let `adjudicatePair` decide but set `match_method` based on `seg.family`.

---

### `fetchBooliSoldPage(segKey, seg, opts)`
**File:** `lib/sold-fetch-booli.js`

**Signature:**
```javascript
async function fetchBooliSoldPage(segKey, seg, opts = {})
// opts: { page, maxSoldDate, minSoldDate, logger }
// Returns: { cards: BooliCard[], meta: { totalCount: number|null, pages: number|null } }
```

**No JSONL write.** Returns in-memory cards only. The `detailScope` option has NO effect on `fetchBooliSoldPage` — it only affects `fetchBooliSold`. This function never calls `shouldFetchDetail`.

**BooliCard fields include:** `booli_id`, `street_address`, `object_type`, `sold_price`, `sold_date`, `sold_price_type`, `is_title_transfer`, `municipality`, `descriptive_area`, `living_area`, `additional_area`, `plot_area`, `rooms`, `floor`, `lat`, `long`, `residence_url`. Detail fields (`rent`, `operating_cost`, `construction_year`, `agent_id`, `agency_id`, `tenure_form`, `sold_in_advance`) are NOT populated by `fetchBooliSoldPage` — they require a detail fetch.

---

### `fetchBooliSold(segKey, seg, opts)`
**File:** `lib/sold-fetch-booli.js`

**Signature:**
```javascript
async function fetchBooliSold(segKey, seg, opts = {})
// opts: { target, marketTarget, maxPages, maxSoldDate, minSoldDate, detailScope, logger }
// detailScope: 'fee-window' | 'all' | 'none' (default 'fee-window')
// Returns: summary object (not a card array); writes to verf-soldspike/seeds/<segKey>.jsonl
```

**Not recommended for the Phase 17 runner.** It writes to a JSONL file, not to the DB. Use `fetchBooliSoldPage` instead.

---

### `searchSoldPaged(booli, seg, windowDays, maxPages, opts)`
**File:** `lib/sold-fetch-hemnet.js`

**Signature:**
```javascript
async function searchSoldPaged(booli, seg, windowDays, maxPages, opts = {})
// booli: one BooliCard from fetchBooliSoldPage
// seg: one segment object { family, hemnet: { locationId, itemType }, ... }
// windowDays: SOLD_DATE_WINDOW_DAYS (10) from sold-config
// maxPages: e.g. 5 (spike default)
// opts: searchOptsFor(seg) result
// Returns: { cards: HemnetCard[], pages: number, complete: boolean, stopReason?: string }
```

**`stopReason` values:** `'ceiling'` (CeilingError caught), `'ceiling-floor'` (remainingCalls <= 40 drain guard).

**HemnetCard fields:** `card_id`, `listing_id`, `slug`, `detail_url`, `street_address`, `sold_at` (Unix epoch seconds), `sold_at_label`, `asking_price`, `final_price`, `living_area`, `rooms`, `fee`, `housing_form`, `location_description`, `broker_name`, `broker_agency`, `lat`, `long`.

---

### `searchOptsFor(seg)`
**File:** `lib/sold-fetch-hemnet.js`

```javascript
function searchOptsFor(seg)
// HOUSE:     { priceBand: 0.10, areaBand: 0.15, dropRooms: true, dropItemType: true }
// APARTMENT: {} (tight defaults: priceBand=0.05, areaBand=0.07, rooms+item_type included)
```

---

### `upsertBooliSold(client, row)`
**File:** `lib/sold-store.js`

**`row` shape:** any object with `booli_id` + optional fields matching the 28-column DDL. All fields null-coalesced. Accepts a raw `fetchBooliSoldPage` card plus `segment` and `family` fields added by the runner.

**Spreads from card:** The runner should add `segment: segKey` and `family: seg.family` to each card before passing to `upsertBooliSold`, matching the `fetchBooliSold` behavior.

---

### `upsertHemnetSold(client, row)`
**File:** `lib/sold-store.js`

**`row` shape:** a `HemnetCard` from `parseHemnetSaleCards`. Key mapping: `row.slug` → `hemnet_slug` column ($1). The parser emits `slug`; the DB column is `hemnet_slug`. The upsert function reads `row.slug` for $1.

---

### `upsertSoldVerdict(client, row)`
**File:** `lib/sold-store.js`

**`row` shape (9 columns):**
```javascript
{
  booli_id:            string|number,  // $1 — REQUIRED
  matched_hemnet_slug: string|null,    // $2 — null for booli_only/uncertain
  verdict:             string|null,    // $3 — 'matched'|'booli_only'|'uncertain'
  match_method:        string|null,    // $4 — 'fee_exact'|'address_key'|null
  evidence:            object|null,    // $5 — auto-JSON.stringify'd (pass the object)
  segment:             string|null,    // $6
  window_start:        string|null,    // $7 — ISO date string (minSoldDate)
  window_end:          string|null,    // $8 — ISO date string (maxSoldDate)
  adjudicated_at:      string|null,    // $9 — ISO timestamp
}
```

**`evidence` field:** Pass a plain JS object. The function calls `JSON.stringify(row.evidence)` before binding. Never pre-stringify before passing.

---

### `persistVerdictForRecord(client, record, verdict)`
**File:** `lib/sold-store.js`

**Signature:**
```javascript
async function persistVerdictForRecord(client, record, verdict)
// record: the BooliCard (must have `is_title_transfer` boolean OR `sold_price_type` string)
// verdict: the verdict object (same shape as upsertSoldVerdict row, without booli_id)
//          booli_id is taken from record.booli_id automatically
// Returns: true if persisted, false if skipped (title transfer)
```

**D-02 gate:** If `record.is_title_transfer === true`, or if that field is absent and `isTitleTransfer(record.sold_price_type)` is true, returns `false` and issues zero queries. This is the ONLY place the title-transfer guard is enforced for the match table.

**`verdict` argument spread:** The function does `{ booli_id: record.booli_id, ...verdict }` before calling `upsertSoldVerdict`. So pass the full verdict object including `matched_hemnet_slug`, `verdict`, `match_method`, `evidence`, `segment`, `window_start`, `window_end`, `adjudicated_at`.

---

### `setSpendClient(client)`
**File:** `lib/sold-transport.js`

```javascript
function setSpendClient(client)
// client: connected pg Client
// Effect: switches _tally from file-backed to DB-atomic (sold_spend table)
// Call ONCE at runner start, before any cachedFetch calls
```

**`SCRAPE_FORCE_OXYLABS` invariant:** Must be set to `'1'` BEFORE `require('./sold-transport')` executes. The module throws at load time if the flag is absent. In the runner: `process.env.SCRAPE_FORCE_OXYLABS = '1'` as the very first line, before any requires.

---

### `remainingCalls()` and `remainingCallsAsync()`
**File:** `lib/sold-transport.js`

- `remainingCalls()` — SYNCHRONOUS, reads the file-based `_spend.json`. On the DB backend this is authoritative only as a drain guard; the real atomic ceiling is enforced by `reserveCall()`.
- `remainingCallsAsync()` — async, queries the DB tally's `remaining()`.
- The `sold-fetch-hemnet.js` drain guard at line 151 calls `remainingCalls()` synchronously. This remains correct on the DB path because the hard ceiling is enforced atomically by `reserveCall()` in `cachedFetch` — the sync drain guard is just an early soft stop.

**`CeilingError`:** Class with `code = 'OXY_CEILING'`. Re-exported from `sold-transport`. All catch sites use `e instanceof CeilingError`.

**`MAX_OXY_CALLS`:** Default 4000 (from `process.env.MAX_OXY_CALLS || '4000'`). Exported from `sold-transport`.

---

### `computeDeltas(booli, hemnet)`
**File:** `lib/spotcheck-evidence.js`

```javascript
// booli:  { price, living_area, object_type, street_address, postcode }
// hemnet: { asking_price, living_area, housing_form, street_address, post_code }
// Returns: { price_pct_diff, area_pct_diff, type_match, family_match,
//            booli_category, hemnet_category, address_match, postcode_match }
```

**Mapping for runner:** `booli.price = booli_card.sold_price`, `hemnet.asking_price = hemnet_card.final_price`. `postcode` is null for sold cards (Booli /slutpriser does not expose postcode; pass null).

---

### `createClient()`
**File:** `db.js`

```javascript
const { createClient } = require('./db');
const client = createClient();
await client.connect();
// ... runner work ...
await client.end();
```

No module-level DB connection. Each runner invocation opens one client, passes it to `setSpendClient` and all store upserts, closes in `finally`.

---

## Architecture Patterns

### Runner Structure (from spike, adapted for DB)

The spike's `runSegment` → `worker()` → `matchOne()` pattern is the direct template. The runner replaces:
- JSONL seed read → `fetchBooliSoldPage` + `upsertBooliSold` (page-by-page seeding)
- JSONL results write → `persistVerdictForRecord`
- File-based spend tally → `setSpendClient(pgClient)`
- Hard-coded segments → JSON config

**Seeding phase (per segment):** Paginate `fetchBooliSoldPage` with the configured window until empty page or page limit. Per card: call `upsertBooliSold(client, { ...card, segment: segKey, family: seg.family })`. Collect non-transfer cards into the match queue.

**Match phase (per segment, bounded concurrency):** Workers pull from queue. Per record:
1. Call `searchSoldPaged(record, seg, SOLD_DATE_WINDOW_DAYS, MAX_PAGES, searchOptsFor(seg))`
2. Filter candidates: `addrCandidates(record, cards, SOLD_DATE_WINDOW_DAYS)` (inline logic from spike)
3. If no candidates: verdict = `booli_only`, skip to persist
4. `pickBest(record, cands)` (inline logic from spike, sort by date proximity then price diff)
5. `computeDeltas(booliFmt, hemnetFmt)` to get deltas
6. **Apartments only:** fetch Booli detail inline via `cachedFetch` + `parseBooliSoldDetail` (the `fetchBooliDetail` pattern from `sold-fetch-booli.js` lines 108–136). Do NOT rely on `record.rent` from seed time.
7. Build `adjRecord = { pair_id: record.booli_id, deltas, photos: {hemnet_gallery:[], booli_gallery:[]}, hemnet_unit: { fee: chosen.fee }, booli_unit: { rent: booliRent, floor: record.floor } }`
8. `adjudicatePair(adjRecord, {})`
9. If `CONFIRMED_MATCH`: `upsertHemnetSold(client, chosen)` (D-07)
10. Assemble verdict object; call `persistVerdictForRecord(client, record, verdictObj)`

### Inline Logic from Spike (not yet extracted to lib)

Two small functions from `spike-hemnet-match.js` must be reproduced inline or copied to the runner:

**`addrCandidates(booli, cards, windowDays)`** (spike lines 152–160):
```javascript
function addrCandidates(booli, cards, windowDays) {
  const bStreet = normAddr(booli.street_address);
  const bUnix = booliSoldUnix(booli.sold_date);
  return cards.filter((c) => {
    if (!c.street_address || normAddr(c.street_address) !== bStreet) return false;
    if (bUnix != null && c.sold_at != null && Math.abs(c.sold_at - bUnix) > windowDays * DAY) return false;
    return true;
  });
}
```

Note: `normAddr` is already in `lib/sold-fetch-hemnet.js` is NOT the same as the spike's inline `normAddr` — the lib version imports from `lib/sold-addr.js`, which is the canonical Phase-15 version. Use `normAddr` from `lib/sold-addr.js` (same function, single source of truth per 15-05 decision).

`booliSoldUnix` is exported from `lib/sold-fetch-hemnet.js`.

**`pickBest(booli, cands)`** (spike lines 170–179): sort by date proximity, tiebreak by price diff. Use `pctDiff` from `lib/spotcheck-evidence.js`.

### Concurrency Pattern (~6 workers)

From spike `runSegment` (lines 296–319):
```javascript
let idx = 0;
async function worker(wid) {
  while (idx < queue.length) {
    if (stopped) return;
    if (remainingCalls() <= 40) { stopped = 'ceiling-floor'; return; }
    const record = queue[idx++];
    try {
      await sleep(jitter()); // 80-240ms jitter
      // ... matchOne equivalent ...
    } catch (e) {
      if (e instanceof CeilingError) { stopped = 'ceiling'; return; }
      // persist error verdict
    }
  }
}
await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));
```

Default `conc = 6`. Stopped flag shared across all workers. CeilingError exits all workers via the `stopped` flag.

### Config File Shape (`config/sold-segments.json`)

Exact shape to migrate from `lib/sold-config.js` `SEGMENTS` const:
```json
{
  "stockholm-apt": {
    "label": "Stockholm apartments",
    "family": "APARTMENT",
    "booli": { "areaIds": 1, "objectType": "Lägenhet" },
    "hemnet": { "locationId": 18031, "itemType": "bostadsratt" }
  },
  "taby-villa": {
    "label": "Täby houses",
    "family": "HOUSE",
    "booli": { "areaIds": 20, "objectType": "Hus" },
    "hemnet": { "locationId": 17793, "itemType": null }
  }
}
```

**Loader pattern:** One function reads and returns the parsed object. Used by the runner and any future CLI wrappers. The runner should NOT import `SEGMENTS` from `lib/sold-config.js` — that const stays for backward compatibility with Phase 15/16 smoke tests and scripts.

### Default Window Calculation (D-02)

```javascript
const maxSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS);            // ~90 days ago
const minSoldDate = daysAgoISO(READ_TIME_EXCLUDE_DAYS + 30);       // ~120 days ago
// Override via --min-sold-date / --max-sold-date CLI args
```

`READ_TIME_EXCLUDE_DAYS = 90` and `daysAgoISO` are both exported from `lib/sold-config.js`.

### Verdict Object Assembly (D-08)

```javascript
// After adjudicatePair returns `adj`:
const verdictObj = {
  matched_hemnet_slug: adj.verdict === 'CONFIRMED_MATCH' ? chosen.slug : null,
  verdict: adj.verdict === 'CONFIRMED_MATCH' ? 'matched'
         : adj.verdict === 'CONFIRMED_MISMATCH' ? 'booli_only'
         : 'uncertain',
  // When no address candidate at all, verdict is 'booli_only' without calling adjudicatePair
  match_method: adj.verdict === 'CONFIRMED_MATCH'
    ? (seg.family === 'APARTMENT' ? 'fee_exact' : 'address_key')
    : null,
  evidence: {
    signals: adj.signals,
    reason: adj.reason,
    source: adj.source,
    deltas,
    matched_card: adj.verdict === 'CONFIRMED_MATCH' ? cardBrief(chosen) : null,
    window_start: minSoldDate,
    window_end: maxSoldDate,
    addr_candidates: cands.length,
    fee: seg.family === 'APARTMENT' ? { booli_rent: booliRent, hemnet_fee: chosen?.fee } : null,
  },
  segment: segKey,
  window_start: minSoldDate,
  window_end: maxSoldDate,
  adjudicated_at: new Date().toISOString(),
};
// Then:
await persistVerdictForRecord(client, record, verdictObj);
```

**`cardBrief` pattern** (spike line 183):
```javascript
function cardBrief(c) {
  return c ? { card_id: c.card_id, listing_id: c.listing_id, slug: c.slug,
               detail_url: c.detail_url, street_address: c.street_address,
               final_price: c.final_price, living_area: c.living_area,
               rooms: c.rooms, fee: c.fee, sold_at: c.sold_at } : null;
}
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Booli /slutpriser pagination | Custom page loop | `fetchBooliSoldPage` | Already handles 200/non-200, apollo parse, ceiling propagation |
| Hemnet /salda per-record search | Custom search | `searchSoldPaged` + `searchOptsFor` | Early-stop logic, drain guard, within-run dedup cache already correct |
| DB upserts | Raw INSERT queries | `upsertBooliSold`, `upsertHemnetSold`, `persistVerdictForRecord` | Correct ON CONFLICT keys, title-transfer gate, JSON.stringify for evidence |
| Adjudication logic | Custom fee/area checks | `adjudicatePair` | Phase-14 identity model; fee-drift UNCERTAIN handling is critical correctness |
| Spend ceiling | Custom counter | `setSpendClient` + `CeilingError` | Phase-16 DB-atomic implementation; hand-rolling loses the race-free guarantee |
| Address normalization | Inline regex | `normAddr` from `lib/sold-addr.js` | MATCH-02 normalization (space-before-unit-letter, dual X/Y, " och ", truncated number) |
| Delta computation | Inline pct calcs | `computeDeltas` from `lib/spotcheck-evidence.js` | Correct null handling, symmetric pctDiff, family_match derivation |

---

## Common Pitfalls

### Pitfall 1: SCRAPE_FORCE_OXYLABS Set Too Late
**What goes wrong:** `sold-transport.js` throws at module load: `"SCRAPE_FORCE_OXYLABS must be set..."`.
**Why it happens:** Any `require` chain that loads `sold-transport` before the flag is set will trigger the guard.
**How to avoid:** `process.env.SCRAPE_FORCE_OXYLABS = '1'` must be the FIRST executable line in `sold-match-run.js`, before any `require` calls. `require('dotenv').config()` loads after the flag line (it cannot override an already-set env var).
**Warning signs:** `Error: sold-transport: SCRAPE_FORCE_OXYLABS must be set...` on runner startup.

### Pitfall 2: Using `fetchBooliSold` Instead of `fetchBooliSoldPage`
**What goes wrong:** `fetchBooliSold` writes to `verf-soldspike/seeds/<segKey>.jsonl` (not the DB) and applies the inverted detail gate. The runner ends up with a JSONL file instead of DB rows.
**How to avoid:** Use `fetchBooliSoldPage` in a page loop, call `upsertBooliSold` per card.

### Pitfall 3: Relying on `record.rent` from Seed for Apartment Fee
**What goes wrong:** `record.rent` is `null` for all apartments in the standard monthly window (D-06 gate analysis above). `adjudicatePair` gets `booli_unit: { rent: null }`, `feeBoth = false`, and all apartments return `UNCERTAIN` instead of `CONFIRMED_MATCH`.
**How to avoid:** Fetch Booli detail inline after finding an address candidate (mirror spike `matchOne` apartment branch). Check `record.residence_url` is non-null before fetching.
**Warning signs:** 0% match rate on Stockholm apartments; all adjudicator `source` values are `'no-photos'` or `'insufficient-evidence'`.

### Pitfall 4: Passing Pre-Stringified `evidence` to `upsertSoldVerdict`
**What goes wrong:** Double-encoding — `'{"a":1}'` becomes `'"{\\"a\\":1}"'` in the JSONB column.
**How to avoid:** Pass the plain JS object. `upsertSoldVerdict` calls `JSON.stringify` internally.

### Pitfall 5: Missing `setSpendClient` Before First `cachedFetch`
**What goes wrong:** Spend counter stays on the file tally (`_spend.json`); DB-atomic ceiling is not active. Concurrent workers can race past the ceiling.
**How to avoid:** Call `setSpendClient(client)` immediately after `client.connect()`, before the seeding loop.

### Pitfall 6: `upsertHemnetSold` Expects `row.slug` Not `row.hemnet_slug`
**What goes wrong:** The parser emits `slug`; the column is `hemnet_slug`, but the upsert reads `row.slug` for the $1 parameter. If the runner renames the field to `hemnet_slug` the upsert gets `null`.
**How to avoid:** Pass the raw `HemnetCard` from `parseHemnetSaleCards` (or the `searchSoldPaged` cards array) directly. Do not rename `slug` to `hemnet_slug` before passing.

### Pitfall 7: Importing `SEGMENTS` from `lib/sold-config.js` Instead of JSON Config
**What goes wrong:** Bypasses D-01; adding a segment still requires a code change.
**How to avoid:** Runner loads from `config/sold-segments.json`. The `SEGMENTS` const stays in `lib/sold-config.js` for backward compatibility with existing smokes only.

---

## DB State

**Phase 16 live status:** CONFIRMED APPLIED TO PROD.

Commit `466cfe7` (2026-06-17): "mark all 3 live-DB UAT items PASS (run on droplet, operator-authorized). Migration applied + idempotent; persist idempotency 0->1970->1970 (zero dupes); atomic ceiling held exactly 100/100 under 4-way concurrency."

**Tables in play:**
| Table | UNIQUE key | Populated by Phase 17 |
|-------|-----------|----------------------|
| `booli_sold` | `booli_id` | `upsertBooliSold` (seeding phase) |
| `hemnet_sold` | `hemnet_slug` | `upsertHemnetSold` (matched records only, D-07) |
| `sold_match` | `booli_id` | `persistVerdictForRecord` (all non-transfer records) |
| `sold_spend` | `spend_key` | `reserveCall` (DB-atomic, via `setSpendClient`) |

**Deploy:** `git pull` on droplet. No migration required.

**Note:** `booli_sold` currently contains 1970 test rows from the Phase 16 live UAT run. These are real data, not an error. Re-running the same window will upsert (no duplicates, DB-03). If a clean-slate run is desired, the operator must truncate the table first.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 17 is a code-only change. All external dependencies (PostgreSQL, Node.js, Oxylabs credentials) are confirmed available from prior phases. No new tools required.

---

## Validation Architecture

The `.planning/config.json` has `"workflow": { "research": false }` — no `nyquist_validation` key. Treat as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js inline `--smoke` tests (no external test runner) |
| Config file | None — each lib module self-tests via `--smoke` flag |
| Quick run command | `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke` |
| Full suite command | `node lib/sold-store.js --smoke && node lib/spotcheck-adjudicate.js --smoke && SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-booli.js --smoke && SCRAPE_FORCE_OXYLABS=1 node lib/sold-fetch-hemnet.js --smoke` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| MATCH-01 | adjudicatePair called per non-deed-transfer record | unit smoke | `node lib/spotcheck-adjudicate.js --smoke` (existing, covers fee-exact + address-key paths) |
| MATCH-03 | Apartment detail fetched inline (not from seed); houses use address key | smoke (new) | `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke` — smoke must assert `record.rent` is populated for apartments even when seed-time `rent=null` |
| MATCH-04 | All non-transfer records get persisted verdict | smoke (new) | Runner `--smoke` with mock client; assert `persistVerdictForRecord` called for each non-transfer record |
| CONFIG-01 | Third segment addable without code change | integration (new) | Add a dummy segment to `config/sold-segments.json`, verify runner loads it and logs the segKey |
| CONFIG-02 | `--min-sold-date`/`--max-sold-date` override defaults | unit (new) | Runner `--smoke` with explicit dates; assert window params passed to `fetchBooliSoldPage` and `searchSoldPaged` |

### Wave 0 Gaps
- [ ] `scripts/sold-match-run.js` — the runner itself (Wave 1 creates it)
- [ ] `config/sold-segments.json` — the segment config file (Wave 1 creates it)
- [ ] Smoke test coverage for inline apartment detail fetch (MATCH-03 gap)
- [ ] Smoke test coverage for verdict persistence per record (MATCH-04 gap)

---

## Security Domain

No new authentication surfaces, external API changes, or user inputs. The runner inherits the existing patterns:
- All DB queries use `$1,$2,...` parameterized placeholders (confirmed in sold-store.js)
- `evidence` passed as object → `JSON.stringify` (no injection path via JSONB)
- CLI args (`--min-sold-date`, `--max-sold-date`) used only as date strings passed to URL params and DB queries via parameterized binding — validate format before use

ASVS: V5 Input Validation applies to CLI date args. Pattern: validate `YYYY-MM-DD` format before accepting (runner should reject malformed dates with a clear error).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `fetchBooliDetail` (unexported private function in `sold-fetch-booli.js`) can be replicated in the runner using `cachedFetch` + `parseBooliSoldDetail` | D-06 analysis, match phase | If the function has undocumented side effects, runner detail fetch may behave differently — LOW risk, function is simple |
| A2 | 1970 test rows in `booli_sold` from Phase 16 UAT are from a Stockholm-apt window that will overlap with the first real run | DB State section | If they're from a different segment/window, no overlap and no issue; if they do overlap, upsert handles it (DB-03) — effectively zero risk |
| A3 | `parseBooliSoldDetail` is exported from `lib/sold-parse.js` and usable standalone | Match phase | Verified by grep on imports in sold-fetch-booli.js — confirmed it is imported and used |

**Verified claims:** All function signatures, return shapes, field names, DB table state, and the D-06 gate analysis are verified by direct codebase reads. No web research needed.

---

## Open Questions

1. **`fetchBooliDetail` not exported — approach for inline apartment detail fetch**
   - What we know: The function exists at lines 108–136 of `sold-fetch-booli.js`. It calls `cachedFetch` + `extractApollo` + `parseBooliSoldDetail`. It is not in `module.exports`.
   - What's unclear: Whether the planner should (a) export it from `sold-fetch-booli.js` as Wave 0, (b) reproduce the 3-line pattern inline in the runner, or (c) extract it to a shared helper.
   - Recommendation: Option (a) — add `fetchBooliDetail` to exports in `sold-fetch-booli.js` as a Wave 0 task. Clean boundary, zero logic change.

2. **House matching: bypass `adjudicatePair` or route through it?**
   - What we know: The spike bypassed `adjudicatePair` for houses when `cands.length === 1 && areaOk && priceOk` (direct `CONFIRMED_MATCH` with custom source string). When conditions weren't met, it called `adjudicatePair` but mapped the result oddly (`CONFIRMED_MATCH → UNCERTAIN` for multi-candidate cases).
   - What's unclear: D-08 says `match_method = 'address_key'` for house matches — should the runner always route houses through `adjudicatePair` (cleaner, consistent), or preserve the spike's direct-confirm path?
   - Recommendation: Route ALL adjudication through `adjudicatePair` (pass empty `hemnet_unit`/`booli_unit` for houses). The adjudicator's `priceAgrees + areaAgrees` path yields `UNCERTAIN` because there's no unit-level signal — which is technically correct but means 0% match rate for houses. Alternatively, replicate the spike's house shortcut. **Planner must decide.** The spike showed ~98% match rate for villas; routing through unmodified `adjudicatePair` with no fee signal would yield ~0%. The house shortcut from the spike is the correct behavior.

3. **`sold_match` has 0 rows but `booli_sold` has 1970 test rows — first run scope**
   - What we know: Phase 16 UAT loaded 1970 booli_sold rows but never populated `sold_match` (Phase 17 scope).
   - What's unclear: Should the first Phase 17 run re-seed booli_sold for the same window (causing upserts on existing rows) or should it be pointed at a fresh window?
   - Recommendation: Fresh window (e.g., 90–120 days ago from the actual run date). Upserts are idempotent; re-seeding is harmless but wastes Oxylabs calls. The runner is manual-run; operator chooses the window.

---

## Sources

### Primary (HIGH confidence — all from direct codebase reads)
- `lib/sold-fetch-booli.js` — `shouldFetchDetail` logic, `fetchBooliSoldPage` signature, `FEE_WINDOW_DAYS = 270`
- `lib/sold-config.js` — `SEGMENTS` shape, `READ_TIME_EXCLUDE_DAYS = 90`, `daysAgoISO`, `isTitleTransfer`, all constants
- `lib/spotcheck-adjudicate.js` — full `adjudicatePair` signature, return shape, verdict enum strings
- `lib/sold-fetch-hemnet.js` — `searchSoldPaged`, `searchOptsFor`, `buildHemnetSoldUrl` signatures
- `lib/sold-store.js` — all four functions, exact column order, `verdict` object shape
- `lib/sold-transport.js` — `setSpendClient`, `CeilingError`, `remainingCalls`/`Async`, `SCRAPE_FORCE_OXYLABS` guard
- `lib/sold-spend.js` — `makeSpendTally`, DB-atomic vs file-tally internals, `spendKey` default `'sold-global'`
- `lib/spotcheck-evidence.js` — `computeDeltas`, `pctDiff` signatures
- `scripts/spike-hemnet-match.js` — `matchOne`, `addrCandidates`, `pickBest`, `cardBrief`, worker pool pattern
- `db.js` — `createClient()` pattern
- `.planning/phases/16-sold-match-db-schema-persistence/16-VERIFICATION.md` — Phase 16 live status
- `git log` commit `466cfe7` — confirmed Phase 16 tables live on prod

---

## Metadata

**Confidence breakdown:**
- D-06 fee-window analysis: HIGH — read the exact `shouldFetchDetail` code and smoke tests
- Function signatures: HIGH — read directly from source files
- DB table state (Phase 16 live): HIGH — confirmed by git commit message and VERIFICATION.md
- Verdict field shape for `persistVerdictForRecord`: HIGH — read the implementation
- House matching approach (open question 2): LOW — behavior depends on planner decision, spike shows 98% rate with shortcut

**Research date:** 2026-06-17
**Valid until:** Stable — until `lib/sold-fetch-booli.js`, `lib/sold-store.js`, or `lib/spotcheck-adjudicate.js` are modified
