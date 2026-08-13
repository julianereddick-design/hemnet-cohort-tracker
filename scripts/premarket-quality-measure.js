'use strict';
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/premarket-quality-measure.js — weekly Booli pre-market quality measurement.
//
// Walks one week of new pre-market listings, classifies each from its search card,
// opens the ambiguous ones (card image cap hides interiors), categorises the cohort
// on the six-rung ladder, and persists one row to premarket_quality_weekly.
//
// Replaces the manual four-script pipeline (premarket-quality-week / -resolve /
// -recompute / -categorise). Rubric lives in lib/premarket-quality.js.
//
// Cron: Mon 09:00 UTC, after premarket-flow-measure (08:50), before the report (09:40).
// Cost: ~604 Oxylabs calls ≈ $1.51/week.
//
// Self-test: node scripts/premarket-quality-measure.js --smoke   (offline, no DB, no network)

const { walkFlow } = require('../lib/premarket-flow');
const { getWithRetry, extractNextData, getOxylabsStats } = require('../lib/scrape-http');
const { interiorVerdict, INTERIOR } = require('../lib/booli-image-labels');
const { bucketOf, NEEDS_PAGE, tally, WINDOW_DAYS } = require('../lib/premarket-quality');
const { parsePublishedToUnix } = require('../lib/booli-fetch');

const MAX_PAGES = 120;          // flow job uses 80; ~71 expected, so 80 could truncate
const WALK_CALL_CEILING = 130;

// No `sort` param — any sort=* flips Booli to oldest-first.
const searchUrl = p => `https://www.booli.se/sok/till-salu?upcomingSale=1&page=${p}`;

function apolloFrom(html) {
  const d = extractNextData(html);
  const a = d && d.props && d.props.pageProps && d.props.pageProps.__APOLLO_STATE__;
  if (!a) throw new Error('__APOLLO_STATE__ missing');
  return a;
}

function dataPoints(L) {
  const k = Object.keys(L).find(x => x.startsWith('displayAttributes('));
  const d = L[k];
  return (d && Array.isArray(d.dataPoints) ? d.dataPoints : [])
    .map(p => p && p.value && p.value.plainText).filter(Boolean);
}

function richCard(L, S) {
  const imgKey = Object.keys(L).find(k => k.startsWith('images('));
  const imgs = (Array.isArray(L[imgKey]) ? L[imgKey] : [])
    .map(r => (r && r.__ref ? S[r.__ref] : r)).filter(Boolean);
  const labels = imgs.map(i => (i.primaryLabel === undefined ? null : i.primaryLabel));
  const verdict = interiorVerdict(labels);

  const loc = L.location && L.location.__ref ? S[L.location.__ref] : L.location;
  const muni = (loc && loc.region && loc.region.municipalityName) || null;
  const agKey = Object.keys(L).find(k => k.startsWith('agency('));

  const dp = dataPoints(L);
  const price = L.listPrice && typeof L.listPrice.raw === 'number' ? L.listPrice.raw : null;
  const estimate = L.estimate && L.estimate.price && typeof L.estimate.price.raw === 'number'
    ? L.estimate.price.raw : null;

  const labelCounts = {};
  for (const l of labels) { const k = l == null ? 'NULL' : l; labelCounts[k] = (labelCounts[k] || 0) + 1; }

  return {
    booli_id: L.id != null ? String(L.id) : null,
    url: L.url || null,
    // Booli serves `published` as a 'YYYY-MM-DD HH:MM:SS' STRING on search
    // cards, not Unix seconds. Passing it through raw makes every downstream
    // numeric comparison (`published >= cutoff`) false, which empties the cohort
    // AND stops walkFlow's `pageEntirelyOld` from ever firing — so the walk runs
    // to maxPages. parsePublishedToUnix accepts both forms defensively.
    published: parsePublishedToUnix(L.published),
    publishedRaw: L.published || null,
    // walkFlow reads exactly these two keys — everything else rides along free.
    isNewBuild: L.isNewConstruction === true,
    upcomingSale: L.upcomingSale === true,
    price, estimate,
    priceMissingAvmShown: price == null && estimate != null,
    cardPhotos: imgs.length,
    blockedImages: L.blockedImages === true,
    cardLabels: labelCounts,
    interiorVerdict: verdict,
    bucket: bucketOf(verdict, imgs.length),
    resolved: false,
    nextShowing: L.nextShowing ? (L.nextShowing.fullDateAndTime || true) : null,
    objectType: L.objectType || null,
    municipality: muni,
    agency: (L[agKey] && L[agKey].name) || null,
    sizeM2: dp.find(x => /m²/.test(x) && !/tomt/.test(x)) || null,
  };
}

function parsePage(S) {
  const root = S.ROOT_QUERY || {};
  const key = Object.keys(root).find(k => k.startsWith('searchForSale') && Array.isArray(root[k].result));
  if (!key) throw new Error('no searchForSale result node');
  const cards = [];
  for (const ref of root[key].result) {
    const L = ref && ref.__ref ? S[ref.__ref] : null;
    if (L && L.__typename === 'Listing') cards.push(richCard(L, S));
  }
  return { cards, totalCount: root[key].totalCount };
}

// Walk the week newest-first. Reuses walkFlow so the window boundary logic is
// identical to the production flow job — the two numerators must be comparable.
async function collectWeek({ fetchPage, nowSec, logger }) {
  const res = await walkFlow({ fetchPage, nowSec, windowDays: WINDOW_DAYS, maxPages: MAX_PAGES, logger });
  const cutoff = nowSec - WINDOW_DAYS * 86400;
  const listings = res.cards.filter(c =>
    c.upcomingSale && !c.isNewBuild && c.published != null && c.published >= cutoff);
  return { listings, pagesWalked: res.pagesWalked };
}

const RESOLVE_CALL_CEILING = 700;
const RESOLVE_CONCURRENCY = 4;

// The detail gallery is NOT limit-capped. Take the longest images array on the
// canonical Listing node. (Lifted from scripts/premarket-quality-resolve.js:41-60.)
function galleryOf(S) {
  let L = null;
  for (const k of Object.keys(S)) {
    if (k.startsWith('Listing:') && S[k] && S[k].__typename === 'Listing') { L = S[k]; break; }
  }
  if (!L) return null;
  let imgs = [];
  for (const k of Object.keys(L)) {
    if (!k.startsWith('images')) continue;
    const r = (Array.isArray(L[k]) ? L[k] : []).map(x => (x && x.__ref ? S[x.__ref] : x)).filter(Boolean);
    if (r.length > imgs.length) imgs = r;
  }
  const labels = imgs.map(i => (i.primaryLabel === undefined ? null : i.primaryLabel));
  const labelCounts = {};
  for (const l of labels) { const k = l == null ? 'NULL' : l; labelCounts[k] = (labelCounts[k] || 0) + 1; }
  return { photos: imgs.length, labels, labelCounts, interiorN: labels.filter(l => INTERIOR.has(l)).length };
}

// Open EVERY listing the card could not settle. A failure leaves the listing
// unresolved rather than mis-categorised — tally() counts the shortfall and
// validate() escalates it.
async function resolveAmbiguous({ listings, fetchDetail, logger }) {
  const queue = listings.filter(l => NEEDS_PAGE.has(l.bucket));
  let opened = 0, failed = 0, next = 0;

  async function worker() {
    while (next < queue.length) {
      const l = queue[next++];
      if (opened + failed >= RESOLVE_CALL_CEILING) {
        logger('WARN', `resolve ceiling ${RESOLVE_CALL_CEILING} hit — ${queue.length - next} left unopened`);
        return;
      }
      try {
        const g = galleryOf(await fetchDetail(l.url));
        if (!g) throw new Error('no Listing node in detail page');
        l.interiorVerdict = g.interiorN > 0 ? 'yes' : 'no';
        l.galleryPhotos = g.photos;
        l.cardLabels = g.labelCounts;   // full gallery labels feed the taxonomy canary
        l.resolved = true;
        opened++;
      } catch (e) {
        failed++;
        logger('WARN', `resolve failed for ${l.url}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, worker));
  logger('INFO', `resolve: ${opened} opened, ${failed} failed, of ${queue.length} needing a page`);
  return { opened, failed };
}

if (require.main === module && process.argv.includes('--smoke')) {
  smoke();
}

async function smoke() {
  let failed = 0;
  const results = [];
  const check = (name, fn) => {
    results.push(Promise.resolve().then(fn).then(
      () => console.log(`  PASS  ${name}`),
      e => { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }));
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

  console.log('=== premarket-quality-measure --smoke ===');

  check('searchUrl carries upcomingSale and no sort param', () => {
    const u = searchUrl(3);
    assert(u.includes('upcomingSale=1'), 'missing upcomingSale');
    assert(u.includes('page=3'), 'missing page');
    assert(!/[?&]sort=/.test(u), 'sort param would flip Booli to oldest-first');
  });

  // Minimal Apollo state: one listing with a 5-image all-exterior gallery.
  const S = {
    ROOT_QUERY: { 'searchForSale({"x":1})': { result: [{ __ref: 'Listing:1' }], totalCount: 1 } },
    'Listing:1': {
      __typename: 'Listing', id: 1, url: 'https://www.booli.se/annons/1',
      published: 1786000000, isNewConstruction: false, upcomingSale: true,
      listPrice: { raw: 3300000 }, nextShowing: { fullDateAndTime: '2026-08-18 12:00' },
      'images(x)': [{ __ref: 'Img:1' }, { __ref: 'Img:2' }, { __ref: 'Img:3' },
                    { __ref: 'Img:4' }, { __ref: 'Img:5' }],
    },
    'Img:1': { primaryLabel: 'facade' }, 'Img:2': { primaryLabel: 'floorplan' },
    'Img:3': { primaryLabel: 'nearby_area' }, 'Img:4': { primaryLabel: 'facade' },
    'Img:5': { primaryLabel: 'garden' },
  };

  check('parsePage extracts one card', () => {
    const { cards } = parsePage(S);
    assert(cards.length === 1, `expected 1 card, got ${cards.length}`);
  });
  check('5 exterior images classify as ambiguous', () => {
    const c = parsePage(S).cards[0];
    assert(c.bucket === 'ambiguous', `expected ambiguous, got ${c.bucket}`);
    assert(NEEDS_PAGE.has(c.bucket), 'ambiguous must need the page');
  });
  check('card fields carry through', () => {
    const c = parsePage(S).cards[0];
    assert(c.booli_id === '1', 'booli_id');
    assert(c.url === 'https://www.booli.se/annons/1', 'canonical /annons url');
    assert(c.price === 3300000, 'price');
    assert(c.nextShowing !== null, 'nextShowing');
    assert(c.priceMissingAvmShown === false, 'priced listing is not AVM-shown');
  });
  check('AVM-shown detected when price absent but estimate present', () => {
    const S2 = JSON.parse(JSON.stringify(S));
    delete S2['Listing:1'].listPrice;
    S2['Listing:1'].estimate = { price: { raw: 2900000 } };
    const c = parsePage(S2).cards[0];
    assert(c.price === null, 'price should be null');
    assert(c.priceMissingAvmShown === true, 'AVM should be flagged');
  });
  check('interior label settles the card without a page fetch', () => {
    const S3 = JSON.parse(JSON.stringify(S));
    S3['Img:3'].primaryLabel = 'kitchen';
    const c = parsePage(S3).cards[0];
    assert(c.bucket === 'has_interior', `expected has_interior, got ${c.bucket}`);
  });
  check('new-build cards are flagged for exclusion', () => {
    const S4 = JSON.parse(JSON.stringify(S));
    S4['Listing:1'].isNewConstruction = true;
    const c = parsePage(S4).cards[0];
    assert(c.isNewBuild === true, 'isNewBuild must be set for walkFlow and the filter');
  });
  check('string published (search-card form) is parsed to numeric Unix seconds', () => {
    const S5 = JSON.parse(JSON.stringify(S));
    S5['Listing:1'].published = '2026-08-12 09:30:00';
    const c = parsePage(S5).cards[0];
    assert(typeof c.published === 'number', `expected number, got ${typeof c.published}`);
    assert(c.publishedRaw === '2026-08-12 09:30:00', 'publishedRaw must retain the original string');
  });
  check('numeric published (already Unix seconds) passes through unchanged', () => {
    const c = parsePage(S).cards[0];
    assert(c.published === 1786000000, `expected 1786000000, got ${c.published}`);
  });
  check('null/absent published yields null and does not throw', () => {
    const S6 = JSON.parse(JSON.stringify(S));
    delete S6['Listing:1'].published;
    const c = parsePage(S6).cards[0];
    assert(c.published === null, `expected null, got ${c.published}`);
  });

  // --- resolve stage --------------------------------------------------------
  const detailS = {
    'Listing:9': {
      __typename: 'Listing', id: 9,
      'images(full)': [{ __ref: 'D1' }, { __ref: 'D2' }, { __ref: 'D3' }],
      'images(small)': [{ __ref: 'D1' }],
    },
    D1: { primaryLabel: 'facade' }, D2: { primaryLabel: 'bedroom' }, D3: { primaryLabel: 'facade' },
  };
  check('galleryOf takes the longest images array', () => {
    const g = galleryOf(detailS);
    assert(g.photos === 3, `expected 3 photos, got ${g && g.photos}`);
    assert(g.interiorN === 1, `expected 1 interior, got ${g && g.interiorN}`);
  });

  check('resolve rescues an ambiguous listing that has interiors', async () => {
    const listings = [{ booli_id: '9', url: 'https://www.booli.se/annons/9',
      bucket: 'ambiguous', interiorVerdict: 'no', resolved: false, cardLabels: {} }];
    const r = await resolveAmbiguous({
      listings, logger: () => {},
      fetchDetail: async () => detailS,
    });
    assert(r.opened === 1, `opened ${r.opened}`);
    assert(r.failed === 0, `failed ${r.failed}`);
    assert(listings[0].interiorVerdict === 'yes', 'should be rescued to yes');
    assert(listings[0].resolved === true, 'should be marked resolved');
  });

  check('resolve confirms no-interior when the full gallery has none', async () => {
    const noInt = { 'Listing:8': { __typename: 'Listing', id: 8, 'images(full)': [{ __ref: 'E1' }] },
      E1: { primaryLabel: 'facade' } };
    const listings = [{ booli_id: '8', url: 'https://www.booli.se/annons/8',
      bucket: 'ambiguous', interiorVerdict: 'no', resolved: false, cardLabels: {} }];
    await resolveAmbiguous({ listings, logger: () => {}, fetchDetail: async () => noInt });
    assert(listings[0].interiorVerdict === 'no', 'should stay no');
    assert(listings[0].resolved === true, 'should still be marked resolved');
  });

  check('a failed detail fetch is tolerated, not fatal', async () => {
    const listings = [{ booli_id: '7', url: 'https://www.booli.se/annons/7',
      bucket: 'ambiguous', interiorVerdict: 'no', resolved: false, cardLabels: {} }];
    const r = await resolveAmbiguous({
      listings, logger: () => {},
      fetchDetail: async () => { throw new Error('timeout'); },
    });
    assert(r.failed === 1, `expected 1 failure, got ${r.failed}`);
    assert(listings[0].resolved === false, 'unresolved listing must not be marked resolved');
  });

  check('settled listings are never opened', async () => {
    let calls = 0;
    const listings = [{ booli_id: '6', url: 'u', bucket: 'has_interior',
      interiorVerdict: 'yes', resolved: false, cardLabels: {} }];
    await resolveAmbiguous({ listings, logger: () => {},
      fetchDetail: async () => { calls++; return detailS; } });
    assert(calls === 0, `settled listing must not be fetched, got ${calls} calls`);
  });

  await Promise.all(results);
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
