// scripts/probe-national-panel.js — ONE-OFF probe to assemble a population-weighted
// national municipality panel for the fortnightly sold-match sample (v3.1 Phase 19/20).
//
// For each panel municipality it resolves:
//   - Booli areaId   (scan Area_V3 nodes across ID ranges, match by name)
//   - Hemnet location_id  (hemnet.se/locations/show?q=<name>, prefer the "<name> kommun" muni)
//   - 14-day sold totalCount for Hus + Lägenhet  (sizing: confirm >=1000 total + allocate)
//
// READ-ONLY: zero DB writes. Live Oxylabs (operator-approved 2026-06-18). Hard call cap.
//   SCRAPE_FORCE_OXYLABS=1 MAX_OXY_CALLS=160 node scripts/probe-national-panel.js
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData } = require('../lib/scrape-http');

const OUT_DIR = path.join(__dirname, '..', 'verf-national-panel');
const CAP = parseInt(process.env.MAX_OXY_CALLS || '160', 10);
let calls = 0;
function budget() { if (calls >= CAP) throw new Error(`call cap ${CAP} hit`); calls++; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

// Population-weighted panel: 3 metros + mid cities + a regional/northern/Gotland spread.
// pop = approx municipality population (thousands) for allocation weighting only.
const PANEL = [
  ['Stockholm', 980], ['Göteborg', 590], ['Malmö', 360], ['Uppsala', 240],
  ['Linköping', 165], ['Örebro', 160], ['Västerås', 155], ['Helsingborg', 150],
  ['Norrköping', 145], ['Jönköping', 145], ['Umeå', 130], ['Lund', 130],
  ['Borås', 115], ['Nacka', 107], ['Eskilstuna', 110], ['Halmstad', 105],
  ['Gävle', 105], ['Södertälje', 100], ['Sundsvall', 99], ['Växjö', 95],
  ['Karlstad', 95], ['Luleå', 79], ['Täby', 73], ['Kalmar', 70],
  ['Östersund', 65], ['Visby', 61], ['Falun', 60], ['Trollhättan', 60],
  ['Kungälv', 47], ['Kiruna', 22],
];

// Known Booli areaIds (from reference_booli_hemnet_sold_schema + live tests) to skip scanning.
const KNOWN_BOOLI = { Stockholm: 1, Göteborg: 22, Täby: 20, Kungälv: 229, Solna: 35,
  Nynäshamn: 4, Sigtuna: 6, Norrtälje: 9, Sollentuna: 13, Värmdö: 16, Danderyd: 18 };

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const maxSoldDate = iso(today);
const minSoldDate = iso(new Date(today.getTime() - 14 * 86400000));

async function booliAreaScan(ranges) {
  // Pass a batch of candidate areaIds in one /slutpriser URL; read hydrated Area_V3 nodes.
  const found = {}; // name(lower) -> {id, type}
  for (const [a, b] of ranges) {
    const ids = []; for (let i = a; i <= b; i++) ids.push(i);
    const qs = ids.map((i) => `areaIds=${i}`).join('&');
    const url = `https://www.booli.se/slutpriser?${qs}&objectType=Hus`;
    budget();
    const res = await getWithRetry(url, { logger: () => {} });
    if (res.status !== 200) { log(`  booli scan ${a}-${b}: HTTP ${res.status}`); continue; }
    const apollo = extractNextData(res.html)?.props?.pageProps?.__APOLLO_STATE__ || {};
    let n = 0;
    for (const [k, v] of Object.entries(apollo)) {
      if (!k.startsWith('Area_V3:')) continue;
      const nm = (v.name || v.displayName || '').trim();
      const ty = v.type || '';
      if (nm && /kommun|municipal/i.test(ty)) { found[nm.toLowerCase()] = { id: Number(k.slice(8)), type: ty }; n++; }
    }
    log(`  booli scan ${a}-${b}: +${n} kommun nodes`);
    await sleep(400);
  }
  return found;
}

async function hemnetLocation(name) {
  budget();
  const url = `https://www.hemnet.se/locations/show?q=${encodeURIComponent(name)}`;
  let body;
  for (const wait of [0, 4000, 12000]) {
    if (wait) await sleep(wait);
    try {
      const res = await getWithRetry(url, { logger: () => {} });
      if (res.status === 200 && res.html) { body = JSON.parse(res.html); break; }
    } catch (e) { /* retry */ }
  }
  if (!Array.isArray(body)) return null;
  const munis = body.filter((b) => b && b.location_type === 'municipality');
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const pick = munis.find((m) => m.slug === `${slug}s-kommun`) || munis.find((m) => m.slug === `${slug}-kommun`)
    || munis.find((m) => (m.name || '').toLowerCase().startsWith(name.toLowerCase())) || munis[0];
  return pick ? { id: Number(pick.id), name: pick.name, slug: pick.slug } : null;
}

async function soldCount(areaId, objectType) {
  budget();
  const url = `https://www.booli.se/slutpriser?areaIds=${areaId}&objectType=${encodeURIComponent(objectType)}`
    + `&maxSoldDate=${maxSoldDate}&minSoldDate=${minSoldDate}&page=1`;
  const res = await getWithRetry(url, { logger: () => {} });
  if (res.status !== 200) return null;
  const apollo = extractNextData(res.html)?.props?.pageProps?.__APOLLO_STATE__ || {};
  for (const [k, v] of Object.entries(apollo)) {
    if (k.startsWith('ROOT_QUERY') || (v && typeof v === 'object' && 'totalCount' in v)) {
      if (v && typeof v === 'object' && Number.isFinite(v.totalCount)) return v.totalCount;
    }
  }
  // fallback: search ROOT_QUERY.searchSold(...) value
  const rq = apollo.ROOT_QUERY || {};
  for (const [k, v] of Object.entries(rq)) {
    if (k.startsWith('searchSold') && v && Number.isFinite(v.totalCount)) return v.totalCount;
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`panel=${PANEL.length} munis | window ${minSoldDate}..${maxSoldDate} | cap=${CAP}`);

  // 1) Booli areaIds: known first, scan the rest.
  log('--- resolving Booli areaIds (scan) ---');
  const scanned = await booliAreaScan([[1, 100], [100, 200], [200, 300], [300, 400], [400, 500]]);
  log(`  scan found ${Object.keys(scanned).length} kommun nodes total`);

  const rows = [];
  for (const [name, pop] of PANEL) {
    let booliId = KNOWN_BOOLI[name] ?? null;
    if (booliId == null) {
      const hit = scanned[name.toLowerCase()];
      booliId = hit ? hit.id : null;
    }
    rows.push({ name, pop, booliId, hemnetId: null, hus14: null, lgh14: null });
  }

  // 2) Hemnet location_ids
  log('--- resolving Hemnet location_ids ---');
  for (const r of rows) {
    const loc = await hemnetLocation(r.name);
    r.hemnetId = loc ? loc.id : null;
    log(`  ${r.name}: booli=${r.booliId ?? '?'} hemnet=${r.hemnetId ?? '?'} (${loc ? loc.slug : 'no-loc'})`);
    await sleep(500);
  }

  // 3) 14-day sold counts (only where booliId resolved)
  log('--- 14-day sold counts (Hus / Lägenhet) ---');
  for (const r of rows) {
    if (r.booliId == null) { log(`  ${r.name}: SKIP (no booliId)`); continue; }
    try {
      r.hus14 = await soldCount(r.booliId, 'Hus'); await sleep(350);
      r.lgh14 = await soldCount(r.booliId, 'Lägenhet'); await sleep(350);
    } catch (e) { log(`  ${r.name}: count error ${e.message}`); break; }
    log(`  ${r.name}: Hus=${r.hus14 ?? '?'} Lgh=${r.lgh14 ?? '?'}`);
  }

  const totalNonDeedish = rows.reduce((s, r) => s + (r.hus14 || 0) + (r.lgh14 || 0), 0);
  fs.writeFileSync(path.join(OUT_DIR, 'panel.json'),
    JSON.stringify({ window: { minSoldDate, maxSoldDate }, calls, rows, totalNonDeedish }, null, 2));

  console.log('\n=== PANEL ===');
  console.log('muni            pop   booliId  hemnetId  Hus14  Lgh14');
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(14)} ${String(r.pop).padStart(4)}  ${String(r.booliId ?? '-').padStart(7)}  `
      + `${String(r.hemnetId ?? '-').padStart(8)}  ${String(r.hus14 ?? '-').padStart(5)}  ${String(r.lgh14 ?? '-').padStart(5)}`);
  }
  const unres = rows.filter((r) => r.booliId == null || r.hemnetId == null).map((r) => r.name);
  console.log(`\ntotal 14d (Hus+Lgh, all-types incl deeds): ${totalNonDeedish}  | calls used: ${calls}`);
  console.log(`unresolved: ${unres.length ? unres.join(', ') : 'none'}`);
  console.log(`written: ${path.join(OUT_DIR, 'panel.json')}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
