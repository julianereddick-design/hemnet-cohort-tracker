// lib/sold-store.js
//
// Persist layer for the Phase 16 sold-match schema (DB-02). Client-first upsert
// functions for the three sold-side tables created by migrate-sold-phase16.js:
//   - booli_sold  (UNIQUE booli_id)    via upsertBooliSold
//   - hemnet_sold (UNIQUE hemnet_slug) via upsertHemnetSold
//   - sold_match  (UNIQUE booli_id)    via upsertSoldVerdict (+ D-02 gate)
//
// Every exported function takes a connected pg Client as its first argument.
// No top-level DB connection is opened here (keeps the offline --smoke DB-free).
// All queries use parameterised $1,$2,... placeholders — no string interpolation.
//
// Idempotency (DB-03): every upsert is INSERT ... ON CONFLICT (<stable_key>) DO
// UPDATE SET col = EXCLUDED.col, so re-running the persist pass refreshes enriched
// fields and yields zero duplicate rows (one row per sold record — D-01).
//
// Usage:
//   const { upsertBooliSold, upsertHemnetSold, upsertSoldVerdict,
//           persistVerdictForRecord } = require('./lib/sold-store');
//   node lib/sold-store.js --smoke

'use strict';

const { isTitleTransfer } = require('./sold-config');

// upsertBooliSold: one row per booli_id (D-01). 28 data columns in the fixed order
// of the migrate-sold-phase16.js DDL. ON CONFLICT (booli_id) DO UPDATE refreshes
// every enriched column from EXCLUDED + bumps updated_at, so a re-fetch (e.g. a
// detail-enriched pass over a card-only row) converges without duplicating (DB-03).
// booli_id is the only required value; every optional field is null-coalesced.
async function upsertBooliSold(client, row) {
  await client.query(
    `INSERT INTO booli_sold (
       booli_id, residence_url, residence_id, street_address, object_type, sold_price,
       sold_date, sold_price_type, is_title_transfer, municipality, descriptive_area,
       living_area, additional_area, plot_area, rooms, floor, lat, long, rent,
       operating_cost, construction_year, agent_id, agency_id, tenure_form,
       sold_in_advance, segment, family, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27,$28)
     ON CONFLICT (booli_id) DO UPDATE SET
       residence_url=EXCLUDED.residence_url, residence_id=EXCLUDED.residence_id,
       street_address=EXCLUDED.street_address, object_type=EXCLUDED.object_type,
       sold_price=EXCLUDED.sold_price, sold_date=EXCLUDED.sold_date,
       sold_price_type=EXCLUDED.sold_price_type, is_title_transfer=EXCLUDED.is_title_transfer,
       municipality=EXCLUDED.municipality, descriptive_area=EXCLUDED.descriptive_area,
       living_area=EXCLUDED.living_area, additional_area=EXCLUDED.additional_area,
       plot_area=EXCLUDED.plot_area, rooms=EXCLUDED.rooms, floor=EXCLUDED.floor,
       lat=EXCLUDED.lat, long=EXCLUDED.long, rent=EXCLUDED.rent,
       operating_cost=EXCLUDED.operating_cost, construction_year=EXCLUDED.construction_year,
       agent_id=EXCLUDED.agent_id, agency_id=EXCLUDED.agency_id,
       tenure_form=EXCLUDED.tenure_form, sold_in_advance=EXCLUDED.sold_in_advance,
       segment=EXCLUDED.segment, family=EXCLUDED.family, scraped_at=EXCLUDED.scraped_at,
       updated_at=NOW()`,
    [
      row.booli_id, row.residence_url ?? null, row.residence_id ?? null,
      row.street_address ?? null, row.object_type ?? null, row.sold_price ?? null,
      row.sold_date ?? null, row.sold_price_type ?? null, row.is_title_transfer ?? null,
      row.municipality ?? null, row.descriptive_area ?? null, row.living_area ?? null,
      row.additional_area ?? null, row.plot_area ?? null, row.rooms ?? null,
      row.floor ?? null, row.lat ?? null, row.long ?? null, row.rent ?? null,
      row.operating_cost ?? null, row.construction_year ?? null, row.agent_id ?? null,
      row.agency_id ?? null, row.tenure_form ?? null, row.sold_in_advance ?? null,
      row.segment ?? null, row.family ?? null, row.scraped_at ?? null,
    ]
  );
}

// upsertHemnetSold: one row per hemnet_slug. The parser emits `slug`; the column is
// `hemnet_slug` (D-01 rename). 18 columns in the DDL fixed order. ON CONFLICT
// (hemnet_slug) DO UPDATE refreshes every column from EXCLUDED + updated_at.
async function upsertHemnetSold(client, row) {
  await client.query(
    `INSERT INTO hemnet_sold (
       hemnet_slug, card_id, listing_id, detail_url, street_address, sold_at,
       sold_at_label, asking_price, final_price, living_area, rooms, fee,
       housing_form, location_description, broker_name, broker_agency, lat, long)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (hemnet_slug) DO UPDATE SET
       card_id=EXCLUDED.card_id, listing_id=EXCLUDED.listing_id,
       detail_url=EXCLUDED.detail_url, street_address=EXCLUDED.street_address,
       sold_at=EXCLUDED.sold_at, sold_at_label=EXCLUDED.sold_at_label,
       asking_price=EXCLUDED.asking_price, final_price=EXCLUDED.final_price,
       living_area=EXCLUDED.living_area, rooms=EXCLUDED.rooms, fee=EXCLUDED.fee,
       housing_form=EXCLUDED.housing_form, location_description=EXCLUDED.location_description,
       broker_name=EXCLUDED.broker_name, broker_agency=EXCLUDED.broker_agency,
       lat=EXCLUDED.lat, long=EXCLUDED.long, updated_at=NOW()`,
    [
      row.slug ?? null, row.card_id ?? null, row.listing_id ?? null,
      row.detail_url ?? null, row.street_address ?? null, row.sold_at ?? null,
      row.sold_at_label ?? null, row.asking_price ?? null, row.final_price ?? null,
      row.living_area ?? null, row.rooms ?? null, row.fee ?? null,
      row.housing_form ?? null, row.location_description ?? null, row.broker_name ?? null,
      row.broker_agency ?? null, row.lat ?? null, row.long ?? null,
    ]
  );
}

module.exports = { upsertBooliSold, upsertHemnetSold };
