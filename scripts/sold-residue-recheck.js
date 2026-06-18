// scripts/sold-residue-recheck.js — Re-run ONLY the unmatched/unclear residue through the
// improved bridge (SERP hardening + loosened villa gate + apartment fee gate), to measure
// the recall lift WITHOUT re-confirming the already-matched records.
//
// Input: verf-soldmatch-serp/overlap-properties.csv (the 500-property run).
// We take bucket ∈ {booli_only, uncertain} (78 rows) and re-run findHemnetListingByAddress.
// Cost note: the original (V1) SERP for these is already disk-cached, so re-running mostly
// pays only for the NEW broadened queries (V2/V3) + any new /bostad fetches + lazy apt fees.
//
//   MAX_OXY_CALLS=20000 node scripts/sold-residue-recheck.js
process.env.SCRAPE_FORCE_OXYLABS = '1';
process.env.MAX_OXY_CALLS = process.env.MAX_OXY_CALLS || '20000';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { cachedFetch, reserveOxylabsCall, procStats, stdoutLogger } = require('../lib/sold-transport');
const { findHemnetListingByAddress } = require('../lib/sold-serp');
const { fetchBooliDetail, extractDetailUrl } = require('../lib/sold-fetch-booli');

// minimal CSV line parser (handles quoted fields with embedded commas)
function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

(async () => {
  const log = stdoutLogger('residue');
  const csv = fs.readFileSync(path.join(__dirname, '..', 'verf-soldmatch-serp', 'overlap-properties.csv'), 'utf8').trim().split('\n');
  const rows = csv.slice(1).map(parseLine).map((p) => ({
    segKey: p[0], region: p[1], family: p[4], booli_id: p[5], street_address: p[6],
    descriptive_area: p[7], municipality: p[8], living_area: p[11] || null, rooms: p[12] || null,
    verdict: p[13], bucket: p[15],
  }));
  const residue = rows.filter((r) => r.bucket === 'booli_only' || r.bucket === 'uncertain');
  log('INFO', `total rows=${rows.length} residue=${residue.length} (booli_only=${residue.filter((r) => r.bucket === 'booli_only').length} uncertain=${residue.filter((r) => r.bucket === 'uncertain').length})`);

  const recovered = [];
  const stats = { booli_only: { n: 0, rec: 0 }, uncertain: { n: 0, rec: 0 } };
  const byFam = {};
  let i = 0;
  for (const r of residue) {
    stats[r.bucket].n++;
    byFam[r.family] = byFam[r.family] || { n: 0, rec: 0 };
    byFam[r.family].n++;
    // Booli detail URL for the lazy apt fee fetch (reconstruct from booli_id via /annons).
    const record = { ...r, residence_url: r.family === 'APARTMENT' ? `/annons/${r.booli_id}` : null };
    let res;
    try {
      res = await findHemnetListingByAddress(record, {
        family: r.family,
        logger: () => {},
        fetch: (u) => cachedFetch(u, { logger: () => {} }),
        reserve: reserveOxylabsCall,
        fetchBooliFee: r.family === 'APARTMENT'
          ? async () => { const d = await fetchBooliDetail(extractDetailUrl(record), { logger: () => {} }); return d ? d.rent : null; }
          : undefined,
      });
    } catch (e) { log('ERROR', `${r.booli_id}: ${e.message}`); res = { found: false, reason: 'error' }; }
    if (res.found) {
      stats[r.bucket].rec++; byFam[r.family].rec++;
      recovered.push({ ...r, query: res.query, gate: res.verified && res.verified.gate, state: res.state, url: res.url });
    }
    if (++i % 15 === 0) log('INFO', `...${i}/${residue.length} processed, ${recovered.length} recovered so far (oxy live=${procStats().live})`);
  }

  console.log('\n================ RESIDUE RE-CHECK (improved bridge on unmatched/unclear only) ================');
  console.log(`booli_only : ${stats.booli_only.rec}/${stats.booli_only.n} now recovered`);
  console.log(`uncertain  : ${stats.uncertain.rec}/${stats.uncertain.n} now recovered`);
  for (const [f, s] of Object.entries(byFam)) console.log(`  ${f}: ${s.rec}/${s.n} recovered`);
  console.log('\nrecovered detail (address | family | gate | via-query | state):');
  for (const r of recovered) console.log(`  ${r.street_address} (${r.region}) | ${r.family} | ${r.gate} | "${r.query}" | ${r.state}`);

  // restated overlap
  const totalRec = stats.booli_only.rec + stats.uncertain.rec;
  const N = rows.length;
  const onHemBefore = rows.filter((r) => r.bucket === 'salda' || r.bucket === 'bridge').length;
  console.log(`\noverlap BEFORE: ${onHemBefore}/${N} = ${(100 * onHemBefore / N).toFixed(1)}%`);
  console.log(`overlap AFTER : ${onHemBefore + totalRec}/${N} = ${(100 * (onHemBefore + totalRec) / N).toFixed(1)}%  (+${totalRec} recovered)`);
  console.log(`never-on-Hemnet now ≤ ${(100 * (residue.filter((r) => r.bucket === 'booli_only').length - stats.booli_only.rec) / N).toFixed(1)}%`);
  console.log(`\noxylabs this run: ${JSON.stringify(procStats())}`);

  fs.writeFileSync(path.join(__dirname, '..', 'verf-soldmatch-serp', 'residue-recheck.json'), JSON.stringify({ stats, byFam, recovered, procStats: procStats() }, null, 2));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
