// market-totals-daily.js
// Phase 11 (v2.2) — Daily nationwide listing-totals capture for Hemnet + Booli.
// Writes 4 rows/day into market_totals (2 sites × 2 segments: till_salu, kommande).
// Slack failure/warning alerting is inherited from cron-wrapper; this job is
// silent on success by design (D-07).
//
// 2026-10-27: Hemnet moved its totals to ROOT_QUERY.search.listings(...) and
// /bostader now renders /till-salu. See docs/handover/CHANGELOG.md. Sites are
// isolated: one site breaking still writes the other's rows, but the run is a
// failure — before this, a Hemnet-only break silently cost Booli 3 weeks of data.

const { runJob } = require('./cron-wrapper');
const { getWithRetry, extractApolloState, getOxylabsStats, resetOxylabsStats } = require('./lib/scrape-http');
const { parseSearchTotals } = require('./lib/hemnet-fetch');

// till_salu must be upcoming=EXCLUDE: bare /till-salu's headline count is
// for-sale + kommande. Bare /till-salu is still fetched — it carries kommande
// AND the combined count, which cross-checks the partition every day.
const HEMNET_TILL_SALU_URL    = 'https://www.hemnet.se/till-salu?upcoming=EXCLUDE';
const HEMNET_ALL_URL          = 'https://www.hemnet.se/till-salu';
const BOOLI_TILL_SALU_URL     = 'https://www.booli.se/sok/till-salu?upcomingSale=0';
const BOOLI_KOMMANDE_URL      = 'https://www.booli.se/sok/till-salu?upcomingSale=1';

// |combined − (forSale + upcoming)| allowed as a share of combined. The two pages
// are fetched in parallel, so only a handful of listings can move between them;
// a real partition change (EXCLUDE meaning something new) is thousands.
const PARTITION_TOLERANCE = 0.005;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS market_totals (
    day          DATE        NOT NULL,
    site         TEXT        NOT NULL,
    segment      TEXT        NOT NULL,
    total        INTEGER     NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_url   TEXT        NOT NULL,
    PRIMARY KEY (day, site, segment)
  )
`;

const UPSERT = `
  INSERT INTO market_totals (day, site, segment, total, fetched_at, source_url)
  VALUES (CURRENT_DATE, $1, $2, $3, NOW(), $4)
  ON CONFLICT (day, site, segment)
  DO UPDATE SET total = EXCLUDED.total, fetched_at = EXCLUDED.fetched_at, source_url = EXCLUDED.source_url
`;

// Inline JSON-path smoke probe (D-02). Key-present + numeric + positive only;
// NO sanity bounds (a real market crash could legitimately drive totals low).
function assertNumericTotal(label, n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || Number.isNaN(n) || n <= 0) {
    throw new Error(
      `JSON path missing for ${label}: expected positive number, got ${n === undefined ? 'undefined' : JSON.stringify(n)}`
    );
  }
}

// Apollo ROOT_QUERY keys are stringified call signatures (e.g.
// "searchForSale({...})"). Prefix-match by call name is stable against
// argument-shape changes. Booli only — Hemnet uses parseSearchTotals.
function pickByPrefix(rootQuery, prefix, fieldName) {
  if (!rootQuery || typeof rootQuery !== 'object') return undefined;
  for (const k of Object.keys(rootQuery)) {
    if (k.startsWith(prefix)) {
      const node = rootQuery[k];
      if (node && typeof node === 'object') return node[fieldName];
    }
  }
  return undefined;
}

function extractApollo(html, siteLabel) {
  // Router-agnostic: Booli is App Router since 2026-09-21, Hemnet is still Pages.
  const apollo = extractApolloState(html, siteLabel);
  if (!apollo || typeof apollo !== 'object') {
    throw new Error(`${siteLabel}: apollo state missing`);
  }
  if (!apollo.ROOT_QUERY || typeof apollo.ROOT_QUERY !== 'object') {
    throw new Error(`${siteLabel}: ROOT_QUERY missing from __APOLLO_STATE__`);
  }
  return apollo;
}

// Unwrap a Promise.allSettled result; a rejected fetch fails only its own site.
function settledHtml(settled, label) {
  if (settled.status === 'rejected') {
    const reason = settled.reason;
    throw new Error(`${label}: fetch failed — ${reason && reason.message ? reason.message : reason}`);
  }
  return settled.value.html;
}

// Returns { rows, check } or throws. check = the partition cross-check result;
// a mismatch does NOT throw — the rows are still written and validate() warns.
function parseHemnet(tillSaluSettled, allSettled) {
  const excl = parseSearchTotals(extractApollo(settledHtml(tillSaluSettled, 'hemnet (till_salu)'), 'hemnet (till_salu)'));
  const all  = parseSearchTotals(extractApollo(settledHtml(allSettled, 'hemnet (all)'), 'hemnet (all)'));

  assertNumericTotal('hemnet.till_salu', excl.forSale);
  assertNumericTotal('hemnet.kommande',  all.upcoming);
  assertNumericTotal('hemnet.combined',  all.combined);

  const diff = all.combined - (excl.forSale + all.upcoming);
  const check = {
    combined: all.combined,
    forSalePlusUpcoming: excl.forSale + all.upcoming,
    diff,
    ok: Math.abs(diff) <= all.combined * PARTITION_TOLERANCE,
  };
  return {
    rows: [
      { site: 'hemnet', segment: 'till_salu', total: excl.forSale, source_url: HEMNET_TILL_SALU_URL },
      { site: 'hemnet', segment: 'kommande',  total: all.upcoming, source_url: HEMNET_ALL_URL       },
    ],
    check,
  };
}

function parseBooli(tillSaluSettled, kommandeSettled) {
  const tsRoot  = extractApollo(settledHtml(tillSaluSettled, 'booli (till_salu)'), 'booli (till_salu)').ROOT_QUERY;
  const komRoot = extractApollo(settledHtml(kommandeSettled, 'booli (kommande)'), 'booli (kommande)').ROOT_QUERY;
  const tillSalu = pickByPrefix(tsRoot,  'searchForSale', 'totalCount');
  const kommande = pickByPrefix(komRoot, 'searchForSale', 'totalCount');
  assertNumericTotal('booli.till_salu', tillSalu);
  assertNumericTotal('booli.kommande',  kommande);
  return {
    rows: [
      { site: 'booli', segment: 'till_salu', total: tillSalu, source_url: BOOLI_TILL_SALU_URL },
      { site: 'booli', segment: 'kommande',  total: kommande, source_url: BOOLI_KOMMANDE_URL  },
    ],
  };
}

// deps is for the offline test (scripts/test-market-totals-daily.js); cron
// passes nothing and gets the live fetcher.
async function main(client, log, deps = {}) {
  const fetchPage = deps.getWithRetry || getWithRetry;
  await client.query(CREATE_TABLE);
  resetOxylabsStats();

  // Four fetches in parallel (Hemnet 2 + Booli 2 = 4 reqs/day).
  const t0 = Date.now();
  const [hTS, hAll, bTS, bKom] = await Promise.allSettled([
    fetchPage(HEMNET_TILL_SALU_URL, { logger: log }),
    fetchPage(HEMNET_ALL_URL,       { logger: log }),
    fetchPage(BOOLI_TILL_SALU_URL,  { logger: log }),
    fetchPage(BOOLI_KOMMANDE_URL,   { logger: log }),
  ]);
  const fetchElapsedMs = Date.now() - t0;

  const rows = [];
  const siteErrors = [];
  let hemnetPartition = null;
  for (const [site, parse] of [
    ['hemnet', () => parseHemnet(hTS, hAll)],
    ['booli',  () => parseBooli(bTS, bKom)],
  ]) {
    try {
      const res = parse();
      rows.push(...res.rows);
      if (res.check) hemnetPartition = res.check;
    } catch (err) {
      siteErrors.push({ site, message: err.message });
      log(`site failed: ${site} — ${err.message}`);
    }
  }

  let rowsWritten = 0;
  for (const r of rows) {
    await client.query(UPSERT, [r.site, r.segment, r.total, r.source_url]);
    rowsWritten++;
    log(`upsert ok: site=${r.site} segment=${r.segment} total=${r.total}`);
  }

  const oxStats = getOxylabsStats();

  return {
    rowsWritten,
    perRow: rows.map(r => ({
      site: r.site,
      segment: r.segment,
      total: r.total,
      source_url: r.source_url,
    })),
    siteErrors,
    hemnetPartition,
    fetchElapsedMs,
    totalElapsedMs: Date.now() - t0,
    oxylabsFallbackRate: oxStats.oxylabsFallbackRate, // REPORTING FIELD ONLY — no validate() warn (D-07, Plan 10-02 lesson)
  };
}

function validate(summary) {
  // A site that failed to parse is a FAILURE even though the other site's rows
  // landed — a lost daily snapshot is unrecoverable. The key names the sites, so
  // "Hemnet broke" and "Booli broke" are separate incidents on the re-notify ladder;
  // the error text goes in the message, never the key.
  if (summary && summary.siteErrors && summary.siteErrors.length > 0) {
    const sites = summary.siteErrors.map(e => e.site).sort();
    return {
      key: `site-failed:${sites.join('+')}`,
      severity: 'failure',
      message: `${sites.join(' + ')} failed (${summary.rowsWritten}/4 rows written): ` +
        summary.siteErrors.map(e => `${e.site}: ${e.message}`).join('; '),
    };
  }
  if (!summary || summary.rowsWritten !== 4) {
    // A DECLARED conditionKey (Phase 4). This is the one perfectly stable error
    // signature in the codebase, on a tier-1 DAILY job — spec §4.2 names it as
    // the reason the re-notify ladder exists at all. Keyed, it gets the
    // 0h/+24h/+72h/daily ladder instead of one alert a day forever; and because
    // the ladder never terminates, no permanently-lost snapshot goes unreported.
    // The count is in the MESSAGE, never in the key — a key that varied with the
    // count would make every partial write look like a brand-new incident.
    return {
      key: 'partial-upsert',
      severity: 'warning',
      message: `Expected 4 rows upserted, got ${summary && summary.rowsWritten}`,
    };
  }
  // Rows are written regardless (dropping a day is worse than flagging one), but
  // a broken partition means till_salu/kommande may no longer mean what the
  // series says they mean — a human has to look.
  const p = summary.hemnetPartition;
  if (p && !p.ok) {
    return {
      key: 'hemnet-partition-mismatch',
      severity: 'warning',
      message: `Hemnet for-sale + kommande (${p.forSalePlusUpcoming}) != combined (${p.combined}), diff ${p.diff} — ` +
        `upcoming=EXCLUDE/ONLY may have changed meaning`,
    };
  }
  // No oxylabsFallbackRate check (D-07; Plan 10-02 lesson — those alerts became permanent noise).
  // No delta check (D-03 — deferred to future plan).
  return null;
}

module.exports = {
  main, validate, parseHemnet, parseBooli, assertNumericTotal, pickByPrefix,
  HEMNET_TILL_SALU_URL, HEMNET_ALL_URL, BOOLI_TILL_SALU_URL, BOOLI_KOMMANDE_URL,
};

if (require.main === module) {
  runJob({ scriptName: 'market-totals-daily', main, validate });
}
