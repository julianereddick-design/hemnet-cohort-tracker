// hemnet-targeted-match.js — Job B. Weekly seeding of hemnet_listingv2 from
// each new Booli FS row in the upcoming Mon cohort, so cohort-create.js (Mon
// 06:00 UTC) finds matches on (postcode, street_address, ±7 days).
//
// Wrapped by cron-wrapper.runJob — failures hit Slack and cron_job_log.
// Concurrency 2 + 100-300ms jitter. Within-run search cache + in-flight dedup.
//
// Behavior locked by .planning/phases/08-weekly-targeted-match-job-b/08-01-PLAN.md
// and 08-CONTEXT.md. Critical correctness items:
//   - UPDATE all matching rows (no LIMIT 1) — fixes hemnet_listingv2 duplicate-row issue
//   - county column stores SHORT form ('Stockholms', not 'Stockholms län')
//   - municipality column stores SHORT form ('Järfälla', not 'Järfälla kommun')
//   - publishedAt is Unix seconds — cast via to_timestamp($N)::date
//   - Postcode validation gate REJECTS UPSERTs where listing.postCode and
//     booli.postcode are both non-null and unequal after normalize(p) =
//     String(p).replace(/\s+/g, '').

'use strict';

const { runJob } = require('./cron-wrapper');
const { fetchSearch, fetchDetail } = require('./lib/hemnet-fetch');
const { getLocationId } = require('./lib/hemnet-locations');

// ---------------------------------------------------------------
// Constants — copied verbatim from cohort-create.js:3-8
// ---------------------------------------------------------------

const BOOLI_COUNTIES = [
  'Stockholms län',
  'Västra Götalands län',
  'Skåne län',
  'Uppsala län',
];

const MAX_PAGES = 3;
const SEVEN_DAYS_SEC = 7 * 86400;

// ---------------------------------------------------------------
// getCohortWeek — copied verbatim from cohort-create.js:17-44.
// Do NOT extract into a shared util in this phase.
// ---------------------------------------------------------------

function getCohortWeek(dateStr) {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);

  const dow = d.getDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const thu = new Date(monday);
  thu.setDate(monday.getDate() + 3);
  const jan1 = new Date(thu.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((thu - jan1) / 86400000) + 1;
  const weekNum = Math.ceil(dayOfYear / 7);

  const fmt = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  const cohortId = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  return { cohortId, weekStart: fmt(monday), weekEnd: fmt(sunday) };
}

// Default --week behavior mirrors cohort-create.js:51-58 (last full Mon-Sun).
function defaultWeekDate() {
  const today = new Date();
  const day = today.getDay();
  const diffToLastMon = day === 0 ? 6 : day - 1;
  const lastMon = new Date(today);
  lastMon.setDate(today.getDate() - diffToLastMon - 7);
  return lastMon.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// CLI parsing — supports --week, --limit, --dry-run (composable).
//   --week YYYY-MM-DD | --week=YYYY-MM-DD
//   --limit N         | --limit=N
//   --dry-run
// Unknown flags ignored (don't fail on them).
// ---------------------------------------------------------------

function parseArgs(argv) {
  let weekArg = null;
  let limit = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--week') {
      const next = argv[i + 1];
      if (typeof next === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next)) {
        weekArg = next;
        i++;
      }
    } else if (a.startsWith('--week=')) {
      const v = a.slice('--week='.length);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) weekArg = v;
    } else if (a === '--limit') {
      const next = argv[i + 1];
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) {
        limit = n;
        i++;
      }
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { weekArg, limit, dryRun };
}

// ---------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return 100 + Math.random() * 200; }

// ---------------------------------------------------------------
// Pure-function helpers (re-used by --smoke block)
// ---------------------------------------------------------------

// Normalize for postcode equality: strip ALL whitespace.
// Booli stores '176 71'; Hemnet stores '17671'. Both must compare equal.
function normalizePostcode(p) {
  return String(p).replace(/\s+/g, '');
}

// Lowercase + trim for street equality.
function normStreet(s) {
  return s == null ? '' : String(s).toLowerCase().trim();
}

// Match predicate (MTCH-03). Used inside processOne AND --smoke.
function cardMatches(card, booliStreetLower, booliListedSec) {
  if (!card.streetAddress || card.publishedAt == null) return false;
  if (card.upcoming === true) return false;
  if (normStreet(card.streetAddress) !== booliStreetLower) return false;
  return Math.abs(card.publishedAt - booliListedSec) <= SEVEN_DAYS_SEC;
}

// ---------------------------------------------------------------
// Field mapping (Apollo listing -> hemnet_listingv2 column tuple)
// IDENTICAL to Phase 7's locked map (hemnet-targeted-refresh.js).
// ---------------------------------------------------------------

function shapeListingForDb(listing) {
  const muniRaw = listing && listing.municipality && listing.municipality.fullName;
  const countyRaw = listing && listing.county && listing.county.fullName;

  const municipality =
    typeof muniRaw === 'string' ? muniRaw.replace(/\s+kommun$/i, '') : null;
  const county =
    typeof countyRaw === 'string' ? countyRaw.replace(/\s+län$/i, '') : null;

  return {
    times_viewed: listing.timesViewed != null ? listing.timesViewed : null,
    is_pre_market: listing.isUpcoming === true,
    street_address: listing.streetAddress != null ? listing.streetAddress : null,
    postcode: listing.postCode != null ? listing.postCode : null,
    municipality,
    county,
    published_at_seconds: listing.publishedAt != null ? listing.publishedAt : null,
  };
}

// ---------------------------------------------------------------
// per-county summary helpers
// ---------------------------------------------------------------

function bucket(summary, key) {
  const k = key || '(unknown)';
  if (!summary.perCounty[k]) {
    summary.perCounty[k] = { matched: 0, inserted: 0, errors: 0 };
  }
  return summary.perCounty[k];
}

// ---------------------------------------------------------------
// Within-run search-page cache + in-flight Promise dedup.
// Shape: getSearchPage(muniId, page) -> Card[]. The cache key is
// `${muniId}:${page}`. Multiple workers hitting the same page share a
// single fetchSearch dispatch via the in-flight registry.
// ---------------------------------------------------------------

async function getSearchPage(muniId, page, log, searchCache, searchInFlight) {
  const key = `${muniId}:${page}`;
  if (searchCache.has(key)) return searchCache.get(key);
  if (searchInFlight.has(key)) return searchInFlight.get(key);
  const promise = (async () => {
    try {
      const res = await fetchSearch(muniId, { page, sort: 'NEWEST', logger: log });
      const cards = (res && res.cards) ? res.cards : [];
      searchCache.set(key, cards);
      return cards;
    } finally {
      searchInFlight.delete(key);
    }
  })();
  searchInFlight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------
// Per-Booli-row pipeline.
// Wraps every step in its own try/catch; never throws out of the worker.
// ---------------------------------------------------------------

async function processOne(booli, client, log, dryRun, summary, searchCache, searchInFlight) {
  try {
    // 1. Validate booli.municipality string is present.
    if (!booli.municipality || typeof booli.municipality !== 'string' || booli.municipality.trim().length === 0) {
      summary.parseErrors++;
      bucket(summary, booli.county).errors++;
      log('WARN', `null-municipality booli_id=${booli.booli_id}`);
      return;
    }

    // 2. Resolve location_id (cache or harvester). Pass cron-wrapper's
    //    client so the harvester does NOT open a fresh DB connection.
    let muniId;
    try {
      muniId = await getLocationId(booli.municipality, { client, logger: log });
    } catch (err) {
      summary.fetchErrors++;
      bucket(summary, booli.county).errors++;
      log('ERROR', `harvest-failed booli_id=${booli.booli_id} muni="${booli.municipality}": ${err && err.message}`);
      return;
    }

    // 3. Paginate Hemnet search (max 3 pages) and apply match filter.
    const booliListedSec = Math.floor(new Date(booli.listed).getTime() / 1000);
    const booliStreetLower = normStreet(booli.title);
    let searchedThisRow = false;
    let chosen = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      let cards;
      try {
        cards = await getSearchPage(muniId, page, log, searchCache, searchInFlight);
      } catch (err) {
        summary.fetchErrors++;
        bucket(summary, booli.county).errors++;
        log('ERROR', `search-failed booli_id=${booli.booli_id} muni=${muniId} page=${page}: ${err && err.message}`);
        return;
      }
      if (!searchedThisRow) {
        summary.searched++;
        searchedThisRow = true;
      }
      if (cards.length === 0) break;

      // Match filter (MTCH-03)
      const candidates = cards.filter((c) => cardMatches(c, booliStreetLower, booliListedSec));

      if (candidates.length > 0) {
        // Tie-break on closest publishedAt (stable sort).
        chosen = candidates.slice().sort(
          (a, b) => Math.abs(a.publishedAt - booliListedSec) - Math.abs(b.publishedAt - booliListedSec),
        )[0];
        break;
      }

      // Early-exit (c): the OLDEST card on this page is past the window.
      // NEWEST sort -> oldest is typically the LAST card on the page; if its
      // publishedAt is already < booliListedSec - 7d, no later page helps.
      let oldest = null;
      for (const c of cards) {
        if (c.publishedAt != null && (oldest == null || c.publishedAt < oldest)) {
          oldest = c.publishedAt;
        }
      }
      if (oldest != null && oldest < booliListedSec - SEVEN_DAYS_SEC) break;
    }

    if (!chosen) return; // no match this row — already counted as searched

    summary.matchedFromSearch++;

    // 4. Fetch the chosen card's detail.
    let detail;
    try {
      detail = await fetchDetail(chosen.id, { logger: log });
    } catch (err) {
      summary.fetchErrors++;
      bucket(summary, booli.county).errors++;
      log('ERROR', `detail-failed booli_id=${booli.booli_id} hemnet_id=${chosen.id}: ${err && err.message}`);
      return;
    }

    if (detail.status !== 'active') {
      // A NEWEST search-card that comes back inactive on detail is a transient
      // race (Hemnet de-listed between search render and our detail fetch).
      summary.parseErrors++;
      bucket(summary, booli.county).errors++;
      log('WARN', `inactive-after-search booli_id=${booli.booli_id} hemnet_id=${chosen.id} reason=${detail.reason || 'unknown'}`);
      return;
    }

    summary.detailFetched++;
    const listing = detail.listing;

    // 5. Postcode validation gate (the critical Booli<->Hemnet contradiction
    //    guard — runs in dry-run too; only the UPSERT is conditional).
    const hp = listing.postCode;
    const bp = booli.postcode;
    let postcodeMarker;
    if (hp != null && bp != null) {
      if (normalizePostcode(hp) !== normalizePostcode(bp)) {
        summary.postcodeMismatch++;
        log('INFO', `postcode-mismatch booli_id=${booli.booli_id} booli=${bp} hemnet=${hp} hemnet_id=${listing.id}`);
        return; // do NOT UPSERT
      }
      postcodeMarker = `${hp} ✓`;
    } else if (hp == null) {
      postcodeMarker = '(null)';
      log('INFO', `postcode-null booli_id=${booli.booli_id} hemnet_id=${listing.id}`);
    } else { // bp == null (defensive — Booli FS rows are postcode-required upstream)
      postcodeMarker = `${hp} (booli-null)`;
      log('WARN', `booli-postcode-null booli_id=${booli.booli_id} hemnet_id=${listing.id}`);
    }

    // 6. Print the per-match URL block (REQUIRED for VERF-04 manual check).
    //    Both Booli and Hemnet URLs must appear so the user can open them
    //    side-by-side and confirm "same property".
    const listedDateStr =
      booli.listed instanceof Date
        ? booli.listed.toISOString().slice(0, 10)
        : String(booli.listed);
    log('INFO',
      `match booli_id=${booli.booli_id} "${booli.title}" listed=${listedDateStr} postcode=${bp} https://www.booli.se/bostad/${booli.booli_id}\n` +
      `   -> hemnet_id=${listing.id} published=${chosen.publishedAt} postCode=${postcodeMarker} https://www.hemnet.se/bostad/${listing.id}`,
    );

    // 7. UPSERT into hemnet_listingv2 (skip in dry-run).
    if (dryRun) return;

    const shaped = shapeListingForDb(listing);

    // UPDATE every row matching this hemnet_id — duplicate-row tolerant.
    // NO LIMIT clause anywhere: Phase 7 wet-run proved 22 rowsUpdated for 20
    // ids when 2 ids had duplicate rows; both copies need the fresh data.
    const upd = await client.query(
      `UPDATE hemnet_listingv2
          SET times_viewed   = $1,
              is_active      = true,
              is_pre_market  = $2,
              street_address = $3,
              postcode       = $4,
              municipality   = $5,
              county         = $6,
              listed         = to_timestamp($7)::date
        WHERE hemnet_id = $8
       RETURNING hemnet_id`,
      [
        shaped.times_viewed,
        shaped.is_pre_market,
        shaped.street_address,
        shaped.postcode,
        shaped.municipality,
        shaped.county,
        shaped.published_at_seconds,
        listing.id,
      ],
    );
    if (upd.rowCount > 0) {
      summary.rowsUpdated += upd.rowCount;
    } else {
      // No existing row — INSERT defensively (the typical Job B path).
      await client.query(
        `INSERT INTO hemnet_listingv2
           (hemnet_id, times_viewed, is_active, is_pre_market, street_address,
            postcode, municipality, county, listed)
         VALUES ($1, $2, true, $3, $4, $5, $6, $7, to_timestamp($8)::date)`,
        [
          listing.id,
          shaped.times_viewed,
          shaped.is_pre_market,
          shaped.street_address,
          shaped.postcode,
          shaped.municipality,
          shaped.county,
          shaped.published_at_seconds,
        ],
      );
      summary.rowsInserted++;
    }
    summary.inserted++;
    bucket(summary, booli.county).matched++;
    bucket(summary, booli.county).inserted++;
  } catch (err) {
    // Catch-all — should be rare given per-step try/catches above.
    summary.parseErrors++;
    bucket(summary, booli && booli.county).errors++;
    log('ERROR', `parse-failed booli_id=${booli && booli.booli_id}: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------
// main()
// ---------------------------------------------------------------

async function main(client, log) {
  const { weekArg, limit, dryRun } = parseArgs(process.argv);
  const startMs = Date.now();
  const dateStr = weekArg || defaultWeekDate();
  const { cohortId, weekStart, weekEnd } = getCohortWeek(dateStr);

  // 1. Booli FS candidates (MTCH-01) — identical filters to cohort-create.js:79-88
  //    plus ORDER BY booli_id for --limit reproducibility.
  const booliRes = await client.query(
    `SELECT booli_id, title, street_address, postcode, municipality, county,
            listed, times_viewed
       FROM booli_listing
      WHERE is_active = true
        AND is_pre_market = false
        AND listed >= $1::date
        AND listed <= $2::date
        AND county = ANY($3)
      ORDER BY booli_id`,
    [weekStart, weekEnd, BOOLI_COUNTIES],
  );
  let booliRows = booliRes.rows;
  if (limit != null) booliRows = booliRows.slice(0, limit);

  log('INFO',
    `cohortId=${cohortId} weekStart=${weekStart} weekEnd=${weekEnd} ` +
    `booliCount=${booliRows.length} dryRun=${!!dryRun} limited=${limit != null ? limit : 'null'}`,
  );

  // 2. Pre-allocate summary so all 16 flat keys are present.
  const summary = {
    booliCount: booliRows.length,
    searched: 0,
    matchedFromSearch: 0,
    detailFetched: 0,
    postcodeMismatch: 0,
    inserted: 0,
    parseErrors: 0,
    fetchErrors: 0,
    rowsUpdated: 0,
    rowsInserted: 0,
    perCounty: {},
    durationMs: 0,
    dryRun: !!dryRun,
    weekStart,
    weekEnd,
    cohortId,
    limited: limit != null ? limit : null,
  };

  // 3. Within-run search caches — lifetime = main() lifetime.
  const searchCache = new Map();
  const searchInFlight = new Map();

  // 4. Hand-rolled worker pool, concurrency 2 + 100-300ms jitter per dispatch.
  const queue = booliRows.slice();
  let processedCount = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (row == null) break;
      await sleep(jitter());
      await processOne(row, client, log, dryRun, summary, searchCache, searchInFlight);
      processedCount++;
      if (processedCount % 25 === 0) {
        log(
          'INFO',
          `processed ${processedCount}/${booliRows.length} ` +
          `(matched: ${summary.matchedFromSearch}, errors: ${summary.fetchErrors + summary.parseErrors})`,
        );
      }
    }
  }

  await Promise.all([worker(), worker()]);

  summary.durationMs = Date.now() - startMs;
  log('INFO', `Final: ${JSON.stringify(summary)}`);
  return summary;
}

// ---------------------------------------------------------------
// validate(summary) — MTCH-05 four-branch contract.
// Returns warning string or null.
// ---------------------------------------------------------------

function validate(summary) {
  if (summary.booliCount === 0) {
    return 'no Booli FS candidates in target counties for this week — query may be wrong or week is empty';
  }
  if (!summary.dryRun && summary.booliCount > 0 && (summary.inserted / summary.booliCount) < 0.5) {
    const pct = ((summary.inserted / summary.booliCount) * 100).toFixed(1);
    return `low match rate: ${summary.inserted}/${summary.booliCount} (${pct}%) — investigate before deploying`;
  }
  if (summary.booliCount > 0 && (summary.fetchErrors / summary.booliCount) > 0.05) {
    const pct = ((summary.fetchErrors / summary.booliCount) * 100).toFixed(1);
    return `high fetch error rate: ${summary.fetchErrors}/${summary.booliCount} (${pct}%)`;
  }
  if (summary.booliCount > 0 && (summary.postcodeMismatch / summary.booliCount) > 0.10) {
    const pct = ((summary.postcodeMismatch / summary.booliCount) * 100).toFixed(1);
    return `high postcode-mismatch rate: ${summary.postcodeMismatch}/${summary.booliCount} (${pct}%) — likely indicates address normalization is matching wrong properties at the same street name`;
  }
  return null;
}

// ---------------------------------------------------------------
// --smoke: pure-function self-test of normalizePostcode, cardMatches,
// and shapeListingForDb. No DB, no network. Used by Task 2 verify.
// Exits 0 on pass, 1 on fail. MUST short-circuit before runJob() below.
// ---------------------------------------------------------------

if (process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- postcode normalize ---
  check('postcode: 176 71 normalises to 17671', () => {
    assert.strictEqual(normalizePostcode('176 71'), '17671');
  });
  check('postcode: 17671 stays 17671', () => {
    assert.strictEqual(normalizePostcode('17671'), '17671');
  });
  check('postcode: cross-form equality (Booli vs Hemnet)', () => {
    assert.strictEqual(normalizePostcode('176 71'), normalizePostcode('17671'));
  });
  check('postcode: multi-space collapsed', () => {
    assert.strictEqual(normalizePostcode('176  71'), '17671');
  });
  check('postcode: leading/trailing trimmed', () => {
    assert.strictEqual(normalizePostcode('  176 71  '), '17671');
  });

  // --- match filter ---
  const booliListedSec = 1714521600; // 2026-04-30 fixed reference
  const booliStreetLower = 'storgatan 5';
  const SEVEN = 7 * 86400;
  const m = (card) => cardMatches(card, booliStreetLower, booliListedSec);

  check('match: case+trim equality, same publishedAt', () => {
    assert.strictEqual(m({ streetAddress: '  STORGATAN 5  ', publishedAt: booliListedSec, upcoming: false }), true);
  });
  check('match: different street rejected', () => {
    assert.strictEqual(m({ streetAddress: 'Annan väg 1', publishedAt: booliListedSec, upcoming: false }), false);
  });
  check('match: +7d boundary inclusive', () => {
    assert.strictEqual(m({ streetAddress: 'Storgatan 5', publishedAt: booliListedSec + SEVEN, upcoming: false }), true);
  });
  check('match: -7d boundary inclusive', () => {
    assert.strictEqual(m({ streetAddress: 'Storgatan 5', publishedAt: booliListedSec - SEVEN, upcoming: false }), true);
  });
  check('match: +7d + 1s rejected', () => {
    assert.strictEqual(m({ streetAddress: 'Storgatan 5', publishedAt: booliListedSec + SEVEN + 1, upcoming: false }), false);
  });
  check('match: null streetAddress rejected', () => {
    assert.strictEqual(m({ streetAddress: null, publishedAt: booliListedSec, upcoming: false }), false);
  });
  check('match: null publishedAt rejected', () => {
    assert.strictEqual(m({ streetAddress: 'Storgatan 5', publishedAt: null, upcoming: false }), false);
  });
  check('match: upcoming=true rejected', () => {
    assert.strictEqual(m({ streetAddress: 'Storgatan 5', publishedAt: booliListedSec, upcoming: true }), false);
  });

  // --- field mapping (4 counties + null) ---
  const mapCases = [
    { in: { municipality: { fullName: 'Järfälla kommun' }, county: { fullName: 'Stockholms län' },
            streetAddress: 'Filarvägen 3', postCode: '17671', timesViewed: 1234, isUpcoming: false, publishedAt: 1714521600 },
      out: { municipality: 'Järfälla', county: 'Stockholms', street_address: 'Filarvägen 3', postcode: '17671',
             times_viewed: 1234, is_pre_market: false, published_at_seconds: 1714521600 } },
    { in: { municipality: { fullName: 'Göteborgs kommun' }, county: { fullName: 'Västra Götalands län' },
            streetAddress: 'X', postCode: '40000', timesViewed: 0, isUpcoming: true, publishedAt: 1 },
      out: { municipality: 'Göteborgs', county: 'Västra Götalands' } },
    { in: { municipality: { fullName: 'Malmö kommun' }, county: { fullName: 'Skåne län' },
            streetAddress: 'Y', postCode: '20000', timesViewed: 5, isUpcoming: false, publishedAt: 2 },
      out: { municipality: 'Malmö', county: 'Skåne' } },
    { in: { municipality: { fullName: 'Uppsala kommun' }, county: { fullName: 'Uppsala län' },
            streetAddress: 'Z', postCode: '75000', timesViewed: 10, isUpcoming: false, publishedAt: 3 },
      out: { municipality: 'Uppsala', county: 'Uppsala' } },
    { in: { municipality: { fullName: null }, county: { fullName: null },
            streetAddress: null, postCode: null, timesViewed: null, isUpcoming: false, publishedAt: null },
      out: { municipality: null, county: null } },
  ];
  for (const c of mapCases) {
    check(`map: muni=${c.in.municipality.fullName} county=${c.in.county.fullName}`, () => {
      const got = shapeListingForDb(c.in);
      for (const k of Object.keys(c.out)) {
        assert.strictEqual(got[k], c.out[k], `field ${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(c.out[k])}`);
      }
    });
  }

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

runJob({ scriptName: 'hemnet-targeted-match', main, validate });
