'use strict';

// probe-location-search.js — Diagnostic: direct probe of Hemnet /locations/show autocomplete API.
//   Authored during Phase 8 VERF-04 to validate muni-id resolution paths.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { getWithRetry } = require('../../lib/scrape-http');

(async () => {
  const muni = process.argv[2] || 'Stockholm';
  const urls = [
    `https://www.hemnet.se/locations/show?q=${encodeURIComponent(muni)}`,
    `https://www.hemnet.se/locations/show?term=${encodeURIComponent(muni)}`,
    `https://www.hemnet.se/locations/show?search=${encodeURIComponent(muni)}`,
    `https://www.hemnet.se/locations/show?name=${encodeURIComponent(muni)}`,
    `https://www.hemnet.se/locations.json?q=${encodeURIComponent(muni)}`,
    `https://www.hemnet.se/locations/autocomplete?q=${encodeURIComponent(muni)}`,
    `https://www.hemnet.se/locations/autocomplete.json?q=${encodeURIComponent(muni)}`,
    `https://www.hemnet.se/locations/autocomplete?query=${encodeURIComponent(muni)}`,
  ];
  for (const url of urls) {
    console.log('---');
    console.log('Fetching:', url);
    try {
      const res = await getWithRetry(url, { logger: () => {} });
      console.log('status:', res.status, 'html length:', res.html ? res.html.length : 0);
      if (res.html && res.html.length > 0 && res.html.length < 5000) {
        console.log('preview:', res.html.slice(0, 1000));
      } else if (res.html) {
        console.log('preview (truncated):', res.html.slice(0, 500));
      }
    } catch (e) {
      console.log('FAILED:', e && e.message);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
