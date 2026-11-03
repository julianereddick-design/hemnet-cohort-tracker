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
//   node lib/sold-ad-type.js --smoke

const { homeClassOf } = require('./listing-segment');
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

// One matched sale -> { type, adId, ads: [hemnet_id] }. PURE.
//   sale: { evidence, street_address, municipality, sold_date }
//   byId: Map(hemnet_id -> ad)   byAddr: Map(normAddr -> [ad])
function classifySale(sale, byId, byAddr) {
  const adId = adIdOf(sale.evidence);
  const ads = new Map();
  if (adId && byId.has(adId)) ads.set(adId, byId.get(adId));
  for (const ad of byAddr.get(normAddr(sale.street_address || '')) || []) {
    if (addressMatches(ad, sale)) ads.set(String(ad.hemnet_id), ad);
  }
  if (ads.size === 0) return { type: adId ? 'not_known' : 'no_ad_found', adId, ads: [] };
  const packages = [...ads.values()].flatMap(a => a.packages_seen || []);
  const type = homeClassOf(packages);
  return { type: type === 'unknown' ? 'not_known' : type, adId, ads: [...ads.keys()] };
}

function emptyCounts() {
  const o = { matched: 0 };
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
  return res.rows.map(s => ({ ...s, ...classifySale(s, byId, byAddr) }));
}

// Count classified sales per key (e.g. ISO week of window_end). PURE.
function countByKey(classified, keyOf) {
  const out = {};
  for (const s of classified) {
    const k = keyOf(s);
    if (!out[k]) out[k] = emptyCounts();
    out[k].matched++;
    out[k][s.type]++;
  }
  return out;
}

module.exports = { TYPES, adIdOf, addressMatches, classifySale, loadAds, classifyWindows, countByKey, emptyCounts };

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
