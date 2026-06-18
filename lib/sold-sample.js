'use strict';

// lib/sold-sample.js — Phase 19 national population-weighted fortnightly sampler
// (SCHED-01 / D-13 / D-14).
//
// Reads config/sold-panel.json (the v1 11-municipality national panel, each muni
// carrying pop + booli_area_id + hemnet_location_id). For each muni x {Hus, Lägenhet}
// it fetches the Booli /slutpriser 14-day feed (fetchBooliSoldPage, paginated),
// EXCLUDES deeds (the parser-computed is_title_transfer flag — methodology stays
// Slutpris-only, no recompute) and DE-DUPES new pulls against the booli_sold.booli_id
// rows the orchestrator already has. It then ALLOCATES the config target (~1000)
// across munis BY POPULATION (capped at each muni's live 14-day volume) and within a
// muni splits Hus:Lägenhet by the NATURAL live volume ratio (no per-type quota), and
// TAGS each sampled record with a synthetic per-record `seg`
// { family, booli:{areaIds,objectType}, hemnet:{locationId,itemType} } built from its
// muni + type, so the existing matchOne can search Hemnet for it.
//
// The allocation math is a PURE function (offline-unit-testable, D-13). The Booli
// fetch + the de-dup query are injectable (deps), so `node lib/sold-sample.js --smoke`
// runs allocation + tagging + the full sampleNational path offline with zero Oxylabs
// and zero live DB and exits 0.
//
// This is a LIBRARY: it must `require` cleanly with NO network and NO DB (like
// lib/sold-recheck.js). It does NOT force the Oxylabs transport load-guard and does NOT
// require the transport at module top — fetchBooliSoldPage is required LAZILY inside
// sampleNational (and the smoke injects a stub so it never touches the network).
//
//   node lib/sold-sample.js --smoke   # offline self-test (no DB, no network)

const fs = require('fs');
const path = require('path');
const { daysAgoISO } = require('./sold-config');
// fetchBooliSoldPage is required LAZILY inside sampleNational only — keeping the pure
// core + --smoke require-clean and network-free.

const PANEL_PATH = path.join(__dirname, '..', 'config', 'sold-panel.json');

// loadPanel — read the national panel config (munis + pop + IDs + target + lookback).
function loadPanel() {
  return JSON.parse(fs.readFileSync(PANEL_PATH, 'utf8'));
}

const FAMILIES = ['HOUSE', 'APARTMENT'];

// ---------------------------------------------------------------------------
// buildSeg — PURE. The synthetic per-record `seg` that matchOne consumes. Mirrors
// the SHAPE of the config/sold-segments.json entries exactly (matchOne reads
// seg.family, seg.booli.{areaIds,objectType}, seg.hemnet.{locationId,itemType}).
//   HOUSE     → booli.objectType 'Hus',      hemnet.itemType null
//   APARTMENT → booli.objectType 'Lägenhet', hemnet.itemType 'bostadsratt'
// ---------------------------------------------------------------------------
function buildSeg(muni, family) {
  if (family === 'HOUSE') {
    return {
      family: 'HOUSE',
      booli: { areaIds: muni.booli_area_id, objectType: 'Hus' },
      hemnet: { locationId: muni.hemnet_location_id, itemType: null },
    };
  }
  return {
    family: 'APARTMENT',
    booli: { areaIds: muni.booli_area_id, objectType: 'Lägenhet' },
    hemnet: { locationId: muni.hemnet_location_id, itemType: 'bostadsratt' },
  };
}

// ---------------------------------------------------------------------------
// allocate — PURE (no I/O). Distribute `target` across the panel's munis.
//   panel        = { munis:[ {name, pop, ...}, ... ], ... }
//   liveVolumes  = { [muniName]: { HOUSE:<count>, APARTMENT:<count> } }  (de-duped,
//                  non-deed live 14-day counts the fetch produced)
//   target       = config target_sample_size (~1000)
//
// Step A — per-muni target BY POPULATION: muniTarget = round(target * pop / sumPop),
//   then CAPPED at the muni's live total (HOUSE+APARTMENT). Zero-live muni → 0.
// Step B — within a muni, split muniTarget across {HOUSE, APARTMENT} by the NATURAL
//   live ratio: houseQuota = round(muniTarget * liveHouse / liveTotal),
//   aptQuota = muniTarget - houseQuota — NO per-type quota/editing (D-13). Each type's
//   quota is clamped to ITS live count; any clamped remainder spills to the other type
//   only up to ITS live cap.
//
// Returns [ { muni:<name>, family:'HOUSE'|'APARTMENT', quota:<n> }, ... ] in stable
// panel order (entries with quota 0 dropped). Invariants ALWAYS hold:
//   sum(quota) <= target  AND  sum(quota) <= sum(live).
// ---------------------------------------------------------------------------
function allocate(panel, liveVolumes, target) {
  const munis = (panel && panel.munis) || [];
  const sumPop = munis.reduce((s, m) => s + (Number(m.pop) || 0), 0);
  const out = [];
  if (sumPop <= 0 || !(target > 0)) return out;

  // WR-02: per-muni Math.round of population shares can sum ABOVE target (rounding
  // drift, e.g. 11 munis x pop 100 / target 1000 → 1001). Carry a global `remaining`
  // budget and cap each muni against it so the documented invariant sum(quota) <= target
  // always holds (and the batch never bills past the implied ceiling).
  let remaining = target;
  for (const m of munis) {
    if (remaining <= 0) break;
    const live = (liveVolumes && liveVolumes[m.name]) || { HOUSE: 0, APARTMENT: 0 };
    const liveHouse = Math.max(0, Number(live.HOUSE) || 0);
    const liveApt = Math.max(0, Number(live.APARTMENT) || 0);
    const liveTotal = liveHouse + liveApt;
    if (liveTotal <= 0) continue; // zero-volume muni → no allocation entries (quota 0)

    // Step A: population share, CAPPED at the muni's live total AND the global remaining.
    let muniTarget = Math.round((target * (Number(m.pop) || 0)) / sumPop);
    if (muniTarget > liveTotal) muniTarget = liveTotal; // D-13 cap — never invent demand
    if (muniTarget > remaining) muniTarget = remaining; // WR-02 global budget cap
    if (muniTarget <= 0) continue;

    // Step B: natural live ratio split (NO per-type quota).
    let houseQuota = Math.round((muniTarget * liveHouse) / liveTotal);
    let aptQuota = muniTarget - houseQuota;

    // Clamp each type to its own live cap; spill the clamped remainder to the other
    // type only up to ITS live cap (so sum(quota) never exceeds sum(live) for the muni).
    if (houseQuota > liveHouse) {
      const spill = houseQuota - liveHouse;
      houseQuota = liveHouse;
      aptQuota = Math.min(liveApt, aptQuota + spill);
    }
    if (aptQuota > liveApt) {
      const spill = aptQuota - liveApt;
      aptQuota = liveApt;
      houseQuota = Math.min(liveHouse, houseQuota + spill);
    }

    // WR-02: draw down the global budget by what this muni actually took (after the
    // live-cap clamps), so subsequent munis are bounded and sum(quota) <= target holds.
    remaining -= (houseQuota + aptQuota);

    if (houseQuota > 0) out.push({ muni: m.name, family: 'HOUSE', quota: houseQuota });
    if (aptQuota > 0) out.push({ muni: m.name, family: 'APARTMENT', quota: aptQuota });
  }
  return out;
}

// ---------------------------------------------------------------------------
// sampleNational — the impure orchestration-facing entry the Plan 19-02 batch calls
// ONCE. opts = { client, log, deps }. Everything stubbable via deps so the smoke is
// network/DB-free:
//   deps.fetchBooliSoldPage(segKey, seg, opts) → { cards, meta }   (default: lazy require)
//   deps.knownBooliIds(booliIds) → Promise<Set<string>>            (default: SELECT … = ANY($1))
//   deps.now  (ISO string | Date)  → drives the 14-day window via daysAgoISO
//   deps.panel  → override loadPanel() (smoke injects a tiny panel)
//
// Steps:
//   1. load panel; window = [today-lookback .. today] (D-14).
//   2. for each muni x family: paginate the Booli /slutpriser feed; EXCLUDE deeds
//      (is_title_transfer === true → skip). A CeilingError propagates UNCHANGED; any
//      OTHER single-fetch error → that muni-type contributes 0 (never abort the sample).
//   3. de-dup all fetched non-deed booli_ids against knownBooliIds; drop the seen ones.
//   4. allocate(panel, liveVolumes, target); build the queue by taking the first `quota`
//      surviving cards per muni+type and TAGGING each record with seg + family + segment.
//   5. return { queue, stats }.
// ---------------------------------------------------------------------------
async function sampleNational(opts = {}) {
  const o = opts || {};
  const log = o.log || (() => {});
  const deps = o.deps || {};
  const client = o.client;
  const panel = deps.panel || loadPanel();

  // Lazy default for fetchBooliSoldPage — only required when no stub is injected, so a
  // plain require('./sold-sample') stays network-free.
  const fetchPage = deps.fetchBooliSoldPage
    || require('./sold-fetch-booli').fetchBooliSoldPage;

  // Default de-dup: one parameterized read-only query (ASVS V5; no interpolation). The
  // smoke injects a stub Set so it never touches the DB.
  const knownBooliIds = deps.knownBooliIds || (async (ids) => {
    if (!ids.length) return new Set();
    const r = await client.query(
      `SELECT booli_id FROM booli_sold WHERE booli_id = ANY($1)`,
      [ids]
    );
    return new Set(r.rows.map((row) => String(row.booli_id)));
  });

  // 14-day window (D-14): derive the anchor deterministically from the injected clock.
  const maxSoldDate = (deps.now ? new Date(deps.now) : new Date())
    .toISOString().slice(0, 10);
  const minSoldDate = daysAgoISO(panel.lookback_days, maxSoldDate);

  // Per-muni-per-type fetch (deeds excluded at parse-flag time).
  // cardsByMuni[muni][family] = [ surviving non-deed cards ]
  const cardsByMuni = {};
  let fetched = 0;
  let deedsExcluded = 0;
  let fetchFailures = 0;
  const allBooliIds = [];

  for (const muni of panel.munis) {
    cardsByMuni[muni.name] = { HOUSE: [], APARTMENT: [] };
    for (const family of FAMILIES) {
      const seg = buildSeg(muni, family);
      const segKey = `${muni.name}:${family}`;
      let page = 1;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let cards;
        let meta;
        try {
          ({ cards, meta } = await fetchPage(segKey, seg, {
            page, maxSoldDate, minSoldDate, logger: log,
          }));
        } catch (e) {
          // CeilingError MUST propagate UNCHANGED (the Plan 19-02 batch ceiling stops
          // the sample mid-fetch). Any OTHER error → this muni-type contributes 0.
          if (e && e.name === 'CeilingError') throw e;
          fetchFailures++;
          log('ERROR', `sampleNational fetch ${segKey} page=${page} failed: ${e && e.message}`);
          break;
        }
        // WR-01: the real fetchBooliSoldPage SWALLOWS transport/non-200/Apollo-parse
        // errors and returns { cards:[], meta:{ totalCount:null, pages:null } } instead of
        // throwing (lib/sold-fetch-booli.js). Without this, a real Booli outage makes a
        // muni-type silently contribute zero rows with fetchFailures stuck at 0, so the
        // D-07 escalation can never fire. Treat that exact signature as a fetch FAILURE.
        // A legitimately-empty feed returns a NUMERIC totalCount (e.g. 0), not null.
        if (!meta || (meta.totalCount == null && meta.pages == null)) {
          fetchFailures++;
          log('WARN', `sampleNational fetch ${segKey} page=${page}: empty/failed page (totalCount+pages null) — counted as fetch failure`);
          break;
        }
        for (const card of (cards || [])) {
          fetched++;
          if (card.is_title_transfer === true) { deedsExcluded++; continue; }
          cardsByMuni[muni.name][family].push(card);
          allBooliIds.push(String(card.booli_id));
        }
        // Stop on an empty page OR once we have walked all available pages. A null-pages
        // error page (cards:[]) terminates cleanly via the cards.length === 0 branch.
        if ((cards || []).length === 0 || (meta && meta.pages != null && page >= meta.pages)) break;
        page++;
      }
    }
  }

  // De-dup against already-stored booli_ids (D-13 — skip already-seen).
  const known = await knownBooliIds(allBooliIds);
  let dupsExcluded = 0;
  const liveVolumes = {};
  for (const muni of panel.munis) {
    liveVolumes[muni.name] = { HOUSE: 0, APARTMENT: 0 };
    for (const family of FAMILIES) {
      const survivors = cardsByMuni[muni.name][family].filter((c) => {
        if (known.has(String(c.booli_id))) { dupsExcluded++; return false; }
        return true;
      });
      cardsByMuni[muni.name][family] = survivors;
      liveVolumes[muni.name][family] = survivors.length;
    }
  }

  // Allocate the target across munis (pure) and build the tagged output queue.
  const quotas = allocate(panel, liveVolumes, panel.target_sample_size);
  const muniByName = {};
  for (const m of panel.munis) muniByName[m.name] = m;

  const queue = [];
  for (const { muni, family, quota } of quotas) {
    const survivors = cardsByMuni[muni][family];
    const take = survivors.slice(0, quota);
    const m = muniByName[muni];
    for (const card of take) {
      queue.push({
        ...card,
        segment: `${muni}:${family}`,
        family,
        seg: buildSeg(m, family),
      });
    }
  }

  return {
    queue,
    stats: {
      fetched,
      deedsExcluded,
      dupsExcluded,
      fetchFailures,
      allocated: queue.length,
      perMuni: liveVolumes,
      window: { minSoldDate, maxSoldDate },
    },
  };
}

module.exports = { loadPanel, buildSeg, allocate, sampleNational };

// ---------------------------------------------------------------------------
// Inline smoke test — node lib/sold-sample.js --smoke
// Fully offline: pure-core checks + a stubbed sampleNational path (zero Oxylabs,
// zero live DB). Mirrors lib/sold-recheck.js's check/checkAsync style.
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  (async () => {
    // ---- Task 1: pure allocation + seg-tagging core ----

    // 1. buildSeg HOUSE shape.
    check('buildSeg HOUSE shape', () => {
      const s = buildSeg({ booli_area_id: 20, hemnet_location_id: 17793 }, 'HOUSE');
      assert.deepStrictEqual(s, {
        family: 'HOUSE',
        booli: { areaIds: 20, objectType: 'Hus' },
        hemnet: { locationId: 17793, itemType: null },
      });
    });

    // 2. buildSeg APARTMENT shape.
    check('buildSeg APARTMENT shape', () => {
      const s = buildSeg({ booli_area_id: 1, hemnet_location_id: 18031 }, 'APARTMENT');
      assert.strictEqual(s.booli.objectType, 'Lägenhet');
      assert.strictEqual(s.hemnet.itemType, 'bostadsratt');
      assert.strictEqual(s.hemnet.locationId, 18031);
      assert.strictEqual(s.booli.areaIds, 1);
    });

    // 3. allocation is population-weighted (~9:1).
    check('allocation is population-weighted', () => {
      const panel = { munis: [
        { name: 'A', pop: 900 }, { name: 'B', pop: 100 },
      ] };
      const live = {
        A: { HOUSE: 500, APARTMENT: 500 },
        B: { HOUSE: 500, APARTMENT: 500 },
      };
      const q = allocate(panel, live, 1000);
      const sumA = q.filter((x) => x.muni === 'A').reduce((s, x) => s + x.quota, 0);
      const sumB = q.filter((x) => x.muni === 'B').reduce((s, x) => s + x.quota, 0);
      assert.ok(sumA > sumB, `A (${sumA}) should exceed B (${sumB})`);
      const ratio = sumA / sumB;
      assert.ok(ratio >= 7 && ratio <= 11, `ratio ${ratio} should be ~9:1`);
    });

    // 4. allocation caps at live volume.
    check('allocation caps at live volume', () => {
      const panel = { munis: [
        { name: 'Big', pop: 900 }, { name: 'Small', pop: 100 },
      ] };
      const live = {
        Big: { HOUSE: 2, APARTMENT: 3 },  // only 5 live
        Small: { HOUSE: 100, APARTMENT: 100 },
      };
      const q = allocate(panel, live, 1000);
      const sumBig = q.filter((x) => x.muni === 'Big').reduce((s, x) => s + x.quota, 0);
      assert.ok(sumBig <= 5, `Big quota ${sumBig} must be <= 5 live`);
    });

    // 5. within-muni natural type ratio (no per-type quota).
    check('within-muni natural type ratio (no per-type quota)', () => {
      // single muni, muniTarget capped at live total 14; live {HOUSE:1, APARTMENT:13}
      const panel = { munis: [{ name: 'M', pop: 100 }] };
      const live = { M: { HOUSE: 1, APARTMENT: 13 } };
      const q = allocate(panel, live, 14);
      const h = q.find((x) => x.family === 'HOUSE');
      const a = q.find((x) => x.family === 'APARTMENT');
      assert.ok(h && h.quota >= 1 && h.quota <= 2, `house quota ~1, got ${h && h.quota}`);
      assert.ok(a && a.quota >= 12 && a.quota <= 13, `apt quota ~13, got ${a && a.quota}`);
      // NOT a 7/7 even split
      assert.notStrictEqual(h.quota, 7);
    });

    // 6. totals bounded for the REAL panel + a synthetic liveVolumes map.
    check('totals bounded', () => {
      const panel = loadPanel();
      const live = {};
      let sumLive = 0;
      for (const m of panel.munis) {
        const h = 30; const a = 30;
        live[m.name] = { HOUSE: h, APARTMENT: a };
        sumLive += h + a;
      }
      const q = allocate(panel, live, panel.target_sample_size);
      const total = q.reduce((s, x) => s + x.quota, 0);
      assert.ok(total <= panel.target_sample_size, `total ${total} <= target ${panel.target_sample_size}`);
      assert.ok(total <= sumLive, `total ${total} <= sumLive ${sumLive}`);
    });

    // 7. zero-volume muni → zero quota / no entries.
    check('zero-volume muni -> zero quota', () => {
      const panel = { munis: [
        { name: 'Dead', pop: 900 }, { name: 'Live', pop: 100 },
      ] };
      const live = {
        Dead: { HOUSE: 0, APARTMENT: 0 },
        Live: { HOUSE: 50, APARTMENT: 50 },
      };
      const q = allocate(panel, live, 1000);
      assert.ok(!q.some((x) => x.muni === 'Dead'), 'Dead muni must contribute no entries');
      assert.ok(q.some((x) => x.muni === 'Live'), 'Live muni must contribute');
    });

    // ---- Task 2: sampleNational (stubbed deps, zero network/DB) ----

    // A tiny 2-muni panel for the fetch-driven checks.
    const tinyPanel = {
      target_sample_size: 1000,
      lookback_days: 14,
      munis: [
        { name: 'Stockholm', pop: 980, booli_area_id: 1, hemnet_location_id: 18031 },
        { name: 'Täby', pop: 73, booli_area_id: 20, hemnet_location_id: 17793 },
      ],
    };

    // Helper: a stub fetchBooliSoldPage that returns one card per (segKey) on page 1,
    // empty thereafter (single-page feed). booli_id derived from segKey so it is unique.
    function makeStubFetch(cardFactory) {
      let id = 1000;
      return async (segKey, seg, fopts) => {
        if (fopts.page > 1) return { cards: [], meta: { pages: 1 } };
        const card = cardFactory(segKey, seg, ++id);
        return { cards: [card], meta: { pages: 1 } };
      };
    }

    // 8. fetch drives every muni x type.
    await checkAsync('fetch drives every muni x type', async () => {
      const seen = new Set();
      const fetchStub = async (segKey, seg, fopts) => {
        seen.add(segKey);
        return { cards: [], meta: { pages: 1 } };
      };
      await sampleNational({
        log: () => {},
        deps: {
          panel: tinyPanel,
          fetchBooliSoldPage: fetchStub,
          knownBooliIds: async () => new Set(),
          now: '2026-06-18',
        },
      });
      assert.ok(seen.has('Stockholm:HOUSE'), 'Stockholm Hus fetched');
      assert.ok(seen.has('Stockholm:APARTMENT'), 'Stockholm Lägenhet fetched');
      assert.ok(seen.has('Täby:HOUSE'), 'Täby Hus fetched');
      assert.ok(seen.has('Täby:APARTMENT'), 'Täby Lägenhet fetched');
    });

    // 9. deeds excluded.
    await checkAsync('deeds excluded', async () => {
      const fetchStub = makeStubFetch((segKey, seg, id) => ({
        booli_id: id, is_title_transfer: true, residence_url: `/bostad/${id}`,
      }));
      const { queue, stats } = await sampleNational({
        log: () => {},
        deps: {
          panel: tinyPanel,
          fetchBooliSoldPage: fetchStub,
          knownBooliIds: async () => new Set(),
          now: '2026-06-18',
        },
      });
      assert.strictEqual(queue.length, 0, 'all-deed feed yields empty queue');
      assert.ok(stats.deedsExcluded >= 1, `deedsExcluded ${stats.deedsExcluded} >= 1`);
    });

    // 10. de-dup drops known booli_ids.
    await checkAsync('de-dup drops known booli_ids', async () => {
      let firstId = null;
      const fetchStub = makeStubFetch((segKey, seg, id) => {
        if (firstId == null) firstId = String(id);
        return { booli_id: id, is_title_transfer: false, residence_url: `/bostad/${id}` };
      });
      const { stats } = await sampleNational({
        log: () => {},
        deps: {
          panel: tinyPanel,
          fetchBooliSoldPage: fetchStub,
          knownBooliIds: async () => new Set([firstId]),
          now: '2026-06-18',
        },
      });
      assert.ok(stats.dupsExcluded >= 1, `dupsExcluded ${stats.dupsExcluded} >= 1`);
    });

    // 11. every queued record carries seg + family.
    await checkAsync('every queued record carries seg + family', async () => {
      const fetchStub = makeStubFetch((segKey, seg, id) => ({
        booli_id: id, is_title_transfer: false, residence_url: `/bostad/${id}`,
      }));
      const { queue } = await sampleNational({
        log: () => {},
        deps: {
          panel: tinyPanel,
          fetchBooliSoldPage: fetchStub,
          knownBooliIds: async () => new Set(),
          now: '2026-06-18',
        },
      });
      assert.ok(queue.length > 0, 'queue not empty');
      for (const rec of queue) {
        const [muniName, fam] = rec.segment.split(':');
        assert.strictEqual(rec.family, fam, 'family matches segment');
        assert.strictEqual(rec.seg.family, fam, 'seg.family matches');
        if (fam === 'HOUSE') {
          assert.strictEqual(rec.seg.booli.objectType, 'Hus');
        } else {
          assert.strictEqual(rec.seg.booli.objectType, 'Lägenhet');
        }
        const m = tinyPanel.munis.find((x) => x.name === muniName);
        assert.strictEqual(rec.seg.hemnet.locationId, m.hemnet_location_id, 'seg locationId matches muni');
      }
    });

    // 12. allocated <= target.
    await checkAsync('allocated <= target', async () => {
      const fetchStub = makeStubFetch((segKey, seg, id) => ({
        booli_id: id, is_title_transfer: false, residence_url: `/bostad/${id}`,
      }));
      const { queue, stats } = await sampleNational({
        log: () => {},
        deps: {
          panel: tinyPanel,
          fetchBooliSoldPage: fetchStub,
          knownBooliIds: async () => new Set(),
          now: '2026-06-18',
        },
      });
      assert.strictEqual(stats.allocated, queue.length, 'allocated === queue.length');
      assert.ok(queue.length <= tinyPanel.target_sample_size, 'allocated <= target');
    });

    // 12b. error-page-as-empty terminates cleanly (meta.pages null, cards:[]).
    await checkAsync('error page (pages null, cards empty) terminates cleanly', async () => {
      let calls = 0;
      const fetchStub = async (segKey, seg, fopts) => {
        calls++;
        // simulate a fetch/parse error page: cards empty, meta.pages null
        return { cards: [], meta: { totalCount: null, pages: null } };
      };
      const { queue, stats } = await sampleNational({
        log: () => {},
        deps: {
          panel: tinyPanel,
          fetchBooliSoldPage: fetchStub,
          knownBooliIds: async () => new Set(),
          now: '2026-06-18',
        },
      });
      assert.strictEqual(queue.length, 0, 'no records from error pages');
      // 2 munis x 2 families = 4 fetches, each terminating after page 1 (no infinite loop)
      assert.strictEqual(calls, 4, `exactly 4 fetches (one per muni x type), got ${calls}`);
      // WR-01: each null-totalCount+null-pages page is a swallowed fetch failure → counted.
      assert.strictEqual(stats.fetchFailures, 4, `fetchFailures must be 4 (one per swallowed-error muni-type), got ${stats.fetchFailures}`);
    });

    // 12c. WR-01: a LEGITIMATELY-empty feed (numeric totalCount 0) is NOT a fetch failure.
    await checkAsync('legit-empty feed (totalCount 0) is not a fetch failure', async () => {
      const fetchStub = async () => ({ cards: [], meta: { totalCount: 0, pages: 0 } });
      const { stats } = await sampleNational({
        log: () => {},
        deps: {
          panel: tinyPanel, fetchBooliSoldPage: fetchStub,
          knownBooliIds: async () => new Set(), now: '2026-06-18',
        },
      });
      assert.strictEqual(stats.fetchFailures, 0, `legit-empty must NOT count as failure, got ${stats.fetchFailures}`);
    });

    // 14. WR-02: rounded population shares must NEVER over-allocate past target.
    check('allocation never exceeds target (rounding drift)', () => {
      // 11 munis x equal pop, each with ample live volume — naive per-muni round() would
      // sum to 1001 for target 1000. The global remaining-budget cap must hold sum <= 1000.
      const munis = [];
      const live = {};
      for (let i = 0; i < 11; i++) {
        const n = `M${i}`;
        munis.push({ name: n, pop: 100 });
        live[n] = { HOUSE: 100, APARTMENT: 100 };
      }
      const q = allocate({ munis }, live, 1000);
      const total = q.reduce((s, x) => s + x.quota, 0);
      assert.ok(total <= 1000, `total ${total} must be <= target 1000`);
    });

    // 13. CeilingError propagates.
    await checkAsync('CeilingError propagates', async () => {
      class CeilingError extends Error { constructor(m) { super(m); this.name = 'CeilingError'; } }
      const fetchStub = async () => { throw new CeilingError('spend ceiling hit'); };
      await assert.rejects(
        () => sampleNational({
          log: () => {},
          deps: {
            panel: tinyPanel,
            fetchBooliSoldPage: fetchStub,
            knownBooliIds: async () => new Set(),
            now: '2026-06-18',
          },
        }),
        /spend ceiling hit/,
        'sampleNational must re-throw the CeilingError'
      );
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
