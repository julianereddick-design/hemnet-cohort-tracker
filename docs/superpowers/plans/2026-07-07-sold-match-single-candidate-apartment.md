# Sold-match Single-Candidate Apartment Confirmation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the apartment branch of the sold-match pipeline from holding near-certain single-candidate matches as `uncertain`, and backfill the ~72 historical rows already in that state.

**Architecture:** Add one confirmation tier to `matchOne`'s apartment branch in `scripts/sold-match-run.js`, inserted *before* the `adjudicatePair` call: when there is exactly one same-address Hemnet candidate whose living-area and sold-price agree, confirm the match (`match_method='single_candidate_confirmed'`) without requiring a fee cross-check. Fee and room-count only *veto* (present-and-contradicting), never block on missing data — mirroring the existing HOUSE address-key shortcut. A one-off, dry-run-by-default migration re-evaluates the same predicate against the stored evidence JSONB of current `uncertain` apartment rows and flips the qualifiers to `matched`.

**Tech Stack:** Node.js (CommonJS), `pg` (node-postgres), offline `--smoke` self-tests (the repo's TDD idiom — no test runner, each module self-tests via `node <file> --smoke`).

## Global Constraints

- **Thresholds (exact values):** `AREA_AGREE_PCT = 0.07`, `PRICE_AGREE_PCT = 0.05` (existing, `lib/sold-config.js`). New: `FEE_AGREE_PCT = 0.05` (±5%).
- **Fee rule:** fee *confirms*, absence does *not* block, a gap > `FEE_AGREE_PCT` *vetoes* (falls through to the adjudicator). Only vetoes when the fee is present on **both** sides and differs by more than tolerance.
- **Rooms rule:** veto only when room counts are present on **both** sides and differ. Never veto on missing data.
- **New match_method values:** `'single_candidate_confirmed'` (live matcher) and `'single_candidate_confirmed_backfill'` (migration) — kept distinct from `fee_exact` / `address_key` / `bostad_bridge` for provenance.
- **Do NOT touch shared code:** no changes to `lib/spotcheck-adjudicate.js` (shared with the live cohort spot-check) or the HOUSE branch. Localized to the apartment branch only.
- **Prod-write approval gate:** the migration is **dry-run by default** (read-only). The actual DB write requires `--apply` AND Julian's explicit go-ahead for that specific run (per repo guardrails — no prod writes without approval). Never run `--apply` autonomously.
- **Offline smokes are network- and DB-free:** all new tests run via `node <file> --smoke` with mock clients / injected deps. No Oxylabs, no DB connection.

---

## File Structure

- `lib/sold-config.js` — **Modify.** Add and export `FEE_AGREE_PCT = 0.05`; add its `--smoke` assertion.
- `scripts/sold-match-run.js` — **Modify.** Import `FEE_AGREE_PCT`; insert the single-candidate tier into `matchOne`'s apartment branch; update three existing apartment smoke tests whose behavior the tier changes; add new smoke tests.
- `migrate-sold-backfill-single-candidate.js` — **Create.** Pure `qualifiesForBackfill(evidence, cfg)` predicate + a dry-run-by-default driver that flips qualifying `uncertain` apartment rows to `matched` under `--apply`; inline `--smoke` for the predicate and the idempotency guard.

---

## Task 1: Add `FEE_AGREE_PCT` constant to sold-config

**Files:**
- Modify: `lib/sold-config.js` (constant + export near lines 38-47 and 103-119; smoke assertion near line 181)

**Interfaces:**
- Produces: `FEE_AGREE_PCT` (Number `0.05`), exported from `lib/sold-config.js`. Consumed by Task 2 (the tier) and Task 3 (the backfill predicate default).

- [ ] **Step 1: Write the failing smoke assertion**

In `lib/sold-config.js`, in the `--smoke` block, add this assertion immediately after the existing `PRICE_AGREE_PCT: is 0.05` check (currently lines 181-183):

```js
  check('FEE_AGREE_PCT: is 0.05', () => {
    assert.strictEqual(FEE_AGREE_PCT, 0.05);
  });
```

- [ ] **Step 2: Run the smoke to verify it fails**

Run: `node lib/sold-config.js --smoke`
Expected: FAIL — `SMOKE FAIL [FEE_AGREE_PCT: is 0.05]: FEE_AGREE_PCT is not defined` (or a ReferenceError), and a non-zero exit.

- [ ] **Step 3: Add the constant and export it**

In `lib/sold-config.js`, add the constant right after the `AREA_AGREE_PCT` definition (currently line 40):

```js
const AREA_AGREE_PCT = 0.07;  // ±7% living-area agreement
// ±5% monthly-fee agreement. Used by the single-candidate apartment confirmation
// tier (scripts/sold-match-run.js) and its backfill: a fee present on BOTH sides
// that differs by more than this vetoes the tier; absence never blocks. Tolerates
// the observed 0.2–1.2% cross-platform rounding drift.
const FEE_AGREE_PCT = 0.05;
```

Then add `FEE_AGREE_PCT` to the `module.exports` block (currently lines 103-119), right after the `AREA_AGREE_PCT,` line:

```js
  PRICE_AGREE_PCT,
  AREA_AGREE_PCT,
  FEE_AGREE_PCT,
  PRICE_BAND,
```

- [ ] **Step 4: Run the smoke to verify it passes**

Run: `node lib/sold-config.js --smoke`
Expected: PASS — `smoke: N pass, 0 fail`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/sold-config.js
git commit -m "feat(sold-config): add FEE_AGREE_PCT=0.05 for single-candidate apartment tier"
```

---

## Task 2: Add the single-candidate confirmation tier to the apartment branch

**Files:**
- Modify: `scripts/sold-match-run.js` — import (line 27), `matchOne` apartment branch (insert after line 334, before line 335), and the `runSmoke` apartment tests (existing tests #4/#5/#5b at ~lines 624-658; new tests appended after them)

**Interfaces:**
- Consumes: `FEE_AGREE_PCT` from `lib/sold-config.js` (Task 1); the in-scope locals in `matchOne`'s apartment branch — `cands` (array), `booliRent` (Number|null), `feeChosen` (Hemnet card object with `.fee`, `.rooms`, `.slug`), `aptDeltas` (object with `.address_match`, `.area_pct_diff`, `.price_pct_diff`), `record.rooms` (Number|null), `segKey`, `minSoldDate`, `maxSoldDate`.
- Produces: a `matched` verdict with `match_method='single_candidate_confirmed'` and `matched_hemnet_slug=feeChosen.slug` for single-candidate agreeing apartments; evidence carries `single_candidate:true`, `fee_checked`, `rooms_checked`.

### Behavior note — why three existing tests change

The tier is inserted **before** `adjudicatePair`, so for a **single** same-address candidate it now short-circuits paths that previously reached the adjudicator:
- Existing test #4 (single candidate, fee-exact) previously produced `match_method='fee_exact'`; it now produces `single_candidate_confirmed`. → **repurposed** to assert the new method (this *is* the spec's "fee present & within 5% → matched" case).
- Existing test #5 (single candidate, fee absent → `uncertain`) enshrined the over-conservative behavior this change deliberately reverses; it now produces `matched/single_candidate_confirmed`. → **inverted** (this *is* the spec's "fee absent → matched" case).
- Existing test #5b (single candidate, fee-exact via `/annons`) previously produced `fee_exact`; a single candidate now takes the tier. To preserve the `/annons` fee-fetch regression guard AND keep `fee_exact` (multi-candidate) coverage, it is **converted to a 2-candidate** fee-exact case.

- [ ] **Step 1: Update the three existing apartment smoke tests (write the new expectations first)**

In `scripts/sold-match-run.js` `runSmoke`, **replace** existing test #4 (currently lines 624-634, the `'apt fee-exact → matched/fee_exact + Hemnet persist'` block) with:

```js
  // 4) APARTMENT, single candidate, fee present & within tolerance → the single-
  //    candidate tier fires FIRST → matched/single_candidate_confirmed (NOT fee_exact;
  //    fee_exact is now the MULTI-candidate disambiguation method — see test 5b).
  await checkAsync('apt single-candidate fee within 5% → matched/single_candidate_confirmed', async () => {
    const c = mockClient();
    const cands = [hcard({ slug: 'apt-1', housing_form: 'Lägenhet', fee: 4500 })];
    const v = await matchOne(c, brec({ booli_id: 14, object_type: 'Lägenhet' }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: 4500 }));
    assert.strictEqual(v, 'matched');
    assert.strictEqual(verdictMethod(c), 'single_candidate_confirmed');
    assert.strictEqual(verdictSlug(c), 'apt-1');
    assert.strictEqual(hemnet(c).length, 1, 'matched apt persists its Hemnet card (D-07)');
    const ev = verdictEvidence(c);
    assert.strictEqual(ev.single_candidate, true, 'evidence flags single_candidate');
    assert.strictEqual(ev.fee_checked, true, 'fee present on both → fee_checked true');
  });
```

**Replace** existing test #5 (currently lines 636-645, the `'apt no fee (rent null) → uncertain'` block) with:

```js
  // 5) APARTMENT, single candidate, fee ABSENT (Booli rent null) → tier fires:
  //    one unit at this address with agreeing area+price, no other unit to confuse
  //    it with, so the missing fee no longer blocks → matched/single_candidate_confirmed.
  //    (Deliberately inverts the pre-change "no fee → uncertain" behavior.)
  await checkAsync('apt single-candidate fee absent → matched/single_candidate_confirmed', async () => {
    const c = mockClient();
    const cands = [hcard({ slug: 'apt-2', housing_form: 'Lägenhet', fee: null })];
    const v = await matchOne(c, brec({ booli_id: 15, object_type: 'Lägenhet' }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: null }));
    assert.strictEqual(v, 'matched');
    assert.strictEqual(verdictMethod(c), 'single_candidate_confirmed');
    assert.strictEqual(verdictSlug(c), 'apt-2', 'matched row persists the Hemnet slug');
    assert.strictEqual(hemnet(c).length, 1, 'matched apt persists its Hemnet card (D-07)');
    const ev = verdictEvidence(c);
    assert.strictEqual(ev.fee_checked, false, 'fee absent → fee_checked false');
  });
```

**Replace** existing test #5b (currently lines 647-658, the `'apt /annons card → fee fetch runs → matched/fee_exact'` block) with:

```js
  // 5b) APARTMENT, TWO same-address candidates via an /annons card, one fee-exact →
  //     tier is skipped (cands.length !== 1) → adjudicator confirms on fee → matched/
  //     fee_exact. Doubles as (a) the /annons fee-fetch regression guard (extractDetailUrl
  //     must follow /annons/<booliId>; if it regressed, rent=null → no fee-exact → uncertain)
  //     and (b) the multi-candidate fee_exact path.
  await checkAsync('apt /annons 2-candidate fee-exact → matched/fee_exact', async () => {
    const c = mockClient();
    const cands = [
      hcard({ slug: 'apt-annons', card_id: 'c1', housing_form: 'Lägenhet', fee: 4500 }),
      hcard({ slug: 'apt-decoy', card_id: 'c2', housing_form: 'Lägenhet', fee: 9999 }),
    ];
    const v = await matchOne(c, brec({ booli_id: 17, object_type: 'Lägenhet', residence_url: '/annons/777' }),
      APT, 'stockholm-apt', WIN[0], WIN[1], noLog, depsWith(cands, { rent: 4500 }));
    assert.strictEqual(v, 'matched', '/annons apt must reach fee-exact (was uncertain before the /annons fix)');
    assert.strictEqual(verdictMethod(c), 'fee_exact');
    assert.strictEqual(verdictSlug(c), 'apt-annons');
  });
```

- [ ] **Step 2: Add the `verdictEvidence` smoke helper**

The new assertions read the evidence JSONB. Add this helper next to the existing `verdictSlug`/`verdictMethod`/`verdictName` helpers (currently lines 505-507):

```js
  const verdictEvidence = (c) => JSON.parse(sold(c)[0].params[4]); // $5 evidence (JSON string)
```

- [ ] **Step 3: Add the new apartment tier smoke tests**

Immediately after the (now-updated) test #5b block, add these five tests:

```js
  // 5c) single candidate, fee present & differs > 5% → tier VETOED → adjudicator sees a
  //     fee contradiction (tolerance 0 kr) → UNCERTAIN conflict → uncertain.
  await checkAsync('apt single-candidate fee differs >5% → uncertain (tier vetoed)', async () => {
    const c = mockClient();
    const cands = [hcard({ slug: 'apt-3', housing_form: 'Lägenhet', fee: 6000 })];
    const v = await matchOne(c, brec({ booli_id: 18, object_type: 'Lägenhet' }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: 4500 })); // |6000-4500|/4500 = 33% > 5%
    assert.strictEqual(v, 'uncertain');
    assert.strictEqual(verdictMethod(c), null);
    assert.strictEqual(hemnet(c).length, 0);
  });

  // 5d) single candidate, area+price agree, fee ABSENT, but ROOMS differ → tier VETOED
  //     (rooms present on both and unequal) → adjudicator has no fee/photos → uncertain.
  await checkAsync('apt single-candidate rooms differ → uncertain (tier vetoed)', async () => {
    const c = mockClient();
    const cands = [hcard({ slug: 'apt-4', housing_form: 'Lägenhet', fee: null, rooms: 4 })];
    const v = await matchOne(c, brec({ booli_id: 19, object_type: 'Lägenhet', rooms: 5 }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: null }));
    assert.strictEqual(v, 'uncertain', 'rooms 5 vs 4 with no fee → tier vetoed → uncertain');
    assert.strictEqual(verdictMethod(c), null);
  });

  // 5e) single candidate, area DISAGREES, fee absent → tier skipped (areaOk false) →
  //     adjudicator (no fee/photos) → uncertain. Confirms the tier requires area agreement.
  await checkAsync('apt single-candidate area disagree → uncertain (tier not used)', async () => {
    const c = mockClient();
    const cands = [hcard({ slug: 'apt-5', housing_form: 'Lägenhet', fee: null, living_area: 200 })];
    const v = await matchOne(c, brec({ booli_id: 20, object_type: 'Lägenhet', living_area: 100 }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: null })); // area 100 vs 200 → 100% diff
    assert.strictEqual(v, 'uncertain');
  });

  // 5f) TWO same-address candidates, NO fee on either → tier skipped → adjudicator has no
  //     unit signal → uncertain. (Multi-candidate is left to the adjudicator, unchanged.)
  await checkAsync('apt 2-candidate no fee → uncertain (adjudicator path)', async () => {
    const c = mockClient();
    const cands = [
      hcard({ slug: 'apt-6a', card_id: 'c1', housing_form: 'Lägenhet', fee: null }),
      hcard({ slug: 'apt-6b', card_id: 'c2', housing_form: 'Lägenhet', fee: null }),
    ];
    const v = await matchOne(c, brec({ booli_id: 21, object_type: 'Lägenhet' }), APT, 'stockholm-apt', WIN[0], WIN[1], noLog,
      depsWith(cands, { rent: null }));
    assert.strictEqual(v, 'uncertain');
  });
```

- [ ] **Step 4: Run the smoke to verify the new/updated tests FAIL**

Run: `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke`
Expected: FAIL — the updated tests #4/#5/#5b and new 5c–5f fail because the tier does not exist yet (e.g. #5 still returns `uncertain`, #4 still returns `fee_exact`). Non-zero exit.

> Windows/PowerShell equivalent if bash is unavailable: `$env:SCRAPE_FORCE_OXYLABS='1'; node scripts/sold-match-run.js --smoke`

- [ ] **Step 5: Import `FEE_AGREE_PCT` into the runner**

In `scripts/sold-match-run.js`, extend the `lib/sold-config` require (currently line 27):

```js
const { isTitleTransfer, PRICE_AGREE_PCT, AREA_AGREE_PCT, FEE_AGREE_PCT, SOLD_DATE_WINDOW_DAYS, READ_TIME_EXCLUDE_DAYS, daysAgoISO } = require('../lib/sold-config');
```

- [ ] **Step 6: Insert the single-candidate confirmation tier**

In `matchOne`'s apartment branch, insert the tier **immediately after** `const aptDeltas = deltasFor(record, feeChosen);` (currently line 334) and **before** `const adj = adjudicatePair({` (currently line 335):

```js
  const aptDeltas = deltasFor(record, feeChosen);

  // 4a) SINGLE-CANDIDATE CONFIRMATION TIER (before adjudicatePair). With exactly one
  //     same-address Hemnet candidate whose living-area and sold-price agree, there is
  //     no OTHER unit to confuse it with, so the unit-level fee gate adds no safety —
  //     confirm the match. Fee and rooms only VETO (present-on-both-and-contradicting),
  //     never block on missing data. Mirrors the HOUSE address-key shortcut (~line 279).
  //     evidence is built inline here: the adjudicator's `aptEv` is defined further down
  //     (after this early return), so it is NOT in scope yet.
  const areaOk  = aptDeltas.area_pct_diff  != null && aptDeltas.area_pct_diff  <= AREA_AGREE_PCT;
  const priceOk = aptDeltas.price_pct_diff != null && aptDeltas.price_pct_diff <= PRICE_AGREE_PCT;
  const addrOk  = aptDeltas.address_match === true;
  const feeContradicts = booliRent != null && feeChosen.fee != null
    && Math.abs(feeChosen.fee - booliRent) / booliRent > FEE_AGREE_PCT;
  const roomsContradict = record.rooms != null && feeChosen.rooms != null
    && Number(record.rooms) !== Number(feeChosen.rooms);
  if (cands.length === 1 && addrOk && areaOk && priceOk && !feeContradicts && !roomsContradict) {
    await upsertHemnetSold(client, feeChosen); // D-07
    return await persistMapped(client, record, 'matched', 'single_candidate_confirmed',
      feeChosen, aptDeltas, {
        source: 'single-candidate-confirmed',
        reason: `single candidate; area Δ${(aptDeltas.area_pct_diff * 100).toFixed(1)}% price Δ${(aptDeltas.price_pct_diff * 100).toFixed(1)}%`,
        addr_candidates: cands.length,
        single_candidate: true,
        fee_checked: booliRent != null && feeChosen.fee != null,
        rooms_checked: record.rooms != null && feeChosen.rooms != null,
        fee: { booli_rent: booliRent, hemnet_fee: feeChosen.fee != null ? feeChosen.fee : null },
      }, segKey, minSoldDate, maxSoldDate, feeChosen);
  }

  const adj = adjudicatePair({
```

- [ ] **Step 7: Run the smoke to verify all tests pass**

Run: `SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke`
Expected: PASS — `smoke: N pass, 0 fail`, exit 0. Confirm the previously-passing HOUSE and bridge tests (1, 2, 3, 6, 7, 8, 9) still pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/sold-match-run.js
git commit -m "feat(sold-match): single-candidate apartment confirmation tier

One same-address Hemnet candidate with agreeing area+price now confirms as
matched/single_candidate_confirmed without a fee cross-check; fee/rooms only
veto when present-on-both-and-contradicting. Mirrors the HOUSE address-key
shortcut. Fixes over-conservative apartment uncertains."
```

---

## Task 3: Backfill migration for existing `uncertain` apartment rows

**Files:**
- Create: `migrate-sold-backfill-single-candidate.js` (predicate + dry-run-by-default driver + inline `--smoke`)

**Interfaces:**
- Consumes: `FEE_AGREE_PCT`, `AREA_AGREE_PCT`, `PRICE_AGREE_PCT` from `lib/sold-config.js`; `createClient` from `./db`; the `sold_match` table's `verdict`, `match_method`, `evidence` (JSONB), `adjudicated_at` columns; `evidence.deltas.{address_match, area_pct_diff, price_pct_diff}`, `evidence.addr_candidates`, `evidence.fee.{booli_rent, hemnet_fee}`.
- Produces: exported `qualifiesForBackfill(evidence, cfg)` → Boolean, and `BACKFILL_UPDATE_SQL` (String). CLI: dry-run preview by default; `--apply` performs the transactional write.

### Design notes

- **House-safe by construction — no family filter needed.** The predicate requires a *single* same-address candidate with `area_pct_diff ≤ 0.07` and `price_pct_diff ≤ 0.05`. The HOUSE branch (`sold-match-run.js:279`) already auto-matches exactly that case, so a house satisfying this predicate can never be `uncertain`. Selecting all `uncertain` rows and relying on the predicate therefore catches every qualifying apartment while provably excluding houses — and avoids depending on `booli_sold.family` being populated on legacy rows.
- **Rooms veto skipped on backfill:** room counts are not stored in `sold_match.evidence`. Address + area + price already agree, so this is acceptable (documented in the spec §Backfill).
- **Known limitation:** `uncertain` rows never stored the candidate slug, so backfilled rows keep `matched_hemnet_slug = NULL` — fine for the count (chart/report read only `verdict`), but no clickable Hemnet link on those historical rows. Printed in the output.
- **node-postgres returns JSONB as a parsed JS object**, so `row.evidence` is already an object; the predicate still guards for a string just in case (`typeof === 'string' → JSON.parse`).

- [ ] **Step 1: Create the file with the predicate, driver, and a failing `--smoke`**

Create `migrate-sold-backfill-single-candidate.js` with the full content below:

```js
'use strict';
// migrate-sold-backfill-single-candidate.js — one-off, idempotent, transactional.
//
// Re-evaluates the STORED evidence on current `uncertain` sold_match rows and flips
// the ones that satisfy the single-candidate apartment confirmation rule to `matched`
// (match_method='single_candidate_confirmed_backfill'). NO scraping — reads only the
// evidence JSONB already persisted on each row.
//
// House-safe WITHOUT a family filter: the predicate requires a single same-address
// candidate with agreeing area (<=7%) + price (<=5%); the HOUSE branch of
// scripts/sold-match-run.js already auto-matches that case, so such a row can only be
// an apartment. Rooms are not in stored evidence → the rooms veto is skipped here
// (address+area+price already agree; acceptable per the design spec).
//
// DRY-RUN BY DEFAULT (read-only preview + count). Pass --apply to perform the write.
// Backfilled rows keep matched_hemnet_slug=NULL (uncertain rows never stored the slug)
// — fine for the count; no clickable Hemnet link on those historical rows.
//
//   node migrate-sold-backfill-single-candidate.js            # dry-run preview
//   node migrate-sold-backfill-single-candidate.js --apply    # transactional write
//   node migrate-sold-backfill-single-candidate.js --smoke     # offline predicate self-test

const { createClient } = require('./db');
const { AREA_AGREE_PCT, PRICE_AGREE_PCT, FEE_AGREE_PCT } = require('./lib/sold-config');

const CFG = { AREA_AGREE_PCT, PRICE_AGREE_PCT, FEE_AGREE_PCT };

// Idempotent by the `verdict='uncertain'` guard: a second run finds the flipped rows
// already 'matched' and updates zero of them.
const BACKFILL_UPDATE_SQL =
  `UPDATE sold_match
      SET verdict = 'matched',
          match_method = 'single_candidate_confirmed_backfill',
          adjudicated_at = NOW()
    WHERE booli_id = ANY($1) AND verdict = 'uncertain'`;

// qualifiesForBackfill — the single-candidate predicate over stored evidence.
// Mirrors the live tier (scripts/sold-match-run.js) minus the rooms veto (rooms are
// not stored in evidence). Returns true iff: exactly one address candidate, address
// matched, area+price within tolerance, and NOT (fee present on both AND gap > tol).
function qualifiesForBackfill(evidence, cfg) {
  const ev = typeof evidence === 'string' ? safeParse(evidence) : evidence;
  if (!ev) return false;
  const d = ev.deltas || {};
  const fee = ev.fee || {};
  const single = Number(ev.addr_candidates) === 1;
  const addrOk = d.address_match === true;
  const areaOk = d.area_pct_diff != null && d.area_pct_diff <= cfg.AREA_AGREE_PCT;
  const priceOk = d.price_pct_diff != null && d.price_pct_diff <= cfg.PRICE_AGREE_PCT;
  const br = fee.booli_rent, hf = fee.hemnet_fee;
  const feeContradicts = br != null && hf != null && Math.abs(hf - br) / br > cfg.FEE_AGREE_PCT;
  return single && addrOk && areaOk && priceOk && !feeContradicts;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}

async function run({ apply }) {
  const client = createClient();
  await client.connect();
  try {
    const before = await client.query(
      `SELECT verdict, COUNT(*)::int AS n FROM sold_match GROUP BY verdict ORDER BY verdict`,
    );
    console.log('=== BEFORE (verdict counts) ===');
    console.table(before.rows, ['verdict', 'n']);

    const rows = (await client.query(
      `SELECT booli_id, evidence FROM sold_match WHERE verdict = 'uncertain'`,
    )).rows;

    const qualifying = rows.filter((r) => qualifiesForBackfill(r.evidence, CFG)).map((r) => r.booli_id);
    console.log(`uncertain rows scanned: ${rows.length}; qualifying (single-candidate, area+price agree, fee not contradicting): ${qualifying.length}`);
    console.log('NOTE: backfilled rows keep matched_hemnet_slug=NULL (no clickable Hemnet link on these historical rows).');

    if (!apply) {
      console.log('DRY RUN — no rows written. Re-run with --apply (after approval) to perform the flip.');
      return;
    }

    await client.query('BEGIN');
    const upd = await client.query(BACKFILL_UPDATE_SQL, [qualifying]);
    await client.query('COMMIT');
    console.log(`Committed. ${upd.rowCount} rows flipped uncertain -> matched (single_candidate_confirmed_backfill).`);

    const after = await client.query(
      `SELECT verdict, COUNT(*)::int AS n FROM sold_match GROUP BY verdict ORDER BY verdict`,
    );
    console.log('=== AFTER (verdict counts) ===');
    console.table(after.rows, ['verdict', 'n']);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

module.exports = { qualifiesForBackfill, BACKFILL_UPDATE_SQL };

if (require.main === module) {
  if (process.argv.includes('--smoke')) {
    runSmoke();
  } else {
    const apply = process.argv.includes('--apply');
    run({ apply })
      .then(() => process.exit(0))
      .catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
  }
}

function runSmoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  const cfg = CFG;
  const base = () => ({
    addr_candidates: 1,
    deltas: { address_match: true, area_pct_diff: 0.02, price_pct_diff: 0.01 },
    fee: { booli_rent: null, hemnet_fee: null },
  });

  check('qualifying: single candidate, agree, fee absent → true', () => {
    assert.strictEqual(qualifiesForBackfill(base(), cfg), true);
  });
  check('qualifying: fee present on both & within 5% → true', () => {
    const ev = base(); ev.fee = { booli_rent: 5000, hemnet_fee: 4900 }; // 2%
    assert.strictEqual(qualifiesForBackfill(ev, cfg), true);
  });
  check('reject: fee present on both & differs >5% → false', () => {
    const ev = base(); ev.fee = { booli_rent: 4000, hemnet_fee: 5000 }; // 25%
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: multi-candidate (addr_candidates=2) → false', () => {
    const ev = base(); ev.addr_candidates = 2;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: address_match not true → false', () => {
    const ev = base(); ev.deltas.address_match = null;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: area disagrees → false', () => {
    const ev = base(); ev.deltas.area_pct_diff = 0.3;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: price disagrees → false', () => {
    const ev = base(); ev.deltas.price_pct_diff = 0.2;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: area_pct_diff missing (null) → false', () => {
    const ev = base(); ev.deltas.area_pct_diff = null;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('accepts a JSON string evidence (parses)', () => {
    assert.strictEqual(qualifiesForBackfill(JSON.stringify(base()), cfg), true);
  });
  check('null/garbage evidence → false, no throw', () => {
    assert.strictEqual(qualifiesForBackfill(null, cfg), false);
    assert.strictEqual(qualifiesForBackfill('not json', cfg), false);
  });
  check('idempotency: UPDATE SQL guards on verdict = uncertain', () => {
    assert.ok(/verdict\s*=\s*'uncertain'/.test(BACKFILL_UPDATE_SQL),
      'UPDATE must guard WHERE verdict = uncertain so a re-run is a no-op');
    assert.ok(/booli_id\s*=\s*ANY\(\$1\)/.test(BACKFILL_UPDATE_SQL),
      'UPDATE must target the qualifying booli_ids via ANY($1)');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run the smoke to verify it passes**

Run: `node migrate-sold-backfill-single-candidate.js --smoke`
Expected: PASS — `smoke: 11 pass, 0 fail`, exit 0.

> This is the file's first version, so its `--smoke` is authored to pass immediately (the predicate is written alongside its tests). The failing-first discipline was exercised on the *behavioral* code in Tasks 1-2; here the predicate and its self-test ship together, which is the repo's established migration idiom.

- [ ] **Step 3: Commit**

```bash
git add migrate-sold-backfill-single-candidate.js
git commit -m "feat(sold-match): dry-run backfill for single-candidate uncertain apartments

Re-evaluates stored evidence on uncertain rows and flips single-candidate,
area+price-agreeing, non-fee-contradicting rows to matched. Dry-run by default;
--apply performs the transactional, idempotent write. No scraping."
```

---

## Task 4: Prod dry-run, approval gate, deploy, and apply (verification — STOP for approval)

**This task performs prod DB reads and (only after approval) a prod write. Do NOT run `--apply` without Julian's explicit go-ahead for that run.**

- [ ] **Step 1: Run all three offline smokes together (regression gate)**

```bash
node lib/sold-config.js --smoke
SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js --smoke
node migrate-sold-backfill-single-candidate.js --smoke
```
Expected: all three print `smoke: N pass, 0 fail` and exit 0.

- [ ] **Step 2: Dry-run the backfill against prod (READ-ONLY) and report the count**

Run (local, against the prod DB — read-only, no `--apply`):

```bash
node migrate-sold-backfill-single-candidate.js
```

Report to Julian: the `BEFORE` verdict counts, the "uncertain rows scanned" and "qualifying" numbers. Expected: **~72 of ~131** apartment uncertains qualify (the spec's evidence figure; the scanned total may exceed 131 because the DB `uncertain` set can include the excluded W12 pilot cohort — the weekly report filters W12 out of the denominator regardless, so flipping any W12 rows does not move the headline). If the qualifying count is wildly off (e.g. 0, or > the total uncertain apartments), STOP and investigate the evidence shape before proposing the write.

- [ ] **Step 3: Get explicit approval for the write**

Present the dry-run count and wait for Julian's go-ahead. Do not proceed to `--apply` without it.

- [ ] **Step 4: Deploy the code to the droplet (git pull), then apply the backfill**

After approval, deploy per the standard process (`git pull` on the cohort-tracker droplet — see project deploy notes), then run the write **once**:

```bash
node migrate-sold-backfill-single-candidate.js --apply
```

Report the `Committed. N rows flipped` line and the `AFTER` verdict counts. Confirm `N` equals the dry-run qualifying count.

- [ ] **Step 5: Confirm idempotency (optional, safe)**

Re-run the dry-run (or `--apply` again) — the qualifying set is now `matched`, so the guarded UPDATE touches **0** rows. Expected: `qualifying: 0` on the dry-run (flipped rows are no longer `uncertain`), or `Committed. 0 rows flipped` on a second `--apply`.

- [ ] **Step 6: Record the definitional change date**

The headline "Matched on Hemnet %" steps up on this date by definition (rule + backfill), not because the market moved. This is recorded by the spec (`docs/superpowers/specs/2026-07-07-sold-match-single-candidate-apartment-design.md`) and the Task-2 commit. No code change required; note the date (2026-07-07) when interpreting the trend chart step. The new `match_method` values (`single_candidate_confirmed`, `single_candidate_confirmed_backfill`) let the report optionally show "of which X% via the single-candidate rule" later — out of scope here.

---

## Out of scope (from the spec)

- Multi-candidate Hemnet-detail-fetch escalation (separate change).
- Any change to the HOUSE branch or the shared `adjudicatePair`.
- Reporting-layer changes beyond the optional provenance annotation.

---

## Self-Review

**Spec coverage:**
- Component 1 (the rule) → Task 2. Fee veto, rooms veto, thresholds, `single_candidate_confirmed` method, slug persistence — all covered, with exact field names verified against `computeDeltas` (`address_match`/`area_pct_diff`/`price_pct_diff`), `cardBrief` (`.slug`/`.fee`/`.rooms`), and `booliRent`/`record.rooms`.
- Component 2 (`FEE_AGREE_PCT`) → Task 1.
- Component 3 (backfill, dry-run, idempotent, transactional) → Task 3, with the prod dry-run/apply gated in Task 4.
- Component 4 (interpretation guard / change date) → Task 4 Step 6.
- Spec TDD list: fee absent → matched (test 5); fee within 5% → matched (test 4); fee differs >5% → uncertain (5c); rooms differ → uncertain (5d); 2+ candidates → unchanged (5b matched / 5f uncertain); area/price disagree → unchanged (5e); slug persisted (tests 4 & 5). Backfill: qualifying→flipped, fee-gap/multi-candidate left uncertain, idempotency — all in Task 3 `--smoke`.

**Deviation from the spec's pseudocode (intentional, documented in Task 2 Step 6):** the spec's evidence example spreads `...aptEv`, but `aptEv` is defined *after* the tier's early-return point, so it is not in scope; the tier builds its evidence object inline instead. Same fields, correct scoping.

**Type consistency:** `feeChosen` carries `.fee`/`.rooms`/`.slug` (confirmed via `cardBrief`/`hcard`); `aptDeltas` carries `.address_match`/`.area_pct_diff`/`.price_pct_diff` (confirmed via `computeDeltas`); `persistMapped(client, record, verdict, matchMethod, matchedCard, deltas, extraEvidence, segKey, minSoldDate, maxSoldDate, slugCard)` signature matches the call. `qualifiesForBackfill(evidence, cfg)` and `BACKFILL_UPDATE_SQL` names are consistent between the module, its `--smoke`, and Task 4.
