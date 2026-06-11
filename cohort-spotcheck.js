#!/usr/bin/env node
/**
 * cohort-spotcheck.js — sample matched cohort pairs and gather independent
 * signals so Claude can spot-check that each pair is genuinely the SAME property.
 *
 * WHY: the matcher (cohort-create.js:116-135) pairs a Booli FS listing to a
 * Hemnet listing on ONLY postcode + street_address + ±7-day listed window. It
 * never checks price, living area, or property type. So two different units on
 * the same street/postcode listed the same week can be mis-paired. This job
 * samples ~5-10% of a cohort's pairs, pulls the independent signals the matcher
 * ignored (Booli price/area/type from the DB, Hemnet price/area/type by
 * re-fetching the live detail page), reconstructs both clickable listing URLs,
 * and writes a JSON + Markdown artifact. A human then opens the artifact in a
 * Claude Code session and labels each pair MATCH / MISMATCH / UNCERTAIN.
 *
 * READ-ONLY: only SELECTs against the DB; no writes, no cron wiring.
 *
 * Usage (on the droplet: git pull && node cohort-spotcheck.js):
 *   node cohort-spotcheck.js                 # latest cohort, 8% stratified sample
 *   node cohort-spotcheck.js --cohort 2026-W21
 *   node cohort-spotcheck.js --rate 0.10
 *   node cohort-spotcheck.js --dry-run       # print the sample, fetch nothing
 *   node cohort-spotcheck.js --seed foo      # reproducible sample (default: cohort_id)
 *   node cohort-spotcheck.js --refetch-booli # also re-fetch Booli detail (2x Oxylabs cost)
 *   node cohort-spotcheck.js --limit 20      # hard cap on sampled pairs (cost control)
 *   node cohort-spotcheck.js --conc 5        # Hemnet fetch concurrency (default 5)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('./db');
const {
  fetchDetail,
  getOxylabsStats,
  resetOxylabsStats,
} = require('./lib/hemnet-fetch');
const { fetchBooliDetail } = require('./lib/booli-fetch');
const { computeDeltas, classifyDeterministic } = require('./lib/spotcheck-evidence');

// ---------------------------------------------------------------
// args + small utils
// ---------------------------------------------------------------
function parseArgs(argv) {
  const a = { dryRun: false, refetchBooli: false, rate: 0.08, conc: 5 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--refetch-booli') a.refetchBooli = true;
    else if (t === '--cohort') a.cohort = argv[++i];
    else if (t === '--seed') a.seed = argv[++i];
    else if (t === '--rate') a.rate = parseFloat(argv[++i]);
    else if (t === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (t === '--conc') a.conc = Math.max(1, parseInt(argv[++i], 10) || 5);
  }
  if (!Number.isFinite(a.rate) || a.rate <= 0 || a.rate > 1) a.rate = 0.08;
  return a;
}

function log(level, msg) {
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 100 + Math.floor(Math.random() * 200); // 100-300ms

// node-pg returns NUMERIC columns (living_area, rooms) as STRINGS and BIGINT as
// strings too; INTEGER comes back as a number. Coerce to a finite number or null
// so the delta logic (which is strict about types) sees real numbers.
function toNum(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Shape a booli_listing DB row into the comparison field set (numeric coercion).
function booliFieldsFromRow(bRow, row) {
  return {
    price: toNum(bRow ? bRow.price : null),
    rooms: toNum(bRow ? bRow.rooms : null),
    living_area: toNum(bRow ? bRow.living_area : null),
    object_type: bRow ? bRow.object_type : null,
    street_address: row.street_address,
    postcode: row.postcode,
  };
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}
function fmtPct(x) {
  if (x == null) return '—';
  return `${(x * 100).toFixed(0)}%`;
}
function fmtNum(n, unit) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${Number(n)}${unit || ''}`;
}

function tsStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 95% Wilson score interval for a binomial proportion. Returns [lo, hi].
// Better than the normal approximation at small n / low p.
function wilson95(successes, n) {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

// ---------------------------------------------------------------
// URL reconstruction
// ---------------------------------------------------------------
function hemnetUrl(hemnetId) {
  return `https://www.hemnet.se/bostad/${hemnetId}`;
}
function booliUrl(storedUrl) {
  if (typeof storedUrl !== 'string' || !storedUrl.length) return null;
  return storedUrl.startsWith('/') ? `https://www.booli.se${storedUrl}` : storedUrl;
}

// ---------------------------------------------------------------
// main
// ---------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const client = createClient();
  await client.connect();

  try {
    // 1. Resolve cohort (latest by week_start unless --cohort given).
    let cohortId = args.cohort;
    if (!cohortId) {
      const r = await client.query('SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1');
      if (r.rows.length === 0) throw new Error('no cohorts found');
      cohortId = r.rows[0].cohort_id;
    }
    const seed = args.seed != null ? args.seed : cohortId;
    log('INFO', `cohort=${cohortId} rate=${args.rate} seed="${seed}" dryRun=${args.dryRun} refetchBooli=${args.refetchBooli}`);

    // 2. Stratified, deterministic sample. Per county, take the first
    //    ceil(county_total * rate) pairs by a seeded md5 ordering (min 2 per
    //    non-empty county). md5 ordering is stable for a given seed → reproducible.
    const sampleRes = await client.query(
      `WITH ranked AS (
         SELECT cp.id, cp.cohort_id, cp.booli_id, cp.hemnet_id, cp.street_address,
                cp.postcode, cp.municipality, cp.county,
                cp.booli_listed::text AS booli_listed,
                cp.hemnet_listed::text AS hemnet_listed,
                COUNT(*)     OVER (PARTITION BY cp.county) AS county_total,
                ROW_NUMBER() OVER (PARTITION BY cp.county
                                   ORDER BY md5(cp.id::text || $2)) AS rn
         FROM cohort_pairs cp
         WHERE cp.cohort_id = $1
           AND cp.removed_at IS NULL
       )
       SELECT * FROM ranked
       WHERE rn <= GREATEST(2, CEIL(county_total * $3::float8))
       ORDER BY county, rn`,
      [cohortId, seed, args.rate]
    );

    let sample = sampleRes.rows;
    const cohortTotal = sample.reduce((acc, r) => {
      acc[r.county] = Number(r.county_total);
      return acc;
    }, {});
    const cohortPairCount = Object.values(cohortTotal).reduce((a, b) => a + b, 0);

    if (sample.length === 0) {
      log('WARN', `cohort ${cohortId} has no pairs — nothing to check`);
      return;
    }

    if (args.limit != null && sample.length > args.limit) {
      log('INFO', `capping sample ${sample.length} → ${args.limit} (--limit)`);
      sample = sample.slice(0, args.limit);
    }

    // Per-county allocation table.
    const byCounty = {};
    for (const r of sample) {
      byCounty[r.county] = byCounty[r.county] || { sampled: 0, total: Number(r.county_total) };
      byCounty[r.county].sampled++;
    }
    const allocRows = Object.entries(byCounty)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([county, v]) => ({
        county,
        cohort_pairs: v.total,
        sampled: v.sampled,
        pct: `${((v.sampled / v.total) * 100).toFixed(1)}%`,
      }));

    log('INFO', `cohort ${cohortId}: ${cohortPairCount} pairs total → sampling ${sample.length} (${((sample.length / cohortPairCount) * 100).toFixed(1)}%)`);
    console.table(allocRows);

    if (args.dryRun) {
      log('INFO', 'DRY RUN — no fetches, no artifact written. Re-run without --dry-run to gather evidence.');
      return;
    }

    // 3. Batched read of stored Booli fields. booli_listing has multiple rows
    //    per booli_id by design → DISTINCT ON keeps the freshest active row.
    const booliIds = [...new Set(sample.map((r) => Number(r.booli_id)))];
    const booliRes = await client.query(
      `SELECT DISTINCT ON (booli_id)
              booli_id, price, rooms, living_area, object_type, url, listed
       FROM booli_listing
       WHERE booli_id = ANY($1::bigint[])
       ORDER BY booli_id, is_active DESC, crawled DESC NULLS LAST`,
      [booliIds]
    );
    const booliById = new Map();
    for (const row of booliRes.rows) booliById.set(String(row.booli_id), row);

    // 4. Re-fetch Hemnet (and optionally Booli) detail via a worker pool.
    resetOxylabsStats();
    const startMs = Date.now();
    const records = new Array(sample.length);
    const counters = { active: 0, inactive: 0, error: 0, booliMissing: 0 };

    const queue = sample.map((row, idx) => ({ row, idx }));
    let processed = 0;

    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        const { row, idx } = item;
        try {
          await sleep(jitter());
          records[idx] = await buildRecord(row, booliById, args, counters);
        } catch (err) {
          counters.error++;
          log('ERROR', `pair=${row.id} hemnet_id=${row.hemnet_id} uncaught: ${(err && err.stack) || err}`);
          records[idx] = baseRecord(row, booliById, { status: 'error', reason: String(err && err.message || err) });
        }
        processed++;
        if (processed % 25 === 0) {
          log('INFO', `processed ${processed}/${sample.length} (active ${counters.active}, inactive ${counters.inactive}, error ${counters.error})`);
        }
      }
    }

    await Promise.all(Array.from({ length: args.conc }, () => worker()));
    const durationMs = Date.now() - startMs;
    const ox = getOxylabsStats();

    // 5. Write artifacts.
    const stamp = tsStamp(new Date());
    const outDir = path.join(process.cwd(), `verf-spotcheck-${cohortId}-${stamp}`);
    fs.mkdirSync(outDir, { recursive: true });

    const provisionalCounts = records.reduce((acc, r) => {
      acc[r.provisional] = (acc[r.provisional] || 0) + 1;
      return acc;
    }, {});

    const meta = {
      cohort_id: cohortId,
      generated_at: new Date().toISOString(),
      seed,
      rate: args.rate,
      cohort_pair_count: cohortPairCount,
      sampled: records.length,
      sample_pct: records.length / cohortPairCount,
      refetch_booli: args.refetchBooli,
      duration_ms: durationMs,
      hemnet: { active: counters.active, inactive: counters.inactive, error: counters.error },
      booli_missing_from_db: counters.booliMissing,
      oxylabs: {
        callCount: ox.oxylabsCallCount,
        failureCount: ox.oxylabsFailureCount,
        fallbackRate: ox.oxylabsFallbackRate,
      },
      provisional_counts: provisionalCounts,
      by_county: allocRows,
    };

    const jsonPath = path.join(outDir, `spotcheck-${cohortId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ meta, pairs: records }, null, 2));

    const mdPath = path.join(outDir, `spotcheck-${cohortId}.md`);
    fs.writeFileSync(mdPath, renderMarkdown(meta, records));

    log('INFO', `Oxylabs calls: ${ox.oxylabsCallCount} (failures ${ox.oxylabsFailureCount}), duration ${(durationMs / 1000).toFixed(1)}s`);
    log('INFO', `Provisional triage: ${JSON.stringify(provisionalCounts)}`);
    log('INFO', `Wrote:\n  ${jsonPath}\n  ${mdPath}`);
    log('INFO', 'NEXT: open the .json in a Claude Code session and label each pair MATCH/MISMATCH/UNCERTAIN (suspects first).');
  } finally {
    await client.end();
  }
}

// Build the skeleton record (DB-only fields). hemnet defaults to nulls.
function baseRecord(row, booliById, hemnetStatus) {
  const bRow = booliById.get(String(row.booli_id)) || null;
  const booli = booliFieldsFromRow(bRow, row);
  return {
    pair_id: row.id,
    cohort_id: row.cohort_id,
    county: row.county,
    municipality: row.municipality,
    postcode: row.postcode,
    street_address: row.street_address,
    booli_id: String(row.booli_id),
    booli_url: bRow ? booliUrl(bRow.url) : null,
    hemnet_id: String(row.hemnet_id),
    hemnet_url: hemnetUrl(row.hemnet_id),
    booli_listed: row.booli_listed,
    hemnet_listed: row.hemnet_listed,
    listed_gap_days: gapDays(row.booli_listed, row.hemnet_listed),
    booli,
    hemnet: { status: hemnetStatus.status, reason: hemnetStatus.reason || null, asking_price: null, living_area: null, housing_form: null, street_address: null, post_code: null },
  };
}

function gapDays(a, b) {
  if (!a || !b) return null;
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round(Math.abs(da - db) / 86400000);
}

// Full per-pair record: DB fields + live Hemnet re-fetch + deltas + triage.
async function buildRecord(row, booliById, args, counters) {
  const bRow = booliById.get(String(row.booli_id)) || null;
  if (!bRow) counters.booliMissing++;

  // Live Hemnet detail.
  let hemnet = { status: 'inactive', reason: null, asking_price: null, living_area: null, housing_form: null, street_address: null, post_code: null };
  const det = await fetchDetail(row.hemnet_id, { logger: log });
  if (det.status === 'active') {
    counters.active++;
    const l = det.listing;
    hemnet = {
      status: 'active',
      reason: null,
      asking_price: l.askingPrice,
      living_area: l.livingArea,
      housing_form: l.housingForm,
      street_address: l.streetAddress,
      post_code: l.postCode,
    };
  } else {
    counters.inactive++;
    hemnet.reason = det.reason || 'inactive';
  }

  // Optional fresh Booli detail (off by default — DB fields usually suffice).
  let booli = booliFieldsFromRow(bRow, row);
  let booliRefetched = false;
  if (args.refetchBooli && bRow && bRow.url) {
    try {
      const bd = await fetchBooliDetail(bRow.url, { logger: log });
      if (bd.status === 'active') {
        booliRefetched = true;
        booli = {
          price: toNum(bd.listing.price),
          rooms: toNum(bd.listing.rooms),
          living_area: toNum(bd.listing.livingArea),
          object_type: bd.listing.objectType,
          street_address: bd.listing.streetAddress || row.street_address,
          postcode: bd.listing.postcode != null ? bd.listing.postcode : row.postcode,
        };
      }
    } catch (e) {
      log('WARN', `booli refetch failed booli_id=${row.booli_id}: ${e.message}`);
    }
  }

  const rec = {
    pair_id: row.id,
    cohort_id: row.cohort_id,
    county: row.county,
    municipality: row.municipality,
    postcode: row.postcode,
    street_address: row.street_address,
    booli_id: String(row.booli_id),
    booli_url: bRow ? booliUrl(bRow.url) : null,
    hemnet_id: String(row.hemnet_id),
    hemnet_url: hemnetUrl(row.hemnet_id),
    booli_listed: row.booli_listed,
    hemnet_listed: row.hemnet_listed,
    listed_gap_days: gapDays(row.booli_listed, row.hemnet_listed),
    booli,
    booli_refetched: booliRefetched,
    hemnet,
    evidence: hemnet.status === 'active' ? 'full' : 'partial',
    // adjudication fields — filled by Claude in-session
    verdict: null,
    confidence: null,
    reason: null,
  };

  rec.deltas = computeDeltas(booli, hemnet);
  const cls = classifyDeterministic(rec);
  rec.provisional = cls.provisional;
  rec.flags = cls.flags;
  return rec;
}

// ---------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------
function renderMarkdown(meta, records) {
  const lines = [];
  const order = { suspect: 0, 'low-signal': 1, 'likely-match': 2 };
  const sorted = [...records].sort((a, b) => (order[a.provisional] - order[b.provisional]) || (a.county.localeCompare(b.county)));

  const suspectCount = meta.provisional_counts.suspect || 0;
  const [lo, hi] = wilson95(suspectCount, records.length);

  lines.push(`# Cohort spot-check — ${meta.cohort_id}`);
  lines.push('');
  lines.push(`Generated ${meta.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Cohort pairs:** ${fmtInt(meta.cohort_pair_count)}`);
  lines.push(`- **Sampled:** ${meta.sampled} (${(meta.sample_pct * 100).toFixed(1)}%), seed \`${meta.seed}\`, rate ${meta.rate}`);
  lines.push(`- **Hemnet re-fetch:** ${meta.hemnet.active} active · ${meta.hemnet.inactive} inactive/404 · ${meta.hemnet.error} error`);
  lines.push(`- **Booli rows missing from DB:** ${meta.booli_missing_from_db}`);
  lines.push(`- **Oxylabs calls:** ${meta.oxylabs.callCount} (failures ${meta.oxylabs.failureCount})`);
  lines.push(`- **Provisional triage:** ${Object.entries(meta.provisional_counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push('');
  lines.push('> Provisional triage is a deterministic pre-filter (area/price/type/address gaps), **not** the verdict. ' +
    'It orders the list so suspects are reviewed first. The real MATCH/MISMATCH/UNCERTAIN verdict is assigned by Claude ' +
    'below (open both URLs for suspects). After labelling, the false-match rate = MISMATCH / adjudicated.');
  lines.push('');
  lines.push(`Provisional suspect rate: **${((suspectCount / records.length) * 100).toFixed(1)}%** ` +
    `(95% Wilson CI ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%). ` +
    `At n=${records.length} the interval is ~±${(((hi - lo) / 2) * 100).toFixed(1)}pp — good for triage magnitude, not for certifying a sub-1% rate.`);
  lines.push('');

  // By-county
  lines.push('## By county');
  lines.push('');
  lines.push('| County | Cohort pairs | Sampled | % | Suspect | Low-signal |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const a of meta.by_county) {
    const inCounty = records.filter((r) => r.county === a.county);
    const sus = inCounty.filter((r) => r.provisional === 'suspect').length;
    const low = inCounty.filter((r) => r.provisional === 'low-signal').length;
    lines.push(`| ${a.county} | ${fmtInt(a.cohort_pairs)} | ${a.sampled} | ${a.pct} | ${sus} | ${low} |`);
  }
  lines.push('');

  // Flagged-first detail blocks (suspect + low-signal).
  const flagged = sorted.filter((r) => r.provisional !== 'likely-match');
  lines.push(`## Flagged pairs (${flagged.length}) — review these first`);
  lines.push('');
  if (flagged.length === 0) {
    lines.push('_None flagged by the deterministic pre-filter._');
    lines.push('');
  }
  for (const r of flagged) {
    lines.push(detailBlock(r));
  }

  // Full table.
  lines.push('## All sampled pairs');
  lines.push('');
  lines.push('| Pair | County | Prov. | Area Δ | Price Δ | Type | Booli | Hemnet | Verdict |');
  lines.push('| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |');
  for (const r of sorted) {
    const d = r.deltas;
    const typeCell = d.booli_category && d.hemnet_category
      ? `${d.booli_category}${d.type_match ? '=' : '≠'}${d.hemnet_category}`
      : '—';
    const bLink = r.booli_url ? `[B](${r.booli_url})` : '—';
    const hLink = `[H](${r.hemnet_url})`;
    lines.push(`| ${r.pair_id} | ${r.county} | ${r.provisional} | ${fmtPct(d.area_pct_diff)} | ${fmtPct(d.price_pct_diff)} | ${typeCell} | ${bLink} | ${hLink} | |`);
  }
  lines.push('');
  return lines.join('\n');
}

function detailBlock(r) {
  const d = r.deltas;
  const b = r.booli;
  const h = r.hemnet;
  const out = [];
  out.push(`### [${r.provisional}] pair ${r.pair_id} — ${r.street_address}, ${r.municipality} (${r.county})`);
  out.push(`- **Flags:** ${r.flags.length ? r.flags.join(', ') : '—'}`);
  out.push(`- **Booli** ${r.booli_url ? `[link](${r.booli_url})` : '(no url)'} — ${fmtInt(b.price)} kr · ${fmtNum(b.living_area, ' m²')} · ${fmtNum(b.rooms, ' rok')} · ${b.object_type || '—'} · listed ${r.booli_listed}`);
  if (h.status === 'active') {
    out.push(`- **Hemnet** [link](${r.hemnet_url}) — ${fmtInt(h.asking_price)} kr · ${fmtNum(h.living_area, ' m²')} · ${h.housing_form || '—'} · addr "${h.street_address || '—'}" · listed ${r.hemnet_listed}`);
  } else {
    out.push(`- **Hemnet** [link](${r.hemnet_url}) — ⚠️ ${h.status}${h.reason ? ` (${h.reason})` : ''}; live signals unavailable · listed ${r.hemnet_listed}`);
  }
  out.push(`- **Deltas:** area ${fmtPct(d.area_pct_diff)} · price ${fmtPct(d.price_pct_diff)} · type ${d.booli_category || '?'}${d.type_match === false ? '≠' : (d.type_match ? '=' : '?')}${d.hemnet_category || '?'} · addr ${d.address_match === false ? 'DRIFT' : (d.address_match ? 'ok' : '?')} · postcode ${d.postcode_match === false ? 'MISMATCH' : (d.postcode_match ? 'ok' : '?')} · listed gap ${r.listed_gap_days ?? '?'}d`);
  out.push('- **Verdict:** ____  **confidence:** ____  **reason:** ____');
  out.push('');
  return out.join('\n');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
