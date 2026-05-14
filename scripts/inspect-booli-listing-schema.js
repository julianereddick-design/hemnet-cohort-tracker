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
  const r = await c.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = 'booli_listing'
     ORDER BY ordinal_position`,
  );
  console.log('booli_listing columns:');
  for (const row of r.rows) {
    const nullable = row.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
    const def = row.column_default ? ` DEFAULT ${row.column_default}` : '';
    console.log(`  ${row.column_name.padEnd(28)} ${row.data_type.padEnd(20)} ${nullable}${def}`);
  }
  await c.end();
})();
