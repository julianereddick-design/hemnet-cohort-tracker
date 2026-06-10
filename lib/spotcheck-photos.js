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

module.exports = {
  ogImage,
  hemnetHeroUrl,
  booliHeroUrl,
  firstBooliImageId,
  hemnetGalleryUrls,
  booliGalleryUrls,
  downloadImage,
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

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
