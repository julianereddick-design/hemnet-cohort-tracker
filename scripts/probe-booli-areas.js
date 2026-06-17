// scripts/probe-booli-areas.js — resolve Booli areaId -> municipality name by reading
// Area_V3 nodes (per reference_booli_hemnet_sold_schema). Pass a batch of areaIds in one
// /slutpriser URL; Booli hydrates Area_V3:<id> nodes with name/displayName/type/parent.
//
//   SCRAPE_FORCE_OXYLABS=1 node scripts/probe-booli-areas.js
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();
const { getWithRetry, extractNextData } = require('../lib/scrape-http');

// Batches of candidate areaIds. Known municipality IDs cluster low (1-40) with a few
// higher (Kungälv=229); probe broadly.
function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; }
const BATCHES = [range(335, 430)];

async function probeBatch(ids) {
  const qs = ids.map((i) => `areaIds=${i}`).join('&');
  const url = `https://www.booli.se/slutpriser?${qs}&objectType=Hus`;
  const res = await getWithRetry(url, {});
  if (res.status !== 200) { console.log(`  batch ${ids[0]}-${ids[ids.length - 1]}: status ${res.status}`); return {}; }
  const data = extractNextData(res.html);
  const apollo = data?.props?.pageProps?.__APOLLO_STATE__ || {};
  const found = {};
  for (const [k, v] of Object.entries(apollo)) {
    if (!k.startsWith('Area_V3:')) continue;
    const id = k.slice('Area_V3:'.length);
    found[id] = { name: v.name ?? v.displayName ?? null, type: v.type ?? null, parent: v.parentDisplayName ?? null };
  }
  return found;
}

(async () => {
  const all = {};
  for (const ids of BATCHES) {
    const found = await probeBatch(ids);
    Object.assign(all, found);
    console.log(`batch ${ids[0]}-${ids[ids.length - 1]}: +${Object.keys(found).length} areas`);
  }
  console.log('\n=== resolved areas (id: name [type] / parent) ===');
  const rows = Object.entries(all).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [id, a] of rows) console.log(`  ${id}: ${a.name} [${a.type}] / ${a.parent}`);

  // highlight the municipalities I want for the experiment mix
  const WANT = ['Stockholm', 'Göteborg', 'Malmö', 'Uppsala', 'Helsingborg', 'Lund', 'Täby', 'Sollentuna', 'Kungälv', 'Norrtälje', 'Alingsås', 'Nacka', 'Luleå', 'Falun', 'Umeå'];
  console.log('\n=== wanted municipalities ===');
  for (const w of WANT) {
    const hit = rows.find(([, a]) => a.name === w && /kommun|municipal/i.test(a.type || ''));
    const any = rows.find(([, a]) => a.name === w);
    console.log(`  ${w}: ${hit ? hit[0] + ' [' + hit[1].type + ']' : any ? any[0] + ' [' + any[1].type + '] (non-kommun?)' : 'NOT FOUND in probed ranges'}`);
  }
})();
