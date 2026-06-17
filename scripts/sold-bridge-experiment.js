// scripts/sold-bridge-experiment.js — Hemnet-overlap experiment across 10 geographies.
//
// Goal (operator-requested 2026-06-17): measure how much of recent Booli-sold inventory
// is on Hemnet, using the search-engine bridge to recover the booli_only residue. Per
// region: take the most-recent N non-deed sold transactions (newest-first, so listings
// are fresh and their /bostad pages still resolve), run the FULL production matcher
// (scripts/sold-match-run matchOne with SOLD_MATCH_BRIDGE=1) against a mock pg client
// (no real DB writes), and tally:
//     salda  = matched via Hemnet /salda priced sale (address_key | fee_exact)
//     bridge = recovered via SERP /bostad lookup (bostad_bridge)   ← the lag false-positives
//     onHemnet = salda + bridge
//     uncertain / booli_only(genuine non-Hemnet) / error
//
// Output: per-region + aggregate Hemnet-overlap tables. Also writes a per-property CSV.
//
//   MAX_OXY_CALLS=20000 node scripts/sold-bridge-experiment.js [--limit N] [--conc K] [--only seg1,seg2]
//
// IMPORTANT: env set BEFORE requires (scrape-http/sold-transport read flags at load).
process.env.SCRAPE_FORCE_OXYLABS = '1';
process.env.SOLD_MATCH_BRIDGE = '1';
process.env.MAX_OXY_CALLS = process.env.MAX_OXY_CALLS || '20000';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { fetchBooliSoldPage } = require('../lib/sold-fetch-booli');
const { daysAgoISO } = require('../lib/sold-config');
const { stdoutLogger, procStats } = require('../lib/sold-transport');
const { matchOne } = require('./sold-match-run');

// ---------------------------------------------------------------------------
// The 10 geographies — 5 apartments / 5 villas, 4 counties, urban → rural.
// booli.areaIds resolved via scripts/probe-booli-areas.js; hemnet.locationId from
// lib/hemnet-locations.json. (Northern counties Norrbotten/Dalarna are absent from the
// repo's Hemnet location map — the queued expansion — so are out of scope here.)
// ---------------------------------------------------------------------------
const REGIONS = {
  'stockholm-apt': { label: 'Stockholm', family: 'APARTMENT', county: 'Stockholm', character: 'urban core',
    booli: { areaIds: 1, objectType: 'Lägenhet' }, hemnet: { locationId: 18031, itemType: 'bostadsratt' } },
  'goteborg-apt': { label: 'Göteborg', family: 'APARTMENT', county: 'Västra Götaland', character: 'urban core',
    booli: { areaIds: 22, objectType: 'Lägenhet' }, hemnet: { locationId: 17920, itemType: 'bostadsratt' } },
  'malmo-apt': { label: 'Malmö', family: 'APARTMENT', county: 'Skåne', character: 'urban core',
    booli: { areaIds: 78, objectType: 'Lägenhet' }, hemnet: { locationId: 17989, itemType: 'bostadsratt' } },
  'uppsala-apt': { label: 'Uppsala', family: 'APARTMENT', county: 'Uppsala', character: 'urban',
    booli: { areaIds: 419, objectType: 'Lägenhet' }, hemnet: { locationId: 17800, itemType: 'bostadsratt' } },
  'nacka-apt': { label: 'Nacka', family: 'APARTMENT', county: 'Stockholm', character: 'affluent suburb',
    booli: { areaIds: 76, objectType: 'Lägenhet' }, hemnet: { locationId: 17853, itemType: 'bostadsratt' } },
  'taby-villa': { label: 'Täby', family: 'HOUSE', county: 'Stockholm', character: 'affluent suburb',
    booli: { areaIds: 20, objectType: 'Hus' }, hemnet: { locationId: 17793, itemType: null } },
  'kungalv-villa': { label: 'Kungälv', family: 'HOUSE', county: 'Västra Götaland', character: 'semi-urban coastal',
    booli: { areaIds: 229, objectType: 'Hus' }, hemnet: { locationId: 17973, itemType: null } },
  'norrtalje-villa': { label: 'Norrtälje', family: 'HOUSE', county: 'Stockholm', character: 'semi-rural coastal',
    booli: { areaIds: 9, objectType: 'Hus' }, hemnet: { locationId: 18003, itemType: null } },
  'alingsas-villa': { label: 'Alingsås', family: 'HOUSE', county: 'Västra Götaland', character: 'small town',
    booli: { areaIds: 151, objectType: 'Hus' }, hemnet: { locationId: 17866, itemType: null } },
  'lund-villa': { label: 'Lund', family: 'HOUSE', county: 'Skåne', character: 'university town + rural',
    booli: { areaIds: 97, objectType: 'Hus' }, hemnet: { locationId: 17987, itemType: null } },
};

function parseArgs(argv) {
  const o = { limit: 50, conc: 5, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a.startsWith('--limit=')) o.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--conc') o.conc = parseInt(argv[++i], 10);
    else if (a.startsWith('--conc=')) o.conc = parseInt(a.split('=')[1], 10);
    else if (a === '--only') o.only = argv[++i].split(',');
    else if (a.startsWith('--only=')) o.only = a.split('=')[1].split(',');
  }
  return o;
}

// Mock pg client (mirrors sold-match-run --smoke): records queries, returns empty rows.
function mockClient() {
  const queries = [];
  return { queries, async query(sql, params) { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
}
function readVerdict(c) {
  const q = c.queries.find((x) => /INSERT INTO sold_match/.test(x.sql));
  if (!q) return { verdict: 'error', method: null, evidence: null };
  let evidence = null;
  try { evidence = typeof q.params[4] === 'string' ? JSON.parse(q.params[4]) : q.params[4]; } catch (_) {}
  return { verdict: q.params[2] || 'error', method: q.params[3] || null, evidence };
}

// Seed the most-recent `limit` non-deed sold records (newest-first; Booli /slutpriser
// defaults to soldDate desc). Walk pages until we have `limit` or run out.
async function seedRegion(segKey, seg, limit, log) {
  const maxSoldDate = daysAgoISO(0); // today — freshest window (operator: keep listings live)
  const queue = [];
  let page = 1, pagesAvail = null, transfers = 0;
  const MAX_PAGES = 14;
  while (queue.length < limit && page <= MAX_PAGES) {
    const { cards, meta } = await fetchBooliSoldPage(segKey, seg, { page, maxSoldDate, logger: () => {} });
    if (meta && meta.pages != null) pagesAvail = meta.pages;
    if (!cards.length) break;
    for (const card of cards) {
      if (card.is_title_transfer) { transfers++; continue; }
      if (queue.length < limit) queue.push(card);
    }
    if (pagesAvail != null && page >= pagesAvail) break;
    page++;
  }
  log('INFO', `${segKey}: seeded ${queue.length} non-deed (skipped ${transfers} deed transfers, ${page - 1} pages, feed pages=${pagesAvail})`);
  return queue;
}

// Run the production matcher over the queue with a bounded worker pool.
async function classifyRegion(segKey, seg, queue, conc, log) {
  const WIN = [null, daysAgoISO(0)];
  const rows = [];
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const record = queue[idx++];
      const c = mockClient();
      let verdict = 'error', method = null, evidence = null;
      try {
        await matchOne(c, record, seg, segKey, WIN[0], WIN[1], () => {});
        ({ verdict, method, evidence } = readVerdict(c));
      } catch (e) {
        log('ERROR', `${segKey} booli_id=${record.booli_id}: ${e && e.message}`);
      }
      // bucket
      let bucket;
      if (verdict === 'matched' && method === 'bostad_bridge') bucket = 'bridge';
      else if (verdict === 'matched') bucket = 'salda';
      else if (verdict === 'uncertain') bucket = 'uncertain';
      else if (verdict === 'booli_only') bucket = 'booli_only';
      else bucket = 'error';
      rows.push({
        segKey, region: seg.label, county: seg.county, character: seg.character, family: seg.family,
        booli_id: record.booli_id, street_address: record.street_address,
        descriptive_area: record.descriptive_area, municipality: record.municipality,
        sold_date: record.sold_date, sold_price: record.sold_price,
        living_area: record.living_area, rooms: record.rooms,
        verdict, method, bucket,
        bridge_url: evidence && evidence.bridge_url ? evidence.bridge_url : null,
        bridge_state: evidence && evidence.bridge_state ? evidence.bridge_state : null,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, conc) }, () => worker()));
  return rows;
}

function tally(rows) {
  const t = { N: rows.length, salda: 0, bridge: 0, uncertain: 0, booli_only: 0, error: 0 };
  for (const r of rows) t[r.bucket]++;
  t.onHemnet = t.salda + t.bridge;
  const denom = t.N - t.error;
  t.overlapPct = denom > 0 ? (t.onHemnet / denom) * 100 : 0;
  t.saldaPct = denom > 0 ? (t.salda / denom) * 100 : 0;
  return t;
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function padl(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function printRegionTable(summaries) {
  const cols = [['Region', 11], ['Type', 5], ['County', 16], ['Character', 22], ['N', 4], ['salda', 6], ['bridge', 7], ['onHem', 6], ['unc', 4], ['b_only', 7], ['err', 4], ['overlap%', 9], ['salda%', 8]];
  const header = cols.map(([h, w]) => pad(h, w)).join(' ');
  console.log('\n' + '='.repeat(header.length));
  console.log('  HEMNET OVERLAP BY REGION  (onHem = salda + bridge; overlap% = onHem / (N − err))');
  console.log('='.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const s of summaries) {
    const t = s.t;
    console.log([
      pad(s.region, 11), pad(s.family === 'APARTMENT' ? 'apt' : 'villa', 5),
      pad(s.county, 16), pad(s.character, 22),
      padl(t.N, 4), padl(t.salda, 6), padl(t.bridge, 7), padl(t.onHemnet, 6),
      padl(t.uncertain, 4), padl(t.booli_only, 7), padl(t.error, 4),
      padl(t.overlapPct.toFixed(1), 9), padl(t.saldaPct.toFixed(1), 8),
    ].join(' '));
  }
  console.log('-'.repeat(header.length));
}

function printAggregate(summaries) {
  const sum = (k) => summaries.reduce((a, s) => a + s.t[k], 0);
  const agg = { N: sum('N'), salda: sum('salda'), bridge: sum('bridge'), uncertain: sum('uncertain'), booli_only: sum('booli_only'), error: sum('error') };
  agg.onHemnet = agg.salda + agg.bridge;
  const denom = agg.N - agg.error;
  const ov = denom > 0 ? (agg.onHemnet / denom) * 100 : 0;
  const sov = denom > 0 ? (agg.salda / denom) * 100 : 0;
  const byFam = (fam) => {
    const ss = summaries.filter((s) => s.family === fam);
    const f = { N: 0, salda: 0, bridge: 0, uncertain: 0, booli_only: 0, error: 0 };
    for (const s of ss) for (const k of Object.keys(f)) f[k] += s.t[k];
    const d = f.N - f.error;
    return { ...f, onHemnet: f.salda + f.bridge, overlapPct: d > 0 ? ((f.salda + f.bridge) / d) * 100 : 0, saldaPct: d > 0 ? (f.salda / d) * 100 : 0 };
  };
  console.log('\n' + '='.repeat(70));
  console.log('  AGGREGATE');
  console.log('='.repeat(70));
  console.log(`  total non-deed adjudicated : ${agg.N}`);
  console.log(`  on Hemnet (salda + bridge) : ${agg.onHemnet}  (${ov.toFixed(1)}%)`);
  console.log(`     via /salda priced sale  : ${agg.salda}  (${sov.toFixed(1)}%)`);
  console.log(`     via SERP /bostad bridge : ${agg.bridge}  (+${(ov - sov).toFixed(1)} pts recovered from booli_only)`);
  console.log(`  uncertain                  : ${agg.uncertain}`);
  console.log(`  genuine non-Hemnet         : ${agg.booli_only}`);
  console.log(`  error                      : ${agg.error}`);
  const fa = byFam('APARTMENT'), fv = byFam('HOUSE');
  console.log(`\n  apartments: N=${fa.N}  onHemnet=${fa.onHemnet} (${fa.overlapPct.toFixed(1)}%)  [salda ${fa.saldaPct.toFixed(1)}% + bridge ${fa.bridge}]`);
  console.log(`  villas    : N=${fv.N}  onHemnet=${fv.onHemnet} (${fv.overlapPct.toFixed(1)}%)  [salda ${fv.saldaPct.toFixed(1)}% + bridge ${fv.bridge}]`);
  console.log('='.repeat(70));
}

function writeCsv(file, rows) {
  const cols = ['segKey', 'region', 'county', 'character', 'family', 'booli_id', 'street_address', 'descriptive_area', 'municipality', 'sold_date', 'sold_price', 'living_area', 'rooms', 'verdict', 'method', 'bucket', 'bridge_url', 'bridge_state'];
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = stdoutLogger('serp-exp');
  const keys = args.only ? args.only.filter((k) => REGIONS[k]) : Object.keys(REGIONS);
  log('INFO', `regions=${keys.length} limit=${args.limit} conc=${args.conc} maxOxy=${process.env.MAX_OXY_CALLS}`);

  const summaries = [];
  const allRows = [];
  for (const segKey of keys) {
    const seg = REGIONS[segKey];
    const t0 = Date.now ? null : null; // Date.now unused (deterministic-friendly)
    log('INFO', `--- ${segKey} (${seg.label} ${seg.family}) ---`);
    let queue = [];
    try { queue = await seedRegion(segKey, seg, args.limit, log); }
    catch (e) { log('ERROR', `${segKey} seed failed: ${e.message}`); }
    const rows = queue.length ? await classifyRegion(segKey, seg, queue, args.conc, log) : [];
    allRows.push(...rows);
    const t = tally(rows);
    summaries.push({ segKey, region: seg.label, county: seg.county, character: seg.character, family: seg.family, t });
    log('INFO', `${segKey} DONE: N=${t.N} salda=${t.salda} bridge=${t.bridge} onHemnet=${t.onHemnet} unc=${t.uncertain} booli_only=${t.booli_only} err=${t.error} overlap=${t.overlapPct.toFixed(1)}%`);
    // Incremental checkpoint: persist cumulative rows + summaries after each region so a
    // mid-run interruption never loses completed regions (re-running is cheap — caches).
    const outDirCk = path.join(__dirname, '..', 'verf-soldmatch-serp');
    try {
      writeCsv(path.join(outDirCk, 'overlap-properties.csv'), allRows);
      fs.writeFileSync(path.join(outDirCk, 'overlap-summary.json'), JSON.stringify({ summaries, procStats: procStats() }, null, 2));
    } catch (e) { log('WARN', `checkpoint write failed: ${e.message}`); }
  }

  printRegionTable(summaries);
  printAggregate(summaries);

  const outDir = path.join(__dirname, '..', 'verf-soldmatch-serp');
  writeCsv(path.join(outDir, 'overlap-properties.csv'), allRows);
  fs.writeFileSync(path.join(outDir, 'overlap-summary.json'), JSON.stringify({ summaries, procStats: procStats() }, null, 2));
  console.log(`\nper-property CSV: verf-soldmatch-serp/overlap-properties.csv (${allRows.length} rows)`);
  console.log(`oxylabs: ${JSON.stringify(procStats())}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}

module.exports = { REGIONS, seedRegion, classifyRegion, tally, readVerdict };
