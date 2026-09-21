'use strict';

// sold-parse.js — parsers for the SOLD Apollo shapes discovered in Stage 0
// recon: Booli `SoldProperty` (from /slutpriser searchSold) and Hemnet `SaleCard`
// (from /salda searchSales). Pure functions over an Apollo state object.
//
// Lifted from scripts/spike-sold-parse.js (Phase 15-01).
// Only dependency change: require('./spike-config') → require('./sold-config').

const { isTitleTransfer } = require('./sold-config');

// Parse a Swedish-formatted number out of a label. Handles space/thin-space/nbsp
// thousands separators and comma decimals. Returns the FIRST number found, or null.
//   "3 600 000 kr" -> 3600000 ; "42,5 m²" -> 42.5 ; "150 + 20 m²" -> 150
function parseSweNum(s) {
  if (s == null) return null;
  const str = String(s);
  const m = str.match(/\d[\d\s  .]*(?:,\d+)?/);
  if (!m) return null;
  const cleaned = m[0].replace(/[\s  .]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// --- Booli -------------------------------------------------------

function booliDisplayDataPoints(card) {
  // V1 keyed this with serialized args (`displayAttributes(...)`); searchSoldV2
  // uses a bare `displayAttributes`. Accept both.
  const key = Object.keys(card).find((k) => k === 'displayAttributes' || k.startsWith('displayAttributes('));
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

// Resolve the sold result node + its ordered card refs.
//
// Booli migrated this on 2026-09-13/14, exactly as it did the for-sale search:
//   searchSold(...).result        of `SoldProperty:<id>`
//     becomes
//   searchSoldV2(...).items({"queryContext":"SERP"})  of
//   `ListableProperty:{"originId":"sold:<origin>:<booliId>",...}`
// `totalCount` was untouched. Returns { node, refs, shape } or null.
function booliSoldNode(apollo) {
  const rq = (apollo && apollo.ROOT_QUERY) || {};
  for (const k of Object.keys(rq)) {
    // Prefix-match: 'searchSold' still prefixes 'searchSoldV2'.
    if (!k.startsWith('searchSold')) continue;
    const v = rq[k];
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v.result)) return { key: k, node: v, refs: v.result, shape: 'v1' };
    const itemsField = Object.keys(v).find((f) => f === 'items' || f.startsWith('items('));
    if (itemsField && Array.isArray(v[itemsField])) {
      return { key: k, node: v, refs: v[itemsField], shape: 'v2' };
    }
  }
  return null;
}

function booliSoldMeta(apollo) {
  const found = booliSoldNode(apollo);
  const n = found ? found.node : null;
  // V2 dropped `pages`; callers already treat it as nullable.
  return { totalCount: n ? n.totalCount : null, pages: (n && n.pages != null) ? n.pages : null };
}

// Map a searchSoldV2 card onto the V1 row shape.
//
// The sold TYPE survives intact and needs no inference: primaryStatus.label
// carries the very string V1 stored in sold_price_type. Measured 2026-09-21
// over four live pages (n=140 sold cards):
//   originId sold:bobot   -> key soldViabobot   label "Slutpris"   x109
//   originId sold:maklare -> key soldViamaklare label "Slutpris"   x22
//   originId sold:bid     -> key soldViabid     label "Sista bud"  x9
// which reproduces the stored distribution (V1 Slutpris 91.0% / Sista bud 8.7%;
// V2 93.6% / 6.4%). 'Lagfart' is 0.3% of stored rows so it did not appear in the
// sample, but it needs no special handling — the label passes straight into
// isTitleTransfer() exactly as before.
//
// If the label is MISSING we must not fall back to null: isTitleTransfer(null)
// returns false, i.e. "treat as a market sale and keep it", which would quietly
// admit an unclassifiable row into a Slutpris-only pipeline. Emit
// 'Okand:<origin>' instead — isTitleTransfer excludes it, and because
// sold_price_type is a stored column the unknown origin shows up in any
// distribution query rather than hiding.
function booliSoldCardV2(card, apollo) {
  const tp = (card.tracking && card.tracking.properties) || {};
  const originId = typeof card.originId === 'string' ? card.originId : '';
  const origin = originId.split(':')[1] || 'unknown';

  const label = card.primaryStatus && typeof card.primaryStatus.label === 'string'
    ? card.primaryStatus.label.trim() : '';
  const soldPriceType = label || `Okand:${origin}`;

  // listingId is null on sold cards — the id lives in tracking, with the
  // originId's numeric tail as a backstop.
  let booliId = tp.booli_id != null ? tp.booli_id : null;
  if (booliId == null) {
    const tail = originId.split(':')[2];
    if (tail && /^\d+$/.test(tail)) booliId = Number(tail);
  }

  const points = booliDisplayDataPoints(card);
  const livingPt = pickPoint(points, /m²/, /(tomt|kr)/);
  const roomsPt = pickPoint(points, /rum/);
  const floorPt = pickPoint(points, /vån/);

  // subtitle is "<objectType> · <area> · <municipality>" e.g.
  // "Lägenhet · Södermalm · Stockholm". tracking carries municipality directly;
  // the middle segment is the descriptive area V1 read from descriptiveAreaName.
  const parts = typeof card.subtitle === 'string'
    ? card.subtitle.split('·').map((x) => x.trim()).filter(Boolean) : [];

  const pos = card.position || {};

  return {
    booli_id: booliId,
    residence_url: card.url || null,       // "/bostad/<residenceId>", as before
    street_address: card.title || null,
    object_type: card.objectType || null,
    sold_price: parseSweNum(card.displayPrice),
    sold_date: card.displayDate || null,   // V2 serves this as an ISO date
    sold_price_type: soldPriceType,
    is_title_transfer: isTitleTransfer(soldPriceType),
    municipality: tp.municipality || (parts.length >= 3 ? parts[2] : null),
    descriptive_area: parts.length >= 3 ? parts[1] : null,
    living_area: livingPt ? parseSweNum(livingPt) : null,
    rooms: roomsPt ? parseSweNum(roomsPt) : null,
    floor: floorPt ? parseSweNum(floorPt) : null,
    lat: pos.latitude != null ? pos.latitude : null,
    long: pos.longitude != null ? pos.longitude : null,
  };
}

function parseBooliSoldCards(apollo) {
  const found = booliSoldNode(apollo);
  if (!found) return [];
  const { refs, shape } = found;
  const out = [];
  for (const ref of refs) {
    const card = ref && ref.__ref ? apollo[ref.__ref] : null;
    if (!card) continue;

    if (shape === 'v2') {
      if (card.__typename !== 'ListableProperty') continue;
      // Only sold rows: the same node family also backs for-sale and project tiles.
      if (typeof card.originId !== 'string' || !card.originId.startsWith('sold:')) continue;
      out.push(booliSoldCardV2(card, apollo));
      continue;
    }

    if (card.__typename !== 'SoldProperty') continue;
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
  // A non-empty ref array that maps to zero cards means the shape moved under us
  // again. Returning [] is precisely what let the 2026-09-13 migration run
  // unnoticed: sold-match-batch sampled nothing, wrote no rows of any verdict,
  // and still spent ~4,387 Oxylabs calls on the re-check drain. Fail loudly.
  // An EMPTY refs array is the legitimate end of results and stays quiet.
  if (refs.length > 0 && out.length === 0) {
    throw new Error(
      `sold-parse: sold node '${found.key.slice(0, 60)}' held ${refs.length} refs but mapped ` +
      '0 cards — Booli sold shape drift; parseBooliSoldCards needs updating',
    );
  }
  return out;
}

// Parse a Booli SOLD detail page (/bostad/<residenceId>) SoldProperty node.
// Used for the apartment fee-match escalation (rent) and broker (agentId/agencyId
// for the Booli-only bypass classification). NOTE: sold detail pages serve NO
// gallery images (images:[]), so dHash photo-matching is not available for sold.
function parseBooliSoldDetail(apollo) {
  const sp = Object.values(apollo || {}).find((v) => v && v.__typename === 'SoldProperty');
  if (!sp) return null;
  const raw = (x) => (x && x.raw != null ? x.raw : null);
  return {
    booli_id: sp.booliId || sp.id || null,
    residence_id: sp.residenceId || null,
    rent: raw(sp.rent),                       // monthly fee (apartments)
    operating_cost: raw(sp.operatingCost),
    living_area: raw(sp.livingArea),
    additional_area: raw(sp.additionalArea),
    plot_area: raw(sp.plotArea),
    rooms: raw(sp.rooms),
    construction_year: sp.constructionYear != null ? sp.constructionYear : null,
    agent_id: sp.agentId || null,
    agency_id: sp.agencyId || null,
    object_type: sp.objectType || null,
    sold_price: raw(sp.soldPrice),
    sold_price_type: sp.soldPriceType || null,
    tenure_form: sp.tenureForm || null,
    // D-04 finding: soldAsUpcomingSale is detail-page-only (not on /slutpriser cards).
    // Boolean cast: false means not sold in advance; null if field absent (older records).
    sold_in_advance: sp.soldAsUpcomingSale != null ? Boolean(sp.soldAsUpcomingSale) : null,
  };
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
  parseBooliSoldDetail,
  booliSoldMeta,
  parseHemnetSaleCards,
  hemnetSalesMeta,
};

// ---------------------------------------------------------------------------
// Inline smoke test — node lib/sold-parse.js --smoke
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- parseSweNum ---
  check('parseSweNum: Swedish thousands separator (space)', () => {
    assert.strictEqual(parseSweNum('3 600 000 kr'), 3600000);
  });
  check('parseSweNum: comma decimal', () => {
    assert.strictEqual(parseSweNum('42,5 m²'), 42.5);
  });
  check('parseSweNum: first number only', () => {
    assert.strictEqual(parseSweNum('150 + 20 m²'), 150);
  });
  check('parseSweNum: null returns null', () => {
    assert.strictEqual(parseSweNum(null), null);
  });
  check('parseSweNum: non-numeric returns null', () => {
    assert.strictEqual(parseSweNum('n/a'), null);
  });
  check('parseSweNum: empty string returns null', () => {
    assert.strictEqual(parseSweNum(''), null);
  });

  // --- parseBooliSoldCards: empty/missing cases ---
  check('parseBooliSoldCards: empty apollo {} returns []', () => {
    const r = parseBooliSoldCards({});
    assert.ok(Array.isArray(r));
    assert.strictEqual(r.length, 0);
  });
  check('parseBooliSoldCards: null apollo returns []', () => {
    const r = parseBooliSoldCards(null);
    assert.ok(Array.isArray(r));
    assert.strictEqual(r.length, 0);
  });
  check('parseBooliSoldCards: no ROOT_QUERY returns []', () => {
    const r = parseBooliSoldCards({ 'SoldProperty:1': { __typename: 'SoldProperty' } });
    assert.strictEqual(r.length, 0);
  });

  // --- parseBooliSoldCards: one-card apollo ---
  check('parseBooliSoldCards: one card extracts snake_case fields + is_title_transfer', () => {
    const apollo = {
      ROOT_QUERY: {
        'searchSold({"input":{"areaIds":1}})': {
          result: [{ __ref: 'SoldProperty:42' }],
          totalCount: 1,
          pages: 1,
        },
      },
      'SoldProperty:42': {
        __typename: 'SoldProperty',
        booliId: 42,
        url: '/bostad/999',
        streetAddress: 'Testgatan 1',
        objectType: 'Lägenhet',
        soldPrice: { raw: 3500000 },
        soldDate: '2026-01-15',
        soldPriceType: 'Slutpris',
        descriptiveAreaName: 'Östermalm',
        latitude: 59.33,
        longitude: 18.07,
        location: { region: { municipalityName: 'Stockholm' } },
        'displayAttributes({"input":{}})': {
          dataPoints: [
            { value: { plainText: '62 m²' } },
            { value: { plainText: '3 rum' } },
            { value: { plainText: '2 vån' } },
          ],
        },
      },
    };
    const cards = parseBooliSoldCards(apollo);
    assert.strictEqual(cards.length, 1);
    const c = cards[0];
    assert.strictEqual(c.booli_id, 42);
    assert.strictEqual(c.street_address, 'Testgatan 1');
    assert.strictEqual(c.object_type, 'Lägenhet');
    assert.strictEqual(c.sold_price, 3500000);
    assert.strictEqual(c.sold_date, '2026-01-15');
    assert.strictEqual(c.sold_price_type, 'Slutpris');
    assert.strictEqual(c.is_title_transfer, false);  // Slutpris = market sale
    assert.strictEqual(c.municipality, 'Stockholm');
    assert.strictEqual(c.descriptive_area, 'Östermalm');
    assert.strictEqual(c.living_area, 62);
    assert.strictEqual(c.rooms, 3);
    assert.strictEqual(c.floor, 2);
    assert.strictEqual(c.lat, 59.33);
    assert.strictEqual(c.long, 18.07);
    assert.strictEqual(c.residence_url, '/bostad/999');
  });
  check('parseBooliSoldCards: is_title_transfer=true for Lagfart', () => {
    const apollo = {
      ROOT_QUERY: {
        'searchSold({"input":{}})': {
          result: [{ __ref: 'SoldProperty:99' }],
        },
      },
      'SoldProperty:99': {
        __typename: 'SoldProperty',
        booliId: 99,
        soldPriceType: 'Lagfart',
      },
    };
    const cards = parseBooliSoldCards(apollo);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].is_title_transfer, true);
  });

  // --- parseBooliSoldDetail ---
  check('parseBooliSoldDetail: no SoldProperty → null', () => {
    assert.strictEqual(parseBooliSoldDetail({}), null);
    assert.strictEqual(parseBooliSoldDetail(null), null);
  });
  check('parseBooliSoldDetail: extracts enriched fields', () => {
    const apollo = {
      'SoldProperty:77': {
        __typename: 'SoldProperty',
        booliId: 77,
        residenceId: 1234,
        rent: { raw: 3200 },
        operatingCost: { raw: 500 },
        livingArea: { raw: 58 },
        additionalArea: { raw: null },
        plotArea: { raw: null },
        rooms: { raw: 2 },
        constructionYear: 1965,
        agentId: 42,
        agencyId: 10,
        objectType: 'Lägenhet',
        soldPrice: { raw: 2900000 },
        soldPriceType: 'Slutpris',
        tenureForm: 'bostadsratt',
      },
    };
    const d = parseBooliSoldDetail(apollo);
    assert.ok(d !== null);
    assert.strictEqual(d.booli_id, 77);
    assert.strictEqual(d.residence_id, 1234);
    assert.strictEqual(d.rent, 3200);
    assert.strictEqual(d.operating_cost, 500);
    assert.strictEqual(d.living_area, 58);
    assert.strictEqual(d.rooms, 2);
    assert.strictEqual(d.construction_year, 1965);
    assert.strictEqual(d.agent_id, 42);
    assert.strictEqual(d.agency_id, 10);
    assert.strictEqual(d.object_type, 'Lägenhet');
    assert.strictEqual(d.sold_price, 2900000);
    assert.strictEqual(d.sold_price_type, 'Slutpris');
    assert.strictEqual(d.tenure_form, 'bostadsratt');
  });

  // --- parseHemnetSaleCards ---
  check('parseHemnetSaleCards: empty apollo returns []', () => {
    assert.strictEqual(parseHemnetSaleCards({}).length, 0);
    assert.strictEqual(parseHemnetSaleCards(null).length, 0);
  });
  check('parseHemnetSaleCards: builds detail_url from slug', () => {
    const apollo = {
      ROOT_QUERY: {
        'searchSales({"input":{}})': {
          cards: [{ __ref: 'SaleCard:sc1' }],
          total: 1,
        },
      },
      'SaleCard:sc1': {
        __typename: 'SaleCard',
        id: 'sc1',
        listingId: 555,
        slug: 'lagenhet-testgatan-1-stockholm-12345678',
        streetAddress: 'Testgatan 1',
        soldAt: '1704067200',
        soldAtLabel: '2024-01-01',
        askingPrice: '3 500 000 kr',
        finalPrice: '3 650 000 kr',
        livingArea: '62 m²',
        rooms: '3 rum',
        fee: '3 200 kr/mån',
        housingForm: { name: 'Lägenhet', symbol: 'apartment' },
        locationDescription: 'Östermalm, Stockholm',
        brokerName: 'Anna Svensson',
        brokerAgencyName: 'Fastighetsbyrån',
        coordinates: { lat: 59.33, long: 18.07 },
      },
    };
    const cards = parseHemnetSaleCards(apollo);
    assert.strictEqual(cards.length, 1);
    const c = cards[0];
    assert.strictEqual(c.card_id, 'sc1');
    assert.strictEqual(c.listing_id, 555);
    assert.strictEqual(c.slug, 'lagenhet-testgatan-1-stockholm-12345678');
    assert.strictEqual(c.detail_url, 'https://www.hemnet.se/salda/lagenhet-testgatan-1-stockholm-12345678');
    assert.strictEqual(c.street_address, 'Testgatan 1');
    assert.strictEqual(c.sold_at, 1704067200);
    assert.strictEqual(c.asking_price, 3500000);
    assert.strictEqual(c.final_price, 3650000);
    assert.strictEqual(c.living_area, 62);
    assert.strictEqual(c.rooms, 3);
    assert.strictEqual(c.fee, 3200);
    assert.strictEqual(c.housing_form, 'Lägenhet');
    assert.strictEqual(c.location_description, 'Östermalm, Stockholm');
    assert.strictEqual(c.broker_name, 'Anna Svensson');
    assert.strictEqual(c.broker_agency, 'Fastighetsbyrån');
    assert.strictEqual(c.lat, 59.33);
    assert.strictEqual(c.long, 18.07);
  });
  check('parseHemnetSaleCards: null slug → detail_url null', () => {
    const apollo = {
      ROOT_QUERY: {
        'searchSales({"input":{}})': {
          cards: [{ __ref: 'SaleCard:sc2' }],
        },
      },
      'SaleCard:sc2': {
        __typename: 'SaleCard',
        id: 'sc2',
        slug: null,
      },
    };
    const cards = parseHemnetSaleCards(apollo);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].detail_url, null);
  });

  // --- booliSoldMeta / hemnetSalesMeta ---
  check('booliSoldMeta: returns totalCount/pages null when no node', () => {
    const m = booliSoldMeta({});
    assert.strictEqual(m.totalCount, null);
    assert.strictEqual(m.pages, null);
  });
  check('hemnetSalesMeta: returns total null when no node', () => {
    const m = hemnetSalesMeta({});
    assert.strictEqual(m.total, null);
  });


  // --- searchSoldV2 (Booli's 2026-09-13/14 migration) -----------------------
  // Fixture mirrors the live sold cards captured 2026-09-21.
  const S_ITEMS = 'items({"queryContext":"SERP"})';
  const soldCard = (booliId, origin, label, extra) => Object.assign({
    __typename: 'ListableProperty',
    originId: `sold:${origin}:${booliId}`,
    listingId: null,                       // always null on sold cards
    title: 'Tjustgatan 5',
    url: '/bostad/79872',
    objectType: 'Lagenhet',
    displayDate: '2026-09-20',             // V2 serves an ISO sold date
    displayPrice: '5 600 000 kr',
    subtitle: 'Lagenhet · Sodermalm · Stockholm',
    primaryStatus: label == null ? null : { __typename: 'TagWithIcon', key: `soldVia${origin}`, label },
    position: { latitude: 59.31193252, longitude: 18.07079616 },
    displayAttributes: { dataPoints: [
      { key: 'livingArea', value: { plainText: '48 m²' } },
      { key: 'rooms', value: { plainText: '2 rum' } },
      { key: 'floor', value: { plainText: 'vån 4' } },
    ] },
    tracking: { properties: { booli_id: booliId, municipality: 'Stockholm' } },
  }, extra || {});
  const soldState = (refs, ents) => Object.assign({
    ROOT_QUERY: { 'searchSoldV2({"input":{"areaIds":[2]}})': { totalCount: 2978983, [S_ITEMS]: refs } },
  }, ents);

  check('soldV2: items(...) node parses and every field maps', () => {
    const a = soldState([{ __ref: 'LP:1' }], { 'LP:1': soldCard(6275753, 'maklare', 'Slutpris') });
    const r = parseBooliSoldCards(a);
    assert.strictEqual(r.length, 1);
    const c = r[0];
    assert.strictEqual(c.booli_id, 6275753, 'id comes from tracking, listingId is null');
    assert.strictEqual(c.residence_url, '/bostad/79872');
    assert.strictEqual(c.street_address, 'Tjustgatan 5');
    assert.strictEqual(c.sold_price, 5600000, 'price parsed out of the formatted string');
    assert.strictEqual(c.sold_date, '2026-09-20');
    assert.strictEqual(c.sold_price_type, 'Slutpris');
    assert.strictEqual(c.is_title_transfer, false);
    assert.strictEqual(c.municipality, 'Stockholm');
    assert.strictEqual(c.descriptive_area, 'Sodermalm');
    assert.strictEqual(c.living_area, 48);
    assert.strictEqual(c.rooms, 2);
    assert.strictEqual(c.floor, 4);
    assert.strictEqual(c.lat, 59.31193252);
    assert.strictEqual(booliSoldMeta(a).totalCount, 2978983);
  });

  check('soldV2: primaryStatus.label carries the V1 sold_price_type verbatim', () => {
    const a = soldState(
      [{ __ref: 'LP:1' }, { __ref: 'LP:2' }, { __ref: 'LP:3' }],
      {
        'LP:1': soldCard(1, 'bobot', 'Slutpris'),
        'LP:2': soldCard(2, 'bid', 'Sista bud'),
        'LP:3': soldCard(3, 'lagfart', 'Lagfart'),
      });
    const r = parseBooliSoldCards(a);
    assert.deepStrictEqual(r.map(x => x.sold_price_type), ['Slutpris', 'Sista bud', 'Lagfart']);
    // The whole point of v3.1 Slutpris-only: a title transfer must be flagged.
    assert.deepStrictEqual(r.map(x => x.is_title_transfer), [false, false, true]);
  });

  // isTitleTransfer(null) === false, i.e. "keep as a market sale". An
  // unclassifiable row must NOT take that path into a Slutpris-only pipeline.
  check('soldV2: a missing label is excluded and named, never silently kept', () => {
    const a = soldState([{ __ref: 'LP:1' }], { 'LP:1': soldCard(9, 'somethingnew', null) });
    const c = parseBooliSoldCards(a)[0];
    assert.strictEqual(c.sold_price_type, 'Okand:somethingnew', 'the unknown origin must be named');
    assert.strictEqual(c.is_title_transfer, true, 'unclassifiable must be excluded, not kept');
  });

  check('soldV2: non-sold tiles sharing the node family are ignored', () => {
    const forSale = Object.assign(soldCard(5, 'maklare', 'Slutpris'), { originId: 'listing:5' });
    const a = soldState([{ __ref: 'LP:f' }, { __ref: 'LP:s' }],
      { 'LP:f': forSale, 'LP:s': soldCard(6, 'bid', 'Sista bud') });
    const r = parseBooliSoldCards(a);
    assert.strictEqual(r.length, 1, 'only sold: originIds are sold rows');
    assert.strictEqual(r[0].booli_id, 6);
  });

  // The failure that cost this series two batches and ~4,387 wasted calls.
  check('soldV2: refs present but nothing mappable throws, never returns []', () => {
    const a = { ROOT_QUERY: { 'searchSoldV9({"x":1})': { [S_ITEMS]: [{ __ref: 'X:1' }] } }, 'X:1': { __typename: 'Nope' } };
    assert.throws(() => parseBooliSoldCards(a), /shape drift/);
  });
  check('soldV2: a genuinely empty sold page stays quiet', () => {
    const a = { ROOT_QUERY: { 'searchSoldV2({"x":1})': { totalCount: 0, [S_ITEMS]: [] } } };
    assert.deepStrictEqual(parseBooliSoldCards(a), []);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
