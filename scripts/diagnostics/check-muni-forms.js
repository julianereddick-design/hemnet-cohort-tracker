'use strict';

// check-muni-forms.js — Diagnostic: probes muni-name → fullName mapping via Hemnet detail pages.
//   Authored during Phase 8 VERF-04; the script that surfaced the genitive bug (now fixed in 8.5 LIBC-01).

// Quick diagnostic: check whether hemnet_listingv2 stores muni names in
// genitive form for the missing W19 munis.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('../../db');

const MISSING = [
  'Ängelholm','Åstorp','Båstad','Bjuv','Burlöv','Eslöv','Hässleholm',
  'Helsingborg','Höör','Klippan','Kristianstad','Lomma','Lund','Perstorp',
  'Simrishamn','Skurup','Staffanstorp','Svalöv','Trelleborg','Ystad',
  'Danderyd','Nykvarn','Nynäshamn','Österåker','Salem','Sollentuna',
  'Stockholm','Sundbyberg','Vaxholm','Enköping','Östhammar','Tierp',
  'Åmål','Bollebygd','Dals-Ed','Falköping','Göteborg','Grästorp','Gullspång',
  'Karlsborg','Kungälv','Lerum','Lidköping','Lilla Edet','Lysekil','Mariestad',
  'Mark','Mellerud','Mölndal','Stenungsund','Strömstad','Tanum','Tidaholm',
  'Tjörn','Trollhättan','Ulricehamn','Vänersborg',
];

(async () => {
  const c = createClient();
  await c.connect();
  try {
    // For each missing muni, try LIKE pattern in hemnet_listingv2 to find
    // a near match (genitive form etc).
    for (const m of MISSING) {
      const res = await c.query(
        `SELECT municipality, COUNT(*)::int AS n
           FROM hemnet_listingv2
          WHERE is_active = true
            AND municipality ILIKE $1
          GROUP BY municipality
          ORDER BY n DESC
          LIMIT 5`,
        [`${m.slice(0, Math.max(3, m.length - 1))}%`],
      );
      if (res.rows.length === 0) {
        console.log(`${m.padEnd(20)} | NO MATCH`);
      } else {
        const summary = res.rows.map((r) => `${r.municipality}(${r.n})`).join(', ');
        console.log(`${m.padEnd(20)} | ${summary}`);
      }
    }
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
