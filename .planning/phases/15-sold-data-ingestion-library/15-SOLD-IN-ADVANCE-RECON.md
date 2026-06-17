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

## D-01 Disposition: Escalate Detail — All Records EXCEPT Deed Transfers

The `sold_in_advance` signal is **detail-page-only**. Per D-01, the all-records detail escalation has been operator-approved with the following scope optimisation:

> **Policy (2026-06-17):** Fetch a Booli detail page (`/bostad/<residenceId>`) for every sold record EXCEPT deed transfers. Gate the per-record detail fetch on `!isTitleTransfer` — skip records where `soldPriceType === "Lagfart"` (isTitleTransfer flag is true). Deed transfers are excluded from matching and retained card-only in the DB; a detail call on them is wasted spend. Genuine (non-deed-transfer) sales get the full detail page → `soldAsUpcomingSale` + full enrichment (broker, operating cost, construction year, tenure form). This reduces the ~2× escalation cost by the deed-transfer share.

### Plan 04 handoff instruction (UNAMBIGUOUS)

Plan 04's `booli-sold.js` fetch loop MUST implement the following logic exactly:

1. **Per record — gate the detail fetch:**
   ```js
   const isTitleTransfer = record.soldPriceType === 'Lagfart'; // or record.isTitleTransfer === true
   if (!isTitleTransfer) {
     // fetch /bostad/<residenceId> detail page
     const detail = await fetchBooliDetail(record.residenceId, ...);
     record.sold_in_advance = Boolean(detail?.soldAsUpcomingSale) || null;
     // also capture: broker, operatingCost, constructionYear, tenureForm from detail
   } else {
     // deed transfer — card-only, no detail fetch
     record.sold_in_advance = null;
   }
   ```

2. **Field to read on the detail `SoldProperty` node:** `sp.soldAsUpcomingSale` (boolean)
   - Casting: `Boolean(sp.soldAsUpcomingSale)` — store as boolean or null
   - Only populated for records that received a detail fetch (i.e. `!isTitleTransfer`)

3. **Deed transfers:** retained in DB with `sold_in_advance = null` and `is_title_transfer = true`; EXCLUDED from the match pipeline but NOT dropped.

4. **`--detail-scope all` guard in `booli-sold.js`:** this guard is unlocked by the approval marker below. Plan 04's executor must assert the marker line is present before enabling the detail-fetch loop for all non-deed-transfer records.

---

## Checkpoint Marker (written by operator approval only)

escalate detail (spend confirmed)
