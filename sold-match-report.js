require('dotenv').config();

// sold-match-report.js — Phase 20 per-run Slack summary over the sold_match table
// (REPORT-01 / REPORT-03; D-01..D-06).
//
// A standalone reporter that buckets each sold_match row's verdict per `segment`
// (the Phase-19 orchestrator stamps `"<muni>:<FAMILY>"` — e.g. "Stockholm:APARTMENT",
// "Täby:HOUSE", see lib/sold-sample.js sampleNational / sold-match-batch.js), rolls up to
// region (config/sold-panel.json muni→region) and national, and posts a monospace Slack
// block via lib/spotcheck-slack-bot.js postInfoMessage.
//
// THE decision-grade headline is the SETTLED genuine-non-Hemnet rate (D-03):
//   settledRate = genuine_non_hemnet / (matched + genuine_non_hemnet)   over TERMINAL
//   verdicts ONLY (excludes still-in-recheck booli_only AND uncertain). It is reported as
//   the lead number, labelled "settled", DISTINCTLY from the raw/preliminary booli_only
//   rate (D-04: booli_only / total) so slutpris-lag contamination is never read as genuine
//   non-Hemnet presence.
//
//   node sold-match-report.js          # production run (needs DB; posts to Slack if token set)
//   node sold-match-report.js --smoke  # offline self-test (no DB, no network, no Slack post)

const { createClient } = require('./db');
const { postInfoMessage } = require('./lib/spotcheck-slack-bot');
const panel = require('./config/sold-panel.json');
// buildSeries computes, per fortnightly cohort, the on-Hemnet match share (firstPull +
// incremental = matched/total) and the sample size — the exact numbers the trend chart
// plots. The minimal weekly Slack message (below) reuses it so the posted % and the chart
// are guaranteed to agree.
const { buildSeries } = require('./sold-match-trend-chart');

// REPORT-ONLY additive overlays (config/sold-panel.json overlays[]): each re-buckets rows whose
// booli_sold.municipality === match_muni AND descriptive_area ∈ descriptive_areas as an extra
// data point. Normalize the area sets once (lowercased) for matching.
const OVERLAYS = (panel.overlays || []).map((o) => ({
  name: o.name,
  matchMuni: String(o.match_muni || '').toLowerCase(),
  areas: new Set((o.descriptive_areas || []).map((a) => String(a).toLowerCase())),
}));

// ---------------------------------------------------------------------------
// muni→region lookup from the national panel (lowercase muni name → region).
// Built once at load. config/sold-panel.json munis each carry their own `region`.
// ---------------------------------------------------------------------------
const MUNI_REGION = {};
for (const m of (panel.munis || [])) {
  if (m && m.name) MUNI_REGION[String(m.name).toLowerCase()] = m.region || 'Unknown';
}

// ---------------------------------------------------------------------------
// segmentToMuniRegion(segment) — derive { muni, region, family } from the opaque
// `segment` string. The orchestrator format is "<muni>:<FAMILY>" (lib/sold-sample.js),
// but parse DEFENSIVELY (segment_format_note): match the muni token against the panel
// muni names case-insensitively; detect HOUSE/APARTMENT/Hus/Lägenhet for family; bucket
// under region 'Unknown' + WARN if unparseable. NEVER throw.
// ---------------------------------------------------------------------------
function segmentToMuniRegion(segment) {
  const raw = segment == null ? '' : String(segment);
  // Split on ':' (orchestrator format) but tolerate other separators / muni-only.
  const parts = raw.split(/[:|/]/).map((s) => s.trim()).filter(Boolean);

  // Family: detect a HOUSE/APARTMENT token (case-insensitive; tolerate Swedish words).
  let family = null;
  if (/\b(house|hus|villa)\b/i.test(raw)) family = 'HOUSE';
  else if (/\b(apartment|apt|l[aä]genhet|bostadsr[aä]tt)\b/i.test(raw)) family = 'APARTMENT';

  // Muni: try each token against the panel muni names (case-insensitive exact match);
  // fall back to the first token if none matches a known muni.
  let muni = null;
  let region = null;
  for (const tok of parts) {
    if (MUNI_REGION[tok.toLowerCase()] != null) {
      muni = tok;
      region = MUNI_REGION[tok.toLowerCase()];
      break;
    }
  }
  if (region == null) {
    // Unparseable muni → keep the first token as a label, bucket under 'Unknown'.
    muni = parts[0] || raw || '(empty)';
    region = 'Unknown';
    console.warn(`WARN: unparseable segment muni "${raw}" → region 'Unknown'`);
  }

  return { muni, region, family };
}

// ---------------------------------------------------------------------------
// emptyBucket() — the per-segment count shape.
//   matched      = verdict 'matched'           (INCLUDES the late-resolved subset)
//   lateResolved = verdict 'matched' AND first_unmatched_at != null (D-05 separate line)
//   booliOnly    = verdict 'booli_only'        (in re-check, preliminary)
//   settled      = verdict 'genuine_non_hemnet' (terminal non-Hemnet)
//   uncertain    = verdict 'uncertain'
//   total        = all rows
// ---------------------------------------------------------------------------
function emptyBucket() {
  return { matched: 0, booliOnly: 0, lateResolved: 0, settled: 0, uncertain: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// bucketRows(rows) — PURE. Group sold_match rows by `segment`, returns
//   { [segment]: bucket } with the D-05 verdict buckets. A row carries
//   { verdict, segment, was_enrolled }  (was_enrolled = first_unmatched_at IS NOT NULL).
// ---------------------------------------------------------------------------
function bucketRows(rows) {
  const perSegment = {};
  for (const r of (rows || [])) {
    const segKey = r.segment == null ? '(null)' : String(r.segment);
    if (!perSegment[segKey]) perSegment[segKey] = emptyBucket();
    const b = perSegment[segKey];
    b.total++;
    const wasEnrolled = r.was_enrolled === true
      || r.was_enrolled === 't'
      || (r.first_unmatched_at != null);
    switch (r.verdict) {
      case 'matched':
        b.matched++;
        if (wasEnrolled) b.lateResolved++;
        break;
      case 'booli_only':
        b.booliOnly++;
        break;
      case 'genuine_non_hemnet':
        b.settled++;
        break;
      case 'uncertain':
        b.uncertain++;
        break;
      default:
        console.warn(`WARN: unknown verdict "${r.verdict}" in segment "${segKey}" — counted only in total`);
        break;
    }
  }
  return perSegment;
}

// ---------------------------------------------------------------------------
// settledRate(bucket) — D-03 decision-grade headline.
//   genuine_non_hemnet / (matched + genuine_non_hemnet), over TERMINAL verdicts ONLY.
//   Excludes booli_only AND uncertain from BOTH numerator and denominator.
//   Returns null when (matched + settled) === 0 (no terminal verdicts yet).
// ---------------------------------------------------------------------------
function settledRate(bucket) {
  const terminal = bucket.matched + bucket.settled;
  if (terminal === 0) return null;
  return bucket.settled / terminal;
}

// ---------------------------------------------------------------------------
// rawBooliOnlyRate(bucket) — D-04 preliminary/lag-contaminated rate.
//   booli_only / total. Distinct function, distinct number — NEVER merged with settled.
//   Returns null when total === 0.
// ---------------------------------------------------------------------------
function rawBooliOnlyRate(bucket) {
  if (bucket.total === 0) return null;
  return bucket.booliOnly / bucket.total;
}

// ---------------------------------------------------------------------------
// addBucket(dst, src) — accumulate src counts into dst (for region/national rollup).
// ---------------------------------------------------------------------------
function addBucket(dst, src) {
  dst.matched += src.matched;
  dst.booliOnly += src.booliOnly;
  dst.lateResolved += src.lateResolved;
  dst.settled += src.settled;
  dst.uncertain += src.uncertain;
  dst.total += src.total;
}

// ---------------------------------------------------------------------------
// rollupRegion(perSegment) — PURE. Groups segments by region (via segmentToMuniRegion)
// and sums the NATIONAL total. Returns
//   { perSegment, byRegion: { [region]: bucket }, national: bucket,
//     segMeta: { [segment]: { muni, region, family } } }
// The national/region rates are computed from the SUMMED terminal counts (not an average
// of per-segment rates) by applying settledRate/rawBooliOnlyRate to the rolled-up buckets.
// ---------------------------------------------------------------------------
function rollupRegion(perSegment) {
  const byRegion = {};
  const national = emptyBucket();
  const segMeta = {};
  for (const segKey of Object.keys(perSegment || {})) {
    const bucket = perSegment[segKey];
    const meta = segmentToMuniRegion(segKey);
    segMeta[segKey] = meta;
    if (!byRegion[meta.region]) byRegion[meta.region] = emptyBucket();
    addBucket(byRegion[meta.region], bucket);
    addBucket(national, bucket);
  }
  return { perSegment, byRegion, national, segMeta };
}

// ---------------------------------------------------------------------------
// rollupFamily(perSegment, segMeta) — PURE. Sum segment buckets by family
// (APARTMENT vs HOUSE), so the report can show the apartments-vs-villas cut. A
// segment whose family is unparseable buckets under 'Unknown'.
// ---------------------------------------------------------------------------
function rollupFamily(perSegment, segMeta) {
  const byFamily = {};
  for (const segKey of Object.keys(perSegment || {})) {
    const meta = (segMeta && segMeta[segKey]) || segmentToMuniRegion(segKey);
    const fam = meta.family || 'Unknown';
    if (!byFamily[fam]) byFamily[fam] = emptyBucket();
    addBucket(byFamily[fam], perSegment[segKey]);
  }
  return byFamily;
}

// ---------------------------------------------------------------------------
// bucketOverlays(rows, overlays) — PURE. Re-bucket RAW rows (not segments) by overlay
// membership: a row joins overlay O iff lower(municipality) === O.matchMuni AND
// lower(descriptive_area) ∈ O.areas. Rows carry { verdict, was_enrolled,
// first_unmatched_at, municipality, descriptive_area }. Returns { [overlayName]: bucket }.
// These rows ALSO remain in their muni/region totals (additive overlay — accepted double-count).
// ---------------------------------------------------------------------------
function bucketOverlays(rows, overlays) {
  const out = {};
  for (const o of (overlays || [])) out[o.name] = emptyBucket();
  for (const r of (rows || [])) {
    const muni = r.municipality == null ? '' : String(r.municipality).toLowerCase();
    const area = r.descriptive_area == null ? '' : String(r.descriptive_area).toLowerCase();
    for (const o of (overlays || [])) {
      if (muni !== o.matchMuni || !o.areas.has(area)) continue;
      const b = out[o.name];
      b.total++;
      const wasEnrolled = r.was_enrolled === true || r.was_enrolled === 't' || (r.first_unmatched_at != null);
      switch (r.verdict) {
        case 'matched': b.matched++; if (wasEnrolled) b.lateResolved++; break;
        case 'booli_only': b.booliOnly++; break;
        case 'genuine_non_hemnet': b.settled++; break;
        case 'uncertain': b.uncertain++; break;
        default: break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers (copied from the market-totals-weekly-report.js analog).
// ---------------------------------------------------------------------------
function lpad(s, w) { return (' '.repeat(w) + s).slice(-w); }
function rpad(s, w) { return (s + ' '.repeat(w)).slice(0, w); }

// pct(rate) — render a 0..1 rate as a percent string, or '?'/'n/a' when null.
function pct(rate) {
  if (rate == null) return 'n/a';
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// renderSegmentRow(label, bucket) — one aligned per-segment/region row:
//   <label>  matched=.. (late=..)  booli_only=..  settled=..  uncertain=..
// ---------------------------------------------------------------------------
function renderSegmentRow(label, bucket) {
  return `${rpad(label, 22)} `
    + `matched=${lpad(String(bucket.matched), 4)} (late=${lpad(String(bucket.lateResolved), 3)})  `
    + `booli_only=${lpad(String(bucket.booliOnly), 4)}  `
    + `settled=${lpad(String(bucket.settled), 4)}  `
    + `uncertain=${lpad(String(bucket.uncertain), 4)}`;
}

// ---------------------------------------------------------------------------
// renderReport(perSegment, opts) — PURE. Returns the monospace-fenced Slack text.
//   Lead block = national headline:
//     - SETTLED genuine-non-Hemnet rate (LEAD number, labelled "settled", terminal-only)
//     - a SEPARATE line for the raw booli_only rate, labelled preliminary/lag-contaminated.
//   The two rates appear on DIFFERENT lines with DIFFERENT labels (the REPORT-03 point).
//   Then per-region rollup rows and per-segment rows.
// ---------------------------------------------------------------------------
function renderReport(perSegment, opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const { byRegion, national, segMeta } = rollupRegion(perSegment);

  // #4 fix: the SETTLED decision-grade rate is computed over the LIFECYCLE-TO-DATE population
  // (opts.settle — every adjudicated row, NO window_end filter) rather than the recent sold-window.
  // window_end is frozen at sample date and never refreshed on settle, while a booli_only row
  // settles 28–182d later — so on the recent-window filter a settled row is ALWAYS aged out at the
  // instant it settles, pinning the settle rate at ~0% forever (the drain's output is invisible).
  // The preliminary booli_only line below stays on the recent window (recency is meaningful for the
  // lag-contaminated raw number). Fallback to `national` keeps the pure --smoke working (it calls
  // renderReport without opts.settle).
  const settleNat = (opts.settle && opts.settle.national) || national;
  const settledNat = settledRate(settleNat);
  const terminalNat = settleNat.matched + settleNat.settled;
  const rawNat = rawBooliOnlyRate(national);
  const sinceLabel = opts.since ? ` since ${opts.since}` : '';

  const lines = [];
  lines.push(`Sold-match run — ${date}`);
  lines.push('');
  // LEAD: settled headline (decision-grade), terminal verdicts only, over all adjudicated rows.
  lines.push(`SETTLED genuine-non-Hemnet (decision-grade, lifecycle-to-date): ${pct(settledNat)}`
    + `  (${settleNat.settled}/${terminalNat} terminal verdicts)`);
  // apt/villa lifecycle-to-date settled cuts (houses settle firmer than apartments).
  if (opts.settle && opts.settle.byFamily) {
    for (const fam of ['APARTMENT', 'HOUSE']) {
      const b = opts.settle.byFamily[fam];
      if (!b || (b.matched + b.settled) === 0) continue;
      const label = fam === 'APARTMENT' ? 'Apartments' : 'Villas/houses';
      lines.push(`  ${rpad(label, 14)}settled=${pct(settledRate(b))}  (${b.settled}/${b.matched + b.settled})`);
    }
  }
  // SEPARATE labelled line: raw booli_only (preliminary / lag-contaminated), recent window only.
  lines.push(`preliminary booli_only (recent${sinceLabel}, lag-contaminated): ${pct(rawNat)}`
    + `  (${national.booliOnly}/${national.total})`);
  lines.push('');

  // Per-region rollup block.
  lines.push('By region:');
  const regionNames = Object.keys(byRegion).sort();
  for (const region of regionNames) {
    const b = byRegion[region];
    lines.push(renderSegmentRow(region, b));
    lines.push(`${rpad('', 22)}   settled=${pct(settledRate(b))}  raw booli_only=${pct(rawBooliOnlyRate(b))}`);
  }
  lines.push('');

  // By type (apartments vs villas) block.
  const byFamily = rollupFamily(perSegment, segMeta);
  lines.push('By type (apartments vs villas):');
  for (const fam of ['APARTMENT', 'HOUSE', 'Unknown']) {
    const b = byFamily[fam];
    if (!b || b.total === 0) continue;
    const label = fam === 'APARTMENT' ? 'Apartments' : fam === 'HOUSE' ? 'Villas/houses' : 'Unknown type';
    lines.push(renderSegmentRow(label, b));
    lines.push(`${rpad('', 22)}   settled=${pct(settledRate(b))}  raw booli_only=${pct(rawBooliOnlyRate(b))}`);
  }
  lines.push('');

  // Focus-area overlays block (additive — these rows ALSO counted in the muni/region/type
  // totals above). Only when raw rows are available (live run); skipped in pure-perSegment calls.
  if (opts.rows && OVERLAYS.length) {
    const overlays = bucketOverlays(opts.rows, OVERLAYS);
    const shown = OVERLAYS.filter((o) => overlays[o.name] && overlays[o.name].total > 0);
    if (shown.length) {
      lines.push('Focus areas (Stockholm overlays — also counted above):');
      for (const o of shown) {
        const b = overlays[o.name];
        lines.push(renderSegmentRow(o.name, b));
        lines.push(`${rpad('', 22)}   settled=${pct(settledRate(b))}  raw booli_only=${pct(rawBooliOnlyRate(b))}`);
      }
      lines.push('');
    }
  }

  // Per-segment block.
  lines.push('By segment:');
  const segKeys = Object.keys(perSegment).sort();
  for (const segKey of segKeys) {
    const b = perSegment[segKey];
    const meta = segMeta[segKey] || segmentToMuniRegion(segKey);
    const label = meta.family ? `${meta.muni}-${meta.family}` : segKey;
    lines.push(renderSegmentRow(label, b));
  }

  return '```\n' + lines.join('\n') + '\n```';
}

// ---------------------------------------------------------------------------
// DB query (live run() path only — NOT used by --smoke). Parameterized lookback
// (T-20-01: no string interpolation of segment/date). Returns rows shaped for
// bucketRows: { verdict, segment, was_enrolled, window_end }.
// ---------------------------------------------------------------------------
async function fetchRows(client, sinceDate) {
  const res = await client.query(
    `SELECT sm.verdict, sm.segment, (sm.first_unmatched_at IS NOT NULL) AS was_enrolled,
            to_char(sm.window_end, 'YYYY-MM-DD') AS window_end,
            bs.descriptive_area, bs.municipality
       FROM sold_match sm
       LEFT JOIN booli_sold bs ON bs.booli_id = sm.booli_id
      WHERE sm.window_end >= $1::date`,
    [sinceDate],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// fetchSettleRows(client) — #4 fix. The SETTLED decision-grade rate must be computed over the
// FULL lifecycle-to-date population, NOT the recent sold-window. window_end is frozen at sample
// date and never refreshed when a row settles (settleNonHemnet/advanceRecheck/clearRecheck in
// lib/sold-store.js leave window_end untouched), while a booli_only row settles 28–182d later —
// so a settled genuine_non_hemnet row's window_end is ALWAYS far older than the report's
// `window_end >= today-21d` filter at the instant it settles. Filtering the settle rate on
// window_end therefore pins it at ~0% forever (the drain's terminal verdicts are structurally
// invisible to the headline). This query has NO window_end filter: the settle headline counts
// every adjudicated row regardless of sample age. (The raw/preliminary booli_only rate stays on
// the recent window via fetchRows — recency IS meaningful for that lag-contaminated number.)
async function fetchSettleRows(client) {
  const res = await client.query(
    `SELECT sm.verdict, sm.segment, (sm.first_unmatched_at IS NOT NULL) AS was_enrolled
       FROM sold_match sm`,
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// fetchRunSummary(client) — OPTIONAL --from-run support (D-06). Reads the most
// recent sold-match-batch cron_job_log row and returns its result_summary recheck
// block, or null. Defensive: never throws (the shape may not exist yet).
// ---------------------------------------------------------------------------
async function fetchRunSummary(client) {
  try {
    const res = await client.query(
      `SELECT result_summary
         FROM cron_job_log
        WHERE script_name = 'sold-match-batch'
        ORDER BY started_at DESC NULLS LAST, id DESC
        LIMIT 1`,
    );
    if (!res.rows.length) return null;
    return res.rows[0].result_summary || null;
  } catch (e) {
    console.warn(`WARN: --from-run skipped (cron_job_log read failed: ${e && e.message})`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// fetchCohortRows — every verdict row carrying window_end, shaped for buildSeries. Static
// SELECT, no interpolated input. Mirrors sold-match-trend-chart.js fetchRows so the Slack
// number and the chart are computed from the same population.
async function fetchCohortRows(client) {
  const res = await client.query(
    `SELECT verdict, (first_unmatched_at IS NOT NULL) AS was_enrolled,
            to_char(window_end, 'YYYY-MM-DD') AS window_end
       FROM sold_match
      WHERE window_end IS NOT NULL
      ORDER BY window_end`,
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// renderMatchRateSummary — the minimal weekly Slack message (blank-slate redesign,
// 2026-07-07). Shows, most-recent first, the Matched-on-Hemnet share + sample size for the
// N most recent fortnightly runs (default 5 = latest + prior 4), and a link to the trend
// chart. Nothing else. Matched-on-Hemnet = buildSeries firstPull + incremental (matched /
// total), i.e. the same % the chart plots. `series` is the buildSeries output.
// ---------------------------------------------------------------------------
function renderMatchRateSummary(series, opts = {}) {
  const limit = opts.limit || 5;
  const n = (series.periods || []).length;
  const take = Math.min(limit, n);
  const rows = [];
  for (let i = n - 1; i >= n - take; i--) {
    const rate = (series.firstPull[i] || 0) + (series.incremental[i] || 0);
    rows.push({ week: series.periods[i], pct: rate * 100, n: series.totals[i] });
  }

  const lines = [':bar_chart: *Sold-match — Matched on Hemnet*', ''];
  if (rows.length === 0) {
    lines.push('_No cohorts with data yet._');
  } else {
    lines.push('```');
    lines.push('week        matched      n');
    for (const r of rows) {
      lines.push(`${rpad(r.week, 10)}  ${lpad(`${r.pct.toFixed(1)}%`, 6)}  ${lpad(String(r.n), 6)}`);
    }
    lines.push('```');
  }
  if (opts.chartUrl) {
    lines.push(`:chart_with_upwards_trend: <${opts.chartUrl}|Historical chart>`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// run() — live path. createClient/connect/try/finally(end) verbatim from the analog.
// Blank-slate minimal report: Matched-on-Hemnet % + n for the most recent runs + chart link.
// The detailed region/segment/settle renderers above are retained (dormant) for a later
// iteration but are no longer posted.
// ---------------------------------------------------------------------------
async function run() {
  const client = createClient();
  await client.connect();

  let cohortRows;
  try {
    cohortRows = await fetchCohortRows(client);
  } finally {
    await client.end();
  }

  const series = buildSeries(cohortRows);

  // Link the trend chart written by sold-match-trend-chart.js at view-data/<date>/sold-match/
  // trend.html and served by view-data-server.js. Same URL scheme as weekly-view-report.js.
  const today = new Date().toISOString().slice(0, 10);
  const host = process.env.VIEW_SERVER_HOST;
  const port = process.env.VIEW_SERVER_PORT || 3800;
  const chartUrl = host ? `http://${host}:${port}/view-data/${today}/sold-match/trend.html` : null;

  const message = renderMatchRateSummary(series, { chartUrl });
  console.log(message);

  if (process.env.SLACK_BOT_TOKEN) {
    const channel = process.env.SOLD_MATCH_SLACK_CHANNEL || process.env.SLACK_REVIEW_CHANNEL;
    const result = await postInfoMessage(channel, message);
    console.log(result ? '\nSlack notification sent' : '\nSlack post returned null');
  } else {
    console.log('\nSkipping Slack (SLACK_BOT_TOKEN not set)');
  }
}

module.exports = {
  bucketRows, settledRate, rawBooliOnlyRate, rollupRegion, rollupFamily, bucketOverlays,
  segmentToMuniRegion, renderReport, fetchSettleRows, renderMatchRateSummary,
};

// ---------------------------------------------------------------------------
// Entry gate: --smoke runs the offline self-test; otherwise run().
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  runSmoke();
} else if (require.main === module) {
  run().catch((err) => { console.error(err); process.exit(1); });
}

// ---------------------------------------------------------------------------
// --smoke self-test — fully offline (no DB, no network, no Slack post).
//   node sold-match-report.js --smoke
// Drives the pure helpers + renderReport on an in-script FIXTURE. Mirrors the
// check()/checkAsync()/pass-fail/process.exit pattern from lib/spotcheck-slack-bot.js.
// ---------------------------------------------------------------------------
function runSmoke() {
  // Ensure no bot token is active for the offline smoke run.
  const savedToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;

  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // FIXTURE: rows across two segments matching the real orchestrator format
  // "<muni>:<FAMILY>" (lib/sold-sample.js). The divergent segment (Stockholm:APARTMENT)
  // has matched=8, settled=2, booli_only=10 → settled 2/10=20%, raw 10/20=50%.
  function fixtureRows() {
    const rows = [];
    // Stockholm:APARTMENT — 8 matched (one late-resolved), 2 settled, 10 booli_only, 1 uncertain.
    for (let i = 0; i < 7; i++) rows.push({ verdict: 'matched', segment: 'Stockholm:APARTMENT', was_enrolled: false });
    rows.push({ verdict: 'matched', segment: 'Stockholm:APARTMENT', first_unmatched_at: '2026-06-01T00:00:00Z' }); // late-resolved
    for (let i = 0; i < 2; i++) rows.push({ verdict: 'genuine_non_hemnet', segment: 'Stockholm:APARTMENT', was_enrolled: true });
    for (let i = 0; i < 10; i++) rows.push({ verdict: 'booli_only', segment: 'Stockholm:APARTMENT', was_enrolled: true });
    rows.push({ verdict: 'uncertain', segment: 'Stockholm:APARTMENT', was_enrolled: false });
    // Göteborg:HOUSE — 3 matched, 1 settled, 2 booli_only. (region "Västra Götaland")
    for (let i = 0; i < 3; i++) rows.push({ verdict: 'matched', segment: 'Göteborg:HOUSE', was_enrolled: false });
    rows.push({ verdict: 'genuine_non_hemnet', segment: 'Göteborg:HOUSE', was_enrolled: true });
    for (let i = 0; i < 2; i++) rows.push({ verdict: 'booli_only', segment: 'Göteborg:HOUSE', was_enrolled: true });
    return rows;
  }

  (async () => {
    // 1. segment parsing matches the real orchestrator "<muni>:<FAMILY>" format.
    check('segmentToMuniRegion parses "Stockholm:APARTMENT" → muni+region+family', () => {
      const m = segmentToMuniRegion('Stockholm:APARTMENT');
      assert.strictEqual(m.muni, 'Stockholm');
      assert.strictEqual(m.region, 'Stockholm');
      assert.strictEqual(m.family, 'APARTMENT');
    });
    check('segmentToMuniRegion parses "Göteborg:HOUSE" → Västra Götaland', () => {
      const m = segmentToMuniRegion('Göteborg:HOUSE');
      assert.strictEqual(m.muni, 'Göteborg');
      assert.strictEqual(m.region, 'Västra Götaland');
      assert.strictEqual(m.family, 'HOUSE');
    });
    check('segmentToMuniRegion buckets an unparseable segment under Unknown (no throw)', () => {
      const m = segmentToMuniRegion('Atlantis:CASTLE');
      assert.strictEqual(m.region, 'Unknown');
    });

    // 2. bucketRows produces the D-05 buckets incl. lateResolved.
    check('bucketRows: late-resolved = matched AND first_unmatched_at not null', () => {
      const per = bucketRows(fixtureRows());
      const sthlm = per['Stockholm:APARTMENT'];
      assert.strictEqual(sthlm.matched, 8, 'matched=8');
      assert.strictEqual(sthlm.lateResolved, 1, 'lateResolved=1');
      assert.strictEqual(sthlm.settled, 2, 'settled=2');
      assert.strictEqual(sthlm.booliOnly, 10, 'booliOnly=10');
      assert.strictEqual(sthlm.uncertain, 1, 'uncertain=1');
      assert.strictEqual(sthlm.total, 21, 'total=21');
    });

    // 3. settledRate over terminal verdicts only — excludes in-recheck booli_only.
    check('settledRate = settled/(matched+settled) = 2/10, NOT 2/20', () => {
      const per = bucketRows(fixtureRows());
      const r = settledRate(per['Stockholm:APARTMENT']);
      assert.ok(Math.abs(r - 0.2) < 1e-9, `expected 0.20, got ${r}`);
    });
    check('settledRate excludes booli_only AND uncertain from denominator', () => {
      // matched=8, settled=2 → terminal 10; booli_only=10 + uncertain=1 excluded.
      const bucket = { matched: 8, settled: 2, booliOnly: 10, uncertain: 1, lateResolved: 0, total: 21 };
      assert.ok(Math.abs(settledRate(bucket) - 0.2) < 1e-9);
    });
    check('settledRate returns null with no terminal verdicts', () => {
      const bucket = { matched: 0, settled: 0, booliOnly: 5, uncertain: 1, lateResolved: 0, total: 6 };
      assert.strictEqual(settledRate(bucket), null);
    });

    // 4. rawBooliOnlyRate is a DISTINCT number (booli_only/total).
    check('rawBooliOnlyRate = booli_only/total = 10/21 (distinct from settled)', () => {
      const per = bucketRows(fixtureRows());
      const raw = rawBooliOnlyRate(per['Stockholm:APARTMENT']);
      assert.ok(Math.abs(raw - (10 / 21)) < 1e-9, `expected 10/21, got ${raw}`);
      const settled = settledRate(per['Stockholm:APARTMENT']);
      assert.notStrictEqual(raw, settled, 'raw and settled must differ');
    });

    // 5. region rollup: national settled from SUMMED terminal counts (not avg of rates).
    check('rollupRegion: national settled from summed terminal counts', () => {
      const per = bucketRows(fixtureRows());
      const { byRegion, national } = rollupRegion(per);
      // Stockholm region: matched 8, settled 2. Västra Götaland: matched 3, settled 1.
      assert.ok(byRegion['Stockholm'], 'Stockholm region present');
      assert.ok(byRegion['Västra Götaland'], 'Västra Götaland region present');
      assert.strictEqual(byRegion['Stockholm'].matched, 8);
      assert.strictEqual(byRegion['Västra Götaland'].matched, 3);
      // National terminal: matched 11, settled 3 → settled 3/14.
      assert.strictEqual(national.matched, 11, 'national matched=11');
      assert.strictEqual(national.settled, 3, 'national settled=3');
      const r = settledRate(national);
      assert.ok(Math.abs(r - (3 / 14)) < 1e-9, `national settled should be 3/14, got ${r}`);
    });

    // 6. renderReport: settled headline DISTINCT from raw booli_only label.
    check('renderReport has settled headline distinct from raw booli_only label', () => {
      const per = bucketRows(fixtureRows());
      const text = renderReport(per, { date: '2026-06-18' });
      assert.ok(/SETTLED genuine-non-Hemnet/.test(text), 'has settled headline');
      assert.ok(/preliminary booli_only/.test(text), 'has distinct raw booli_only label');
      assert.ok(/decision-grade/.test(text), 'settled labelled decision-grade');
      assert.ok(/lag-contaminated/.test(text), 'raw labelled lag-contaminated');
    });

    // 7. renderReport: the two NATIONAL rates differ and the settled headline shows the
    //    terminal-only math (national settled = 3/14 = 21.4%, raw = 12/27 = 44.4%).
    check('renderReport: settled value ≠ raw value for the divergent fixture', () => {
      const per = bucketRows(fixtureRows());
      const text = renderReport(per, { date: '2026-06-18' });
      // national: matched 11, settled 3, booli_only 12, total 27.
      assert.ok(text.includes('21.4%'), `expected national settled 21.4% (3/14) in:\n${text}`);
      assert.ok(text.includes('44.4%'), `expected national raw 44.4% (12/27) in:\n${text}`);
      assert.ok(text.includes('(3/14 terminal verdicts)'), 'settled denominator is terminal-only');
      assert.ok(text.includes('(12/27)'), 'raw denominator is total');
    });

    // 7b. #4 fix: fetchSettleRows queries ALL rows (NO window_end filter) so settled rows
    //     (window_end frozen months earlier) are not aged out of the settle decision rate.
    await checkAsync('fetchSettleRows: no window_end filter (settle pop = lifecycle-to-date)', async () => {
      let sql = '';
      const mockClient = { query: async (q) => { sql = q; return { rows: [] }; } };
      const out = await fetchSettleRows(mockClient);
      assert.ok(/FROM sold_match/.test(sql), 'selects from sold_match');
      assert.ok(!/window_end/.test(sql), 'must NOT filter on window_end');
      assert.deepStrictEqual(out, [], 'returns the query rows');
    });

    // 7c. #4 fix: with opts.settle, the LEAD settled rate uses the all-time settle population,
    //     while the preliminary booli_only rate still comes from the recent perSegment. Here the
    //     recent window has ONLY booli_only (settled would be n/a), but the lifecycle pop has
    //     3 matched + 1 settled → the headline must read 1/4 = 25.0%, NOT n/a.
    check('renderReport: opts.settle drives settled headline; raw stays recent-window', () => {
      const recent = bucketRows([
        { verdict: 'booli_only', segment: 'Stockholm:APARTMENT', was_enrolled: true },
        { verdict: 'booli_only', segment: 'Stockholm:APARTMENT', was_enrolled: true },
      ]);
      const settleSeg = bucketRows([
        { verdict: 'matched', segment: 'Stockholm:APARTMENT', was_enrolled: false },
        { verdict: 'matched', segment: 'Stockholm:APARTMENT', was_enrolled: false },
        { verdict: 'matched', segment: 'Stockholm:APARTMENT', was_enrolled: false },
        { verdict: 'genuine_non_hemnet', segment: 'Stockholm:APARTMENT', was_enrolled: true },
      ]);
      const sr = rollupRegion(settleSeg);
      const text = renderReport(recent, {
        date: '2026-06-18',
        settle: { national: sr.national, byFamily: rollupFamily(settleSeg, sr.segMeta) },
      });
      assert.ok(text.includes('(1/4 terminal verdicts)'), `settle denom from all-time pop in:\n${text}`);
      assert.ok(text.includes('25.0%'), 'lead settled = lifecycle 1/4 = 25.0%');
      assert.ok(text.includes('(2/2)'), 'raw booli_only denominator from the recent window');
      assert.ok(/lifecycle-to-date/.test(text), 'settled headline labelled lifecycle-to-date');
    });

    // 8. renderReport tolerates a null-rate cell (no terminal verdicts) → 'n/a', no crash.
    check('renderReport renders n/a for a region with no terminal verdicts', () => {
      const per = bucketRows([
        { verdict: 'booli_only', segment: 'Lund:APARTMENT', was_enrolled: true },
        { verdict: 'uncertain', segment: 'Lund:APARTMENT', was_enrolled: false },
      ]);
      const text = renderReport(per, { date: '2026-06-18' });
      assert.ok(/n\/a/.test(text), 'null settled rate rendered as n/a');
    });

    // 10. rollupFamily sums segment buckets by family (apartments vs villas).
    check('rollupFamily: APARTMENT total 21, HOUSE total 6 (from fixture segments)', () => {
      const per = bucketRows(fixtureRows());
      const { segMeta } = rollupRegion(per);
      const byFam = rollupFamily(per, segMeta);
      assert.ok(byFam.APARTMENT && byFam.APARTMENT.total === 21, `apt total 21, got ${byFam.APARTMENT && byFam.APARTMENT.total}`);
      assert.ok(byFam.HOUSE && byFam.HOUSE.total === 6, `house total 6, got ${byFam.HOUSE && byFam.HOUSE.total}`);
    });

    // 11. bucketOverlays joins by municipality + descriptive_area; wrong-muni & non-area excluded.
    check('bucketOverlays: Stockholm inner-city rows join overlays; other-muni/area excluded', () => {
      const rows = [
        { verdict: 'matched', municipality: 'Stockholm', descriptive_area: 'Östermalm' },
        { verdict: 'booli_only', municipality: 'Stockholm', descriptive_area: 'Södermalm' },
        { verdict: 'matched', municipality: 'Stockholm', descriptive_area: 'Bromma' },   // not innerstad
        { verdict: 'matched', municipality: 'Göteborg', descriptive_area: 'Östermalm' },  // wrong muni
      ];
      const ov = bucketOverlays(rows, OVERLAYS);
      assert.strictEqual(ov['Stockholm innerstad'].total, 2, `innerstad total 2, got ${ov['Stockholm innerstad'].total}`);
      assert.strictEqual(ov['Östermalm'].total, 1, `Östermalm total 1, got ${ov['Östermalm'].total}`);
      assert.strictEqual(ov['Stockholm innerstad'].matched, 1);
      assert.strictEqual(ov['Stockholm innerstad'].booliOnly, 1);
    });

    // 12. renderReport with rows shows the By-type + Focus-area overlay blocks.
    check('renderReport: shows apt-vs-villa + overlay blocks when rows provided', () => {
      const per = bucketRows(fixtureRows());
      const rows = [{ verdict: 'matched', segment: 'Stockholm:APARTMENT', municipality: 'Stockholm', descriptive_area: 'Östermalm' }];
      const text = renderReport(per, { date: '2026-06-19', rows });
      assert.ok(/By type \(apartments vs villas\)/.test(text), 'has apt-vs-villa block');
      assert.ok(/Apartments/.test(text), 'has Apartments row');
      assert.ok(/Focus areas/.test(text), 'has Focus areas block');
      assert.ok(/Stockholm innerstad/.test(text) && /Östermalm/.test(text), 'has both overlays');
    });

    // 9. with no token, postInfoMessage returns null (no post, no throw).
    await checkAsync('postInfoMessage returns null with no SLACK_BOT_TOKEN', async () => {
      const result = await postInfoMessage('C0test', 'hello');
      assert.strictEqual(result, null, `expected null, got ${JSON.stringify(result)}`);
    });

    // renderMatchRateSummary — the minimal weekly message: most-recent-first table of
    // Matched-on-Hemnet % + n, capped at `limit`, plus the chart link.
    check('renderMatchRateSummary: most-recent-first, correct %/n, capped, chart link', () => {
      const series = {
        periods: ['2026-W12', '2026-W25', '2026-W26', '2026-W28'],
        firstPull: [0.50, 0.761, 0.788, 0.77],
        incremental: [0, 0, 0, 0],
        totals: [54, 67, 1467, 985],
      };
      const msg = renderMatchRateSummary(series, { chartUrl: 'http://h:3800/x.html', limit: 5 });
      // most recent first
      const w28 = msg.indexOf('2026-W28');
      const w12 = msg.indexOf('2026-W12');
      assert.ok(w28 >= 0 && w12 >= 0 && w28 < w12, 'most recent (W28) listed before oldest (W12)');
      // latest row shows the 77.0% headline number and its sample size
      assert.ok(/2026-W28\s+77\.0%\s+985/.test(msg), 'W28 row shows 77.0% and n=985');
      assert.ok(/2026-W26\s+78\.8%\s+1467/.test(msg), 'W26 row shows 78.8% and n=1467');
      assert.ok(msg.includes('<http://h:3800/x.html|Historical chart>'), 'chart link present');
      assert.ok(msg.includes('Matched on Hemnet'), 'header present');
      // no leftover detailed sections
      assert.ok(!/settled|booli_only|region/i.test(msg), 'no detailed settle/booli_only/region text');
    });

    check('renderMatchRateSummary: caps at limit (5) of many cohorts', () => {
      const mk = (k) => `2026-W${String(k).padStart(2, '0')}`;
      const periods = []; const firstPull = []; const incremental = []; const totals = [];
      for (let i = 1; i <= 9; i++) { periods.push(mk(i)); firstPull.push(0.7); incremental.push(0); totals.push(100 + i); }
      const msg = renderMatchRateSummary({ periods, firstPull, incremental, totals }, { limit: 5 });
      const shown = (msg.match(/2026-W\d\d/g) || []);
      assert.strictEqual(shown.length, 5, `expected 5 rows, got ${shown.length}`);
      assert.strictEqual(shown[0], '2026-W09', 'newest first');
    });

    check('renderMatchRateSummary: empty series → graceful "no cohorts" (no crash)', () => {
      const msg = renderMatchRateSummary({ periods: [], firstPull: [], incremental: [], totals: [] }, {});
      assert.ok(msg.includes('No cohorts'), 'graceful empty message');
    });

    if (savedToken !== undefined) process.env.SLACK_BOT_TOKEN = savedToken;

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
