# 15-SOLD-IN-ADVANCE-RECON.md
# D-04 Recon: Where Booli Encodes "Sold in Advance"

**Recon executed:** 2026-06-17 (offline-first, 0 live Oxylabs calls)
**Sources scanned:** verf-soldspike/recon/*.apollo.json, verf-soldspike/recon/booli-sold-detail-sample.json
**Spend:** 0 (all data from existing spike recon dumps)

---

## Finding: DETAIL FIELD

**Signal location:** Detail field — Booli `/bostad/<residenceId>` detail page only

**Exact Apollo path:** `SoldProperty.soldAsUpcomingSale` (boolean)

**Sample value:** `true` (from booli-sold-detail-sample.json, residenceId 2265068 / booliId 6107381)

### What was found

| Level | typename | Field | Present? | Sample value |
|-------|----------|-------|----------|-------------|
| Card (list page `/slutpriser`) | `SoldProperty` (35 records scanned) | `soldAsUpcomingSale` | NO | — |
| Card (list page `/slutpriser`) | `SoldProperty` (35 records scanned) | `upcomingSale` | NO | — |
| Detail page (`/bostad/<id>`) | `SoldProperty` | `soldAsUpcomingSale` | YES | `true` |

### Evidence

Card-level `SoldProperty` keys (from `/slutpriser` list Apollo state):
`__typename, amenities, booliId, daysActive, descriptiveAreaName, displayAttributes(...), id, images(...), latitude, listPrice, location, longitude, objectType, primaryImage, soldDate, soldPrice, soldPriceAbsoluteDiff, soldPricePercentageDiff, soldPriceType, streetAddress, url`

No `soldAsUpcomingSale` and no `upcomingSale` among the 35 card nodes in the list page Apollo state.

Detail-page `SoldProperty` additional fields (from `/bostad/<residenceId>` Apollo state):
`addressId, adTargetingProperties, agencyId, agentId, areas, breadcrumbs, buildingFloors, constructionYear, housingCoop, infoSections, livingArea, operatingCost, plotArea, priceInfo, primaryArea, propertyType, relatedSearchUrl, removed, rent, residenceId, rooms, salesOfResidence, **soldAsUpcomingSale**, soldSqmPrice, tenureForm, ...`

`soldAsUpcomingSale` is exclusively in the detail-page response. The keyword scan found it only in the `booli-sold-detail-sample.json` file (2 hits: the `adTargetingProperties` key entry `"upcomingSale"` and the boolean field `soldAsUpcomingSale: true`).

Note: The `Listing:<id>.upcomingSale` field found in the booli-slutpriser apollo dump is on **for-sale** `Listing` nodes that are cross-linked on the sold search page — these are NOT sold records. The `SoldProperty` card nodes have no analogous flag.

---

## D-01 Disposition: All-Records Detail Escalation Required

The `sold_in_advance` signal is **detail-page-only**. Per D-01:

> "If 'sold in advance' proves detail-only: escalating to fetch detail for all market records (which would also yield full enrichment everywhere) is allowed only after Julian re-confirms the spend."

### What this means for cost

The current D-01 default (Plan 04 without escalation) fetches detail pages **only for apartments within the fee window** — the one case where the `rent` field changes a match outcome. Under the default:

- Villas (Täby): card-only → `sold_in_advance` = `null` (D-03: best-effort, never block)
- Apartments (Stockholm): detail fetched for fee-window records → `soldAsUpcomingSale` captured for those records only

To capture `sold_in_advance` for ALL records (both villas and apartments outside the fee window), Plan 04 would need to issue a detail fetch for every Booli sold record — approximately **doubling the per-segment Oxylabs call count** relative to the apartment-only-detail default.

This is an operator spend decision (D-01, D-07). The agent does NOT escalate silently.

### Plan 04 handoff instruction

**If operator approves card-only default (no escalation):**
- Plan 04 reads `sold_in_advance` from `SoldProperty.soldAsUpcomingSale` on detail pages that are already fetched for fee-window apartments
- For all other records (villas, apartments outside fee window): set `sold_in_advance = null`
- Field to read: `sp.soldAsUpcomingSale` (boolean on the detail-page `SoldProperty` node)
- Casting: `Boolean(sp.soldAsUpcomingSale)` → store as boolean or null

**If operator approves all-records escalation:**
- Plan 04 fetches `/bostad/<residenceId>` for every Booli sold record (villa and apartment alike)
- Read `sp.soldAsUpcomingSale` from the detail `SoldProperty` node for every record
- The literal marker line that unlocks `--detail-scope all` in Plan 04 is written to this file ONLY after operator approval at the checkpoint — see below.

---

## Checkpoint Marker (written by operator approval only)

The line below is the approval marker for Plan 04's `--detail-scope all` guard.
It must NOT be written by the agent. It is appended ONLY after operator approval at the Plan 03 checkpoint.

[APPROVAL MARKER ABSENT — awaiting operator decision]
