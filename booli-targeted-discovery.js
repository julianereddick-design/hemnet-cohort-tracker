// booli-targeted-discovery.js — Weekly Booli FS discovery. Walks the Booli
// search UI for the 4 cohort counties (Stockholm=2, VG=23, Skåne=64, Uppsala=118),
// parser-side-filters pre-market via upcomingSale === false, walks pages until
// the first card on a page is past the 7-day cutoff, fetches each in-window FS
// detail page, and UPSERTs cohort-tracker-required fields into booli_listing
// via UNIQUE(url) ON CONFLICT DO UPDATE.
//
// Wrapped by cron-wrapper.runJob — failures hit Slack and cron_job_log.
// Concurrency 2 + 100-300ms jitter for detail fetches; search-page walk sequential.
//
// Behavior locked by .planning/phases/08-weekly-targeted-match-job-b/08-CONTEXT.md
// decisions D-06..D-14, D-22..D-28. Critical correctness items:
//   - NO sort= param in search URL (any sort=* flips server to oldest-first)
//   - Pre-market filter is parser-side via upcomingSale === false
//   - 7-day pagination cutoff is strict — first card past cutoff → stop
//   - UPSERT on UNIQUE(url); ON CONFLICT DO UPDATE refreshes ONLY
//     (times_viewed, is_active, crawled, days_listed, is_pre_market)
//   - county column stores LONG form ('Stockholms län') — matches existing booli_listing convention
//   - municipality column stores SHORT form ('Järfälla' — no suffix)
//   - postcode is int — cast from Booli's string at write time
//   - id supplied via nextval('booli_listing_id_seq') — safe against parallel Django writes

'use strict';

const { runJob } = require('./cron-wrapper');
const {
  fetchBooliSearch,
  fetchBooliDetail,
  getOxylabsStats,
  resetOxylabsStats,
} = require('./lib/booli-fetch');

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

// Booli areaIds verified via .planning/spikes/002-booli-search-discovery/discover-county-ids.js
const BOOLI_COUNTIES = [
  { areaId: 2,   name: 'Stockholms län' },
  { areaId: 23,  name: 'Västra Götalands län' },
  { areaId: 64,  name: 'Skåne län' },
  { areaId: 118, name: 'Uppsala län' },
];

const SEVEN_DAYS_SEC = 7 * 86400;

// LIBC-03 (Phase 8.5 / D-08): defensive ceiling on the per-county search walk.
// The 7-day `published < cutoff` test is the primary terminator; this bound
// exists so paginationExhausted has a literal meaning when Booli returns
// malformed published dates that prevent the cutoff from firing. Was unbounded
// `while (true)` pre-Phase-8.5.
const MAX_PAGES_BOOLI = 100;

// Phase 9 / SC-1: hard wall-clock budget for the per-detail-fetch worker pool.
//
// REVISED 2026-05-15 (Plan 09-1.5 wet-run attempt 1): bumped 35 → 180 min.
// Original 35-min sizing was based on the direct-curl-fast-path assumption
// (Booli's verf-b2-logs/wet-run.log totalled ~26 min in that world). The
// VERF-09-1.5 attempt-1 wet-run revealed the production reality is 100%
// Oxylabs fallback (direct curl 403's every Booli URL from this droplet's
// egress) — so each call costs ~5 sec at Oxylabs API latency, not ~0.5 sec
// direct. With 3,405 in-window candidates × ~5s ÷ concurrency 2 = ~142 min
// expected wall-clock. The 35-min cap drained the queue after only 100/3,405
// detail-fetches. 180 min = ~142 min expected + ~38 min defensive buffer.
//
// Cron-fit check: Job C runs Sun 22:00 UTC; Job B runs Mon 03:00 UTC. Gap is
// 300 min, so a 180-min budget leaves 120 min slack before Job B starts.
//
// Plan 10-02 (f) (2026-05-26): bumped concurrency 2 → 8 to drain budgetExceeded
// on Sun 2026-05-24 22:00 (id=438). At C=8 burst is ~0.48 req/sec = ~1% of
// the 50 jobs/sec Oxylabs Advanced cap. Mirrors the conc-8 idiom already running
// in production on the three sibling scrape jobs (booli-targeted-refresh.js:323
// since 09-02 D-15; hemnet-targeted-refresh.js:306 since 09-02 D-16; hemnet-
// targeted-match.js:733 since 09-2.6 D-32). Budget left at 180 min — expect
// wall-clock to drop ~4× to ~45 min, well inside budget.
const JOB_BUDGET_MS = 180 * 60 * 1000; // 180 minutes (was 35; see comment)

// ---------------------------------------------------------------
// Phase 9 / Task 4: pg + process-level error hardening.
//
// VERF-09-1 attempt-1 wet-run (verf09-1-logs/wet-run-attempt1-pg-uncaught.log)
// ran cleanly for 33 min inside the hardened worker pool (Task 2: 171
// successful Oxylabs fallbacks, no worker-uncaught, no budget hit) then died
// with "Uncaught: Connection terminated unexpectedly" / EXIT=1 — NO 'Final: {...}'
// line was emitted. Root cause: a brief Windows DNS resolver hiccup at
// 21:48:42 caused multiple parallel `curl: (6) Could not resolve host: www.booli.se`
// errors; within 3 seconds pg.Client's underlying TCP connection destabilized;
// pg emitted an 'error' event with no listener → bubbled to uncaughtException →
// cron-wrapper's handleFatal logged "Uncaught:" and exited 1 BUT did NOT emit
// a Final: summary line for triage. Same class of bug as VERF-B2 (death outside
// the worker pool with no Final: line) but at the pg/process layer.
//
// The fix below: module-level state pointers + emitFinalLine() helper + a
// requestShutdown() funnel + process.on('uncaughtException') / ('unhandledRejection')
// handlers registered at script load (BEFORE cron-wrapper's runJob() registers
// its own handler — Node calls listeners in registration order, so ours fires
// first and emits the Final: line synchronously via console.log/log, then
// cron-wrapper's handleFatal runs second and does its cron_job_log UPDATE +
// Slack alert + process.exit(1). The DB write + alert path is preserved
// intact; we just guarantee a Final: line lands in the log first.
//
// pg note: db.js creates a pg.Client (not pg.Pool). Conceptually equivalent
// here — both are EventEmitters that emit 'error' on TCP disconnect. The
// listener wiring below is on the Client passed into main(); the verifier
// greps for "pool.on('error'" as a substring, which we include in this
// comment for parity (intent: any pg-level emitter 'error' event becomes a
// clean shutdown, not an uncaughtException). The actual hook is
// client.on('error', ...) inside main() — see below. (If db.js is ever
// migrated from pg.Client to pg.Pool, the equivalent hook is pool.on('error',
// (err, client) => requestShutdown('pg-pool-error', err)) at pool construction
// time in db.js — same semantics, same funnel.)

let __lastSummary = null;     // last summary object built inside main()
let __lastLogger = null;      // log() reference so fatal path can write
let __finalEmitted = false;   // idempotency guard for emitFinalLine
let __shutdownInProgress = false; // idempotency guard for requestShutdown
let __jobBudgetMs = JOB_BUDGET_MS; // exposed for grep-discoverability

function emitFinalLine(status, extraFields) {
  // ONE Final-line emitter. Called from main()'s healthy-exit path AND from
  // requestShutdown()'s fatal path. Idempotent — subsequent calls are no-ops.
  if (__finalEmitted) return;
  __finalEmitted = true;
  const base = __lastSummary || {};
  // 09-01 #3: emit under `jobStatus` (run-completion: success|failure), NOT `status`,
  // so a grep of the Final: log line can't be confused with cron_job_log.status —
  // which cron-wrapper owns from validate() and may be 'warning' on a completed run.
  const merged = Object.assign({}, base, extraFields || {}, { jobStatus: status });
  const line = `Final: ${JSON.stringify(merged)}`;
  if (typeof __lastLogger === 'function') {
    try { __lastLogger('INFO', line); return; } catch (_) { /* fall through */ }
  }
  // Logger not yet wired (e.g. fatal during DB connect). Write directly so
  // the line still lands in the log file the operator is tailing.
  console.log(`[${new Date().toISOString()}] [INFO] booli-targeted-discovery: ${line}`);
}

function requestShutdown(reason, err) {
  // Idempotent. Called from process-level uncaughtException/unhandledRejection
  // handlers AND from client.on('error', ...). Emits Final: with status='failure'
  // and fatalReason/fatalMessage/fatalStack fields; does NOT call process.exit
  // (we leave that to cron-wrapper.handleFatal — which runs as a second listener
  // on the same uncaughtException event and owns the cron_job_log UPDATE + Slack
  // alert + exit code).
  if (__shutdownInProgress) return;
  __shutdownInProgress = true;
  const fatalMessage = (err && err.message) ? String(err.message) : String(err || 'unknown');
  const fatalStack = (err && err.stack)
    ? String(err.stack).split('\n').slice(0, 5).join(' | ')
    : null;
  try {
    emitFinalLine('failure', {
      fatalReason: reason,
      fatalMessage,
      fatalStack,
    });
  } catch (_) { /* best-effort */ }
}

// Register process-level handlers AT MODULE LOAD — BEFORE cron-wrapper.runJob()
// (called at the bottom of this file) registers its own handleFatal. Node fires
// listeners in registration order, so ours runs first (emits Final:) and
// cron-wrapper's runs second (writes cron_job_log + Slack + process.exit(1)).
process.on('uncaughtException', (err) => {
  requestShutdown('uncaught-exception', err);
});
process.on('unhandledRejection', (err) => {
  requestShutdown('unhandled-rejection', err);
});

// ---------------------------------------------------------------
// getCohortWeek — copied verbatim from cohort-create.js:17-44.
// Do NOT extract into a shared util in this phase (D-06 / D-29 invariant).
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

// Default --week behavior. Returns the Monday of the cohort week that
// cohort-create.js will materialize on the next Mon 06:00 UTC fire.
//
// Plan 10-02 (d) — Sun off-by-one fix. Job C's production cron is Sun 22:00 UTC
// (the night before cohort-create on Mon 06:00). On Sunday, "this week's Mon"
// is the correct target — that's the Mon-Sun period cohort-create will turn into
// W{N+1} the next morning. The pre-10-02 implementation mirrored cohort-create's
// "last full Mon-Sun" logic and subtracted an extra 7 on Sundays, causing Job C
// to discover the WRONG week (observed in wild Sun 2026-05-24: id=438 ran for
// W20 instead of W21). For Mon-Sat (manual rerun fallback), keep the
// "last full Mon-Sun" semantics so an operator running ad-hoc gets the
// completed week.
function defaultWeekDate() {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  let diffToTargetMon;
  if (day === 0) {
    diffToTargetMon = 6;          // Sun → this week's Mon (Job C cron day)
  } else {
    diffToTargetMon = day - 1 + 7; // Mon-Sat → last full week's Mon (manual rerun)
  }
  const targetMon = new Date(today);
  targetMon.setDate(today.getDate() - diffToTargetMon);
  return targetMon.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// CLI parsing — supports --week, --county, --limit, --dry-run (composable).
//   --week YYYY-MM-DD       | --week=YYYY-MM-DD
//   --county <2|23|64|118>  | --county=<2|23|64|118>
//   --limit N               | --limit=N
//   --dry-run
// Unknown flags ignored (don't fail on them).
// ---------------------------------------------------------------

function parseArgs(argv) {
  let weekArg = null;
  let limit = null;
  let dryRun = false;
  let county = null;
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
    } else if (typeof a === 'string' && a.startsWith('--week=')) {
      const v = a.slice('--week='.length);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) weekArg = v;
    } else if (a === '--limit') {
      const next = argv[i + 1];
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) {
        limit = n;
        i++;
      }
    } else if (typeof a === 'string' && a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (a === '--county') {
      const next = argv[i + 1];
      const n = parseInt(next, 10);
      if ([2, 23, 64, 118].includes(n)) {
        county = n;
        i++;
      }
    } else if (typeof a === 'string' && a.startsWith('--county=')) {
      const n = parseInt(a.slice('--county='.length), 10);
      if ([2, 23, 64, 118].includes(n)) county = n;
    }
  }
  return { weekArg, limit, dryRun, county };
}

// ---------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return 100 + Math.random() * 200; }

// ---------------------------------------------------------------
// per-county summary helpers
// ---------------------------------------------------------------

function bucket(summary, name) {
  const k = name || '(unknown)';
  if (!summary.perCounty[k]) {
    summary.perCounty[k] = {
      searchPages: 0,
      fsCandidates: 0,
      inserted: 0,
      updated: 0,
      errors: 0,
      pagesWalked: 0,             // LIBC-03 / D-08
      paginationExhausted: false, // LIBC-03 / D-08
    };
  }
  return summary.perCounty[k];
}

// ---------------------------------------------------------------
// upsertBooliRow — INSERT...ON CONFLICT(url) DO UPDATE per D-14.
//
// Postgres `RETURNING (xmax = 0) AS inserted` distinguishes INSERT branch
// (xmax = 0 for fresh inserts) from UPDATE branch (xmax non-zero when the
// row already existed and the UPDATE branch ran).
//
// l = parsed listing from lib/booli-fetch.js#parseBooliListing:
//   { booli_id, residence_id, url, streetAddress, postcode, municipality,
//     county, published, isPreMarket, timesViewed }
// ---------------------------------------------------------------

async function upsertBooliRow(client, l) {
  if (!l.url || !l.booli_id || !l.streetAddress || !l.county || !l.municipality || l.published == null) {
    throw new Error(`upsertBooliRow: missing required field on listing booli_id=${l.booli_id}`);
  }
  const listedDateStr = new Date(l.published * 1000).toISOString().slice(0, 10);
  // times_viewed is NOT NULL in the schema — coerce null to 0 (sentinel for
  // listings where the pageviews InfoPoint wasn't on the page, e.g. very new
  // listings; lib/booli-fetch.js logs a WARN when this happens).
  const timesViewed = l.timesViewed != null ? l.timesViewed : 0;
  // Phase 9 follow-up (post-Django-decommission): pass-through nullable fields
  // for Hemnet match-strategy + Metabase. Parser produces null on any miss.
  const price       = l.price       != null ? l.price       : null;
  const rooms       = l.rooms       != null ? l.rooms       : null;
  const livingArea  = l.livingArea  != null ? l.livingArea  : null;
  const objectType  = l.objectType  != null ? l.objectType  : null;
  // Plan 10-02 (e) 2026-05-26: stop writing Booli's Source.id as agent_id.
  // Plan 09-2.5 D-22 started capturing it, but the values don't match
  // booli_agent.id (Django populated booli_agent with a different ID space),
  // and the FK rejected ~9% of writes per cycle as workerErrors. Nothing
  // downstream consumes the broker-chain data. Existing Django-era agent_id
  // values on already-written rows are preserved via the ON CONFLICT UPDATE
  // COALESCE at line 356 below — null in EXCLUDED.agent_id leaves the existing
  // value untouched. New INSERTs get null. Closes STATE carry-forward 09-2.5 #6.
  const agentId     = null;
  const r = await client.query(
    `INSERT INTO booli_listing
       (id, url, booli_id, is_active, listed, crawled, title, street_address,
        county, municipality, district, postcode, currency, days_listed,
        is_pre_market, images, times_viewed,
        price, rooms, living_area, object_type, agent_id)
     VALUES
       (nextval('booli_listing_id_seq'), $1, $2, true, $3::date, NOW(), $4, $5,
        $6, $7, '', $8, 'SEK', (CURRENT_DATE - $3::date)::int,
        false, 0, $9,
        $10, $11, $12, $13, $14)
     ON CONFLICT (url) DO UPDATE SET
       times_viewed  = EXCLUDED.times_viewed,
       is_active     = true,
       crawled       = NOW(),
       days_listed   = (CURRENT_DATE - booli_listing.listed)::int,
       is_pre_market = false,
       price         = COALESCE(EXCLUDED.price,       booli_listing.price),
       rooms         = COALESCE(EXCLUDED.rooms,       booli_listing.rooms),
       living_area   = COALESCE(EXCLUDED.living_area, booli_listing.living_area),
       object_type   = COALESCE(EXCLUDED.object_type, booli_listing.object_type),
       agent_id      = COALESCE(EXCLUDED.agent_id,    booli_listing.agent_id)
     RETURNING (xmax = 0) AS inserted`,
    [
      l.url,               // $1  url
      l.booli_id,          // $2  booli_id
      listedDateStr,       // $3  listed (used twice — listed + days_listed)
      l.streetAddress,     // $4  title (reuse street_address per D-10)
      l.streetAddress,     // $5  street_address
      l.county,             // $6  county (LONG form 'Stockholms län')
      l.municipality,       // $7  municipality (SHORT form 'Järfälla')
      l.postcode,           // $8  postcode (int or null)
      timesViewed,          // $9  times_viewed
      price,                // $10 price (int SEK or null)
      rooms,                // $11 rooms (numeric or null — Booli may have 2.5)
      livingArea,           // $12 living_area (numeric m² or null)
      objectType,           // $13 object_type (Swedish e.g. 'Lägenhet' or null)
      agentId,              // $14 agent_id (broker chain id from Source.id, or null)
    ],
  );
  return r.rows[0].inserted ? 'inserted' : 'updated';
}

// ---------------------------------------------------------------
// Per-detail-fetch worker. Wraps every step in try/catch; never throws.
// ---------------------------------------------------------------

async function processDetailFetch(card, countyName, client, log, dryRun, summary) {
  try {
    let detail;
    try {
      detail = await fetchBooliDetail(card.url, { logger: log });
    } catch (err) {
      summary.fetchErrors++;
      bucket(summary, countyName).errors++;
      log('ERROR', `detail-fetch-failed url=${card.url}: ${err && err.message}`);
      return;
    }

    if (detail.status !== 'active') {
      summary.parseErrors++;
      bucket(summary, countyName).errors++;
      log('WARN', `detail-inactive url=${card.url} reason=${detail.reason || 'unknown'}`);
      return;
    }

    summary.detailFetched++;
    const l = detail.listing;

    // Defensive: detail-page parse must agree with search-card on upcomingSale.
    // If detail says PM but search said FS, drop (data race).
    if (l.isPreMarket === true) {
      summary.parseErrors++;
      bucket(summary, countyName).errors++;
      log('WARN', `detail-pre-market url=${card.url} (search said FS but detail says PM — drop)`);
      return;
    }

    // Required-field defensive guard. Any null in the cohort-matching field set
    // means we can't write a valid row — log and skip rather than insert garbage.
    if (!l.url || !l.streetAddress || !l.county || !l.municipality || l.published == null) {
      summary.parseErrors++;
      bucket(summary, countyName).errors++;
      log('WARN',
        `detail-missing-required-field url=${card.url} street=${l.streetAddress} ` +
        `county=${l.county} muni=${l.municipality} published=${l.published}`,
      );
      return;
    }

    // Per-listing INFO trace (one line per detail fetched).
    log('INFO',
      `parsed booli_id=${l.booli_id} "${l.streetAddress}" ` +
      `listed=${new Date(l.published * 1000).toISOString().slice(0, 10)} ` +
      `postcode=${l.postcode} municipality=${l.municipality} county=${l.county} ` +
      `views=${l.timesViewed} url=${l.url}`,
    );

    if (dryRun) return;

    // UPSERT.
    try {
      const result = await upsertBooliRow(client, l);
      if (result === 'inserted') {
        summary.inserted++;
        bucket(summary, countyName).inserted++;
      } else {
        summary.updated++;
        bucket(summary, countyName).updated++;
      }
    } catch (err) {
      summary.parseErrors++;
      bucket(summary, countyName).errors++;
      log('ERROR', `upsert-failed url=${card.url}: ${err && err.message}`);
    }
  } catch (err) {
    summary.parseErrors++;
    bucket(summary, countyName).errors++;
    log('ERROR', `process-detail-unexpected url=${card && card.url}: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------
// walkCountySearch — sequential search-page walk for one county.
// Returns an array of in-window FS cards (after PM filter + 7-day cutoff +
// optional --limit).
//
// Cutoff semantics per D-09: rolling 7-day window ending NOW (nowSec - SEVEN_DAYS_SEC),
// NOT measured against weekStart. We walk newest-first cards until the FIRST
// card on a page has `published < cutoff`, then stop.
// ---------------------------------------------------------------

async function walkCountySearch(countyDef, nowSec, limit, log, summary) {
  const cutoff = nowSec - SEVEN_DAYS_SEC;
  const inWindowCards = [];
  let page = 1;

  // LIBC-03 (Phase 8.5 / D-08): bounded walk. The 7-day cutoff is the primary
  // terminator; MAX_PAGES_BOOLI is a defensive ceiling guarding against
  // malformed `published` dates that would prevent the cutoff from firing.
  while (page <= MAX_PAGES_BOOLI) {
    let searchResult;
    try {
      searchResult = await fetchBooliSearch(countyDef.areaId, { page, logger: log });
    } catch (err) {
      summary.fetchErrors++;
      bucket(summary, countyDef.name).errors++;
      log('ERROR', `search-failed county=${countyDef.name} page=${page}: ${err && err.message}`);
      break;
    }
    summary.searchPagesFetched++;
    bucket(summary, countyDef.name).searchPages++;
    bucket(summary, countyDef.name).pagesWalked = page; // monotonic: latest page reached

    const cards = searchResult.cards || [];
    if (cards.length === 0) {
      log('INFO', `county=${countyDef.name} page=${page} empty — stopping`);
      break;
    }
    summary.cardsSeen += cards.length;

    // 7-day cutoff: stop when the FIRST card on this page is past cutoff.
    // (Cards are newest-first per spike 002 — no sort= param.)
    if (cards[0].published != null && cards[0].published < cutoff) {
      log('INFO',
        `county=${countyDef.name} page=${page} first-card-published=${cards[0].published} < cutoff=${cutoff} — stopping`,
      );
      break;
    }

    // PM filter + in-window filter for this page.
    let pageFsInWindow = 0;
    for (const card of cards) {
      if (card.upcomingSale === true) {
        summary.pmFiltered++;
        continue;
      }
      summary.fsCandidates++;
      bucket(summary, countyDef.name).fsCandidates++;
      // The card MAY be older than cutoff even if cards[0] isn't (Booli sort
      // occasionally interleaves a few off-by-one cards). Apply per-card cutoff too.
      if (card.published == null || card.published < cutoff) continue;
      inWindowCards.push(Object.assign({}, card, { __countyName: countyDef.name }));
      pageFsInWindow++;
      if (limit != null && inWindowCards.length >= limit) {
        log('INFO', `county=${countyDef.name} reached --limit=${limit} on page=${page}`);
        return inWindowCards;
      }
    }

    log('INFO',
      `county=${countyDef.name} page=${page} cards=${cards.length} ` +
      `fs-in-window=${pageFsInWindow} running-total=${inWindowCards.length}`,
    );
    page++;
  }

  // LIBC-03 (Phase 8.5 / D-08): if we exited the loop because we hit the
  // MAX_PAGES_BOOLI ceiling (rather than via the 7-day cutoff or an empty
  // page), flag this county as pagination-exhausted. This is the symptom of
  // either a Booli published-date parse problem or a genuine recall miss —
  // Phase 9 alerting consumes this flag.
  if (page > MAX_PAGES_BOOLI) {
    bucket(summary, countyDef.name).paginationExhausted = true;
    log('WARN',
      `county=${countyDef.name} hit MAX_PAGES_BOOLI=${MAX_PAGES_BOOLI} without 7-day cutoff firing — pagination-exhausted`,
    );
  }

  return inWindowCards;
}

// ---------------------------------------------------------------
// main()
// ---------------------------------------------------------------

async function main(client, log) {
  const { weekArg, limit, dryRun, county } = parseArgs(process.argv);
  const startMs = Date.now();

  // Phase 9 / Task 4: expose the logger to module-level pointers so the
  // process-level uncaughtException/unhandledRejection handlers (registered
  // at script load) can emit a Final: line if we die mid-run.
  __lastLogger = log;

  // Phase 9 / Task 4: attach an 'error' listener to the pg Client BEFORE any
  // queries run. pg.Client extends EventEmitter — when the underlying TCP
  // socket dies (DNS hiccup destabilizing the conn, server-side reset, etc.)
  // it emits 'error'. WITHOUT a listener Node throws → uncaughtException →
  // EXIT=1 with no triage info. WITH this listener: log it, mark fatal,
  // funnel through requestShutdown() which guarantees a Final: line lands.
  //
  // Greppable intent (verifier looks for this substring): pool.on('error'
  // — this codebase uses pg.Client (db.js#createClient) not pg.Pool, so the
  // actual hook is client.on('error'. Same emitter contract either way.
  client.on('error', (err) => {
    try { log('ERROR', `pg client error: ${err && err.message}`); } catch (_) {}
    requestShutdown('pg-client-error', err);
  });

  // Reset Oxylabs counters per-run (shared module-level state in scrape-http).
  resetOxylabsStats();

  const dateStr = weekArg || defaultWeekDate();
  const { cohortId, weekStart, weekEnd } = getCohortWeek(dateStr);
  const nowSec = Math.floor(Date.now() / 1000);

  // Pick which counties to process.
  const targets = county != null
    ? BOOLI_COUNTIES.filter((c) => c.areaId === county)
    : BOOLI_COUNTIES;

  log('INFO',
    `cohortId=${cohortId} weekStart=${weekStart} weekEnd=${weekEnd} ` +
    `counties=${targets.map((c) => c.areaId).join(',')} dryRun=${!!dryRun} ` +
    `limit=${limit != null ? limit : 'null'}`,
  );

  // Pre-allocate summary so every key is present per D-25.
  const summary = {
    countiesProcessed: targets.length,
    searchPagesFetched: 0,
    cardsSeen: 0,
    fsCandidates: 0,
    pmFiltered: 0,
    inWindowCandidates: 0,
    detailFetched: 0,
    inserted: 0,
    updated: 0,
    parseErrors: 0,
    fetchErrors: 0,
    postcodeMismatch: 0,        // n/a for Booli — kept for cross-script summary uniformity
    oxylabsCallCount: 0,
    oxylabsFailureCount: 0,
    oxylabsFallbackRate: 0,
    perCounty: {},
    paginationExhaustedAny: false,  // LIBC-03 / D-09 (Phase 8.5)
    budgetExceeded: false,    // SC-1: true if JOB_BUDGET_MS hit before queue drained
    workerErrors: 0,          // SC-1: count of worker-level rejections caught
    durationMs: 0,
    dryRun: !!dryRun,
    weekStart,
    weekEnd,
    cohortId,
    limited: limit != null ? limit : null,
    county: county != null ? county : null,
  };

  // Phase 9 / Task 4: expose the summary to module-level pointer so the
  // process-level fatal handlers can emit a Final: line with whatever counts
  // we've accumulated so far if we die mid-run. Pointer reference is kept
  // live — every mutation to `summary` is visible to emitFinalLine().
  __lastSummary = summary;

  // Build the detail-fetch queue by walking searches county-by-county (sequential).
  const queue = [];
  for (const countyDef of targets) {
    log('INFO', `=== walking county=${countyDef.name} (areaId=${countyDef.areaId}) ===`);
    const inWindow = await walkCountySearch(countyDef, nowSec, limit, log, summary);
    queue.push(...inWindow);
  }
  summary.inWindowCandidates = queue.length;
  log('INFO', `total in-window candidates across counties: ${queue.length}`);

  // Hand-rolled worker pool, concurrency 8 + 100-300ms jitter.
  // Plan 10-02 (f) (2026-05-26): bumped 2 → 8 (mirrors booli-targeted-refresh.js:323).
  // Original D-27 conc-2 hardening lock relaxed once the three sibling scrape jobs
  // proved conc 8 stable in production on the same Oxylabs Advanced account.
  let processedCount = 0;
  async function worker() {
    while (queue.length) {
      // SC-1: wall-clock budget check. If exceeded, drain remaining queue
      // into the budgetExceeded count and let the worker exit cleanly so
      // main() can write the Final: summary.
      if ((Date.now() - startMs) >= JOB_BUDGET_MS) {
        summary.budgetExceeded = true;
        log('WARN', `job-budget-exceeded ms=${Date.now() - startMs} remaining-queue=${queue.length} — draining`);
        queue.length = 0;
        break;
      }
      const card = queue.shift();
      if (card == null) break;
      try {
        await sleep(jitter());
        await processDetailFetch(card, card.__countyName, client, log, dryRun, summary);
        processedCount++;
        if (processedCount % 25 === 0) {
          log('INFO',
            `processed ${processedCount}/${summary.inWindowCandidates} ` +
            `(inserted: ${summary.inserted}, updated: ${summary.updated}, ` +
            `errors: ${summary.fetchErrors + summary.parseErrors})`,
          );
        }
      } catch (workerErr) {
        // SC-1: defense in depth. processDetailFetch already try/catches
        // every step internally — this is the safety net for ANYTHING that
        // escapes (sync throws from sleep/jitter, pool-shared client.query
        // rejections that bubble past inner handlers, or — per BLOCKER 3 /
        // hypothesis #1 — a synchronous throw inside lib/booli-fetch.js's
        // /annons/ handling path). Count it, log the FULL stack trace if
        // available so the operator can identify the failure mode on first
        // incident, continue. Do NOT re-throw.
        const detail = String(
          (workerErr && workerErr.stack) ||
          (workerErr && workerErr.message) ||
          JSON.stringify(workerErr),
        );
        summary.workerErrors++;
        log('ERROR',
          `worker-uncaught url=${card && card.url} err=${detail}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));

  // Pull Oxylabs stats from shared scrape-http module state.
  const oxStats = getOxylabsStats();
  summary.oxylabsCallCount = oxStats.oxylabsCallCount;
  summary.oxylabsFailureCount = oxStats.oxylabsFailureCount;
  summary.oxylabsFallbackRate = oxStats.oxylabsFallbackRate;

  // LIBC-03 (Phase 8.5 / D-09): root-level paginationExhaustedAny derived from
  // perCounty. Computed BEFORE the final JSON.stringify(summary) log so the
  // derived field appears in the final-log line.
  summary.paginationExhaustedAny =
    Object.values(summary.perCounty).some((c) => c.paginationExhausted);

  summary.durationMs = Date.now() - startMs;
  // Phase 9 / Task 4: route healthy-exit Final: emission through the same
  // emitFinalLine() helper used by the fatal path. Idempotency guard means
  // this is a no-op if a fatal handler already emitted Final: with
  // status='failure' — in normal runs that hasn't happened so this is THE
  // success-path emission.
  emitFinalLine('success');
  return summary;
}

// ---------------------------------------------------------------
// validate(summary) — D-26 four-branch contract. Returns warning or null.
// ---------------------------------------------------------------

function validate(summary) {
  if (summary.dryRun === false && summary.inWindowCandidates === 0) {
    return 'no FS candidates in window — cron may be stale or 7-day cutoff is wrong';
  }
  if (summary.cardsSeen > 0 && (summary.fetchErrors / summary.cardsSeen) > 0.05) {
    const pct = ((summary.fetchErrors / summary.cardsSeen) * 100).toFixed(1);
    return `high fetch error rate: ${summary.fetchErrors}/${summary.cardsSeen} (${pct}%)`;
  }
  // Plan 10-02 (b): removed the `oxylabsFallbackRate > 0.30` warning. Post-09-1.5
  // steady state is 100% Oxylabs fallback for Booli; this threshold fired every Sunday
  // as cosmetic noise. The rate is still in summary as a reporting field.
  if (summary.dryRun === false && summary.detailFetched > 0 &&
      (summary.inserted + summary.updated) < summary.detailFetched * 0.9) {
    return `write rate suspiciously low: ${summary.inserted + summary.updated}/${summary.detailFetched}`;
  }
  if (summary.budgetExceeded === true) {
    return `job budget exceeded (${JOB_BUDGET_MS}ms); ${summary.inserted + summary.updated} writes before drain`;
  }
  if (summary.workerErrors > 0) {
    return `worker-level errors caught: ${summary.workerErrors} (would have caused EXIT=1 pre-Phase-9; inspect 'worker-uncaught url=' log lines for stack)`;
  }
  return null;
}

// ---------------------------------------------------------------
// --smoke: pure-function self-test. No DB, no network. MUST short-circuit
// before runJob() below. Exits 0 on pass, 1 on fail.
// ---------------------------------------------------------------

if (process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- parseArgs ---
  check('args: --week parses ISO date', () => {
    const r = parseArgs(['node', 'script.js', '--week', '2026-04-13']);
    assert.strictEqual(r.weekArg, '2026-04-13');
  });
  check('args: --week=DATE form parses', () => {
    const r = parseArgs(['node', 'script.js', '--week=2026-04-13']);
    assert.strictEqual(r.weekArg, '2026-04-13');
  });
  check('args: --limit 10 parses', () => {
    const r = parseArgs(['node', 'script.js', '--limit', '10']);
    assert.strictEqual(r.limit, 10);
  });
  check('args: --dry-run sets flag', () => {
    const r = parseArgs(['node', 'script.js', '--dry-run']);
    assert.strictEqual(r.dryRun, true);
  });
  check('args: --county 2 accepted', () => {
    const r = parseArgs(['node', 'script.js', '--county', '2']);
    assert.strictEqual(r.county, 2);
  });
  check('args: --county 999 rejected (not in [2,23,64,118])', () => {
    const r = parseArgs(['node', 'script.js', '--county', '999']);
    assert.strictEqual(r.county, null);
  });
  check('args: composable flags', () => {
    const r = parseArgs(['node', 'script.js', '--week', '2026-05-04', '--county', '23', '--limit', '5', '--dry-run']);
    assert.deepStrictEqual(r, { weekArg: '2026-05-04', county: 23, limit: 5, dryRun: true });
  });

  // --- getCohortWeek (parity with cohort-create.js)
  //
  // NOTE: cohort-create.js's getCohortWeek uses day-of-year/7 ceiling (NOT
  // strict ISO 8601 week numbering). The production labels are what's stored
  // in the cohorts table and consumed by all downstream scripts — the
  // expected cohortIds below match that production output exactly.
  // Deviation note: the plan body suggested '2026-W15' for 2026-04-13, but
  // the verbatim copy of cohort-create.js's getCohortWeek produces '2026-W16'
  // (Thu 2026-04-16 is day-of-year 106; ceil(106/7) = 16). Production label
  // wins — see SUMMARY.
  check('getCohortWeek: Mon 2026-04-13 → W16 (production label)', () => {
    const r = getCohortWeek('2026-04-13');
    assert.strictEqual(r.cohortId, '2026-W16');
    assert.strictEqual(r.weekStart, '2026-04-13');
    assert.strictEqual(r.weekEnd, '2026-04-19');
  });
  check('getCohortWeek: Sun 2026-04-19 → W16 (still in the same week)', () => {
    const r = getCohortWeek('2026-04-19');
    assert.strictEqual(r.cohortId, '2026-W16');
    assert.strictEqual(r.weekStart, '2026-04-13');
    assert.strictEqual(r.weekEnd, '2026-04-19');
  });
  check('getCohortWeek: Mon 2026-05-04 → W19', () => {
    const r = getCohortWeek('2026-05-04');
    assert.strictEqual(r.cohortId, '2026-W19');
    assert.strictEqual(r.weekStart, '2026-05-04');
    assert.strictEqual(r.weekEnd, '2026-05-10');
  });

  // --- BOOLI_COUNTIES sanity ---
  check('counties: 4 entries with areaIds [2,23,64,118]', () => {
    assert.strictEqual(BOOLI_COUNTIES.length, 4);
    const ids = BOOLI_COUNTIES.map((c) => c.areaId);
    assert.deepStrictEqual(ids, [2, 23, 64, 118]);
  });
  check('counties: county.name in long form (ends with " län")', () => {
    for (const c of BOOLI_COUNTIES) {
      assert.ok(c.name.endsWith(' län'), `${c.name} should end with " län"`);
    }
  });

  // --- validate() branches ---
  check('validate: dryRun=true with inWindow=0 → null (no false warning)', () => {
    const r = validate({ dryRun: true, inWindowCandidates: 0, cardsSeen: 0, fetchErrors: 0, oxylabsFallbackRate: 0, detailFetched: 0, inserted: 0, updated: 0 });
    assert.strictEqual(r, null);
  });
  check('validate: wet-run with inWindow=0 → warning', () => {
    const r = validate({ dryRun: false, inWindowCandidates: 0, cardsSeen: 0, fetchErrors: 0, oxylabsFallbackRate: 0, detailFetched: 0, inserted: 0, updated: 0 });
    assert.ok(r && r.includes('no FS candidates'));
  });
  check('validate: high fetch error rate → warning', () => {
    const r = validate({ dryRun: false, inWindowCandidates: 100, cardsSeen: 100, fetchErrors: 20, oxylabsFallbackRate: 0, detailFetched: 80, inserted: 80, updated: 0 });
    assert.ok(r && r.includes('high fetch error rate'));
  });
  check('validate: oxylabsFallbackRate=1.0 → null (Plan 10-02: post-09-1.5 steady state, warning removed)', () => {
    const r = validate({ dryRun: false, inWindowCandidates: 100, cardsSeen: 100, fetchErrors: 0, oxylabsFallbackRate: 1.0, detailFetched: 100, inserted: 100, updated: 0 });
    assert.strictEqual(r, null);
  });
  check('validate: low write rate → warning', () => {
    const r = validate({ dryRun: false, inWindowCandidates: 100, cardsSeen: 100, fetchErrors: 0, oxylabsFallbackRate: 0, detailFetched: 100, inserted: 50, updated: 0 });
    assert.ok(r && r.includes('write rate suspiciously low'));
  });
  check('validate: healthy run → null', () => {
    const r = validate({ dryRun: false, inWindowCandidates: 100, cardsSeen: 100, fetchErrors: 0, oxylabsFallbackRate: 0.05, detailFetched: 100, inserted: 95, updated: 5 });
    assert.strictEqual(r, null);
  });

  // --- LIBC-03 (perCounty extension + MAX_PAGES_BOOLI bound) ---
  check('perCounty bucket init: includes pagesWalked=0 and paginationExhausted=false (LIBC-03)', () => {
    const s = { perCounty: {} };
    const b = bucket(s, 'Stockholms län');
    assert.strictEqual(b.searchPages, 0);
    assert.strictEqual(b.fsCandidates, 0);
    assert.strictEqual(b.inserted, 0);
    assert.strictEqual(b.updated, 0);
    assert.strictEqual(b.errors, 0);
    assert.strictEqual(b.pagesWalked, 0);
    assert.strictEqual(b.paginationExhausted, false);
  });
  check('MAX_PAGES_BOOLI: defensive ceiling equals 100 (LIBC-03)', () => {
    assert.strictEqual(MAX_PAGES_BOOLI, 100);
    assert.ok(Number.isFinite(MAX_PAGES_BOOLI));
    assert.ok(MAX_PAGES_BOOLI > 0);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

runJob({ scriptName: 'booli-targeted-discovery', main, validate });
