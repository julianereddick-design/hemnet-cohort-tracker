'use strict';

// probe-fetch-fallback.js — End-to-end verification of Phase 7.1's
// Oxylabs fallback in lib/hemnet-fetch.js. Exercises both the direct-curl
// path (default) and the forced-Oxylabs path (HEMNET_FORCE_OXYLABS=1),
// and asserts the Apollo state shape is byte-identical for a known-good
// URL across both transports.
//
// Reads OXYLABS_USERNAME / OXYLABS_PASSWORD from .env (already gitignored).
// No new npm deps — dotenv is already a transitive dep used by cron-wrapper.
//
// Usage (from hemnet-cohort-tracker/):
//   node scripts/probe-fetch-fallback.js                       # default mode
//   HEMNET_FORCE_OXYLABS=1 node scripts/probe-fetch-fallback.js  # force-oxylabs mode
//
// Pass criteria:
//   - >=18 of ~20 probes succeed end-to-end (deliberate-error probes count as
//     'expected fail = success' for accounting purposes; their ok=true)
//   - Apollo state shape byte-identical for the known-good URL across direct vs
//     forced-Oxylabs (key-set comparison; the byte content of dynamic fields
//     like timesViewed legitimately differs between calls)
//   - In force-mode: oxylabsCallCount > 0 AND directSuccessCount == 0

require('dotenv').config();

const {
  fetchDetail,
  fetchSearch,
  getOxylabsStats,
  resetOxylabsStats,
} = require('../lib/hemnet-fetch');

const PROBES = [
  // 8 search-page probes
  { kind: 'search', muni: 17951, page: 1, label: 'Järfälla p1' },
  { kind: 'search', muni: 17951, page: 2, label: 'Järfälla p2' },
  { kind: 'search', muni: 17884, page: 1, label: 'Borås p1' },
  { kind: 'search', muni: 17884, page: 2, label: 'Borås p2' },
  { kind: 'search', muni: 18043, page: 1, label: 'Landskrona p1' },
  { kind: 'search', muni: 18043, page: 3, label: 'Landskrona p3' },
  { kind: 'search', muni: 17865, page: 1, label: 'Ale p1' },
  { kind: 'search', muni: 17936, page: 1, label: 'Huddinge p1' },
  // 8 detail probes — mix known-active and the persistent-403 ones from Phase 8 VERF-04
  { kind: 'detail', id: '21703513', label: 'Kalvshällavägen 42 (known-good)' },
  { kind: 'detail', id: '21708071', label: 'Upplands-Bro probe' },
  { kind: 'detail', id: '21708066', label: 'Upplands-Bro #2' },
  { kind: 'detail', id: '19857620', label: 'Malmö probe (likely inactive)' },
  { kind: 'detail', id: '21703801', label: 'Lidingö probe' },
  { kind: 'detail', id: '21686679', label: 'Håbo (persistent-403 baseline)' },
  { kind: 'detail', id: '21430153', label: 'Göteborg probe' },
  { kind: 'detail', id: '21685260', label: 'Pressarvägen 23' },
  // 2 known-404 detail probes (impossible hemnet_ids — confirm 404 path still works)
  { kind: 'detail', id: '99999999', label: '404 sanity #1', expect404: true },
  { kind: 'detail', id: '12345678', label: '404 sanity #2', expect404: true },
  // 2 deliberate-error: invalid muni (search 404 should throw)
  { kind: 'search', muni: 99999999, page: 1, label: 'invalid muni #1', expectErr: true },
  { kind: 'search', muni: 88888888, page: 1, label: 'invalid muni #2', expectErr: true },
];

const forceMode = process.env.HEMNET_FORCE_OXYLABS === '1';

function summarize(results) {
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const expectedFail = results.filter((r) => (r.expectErr || r.expect404)).length;
  return { ok, fail, expectedFail };
}

async function runProbe(p) {
  try {
    if (p.kind === 'search') {
      const r = await fetchSearch(p.muni, { page: p.page });
      if (p.expectErr) {
        // Should have thrown — getting here means the expected error didn't occur.
        return { ok: false, err: 'expected error, got success', cards: r.cards.length };
      }
      return { ok: true, cards: r.cards.length };
    }
    // detail
    const r = await fetchDetail(p.id);
    if (p.expect404) {
      return { ok: r.status === 'inactive' && r.reason === '404', detailStatus: r.status, detailReason: r.reason };
    }
    return { ok: r.status === 'active' || r.status === 'inactive', detailStatus: r.status, detailReason: r.reason };
  } catch (e) {
    if (p.expectErr || p.expect404) return { ok: true, expectedError: e.message };
    return { ok: false, err: e.message };
  }
}

(async () => {
  console.log(`Mode: ${forceMode ? 'HEMNET_FORCE_OXYLABS=1 (Oxylabs-only)' : 'default (direct-first)'}`);
  console.log(`Probes: ${PROBES.length}\n`);

  resetOxylabsStats();

  const results = [];
  for (const p of PROBES) {
    process.stdout.write(`[${p.kind.padEnd(6)}] ${p.label.padEnd(42)} ... `);
    const r = await runProbe(p);
    Object.assign(r, p);
    results.push(r);
    if (r.ok) {
      const note = r.expectedError ? ' (expected error)' : (r.cards != null ? ` (cards=${r.cards})` : (r.detailStatus ? ` (${r.detailStatus}${r.detailReason ? '/' + r.detailReason : ''})` : ''));
      console.log(`OK${note}`);
    } else {
      console.log(`FAIL (${r.err || 'unexpected'})`);
    }
  }

  const { ok, fail, expectedFail } = summarize(results);
  const stats = getOxylabsStats();

  console.log('');
  console.log('---------------------------------------------------------------');
  console.log(`Pass: ${ok}/${PROBES.length}  Fail: ${fail}  (deliberate-error probes: ${expectedFail})`);
  console.log(`Oxylabs stats: callCount=${stats.oxylabsCallCount} failureCount=${stats.oxylabsFailureCount} directSuccess=${stats.directSuccessCount} fallbackRate=${(stats.oxylabsFallbackRate * 100).toFixed(1)}%`);
  console.log('---------------------------------------------------------------');

  // Pass-gate checks
  let exitCode = 0;
  if (ok < 18) {
    console.error(`FAIL: only ${ok}/${PROBES.length} passed (need >=18)`);
    exitCode = 1;
  }

  if (forceMode) {
    if (stats.directSuccessCount !== 0) {
      console.error(`FAIL: force mode but directSuccessCount=${stats.directSuccessCount} (expected 0)`);
      exitCode = 1;
    }
    if (stats.oxylabsCallCount === 0) {
      console.error(`FAIL: force mode but oxylabsCallCount=0 (expected > 0)`);
      exitCode = 1;
    }
  }

  // Apollo shape comparison — only in default mode (in force mode both halves
  // would route through Oxylabs, defeating the cross-transport assertion).
  // Spawn a child node process with HEMNET_FORCE_OXYLABS=1 set BEFORE node
  // boots — FORCE_OXYLABS is captured at module load via a top-level const
  // so toggling process.env in the parent after lib is required doesn't take
  // effect.
  if (!forceMode) {
    const knownGood = '21703513';
    try {
      const directResult = await fetchDetail(knownGood);
      if (directResult.status !== 'active') {
        // If the known-good URL is no longer active we can't compare listings;
        // surface but don't hard-fail unless this is a regression.
        console.error(`WARN: known-good URL ${knownGood} no longer active (status=${directResult.status}, reason=${directResult.reason}) — skipping shape comparison`);
      } else {
        const { spawnSync } = require('child_process');
        const path = require('path');
        const childEnv = Object.assign({}, process.env, { HEMNET_FORCE_OXYLABS: '1' });
        const libPath = path.resolve(__dirname, '..', 'lib', 'hemnet-fetch.js').replace(/\\/g, '/');
        const code = `require('dotenv').config(); const { fetchDetail } = require('${libPath}'); fetchDetail('${knownGood}').then(r => { console.log(JSON.stringify({ status: r.status, listing: r.listing })); }).catch(e => { console.error(e.message); process.exit(1); });`;
        const child = spawnSync(
          process.execPath,
          ['-e', code],
          {
            encoding: 'utf8',
            timeout: 120_000,
            env: childEnv,
            cwd: path.resolve(__dirname, '..'),
          },
        );
        if (child.status !== 0) {
          console.error('FAIL: forced-Oxylabs child failed:');
          console.error('  stderr:', child.stderr);
          console.error('  stdout:', child.stdout);
          exitCode = 1;
        } else {
          let oxylabsResult;
          try {
            // Child stdout may contain a dotenv banner on the first line. Find the JSON line.
            const lines = (child.stdout || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
            const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));
            oxylabsResult = JSON.parse(jsonLine);
          } catch (e) {
            console.error('FAIL: forced-Oxylabs child output not parseable:', e.message);
            console.error('  stdout:', child.stdout);
            exitCode = 1;
          }
          if (oxylabsResult) {
            const directKeys = Object.keys(directResult.listing || {}).sort();
            const oxylabsKeys = Object.keys(oxylabsResult.listing || {}).sort();
            const equal =
              directKeys.length === oxylabsKeys.length &&
              directKeys.every((k, i) => k === oxylabsKeys[i]);
            console.log(`Apollo listing shape direct vs Oxylabs: ${equal ? 'IDENTICAL' : 'DIFFER'} (direct=${directKeys.length} keys, oxylabs=${oxylabsKeys.length} keys)`);
            if (!equal) {
              console.error('FAIL: Apollo listing shape differs between direct and Oxylabs paths');
              console.error('  direct:', directKeys);
              console.error('  oxylabs:', oxylabsKeys);
              exitCode = 1;
            }
          }
        }
      }
    } catch (e) {
      console.error('FAIL: shape comparison threw:', e.message);
      exitCode = 1;
    }
  }

  process.exit(exitCode);
})().catch((e) => {
  console.error('UNEXPECTED:', e);
  process.exit(1);
});
