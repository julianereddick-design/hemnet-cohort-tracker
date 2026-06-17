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

  // sold_match: DESIGN-ONLY this phase — created empty, populated in Phase 17 (adjudicatePair). D-05.
  // Verdict vocabulary mirrors Phase-14 (verdict allowed: matched, booli_only, uncertain — kept loose,
  // no CHECK constraint, for Phase 17). match_method allowed: fee_exact, address_key.
  // matched_hemnet_slug is nullable: null for booli_only / uncertain — a first-class outcome
  // (the spike's ~36% genuine-non-Hemnet finding), NOT an error. evidence is JSONB for flexibility.
  await client.query(`
    CREATE TABLE IF NOT EXISTS sold_match (
      id                  SERIAL PRIMARY KEY,
      booli_id            BIGINT NOT NULL,
      matched_hemnet_slug TEXT,
      verdict             TEXT,
      match_method        TEXT,
      evidence            JSONB,
      segment             TEXT,
      window_start        DATE,
      window_end          DATE,
      adjudicated_at      TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(booli_id)
    )
  `);
  console.log('Created table: sold_match');

  // sold_spend: backs the D-03 DB atomic spend ceiling (closes CR-01). One row per logical
  // spend bucket, keyed by a stable text key so Phase 17's concurrent drivers share one counter.
  // Plan 03's atomic increment: UPDATE sold_spend SET calls = calls + 1, updated_at = NOW()
  //   WHERE spend_key = $1 AND calls < $2 RETURNING calls  (zero rows = ceiling hit).
  // Seeding: INSERT ... ON CONFLICT (spend_key) DO NOTHING — UNIQUE(spend_key) makes seed idempotent.
  await client.query(`
    CREATE TABLE IF NOT EXISTS sold_spend (
      id         SERIAL PRIMARY KEY,
      spend_key  TEXT NOT NULL,
      calls      INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(spend_key)
    )
  `);
  console.log('Created table: sold_spend');

  // Read-back verify (idiom from migrate-booli-listing-add-fields.js): confirm the four tables
  // exist after the run, so a re-run visibly reports the schema applied. Parameterized $1 — no
  // string interpolation.
  const check = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [['booli_sold', 'hemnet_sold', 'sold_match', 'sold_spend']]
  );
  console.log('Tables present:', check.rows.map(r => r.table_name).join(', '));

  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
