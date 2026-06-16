'use strict';

// spike-sold-parse.js — parsers for the SOLD Apollo shapes discovered in Stage 0
// recon: Booli `SoldProperty` (from /slutpriser searchSold) and Hemnet `SaleCard`
// (from /salda searchSales). Pure functions over an Apollo state object.

const { isTitleTransfer } = require('./spike-config');

// Parse a Swedish-formatted number out of a label. Handles space/thin-space/nbsp
// thousands separators and comma decimals. Returns the FIRST number found, or null.
//   "3 600 000 kr" -> 3600000 ; "42,5 m²" -> 42.5 ; "150 + 20 m²" -> 150
function parseSweNum(s) {
  if (s == null) return null;
  const str = String(s);
  const m = str.match(/\d[\d\s  .]*(?:,\d+)?/);
  if (!m) return null;
  const cleaned = m[0].replace(/[\s  .]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// --- Booli -------------------------------------------------------

function booliDisplayDataPoints(card) {
  const key = Object.keys(card).find((k) => k.startsWith('displayAttributes('));
  const da = key ? card[key] : null;
  const pts = (da && Array.isArray(da.dataPoints)) ? da.dataPoints : [];
  return pts.map((p) => (p && p.value && p.value.plainText) || '').filter(Boolean);
}

function pickPoint(points, re, reject) {
  for (const p of points) {
    if (re.test(p) && !(reject && reject.test(p))) return p;
  }
  return null;
}

// Resolve the searchSold result node + its ordered card refs.
function booliSoldNode(apollo) {
  const rq = (apollo && apollo.ROOT_QUERY) || {};
  const k = Object.keys(rq).find((k) => k.startsWith('searchSold(') && rq[k] && Array.isArray(rq[k].result));
  return k ? rq[k] : null;
}

function booliSoldMeta(apollo) {
  const n = booliSoldNode(apollo);
  return { totalCount: n ? n.totalCount : null, pages: n ? n.pages : null };
}

function parseBooliSoldCards(apollo) {
  const node = booliSoldNode(apollo);
  if (!node) return [];
  const out = [];
  for (const ref of node.result) {
    const card = ref && ref.__ref ? apollo[ref.__ref] : null;
    if (!card || card.__typename !== 'SoldProperty') continue;
    const points = booliDisplayDataPoints(card);
    const livingPt = pickPoint(points, /m²/, /(tomt|kr)/);
    const roomsPt = pickPoint(points, /rum/);
    const floorPt = pickPoint(points, /vån/);
    const muni = card.location && card.location.region && card.location.region.municipalityName;
    out.push({
      booli_id: card.booliId || card.id,
      residence_url: card.url || null, // "/bostad/<residenceId>"
      street_address: card.streetAddress || null,
      object_type: card.objectType || null,
      sold_price: card.soldPrice && card.soldPrice.raw != null ? card.soldPrice.raw : null,
      sold_date: card.soldDate || null,
      sold_price_type: card.soldPriceType || null,
      is_title_transfer: isTitleTransfer(card.soldPriceType),
      municipality: muni || null,
      descriptive_area: card.descriptiveAreaName || null,
      living_area: livingPt ? parseSweNum(livingPt) : null,
      rooms: roomsPt ? parseSweNum(roomsPt) : null,
      floor: floorPt ? parseSweNum(floorPt) : null,
      lat: card.latitude != null ? card.latitude : null,
      long: card.longitude != null ? card.longitude : null,
    });
  }
  return out;
}

// --- Hemnet ------------------------------------------------------

function hemnetSalesNode(apollo) {
  const rq = (apollo && apollo.ROOT_QUERY) || {};
  const k = Object.keys(rq).find((k) => k.startsWith('searchSales(') && rq[k] && Array.isArray(rq[k].cards));
  return k ? rq[k] : null;
}

function hemnetSalesMeta(apollo) {
  const n = hemnetSalesNode(apollo);
  return { total: n ? n.total : null };
}

function parseHemnetSaleCards(apollo) {
  const node = hemnetSalesNode(apollo);
  if (!node) return [];
  const out = [];
  for (const ref of node.cards) {
    const c = ref && ref.__ref ? apollo[ref.__ref] : null;
    if (!c || c.__typename !== 'SaleCard') continue;
    const soldAt = c.soldAt != null ? Math.floor(parseFloat(c.soldAt)) : null;
    out.push({
      card_id: c.id || null,
      listing_id: c.listingId || null,
      slug: c.slug || null,
      detail_url: c.slug ? `https://www.hemnet.se/salda/${c.slug}` : null,
      street_address: c.streetAddress || null,
      sold_at: Number.isFinite(soldAt) ? soldAt : null,
      sold_at_label: c.soldAtLabel || null,
      asking_price: parseSweNum(c.askingPrice),
      final_price: parseSweNum(c.finalPrice),
      living_area: parseSweNum(c.livingArea),
      rooms: parseSweNum(c.rooms),
      fee: parseSweNum(c.fee),
      housing_form: (c.housingForm && (c.housingForm.name || c.housingForm.symbol)) || null,
      location_description: c.locationDescription || null,
      broker_name: c.brokerName || null,
      broker_agency: c.brokerAgencyName || null,
      lat: c.coordinates && c.coordinates.lat != null ? c.coordinates.lat : null,
      long: c.coordinates && c.coordinates.long != null ? c.coordinates.long : null,
    });
  }
  return out;
}

module.exports = {
  parseSweNum,
  parseBooliSoldCards,
  booliSoldMeta,
  parseHemnetSaleCards,
  hemnetSalesMeta,
};
