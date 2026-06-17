'use strict';
// migrate-sold-phase16.js — sold-match schema (DB-01). Run manually: node migrate-sold-phase16.js
//
// Creates the entire sold-side schema, idempotently (each table guarded IF NOT EXISTS):
//   - booli_sold   : one row per Booli /slutpriser sold record (UNIQUE booli_id)
//   - hemnet_sold  : one row per Hemnet /salda sold record (UNIQUE hemnet_slug)
//   - sold_match   : verdict table — DESIGN-ONLY this phase, populated in Phase 17 (D-05)
//   - sold_spend   : atomic spend counter backing the D-03 DB-backed ceiling (CR-01)
//
// Column contracts for booli_sold / hemnet_sold are 1:1 with lib/sold-parse.js
// (parseBooliSoldCards + parseBooliSoldDetail; parseHemnetSaleCards). The parser
// field `slug` maps to column `hemnet_slug` per D-01.
const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();

  // booli_sold: union of parseBooliSoldCards (lib/sold-parse.js:65-81) +
  // parseBooliSoldDetail (lib/sold-parse.js:94-113). segment/family/scraped_at are
  // on the fetcher JSONL record (lib/sold-fetch-booli.js) so a row is self-describing.
  // is_title_transfer + sold_in_advance are nullable BOOLEAN (parsers emit null for
  // older records — D-02/D-04). updated_at backs the Plan 02 ON CONFLICT DO UPDATE refresh.
  await client.query(`
    CREATE TABLE IF NOT EXISTS booli_sold (
      id                SERIAL PRIMARY KEY,
      booli_id          BIGINT NOT NULL,
      residence_url     TEXT,
      residence_id      BIGINT,
      street_address    TEXT,
      object_type       TEXT,
      sold_price        NUMERIC,
      sold_date         DATE,
      sold_price_type   TEXT,
      is_title_transfer BOOLEAN,
      municipality      TEXT,
      descriptive_area  TEXT,
      living_area       NUMERIC,
      additional_area   NUMERIC,
      plot_area         NUMERIC,
      rooms             NUMERIC,
      floor             NUMERIC,
      lat               NUMERIC,
      long              NUMERIC,
      rent              NUMERIC,
      operating_cost    NUMERIC,
      construction_year INTEGER,
      agent_id          BIGINT,
      agency_id         BIGINT,
      tenure_form       TEXT,
      sold_in_advance   BOOLEAN,
      segment           TEXT,
      family            TEXT,
      scraped_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(booli_id)
    )
  `);
  console.log('Created table: booli_sold');

  // hemnet_sold: parseHemnetSaleCards (lib/sold-parse.js:137-156). D-01 naming:
  // parser field `slug` → column `hemnet_slug` (the UNIQUE key). sold_at is the epoch
  // integer the parser emits (Unix seconds) — BIGINT, not DATE; sold_at_label is the
  // human form.
  await client.query(`
    CREATE TABLE IF NOT EXISTS hemnet_sold (
      id                   SERIAL PRIMARY KEY,
      hemnet_slug          TEXT NOT NULL,
      card_id              TEXT,
      listing_id           BIGINT,
      detail_url           TEXT,
      street_address       TEXT,
      sold_at              BIGINT,
      sold_at_label        TEXT,
      asking_price         NUMERIC,
      final_price          NUMERIC,
      living_area          NUMERIC,
      rooms                NUMERIC,
      fee                  NUMERIC,
      housing_form         TEXT,
      location_description TEXT,
      broker_name          TEXT,
      broker_agency        TEXT,
      lat                  NUMERIC,
      long                 NUMERIC,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(hemnet_slug)
    )
  `);
  console.log('Created table: hemnet_sold');

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
