// lib/spotcheck-photos.js
//
// Extract the MAIN ("hero") property photo URL from a Hemnet or Booli detail
// page, and download it. Used by spotcheck-photos.js to let Claude visually
// confirm a matched cohort pair is the same physical property.
//
// WHY a separate photo path: the two sites expose the hero shot differently and
// neither field is in the DB.
//   * HEMNET: <meta property="og:image" content="https://bilder.hemnet.se/images/itemgallery_L/..jpg">
//             — the broker's cover photo. The Apollo state only carries AI-staged
//             `GeneratedImage` variants + broker logos, so og:image is the reliable hero.
//   * BOOLI:  <meta name="og:image" ...> (NOTE: name=, not property=) →
//             https://bcdn.se/images/cache/<imageId>_<WxH>.jpg. The hero id is also
//             Listing.images[0] in the Apollo state. The `Image` objects carry no URL
//             (Rails ActiveStorage signed tokens), so we CONSTRUCT the bcdn.se cache URL.
//
// Both image CDNs (bilder.hemnet.se, bcdn.se) serve directly over https with no
// Cloudflare challenge — only the HTML pages need the scrape layer / Oxylabs.

'use strict';

const fs = require('fs');
const https = require('https');

// Match <meta ... og:image ... content="URL">, accepting BOTH property="og:image"
// (Hemnet) and name="og:image" (Booli), in either attribute order.
function ogImage(html) {
  if (typeof html !== 'string') return null;
  const patterns = [
    /<meta[^>]+(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Hemnet hero = og:image (broker cover photo). null if absent.
function hemnetHeroUrl(html) {
  const og = ogImage(html);
  return og && /^https?:\/\//.test(og) ? og : null;
}

// Booli hero: prefer constructing from Listing.images[0] (guaranteed first/hero,
// requestable at a high-res cache size); fall back to og:image.
//   imageWxH default '1200x900' (also seen: '960x640').
function booliHeroUrl(html, apolloState, opts = {}) {
  const size = opts.size || '1200x900';
  const id = firstBooliImageId(apolloState);
  if (id != null) return `https://bcdn.se/images/cache/${id}_${size}.jpg`;
  const og = ogImage(html);
  return og && /^https?:\/\//.test(og) ? og : null;
}

// Pull the numeric id of Listing.images[0] from a Booli Apollo state.
// Listing.images is an array of { __ref: "Image:<id>" }. Returns the id string
// (e.g. "54032840") or null.
function firstBooliImageId(apolloState) {
  if (!apolloState || typeof apolloState !== 'object') return null;
  const listingKey = Object.keys(apolloState).find(
    (k) => k.startsWith('Listing:') && apolloState[k] && apolloState[k].__typename === 'Listing'
  );
  if (!listingKey) return null;
  const imgs = apolloState[listingKey].images;
  if (!Array.isArray(imgs) || imgs.length === 0) return null;
  const ref = imgs[0] && imgs[0].__ref;
  if (typeof ref !== 'string') return null;
  const m = ref.match(/^Image:(\d+)$/);
  return m ? m[1] : null;
}

// Hemnet full gallery: the real listing photos appear in the HTML as
// `itemgallery_<size>/<aa>/<bb>/<hash>.jpg` paths (distinct from the AI-staged
// `GeneratedImage` entries in Apollo). We dedupe by the hash path and request a
// large variant. Returns an array of absolute URLs (hero/first-in-DOM order).
function hemnetGalleryUrls(html, opts = {}) {
  const size = opts.size || 'itemgallery_L';
  const max = opts.max || 12;
  if (typeof html !== 'string') return [];
  const re = /itemgallery_[A-Za-z]+\/([a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]+\.(?:jpe?g|webp))/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const hashPath = m[1];
    if (seen.has(hashPath)) continue;
    seen.add(hashPath);
    out.push(`https://bilder.hemnet.se/images/${size}/${hashPath}`);
    if (out.length >= max) break;
  }
  return out;
}

// Booli full gallery from Apollo Listing.images. Returns [{ url, label }] in
// Listing order. With opts.interiorFirst, indoor shots (interior/kitchen/bath/
// room) are sorted ahead of exterior/aerial/plan so an indoor match is found fast.
function booliGalleryUrls(apolloState, opts = {}) {
  const size = opts.size || '1200x900';
  const max = opts.max || 12;
  if (!apolloState || typeof apolloState !== 'object') return [];
  const listingKey = Object.keys(apolloState).find(
    (k) => k.startsWith('Listing:') && apolloState[k] && apolloState[k].__typename === 'Listing'
  );
  if (!listingKey) return [];
  const imgs = apolloState[listingKey].images;
  if (!Array.isArray(imgs)) return [];
  let entries = imgs
    .map((r) => (r && typeof r.__ref === 'string' ? apolloState[r.__ref] : null))
    .filter((e) => e && /^Image:/.test(`Image:${e.id}`) && e.id != null)
    .map((e) => ({ url: `https://bcdn.se/images/cache/${e.id}_${size}.jpg`, label: e.primaryLabel || null }));
  if (opts.interiorFirst) {
    const indoor = (l) => l && /interior|kitchen|bath|room|kök|bad|rum/i.test(l);
    entries = entries.slice().sort((a, b) => (indoor(b.label) ? 1 : 0) - (indoor(a.label) ? 1 : 0));
  }
  return entries.slice(0, max);
}

// Download an image URL to destPath. Resolves { ok, bytes } or { ok:false, ... }.
// Never rejects. Follows one level of redirect (CDNs sometimes 30x to a variant).
function downloadImage(url, destPath, _redirects = 0) {
  return new Promise((resolve) => {
    if (!url) return resolve({ ok: false, error: 'no-url' });
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects < 2) {
        res.resume();
        return resolve(downloadImage(res.headers.location, destPath, _redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, status: res.statusCode });
      }
      const ct = res.headers['content-type'] || '';
      if (!/^image\//i.test(ct)) {
        res.resume();
        return resolve({ ok: false, error: `non-image content-type: ${ct}` });
      }
      const f = fs.createWriteStream(destPath);
      res.pipe(f);
      f.on('finish', () => f.close(() => {
        let bytes = 0;
        try { bytes = fs.statSync(destPath).size; } catch (_) { /* ignore */ }
        resolve({ ok: bytes > 0, bytes });
      }));
      f.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

// ---------------------------------------------------------------
// Phase 14: unit-level identity fields + label-aware Hemnet gallery from the
// detail-page Apollo state. Both platforms expose, on pages this module
// ALREADY fetches, the fields that disambiguate units within one building:
//   Hemnet ActivePropertyListing: fee.amount (exact kr), formattedFloor,
//     numberOfRooms, energyClassification, images(...).images[] each with
//     url/filename/labels (labels incl. 'FLOOR_PLAN').
//   Booli Listing: rent.raw (exact kr/mån), floor.raw, apartmentNumber.value
//     (the national lägenhetsnummer), isNewConstruction, agencyId.
// ---------------------------------------------------------------

// Find Hemnet's listing node. Active pages use ActivePropertyListing:<id>;
// match any *PropertyListing typename so deactivated variants still parse.
function hemnetListingNode(apolloState) {
  if (!apolloState || typeof apolloState !== 'object') return null;
  const key = Object.keys(apolloState).find(
    (k) => apolloState[k] && /PropertyListing$/.test(String(apolloState[k].__typename || ''))
  );
  return key ? apolloState[key] : null;
}

// First integer in formattedFloor ("3 av 4, hiss finns" → 3). "BV"/bottenvåning → 0.
function parseHemnetFloor(formattedFloor) {
  if (formattedFloor == null || typeof formattedFloor !== 'string') return null;
  if (/^\s*(bv|bottenv)/i.test(formattedFloor)) return 0;
  const m = formattedFloor.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// { fee, floor, formattedFloor, rooms, energyClass, tenure } — all null-safe.
function hemnetUnitFields(apolloState) {
  const n = hemnetListingNode(apolloState);
  if (!n) return { fee: null, floor: null, formattedFloor: null, rooms: null, energyClass: null, tenure: null };
  return {
    fee: n.fee && Number.isFinite(n.fee.amount) ? n.fee.amount : null,
    floor: parseHemnetFloor(n.formattedFloor),
    formattedFloor: n.formattedFloor != null ? n.formattedFloor : null,
    rooms: Number.isFinite(n.numberOfRooms) ? n.numberOfRooms : null,
    energyClass: (n.energyClassification && n.energyClassification.classification) || null,
    tenure: (n.tenure && n.tenure.name) || null,
  };
}

// Label-aware Hemnet gallery from Apollo: the listing node carries an
// argument-encoded field like `images({"limit":300})` whose .images[] entries
// each have an argument-encoded url (`url({"format":"ITEMGALLERY_CUT"})`),
// a filename (hash path), and labels (e.g. ['FLOOR_PLAN']). We rebuild the
// requested size from the filename. Returns [{ url, label }] in page order;
// empty array when Apollo is missing/unparseable (caller falls back to the
// HTML regex extractor, which has no labels).
function hemnetGalleryFromApollo(apolloState, opts = {}) {
  const size = opts.size || 'itemgallery_L';
  const max = opts.max || 12;
  const n = hemnetListingNode(apolloState);
  if (!n) return [];
  let best = null;
  for (const k of Object.keys(n)) {
    if (!/^images\(/.test(k)) continue;
    const v = n[k];
    if (v && Array.isArray(v.images) && (!best || v.images.length > best.length)) best = v.images;
  }
  if (!best) return [];
  const out = [];
  for (const img of best) {
    if (!img || typeof img !== 'object') continue;
    let url = null;
    if (typeof img.filename === 'string' && img.filename) {
      url = `https://bilder.hemnet.se/images/${size}/${img.filename}`;
    } else {
      const urlKey = Object.keys(img).find((k) => /^url\(/.test(k));
      if (urlKey && typeof img[urlKey] === 'string') url = img[urlKey];
    }
    if (!url) continue;
    const label = Array.isArray(img.labels) && img.labels.length ? String(img.labels[0]) : null;
    out.push({ url, label });
    if (out.length >= max) break;
  }
  return out;
}

// Booli unit fields from the Listing:<id> Apollo node — all null-safe.
function booliUnitFields(apolloState) {
  if (!apolloState || typeof apolloState !== 'object') {
    return { rent: null, floor: null, apartmentNumber: null, isNewConstruction: null, agencyId: null };
  }
  const key = Object.keys(apolloState).find(
    (k) => k.startsWith('Listing:') && apolloState[k] && apolloState[k].__typename === 'Listing'
  );
  const n = key ? apolloState[key] : null;
  if (!n) return { rent: null, floor: null, apartmentNumber: null, isNewConstruction: null, agencyId: null };
  return {
    rent: n.rent && Number.isFinite(n.rent.raw) ? n.rent.raw : null,
    floor: n.floor && Number.isFinite(n.floor.raw) ? n.floor.raw : null,
    apartmentNumber: (n.apartmentNumber && n.apartmentNumber.value != null) ? String(n.apartmentNumber.value) : null,
    isNewConstruction: typeof n.isNewConstruction === 'boolean' ? n.isNewConstruction : null,
    agencyId: n.agencyId != null ? String(n.agencyId) : null,
  };
}

// ---------------------------------------------------------------
// Phase 14.1: delisted-page classification. Removed listings return HTTP 200
// with a tombstone page — verified signatures (probe 2026-06-12):
//   Hemnet:  no og:image, Apollo listing node typename is Deactivated*/Sold*
//            PropertyListing (NOT ActivePropertyListing), text "Borttagen ..."
//   Booli:   no Listing:<id> Apollo node (SoldProperty instead), text
//            "Såld eller borttagen <date>"
// Returns 'active' | 'delisted'. Transport-level failures (throw/5xx) are the
// caller's 'error' state — these classifiers only see fetched pages.
// ---------------------------------------------------------------
function classifyHemnetPage(status, html, apolloState) {
  if (status === 404) return 'delisted';
  const node = hemnetListingNode(apolloState);
  if (node) return node.__typename === 'ActivePropertyListing' ? 'active' : 'delisted';
  // No listing node parsed: a live page always carries og:image; tombstones don't.
  return ogImage(html) ? 'active' : 'delisted';
}

function classifyBooliPage(status, html, apolloState) {
  if (status === 404) return 'delisted';
  // A parsed Listing node wins — a LIVE ad whose description merely mentions
  // "borttagen" must not be classified as removed.
  if (apolloState && typeof apolloState === 'object') {
    const hasListing = Object.keys(apolloState).some(
      (k) => k.startsWith('Listing:') && apolloState[k] && apolloState[k].__typename === 'Listing'
    );
    if (hasListing) return 'active';
    return 'delisted'; // Apollo parsed but no Listing node (e.g. SoldProperty tombstone)
  }
  if (typeof html === 'string' && /såld eller borttagen/i.test(html)) return 'delisted';
  return ogImage(html) ? 'active' : 'delisted';
}

module.exports = {
  ogImage,
  hemnetHeroUrl,
  booliHeroUrl,
  firstBooliImageId,
  hemnetGalleryUrls,
  booliGalleryUrls,
  downloadImage,
  hemnetListingNode,
  parseHemnetFloor,
  hemnetUnitFields,
  hemnetGalleryFromApollo,
  booliUnitFields,
  classifyHemnetPage,
  classifyBooliPage,
};

// ---------------------------------------------------------------
// --smoke self-test (pure parsers only; no network).
//   node lib/spotcheck-photos.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  const hemnetHtml = '<meta property="og:image" content="https://bilder.hemnet.se/images/itemgallery_L/b4/bb/x.jpg" data-next-head=""/>';
  const booliHtml = '<meta name="og:image" content="https://bcdn.se/images/cache/54032840_960x640.jpg" data-next-head=""/>';

  check('hemnet og:image (property=)', () => assert.strictEqual(hemnetHeroUrl(hemnetHtml), 'https://bilder.hemnet.se/images/itemgallery_L/b4/bb/x.jpg'));
  check('booli og:image (name=)', () => assert.strictEqual(ogImage(booliHtml), 'https://bcdn.se/images/cache/54032840_960x640.jpg'));
  check('ogImage null when absent', () => assert.strictEqual(ogImage('<html>no meta</html>'), null));

  const apollo = {
    'Listing:1': { __typename: 'Listing', images: [{ __ref: 'Image:54032840' }, { __ref: 'Image:54032841' }] },
    'Image:54032840': { __typename: 'Image', id: '54032840' },
  };
  check('firstBooliImageId', () => assert.strictEqual(firstBooliImageId(apollo), '54032840'));
  check('booliHeroUrl constructs from images[0]', () => assert.strictEqual(booliHeroUrl('', apollo), 'https://bcdn.se/images/cache/54032840_1200x900.jpg'));
  check('booliHeroUrl falls back to og:image', () => assert.strictEqual(booliHeroUrl(booliHtml, {}), 'https://bcdn.se/images/cache/54032840_960x640.jpg'));
  check('firstBooliImageId null on empty', () => assert.strictEqual(firstBooliImageId({}), null));

  const galHtml = 'x itemgallery_cut/19/3a/abc123.jpg y itemgallery_cut/19/3a/abc123.jpg z itemgallery_cut/21/fd/def456.jpg';
  check('hemnetGalleryUrls dedupes + builds _L', () => {
    const g = hemnetGalleryUrls(galHtml);
    assert.deepStrictEqual(g, [
      'https://bilder.hemnet.se/images/itemgallery_L/19/3a/abc123.jpg',
      'https://bilder.hemnet.se/images/itemgallery_L/21/fd/def456.jpg',
    ]);
  });
  const galApollo = {
    'Listing:1': { __typename: 'Listing', images: [{ __ref: 'Image:1' }, { __ref: 'Image:2' }, { __ref: 'Image:3' }] },
    'Image:1': { id: '1', primaryLabel: 'exterior' },
    'Image:2': { id: '2', primaryLabel: 'interior' },
    'Image:3': { id: '3', primaryLabel: 'kitchen' },
  };
  check('booliGalleryUrls order + url', () => {
    const g = booliGalleryUrls(galApollo);
    assert.strictEqual(g.length, 3);
    assert.strictEqual(g[0].url, 'https://bcdn.se/images/cache/1_1200x900.jpg');
  });
  check('booliGalleryUrls interiorFirst', () => {
    const g = booliGalleryUrls(galApollo, { interiorFirst: true });
    assert.ok(/interior|kitchen/.test(g[0].label), `expected indoor first, got ${g[0].label}`);
  });

  // --- Phase 14: Hemnet unit fields + Apollo gallery ---
  const hemnetApollo = {
    'ActivePropertyListing:21669222': {
      __typename: 'ActivePropertyListing',
      id: '21669222',
      fee: { __typename: 'Money', formatted: '5 593 kr', amount: 5593 },
      formattedFloor: '3 av 4, hiss finns',
      numberOfRooms: 3,
      energyClassification: { __typename: 'EnergyClassification', classification: 'E' },
      tenure: { __typename: 'Tenure', name: 'Bostadsrätt' },
      'images({"limit":300})': {
        __typename: 'ListingImageResults',
        images: [
          { __typename: 'ListingImage', 'url({"format":"ITEMGALLERY_CUT"})': 'https://bilder.hemnet.se/images/itemgallery_cut/50/da/aaa.jpg', filename: '50/da/aaa.jpg', labels: [] },
          { __typename: 'ListingImage', 'url({"format":"ITEMGALLERY_CUT"})': 'https://bilder.hemnet.se/images/itemgallery_cut/90/ad/bbb.jpg', filename: '90/ad/bbb.jpg', labels: ['FLOOR_PLAN'] },
        ],
      },
      'images({"limit":0})': { __typename: 'ListingImageResults', total: 27 },
    },
  };
  check('hemnetUnitFields extracts fee/floor/rooms/energy', () => {
    const u = hemnetUnitFields(hemnetApollo);
    assert.strictEqual(u.fee, 5593);
    assert.strictEqual(u.floor, 3);
    assert.strictEqual(u.rooms, 3);
    assert.strictEqual(u.energyClass, 'E');
    assert.strictEqual(u.tenure, 'Bostadsrätt');
  });
  check('hemnetUnitFields null-safe on empty apollo', () => {
    const u = hemnetUnitFields(null);
    assert.strictEqual(u.fee, null);
    assert.strictEqual(u.floor, null);
  });
  check('parseHemnetFloor variants', () => {
    assert.strictEqual(parseHemnetFloor('3 av 4, hiss finns'), 3);
    assert.strictEqual(parseHemnetFloor('BV'), 0);
    assert.strictEqual(parseHemnetFloor(null), null);
  });
  check('hemnetGalleryFromApollo builds sized urls + labels', () => {
    const g = hemnetGalleryFromApollo(hemnetApollo, { max: 10 });
    assert.strictEqual(g.length, 2);
    assert.strictEqual(g[0].url, 'https://bilder.hemnet.se/images/itemgallery_L/50/da/aaa.jpg');
    assert.strictEqual(g[0].label, null);
    assert.strictEqual(g[1].label, 'FLOOR_PLAN');
  });
  check('hemnetGalleryFromApollo empty on missing apollo', () => {
    assert.deepStrictEqual(hemnetGalleryFromApollo(null), []);
  });

  const booliUnitApollo = {
    'Listing:6155277': {
      __typename: 'Listing',
      rent: { __typename: 'FormattedValue', raw: 4080, value: '4 080', unit: 'kr/mån' },
      floor: { __typename: 'FormattedValue', raw: 1 },
      apartmentNumber: { __typename: 'FormattedValue', value: '1002' },
      isNewConstruction: false,
      agencyId: 12,
    },
  };
  check('booliUnitFields extracts rent/floor/aptNo', () => {
    const u = booliUnitFields(booliUnitApollo);
    assert.strictEqual(u.rent, 4080);
    assert.strictEqual(u.floor, 1);
    assert.strictEqual(u.apartmentNumber, '1002');
    assert.strictEqual(u.isNewConstruction, false);
    assert.strictEqual(u.agencyId, '12');
  });
  check('booliUnitFields null-safe', () => {
    const u = booliUnitFields({});
    assert.strictEqual(u.rent, null);
    assert.strictEqual(u.apartmentNumber, null);
  });

  // --- Phase 14.1: delisted-page classifiers (fixtures from live probe 2026-06-12) ---
  check('classifyHemnetPage: active listing → active', () => {
    assert.strictEqual(classifyHemnetPage(200, '<meta property="og:image" content="x"/>', hemnetApollo), 'active');
  });
  check('classifyHemnetPage: DeactivatedBeforeOpenHousePropertyListing → delisted', () => {
    const ap = { 'DeactivatedBeforeOpenHousePropertyListing:21737575': { __typename: 'DeactivatedBeforeOpenHousePropertyListing', id: '21737575' } };
    assert.strictEqual(classifyHemnetPage(200, '<html>Borttagen före visning</html>', ap), 'delisted');
  });
  check('classifyHemnetPage: 404 → delisted', () => {
    assert.strictEqual(classifyHemnetPage(404, '', null), 'delisted');
  });
  check('classifyHemnetPage: no apollo, no og:image → delisted', () => {
    assert.strictEqual(classifyHemnetPage(200, '<html>tomt</html>', null), 'delisted');
  });
  check('classifyBooliPage: live Listing node → active', () => {
    assert.strictEqual(classifyBooliPage(200, '<html>x</html>', booliUnitApollo), 'active');
  });
  check('classifyBooliPage: "Såld eller borttagen" tombstone → delisted', () => {
    const ap = { 'SoldProperty:1': { __typename: 'SoldProperty' } };
    assert.strictEqual(classifyBooliPage(200, '<p>Såld eller borttagen <strong>2026-03-25</strong></p>', ap), 'delisted');
  });
  check('classifyBooliPage: no Listing node → delisted', () => {
    assert.strictEqual(classifyBooliPage(200, '<html>x</html>', { 'SoldProperty:1': { __typename: 'SoldProperty' } }), 'delisted');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
