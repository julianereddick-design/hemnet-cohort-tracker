# Stage 0 recon — VERDICT: PASS (2026-06-16)

Booli-sold → Hemnet-sold matching feasibility spike. Schema validated live (forced
through Oxylabs; raw dumps in `recon/`).

## Booli sold (seed source)
- URL: `https://www.booli.se/slutpriser?areaIds=<id>&objectType=<Lägenhet|Hus>` (param is
  **plural `areaIds`**; singular `areaId` is ignored → defaults to national 77104).
- Search node: `ROOT_QUERY.searchSold(...)` → `result[]` refs, `totalCount`, `pages` (~35/page).
- Card typename `SoldProperty`: `streetAddress`, `objectType`, `soldPrice.raw`, `soldDate`,
  `soldPriceType`, `location.region.municipalityName`, `descriptiveAreaName`, `url`
  (`/bostad/<residenceId>`), `displayAttributes.dataPoints` (living area, rooms, floor), lat/long.
- **Title-transfer signal = `soldPriceType`.** Market = {`Slutpris`, `Sista bud`}; everything
  else (`Lagfart`, and any Gåva/Arv/Byte subtypes) = title transfer. Confirmed: Täby villa feed
  showed `{Slutpris, Sista bud, Lagfart}`; Stockholm apartment feed showed no Lagfart — matches
  the brief (house feed is raw lagfarter, apartment feed is not).
- Broker: NOT on the card; **on the detail page** (`/bostad/<id>` → `agentId`/`agencyId`, plus
  `rent` (fee), `floor`, `images`) for the bypass classification + dHash escalation.

## Hemnet sold (lookup target)
- URL: `https://www.hemnet.se/salda?location_ids[]=<id>&price_min=&price_max=&rooms_min=&rooms_max=&item_types[]=<token>`
  — **`/salda` accepts the SAME narrowed filters as `/bostader`** (confirmed via inputSearch echo).
- Search node: `ROOT_QUERY.searchSales(...)` → `cards[]` refs, `total`.
- Card typename `SaleCard` is rich enough to match WITHOUT a detail fetch: `streetAddress`,
  `soldAt` (unix), `finalPrice`, `askingPrice`, `livingArea`, `rooms`, `fee`, `housingForm`,
  `slug` (→ `/salda/<slug>` detail), `brokerName`, `brokerAgencyName`, coordinates.

## Resolved area IDs
| Segment | Booli areaIds | Booli objectType | Hemnet location_id | Hemnet item_type |
|---|---|---|---|---|
| Stockholm apartments | 1 | Lägenhet | 18031 | bostadsratt |
| Täby houses | 20 | Hus | 17793 | (per-record via booliObjectTypeToHemnet) |

## Transport
Forced Oxylabs confirmed (`oxylabsCallCount`>0, `directSuccessCount`==0). Global spend ceiling
`MAX_OXY_CALLS=4000`, persisted in `cache/_spend.json`; all fetches disk-cached.

## Environment notes
- DB unreachable (doctl auth expired) → spike runs **DB-free** (seed/results/checkpoints as
  JSON under `verf-soldspike/`).
- `ANTHROPIC_API_KEY` absent → **vision off**; adjudication uses fields → dHash → UNCERTAIN.
