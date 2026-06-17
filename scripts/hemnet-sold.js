// hemnet-sold.js — Thin CLI wrapper for lib/sold-fetch-hemnet.js.
// Sets SCRAPE_FORCE_OXYLABS before any lib require (transport guard invariant).
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// Requires AFTER the flag is set.
const path = require('path');
const { searchSoldPaged, searchOptsFor } = require('../lib/sold-fetch-hemnet');
const { SEGMENTS, SOLD_DATE_WINDOW_DAYS } = require('../lib/sold-config');
const { assertOxyUsed, stdoutLogger, appendJsonl, readJsonl, ensureDir, ROOT } = require('../lib/sold-transport');

const log = stdoutLogger('hemnet-sold');

function parseArgs(argv) {
  const o = {
    segment: null,
    seed: null,
    windowDays: SOLD_DATE_WINDOW_DAYS,
    maxPages: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--segment') { o.segment = argv[++i]; }
    else if (a.startsWith('--segment=')) { o.segment = a.split('=')[1]; }
    else if (a === '--seed') { o.seed = argv[++i]; }
    else if (a.startsWith('--seed=')) { o.seed = a.split('=')[1]; }
    else if (a === '--window-days') { o.windowDays = parseInt(argv[++i], 10); }
    else if (a.startsWith('--window-days=')) { o.windowDays = parseInt(a.split('=')[1], 10); }
    else if (a === '--max-pages') { o.maxPages = parseInt(argv[++i], 10); }
    else if (a.startsWith('--max-pages=')) { o.maxPages = parseInt(a.split('=')[1], 10); }
  }
  return o;
}

async function main() {
  const { segment, seed, windowDays, maxPages } = parseArgs(process.argv.slice(2));

  const segKeys = segment ? [segment] : Object.keys(SEGMENTS);

  for (const k of segKeys) {
    const seg = SEGMENTS[k];
    if (!seg) {
      log('ERROR', `unknown segment "${k}" — valid keys: ${Object.keys(SEGMENTS).join(', ')}`);
      continue;
    }

    // Default seed path: verf-soldspike/seeds/<segKey>.jsonl (Plan-04 canonical path)
    const seedPath = seed || path.join(ROOT, 'seeds', `${k}.jsonl`);
    const records = readJsonl(seedPath);
    if (records.length === 0) {
      log('WARN', `seed file empty or missing: ${seedPath}`);
      continue;
    }

    log('INFO', `segment=${k} seed=${records.length} records windowDays=${windowDays} maxPages=${maxPages}`);

    const opts = searchOptsFor(seg);
    const resultsDir = ensureDir(path.join(ROOT, 'hemnet-candidates'));
    const resultsFile = path.join(resultsDir, `${k}.jsonl`);

    let found = 0;
    let notFound = 0;
    let errors = 0;

    for (const booli of records) {
      let result;
      try {
        result = await searchSoldPaged(booli, seg, windowDays, maxPages, opts);
      } catch (e) {
        log('ERROR', `booli_id=${booli.booli_id} search failed: ${e.message}`);
        errors++;
        appendJsonl(resultsFile, {
          booli_id: booli.booli_id,
          segment: k,
          candidates: 0,
          complete: false,
          error: e.message,
        });
        continue;
      }

      const { cards, pages, complete, stopReason } = result;
      if (cards.length > 0) { found++; } else { notFound++; }

      log('INFO', `booli_id=${booli.booli_id} candidates=${cards.length} pages=${pages} complete=${complete}${stopReason ? ` stopReason=${stopReason}` : ''}`);

      appendJsonl(resultsFile, {
        booli_id: booli.booli_id,
        segment: k,
        candidates: cards.length,
        pages,
        complete,
        stopReason: stopReason || null,
        cards,
      });
    }

    log('INFO', `segment=${k} done: found=${found} notFound=${notFound} errors=${errors} resultsFile=${resultsFile}`);
  }

  // Transport assert: verify all live fetches went through Oxylabs (T-15-17).
  try {
    log('INFO', `transport-assert: ${JSON.stringify(assertOxyUsed())}`);
  } catch (e) {
    log('ERROR', `transport-assert FAILED: ${e.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}
