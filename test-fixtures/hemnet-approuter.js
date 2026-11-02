// test-fixtures/hemnet-approuter.js — the live Hemnet App Router pages captured
// 2026-11-03 from the droplet via Oxylabs (Hemnet moved to the App Router ~2026-10-30;
// see docs/handover/CHANGELOG.md 2026-11-03). Stored gzipped: ~1.1 MB instead of ~10 MB.
//
// Captured numbers worth asserting against:
//   till-salu-exclude   forSale  62,802
//   till-salu-only      upcoming 27,166
//   till-salu-all       combined 89,968  (= 62,802 + 27,166 exactly)
//   till-salu-goteborg-apartments-rooms1.5-2-p2   Göteborg (17920), APARTMENTS, rooms 1.5–2, offset 50, total 1,076
//   bostader-goteborg-apartments-2rooms-1.8-2.6M  Göteborg, APARTMENTS, 2 rooms, 1.8–2.6M kr, total 403
//   salda-goteborg-apartments-2rooms              sold, total 30,446, 50 SaleCards
//   bostad-22055372-minimal                       App Router detail, MINIMAL, 319 views, Göteborgs kommun
//   bostad-sold-pages-router                      a sold listing page Hemnet still served as Pages Router
//   till-salu-only-gnosjo-u2028                   Gnosjö pre-market, total 7; its result row holds a U+2028
//                                                 (captured 2026-11-02 UTC after it failed the census re-run)
//   bostad-19424955-after-text-row                detail whose listing row follows a length-prefixed TEXT row, 115 views
//   bostader-orkelljunga-fritidshus-1-result      search whose variables row follows a TEXT row, total 1

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'hemnet-approuter-2026-11-03');

function loadHemnetPage(name) {
  return zlib.gunzipSync(fs.readFileSync(path.join(DIR, `${name}.html.gz`))).toString('utf8');
}

module.exports = { loadHemnetPage };
