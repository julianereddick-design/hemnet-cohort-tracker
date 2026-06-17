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
//
// WR-04: parse line-by-line and SKIP a malformed line with file:line + a content
// snippet, instead of letting one bad line in the resume cache abort the whole pass
// with an opaque message. Returns { records, malformed } so the caller can exit
// non-zero when anything was dropped.
function readJsonl(file) {
  const records = [];
  let malformed = 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    try { records.push(JSON.parse(raw)); }
    catch (e) {
      malformed++;
      console.error(`WARN ${file}:${i + 1} skipped — malformed JSON line: ${e.message} (starts: ${raw.slice(0, 80)})`);
    }
  });
  return { records, malformed };
}

// WR-05: upsert each record in isolation. One bad row (e.g. an absent booli_id binding
// raw as undefined) otherwise aborts mid-stream after partial writes with an opaque pg
// error. Skip + log the offending record (with its identifying key) and keep going —
// the upserts are idempotent (DB-03), so a re-run after the data is fixed is safe.
async function persistFile(client, file, upsert) {
  const { records, malformed } = readJsonl(file);
  let ok = 0, failed = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    try { await upsert(client, rec); ok++; }
    catch (e) {
      failed++;
      const key = rec && (rec.booli_id != null ? rec.booli_id : (rec.slug != null ? rec.slug : rec.hemnet_slug));
      console.error(`WARN ${file} record #${i + 1}${key != null ? ` (${key})` : ''} skipped — upsert failed: ${e.message}`);
    }
  }
  return { ok, malformed, failed };
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
  let booli = 0, hemnet = 0, skipped = 0;
  try {
    if (args.booli) {
      const r = await persistFile(client, args.booli, upsertBooliSold);
      booli = r.ok; skipped += r.malformed + r.failed;
    }
    if (args.hemnet) {
      const r = await persistFile(client, args.hemnet, upsertHemnetSold);
      hemnet = r.ok; skipped += r.malformed + r.failed;
    }
  } finally {
    await client.end();
  }
  console.log(`persisted: booli=${booli} hemnet=${hemnet} skipped=${skipped}`);
  return { booli, hemnet, skipped };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.smoke) {
    const assert = require('assert');
    const os = require('os');
    const path = require('path');
    assert.strictEqual(typeof upsertBooliSold, 'function');
    assert.strictEqual(typeof upsertHemnetSold, 'function');
    const a = parseArgs(['--booli', 'x.jsonl', '--hemnet', 'y.jsonl']);
    assert.strictEqual(a.booli, 'x.jsonl');
    assert.strictEqual(a.hemnet, 'y.jsonl');

    // WR-04: a malformed line is skipped (not fatal) and counted; valid lines survive.
    const tmp = path.join(os.tmpdir(), `persist-sold-smoke-${process.pid}-${Date.now()}.jsonl`);
    try {
      fs.writeFileSync(tmp, '{"booli_id":1}\nNOT JSON\n\n{"booli_id":2}\n');
      const { records, malformed } = readJsonl(tmp);
      assert.strictEqual(records.length, 2, `expected 2 valid records, got ${records.length}`);
      assert.strictEqual(malformed, 1, `expected 1 malformed line, got ${malformed}`);

      // WR-05: one record whose upsert throws is isolated — the others still persist.
      (async () => {
        const mockClient = {};
        const failOnTwo = async (_c, rec) => { if (rec.booli_id === 2) throw new Error('boom'); };
        const r = await persistFile(mockClient, tmp, failOnTwo);
        assert.strictEqual(r.ok, 1, `expected 1 ok, got ${r.ok}`);
        assert.strictEqual(r.failed, 1, `expected 1 failed, got ${r.failed}`);
        assert.strictEqual(r.malformed, 1, `expected 1 malformed, got ${r.malformed}`);
        console.log('smoke: ok');
        process.exit(0);
      })().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return;
  }
  run(args)
    .then(({ skipped }) => { if (skipped > 0) process.exit(2); })  // partial: good rows landed, but some were dropped
    .catch((err) => { console.error('Error:', err.message); process.exit(1); });
}

module.exports = { run, parseArgs, readJsonl, persistFile };
