'use strict';

// list-w19-munis.js — Diagnostic: enumerates W19 cohort munis for harvester debugging.
//   Authored during Phase 8 VERF-04. Read-only DB query; safe to run anytime.

// Quick one-shot helper: list distinct Booli FS municipalities for the
// W19 (2026-05-04 .. 2026-05-10) target counties cohort window. Used to
// identify which munis are missing from lib/hemnet-locations.json so we
// can pre-seed them (D-29 cache-growth exception).
//
// Mirrors cohort-create.js:79-88 exactly except for the GROUP BY.
//
// Run from hemnet-cohort-tracker/:
//   node scripts/diagnostics/list-w19-munis.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('../../db');

const BOOLI_COUNTIES = [
  'Stockholms län',
  'Västra Götalands län',
  'Skåne län',
  'Uppsala län',
];

const WEEK_START = '2026-05-04';
const WEEK_END = '2026-05-10';

(async () => {
  const c = createClient();
  await c.connect();
  try {
    const res = await c.query(
      `SELECT municipality, county, COUNT(*)::int AS n
         FROM booli_listing
        WHERE is_active = true
          AND is_pre_market = false
          AND listed >= $1::date
          AND listed <= $2::date
          AND county = ANY($3)
        GROUP BY municipality, county
        ORDER BY county, municipality`,
      [WEEK_START, WEEK_END, BOOLI_COUNTIES],
    );

    console.log(`W19 (${WEEK_START}..${WEEK_END}) Booli FS muni distribution (target counties):`);
    let total = 0;
    for (const r of res.rows) {
      console.log(`  ${r.county.padEnd(22)} | ${(r.municipality || '(null)').padEnd(20)} | ${r.n}`);
      total += r.n;
    }
    console.log(`Total munis: ${res.rows.length} | Total rows: ${total}`);

    // Emit a JS array literal for easy copy
    console.log('\nDistinct muni names (JSON):');
    const names = res.rows.map((r) => r.municipality).filter((m) => m != null);
    console.log(JSON.stringify(names));
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
