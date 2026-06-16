'use strict';

// spike-selfcheck.js — validation ladder. Asserts the fragile invariants on
// cached real pages (≈free) before the full run. Prints PASS/FAIL per check;
// exits non-zero on any failure so the build→check→fix loop can gate on it.

process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

const { cachedFetch, extractApollo, getOxylabsStats } = require('./spike-common');
const { parseBooliSoldCards, parseHemnetSaleCards } = require('./spike-sold-parse');
const { SEGMENTS } = require('./spike-config');
const { buildHemnetSoldUrl, addrCandidates, deltasFor } = require('./spike-hemnet-match');
const { adjudicatePair } = require('../lib/spotcheck-adjudicate');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then((info) => { pass++; console.log(`PASS  ${name}${info ? ' — ' + info : ''}`); })
    .catch((e) => { fail++; console.log(`FAIL  ${name} — ${e.message}`); });
}

(async () => {
  // 1. Booli sold parse + title-transfer signal (villa feed has >1 soldPriceType incl Lagfart).
  await check('booli sold parse + title-transfer signal', async () => {
    const r = await cachedFetch('https://www.booli.se/slutpriser?areaIds=20&objectType=Hus');
    const { apollo } = extractApollo(r.html);
    const cards = parseBooliSoldCards(apollo);
    if (cards.length < 10) throw new Error(`only ${cards.length} cards`);
    const withCore = cards.filter((c) => c.street_address && c.sold_price && c.sold_date && c.object_type);
    if (withCore.length / cards.length < 0.9) throw new Error(`only ${withCore.length}/${cards.length} have core fields`);
    const types = new Set(cards.map((c) => c.sold_price_type));
    if (types.size < 2) throw new Error(`soldPriceType has <2 values: ${[...types]}`);
    return `${cards.length} cards, soldPriceType={${[...types].join(',')}}`;
  });

  // 2. Hemnet SaleCard parse (rich card: address, finalPrice, soldAt, fee, broker, slug).
  await check('hemnet salecard parse', async () => {
    const r = await cachedFetch('https://www.hemnet.se/salda?location_ids%5B%5D=18031&item_types%5B%5D=bostadsratt');
    const { apollo } = extractApollo(r.html);
    const cards = parseHemnetSaleCards(apollo);
    if (cards.length < 10) throw new Error(`only ${cards.length} cards`);
    const c = cards[0];
    for (const k of ['street_address', 'final_price', 'sold_at', 'slug']) if (c[k] == null) throw new Error(`SaleCard missing ${k}`);
    return `${cards.length} cards; sample fee=${c.fee} broker=${c.broker_name || '?'}`;
  });

  // 3. Transport forced through Oxylabs (only meaningful if a live fetch happened this run).
  await check('transport forced Oxylabs (or all cached)', async () => {
    const s = getOxylabsStats();
    if (s.directSuccessCount > 0) throw new Error(`${s.directSuccessCount} direct-curl successes`);
    return s.oxylabsCallCount > 0 ? `${s.oxylabsCallCount} oxylabs calls` : 'all cached';
  });

  // 4. Golden match — a known true HOUSE pair adjudicates to a confirmable match.
  await check('golden house match (address+area+price)', async () => {
    const seg = SEGMENTS['taby-villa'];
    const booli = { street_address: 'Travslingan 4', sold_price: 9000000, living_area: 169, rooms: 7, object_type: 'Villa', sold_date: '2026-06-16' };
    const r = await cachedFetch(buildHemnetSoldUrl(booli, seg));
    const { apollo } = extractApollo(r.html);
    const cards = parseHemnetSaleCards(apollo);
    const cands = addrCandidates(booli, cards, 10);
    if (cands.length < 1) throw new Error('no address candidate for known match');
    const d = deltasFor(booli, cands[0]);
    if (!(d.area_pct_diff <= 0.07 && d.price_pct_diff <= 0.05)) throw new Error(`deltas too wide area=${d.area_pct_diff} price=${d.price_pct_diff}`);
    return `cand ${cands[0].street_address} areaΔ${(d.area_pct_diff * 100).toFixed(1)}%`;
  });

  // 5. Golden mismatch — adjudicatePair rejects price+area both diverging.
  await check('golden adjudicate mismatch (bothFieldGap)', async () => {
    const res = adjudicatePair({ deltas: { price_pct_diff: 0.2, area_pct_diff: 0.2 }, photos: { hemnet_gallery: [], booli_gallery: [] } });
    if (res.verdict !== 'CONFIRMED_MISMATCH') throw new Error(`expected MISMATCH got ${res.verdict}`);
    return res.source;
  });

  console.log(`\nself-check: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
