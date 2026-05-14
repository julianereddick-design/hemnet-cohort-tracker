'use strict';

// probe-oxylabs-booli.js — Cheap iteration loop for 09-1.5 Oxylabs detail-page
// fix. Hits ~12 URLs spanning Booli /sok/till-salu* (search) + /bostad/* (detail)
// endpoints and reports per-URL pass/fail with body excerpts on failure.
//
// Forces Oxylabs via SCRAPE_FORCE_OXYLABS=1 (set BEFORE require — FORCE_OXYLABS
// is captured at module load via top-level const in lib/scrape-http.js:40-42).
//
// Reads OXYLABS_USERNAME / OXYLABS_PASSWORD from .env. Writes log lines that
// include the OXYLABS_API_NON_200 body=... excerpt (lib/scrape-http.js:142-143
// already emits this — the probe just routes it to a per-URL summary line).
//
// Usage (from hemnet-cohort-tracker/):
//   mkdir -p verf09-1-5-logs
//   node scripts/probe-oxylabs-booli.js 2>&1 | tee verf09-1-5-logs/probe.log
//
// Pass criteria:
//   >= 80% of probes succeed end-to-end (>= 10/12 OK)
//   exitCode 0
//
// Cost: ~12 paid Oxylabs API requests per run. Use this for iteration; reserve
// the full wet-run (Task 4) for the binding gate.

// SCRAPE_FORCE_OXYLABS MUST be set BEFORE the lib/scrape-http require chain.
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

const { fetchBooliSearch, fetchBooliDetail, getOxylabsStats, resetOxylabsStats } =
  require('../lib/booli-fetch');
const { createClient } = require('../db');

// Search-side probes: one page-1 search per county
// (areaIds: 2 Stockholm, 23 VG, 64 Skåne, 118 Uppsala).
const SEARCH_PROBES = [
  { kind: 'search', areaId: 2,   page: 1, label: 'Stockholm p1' },
  { kind: 'search', areaId: 23,  page: 1, label: 'VG p1' },
  { kind: 'search', areaId: 64,  page: 1, label: 'Skåne p1' },
  { kind: 'search', areaId: 118, page: 1, label: 'Uppsala p1' },
];

// Detail-side probes: derived at runtime from booli_listing so the URLs are
// real and the rows reflect what Job D will actually try to refresh.
//
// SQL:
//   SELECT url FROM booli_listing
//    WHERE url LIKE '%/bostad/%' OR url LIKE '%/annons/%'
//    ORDER BY crawled DESC NULLS LAST
//    LIMIT 8;

function nowIso() {
  return new Date().toISOString();
}

function log(prefix, msg) {
  process.stdout.write(`[${nowIso()}] [${prefix}] ${msg}\n`);
}

async function loadDetailProbes(client) {
  const sql = `
    SELECT url
      FROM booli_listing
     WHERE url LIKE '%/bostad/%' OR url LIKE '%/annons/%'
     ORDER BY crawled DESC NULLS LAST
     LIMIT 8
  `;
  const res = await client.query(sql);
  const rows = res.rows || [];
  if (rows.length < 6) {
    log(
      'FAIL',
      `probe set too small (< 6 detail probes) — wait for Job C to populate booli_listing before running probe. Found ${rows.length} rows.`,
    );
    process.exit(1);
  }
  return rows.map((r, i) => ({
    kind: 'detail',
    url: r.url,
    label: `detail #${i + 1} ${r.url.replace('https://www.booli.se', '').slice(0, 48)}`,
  }));
}

async function runProbe(probe) {
  const t0 = Date.now();
  try {
    if (probe.kind === 'search') {
      const r = await fetchBooliSearch(probe.areaId, { page: probe.page });
      const cards = (r && r.cards) ? r.cards.length : 0;
      return { ok: true, label: probe.label, kind: probe.kind, durationMs: Date.now() - t0, cards };
    }
    // detail
    const r = await fetchBooliDetail(probe.url);
    // Accept either active (parsed listing) or inactive (404 / no-apollo / no-listing).
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
    // Surface VERBATIM — do NOT truncate, the body excerpt is the entire point.
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
  log('INFO', 'probe-oxylabs-booli.js starting (SCRAPE_FORCE_OXYLABS=1)');

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
    // Release the DB client before running paid Oxylabs calls — we no longer
    // need the connection and don't want it idle for the duration of the probe.
    try { await client.end(); } catch (_) { /* best effort */ }
  }

  const PROBES = [...SEARCH_PROBES, ...detailProbes];
  log('INFO', `probe set: ${PROBES.length} URLs (${SEARCH_PROBES.length} search + ${detailProbes.length} detail)`);

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
        : r.cards != null
          ? ` cards=${r.cards}`
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
    log('PASS', `probe pass rate ${ok}/${PROBES.length} >= 80% (threshold ${threshold}/${PROBES.length}) — chosen Oxylabs plan looks good`);
    process.exit(0);
  } else {
    log('FAIL', `probe pass rate ${ok}/${PROBES.length} < 80% — root-cause hypothesis NOT resolved`);
    log('FAIL', 'inspect the err=... lines above for OXYLABS_API_NON_200 status=<X> body=<Y> excerpts');
    process.exit(1);
  }
})().catch((e) => {
  log('UNEXPECTED', e && e.stack ? e.stack : String(e));
  process.exit(1);
});
