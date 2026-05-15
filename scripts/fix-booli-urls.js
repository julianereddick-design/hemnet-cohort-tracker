// scripts/fix-booli-urls.js — replace constructed `https://www.booli.se/bostad/<id>`
// URLs in a Markdown file with the canonical URL from booli_listing.url.
//
// Why: booli_id is the LISTING id, but /bostad/ takes the RESIDENCE id (different).
// /annons/{listingId} is correct for active FS listings; /bostad/{residenceId} for
// promoted ones. The DB stores the right one in booli_listing.url.
//
// Usage: node scripts/fix-booli-urls.js <report.md>
//   Rewrites the file in place.

'use strict';

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('../db');

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/fix-booli-urls.js <report.md>');
    process.exit(1);
  }
  const text = fs.readFileSync(path, 'utf8');

  const ids = new Set();
  const re = /https:\/\/www\.booli\.se\/bostad\/(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);

  if (ids.size === 0) {
    console.log('no /bostad/<id> URLs found — nothing to fix');
    return;
  }

  console.log(`looking up ${ids.size} booli_ids in DB...`);
  const client = createClient();
  await client.connect();
  const r = await client.query(
    `SELECT booli_id::text AS booli_id, url FROM booli_listing WHERE booli_id = ANY($1::int[])`,
    [Array.from(ids).map(Number)],
  );
  await client.end();

  const map = new Map();
  for (const row of r.rows) {
    let url = row.url;
    if (typeof url === 'string' && url.startsWith('/')) url = `https://www.booli.se${url}`;
    if (!map.has(row.booli_id)) map.set(row.booli_id, url);
  }

  let replaced = 0;
  let missing = 0;
  const fixed = text.replace(/https:\/\/www\.booli\.se\/bostad\/(\d+)/g, (orig, id) => {
    const u = map.get(id);
    if (u) { replaced++; return u; }
    missing++;
    return orig;
  });

  fs.writeFileSync(path, fixed);
  console.log(`replaced ${replaced} URLs, ${missing} not found in DB; wrote ${path}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
