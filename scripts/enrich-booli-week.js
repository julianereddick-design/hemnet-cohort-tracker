// scripts/enrich-booli-week.js — one-off enrichment probe for a specific cohort week.
//
// Selects active booli_listing rows for the given --week where any of
// (price, rooms, object_type, living_area, agent_id) is NULL, then fetches
// each via lib/booli-fetch.fetchBooliDetail and UPDATEs the row using the
// same COALESCE-preserve shape as Job D (booli-targeted-refresh.js).
//
// Purpose: pre-seed enrichment for Plan 09-2.5 dry-run testing of Job B's
// new narrowed-search code path BEFORE Sun's natural Job C cron does the
// same work. Mirrors Job D's worker pattern (conc 8 + jitter, per-iteration
// try/catch, wall-clock budget).

'use strict';

const { runJob } = require('../cron-wrapper');
const { fetchBooliDetail } = require('../lib/booli-fetch');

const BOOLI_COUNTIES = [
  'Stockholms län',
  'Västra Götalands län',
  'Skåne län',
  'Uppsala län',
];

const JOB_BUDGET_MS = 30 * 60 * 1000; // 30 minutes — generous cap for ~600-row enrichment

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
    } else if (typeof a === 'string' && a.startsWith('--week=')) {
      const v = a.slice('--week='.length);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) weekArg = v;
    } else if (a === '--limit') {
      const next = argv[i + 1];
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) { limit = n; i++; }
    } else if (typeof a === 'string' && a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { weekArg, limit, dryRun };
}

function isoWeekRange(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay();
  const diffToMon = day === 0 ? 6 : day - 1;
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() - diffToMon);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { weekStart: fmt(mon), weekEnd: fmt(sun) };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return 100 + Math.random() * 200; }

function shapeForUpdate(listing) {
  const l = listing || {};
  return {
    price:      l.price      != null ? l.price      : null,
    rooms:      l.rooms      != null ? l.rooms      : null,
    livingArea: l.livingArea != null ? l.livingArea : null,
    objectType: l.objectType != null ? l.objectType : null,
    agentId:    l.agentId    != null ? l.agentId    : null,
  };
}

async function processOne(row, client, log, dryRun, summary) {
  const { booli_id, url } = row;
  let result;
  try {
    result = await fetchBooliDetail(url, { logger: log });
  } catch (err) {
    log('ERROR', `booli_id=${booli_id} url=${url} fetch error: ${err && err.message}`);
    summary.errors++;
    return;
  }

  summary.fetched++;

  if (result.status !== 'active') {
    summary.inactive++;
    return;
  }

  const shaped = shapeForUpdate(result.listing);
  if (shaped.price == null && shaped.rooms == null && shaped.objectType == null) {
    summary.parsedNothing++;
    return;
  }

  if (dryRun) {
    summary.wouldUpdate++;
    return;
  }

  const upd = await client.query(
    `UPDATE booli_listing
        SET price        = COALESCE($2, price),
            rooms        = COALESCE($3, rooms),
            living_area  = COALESCE($4, living_area),
            object_type  = COALESCE($5, object_type),
            agent_id     = COALESCE($6, agent_id)
      WHERE booli_id = $1`,
    [booli_id, shaped.price, shaped.rooms, shaped.livingArea, shaped.objectType, shaped.agentId],
  );
  if (upd.rowCount > 0) summary.rowsUpdated += upd.rowCount;
}

async function main(client, log) {
  const { weekArg, limit, dryRun } = parseArgs(process.argv);
  if (!weekArg) {
    log('ERROR', '--week YYYY-MM-DD is required');
    throw new Error('--week required');
  }
  const startMs = Date.now();
  const { weekStart, weekEnd } = isoWeekRange(weekArg);

  const sel = await client.query(
    `SELECT booli_id, url
       FROM booli_listing
      WHERE is_active = true
        AND is_pre_market = false
        AND listed >= $1::date
        AND listed <= $2::date
        AND county = ANY($3)
        AND (price IS NULL OR rooms IS NULL OR object_type IS NULL OR living_area IS NULL OR agent_id IS NULL)
      ORDER BY booli_id`,
    [weekStart, weekEnd, BOOLI_COUNTIES],
  );
  let rows = sel.rows;
  if (limit != null) rows = rows.slice(0, limit);

  log('INFO',
    `weekStart=${weekStart} weekEnd=${weekEnd} candidates=${rows.length} ` +
    `dryRun=${!!dryRun} limited=${limit != null ? limit : 'null'}`,
  );

  const summary = {
    candidates: rows.length,
    fetched: 0,
    inactive: 0,
    parsedNothing: 0,
    wouldUpdate: 0,
    rowsUpdated: 0,
    errors: 0,
    durationMs: 0,
    budgetExceeded: false,
    workerErrors: 0,
    dryRun: !!dryRun,
    weekStart,
    weekEnd,
    limited: limit != null ? limit : null,
  };

  const queue = rows.slice();
  let processedCount = 0;

  async function worker() {
    while (queue.length) {
      if ((Date.now() - startMs) >= JOB_BUDGET_MS) {
        summary.budgetExceeded = true;
        break;
      }
      const row = queue.shift();
      if (row == null) break;
      await sleep(jitter());
      try {
        await processOne(row, client, log, dryRun, summary);
      } catch (err) {
        summary.workerErrors++;
        log('ERROR', `worker booli_id=${row.booli_id}: ${err && err.message}\n${err && err.stack}`);
      }
      processedCount++;
      if (processedCount % 25 === 0) {
        log('INFO',
          `processed ${processedCount}/${rows.length} ` +
          `(updated: ${summary.rowsUpdated}, errors: ${summary.errors})`,
        );
      }
    }
  }

  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker(), worker(), worker()]);

  summary.durationMs = Date.now() - startMs;
  log('INFO', `Final: ${JSON.stringify(summary)}`);
  return summary;
}

function validate(summary) {
  if (summary.budgetExceeded) {
    return `wall-clock budget exceeded after ${summary.rowsUpdated} updates of ${summary.candidates} candidates`;
  }
  if (summary.workerErrors > 0) {
    return `${summary.workerErrors} worker-uncaught error(s)`;
  }
  return null;
}

if (require.main === module) {
  runJob({ scriptName: 'enrich-booli-week', main, validate });
}

module.exports = { parseArgs, isoWeekRange, shapeForUpdate, main };
