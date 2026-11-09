'use strict';
// lib/sold-ad-type.js — what kind of Hemnet ad a sold home had, for sold-match.
//
// Sold-match says whether a Booli-sold home is "on Hemnet". Since Oct 2026 Hemnet also shows
// free (MINIMAL) and aggregated ads, so "on Hemnet" no longer means "a paid Hemnet ad". Sold
// pages carry no package, so we look the home up in the ad registry (lib/ad-registry.js),
// which records each ad's package while it is live:
//   1. by the ad id on the sold card (or on the listing page the address fallback found), and
//   2. by street address + kommun, for ads live within the months around the sale (catches a
//      home relisted under a new id, and sold cards that carry no id).
// Rule (agreed 2026-11-03): a home counts as PAID if any of its ads was seen with a paid
// package at any point while listed (lib/listing-segment.js homeClassOf).
//
// Types: paid | newbuild | free | aggregated | teaser | other
//        no_ad_found — the sold card has no ad id and the registry has no ad for that home.
//                     Hemnet sold cards with an empty listingId show no package and no labels
//                     (seen 2026-11-03), but they are NOT proof of no ad: about half of the
//                     no-id matches since June had a live Hemnet ad at the same address in
//                     hemnet_listingv2. Read this as "no ad found", never "no ad".
//        not_known  — an ad id exists but the registry never saw that ad live (mostly ads
//                     that came down before the registry started on 2026-11-04)
//
// Earlier evidence (2026-11-10). The registry only sees ads live from 3–4 Nov. A home whose
// paid ad came down at sale before then, while a copied or free version of it was still live,
// was labelled by that copy: in the W46 run all 31 "copied" homes that were also in our
// cohorts had had a paid Hemnet ad when listed (free 25/56, not seen live 34/36). So a home
// the registry does not show as paid is checked against two older sources, under the same
// rule (paid if any of its ads was paid while listed):
//   - cohort_pairs: its Hemnet twin when Booli listed it, paid by package or by date (listed
//     before the free tier, when every Hemnet ad was paid): listing-segment segmentOf.
//   - hemnet_listingv2: our earlier crawls of the same ad ids: a paid package, or listed
//     before the free tier with no free/copied package.
// paidFrom on the result says which source made it paid: registry | earlier_crawl | cohort.
//
//   node lib/sold-ad-type.js --smoke

const { homeClassOf, segmentOf, FREE_TIER_LAUNCH } = require('./listing-segment');
const { muniMatches } = require('./ad-registry');
const { normAddr } = require('./sold-addr');

const DAY = 86400000;
const BEFORE_SALE_DAYS = 180;   // an ad seen live up to ~6 months before the sale…
const AFTER_SALE_DAYS = 30;     // …or first seen up to a month after (sale date lags)
const TYPES = ['paid', 'newbuild', 'free', 'aggregated', 'teaser', 'other', 'no_ad_found', 'not_known'];
const AREA_TOLERANCE = 0.10;    // one street address can be a whole block: the unit must agree

// The Hemnet ad id sold-match recorded for a matched row, or null.
function adIdOf(evidence) {
  const e = evidence || {};
  const card = e.matched_card || {};
  const id = card.listing_id != null && String(card.listing_id) !== '' ? card.listing_id : e.bridge_listing_id;
  return id != null && String(id) !== '' ? String(id) : null;
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const dayMs = (d) => (d == null ? null : (d instanceof Date ? d.getTime() : Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`)));

// Does a registry ad belong to this sold home by address, near the sale date? PURE.
function addressMatches(ad, sale) {
  if (!ad.street_address || !sale.street_address) return false;
  if (normAddr(ad.street_address) !== normAddr(sale.street_address)) return false;
  if (!muniMatches(ad.kommun, sale.municipality)) return false;
  const aArea = num(ad.living_area), sArea = num(sale.living_area);
  if (aArea != null && sArea != null && Math.abs(aArea - sArea) / sArea > AREA_TOLERANCE) return false;
  const aRooms = num(ad.rooms), sRooms = num(sale.rooms);
  if (aRooms != null && sRooms != null && Math.round(aRooms) !== Math.round(sRooms)) return false;
  const sold = dayMs(sale.sold_date);
  if (sold == null) return true;
  const first = dayMs(ad.first_seen), last = dayMs(ad.last_seen);
  return first <= sold + AFTER_SALE_DAYS * DAY && last >= sold - BEFORE_SALE_DAYS * DAY;
}

const PAID_PKG = new Set(['BASIC', 'PLUS', 'PREMIUM', 'MAX']);

// Did an older source show this home with a paid ad while it was listed? PURE.
//   earlier: { v2ById: Map(hemnet_id -> [{ active_package, listed, is_teaser }]),
//              pairsByAddr: Map(normAddr -> [{ municipality, hemnet_listed, active_package, living_area, rooms }]) }
// Returns 'earlier_crawl' | 'cohort' | null.
function earlierPaid(sale, ids, earlier) {
  for (const id of ids) {
    for (const r of earlier.v2ById.get(String(id)) || []) {
      if (PAID_PKG.has(r.active_package)) return 'earlier_crawl';
      if (!r.active_package && !r.is_teaser && r.listed && r.listed < FREE_TIER_LAUNCH) return 'earlier_crawl';
    }
  }
  const sold = dayMs(sale.sold_date);
  const sArea = num(sale.living_area), sRooms = num(sale.rooms);
  for (const p of earlier.pairsByAddr.get(normAddr(sale.street_address || '')) || []) {
    if (!sale.municipality || !p.municipality || p.municipality.toLowerCase() !== sale.municipality.toLowerCase()) continue;
    if (typeof p.active_package === 'string' && p.active_package.startsWith('NC_')) continue;   // new-build, not second-hand paid
    if (segmentOf(p.active_package, p.hemnet_listed) !== 'paid') continue;
    const listed = dayMs(p.hemnet_listed);
    if (sold != null && listed != null && (listed > sold + AFTER_SALE_DAYS * DAY || listed < sold - BEFORE_SALE_DAYS * DAY)) continue;
    const pArea = num(p.living_area), pRooms = num(p.rooms);
    if (pArea != null && sArea != null && Math.abs(pArea - sArea) / sArea > AREA_TOLERANCE) continue;
    if (pRooms != null && sRooms != null && Math.round(pRooms) !== Math.round(sRooms)) continue;
    return 'cohort';
  }
  return null;
}

// One matched sale -> { type, adId, ads: [hemnet_id], paidFrom }. PURE.
//   sale: { evidence, street_address, municipality, sold_date }
//   byId: Map(hemnet_id -> ad)   byAddr: Map(normAddr -> [ad])   earlier: see earlierPaid (optional)
function classifySale(sale, byId, byAddr, earlier = null) {
  const adId = adIdOf(sale.evidence);
  const ads = new Map();
  if (adId && byId.has(adId)) ads.set(adId, byId.get(adId));
  for (const ad of byAddr.get(normAddr(sale.street_address || '')) || []) {
    if (addressMatches(ad, sale)) ads.set(String(ad.hemnet_id), ad);
  }
  let type;
  if (ads.size === 0) type = adId ? 'not_known' : 'no_ad_found';
  else {
    const t = homeClassOf([...ads.values()].flatMap(a => a.packages_seen || []));
    type = t === 'unknown' ? 'not_known' : t;
  }
  const base = { type, adId, ads: [...ads.keys()], paidFrom: type === 'paid' ? 'registry' : null };
  if (type === 'paid' || type === 'newbuild' || !earlier) return base;
  const from = earlierPaid(sale, [adId, ...ads.keys()].filter(Boolean), earlier);
  return from ? { ...base, type: 'paid', paidFrom: from } : base;
}

function emptyCounts() {
  const o = { matched: 0, paid_earlier: 0 };
  for (const t of TYPES) o[t] = 0;
  return o;
}

// Load every registry ad the given matched sales could point at. Two indexed lookups.
async function loadAds(client, sales) {
  const ids = [...new Set(sales.map(s => adIdOf(s.evidence)).filter(Boolean))];
  const addrs = [...new Set(sales.map(s => (s.street_address || '').toLowerCase()).filter(Boolean))];
  const cols = `hemnet_id::text AS hemnet_id, street_address, kommun, packages_seen, living_area, rooms,
                to_char(first_seen, 'YYYY-MM-DD') AS first_seen, to_char(last_seen, 'YYYY-MM-DD') AS last_seen`;
  const rows = [];
  if (ids.length) rows.push(...(await client.query(`SELECT ${cols} FROM hemnet_ad_registry WHERE hemnet_id = ANY($1::bigint[])`, [ids])).rows);
  if (addrs.length) rows.push(...(await client.query(`SELECT ${cols} FROM hemnet_ad_registry WHERE lower(street_address) = ANY($1::text[])`, [addrs])).rows);
  const byId = new Map(), byAddr = new Map();
  for (const ad of rows) {
    byId.set(String(ad.hemnet_id), ad);
    const k = normAddr(ad.street_address || '');
    if (!byAddr.has(k)) byAddr.set(k, []);
    if (!byAddr.get(k).some(a => String(a.hemnet_id) === String(ad.hemnet_id))) byAddr.get(k).push(ad);
  }
  return { byId, byAddr };
}

// The older evidence for these sales: earlier crawls of every ad id they could point at, and
// cohort pairs at their addresses. Two lookups.
async function loadEarlier(client, sales, byId) {
  const { latestPackageJoin } = require('./listing-segment');
  const ids = [...new Set([...sales.map(s => adIdOf(s.evidence)).filter(Boolean), ...byId.keys()])];
  const addrs = [...new Set(sales.map(s => (s.street_address || '').toLowerCase()).filter(Boolean))];
  const v2ById = new Map(), pairsByAddr = new Map();
  if (ids.length) {
    const r = await client.query(
      `SELECT hemnet_id::text AS id, active_package, to_char(listed, 'YYYY-MM-DD') AS listed, is_teaser
         FROM hemnet_listingv2 WHERE hemnet_id::text = ANY($1::text[])`, [ids]);
    for (const x of r.rows) { if (!v2ById.has(x.id)) v2ById.set(x.id, []); v2ById.get(x.id).push(x); }
  }
  if (addrs.length) {
    const r = await client.query(
      `SELECT cp.street_address, cp.municipality, to_char(cp.hemnet_listed, 'YYYY-MM-DD') AS hemnet_listed,
              pkg.active_package, bl.living_area, bl.rooms
         FROM cohort_pairs cp ${latestPackageJoin('cp')}
         LEFT JOIN LATERAL (SELECT living_area, rooms FROM booli_listing b WHERE b.booli_id = cp.booli_id
                             ORDER BY b.crawled DESC LIMIT 1) bl ON true
        WHERE cp.removed_at IS NULL AND lower(cp.street_address) = ANY($1::text[])`, [addrs]);
    for (const x of r.rows) {
      const k = normAddr(x.street_address || '');
      if (!pairsByAddr.has(k)) pairsByAddr.set(k, []);
      pairsByAddr.get(k).push(x);
    }
  }
  return { v2ById, pairsByAddr };
}

// Matched sales for the given window_end dates (YYYY-MM-DD), each with its ad type.
async function classifyWindows(client, windowEnds) {
  if (!windowEnds.length) return [];
  const res = await client.query(
    `SELECT sm.booli_id, sm.evidence, to_char(sm.window_end, 'YYYY-MM-DD') AS window_end,
            bs.street_address, bs.municipality, bs.living_area, bs.rooms,
            to_char(bs.sold_date, 'YYYY-MM-DD') AS sold_date
       FROM sold_match sm
       LEFT JOIN booli_sold bs ON bs.booli_id = sm.booli_id
      WHERE sm.verdict = 'matched' AND sm.window_end = ANY($1::date[])`, [windowEnds]);
  const { byId, byAddr } = await loadAds(client, res.rows);
  const earlier = await loadEarlier(client, res.rows, byId);
  return res.rows.map(s => ({ ...s, ...classifySale(s, byId, byAddr, earlier) }));
}

// Count classified sales per key (e.g. ISO week of window_end). PURE.
function countByKey(classified, keyOf) {
  const out = {};
  for (const s of classified) {
    const k = keyOf(s);
    if (!out[k]) out[k] = emptyCounts();
    out[k].matched++;
    out[k][s.type]++;
    if (s.type === 'paid' && s.paidFrom && s.paidFrom !== 'registry') out[k].paid_earlier++;
  }
  return out;
}

module.exports = { TYPES, adIdOf, addressMatches, earlierPaid, classifySale, loadAds, loadEarlier, classifyWindows, countByKey, emptyCounts };

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  const ad = (id, addr, kommun, pkgs, first = '2026-11-04', last = '2026-11-20') =>
    ({ hemnet_id: id, street_address: addr, kommun, packages_seen: pkgs, first_seen: first, last_seen: last });
  const index = (ads) => {
    const byId = new Map(ads.map(a => [String(a.hemnet_id), a]));
    const byAddr = new Map();
    for (const a of ads) { const k = normAddr(a.street_address); if (!byAddr.has(k)) byAddr.set(k, []); byAddr.get(k).push(a); }
    return [byId, byAddr];
  };
  const sale = (evidence, addr = 'Gävlegatan 32', muni = 'Stockholm', sold = '2026-11-25') =>
    ({ evidence, street_address: addr, municipality: muni, sold_date: sold });

  check('adIdOf reads the sold card id, then the bridge id, ignoring empty strings', () => {
    assert.strictEqual(adIdOf({ matched_card: { listing_id: '22056917' } }), '22056917');
    assert.strictEqual(adIdOf({ matched_card: { listing_id: '' }, bridge_listing_id: '21643904' }), '21643904');
    assert.strictEqual(adIdOf({ matched_card: { listing_id: '' } }), null);
    assert.strictEqual(adIdOf(null), null);
  });
  check('by id: an aggregated ad later upgraded to Plus is paid', () => {
    const [byId, byAddr] = index([ad('1', 'Gävlegatan 32', 'Stockholms', ['AGGREGATED', 'PLUS'])]);
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '1' } }), byId, byAddr).type, 'paid');
  });
  check('by id: only ever aggregated', () => {
    const [byId, byAddr] = index([ad('1', 'Annan väg 1', 'Stockholms', ['AGGREGATED'])]);
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '1' } }), byId, byAddr).type, 'aggregated');
  });
  check('by address: a relisted home under a new id counts if any of its ads was paid', () => {
    const [byId, byAddr] = index([ad('1', 'Gävlegatan 32', 'Stockholms', ['AGGREGATED']), ad('2', 'Gävlegatan 32', 'Stockholms', ['BASIC'])]);
    const r = classifySale(sale({ matched_card: { listing_id: '1' } }), byId, byAddr);
    assert.strictEqual(r.type, 'paid');
    assert.deepStrictEqual(r.ads.sort(), ['1', '2']);
  });
  check('by address: wrong kommun or an ad from long before the sale does not count', () => {
    const [byId, byAddr] = index([ad('1', 'Gävlegatan 32', 'Solna', ['PLUS']), ad('2', 'Gävlegatan 32', 'Stockholms', ['PLUS'], '2025-01-01', '2025-02-01')]);
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '' } }), byId, byAddr).type, 'no_ad_found');
  });
  check('by address: another flat in the same block (different size or rooms) does not count', () => {
    const big = { ...ad('1', 'Gävlegatan 32', 'Stockholms', ['PLUS']), living_area: 95, rooms: 4 };
    const [byId, byAddr] = index([big]);
    const s = { ...sale({ matched_card: { listing_id: '' } }), living_area: 54, rooms: 2 };
    assert.strictEqual(classifySale(s, byId, byAddr).type, 'no_ad_found');
    const same = { ...sale({ matched_card: { listing_id: '' } }), living_area: 96, rooms: 4 };
    assert.strictEqual(classifySale(same, byId, byAddr).type, 'paid');
  });
  check('no id on the sold card and nothing at the address: a sale record with no Hemnet ad', () => {
    const [byId, byAddr] = index([]);
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '' } }), byId, byAddr).type, 'no_ad_found');
  });
  check('an id the registry never saw live: not known', () => {
    const [byId, byAddr] = index([]);
    assert.strictEqual(classifySale(sale({ bridge_listing_id: '21643904' }), byId, byAddr).type, 'not_known');
  });
  check('free and new-build', () => {
    const [byId, byAddr] = index([ad('1', 'A 1', 'Stockholms', ['MINIMAL']), ad('2', 'B 2', 'Stockholms', ['NC_PREMIUM_PROJECT'])]);
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '1' } }, 'A 1'), byId, byAddr).type, 'free');
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '2' } }, 'B 2'), byId, byAddr).type, 'newbuild');
  });
  // --- earlier evidence (2026-11-10) ---
  const E = (v2 = {}, pairs = []) => {
    const pairsByAddr = new Map();
    for (const p of pairs) { const k = normAddr(p.street_address); if (!pairsByAddr.has(k)) pairsByAddr.set(k, []); pairsByAddr.get(k).push(p); }
    return { v2ById: new Map(Object.entries(v2)), pairsByAddr };
  };
  const pair = (o) => ({ street_address: 'Gävlegatan 32', municipality: 'Stockholm', hemnet_listed: '2026-10-10', active_package: null, ...o });
  check('earlier: a copied ad whose home had a paid cohort twin is paid (paidFrom cohort)', () => {
    const [byId, byAddr] = index([ad('9', 'Gävlegatan 32', 'Stockholms', ['AGGREGATED'])]);
    const r = classifySale(sale({ matched_card: { listing_id: '9' } }, 'Gävlegatan 32', 'Stockholm', '2026-11-05'), byId, byAddr, E({}, [pair({})]));
    assert.strictEqual(r.type, 'paid');
    assert.strictEqual(r.paidFrom, 'cohort');
  });
  check('earlier: a cohort twin listed after the free tier with no package does not count; a free one never does', () => {
    const [byId, byAddr] = index([ad('9', 'Gävlegatan 32', 'Stockholms', ['AGGREGATED'])]);
    const s = sale({ matched_card: { listing_id: '9' } }, 'Gävlegatan 32', 'Stockholm', '2026-11-05');
    assert.strictEqual(classifySale(s, byId, byAddr, E({}, [pair({ hemnet_listed: '2026-10-25' })])).type, 'aggregated');
    assert.strictEqual(classifySale(s, byId, byAddr, E({}, [pair({ active_package: 'MINIMAL' })])).type, 'aggregated');
  });
  check('earlier: a cohort twin in another kommun, too long before the sale, or another flat does not count', () => {
    const [byId, byAddr] = index([]);
    const s = { ...sale({ matched_card: { listing_id: '' } }, 'Gävlegatan 32', 'Stockholm', '2026-11-05'), living_area: 54, rooms: 2 };
    assert.strictEqual(classifySale(s, byId, byAddr, E({}, [pair({ municipality: 'Solna' })])).type, 'no_ad_found');
    assert.strictEqual(classifySale(s, byId, byAddr, E({}, [pair({ hemnet_listed: '2025-12-01' })])).type, 'no_ad_found');
    assert.strictEqual(classifySale(s, byId, byAddr, E({}, [pair({ living_area: 95, rooms: 4 })])).type, 'no_ad_found');
    assert.strictEqual(classifySale(s, byId, byAddr, E({}, [pair({ living_area: '55', rooms: 2 })])).type, 'paid');
  });
  check('earlier: an ad the registry never saw, crawled earlier as Premium or listed before the free tier, is paid', () => {
    const [byId, byAddr] = index([]);
    const s = sale({ bridge_listing_id: '777' });
    assert.strictEqual(classifySale(s, byId, byAddr, E({ 777: [{ active_package: 'PREMIUM', listed: '2026-10-25' }] })).paidFrom, 'earlier_crawl');
    assert.strictEqual(classifySale(s, byId, byAddr, E({ 777: [{ active_package: null, listed: '2026-10-01', is_teaser: false }] })).type, 'paid');
    assert.strictEqual(classifySale(s, byId, byAddr, E({ 777: [{ active_package: null, listed: '2026-10-01', is_teaser: true }] })).type, 'not_known', 'a teaser is not a paid ad');
    assert.strictEqual(classifySale(s, byId, byAddr, E({ 777: [{ active_package: 'AGGREGATED', listed: '2026-10-01' }] })).type, 'not_known', 'a copy keeps the agent\'s old date');
  });
  check('earlier: registry-paid stays registry; without earlier evidence nothing changes', () => {
    const [byId, byAddr] = index([ad('1', 'Gävlegatan 32', 'Stockholms', ['PLUS'])]);
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '1' } }), byId, byAddr, E()).paidFrom, 'registry');
    const [b2, a2] = index([ad('9', 'Gävlegatan 32', 'Stockholms', ['AGGREGATED'])]);
    assert.strictEqual(classifySale(sale({ matched_card: { listing_id: '9' } }), b2, a2).type, 'aggregated');
  });
  check('countByKey counts paid found only in earlier data', () => {
    const c = countByKey([{ type: 'paid', paidFrom: 'cohort', k: 'a' }, { type: 'paid', paidFrom: 'registry', k: 'a' }], s => s.k);
    assert.strictEqual(c.a.paid, 2);
    assert.strictEqual(c.a.paid_earlier, 1);
  });
  check('countByKey tallies every type', () => {
    const c = countByKey([{ type: 'paid', k: 'a' }, { type: 'no_ad_found', k: 'a' }, { type: 'paid', k: 'b' }], s => s.k);
    assert.strictEqual(c.a.matched, 2);
    assert.strictEqual(c.a.paid, 1);
    assert.strictEqual(c.a.no_ad_found, 1);
    assert.strictEqual(c.b.paid, 1);
  });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}
