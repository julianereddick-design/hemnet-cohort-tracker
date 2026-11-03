'use strict';
// migrate-weekly-new-listings.js — the weekly new-listings series behind Glenn's MASTER
// workbook (DATA MASTER\WEEKLY PROPERTIES\MASTER_updated_*.xlsx), idempotent.
// Run manually: node migrate-weekly-new-listings.js
//
// One row per (week_start, area, market, series):
//   week_start  Monday (Swedish time) of the Mon–Sun week
//   area        sweden | stockholm (Stockholms län) | vg (Västra Götalands län)
//   market      tot (all new pre-owned listings) | fs (new straight to for sale);
//               pre-market = tot − fs, as in the workbook
//   series      master            the workbook series: Hemnet's nytillkomna up to wk 12 Oct
//                                 2026, then PAID new listings from our ad registry
//               hemnet_public     Hemnet's nytillkomna as it stands today (refetched weekly;
//                                 counts free + aggregated ads from wk 19 Oct 2026)
//               registry_all      our count of all new pre-owned ads (checked against
//                                 hemnet_public every week)
//               registry_paid     our count of new paid ads (brand-new ids)
//               registry_upgrades older free/aggregated ads that became paid that week
// See lib/weekly-new-listings.js and docs/handover/CHANGELOG.md, 2026-11-03.
const { createClient } = require('./db');

const CREATE = `
  CREATE TABLE IF NOT EXISTS hemnet_weekly_new_listings (
    week_start   DATE        NOT NULL,
    area         TEXT        NOT NULL,
    market       TEXT        NOT NULL,
    series       TEXT        NOT NULL,
    value        INTEGER     NOT NULL,
    is_estimate  BOOLEAN     NOT NULL DEFAULT FALSE,
    note         TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (week_start, area, market, series)
  )`;

async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(CREATE);
    const r = await client.query(`SELECT count(*)::int AS n FROM hemnet_weekly_new_listings`);
    console.log(`hemnet_weekly_new_listings present (${r.rows[0].n} rows)`);
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
