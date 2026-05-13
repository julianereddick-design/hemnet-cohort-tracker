'use strict';

// seed-hemnet-locations.js — Emergency cache-rebuild tool: re-seeds lib/hemnet-locations.json
//   from Hemnet /locations/show autocomplete + cross-check. Run if cache is wiped/corrupted.
//   Authored during Phase 8 VERF-04 to work around the lib/hemnet-locations.js genitive bug
//   (now patched in Phase 8.5 LIBC-01 — kept here for emergency rebuild use).

// scripts/seed-hemnet-locations.js — one-shot bootstrap that pre-seeds
// lib/hemnet-locations.json with the W19 (2026-05-04 .. 2026-05-10) Booli
// FS muni set. Works around the genitive-form bug in lib/hemnet-locations.js
// (the muni.fullName === `${name} kommun` check fails for "Stockholms kommun",
// "Trollhättans kommun", etc).
//
// D-29 cache-growth exception: this is what the harvester *should* be
// doing automatically — we're doing it manually because the harvester's
// equality check is too strict. The real fix is deferred to Phase 8.5.
//
// Strategy: use Hemnet's own /locations/show?q=<name> JSON endpoint. It
// returns an array of {id, name, location_type, slug, parent_location}
// objects matching the query. We filter for location_type === 'municipality'
// and prefer matches where:
//   1. slug starts with the lowercase muni name + (optional "s") + "-kommun"
//   2. OR name === `${muniName}s kommun` (genitive form Hemnet uses)
//   3. OR name === `${muniName} kommun`  (nominative form)
//
// Re-runs are idempotent — keys already in the JSON are skipped.
//
// Run from hemnet-cohort-tracker/:
//   node scripts/diagnostics/seed-hemnet-locations.js
//   node scripts/diagnostics/seed-hemnet-locations.js --only "Stockholm,Malmö"

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const { getWithRetry } = require('../../lib/scrape-http');
const { loadCache } = require('../../lib/hemnet-locations');

const CACHE_PATH = path.join(__dirname, '..', '..', 'lib', 'hemnet-locations.json');

const W19_MUNIS = [
  'Ängelholm','Åstorp','Båstad','Bjuv','Bromölla','Burlöv','Eslöv','Hässleholm',
  'Helsingborg','Höganäs','Höör','Hörby','Kävlinge','Klippan','Kristianstad',
  'Landskrona','Lomma','Lund','Malmö','Örkelljunga','Osby','Östra Göinge',
  'Perstorp','Simrishamn','Sjöbo','Skurup','Staffanstorp','Svalöv','Svedala',
  'Tomelilla','Trelleborg','Vellinge','Ystad',
  'Botkyrka','Danderyd','Ekerö','Haninge','Huddinge','Järfälla','Lidingö',
  'Nacka','Norrtälje','Nykvarn','Nynäshamn','Österåker','Salem','Sigtuna',
  'Södertälje','Sollentuna','Solna','Stockholm','Sundbyberg','Täby','Tyresö',
  'Upplands-Bro','Upplands Väsby','Vallentuna','Värmdö','Vaxholm',
  'Älvkarleby','Enköping','Håbo','Heby','Knivsta','Östhammar','Tierp','Uppsala',
  'Ale','Alingsås','Åmål','Bengtsfors','Bollebygd','Borås','Dals-Ed','Essunga',
  'Falköping','Färgelanda','Göteborg','Götene','Grästorp','Gullspång','Härryda',
  'Herrljunga','Hjo','Karlsborg','Kungälv','Lerum','Lidköping','Lilla Edet',
  'Lysekil','Mariestad','Mark','Mellerud','Mölndal','Öckerö','Orust','Partille',
  'Skara','Skövde','Sotenäs','Stenungsund','Strömstad','Svenljunga','Tanum',
  'Tibro','Tidaholm','Tjörn','Töreboda','Tranemo','Trollhättan','Uddevalla',
  'Ulricehamn','Vänersborg','Vara','Vårgårda',
];

const SLEEP_BETWEEN_MUNIS_MS = 600;

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] seed: ${msg}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function saveCache(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  fs.writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

// Build a slug from a Swedish muni name following Hemnet's slug rules:
//   lowercase, strip accents, replace spaces with hyphens
// Hemnet appears to keep "ö/ä/å" in slugs (e.g., "mölndals-kommun"), so
// we DON'T strip diacritics. Just lowercase + space-to-hyphen.
function muniSlugBase(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

async function resolveMuni(muniName) {
  const q = encodeURIComponent(muniName);
  const url = `https://www.hemnet.se/locations/show?q=${q}`;
  // The /locations/show endpoint returns JSON (no __NEXT_DATA__) so the
  // Oxylabs fallback in scrape-http.js can't accept its responses. We add
  // our own outer-retry loop with longer backoff to ride out occasional
  // Cloudflare 403s. Up to 4 tries total: 0s, 5s, 15s, 40s.
  const BACKOFFS = [0, 5000, 15000, 40000];
  let lastErr;
  let body;
  for (let i = 0; i < BACKOFFS.length; i++) {
    if (BACKOFFS[i] > 0) await sleep(BACKOFFS[i]);
    try {
      const res = await getWithRetry(url, { logger: () => {} });
      if (res.status !== 200 || !res.html) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      body = JSON.parse(res.html);
      break;
    } catch (e) {
      lastErr = e && e.message;
      // 403 from this JSON endpoint is the most common — Cloudflare doesn't
      // like rapid-fire API calls. Backoff loop above handles it.
    }
  }
  if (body == null) {
    return { ok: false, reason: `fetch/parse error after retries: ${lastErr}` };
  }
  if (!Array.isArray(body)) return { ok: false, reason: 'non-array response' };

  // Filter to municipality entries
  const munis = body.filter((b) => b && b.location_type === 'municipality');
  if (munis.length === 0) {
    return { ok: false, reason: `no municipality in ${body.length} results` };
  }

  const slugBase = muniSlugBase(muniName);
  const candidates = [];

  // 1. Exact slug genitive form: e.g. "stockholms-kommun"
  // 2. Exact slug nominative form: e.g. "lomma-kommun"
  // 3. Name == `${muniName} kommun` (nominative)
  // 4. Name == `${muniName}s kommun` (genitive)
  // Score by preference, take highest.
  for (const m of munis) {
    let score = 0;
    if (m.slug === `${slugBase}s-kommun`) score = 100;
    else if (m.slug === `${slugBase}-kommun`) score = 95;
    else if (m.name === `${muniName}s kommun`) score = 90;
    else if (m.name === `${muniName} kommun`) score = 85;
    else if (m.slug && m.slug.startsWith(`${slugBase}s-`)) score = 60;
    else if (m.slug && m.slug.startsWith(`${slugBase}-`)) score = 55;
    else if (m.name && m.name.toLowerCase().startsWith(muniName.toLowerCase())) score = 30;
    if (score > 0) candidates.push({ ...m, score });
  }

  if (candidates.length === 0) {
    // Fallback: take any municipality whose name contains the query
    const fallback = munis.find((m) =>
      m.name && m.name.toLowerCase().includes(muniName.toLowerCase()),
    );
    if (fallback) {
      return {
        ok: true,
        id: parseInt(fallback.id, 10),
        name: fallback.name,
        slug: fallback.slug,
        matchScore: 'fallback',
      };
    }
    return { ok: false, reason: `no slug/name match in ${munis.length} muni results: ${munis.map((m) => m.name).slice(0, 5).join(', ')}` };
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  return {
    ok: true,
    id: parseInt(top.id, 10),
    name: top.name,
    slug: top.slug,
    matchScore: top.score,
  };
}

function parseOnlyArg(argv) {
  const idx = argv.indexOf('--only');
  if (idx === -1) return null;
  const v = argv[idx + 1];
  if (!v) return null;
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

(async () => {
  const only = parseOnlyArg(process.argv);
  const targets = only != null ? W19_MUNIS.filter((m) => only.includes(m)) : W19_MUNIS;

  log('INFO', `target munis: ${targets.length}${only ? ` (filtered via --only)` : ''}`);

  const cache = loadCache();
  log('INFO', `existing cache keys: ${Object.keys(cache).length}`);

  const missing = targets.filter((m) => cache[m] == null);
  log('INFO', `missing keys: ${missing.length}`);
  if (missing.length === 0) {
    log('INFO', 'nothing to do — exiting');
    return;
  }

  let resolved = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < missing.length; i++) {
    const muni = missing[i];
    log('INFO', `[${i + 1}/${missing.length}] resolving "${muni}"`);
    const r = await resolveMuni(muni);
    if (r.ok) {
      cache[muni] = r.id;
      saveCache(cache);
      resolved++;
      log('INFO', `  -> id=${r.id} (name="${r.name}", slug=${r.slug}, score=${r.matchScore})`);
    } else {
      failed++;
      failures.push({ muni, reason: r.reason });
      log('ERROR', `  -> FAILED: ${r.reason}`);
    }
    if (i < missing.length - 1) await sleep(SLEEP_BETWEEN_MUNIS_MS);
  }

  log('INFO', `done. resolved=${resolved} failed=${failed}`);
  if (failures.length) {
    log('INFO', `failures:`);
    for (const f of failures) log('INFO', `  - ${f.muni}: ${f.reason}`);
    log('INFO', `re-run with --only "${failures.map((f) => f.muni).join(',')}" to retry`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
