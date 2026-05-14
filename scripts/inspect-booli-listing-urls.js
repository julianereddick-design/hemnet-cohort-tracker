'use strict';
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

(async () => {
  const c = new Client({
    host: process.env.DB_HOST, port: +process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  console.log('-- Sample 6 known active listings (our spike fixtures) --');
  const sample = await c.query(
    `SELECT booli_id, url FROM booli_listing
     WHERE booli_id IN (6030840,6113019,6089456,6109244,4953553,6057489)`,
  );
  for (const r of sample.rows) console.log(`  booli_id=${r.booli_id}  url=${r.url}`);

  console.log('\n-- URL prefix distribution (active FS in 4 counties) --');
  const dist = await c.query(
    `SELECT
       CASE
         WHEN url LIKE '/annons/%' THEN '/annons/'
         WHEN url LIKE '/bostad/%' THEN '/bostad/'
         WHEN url LIKE 'https://%' THEN '<absolute>'
         ELSE substring(url for 30)
       END AS prefix,
       COUNT(*)::int AS n
     FROM booli_listing
     WHERE removed IS NULL
       AND is_pre_market = false
       AND county IN ('Stockholms län','Västra Götalands län','Skåne län','Uppsala län')
     GROUP BY 1
     ORDER BY 2 DESC`,
  );
  for (const r of dist.rows) console.log(`  ${r.prefix.padEnd(20)} ${r.n}`);

  await c.end();
})();
