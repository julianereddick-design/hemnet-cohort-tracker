'use strict';

// probe-oxylabs-hemnet.js — Hemnet Oxylabs probe (D-18 in 09-02-PLAN.md).
//
// Mirror of scripts/probe-oxylabs-booli.js swapped to the Hemnet side. Hits 12
// detail URLs (hemnet_id rows from hemnet_listingv2, newest crawled first) and
// reports per-URL pass/fail. Forces Oxylabs via SCRAPE_FORCE_OXYLABS=1 so the
// probe validates the Hemnet-via-Oxylabs fallback path, NOT the direct-curl
// path that Job A uses today.
//
// Why: D-16 retrofits hemnet-targeted-refresh.js (Job A) with conc 8 + 240-min
// budget pre-staged for the Hemnet-flips-to-Oxylabs scenario. Without an
// Oxylabs-path probe, that hardening is theoretical. This script is the
// ~$0.005 insurance call that confirms the path works end-to-end.
//
// Reads OXYLABS_USERNAME / OXYLABS_PASSWORD from .env. Writes log lines that
// include the OXYLABS_API_NON_200 body=... excerpt if any.
//
// Usage (from hemnet-cohort-tracker/):
//   mkdir -p verf09-2-logs
//   node scripts/probe-oxylabs-hemnet.js 2>&1 | tee verf09-2-logs/probe-oxylabs-hemnet.log
//
// Pass criteria:
//   >= 80% of probes succeed end-to-end (>= 10/12 OK)
//   exitCode 0
//
// Cost: ~12 paid Oxylabs API requests per run (~$0.005). Cheap insurance.

// SCRAPE_FORCE_OXYLABS MUST be set BEFORE the lib/scrape-http require chain.
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

const { fetchDetail, getOxylabsStats, resetOxylabsStats } =
  require('../lib/hemnet-fetch');
const { createClient } = require('../db');

function nowIso() {
  return new Date().toISOString();
}

function log(prefix, msg) {
  process.stdout.write(`[${nowIso()}] [${prefix}] ${msg}\n`);
}

// Load 12 hemnet_id rows from hemnet_listingv2, newest crawled first.
// Mirrors probe-oxylabs-booli.js loadDetailProbes but reads hemnet_id instead of url.
async function loadDetailProbes(client) {
  const sql = `
    SELECT hemnet_id
      FROM hemnet_listingv2
     WHERE hemnet_id IS NOT NULL
     ORDER BY crawled DESC NULLS LAST
     LIMIT 12
  `;
  const res = await client.query(sql);
  const rows = res.rows || [];
  if (rows.length < 6) {
    log(
      'FAIL',
      `probe set too small (< 6 hemnet_id rows) — populate hemnet_listingv2 first. Found ${rows.length} rows.`,
    );
    process.exit(1);
  }
  return rows.map((r, i) => ({
    kind: 'detail',
    hemnet_id: r.hemnet_id,
    label: `hemnet #${i + 1} id=${r.hemnet_id}`,
  }));
}

async function runProbe(probe) {
  const t0 = Date.now();
  try {
    const r = await fetchDetail(probe.hemnet_id);
    // Accept either active (parsed listing) or inactive (404 / similar).
    const acceptable = r && (r.status === 'active' || r.status === 'inactive');
    return {
      ok: !!acceptable,
      label: probe.label,
      kind: probe.kind,
      durationMs: Date.now() - t0,
      detailStatus: r && r.status,
      detailReason: r && r.reason,
    };
  } catch (e) {
    // err.message contains the OXYLABS_API_NON_200 body=... diagnostic gold.
    return {
      ok: false,
      label: probe.label,
      kind: probe.kind,
      durationMs: Date.now() - t0,
      err: e && e.message ? e.message : 'unknown',
    };
  }
}

(async () => {
  log('INFO', 'probe-oxylabs-hemnet.js starting (SCRAPE_FORCE_OXYLABS=1)');

  const hasCreds = !!process.env.OXYLABS_USERNAME && !!process.env.OXYLABS_PASSWORD;
  if (!hasCreds) {
    log('FAIL', 'OXYLABS_USERNAME or OXYLABS_PASSWORD missing from .env — cannot probe');
    process.exit(1);
  }

  const client = createClient();
  try {
    await client.connect();
  } catch (e) {
    log('FAIL', `DB connect failed: ${e && e.message ? e.message : 'unknown'}`);
    process.exit(1);
  }

  let detailProbes;
  try {
    detailProbes = await loadDetailProbes(client);
  } finally {
    // Release the DB client before running paid Oxylabs calls.
    try { await client.end(); } catch (_) { /* best effort */ }
  }

  const PROBES = detailProbes;
  log('INFO', `probe set: ${PROBES.length} hemnet_id rows`);

  resetOxylabsStats();

  let ok = 0;
  const results = [];
  for (const probe of PROBES) {
    const r = await runProbe(probe);
    results.push(r);
    if (r.ok) ok++;
    const extra = r.err
      ? ` err=${r.err}`
      : r.detailStatus
        ? ` detailStatus=${r.detailStatus}${r.detailReason ? '/' + r.detailReason : ''}`
        : '';
    log('probe', `${r.kind} ${probe.label} ok=${r.ok} durationMs=${r.durationMs}${extra}`);
  }

  const stats = getOxylabsStats();
  log(
    'SUMMARY',
    `ok=${ok}/${PROBES.length} oxylabsCallCount=${stats.oxylabsCallCount} oxylabsFailureCount=${stats.oxylabsFailureCount} directSuccessCount=${stats.directSuccessCount} fallbackRate=${(stats.oxylabsFallbackRate * 100).toFixed(1)}%`,
  );

  const threshold = Math.ceil(PROBES.length * 0.8);
  if (ok >= threshold) {
    log('PASS', `probe pass rate ${ok}/${PROBES.length} >= 80% (threshold ${threshold}/${PROBES.length}) — Hemnet-via-Oxylabs path verified`);
    process.exit(0);
  } else {
    log('FAIL', `probe pass rate ${ok}/${PROBES.length} < 80% — Hemnet-via-Oxylabs path is degraded`);
    log('FAIL', 'inspect the err=... lines above for OXYLABS_API_NON_200 status=<X> body=<Y> excerpts');
    process.exit(1);
  }
})().catch((e) => {
  log('UNEXPECTED', e && e.stack ? e.stack : String(e));
  process.exit(1);
});
