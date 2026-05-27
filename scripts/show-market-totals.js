#!/usr/bin/env node
/**
 * show-market-totals.js — read-only diagnostic for the Phase 11 market_totals table.
 *
 * Prints the last 7 days of captured rows (hemnet/booli × till_salu/kommande) plus a
 * one-line day-coverage summary so you can eyeball the SC-5 soak for missing days.
 *
 * Usage on the droplet (no pasting of logic — just):
 *   git pull && node scripts/show-market-totals.js
 *
 * Pass a day count to widen the window: node scripts/show-market-totals.js 30
 */
const { createClient } = require('../db');

const days = Math.max(1, parseInt(process.argv[2], 10) || 7);

(async () => {
  const c = createClient();
  await c.connect();
  const { rows } = await c.query(
    `SELECT to_char(day, 'YYYY-MM-DD')                                  AS day,
            site,
            segment,
            total,
            to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z' AS fetched_utc
       FROM market_totals
      WHERE day >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
      ORDER BY day DESC, site, segment`,
    [days]
  );

  if (rows.length === 0) {
    console.log(`No market_totals rows in the last ${days} day(s).`);
  } else {
    console.table(rows);
    const distinctDays = [...new Set(rows.map((r) => r.day))];
    console.log(
      `\n${rows.length} rows across ${distinctDays.length} day(s) ` +
        `[${distinctDays.join(', ')}] — expect 4 rows/day.`
    );
  }

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
