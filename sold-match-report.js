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

  const settledNat = settledRate(national);
  const rawNat = rawBooliOnlyRate(national);
  const terminalNat = national.matched + national.settled;

  const lines = [];
  lines.push(`Sold-match run — ${date}`);
  lines.push('');
  // LEAD: settled headline (decision-grade), terminal verdicts only.
  lines.push(`SETTLED genuine-non-Hemnet (decision-grade): ${pct(settledNat)}`
    + `  (${national.settled}/${terminalNat} terminal verdicts)`);
  // SEPARATE labelled line: raw booli_only (preliminary / lag-contaminated).
  lines.push(`preliminary booli_only (lag-contaminated, draining ~4wk): ${pct(rawNat)}`
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
// run() — live path. createClient/connect/try/finally(end) verbatim from the analog.
// ---------------------------------------------------------------------------
async function run() {
  // Lookback defaults to today − 21 days (one fortnight + buffer); REPORT_SINCE overrides.
  let since = process.env.REPORT_SINCE;
  if (!since) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 21);
    since = d.toISOString().slice(0, 10);
  }
  const fromRun = process.argv.includes('--from-run');

  const client = createClient();
  await client.connect();

  let rows;
  let runSummary = null;
  try {
    rows = await fetchRows(client, since);
    if (fromRun) runSummary = await fetchRunSummary(client);
  } finally {
    await client.end();
  }

  const perSegment = bucketRows(rows);
  let message = renderReport(perSegment, { date: new Date().toISOString().slice(0, 10), rows });

  if (fromRun && runSummary && runSummary.recheck) {
    const r = runSummary.recheck;
    message += '\n```\n'
      + 'Last batch re-check drain:\n'
      + `enrolled=${r.enrolled} rechecked=${r.rechecked} lateMatched=${r.lateMatched} `
      + `stillPending=${r.stillPending} uncertain=${r.uncertain} settled=${r.settled}`
      + '\n```';
  }

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
  segmentToMuniRegion, renderReport,
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

    if (savedToken !== undefined) process.env.SLACK_BOT_TOKEN = savedToken;

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
