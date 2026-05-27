// market-totals-daily.js
// Phase 11 (v2.2) — Daily nationwide listing-totals capture for Hemnet + Booli.
// Writes 4 rows/day into market_totals (2 sites × 2 segments: till_salu, kommande).
// Slack failure/warning alerting is inherited from cron-wrapper; this job is
// silent on success by design (D-07).

const { runJob } = require('./cron-wrapper');
const { getWithRetry, extractNextData, getOxylabsStats, resetOxylabsStats } = require('./lib/scrape-http');

const HEMNET_URL              = 'https://www.hemnet.se/bostader';
const BOOLI_TILL_SALU_URL     = 'https://www.booli.se/sok/till-salu?upcomingSale=0';
const BOOLI_KOMMANDE_URL      = 'https://www.booli.se/sok/till-salu?upcomingSale=1';

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
// "searchForSaleListings({...})"). Prefix-match by call name is stable against
// argument-shape changes — mirrors the lib/hemnet-fetch.js:196-204 pattern.
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

function extractApolloRoot(html, siteLabel) {
  const data = extractNextData(html);
  const apollo = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  if (!apollo || typeof apollo !== 'object') {
    throw new Error(`${siteLabel}: __APOLLO_STATE__ missing from __NEXT_DATA__`);
  }
  const root = apollo.ROOT_QUERY;
  if (!root || typeof root !== 'object') {
    throw new Error(`${siteLabel}: ROOT_QUERY missing from __APOLLO_STATE__`);
  }
  return root;
}

async function main(client, log) {
  await client.query(CREATE_TABLE);
  resetOxylabsStats();

  // Three fetches in parallel — D-01 fetch budget (Hemnet 1 + Booli 2 = 3 reqs/day).
  // Hemnet's single fetch yields BOTH segments via two different ROOT_QUERY keys.
  const t0 = Date.now();

  const [hemnetRes, booliTillSaluRes, booliKommandeRes] = await Promise.all([
    getWithRetry(HEMNET_URL,          { logger: log }),
    getWithRetry(BOOLI_TILL_SALU_URL, { logger: log }),
    getWithRetry(BOOLI_KOMMANDE_URL,  { logger: log }),
  ]);

  const fetchElapsedMs = Date.now() - t0;

  // Parse Hemnet — one Apollo state yields both segments.
  const hemnetRoot     = extractApolloRoot(hemnetRes.html, 'hemnet');
  const hemnetTillSalu = pickByPrefix(hemnetRoot, 'searchForSaleListings',  'total');
  const hemnetKommande = pickByPrefix(hemnetRoot, 'searchUpcomingListings', 'total');

  // Parse Booli — two Apollo states, each yields its one segment via totalCount.
  const booliTSRoot        = extractApolloRoot(booliTillSaluRes.html, 'booli (till_salu)');
  const booliKomRoot       = extractApolloRoot(booliKommandeRes.html, 'booli (kommande)');
  const booliTillSaluTotal = pickByPrefix(booliTSRoot,  'searchForSale', 'totalCount');
  const booliKommandeTotal = pickByPrefix(booliKomRoot, 'searchForSale', 'totalCount');

  // Inline smoke probe (D-02). Throws cleanly with descriptive error if drift.
  assertNumericTotal('hemnet.till_salu', hemnetTillSalu);
  assertNumericTotal('hemnet.kommande',  hemnetKommande);
  assertNumericTotal('booli.till_salu',  booliTillSaluTotal);
  assertNumericTotal('booli.kommande',   booliKommandeTotal);

  // Upsert 4 rows.
  const rows = [
    { site: 'hemnet', segment: 'till_salu', total: hemnetTillSalu,     source_url: HEMNET_URL          },
    { site: 'hemnet', segment: 'kommande',  total: hemnetKommande,     source_url: HEMNET_URL          },
    { site: 'booli',  segment: 'till_salu', total: booliTillSaluTotal, source_url: BOOLI_TILL_SALU_URL },
    { site: 'booli',  segment: 'kommande',  total: booliKommandeTotal, source_url: BOOLI_KOMMANDE_URL  },
  ];

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
    fetchElapsedMs,
    totalElapsedMs: Date.now() - t0,
    oxylabsFallbackRate: oxStats.oxylabsFallbackRate, // REPORTING FIELD ONLY — no validate() warn (D-07, Plan 10-02 lesson)
  };
}

runJob({
  scriptName: 'market-totals-daily',
  main,
  validate: (summary) => {
    if (!summary || summary.rowsWritten !== 4) {
      return `Expected 4 rows upserted, got ${summary && summary.rowsWritten}`;
    }
    // No oxylabsFallbackRate check (D-07; Plan 10-02 lesson — those alerts became permanent noise).
    // No delta check (D-03 — deferred to future plan).
    return null;
  },
});
