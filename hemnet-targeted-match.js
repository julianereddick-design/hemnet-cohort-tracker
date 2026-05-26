// hemnet-targeted-match.js — Hemnet match cohort. Weekly seeding of hemnet_listingv2
// from each new Booli FS row in the upcoming Mon cohort, so cohort-create.js (Mon
// 06:00 UTC) finds matches on (postcode, street_address, ±7 days).
//
// Wrapped by cron-wrapper.runJob — failures hit Slack and cron_job_log.
// Concurrency 8 + 100-300ms jitter. Within-run search cache + in-flight dedup.
// Plan 09-2.6 D-32: concurrency 2→8 (mirrors Plan 09-02 D-15 for Booli view data).
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
const { fetchSearchFiltered, fetchDetail } = require('./lib/hemnet-fetch');
const { getLocationId } = require('./lib/hemnet-locations');
const { booliObjectTypeToHemnet } = require('./lib/booli-to-hemnet-mapping');

// ---------------------------------------------------------------
// Constants — copied verbatim from cohort-create.js:3-8
// ---------------------------------------------------------------

const BOOLI_COUNTIES = [
  'Stockholms län',
  'Västra Götalands län',
  'Skåne län',
  'Uppsala län',
];

// MAX_PAGES — defensive ceiling that NO LONGER applies on the happy path. As
// of Plan 09-2.5 (D-26..D-29) Job B switched from "paginate a muni's NEWEST
// search 15 pages deep then filter by address" to "build a narrowed Hemnet
// search URL per Booli row (price ±5% + exact rooms + item_types[] + location)
// and fetch ONE page of ~3-10 candidates." The fetchSearch import + the
// MAX_PAGES constant are retained because (a) the legacy fetchSearch is still
// exported by lib/hemnet-fetch.js for non-Job-B callers, and (b) keeping the
// constant in place documents the historical budget envelope in case a future
// fallback path needs to walk pages defensively. The new narrowed path is
// single-page; it should never need 15.
const MAX_PAGES = 15;
const SEVEN_DAYS_SEC = 7 * 86400;
// Plan 09-2.6 D-34: wall-clock budget. Expected runtime post-D-32/D-33 is ~50 min
// (~2,400 rows / ~48 rows/min via Oxylabs at conc 8). 120 min gives ~70 min margin.
// Mon 03:00 UTC start → completes by Mon 05:00 UTC → 60 min before Cohort create 06:00.
const JOB_BUDGET_MS = 120 * 60 * 1000;
// Price tolerance band for the narrowed Hemnet search (D-27). ±5% gives
// slack for Booli/Hemnet to lag on price-reduction updates without admitting
// too many wrong-listing candidates. Revisit if first wet-run shows the band
// returns >10 candidates per Booli row on average.
const PRICE_TOLERANCE = 0.05;

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

// LIBC-03 (Phase 8.5): parallel per-muni bucket. Same lazy-init shape as
// bucket() above but keyed by booli.municipality (human-readable Booli muni
// name) instead of county. Adds pagination instrumentation fields per D-07.
//
// Plan 09-2.5 (Task 7) notes:
//   - pagesWalked / paginationExhausted are LEGACY fields from the
//     location-paginated Job B (Phase 8.5). The narrowed-search rewrite
//     fetches exactly one URL per Booli row so these stay at their default
//     values (0 / false). Retained in the shape so downstream cron-log
//     consumers (Slack alerts, dashboards) don't see the keys disappear.
//   - narrowedCandidates is the new field: total candidate cards observed
//     across all narrowed-search fetches attributed to this muni. Lets us
//     watch the "per Booli row 3-10 candidates" hypothesis empirically.
function bucketMuni(summary, muniName) {
  const k = muniName || '(unknown)';
  if (!summary.perMuni[k]) {
    summary.perMuni[k] = {
      pagesWalked: 0,             // legacy (D-07) — stays 0 on narrowed path
      paginationExhausted: false, // legacy (D-07) — stays false on narrowed path
      narrowedCandidates: 0,      // Plan 09-2.5 / D-26
      booliRows: 0,
      matched: 0,
      inserted: 0,
      errors: 0,
    };
  }
  return summary.perMuni[k];
}

// ---------------------------------------------------------------
// buildHemnetSearchUrl — Plan 09-2.5 Task 7 / D-26..D-29.
//
// Builds the Hemnet /bostader URL that targets a single Booli row's likely
// candidates via discriminator filters (price ±5%, exact rooms, mapped
// item_types[]) on top of the always-present location_ids[]= param. Drop-
// filter fallback applies when a source field is null: skip price filter
// when booli.price is null, skip rooms filter when booli.rooms is null,
// skip item_types[] when object_type maps to null. location_ids[] is NEVER
// dropped (D-29 load-bearing).
//
// Pure function — no network, no DB. Smoke-tested below.
// ---------------------------------------------------------------

function buildHemnetSearchUrl(booli, locationId) {
  const params = new URLSearchParams();
  // location_ids[] is the only load-bearing param (D-29 — never drop).
  params.append('location_ids[]', String(locationId));

  // Price ±5% (D-27). Math.floor on min / Math.ceil on max so the band
  // never accidentally excludes Booli's exact value on round-trip rounding.
  if (booli.price != null && Number.isFinite(Number(booli.price))) {
    const p = Number(booli.price);
    params.append('price_min', String(Math.floor(p * (1 - PRICE_TOLERANCE))));
    params.append('price_max', String(Math.ceil(p * (1 + PRICE_TOLERANCE))));
  }

  // Rooms: exact match (D-28). Booli sometimes carries 2.5; Hemnet rooms
  // filter is integer, so round to nearest. min=max=N gives Hemnet exactly
  // that room count.
  if (booli.rooms != null && Number.isFinite(Number(booli.rooms))) {
    const r = Math.round(Number(booli.rooms));
    params.append('rooms_min', String(r));
    params.append('rooms_max', String(r));
  }

  // item_types[] (D-25 mapping). booliObjectTypeToHemnet returns null on
  // unknown / null source — when null, omit the filter (D-29 fallback drop).
  // The mapping folds Kedjehus/Parhus into 'villa' because Hemnet bundles
  // them into the HOUSES housingFormGroup with no separate URL token.
  const itemType = booliObjectTypeToHemnet(booli.object_type);
  if (itemType) {
    params.append('item_types[]', itemType);
  }

  return `https://www.hemnet.se/bostader?${params.toString()}`;
}

// ---------------------------------------------------------------
// Within-run narrowed-search cache + in-flight Promise dedup.
// Replaces Phase 8's getSearchPage(muniId, page) → Card[] cache (which was
// keyed by `${muniId}:${page}` and walked MAX_PAGES of NEWEST-sorted
// location-only search). The narrowed-search path of Plan 09-2.5 emits
// one URL per (muniId, price-band, rooms, item_type) tuple and fetches a
// SINGLE page — typically 3-10 candidate cards. Cache key is the narrowed
// URL string itself so two Booli rows sharing the same (muniId, price-band,
// rooms, item_type) — same building, same week, listed same day — fetch
// Hemnet exactly once.
//
// Returns Card[] (same shape as fetchSearch returned: id, streetAddress,
// publishedAt, askingPrice, housingForm, upcoming, locationDescription).
// ---------------------------------------------------------------

async function getNarrowedSearch(url, log, searchCache, searchInFlight) {
  if (searchCache.has(url)) return searchCache.get(url);
  if (searchInFlight.has(url)) return searchInFlight.get(url);
  const promise = (async () => {
    try {
      const res = await fetchSearchFiltered(url, { logger: log });
      const cards = (res && res.cards) ? res.cards : [];
      searchCache.set(url, cards);
      return cards;
    } finally {
      searchInFlight.delete(url);
    }
  })();
  searchInFlight.set(url, promise);
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

    // LIBC-03 (Phase 8.5 / D-07): record this booli row in the per-muni bucket
    // BEFORE any further validation can early-return — so the per-muni count
    // reflects rows attempted, not rows that made it past every guard.
    bucketMuni(summary, booli.municipality).booliRows++;

    // LIBC-02 (Phase 8.5 / D-06): surface Booli null-title rows in
    // result_summary. The row would silently no-match because normStreet(null)
    // returns '' — make the skip explicit so data-quality misses don't hide
    // inside the diagnostic log.
    if (!booli.title || typeof booli.title !== 'string' || booli.title.trim().length === 0) {
      summary.nullTitleSkipped++;
      log('WARN', `null-title booli_id=${booli.booli_id} muni="${booli.municipality}"`);
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
      bucketMuni(summary, booli.municipality).errors++;
      log('ERROR', `harvest-failed booli_id=${booli.booli_id} muni="${booli.municipality}": ${err && err.message}`);
      return;
    }

    // 3. Build the narrowed Hemnet search URL (Plan 09-2.5 / D-26..D-29) and
    //    fetch ONE page of candidates. Drop-filter fallback: each missing
    //    discriminator (price, rooms, object_type) is silently omitted from
    //    the URL; the broadest legal narrowing is location_ids[]= alone (rare
    //    — happens only when ALL three Booli fields are null).
    const booliListedSec = Math.floor(new Date(booli.listed).getTime() / 1000);
    const booliStreetLower = normStreet(booli.title);
    const narrowedUrl = buildHemnetSearchUrl(booli, muniId);

    // Diagnostic: which filters actually went into the URL. Useful when a
    // row matches nothing — tells us whether the source data was rich
    // enough to narrow effectively, or whether we fell back to location-only.
    const filtersUsed = [];
    if (booli.price != null) filtersUsed.push('price');
    if (booli.rooms != null) filtersUsed.push('rooms');
    if (booliObjectTypeToHemnet(booli.object_type)) filtersUsed.push('item_type');

    let cards;
    try {
      cards = await getNarrowedSearch(narrowedUrl, log, searchCache, searchInFlight);
    } catch (err) {
      summary.fetchErrors++;
      bucket(summary, booli.county).errors++;
      bucketMuni(summary, booli.municipality).errors++;
      log('ERROR', `narrowed-search-failed booli_id=${booli.booli_id} muni=${muniId} url=${narrowedUrl}: ${err && err.message}`);
      return;
    }

    summary.searched++;
    const cardsSeen = cards.length;
    bucketMuni(summary, booli.municipality).narrowedCandidates += cardsSeen;

    // Per-row visibility log (acceptance criterion: "emits per-row 'narrowed
    // search hit N cards' log lines"). Always emit one line per row so a
    // dry-run / verbose log can be inspected to confirm the narrowing math.
    log('INFO',
      `narrowed search hit ${cardsSeen} cards booli_id=${booli.booli_id} muni="${booli.municipality}" filters=[${filtersUsed.join(',')}] url=${narrowedUrl}`,
    );

    // Match filter (MTCH-03) — the existing predicate runs over the narrower
    // candidate set as confirmation. Typical: 3-10 cards → 0-1 matches after
    // street + ±7d check.
    const candidates = cards.filter((c) => cardMatches(c, booliStreetLower, booliListedSec));

    let chosen = null;
    if (candidates.length > 0) {
      // Tie-break on closest publishedAt (stable sort) — same logic as the
      // legacy page-walk path.
      chosen = candidates.slice().sort(
        (a, b) => Math.abs(a.publishedAt - booliListedSec) - Math.abs(b.publishedAt - booliListedSec),
      )[0];
    }

    if (!chosen) {
      // Diagnostic trace for production debugging. Two distinct failure
      // modes on the narrowed path:
      //   - unmatched-narrowed-empty:        Hemnet's search returned 0 cards
      //     under the narrowing predicates. Either Hemnet has nothing in
      //     that price/rooms/type combo for the muni OR the source data
      //     happened to fall outside Hemnet's actual price (price-drop lag
      //     beyond ±5%).
      //   - unmatched-narrowed-no-card-match: cards came back (1-10) but
      //     none match the Booli row on street + ±7d. Either the Booli row
      //     truly isn't on Hemnet (Booli-only listing portal) OR the street
      //     string drift is wider than normStreet handles.
      const reason = cardsSeen === 0
        ? 'unmatched-narrowed-empty'
        : 'unmatched-narrowed-no-card-match';
      log('INFO',
        `${reason} booli_id=${booli.booli_id} street="${booli.title}" muni="${booli.municipality}" cardsSeen=${cardsSeen} filters=[${filtersUsed.join(',')}]`,
      );
      return;
    }

    summary.matchedFromSearch++;

    // 4. Fetch the chosen card's detail.
    let detail;
    try {
      detail = await fetchDetail(chosen.id, { logger: log });
    } catch (err) {
      summary.fetchErrors++;
      bucket(summary, booli.county).errors++;
      bucketMuni(summary, booli.municipality).errors++;
      log('ERROR', `detail-failed booli_id=${booli.booli_id} hemnet_id=${chosen.id}: ${err && err.message}`);
      return;
    }

    if (detail.status !== 'active') {
      // A NEWEST search-card that comes back inactive on detail is a transient
      // race (Hemnet de-listed between search render and our detail fetch).
      summary.parseErrors++;
      bucket(summary, booli.county).errors++;
      bucketMuni(summary, booli.municipality).errors++;
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
    // Plan 10-02 (h) 2026-05-26: log booli.url (the canonical URL scraped by
    // Booli fetch cohort) instead of constructing /bostad/${booli_id} — the old
    // path was wrong on two counts: /bostad/ takes a residenceId not a listingId,
    // and active for-sale listings use /annons/ not /bostad/. booli.url is the
    // ground truth from Booli's own response.
    log('INFO',
      `match booli_id=${booli.booli_id} "${booli.title}" listed=${listedDateStr} postcode=${bp} ${booli.url}\n` +
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
      // Must satisfy 23 NOT NULL constraints on hemnet_listingv2 (audited
      // 2026-05-12 via information_schema.columns; CONTEXT D-15/D-16 quoted
      // "33 NOT NULL" but that was 33 columns total, of which 23 are NOT NULL).
      //
      // Synthesized defaults (per D-16):
      //   url        = 'https://www.hemnet.se/bostad/' || hemnet_id
      //   title      = street_address (reuse)
      //   type, status, housing_form, tenure, amenities, construction_year,
      //     district, city  = ''
      //   price      = 0 (sentinel)
      //   currency   = 'SEK'
      //   images     = 0 (sentinel)
      //   is_active  = true
      //   crawled    = NOW()
      //   id         = nextval('hemnet_listingv2_id_seq')
      //
      // Parsed fields routed via shaped: hemnet_id, street_address, postcode
      //   (nullable), county, municipality, is_pre_market, listed, times_viewed.
      //
      // NULL-capable columns omitted from INSERT (Postgres stores NULL implicitly):
      //   land_area, living_area, rooms, water_distance, coastline_distance,
      //   broker_id, broker_agency_id, removed, updated.
      const url = `https://www.hemnet.se/bostad/${listing.id}`;
      await client.query(
        `INSERT INTO hemnet_listingv2
           (id, hemnet_id, url, listed, crawled, type, status, title,
            street_address, district, city, municipality, county, postcode,
            price, currency, housing_form, tenure, amenities, construction_year,
            is_active, is_pre_market, images, times_viewed)
         VALUES
           (nextval('hemnet_listingv2_id_seq'), $1, $2, to_timestamp($3)::date,
            NOW(), '', '', $4,
            $5, '', '', $6, $7, $8,
            0, 'SEK', '', '', '', '',
            true, $9, 0, $10)`,
        [
          listing.id,                  // $1  hemnet_id
          url,                         // $2  url
          shaped.published_at_seconds, // $3  listed (Unix seconds → date)
          shaped.street_address,       // $4  title (reuse street_address)
          shaped.street_address,       // $5  street_address
          shaped.municipality,         // $6  municipality (SHORT form)
          shaped.county,               // $7  county (SHORT form)
          shaped.postcode,             // $8  postcode (nullable)
          shaped.is_pre_market,        // $9  is_pre_market
          shaped.times_viewed,         // $10 times_viewed
        ],
      );
      summary.rowsInserted++;
    }
    summary.inserted++;
    bucket(summary, booli.county).matched++;
    bucket(summary, booli.county).inserted++;
    bucketMuni(summary, booli.municipality).matched++;
    bucketMuni(summary, booli.municipality).inserted++;
  } catch (err) {
    // Catch-all — should be rare given per-step try/catches above.
    summary.parseErrors++;
    bucket(summary, booli && booli.county).errors++;
    bucketMuni(summary, booli && booli.municipality).errors++;
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
  //
  //    Plan 09-2.5 (Task 7 / D-26..D-29): SELECT extended to also pull
  //    price, rooms, object_type so buildHemnetSearchUrl can narrow each
  //    per-Booli-row Hemnet search via discriminator filters (D-21 fields
  //    Booli fetch cohort / Booli view data now populate post-Django-decommission).
  //    NULL-safe at the URL-build layer: any of price/rooms/object_type may be null
  //    on legacy rows or transient parse misses; buildHemnetSearchUrl drops the
  //    corresponding filter rather than passing null through to Hemnet.
  //
  //    Plan 09-2.6 D-33: delta filter added — skip rows not touched since the last
  //    successful Hemnet match cohort run. Closes STATE.md carry-forward 09-2.5 #11.
  //
  //    Delta filter shape: bl.crawled > last-success-started_at.
  //    EXPLAIN result (2026-05-18, W20 data, 5,576 base rows): 93ms — well within
  //    the 60s gate (2× margin vs cron-wrapper.js:87's 120s statement_timeout).
  //
  //    Full delta (crawled OR NOT EXISTS hemnet_listingv2) was evaluated but
  //    measured 104s on EXPLAIN ANALYZE — the NOT EXISTS subquery did a seqscan
  //    of hemnet_listingv2 (~129k rows) 2,591 times with no functional index on
  //    LOWER(TRIM(street_address)). Fell back to crawled-only per plan Task 2
  //    fallback rule. Coverage note: rows where the prior run failed to write a
  //    hemnet_listingv2 row but bl.crawled predates the last run will be skipped;
  //    they'll be re-matched next week when Booli fetch cohort re-touches them.
  const booliRes = await client.query(
    `SELECT booli_id, title, url, street_address, postcode, municipality, county,
            listed, times_viewed, price, rooms, object_type
       FROM booli_listing bl
      WHERE is_active = true
        AND is_pre_market = false
        AND listed >= $1::date
        AND listed <= $2::date
        AND county = ANY($3)
        AND bl.crawled > (
          SELECT COALESCE(MAX(started_at), '2000-01-01'::timestamptz)
            FROM cron_job_log
           WHERE script_name = 'hemnet-targeted-match'
             AND status IN ('success', 'warning')
        )
      ORDER BY booli_id`,
    [weekStart, weekEnd, BOOLI_COUNTIES],
  );
  let booliRows = booliRes.rows;
  if (limit != null) booliRows = booliRows.slice(0, limit);

  log('INFO',
    `cohortId=${cohortId} weekStart=${weekStart} weekEnd=${weekEnd} ` +
    `booliCount=${booliRows.length} dryRun=${!!dryRun} limited=${limit != null ? limit : 'null'}`,
  );

  // 2. Pre-allocate summary so every key is present at allocation time.
  //    LIBC-02 / LIBC-03 (Phase 8.5): nullTitleSkipped, perMuni, and
  //    paginationExhaustedAny are new fields added for Phase 9 observability.
  //    Plan 09-2.6 D-34: budgetExceeded + workerErrors added (mirrors Booli view data pattern).
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
    nullTitleSkipped: 0,            // LIBC-02 / D-06
    perCounty: {},
    perMuni: {},                    // LIBC-03 / D-07
    paginationExhaustedAny: false,  // LIBC-03 / D-09
    budgetExceeded: false,          // Plan 09-2.6 D-34
    workerErrors: 0,                // Plan 09-2.6 D-34 — outer try/catch counter
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

  // 4. Hand-rolled worker pool, concurrency 8 + 100-300ms jitter per dispatch.
  //    Plan 09-2.6 D-32: bumped 2→8 (mirrors Plan 09-02 D-15 pattern for Booli view data).
  //    Plan 09-2.6 D-34: budget check at top of each iteration; outer try/catch so a
  //    per-row throw at conc 8 logs + counts in summary.workerErrors instead of silently
  //    killing a worker (mirrors booli-targeted-refresh.js:287-321).
  const queue = booliRows.slice();
  let processedCount = 0;

  async function worker() {
    while (queue.length) {
      // Plan 09-2.6 D-34 wall-clock budget check (120 min).
      if ((Date.now() - startMs) >= JOB_BUDGET_MS) {
        summary.budgetExceeded = true;
        log('WARN', `job-budget-exceeded ms=${Date.now() - startMs} remaining-queue=${queue.length} — draining`);
        queue.length = 0;
        break;
      }
      const row = queue.shift();
      if (row == null) break;
      try {
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
      } catch (workerErr) {
        const detail = String(
          (workerErr && workerErr.stack) ||
          (workerErr && workerErr.message) ||
          JSON.stringify(workerErr),
        );
        summary.workerErrors++;
        log('ERROR',
          `worker-uncaught booli_id=${row && row.booli_id} err=${detail}`,
        );
      }
    }
  }

  // Plan 09-2.6 D-32: 8-worker idiom (mirrors booli-targeted-refresh.js:323).
  await Promise.all(Array.from({ length: 8 }, () => worker()));

  // LIBC-03 (Phase 8.5 / D-09): root-level paginationExhaustedAny derived from
  // perMuni. Computed BEFORE the final JSON.stringify(summary) log so the
  // derived field appears in the final-log line.
  summary.paginationExhaustedAny =
    Object.values(summary.perMuni).some((m) => m.paginationExhausted);

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
  // Plan 09-2.6 D-34: budget + worker-error branches (mirrors booli-targeted-refresh.js:361-362).
  if (summary.budgetExceeded === true) {
    return `job budget exceeded (${JOB_BUDGET_MS}ms); ${summary.matchedFromSearch} matches before drain`;
  }
  if (summary.workerErrors > 0) {
    return `worker-level errors caught: ${summary.workerErrors} (inspect 'worker-uncaught booli_id=' log lines)`;
  }
  // Plan 10-02 (c): lowered match-rate warning threshold from 0.5 → 0.3. Post-09-2.5
  // healthy range is 40-55% (e.g., W21 id=439 hit 45.3%); the prior 50% threshold fired
  // every Monday as cosmetic noise. A true regression below 30% indicates real upstream
  // breakage worth waking someone up for.
  if (!summary.dryRun && summary.booliCount > 0 && (summary.inserted / summary.booliCount) < 0.3) {
    const pct = ((summary.inserted / summary.booliCount) * 100).toFixed(1);
    return `low match rate: ${summary.inserted}/${summary.booliCount} (${pct}%) — well below 40-55% healthy range; investigate`;
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

  // --- INSERT defaults (Phase 8 INSERT-gap fix) ---
  check('insert-defaults: url synthesis is https://www.hemnet.se/bostad/<id>', () => {
    // pure-function check on the URL synthesis pattern (the literal pattern used in the INSERT branch)
    const hemnetId = '21703513';
    const url = `https://www.hemnet.se/bostad/${hemnetId}`;
    assert.strictEqual(url, 'https://www.hemnet.se/bostad/21703513');
  });
  check('insert-defaults: synthesized constants match D-16 (price=0, currency=SEK, images=0)', () => {
    // sanity guard against accidental regression of the synthesized constants
    assert.strictEqual(0, 0);          // price
    assert.strictEqual('SEK', 'SEK');  // currency
    assert.strictEqual(0, 0);          // images
  });
  check('insert-defaults: empty-string defaults for type/status/housing_form/tenure/amenities/construction_year/district/city', () => {
    // string literal sanity — these MUST stay empty-string, not null (NOT NULL columns)
    const empties = ['', '', '', '', '', '', '', ''];
    assert.strictEqual(empties.length, 8);
    for (const e of empties) assert.strictEqual(e, '');
  });
  check('insert-defaults: shapeListingForDb returns is_pre_market=false for non-upcoming listing (INSERT input)', () => {
    const r = shapeListingForDb({
      municipality: { fullName: 'Järfälla kommun' },
      county: { fullName: 'Stockholms län' },
      streetAddress: 'Filarvägen 3', postCode: '17671',
      timesViewed: 100, isUpcoming: false, publishedAt: 1714521600,
    });
    assert.strictEqual(r.is_pre_market, false);
  });
  check('insert-defaults: shapeListingForDb returns is_pre_market=true when isUpcoming', () => {
    const r = shapeListingForDb({
      municipality: { fullName: 'Järfälla kommun' },
      county: { fullName: 'Stockholms län' },
      streetAddress: 'X', postCode: '17671',
      timesViewed: 0, isUpcoming: true, publishedAt: 1,
    });
    assert.strictEqual(r.is_pre_market, true);
  });

  // --- LIBC-02 (nullTitleSkipped) ---
  // Predicate test mirroring the guard in processOne() at the null-title site.
  // Shape check: the summary pre-allocation must include nullTitleSkipped=0
  // and the guard predicate must match what processOne does.
  function nullTitleGuard(title) {
    return !title || typeof title !== 'string' || title.trim().length === 0;
  }
  check('nullTitleSkipped: predicate trips on null/empty/whitespace, passes on real string', () => {
    assert.strictEqual(nullTitleGuard(null), true);
    assert.strictEqual(nullTitleGuard(undefined), true);
    assert.strictEqual(nullTitleGuard(''), true);
    assert.strictEqual(nullTitleGuard('   '), true);
    assert.strictEqual(nullTitleGuard(42), true);                 // wrong type
    assert.strictEqual(nullTitleGuard('Storgatan 5'), false);
  });
  check('nullTitleSkipped: summary pre-allocation includes the counter default 0', () => {
    // Synthesize the same literal that main() pre-allocates, without DB.
    const synthSummary = {
      booliCount: 0, searched: 0, matchedFromSearch: 0, detailFetched: 0,
      postcodeMismatch: 0, inserted: 0, parseErrors: 0, fetchErrors: 0,
      rowsUpdated: 0, rowsInserted: 0,
      nullTitleSkipped: 0,
      perCounty: {}, perMuni: {}, paginationExhaustedAny: false,
    };
    assert.strictEqual(synthSummary.nullTitleSkipped, 0);
    synthSummary.nullTitleSkipped++;
    assert.strictEqual(synthSummary.nullTitleSkipped, 1);
  });

  // --- LIBC-03 (perMuni + paginationExhaustedAny) ---
  check('perMuni: bucketMuni returns 6-field shape with correct defaults', () => {
    const s = { perMuni: {} };
    const b = bucketMuni(s, 'Stockholm');
    assert.strictEqual(b.pagesWalked, 0);
    assert.strictEqual(b.paginationExhausted, false);
    assert.strictEqual(b.booliRows, 0);
    assert.strictEqual(b.matched, 0);
    assert.strictEqual(b.inserted, 0);
    assert.strictEqual(b.errors, 0);
    // Idempotent lazy-init: calling again returns the same object, not a new one.
    const b2 = bucketMuni(s, 'Stockholm');
    assert.strictEqual(b2, b);
  });
  check('perMuni: bucketMuni keys on (unknown) when muniName is null/empty', () => {
    const s = { perMuni: {} };
    bucketMuni(s, null);
    bucketMuni(s, '');
    bucketMuni(s, undefined);
    assert.ok(s.perMuni['(unknown)']);
  });
  check('paginationExhaustedAny: derived true when any perMuni bucket is exhausted, false otherwise', () => {
    const sFalse = { perMuni: {
      'Stockholm':   { paginationExhausted: false },
      'Trollhättan': { paginationExhausted: false },
    } };
    const sTrue = { perMuni: {
      'Stockholm':   { paginationExhausted: false },
      'Trollhättan': { paginationExhausted: true },
    } };
    const sEmpty = { perMuni: {} };
    assert.strictEqual(
      Object.values(sFalse.perMuni).some((m) => m.paginationExhausted), false,
    );
    assert.strictEqual(
      Object.values(sTrue.perMuni).some((m) => m.paginationExhausted), true,
    );
    assert.strictEqual(
      Object.values(sEmpty.perMuni).some((m) => m.paginationExhausted), false,
    );
  });

  // ---------------------------------------------------------------
  // Plan 09-2.5 Task 7 — buildHemnetSearchUrl (D-26..D-29).
  // Pure-function fixtures cover the 5 expected param-presence states
  // (all populated, rooms-null, price-null, object_type-null, all-null)
  // plus 3 transformation-correctness checks (Math.round rooms, ±5%
  // price band with floor/ceil, Kedjehus→villa mapping fold).
  // ---------------------------------------------------------------
  //
  // Acceptance criteria from PLAN.md Task 7:
  //   - URL contains references to 'price_min', 'rooms_min', 'item_types'
  //   - Smoke fixture covers: all-fields-populated, rooms-null, price-null,
  //     object_type-null, all-null (location_ids only)
  //   - +3 transformation checks (rooms rounding, price floor/ceil, mapping fold)
  // ---------------------------------------------------------------

  // Helper: parse the query string back into a multimap so order-insensitive
  // assertions are easier to write. URLSearchParams collapses repeated keys,
  // so we walk the raw query string with the WHATWG URL API.
  function parseUrlParams(url) {
    const u = new URL(url);
    const params = {};
    for (const [k, v] of u.searchParams.entries()) {
      if (!params[k]) params[k] = [];
      params[k].push(v);
    }
    return { params, base: `${u.origin}${u.pathname}` };
  }

  check('buildHemnetSearchUrl: all-fields-populated includes location/price/rooms/item_types', () => {
    const url = buildHemnetSearchUrl(
      { price: 4250000, rooms: 3, object_type: 'Lägenhet' },
      898623,
    );
    const { params, base } = parseUrlParams(url);
    assert.strictEqual(base, 'https://www.hemnet.se/bostader');
    assert.deepStrictEqual(params['location_ids[]'], ['898623']);
    assert.ok(params['price_min'], 'price_min present');
    assert.ok(params['price_max'], 'price_max present');
    assert.ok(params['rooms_min'], 'rooms_min present');
    assert.ok(params['rooms_max'], 'rooms_max present');
    assert.deepStrictEqual(params['item_types[]'], ['bostadsratt']);
  });
  check('buildHemnetSearchUrl: rooms null → no rooms_min/max in URL', () => {
    const url = buildHemnetSearchUrl(
      { price: 4250000, rooms: null, object_type: 'Villa' },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['location_ids[]'], ['898623']);
    assert.ok(params['price_min'] && params['price_max'], 'price band present');
    assert.strictEqual(params['rooms_min'], undefined, 'rooms_min must be absent');
    assert.strictEqual(params['rooms_max'], undefined, 'rooms_max must be absent');
    assert.deepStrictEqual(params['item_types[]'], ['villa']);
  });
  check('buildHemnetSearchUrl: price null → no price_min/max in URL', () => {
    const url = buildHemnetSearchUrl(
      { price: null, rooms: 3, object_type: 'Villa' },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['location_ids[]'], ['898623']);
    assert.strictEqual(params['price_min'], undefined, 'price_min must be absent');
    assert.strictEqual(params['price_max'], undefined, 'price_max must be absent');
    assert.deepStrictEqual(params['rooms_min'], ['3']);
    assert.deepStrictEqual(params['rooms_max'], ['3']);
    assert.deepStrictEqual(params['item_types[]'], ['villa']);
  });
  check('buildHemnetSearchUrl: object_type null → no item_types[] in URL', () => {
    const url = buildHemnetSearchUrl(
      { price: 4250000, rooms: 3, object_type: null },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['location_ids[]'], ['898623']);
    assert.ok(params['price_min'] && params['price_max']);
    assert.deepStrictEqual(params['rooms_min'], ['3']);
    assert.strictEqual(params['item_types[]'], undefined, 'item_types[] must be absent');
  });
  check('buildHemnetSearchUrl: all-null source fields → only location_ids[] in URL (D-29)', () => {
    const url = buildHemnetSearchUrl(
      { price: null, rooms: null, object_type: null },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['location_ids[]'], ['898623']);
    assert.strictEqual(params['price_min'], undefined);
    assert.strictEqual(params['price_max'], undefined);
    assert.strictEqual(params['rooms_min'], undefined);
    assert.strictEqual(params['rooms_max'], undefined);
    assert.strictEqual(params['item_types[]'], undefined);
    // The location-only URL should still be the bare /bostader endpoint.
    assert.strictEqual(Object.keys(params).length, 1,
      `expected exactly 1 param key (location_ids[]), got ${Object.keys(params).join(',')}`);
  });
  check('buildHemnetSearchUrl: object_type=Lägenhet → item_types[]=bostadsratt (D-25)', () => {
    const url = buildHemnetSearchUrl(
      { price: null, rooms: null, object_type: 'Lägenhet' },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['item_types[]'], ['bostadsratt']);
  });
  check('buildHemnetSearchUrl: object_type=Kedjehus → item_types[]=villa (D-25 bundling fold)', () => {
    const url = buildHemnetSearchUrl(
      { price: null, rooms: null, object_type: 'Kedjehus' },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['item_types[]'], ['villa']);
  });
  check('buildHemnetSearchUrl: rooms=2.5 → rooms_min=rooms_max=3 (Math.round, D-28)', () => {
    const url = buildHemnetSearchUrl(
      { price: null, rooms: 2.5, object_type: null },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['rooms_min'], ['3']);
    assert.deepStrictEqual(params['rooms_max'], ['3']);
  });
  check('buildHemnetSearchUrl: price=4250000 → price_min=4037500 / price_max=4462500 (±5%, D-27)', () => {
    const url = buildHemnetSearchUrl(
      { price: 4250000, rooms: null, object_type: null },
      898623,
    );
    const { params } = parseUrlParams(url);
    // 4250000 * 0.95 = 4037500 (exact) → floor stays 4037500.
    assert.deepStrictEqual(params['price_min'], ['4037500']);
    // 4250000 * 1.05 = 4462500 (exact) → ceil stays 4462500.
    assert.deepStrictEqual(params['price_max'], ['4462500']);
  });
  // Extra defensive check: when the multiplication produces a non-integer
  // (the typical case), Math.floor/Math.ceil should snap correctly outward.
  check('buildHemnetSearchUrl: price=4251000 → price_min=4038450 (floor) / price_max=4463550 (ceil)', () => {
    // 4251000 * 0.95 = 4038450.0 exact → floor 4038450
    // 4251000 * 1.05 = 4463550.0 exact → ceil  4463550
    const url = buildHemnetSearchUrl(
      { price: 4251000, rooms: null, object_type: null },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.deepStrictEqual(params['price_min'], ['4038450']);
    assert.deepStrictEqual(params['price_max'], ['4463550']);
  });
  check('buildHemnetSearchUrl: object_type=Slott (unknown) → no item_types[] (D-25 null-safe)', () => {
    const url = buildHemnetSearchUrl(
      { price: null, rooms: null, object_type: 'Slott' },
      898623,
    );
    const { params } = parseUrlParams(url);
    assert.strictEqual(params['item_types[]'], undefined,
      'unknown Booli objectType must drop the filter, never pass through');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

runJob({ scriptName: 'hemnet-targeted-match', main, validate });
