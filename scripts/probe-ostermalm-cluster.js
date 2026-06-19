// scripts/probe-ostermalm-cluster.js — ONE-OFF probe to resolve the Booli area IDs for the
// inner-city Stockholm hotspot cluster (Östermalm + Norrmalm + Vasastan + Kungsholmen) for the
// v3.1 dedicated sold-match focus segment, size each district's 14-day non-deed volume (confirm
// the ~75/cohort target is reachable), and capture the distinct descriptive_area labels used to
// attribute the additive Östermalm overlay in the report/chart.
//
// Resolution: the Area_V3 hydration trick from probe-national-panel.js — pass candidate areaIds
// to /slutpriser and read back the hydrated Area_V3 nodes — but WITHOUT the kommun-type filter
// (districts are not kommun nodes). Then for each matched district fetch the 14-day Hus + Lgh
// feed (totalCount + page-1 cards for descriptive_area labels).
//
// READ-ONLY: zero DB writes. Live Oxylabs (operator-approved 2026-06-19). Hard call cap.
//   SCRAPE_FORCE_OXYLABS=1 MAX_OXY_CALLS=50 node scripts/probe-ostermalm-cluster.js
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getWithRetry, extractNextData } = require('../lib/scrape-http');
const { parseBooliSoldCards } = require('../lib/sold-parse');

const OUT_DIR = path.join(__dirname, '..', 'verf-ostermalm-cluster');
const CAP = parseInt(process.env.MAX_OXY_CALLS || '50', 10);
const SCAN_MAX = parseInt(process.env.SCAN_MAX || '2000', 10);
const BATCH = 200; // areaIds per scan call
let calls = 0;
function budget() { if (calls >= CAP) throw new Error(`call cap ${CAP} hit (${calls})`); calls++; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

// Target district names (normalized match). Booli may spell Vasastan as Vasastaden.
const TARGETS = ['östermalm', 'norrmalm', 'vasastan', 'vasastaden', 'kungsholmen'];
const norm = (s) => (s || '').toString().trim().toLowerCase();

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const maxSoldDate = iso(today);
const minSoldDate = iso(new Date(today.getTime() - 14 * 86400000));

function apolloOf(html) {
  return extractNextData(html)?.props?.pageProps?.__APOLLO_STATE__ || {};
}

// Wide Area_V3 scan — dump EVERY hydrated area node (id, name, type), no type filter.
async function scanAreas() {
  const all = {}; // id -> {name, type}
  for (let a = 1; a <= SCAN_MAX; a += BATCH) {
    const b = Math.min(a + BATCH - 1, SCAN_MAX);
    const ids = []; for (let i = a; i <= b; i++) ids.push(i);
    const qs = ids.map((i) => `areaIds=${i}`).join('&');
    const url = `https://www.booli.se/slutpriser?${qs}&objectType=Hus`;
    budget();
    let res;
    try { res = await getWithRetry(url, { logger: () => {} }); }
    catch (e) { log(`  scan ${a}-${b}: ERROR ${e.message}`); continue; }
    if (res.status !== 200) { log(`  scan ${a}-${b}: HTTP ${res.status}`); await sleep(400); continue; }
    const apollo = apolloOf(res.html);
    let n = 0;
    for (const [k, v] of Object.entries(apollo)) {
      if (!k.startsWith('Area_V3:')) continue;
      const id = Number(k.slice(8));
      const name = (v.name || v.displayName || '').trim();
      if (name) { all[id] = { name, type: v.type || v.areaTypeName || '' }; n++; }
    }
    log(`  scan ${a}-${b}: +${n} area nodes (total ${Object.keys(all).length})`);
    await sleep(400);
  }
  return all;
}

async function soldFeed(areaId, objectType) {
  budget();
  const url = `https://www.booli.se/slutpriser?areaIds=${areaId}&objectType=${encodeURIComponent(objectType)}`
    + `&maxSoldDate=${maxSoldDate}&minSoldDate=${minSoldDate}&page=1`;
  const res = await getWithRetry(url, { logger: () => {} });
  if (res.status !== 200) return { total: null, cards: [] };
  const apollo = apolloOf(res.html);
  let total = null;
  const rq = apollo.ROOT_QUERY || {};
  for (const [k, v] of Object.entries(rq)) {
    if (k.startsWith('searchSold') && v && Number.isFinite(v.totalCount)) { total = v.totalCount; break; }
  }
  let cards = [];
  try { cards = parseBooliSoldCards(apollo) || []; } catch (e) { /* labels optional */ }
  return { total, cards };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`window ${minSoldDate}..${maxSoldDate} | scan 1..${SCAN_MAX} | cap=${CAP}`);

  log('--- scanning Booli Area_V3 namespace (no type filter) ---');
  const areas = await scanAreas();
  log(`scan complete: ${Object.keys(areas).length} area nodes`);

  // Match target districts by normalized name.
  const matched = [];
  for (const [id, info] of Object.entries(areas)) {
    if (TARGETS.includes(norm(info.name))) matched.push({ id: Number(id), name: info.name, type: info.type });
  }
  matched.sort((x, y) => x.name.localeCompare(y.name));
  log(`matched districts: ${matched.length ? matched.map((m) => `${m.name}=${m.id}(${m.type})`).join(', ') : 'NONE'}`);

  // Size each matched district + collect descriptive_area labels.
  const sized = [];
  const labelSet = {};
  for (const m of matched) {
    let hus = null; let lgh = null; const labels = new Set();
    try {
      const fH = await soldFeed(m.id, 'Hus'); hus = fH.total;
      for (const c of fH.cards) if (c.descriptive_area) labels.add(c.descriptive_area);
      await sleep(350);
      const fL = await soldFeed(m.id, 'Lägenhet'); lgh = fL.total;
      for (const c of fL.cards) if (c.descriptive_area) labels.add(c.descriptive_area);
      await sleep(350);
    } catch (e) { log(`  ${m.name}: size error ${e.message}`); }
    for (const l of labels) labelSet[l] = (labelSet[l] || 0) + 1;
    sized.push({ ...m, hus14: hus, lgh14: lgh, total14: (hus || 0) + (lgh || 0), labels: [...labels] });
    log(`  ${m.name} (id ${m.id}): Hus=${hus ?? '?'} Lgh=${lgh ?? '?'} total=${(hus || 0) + (lgh || 0)} labels=[${[...labels].join(', ')}]`);
  }

  const clusterTotal = sized.reduce((s, r) => s + (r.total14 || 0), 0);
  // Dump the full scanned namespace too (reusable for future district work).
  const scannedList = Object.entries(areas)
    .map(([id, info]) => ({ id: Number(id), name: info.name, type: info.type }))
    .sort((a, b) => a.id - b.id);

  fs.writeFileSync(path.join(OUT_DIR, 'cluster.json'), JSON.stringify({
    window: { minSoldDate, maxSoldDate }, calls, matched: sized,
    clusterTotal14: clusterTotal, descriptiveAreaLabels: labelSet,
  }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'all-areas-scanned.json'), JSON.stringify(scannedList, null, 2));

  console.log('\n=== INNER-CITY CLUSTER ===');
  console.log('district        id     Hus14  Lgh14  total14');
  for (const r of sized) {
    console.log(`${r.name.padEnd(14)} ${String(r.id).padStart(5)}  ${String(r.hus14 ?? '-').padStart(5)}  ${String(r.lgh14 ?? '-').padStart(5)}  ${String(r.total14).padStart(6)}`);
  }
  console.log(`\ncluster 14d non-deedish total (incl deeds): ${clusterTotal}  | target 75/cohort reachable: ${clusterTotal >= 75 ? 'YES' : 'CHECK'}`);
  console.log(`distinct descriptive_area labels: ${Object.keys(labelSet).length}`);
  console.log(`calls used: ${calls}`);
  const missing = TARGETS.filter((t) => t !== 'vasastaden' && !sized.some((s) => norm(s.name) === t || (t === 'vasastan' && norm(s.name) === 'vasastaden')));
  console.log(`unresolved targets: ${missing.length ? missing.join(', ') : 'none'}`);
  console.log(`written: ${path.join(OUT_DIR, 'cluster.json')} + all-areas-scanned.json`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
