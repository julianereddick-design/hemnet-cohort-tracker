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

const UNRESOLVED_WARN_PCT = 10;
const VOLUME_ANOMALY_PCT = 40;
const VOLUME_HISTORY_WEEKS = 4;

// A zero-listing cohort means the walk or the parser broke, not that Sweden
// stopped selling houses. Fail hard and persist nothing — the same guard that
// was missing when spotcheck-photos.js wrote back an empty result set.
function assertCohortNonEmpty(n) {
  if (!n) throw new Error('walk produced 0 in-window listings — refusing to persist');
}

// Compare this week's volume against the trailing mean. Silent until enough
// history exists; a short series must not manufacture an alarm.
function volumeAnomaly(nTotal, priorTotals) {
  if (priorTotals.length < VOLUME_HISTORY_WEEKS) return null;
  const mean = priorTotals.reduce((a, b) => a + b, 0) / priorTotals.length;
  if (!mean) return null;
  const deltaPct = Math.round(100 * (nTotal - mean) / mean);
  if (Math.abs(deltaPct) <= VOLUME_ANOMALY_PCT) return null;
  return `n_total ${nTotal} is ${deltaPct > 0 ? '+' : ''}${deltaPct}% vs ${VOLUME_HISTORY_WEEKS}-week mean ${Math.round(mean)}`;
}

function validate(summary) {
  const problems = [];
  if (summary.n_ambiguous > 0) {
    const unresolvedPct = 100 * (summary.n_ambiguous - summary.n_resolved) / summary.n_ambiguous;
    if (unresolvedPct > UNRESOLVED_WARN_PCT) {
      problems.push(`${summary.n_ambiguous - summary.n_resolved}/${summary.n_ambiguous} ambiguous listings unresolved (${unresolvedPct.toFixed(1)}%)`);
    }
  }
  if (summary.n_unknown_labels > 0) {
    problems.push(`${summary.n_unknown_labels} unknown image label(s) — Booli taxonomy may have changed, check lib/booli-image-labels.js`);
  }
  if (summary.volumeAnomaly) problems.push(summary.volumeAnomaly);
  if (summary.pagesWalked >= MAX_PAGES) {
    problems.push(`walk hit maxPages=${MAX_PAGES} — the week may be truncated (undercount)`);
  }
  return problems.length ? problems.join(' · ') : null;
}

// getOxylabsStats() exposes { oxylabsCallCount, oxylabsFailureCount,
// directSuccessCount, oxylabsFallbackRate } — there is NO `requests` field.
// Reading `.requests` yields undefined, so the subtraction yields NaN, which
// node-pg serialises as "NaN" and Postgres rejects on an INTEGER column.
// Total calls = Oxylabs + direct.
function oxCallsTotal() {
  const s = getOxylabsStats();
  return s.oxylabsCallCount + s.directSuccessCount;
}

const UPSERT = `
  INSERT INTO premarket_quality_weekly (
    snapshot_date, window_days, n_total,
    n_high, n_mid_high, n_mid_sell, n_mid_fish, n_other, n_low,
    pct_interior, pct_price, pct_avm_shown, pct_viewing,
    n_ambiguous, n_resolved, n_unknown_labels, pages_walked, oxylabs_calls
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  ON CONFLICT (snapshot_date) DO UPDATE SET
    window_days = EXCLUDED.window_days, n_total = EXCLUDED.n_total,
    n_high = EXCLUDED.n_high, n_mid_high = EXCLUDED.n_mid_high,
    n_mid_sell = EXCLUDED.n_mid_sell, n_mid_fish = EXCLUDED.n_mid_fish,
    n_other = EXCLUDED.n_other, n_low = EXCLUDED.n_low,
    pct_interior = EXCLUDED.pct_interior, pct_price = EXCLUDED.pct_price,
    pct_avm_shown = EXCLUDED.pct_avm_shown, pct_viewing = EXCLUDED.pct_viewing,
    n_ambiguous = EXCLUDED.n_ambiguous, n_resolved = EXCLUDED.n_resolved,
    n_unknown_labels = EXCLUDED.n_unknown_labels,
    pages_walked = EXCLUDED.pages_walked, oxylabs_calls = EXCLUDED.oxylabs_calls,
    created_at = NOW()
`;

async function main(client, log) {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
  const callsAtStart = oxCallsTotal();

  let walkCalls = 0;
  const fetchPage = async (p) => {
    if (++walkCalls > WALK_CALL_CEILING) throw new Error(`walk ceiling ${WALK_CALL_CEILING} exceeded`);
    return parsePage(apolloFrom((await getWithRetry(searchUrl(p), { logger: () => {} })).html)).cards;
  };
  const fetchDetail = async (url) => apolloFrom((await getWithRetry(url, { logger: () => {} })).html);

  const { listings, pagesWalked } = await collectWeek({ fetchPage, nowSec, logger: log });
  log('INFO', `walked ${pagesWalked} pages -> ${listings.length} in-window 2nd-hand listings`);
  assertCohortNonEmpty(listings.length);

  await resolveAmbiguous({ listings, fetchDetail, logger: log });

  const counts = tally(listings);
  const oxylabsCalls = oxCallsTotal() - callsAtStart;

  const prior = await client.query(
    `SELECT n_total FROM premarket_quality_weekly
      WHERE snapshot_date < $1::date ORDER BY snapshot_date DESC LIMIT $2`,
    [today, VOLUME_HISTORY_WEEKS]
  );
  const anomaly = volumeAnomaly(counts.n_total, prior.rows.map(r => Number(r.n_total)));

  await client.query(UPSERT, [
    today, WINDOW_DAYS, counts.n_total,
    counts.high, counts.mid_high, counts.mid_sell, counts.mid_fish, counts.other, counts.low,
    counts.pct_interior, counts.pct_price, counts.pct_avm_shown, counts.pct_viewing,
    counts.n_ambiguous, counts.n_resolved, counts.n_unknown_labels, pagesWalked, oxylabsCalls,
  ]);

  log('INFO', `persisted ${today}: coming-to-market ${counts.high + counts.mid_high}/${counts.n_total}, ` +
    `filler ${counts.low}, ${oxylabsCalls} Oxylabs calls`);

  return { ...counts, pagesWalked, oxylabsCalls, volumeAnomaly: anomaly };
}

// Entry gate: --smoke runs the offline self-test; otherwise the job runs under cron-wrapper.
if (require.main === module && process.argv.includes('--smoke')) {
  smoke();
} else if (require.main === module) {
  require('../cron-wrapper').runJob({
    scriptName: 'premarket-quality-measure',
    main,
    validate,
  });
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

  // --- validate() thresholds ------------------------------------------------
  const base = { n_total: 2264, n_ambiguous: 537, n_resolved: 537, n_unknown_labels: 0, volumeAnomaly: null };
  check('validate: clean run returns nothing', () => {
    assert(!validate(base), 'clean run should not warn');
  });
  check('validate: >10% unresolved warns', () => {
    const v = validate({ ...base, n_resolved: 480 });   // 57/537 = 10.6%
    assert(/unresolved/i.test(v || ''), `expected unresolved warning, got ${v}`);
  });
  check('validate: exactly 10% unresolved does not warn', () => {
    const v = validate({ ...base, n_ambiguous: 100, n_resolved: 90 });
    assert(!v, `10% should be within tolerance, got ${v}`);
  });
  check('validate: unknown labels warn (taxonomy drift canary)', () => {
    const v = validate({ ...base, n_unknown_labels: 2 });
    assert(/label/i.test(v || ''), `expected label warning, got ${v}`);
  });
  check('validate: volume anomaly warns', () => {
    const v = validate({ ...base, volumeAnomaly: 'n_total 900 is -60% vs 4-week mean 2250' });
    assert(/vs 4-week mean/.test(v || ''), `expected volume warning, got ${v}`);
  });
  check('validate: hitting maxPages warns of a possibly truncated week', () => {
    const v = validate({ ...base, pagesWalked: MAX_PAGES });
    assert(/maxPages/.test(v || ''), `expected truncation warning, got ${v}`);
  });
  check('validate: below maxPages does not warn of truncation', () => {
    const v = validate({ ...base, pagesWalked: MAX_PAGES - 1 });
    assert(!v, `walk under the cap should not warn, got ${v}`);
  });
  check('validate: zero listings is a hard failure not a warning', () => {
    let threw = false;
    try { assertCohortNonEmpty(0); } catch (e) {
      threw = true;
      assert(/refusing to persist/.test(e.message), `wrong error message: ${e.message}`);
    }
    assert(threw, 'empty cohort must throw');
  });
  check('validate: a non-empty cohort does not throw', () => {
    // Guards against an inverted condition in assertCohortNonEmpty.
    assertCohortNonEmpty(2264);
  });
  check('oxCallsTotal() is a real integer, not NaN from a nonexistent field', () => {
    // getOxylabsStats() has no `.requests` field — this is the exact bug that
    // made every run fail on the final INSERT after already spending the money.
    assert(Number.isInteger(oxCallsTotal()), `expected an integer, got ${oxCallsTotal()}`);
  });

  await Promise.all(results);
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
