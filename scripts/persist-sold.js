'use strict';
// scripts/persist-sold.js — D-04 persist pass: upsert fetcher JSONL → DB so the DB
// becomes the store of record while JSONL is retained as the raw landing/resume cache.
//
// Unlike lib/sold-store.js (client-first, no own connection), this driver opens its
// OWN pg client via db.js createClient() and passes it into the store upserts.
//
// CLI:
//   node scripts/persist-sold.js --booli  <path-to-seed.jsonl>
//   node scripts/persist-sold.js --hemnet <path-to-hemnet-cards.jsonl>
//   node scripts/persist-sold.js --smoke            (offline self-test, no DB / no files)
//
// Each record loops through the store ON CONFLICT upsert, so re-running the same JSONL
// is idempotent (DB-03) — zero duplicate rows. The fetcher JSONL append is left
// untouched (DB is store of record; JSONL stays the cheap idempotent resume cache, D-04).
const fs = require('fs');
const { createClient } = require('../db');
const { upsertBooliSold, upsertHemnetSold } = require('../lib/sold-store');

// Inline JSONL reader (one JSON object per non-empty line). Read inline rather than
// require('../lib/sold-transport') so this DB/IO-focused persist script avoids the
// transport module's SCRAPE_FORCE_OXYLABS load guard.
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function parseArgs(argv) {
  const out = { booli: null, hemnet: null, smoke: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--booli') out.booli = argv[++i];
    else if (argv[i] === '--hemnet') out.hemnet = argv[++i];
    else if (argv[i] === '--smoke') out.smoke = true;
  }
  return out;
}

async function run(args) {
  const client = createClient();
  await client.connect();
  let booli = 0, hemnet = 0;
  try {
    if (args.booli) {
      for (const rec of readJsonl(args.booli)) { await upsertBooliSold(client, rec); booli++; }
    }
    if (args.hemnet) {
      for (const rec of readJsonl(args.hemnet)) { await upsertHemnetSold(client, rec); hemnet++; }
    }
  } finally {
    await client.end();
  }
  console.log(`persisted: booli=${booli} hemnet=${hemnet}`);
  return { booli, hemnet };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.smoke) {
    const assert = require('assert');
    assert.strictEqual(typeof upsertBooliSold, 'function');
    assert.strictEqual(typeof upsertHemnetSold, 'function');
    const a = parseArgs(['--booli', 'x.jsonl', '--hemnet', 'y.jsonl']);
    assert.strictEqual(a.booli, 'x.jsonl');
    assert.strictEqual(a.hemnet, 'y.jsonl');
    console.log('smoke: ok');
    process.exit(0);
  }
  run(args).catch((err) => { console.error('Error:', err.message); process.exit(1); });
}

module.exports = { run, parseArgs };
