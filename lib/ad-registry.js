'use strict';
// lib/ad-registry.js — the Hemnet ad registry: what every live Hemnet ad is (paid package,
// free, aggregated, new-build) and how that changes, recorded while the ad is live.
//
// Why: Hemnet's sold pages carry no package, and since Oct 2026 Hemnet also shows free
// (MINIMAL, 2026-10-20) and aggregated (copied from agency sites, ~2026-10-27) ads. Sold-match
// can only say whether a sold home was a PAID Hemnet ad if we saw the ad while it was live.
//
// Writers:  scripts/hemnet-ad-daily.js  — newest ads, every morning (catches new ads and
//                                          upgrades: buying a package resets publishedAt,
//                                          which puts the ad back at the top of the list)
//           scripts/hemnet-ad-sweep.js  — every live ad, weekly (the complete picture,
//                                          gone ads, the counts by tier and package)
// Reader:   lib/sold-ad-type.js (sold-match report and xlsx)
// Tables:   migrate-ad-registry.js
//
//   node lib/ad-registry.js --smoke     # offline self-test

const { adClassOf, PAID_PACKAGES } = require('./listing-segment');

const BATCH = 500;

// "Alingsås, Alingsås kommun" -> "Alingsås";  "Östermalm, Stockholms kommun" -> "Stockholms".
// Hemnet writes the kommun in the genitive, so muniMatches() allows one trailing "s".
function kommunOf(locationDescription) {
  if (typeof locationDescription !== 'string') return null;
  const parts = locationDescription.split(',').map(s => s.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : '';
  const m = last.match(/^(.*?)\s+kommun$/i);
  return m ? m[1] : null;
}

function normMuni(s) {
  return String(s || '').toLowerCase().replace(/\s+kommun$/, '').trim();
}
function muniMatches(kommun, muni) {
  const k = normMuni(kommun), m = normMuni(muni);
  if (!k || !m) return false;
  return k === m || k === `${m}s` || `${k}s` === m;
}

// "171 m²" -> 171; "62 + 10 m²" -> 62 (living area only); "2,5 rum" -> 2.5
function firstNumber(s) {
  if (typeof s !== 'string') return null;
  const m = s.replace(/ /g, ' ').match(/(\d+(?:[ ]\d{3})*(?:,\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/ /g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const tierOf = (card) => (card.upcoming ? 'premarket' : 'forsale');

// One parsed search card (lib/hemnet-fetch parseListingCards) -> registry row for today.
function shapeCard(card, seenOn) {
  const pkg = card.activePackage || null;
  const pub = Number.isFinite(card.publishedAt) ? new Date(card.publishedAt * 1000).toISOString() : null;
  return {
    hemnet_id: String(card.id),
    slug: card.slug || null,
    street_address: card.streetAddress || null,
    location: card.locationDescription || null,
    kommun: kommunOf(card.locationDescription),
    housing_form: card.housingForm || null,
    asking_price: Number.isFinite(card.askingPrice) ? Math.round(card.askingPrice) : null,
    living_area: firstNumber(card.livingArea),
    rooms: firstNumber(card.rooms),
    lat: Number.isFinite(card.lat) ? card.lat : null,
    long: Number.isFinite(card.long) ? card.long : null,
    broker_agency: card.brokerAgencyName || null,
    record_type: card.recordType || null,
    new_construction: card.newConstruction === true,
    project_id: card.projectId || null,
    package: pkg,
    ad_class: adClassOf(pkg),
    tier: tierOf(card),
    published_at: pub,
    packages_seen: pkg ? [pkg] : [],
    first_paid_seen: pkg && PAID_PACKAGES.has(pkg) ? seenOn : null,
    first_seen: seenOn,
    last_seen: seenOn,
  };
}

// Compare today's row with what the registry holds. PURE.
// Returns { history|null, isNew, changed, upgraded }. A history row is written the first
// time an ad is seen and whenever its package or tier changes. A card without a package
// (should not happen since Oct 2026) never counts as a change.
function diffRow(existing, row, source) {
  const hist = (prior) => ({
    hemnet_id: row.hemnet_id, seen_on: row.last_seen, source, package: row.package, tier: row.tier,
    prior_package: prior ? prior.package : null, prior_tier: prior ? prior.tier : null,
    published_at: row.published_at,
  });
  if (!existing) return { history: hist(null), isNew: true, changed: false, upgraded: false };
  const pkgChanged = row.package != null && row.package !== existing.package;
  const tierChanged = row.tier !== existing.tier;
  if (!pkgChanged && !tierChanged) return { history: null, isNew: false, changed: false, upgraded: false };
  const upgraded = pkgChanged && adClassOf(row.package) === 'paid' && adClassOf(existing.package) !== 'paid';
  return { history: hist(existing), isNew: false, changed: true, upgraded };
}

// Counts by tier x package over a set of rows (distinct ads). PURE.
function tierCounts(rows) {
  const out = { forsale: {}, premarket: {} };
  for (const r of rows) {
    const t = out[r.tier] || (out[r.tier] = {});
    const k = r.package || 'NONE';
    t[k] = (t[k] || 0) + 1;
  }
  return out;
}

const UPSERT_SQL = `
  INSERT INTO hemnet_ad_registry AS reg (
    hemnet_id, slug, street_address, location, kommun, housing_form, asking_price, living_area,
    rooms, lat, long, broker_agency, record_type, new_construction, project_id, package, ad_class,
    tier, published_at, packages_seen, first_paid_seen, first_seen, last_seen, gone_on, updated_at)
  SELECT x.hemnet_id, x.slug, x.street_address, x.location, x.kommun, x.housing_form, x.asking_price,
         x.living_area, x.rooms, x.lat, x.long, x.broker_agency, x.record_type, x.new_construction,
         x.project_id, x.package, x.ad_class, x.tier, x.published_at, x.packages_seen,
         x.first_paid_seen, x.first_seen, x.last_seen, NULL, NOW()
    FROM jsonb_to_recordset($1::jsonb) AS x(
      hemnet_id BIGINT, slug TEXT, street_address TEXT, location TEXT, kommun TEXT, housing_form TEXT,
      asking_price BIGINT, living_area NUMERIC, rooms NUMERIC, lat DOUBLE PRECISION,
      long DOUBLE PRECISION, broker_agency TEXT, record_type TEXT, new_construction BOOLEAN,
      project_id TEXT, package TEXT, ad_class TEXT, tier TEXT, published_at TIMESTAMPTZ,
      packages_seen TEXT[], first_paid_seen DATE, first_seen DATE, last_seen DATE)
  ON CONFLICT (hemnet_id) DO UPDATE SET
    slug = COALESCE(EXCLUDED.slug, reg.slug),
    street_address = COALESCE(EXCLUDED.street_address, reg.street_address),
    location = COALESCE(EXCLUDED.location, reg.location),
    kommun = COALESCE(EXCLUDED.kommun, reg.kommun),
    housing_form = COALESCE(EXCLUDED.housing_form, reg.housing_form),
    asking_price = EXCLUDED.asking_price,
    living_area = COALESCE(EXCLUDED.living_area, reg.living_area),
    rooms = COALESCE(EXCLUDED.rooms, reg.rooms),
    lat = COALESCE(EXCLUDED.lat, reg.lat),
    long = COALESCE(EXCLUDED.long, reg.long),
    broker_agency = COALESCE(EXCLUDED.broker_agency, reg.broker_agency),
    record_type = COALESCE(EXCLUDED.record_type, reg.record_type),
    new_construction = EXCLUDED.new_construction,
    project_id = COALESCE(EXCLUDED.project_id, reg.project_id),
    package = COALESCE(EXCLUDED.package, reg.package),
    ad_class = CASE WHEN EXCLUDED.package IS NULL THEN reg.ad_class ELSE EXCLUDED.ad_class END,
    tier = EXCLUDED.tier,
    published_at = COALESCE(EXCLUDED.published_at, reg.published_at),
    packages_seen = ARRAY(SELECT DISTINCT p FROM unnest(reg.packages_seen || EXCLUDED.packages_seen) AS p ORDER BY p),
    first_paid_seen = COALESCE(reg.first_paid_seen, EXCLUDED.first_paid_seen),
    first_seen = LEAST(reg.first_seen, EXCLUDED.first_seen),
    last_seen = GREATEST(reg.last_seen, EXCLUDED.last_seen),
    gone_on = NULL,
    updated_at = NOW()`;

const HISTORY_SQL = `
  INSERT INTO hemnet_ad_package_history
    (hemnet_id, seen_on, source, package, tier, prior_package, prior_tier, published_at)
  SELECT x.hemnet_id, x.seen_on, x.source, x.package, x.tier, x.prior_package, x.prior_tier, x.published_at
    FROM jsonb_to_recordset($1::jsonb) AS x(
      hemnet_id BIGINT, seen_on DATE, source TEXT, package TEXT, tier TEXT,
      prior_package TEXT, prior_tier TEXT, published_at TIMESTAMPTZ)`;

// Write a batch of parsed cards seen on `seenOn` ('YYYY-MM-DD'). Duplicate ids in the batch
// keep the last card. Each chunk is one transaction, so a chunk's history and registry rows
// land together. Returns { cards, distinct, newAds, changed, upgrades }.
async function applyCards(client, cards, { seenOn, source }) {
  const byId = new Map();
  for (const c of cards || []) if (c && c.id != null) byId.set(String(c.id), c);
  const rows = [...byId.values()].map(c => shapeCard(c, seenOn));
  const out = { cards: (cards || []).length, distinct: rows.length, newAds: 0, changed: 0, upgrades: 0 };
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const ex = await client.query(
      `SELECT hemnet_id::text AS hemnet_id, package, tier FROM hemnet_ad_registry WHERE hemnet_id = ANY($1::bigint[])`,
      [chunk.map(r => r.hemnet_id)]);
    const existing = new Map(ex.rows.map(r => [r.hemnet_id, r]));
    const history = [];
    for (const r of chunk) {
      const d = diffRow(existing.get(r.hemnet_id), r, source);
      if (d.history) history.push(d.history);
      if (d.isNew) out.newAds++;
      if (d.changed) out.changed++;
      if (d.upgraded) out.upgrades++;
    }
    await client.query('BEGIN');
    try {
      await client.query(UPSERT_SQL, [JSON.stringify(chunk)]);
      if (history.length) await client.query(HISTORY_SQL, [JSON.stringify(history)]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }
  return out;
}

// After a COMPLETE weekly sweep that started on `sweepDate`: every ad still marked live but
// not seen since before that date has come down (sold, withdrawn or expired). Only call this
// when the sweep passed its completeness gates, or a failed municipality would be marked gone.
async function markGone(client, { sweepDate }) {
  const r = await client.query(
    `UPDATE hemnet_ad_registry SET gone_on = $1::date, updated_at = NOW()
      WHERE gone_on IS NULL AND last_seen < $1::date`, [sweepDate]);
  return r.rowCount;
}

async function recordRun(client, run) {
  const r = await client.query(
    `INSERT INTO hemnet_ad_sweep_run
       (kind, run_date, status, cards_seen, distinct_ads, headline_total, new_ads, changed_ads,
        upgrades, gone_ads, pages, ox_calls, counts, notes, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [run.kind, run.runDate, run.status, run.cardsSeen || 0, run.distinct || 0,
      run.headlineTotal == null ? null : run.headlineTotal, run.newAds || 0, run.changed || 0,
      run.upgrades || 0, run.goneAds == null ? null : run.goneAds, run.pages || 0, run.oxCalls || 0,
      run.counts ? JSON.stringify(run.counts) : null, run.notes || null, run.startedAt]);
  return r.rows[0].id;
}

module.exports = {
  kommunOf, muniMatches, firstNumber, shapeCard, diffRow, tierCounts,
  applyCards, markGone, recordRun,
};

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  (async () => {
    await check('kommunOf reads the kommun from the location line', () => {
      assert.strictEqual(kommunOf('Alingsås, Alingsås kommun'), 'Alingsås');
      assert.strictEqual(kommunOf('Östermalm, Stockholms kommun'), 'Stockholms');
      assert.strictEqual(kommunOf('Bromma / Blackeberg, Stockholms kommun'), 'Stockholms');
      assert.strictEqual(kommunOf('Ingen kommun här'), null);
      assert.strictEqual(kommunOf(null), null);
    });
    await check('muniMatches allows the genitive s, either way round', () => {
      assert.ok(muniMatches('Stockholms', 'Stockholm'));
      assert.ok(muniMatches('Alingsås', 'Alingsås'));
      assert.ok(muniMatches('Göteborgs', 'Göteborgs kommun'));
      assert.ok(!muniMatches('Solna', 'Sollentuna'));
      assert.ok(!muniMatches(null, 'Solna'));
    });
    await check('firstNumber parses Hemnet display strings', () => {
      assert.strictEqual(firstNumber('171 m²'), 171);
      assert.strictEqual(firstNumber('62 + 10 m²'), 62);
      assert.strictEqual(firstNumber('2,5 rum'), 2.5);
      assert.strictEqual(firstNumber('1 205 m²'), 1205);
      assert.strictEqual(firstNumber(null), null);
    });
    const card = {
      id: '22000820', streetAddress: 'Edsåsvägen 220', locationDescription: 'Alingsås, Alingsås kommun',
      publishedAt: 1779055200, housingForm: 'Villa', askingPrice: null, upcoming: true, newConstruction: false,
      activePackage: 'AGGREGATED', slug: 'villa-4rum-x-22000820', recordType: 'AGGREGATED', livingArea: '171 m²',
      rooms: '4 rum', lat: 57.8, long: 12.5,
    };
    await check('shapeCard: an aggregated coming-soon card', () => {
      const r = shapeCard(card, '2026-11-04');
      assert.strictEqual(r.tier, 'premarket');
      assert.strictEqual(r.ad_class, 'aggregated');
      assert.strictEqual(r.kommun, 'Alingsås');
      assert.strictEqual(r.living_area, 171);
      assert.strictEqual(r.rooms, 4);
      assert.deepStrictEqual(r.packages_seen, ['AGGREGATED']);
      assert.strictEqual(r.first_paid_seen, null);
      assert.strictEqual(r.published_at, '2026-05-17T22:00:00.000Z');
    });
    await check('shapeCard: a paid card records the day it was first seen paid', () => {
      const r = shapeCard({ ...card, activePackage: 'PLUS', upcoming: false }, '2026-11-04');
      assert.strictEqual(r.ad_class, 'paid');
      assert.strictEqual(r.tier, 'forsale');
      assert.strictEqual(r.first_paid_seen, '2026-11-04');
    });
    await check('diffRow: new, unchanged, upgrade, tier move, missing package', () => {
      const r = shapeCard(card, '2026-11-04');
      const d0 = diffRow(null, r, 'daily');
      assert.ok(d0.isNew && d0.history && d0.history.prior_package === null);
      const same = diffRow({ package: 'AGGREGATED', tier: 'premarket' }, r, 'weekly');
      assert.strictEqual(same.history, null);
      const up = diffRow({ package: 'AGGREGATED', tier: 'premarket' }, shapeCard({ ...card, activePackage: 'PLUS' }, '2026-11-05'), 'daily');
      assert.ok(up.changed && up.upgraded);
      assert.strictEqual(up.history.prior_package, 'AGGREGATED');
      assert.strictEqual(up.history.package, 'PLUS');
      const paidToPaid = diffRow({ package: 'PLUS', tier: 'forsale' }, shapeCard({ ...card, activePackage: 'MAX', upcoming: false }, '2026-11-05'), 'daily');
      assert.ok(paidToPaid.changed && !paidToPaid.upgraded, 'Plus to Max is a change, not an upgrade to paid');
      const move = diffRow({ package: 'AGGREGATED', tier: 'premarket' }, shapeCard({ ...card, upcoming: false }, '2026-11-05'), 'weekly');
      assert.ok(move.changed && !move.upgraded);
      assert.strictEqual(move.history.prior_tier, 'premarket');
      const nopkg = diffRow({ package: 'PLUS', tier: 'premarket' }, shapeCard({ ...card, activePackage: null }, '2026-11-05'), 'weekly');
      assert.strictEqual(nopkg.history, null, 'a card with no package is not a change');
    });
    await check('tierCounts groups distinct rows by tier and package', () => {
      const rows = [shapeCard(card, 'd'), shapeCard({ ...card, id: 2, activePackage: 'PLUS', upcoming: false }, 'd'),
        shapeCard({ ...card, id: 3, activePackage: 'PLUS', upcoming: false }, 'd')];
      assert.deepStrictEqual(tierCounts(rows), { forsale: { PLUS: 2 }, premarket: { AGGREGATED: 1 } });
    });
    await check('applyCards: dedupes, diffs against the registry and writes in one transaction', async () => {
      const calls = [];
      const client = {
        query: async (sql, params) => {
          calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
          if (/^SELECT hemnet_id/.test(sql.trim())) return { rows: [{ hemnet_id: '2', package: 'AGGREGATED', tier: 'forsale' }] };
          return { rows: [], rowCount: 0 };
        },
      };
      const out = await applyCards(client, [card, card, { ...card, id: '2', activePackage: 'BASIC', upcoming: false }], { seenOn: '2026-11-04', source: 'daily' });
      assert.deepStrictEqual(out, { cards: 3, distinct: 2, newAds: 1, changed: 1, upgrades: 1 });
      assert.deepStrictEqual(calls, ['SELECT hemnet_id::text AS', 'BEGIN', 'INSERT INTO hemnet_ad_registry', 'INSERT INTO hemnet_ad_package_history', 'COMMIT']);
    });
    await check('applyCards: a failed write rolls back and throws', async () => {
      const calls = [];
      const client = {
        query: async (sql) => {
          calls.push(sql.trim().split(/\s+/)[0]);
          if (/^SELECT/.test(sql.trim())) return { rows: [] };
          if (/^INSERT INTO hemnet_ad_registry/.test(sql.trim())) throw new Error('boom');
          return { rows: [] };
        },
      };
      await assert.rejects(applyCards(client, [card], { seenOn: '2026-11-04', source: 'daily' }), /boom/);
      assert.ok(calls.includes('ROLLBACK'));
    });
    console.log(`smoke: ${pass} pass, ${fail} fail`);
    if (fail) process.exit(1);
  })();
}
