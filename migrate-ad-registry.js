'use strict';
// migrate-ad-registry.js — creates the Hemnet ad registry tables (idempotent).
// Run manually: node migrate-ad-registry.js
//
// Why: Hemnet's sold pages carry no ad package, and since Oct 2026 Hemnet also shows free
// (MINIMAL) and aggregated ads. To tell whether a sold home was a PAID Hemnet ad we have to
// record each ad's package while it is live. Written by scripts/hemnet-ad-daily.js (newest
// ads, daily) and scripts/hemnet-ad-sweep.js (every live ad, weekly); read by sold-match.
// See lib/ad-registry.js and docs/handover/CHANGELOG.md, 2026-11-03.
//
//   hemnet_ad_registry         one row per Hemnet ad id: where it is, what it is now, and
//                              every package it has been seen with (packages_seen)
//   hemnet_ad_package_history  one row the first time an ad is seen and on every change of
//                              package or tier (for sale / coming soon)
//   hemnet_ad_sweep_run        one row per walk (daily / weekly), with its counts
const { createClient } = require('./db');

const CREATE_REGISTRY = `
  CREATE TABLE IF NOT EXISTS hemnet_ad_registry (
    hemnet_id         BIGINT      PRIMARY KEY,
    slug              TEXT,
    street_address    TEXT,
    location          TEXT,
    kommun            TEXT,
    housing_form      TEXT,
    asking_price      BIGINT,
    living_area       NUMERIC,
    rooms             NUMERIC,
    lat               DOUBLE PRECISION,
    long              DOUBLE PRECISION,
    broker_agency     TEXT,
    record_type       TEXT,
    new_construction  BOOLEAN,
    project_id        TEXT,
    package           TEXT,
    ad_class          TEXT        NOT NULL,
    tier              TEXT        NOT NULL,
    published_at      TIMESTAMPTZ,
    packages_seen     TEXT[]      NOT NULL DEFAULT '{}',
    first_paid_seen   DATE,
    first_seen        DATE        NOT NULL,
    last_seen         DATE        NOT NULL,
    gone_on           DATE,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

const CREATE_HISTORY = `
  CREATE TABLE IF NOT EXISTS hemnet_ad_package_history (
    id             BIGSERIAL   PRIMARY KEY,
    hemnet_id      BIGINT      NOT NULL,
    seen_on        DATE        NOT NULL,
    source         TEXT        NOT NULL,
    package        TEXT,
    tier           TEXT        NOT NULL,
    prior_package  TEXT,
    prior_tier     TEXT,
    published_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

const CREATE_RUN = `
  CREATE TABLE IF NOT EXISTS hemnet_ad_sweep_run (
    id              SERIAL      PRIMARY KEY,
    kind            TEXT        NOT NULL,
    run_date        DATE        NOT NULL,
    status          TEXT        NOT NULL,
    cards_seen      INTEGER     NOT NULL DEFAULT 0,
    distinct_ads    INTEGER     NOT NULL DEFAULT 0,
    headline_total  INTEGER,
    new_ads         INTEGER     NOT NULL DEFAULT 0,
    changed_ads     INTEGER     NOT NULL DEFAULT 0,
    upgrades        INTEGER     NOT NULL DEFAULT 0,
    gone_ads        INTEGER,
    pages           INTEGER     NOT NULL DEFAULT 0,
    ox_calls        INTEGER     NOT NULL DEFAULT 0,
    counts          JSONB,
    notes           TEXT,
    started_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS hemnet_ad_registry_addr ON hemnet_ad_registry (lower(street_address))`,
  `CREATE INDEX IF NOT EXISTS hemnet_ad_registry_live ON hemnet_ad_registry (gone_on, last_seen)`,
  `CREATE INDEX IF NOT EXISTS hemnet_ad_history_id ON hemnet_ad_package_history (hemnet_id, seen_on)`,
  `CREATE INDEX IF NOT EXISTS hemnet_ad_sweep_run_kind ON hemnet_ad_sweep_run (kind, run_date)`,
];

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE_REGISTRY);
    await client.query(CREATE_HISTORY);
    await client.query(CREATE_RUN);
    for (const sql of INDEXES) await client.query(sql);
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [['hemnet_ad_registry', 'hemnet_ad_package_history', 'hemnet_ad_sweep_run']]
    );
    console.log('Tables present:', check.rows.map(r => r.table_name).sort().join(', ') || '(none)');
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
