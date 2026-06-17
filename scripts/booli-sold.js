// booli-sold.js — Thin CLI wrapper for lib/sold-fetch-booli.js.
// Sets SCRAPE_FORCE_OXYLABS before any lib require (transport guard invariant).
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// Requires AFTER the flag is set.
const path = require('path');
const fs = require('fs');
const { fetchBooliSold } = require('../lib/sold-fetch-booli');
const { SEGMENTS, DEFAULT_TARGET_PER_SEGMENT, READ_TIME_EXCLUDE_DAYS, daysAgoISO } = require('../lib/sold-config');
const { assertOxyUsed, stdoutLogger, writeJson, procStats, ROOT, ensureDir } = require('../lib/sold-transport');

const log = stdoutLogger('booli-sold');

// D-01 SPEND GUARD: if --detail-scope all is requested, verify the operator-approval
// marker is present in the recon document before proceeding. This makes the
// ~2× cost escalation impossible to trigger silently in a delegated/overnight run.
// fee-window (default) and none scopes do NOT require this check.
const RECON_DOC = path.join(
  __dirname, '..', '.planning', 'phases',
  '15-sold-data-ingestion-library', '15-SOLD-IN-ADVANCE-RECON.md',
);
const APPROVAL_MARKER = 'escalate detail (spend confirmed)';

function assertDetailScopeAllApproved() {
  let content = '';
  try {
    content = fs.readFileSync(RECON_DOC, 'utf8');
  } catch (e) {
    console.error(`ERROR: Cannot read recon doc at ${RECON_DOC}: ${e.message}`);
    console.error('Cannot verify operator approval for --detail-scope all. Aborting.');
    process.exit(3);
  }
  if (!content.includes(APPROVAL_MARKER)) {
    console.error('ERROR: --detail-scope all requires operator approval.');
    console.error(`The approval marker "${APPROVAL_MARKER}" was NOT found in:`);
    console.error(`  ${RECON_DOC}`);
    console.error('This guard prevents an unintended ~2× spend escalation.');
    console.error('To enable, have the operator write the marker to the recon doc (Plan 03 checkpoint).');
    process.exit(3);
  }
}

function parseArgs(argv) {
  const o = {
    segment: null,
    target: DEFAULT_TARGET_PER_SEGMENT,
    marketTarget: null,
    maxPages: 60,
    maxSoldDate: null,
    minSoldDate: null,
    detailScope: 'fee-window',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--segment') { o.segment = argv[++i]; }
    else if (a.startsWith('--segment=')) { o.segment = a.split('=')[1]; }
    else if (a === '--target') { o.target = parseInt(argv[++i], 10); }
    else if (a.startsWith('--target=')) { o.target = parseInt(a.split('=')[1], 10); }
    else if (a === '--market-target') { o.marketTarget = parseInt(argv[++i], 10); }
    else if (a.startsWith('--market-target=')) { o.marketTarget = parseInt(a.split('=')[1], 10); }
    else if (a === '--max-pages') { o.maxPages = parseInt(argv[++i], 10); }
    else if (a.startsWith('--max-pages=')) { o.maxPages = parseInt(a.split('=')[1], 10); }
    else if (a === '--max-sold-date') { o.maxSoldDate = argv[++i]; }
    else if (a.startsWith('--max-sold-date=')) { o.maxSoldDate = a.split('=')[1]; }
    else if (a === '--min-sold-date') { o.minSoldDate = argv[++i]; }
    else if (a.startsWith('--min-sold-date=')) { o.minSoldDate = a.split('=')[1]; }
    else if (a === '--detail-scope') { o.detailScope = argv[++i]; }
    else if (a.startsWith('--detail-scope=')) { o.detailScope = a.split('=')[1]; }
  }
  return o;
}

async function main() {
  const {
    segment,
    target,
    marketTarget,
    maxPages,
    minSoldDate,
    detailScope,
  } = parseArgs(process.argv.slice(2));

  // Default maxSoldDate = 90 days ago (ratio-eligible + Hemnet-posted window).
  const maxSoldDate = parseArgs(process.argv.slice(2)).maxSoldDate || daysAgoISO(READ_TIME_EXCLUDE_DAYS);

  // Validate detailScope value.
  const validScopes = ['fee-window', 'all', 'none'];
  if (!validScopes.includes(detailScope)) {
    log('ERROR', `Invalid --detail-scope "${detailScope}". Must be one of: ${validScopes.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // D-01 spend guard: --detail-scope all requires operator approval in the recon doc.
  if (detailScope === 'all') {
    assertDetailScopeAllApproved();
    log('INFO', `detail-scope=all: operator approval confirmed (marker present in recon doc)`);
  }

  const segKeys = segment ? [segment] : Object.keys(SEGMENTS);
  const summaries = [];

  for (const k of segKeys) {
    const seg = SEGMENTS[k];
    if (!seg) {
      log('ERROR', `unknown segment "${k}" — valid keys: ${Object.keys(SEGMENTS).join(', ')}`);
      continue;
    }
    summaries.push(
      await fetchBooliSold(k, seg, {
        target,
        marketTarget,
        maxPages,
        maxSoldDate,
        minSoldDate,
        detailScope,
        logger: log,
      }),
    );
  }

  // Write per-run summary alongside the seeds.
  const seedDir = ensureDir(path.join(ROOT, 'seeds'));
  writeJson(path.join(seedDir, '_summary.json'), {
    at: new Date().toISOString(),
    procStats: procStats(),
    segments: summaries,
  });
  log('INFO', `procStats: ${JSON.stringify(procStats())}`);

  // Transport assert: verify all live fetches went through Oxylabs (T-15-13).
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
