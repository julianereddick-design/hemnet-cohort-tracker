# Sold-match: single-candidate apartment confirmation rule

**Date:** 2026-07-07
**Status:** Approved design — ready for implementation plan
**Author:** Julian + Claude (brainstorming session)

## Problem

The sold-match pipeline (`scripts/sold-match-run.js`) classifies each Booli-sold apartment
against Hemnet as `matched` / `booli_only` / `uncertain`. The **apartment branch is
over-conservative**: it requires a unit-level fee cross-check to confirm a match, even when
there is exactly **one** Hemnet candidate whose address, living-area, and sold-price all
agree. With a single candidate there is no other unit to confuse it with, so the fee gate
adds no safety — it only vetoes good matches.

The house branch already handles this correctly (`sold-match-run.js:279`): a single candidate
with agreeing area + price is auto-matched (`match_method='address_key'`). Apartments have no
such tier.

### Evidence

- **72 of 131** current `uncertain` apartments (55%, W12 excluded) are single-candidate with
  `address_match=true`, `area_pct_diff ≤ 5%`, `price_pct_diff ≤ 5%` — held `uncertain` purely
  because the Hemnet fee was missing or differed by a rounding amount.
- Worked example — booli_id 6054481, **Kongahällagatan 51, Komarken, Kungälv**, 3 rooms, 78 m²,
  1,400,000 kr, Booli fee 6,381. Hemnet listing exists and is unambiguously the same flat
  (`https://www.hemnet.se/salda/lagenhet-3rum-komarken-kungalvs-kommun-kongahallagatan-51-2634462830644490718`).
  It was held `uncertain` because the Hemnet `/salda` **search card** carried no fee, and the
  pipeline never fetches the Hemnet detail page (only the Booli detail is fetched inline). So
  `hemnet_fee=null` → adjudicator could not confirm → `uncertain`.

### Impact

`uncertain` sits in the "Matched on Hemnet" denominator, so the headline rate (~77%) is a
**floor**. Reclassifying the ~72 near-certain matches raises it toward the true value.

## Root cause (code)

`scripts/sold-match-run.js`, apartment branch (~lines 304–358):
1. Fetch Booli detail inline → `booliRent` (the only fee we obtain).
2. Prefer a fee-exact Hemnet candidate; else `feeChosen = chosen`.
3. `adjudicatePair(...)` → `matched` only on `CONFIRMED_MATCH`, else `booli_only`/`uncertain`.

There is no single-candidate shortcut analogous to the house branch (`sold-match-run.js:279`).

## Decisions (locked)

1. **Fee handling:** fee *confirms*, absence does *not* block, a *large gap vetoes*. Specifically:
   match on the single-candidate tier when the fee is absent on either side OR present-on-both
   and within tolerance; if present-on-both and differing by more than tolerance → do NOT use
   the tier (fall through to the adjudicator → `uncertain`). The fee gap is the one real signal
   that a single candidate might be a different unit.
2. **Rooms veto (INCLUDED):** if room counts are present on both sides and differ, do NOT use
   the tier. Symmetric with the fee veto; only vetoes on present-and-contradicting, never on
   missing data. Cheap extra safety. *(Revisit if it proves noisy.)*
3. **Thresholds:** reuse `AREA_AGREE_PCT = 0.07` and `PRICE_AGREE_PCT = 0.05` (existing, in
   `lib/sold-config.js`). Add **`FEE_AGREE_PCT = 0.05`** (±5%) — tolerates the observed
   0.2–1.2% rounding drift while vetoing genuinely different units. *(Revisit; could tighten.)*
4. **Backfill the existing ~72 rows** from stored evidence — NO scraping (see §Backfill).
5. **Scope:** ship the single-candidate rule + backfill only. **Defer** the multi-candidate
   escalation (fetching the Hemnet detail page for the fee when 2+ candidates) to a separate
   change.

## Approach

Chosen: **add a single-candidate confirmation tier to the apartment branch**, mirroring the
house shortcut. Localized, unit-testable, does not touch shared code.

Rejected:
- Loosening `adjudicatePair` (`lib/spotcheck-adjudicate.js`) — shared with the live cohort
  spot-check; changing it risks the other pipeline.
- Post-processing `uncertain` rows in the report layer — hides the logic, doesn't fix the
  verdict at source, and the recheck drain wouldn't benefit.

## Design

### Component 1 — the rule (live matcher)

In the apartment branch of `scripts/sold-match-run.js`, **before** the `adjudicatePair` call,
insert a confirmation tier. Precondition + veto structure:

```
areaOk  = aptDeltas.area_pct_diff  != null && aptDeltas.area_pct_diff  <= AREA_AGREE_PCT
priceOk = aptDeltas.price_pct_diff != null && aptDeltas.price_pct_diff <= PRICE_AGREE_PCT
addrOk  = aptDeltas.address_match === true

feeContradicts   = booliRent != null && feeChosen.fee != null
                   && Math.abs(feeChosen.fee - booliRent) / booliRent > FEE_AGREE_PCT
roomsContradict  = record.rooms != null && feeChosen.rooms != null
                   && Number(record.rooms) !== Number(feeChosen.rooms)

if (cands.length === 1 && addrOk && areaOk && priceOk && !feeContradicts && !roomsContradict) {
  await upsertHemnetSold(client, feeChosen);
  return persistMapped(client, record, 'matched', 'single_candidate_confirmed',
    feeChosen, aptDeltas, { ...aptEv, single_candidate: true,
      fee_checked: (booliRent != null && feeChosen.fee != null),
      rooms_checked: (record.rooms != null && feeChosen.rooms != null) },
    segKey, minSoldDate, maxSoldDate, feeChosen);
}
```

- New `match_method='single_candidate_confirmed'` — distinct from `fee_exact` and `address_key`
  so we can report "of matches, X% via single-candidate rule".
- Stores the Hemnet slug (`feeChosen`), so live matches via this rule carry a clickable link.
- Confirm the exact field names during implementation: `aptDeltas.address_match`,
  candidate `.rooms`, `.fee`, `.slug` (via `cardBrief`). Adjust if the delta/card shape differs.

### Component 2 — new constant

`lib/sold-config.js`: add `FEE_AGREE_PCT = 0.05` next to `PRICE_AGREE_PCT` / `AREA_AGREE_PCT`,
export it, and add a smoke assertion (mirrors the existing threshold tests ~line 181).

### Component 3 — backfill (existing uncertain)

One-off, idempotent, transactional script (pattern: `migrate-sold-*.js`) that re-evaluates the
**stored evidence** on current `uncertain` apartments and flips qualifiers to `matched`.

The predicate reads from `sold_match.evidence` (already present on every uncertain row):
`addr_candidates == '1'`, `deltas.address_match == true`, `deltas.area_pct_diff <= AREA_AGREE_PCT`,
`deltas.price_pct_diff <= PRICE_AGREE_PCT`, and NOT (`fee.booli_rent` and `fee.hemnet_fee` both
present and differing > `FEE_AGREE_PCT`). (Rooms are not in stored evidence → rooms veto is
skipped on backfill; acceptable, area+price+address already agree.)

- Updates `verdict='matched'`, `match_method='single_candidate_confirmed_backfill'`,
  `adjudicated_at=now()`.
- **Known limitation:** uncertain rows never stored the candidate slug (`matched_card=null`),
  so backfilled rows get `matched_hemnet_slug=NULL` — fine for the count (chart/report only
  read `verdict`), but no clickable Hemnet link on those historical rows. Document in output.
- Idempotent (only touches `verdict='uncertain'`); transactional; prints before/after counts.
- **Dry-run mode** (or a separate read-only preview) to report the exact reclassification count
  before any write, for approval.

### Component 4 — interpretation guard

Backfill + rule cause historical cohorts' matched-% to **step up** on the change date — a
definitional change, not a market move. Actions:
- Record the change date (this spec + commit) so the trend chart step isn't misread.
- The new `match_method` values let the report optionally show "of which X% via single-candidate
  rule" for provenance. (Reporting annotation is optional, not required for this change.)

## Testing (TDD)

Unit (offline smoke, existing `--smoke` pattern in `scripts/sold-match-run.js`):
- single candidate + addr+area+price agree + **fee absent** → `matched`, method `single_candidate_confirmed`
- single candidate + agree + **fee present & within 5%** → `matched`
- single candidate + agree + **fee present & differs > 5%** → `uncertain` (tier skipped)
- single candidate + agree + **rooms differ** → `uncertain` (tier skipped)
- **2+ candidates** + agree → unchanged (adjudicator path)
- area or price disagree → unchanged
- matched row persists the Hemnet slug (not null)

Backfill:
- stored-evidence fixtures: qualifying → flipped; fee-gap/multi-candidate → left `uncertain`
- idempotent (second run is a no-op)

Verification:
- Run `--smoke` for the matcher and the backfill.
- **Dry-run the backfill on prod (read-only)** and report the before/after count (expect ~72 of
  131 apartments flip). Get approval before the write.
- Deploy code (git pull on droplet), then run the backfill (prod DB write — needs go-ahead).

## Out of scope (explicit)

- Multi-candidate Hemnet-detail-fetch escalation (separate change).
- Any change to the house branch or the shared `adjudicatePair`.
- Reporting-layer changes beyond the optional provenance annotation.

## Files touched

- `scripts/sold-match-run.js` — the rule + smoke tests
- `lib/sold-config.js` — `FEE_AGREE_PCT` + smoke assertion
- `migrate-sold-backfill-single-candidate.js` (new) — backfill + dry-run
- (no report/chart code changes required)
