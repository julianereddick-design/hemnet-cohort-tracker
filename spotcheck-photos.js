#!/usr/bin/env node
/**
 * spotcheck-photos.js — enrich a spot-check artifact with MAIN property photos so
 * Claude can visually confirm each pair is the same property (UI/photo comparison).
 *
 * Reads a `verf-spotcheck-<cohort>-<ts>/spotcheck-<cohort>.json` artifact produced
 * by cohort-spotcheck.js, fetches the Hemnet + Booli detail pages (via the shared
 * direct→Oxylabs scrape layer), extracts each side's hero photo URL, downloads
 * both into <dir>/photos/, writes the URLs+paths back into the JSON, and emits a
 * PHOTOS.md with the images embedded side-by-side for review.
 *
 * By default it only does the FLAGGED pairs (provisional != likely-match) — that
 * is where a visual check resolves "different unit vs measurement noise", and it
 * keeps Booli Oxylabs calls low. Use --all to do every sampled pair.
 *
 * Usage:
 *   node spotcheck-photos.js                       # latest artifact dir, flagged pairs
 *   node spotcheck-photos.js <artifact-dir>        # explicit dir
 *   node spotcheck-photos.js --all                 # every sampled pair (2 fetches/pair)
 *   node spotcheck-photos.js --limit 10
 *
 * NEXT (the actual comparison): open PHOTOS.md / the photos/ images in a Claude
 * Code session and confirm same-vs-different property per pair.
 */
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { getWithRetry, extractNextData } = require('./lib/scrape-http');
const {
  hemnetHeroUrl, booliHeroUrl, hemnetGalleryUrls, booliGalleryUrls, downloadImage,
  hemnetUnitFields, hemnetGalleryFromApollo, booliUnitFields,
} = require('./lib/spotcheck-photos');

function log(level, msg) {
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 150 + Math.floor(Math.random() * 250);

function parseArgs(argv) {
  const a = { all: false, conc: 4, gallery: false, max: 10 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--all') a.all = true;
    else if (t === '--gallery') a.gallery = true;
    else if (t === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (t === '--max') a.max = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if (t === '--conc') a.conc = Math.max(1, parseInt(argv[++i], 10) || 4);
    else if (!t.startsWith('--')) a.dir = t;
  }
  return a;
}

function latestArtifactDir() {
  const dirs = fs.readdirSync('.').filter((d) => /^verf-spotcheck-.+/.test(d) && fs.statSync(d).isDirectory());
  if (dirs.length === 0) return null;
  return dirs.sort().pop();
}

// Fetch a detail page's raw HTML + Apollo state via the shared scrape layer.
// Returns { status:'active', html, apollo } | { status:'inactive', reason }.
async function fetchPage(url) {
  const res = await getWithRetry(url, { logger: () => {} });
  if (res.status === 404) return { status: 'inactive', reason: '404' };
  let apollo = null;
  try {
    const data = extractNextData(res.html);
    apollo = data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
  } catch (_) { /* og:image may still be present even if Apollo parse fails */ }
  return { status: 'active', html: res.html, apollo };
}

// Download a list of {url,label} into <sub>/<side>_NN[.label].jpg. Returns
// [{ file, label }] for the ones that succeeded (relative to artifact dir).
async function dlGallery(entries, sub, side, dir) {
  const out = [];
  let i = 1;
  for (const e of entries) {
    const labelTag = e.label ? '_' + String(e.label).replace(/[^a-z0-9]+/gi, '').slice(0, 12) : '';
    const dest = path.join(sub, `${side}_${String(i).padStart(2, '0')}${labelTag}.jpg`);
    const dl = await downloadImage(e.url, dest);
    if (dl.ok) out.push({ file: path.relative(dir, dest).split(path.sep).join('/'), label: e.label || null });
    i++;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const dir = args.dir || latestArtifactDir();
  if (!dir || !fs.existsSync(dir)) {
    log('ERROR', `no artifact dir found${args.dir ? `: ${args.dir}` : ' (run cohort-spotcheck.js first)'}`);
    process.exit(1);
  }
  const jsonFiles = fs.readdirSync(dir).filter((f) => /^spotcheck-.+\.json$/.test(f));
  if (jsonFiles.length === 0) { log('ERROR', `no spotcheck-*.json in ${dir}`); process.exit(1); }
  const jsonPath = path.join(dir, jsonFiles[0]);
  const artifact = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  let targets = artifact.pairs.filter((p) => args.all || p.provisional !== 'likely-match');
  if (args.limit != null) targets = targets.slice(0, args.limit);
  log('INFO', `${dir}: ${artifact.pairs.length} pairs, photo-enriching ${targets.length} (${args.all ? 'all' : 'flagged only'})`);

  const photoDir = path.join(dir, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });

  const counters = { hemnetOk: 0, booliOk: 0, hemnetMiss: 0, booliMiss: 0 };
  const queue = targets.slice();

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (!p) break;
      await sleep(jitter());
      const photos = { hemnet_hero_url: null, booli_hero_url: null, hemnet_file: null, booli_file: null, hemnet_gallery: [], booli_gallery: [], notes: [] };
      const pairSub = args.gallery ? path.join(photoDir, `pair${p.pair_id}`) : photoDir;
      if (args.gallery) fs.mkdirSync(pairSub, { recursive: true });

      // Hemnet
      try {
        const hp = await fetchPage(p.hemnet_url);
        if (hp.status === 'active') {
          // Phase 14: unit-level identity fields (fee/floor/rooms/energy) from the
          // Apollo state of the page we already fetched — zero extra cost.
          p.hemnet_unit = hemnetUnitFields(hp.apollo);
          photos.hemnet_hero_url = hemnetHeroUrl(hp.html);
          if (photos.hemnet_hero_url) {
            const dest = path.join(pairSub, args.gallery ? 'hemnet_00_hero.jpg' : `pair${p.pair_id}_hemnet.jpg`);
            const dl = await downloadImage(photos.hemnet_hero_url, dest);
            if (dl.ok) { photos.hemnet_file = path.relative(dir, dest).split(path.sep).join('/'); counters.hemnetOk++; }
            else { photos.notes.push(`hemnet-dl-fail:${dl.status || dl.error}`); counters.hemnetMiss++; }
          } else { photos.notes.push('hemnet-no-og-image'); counters.hemnetMiss++; }
          if (args.gallery) {
            // Prefer the Apollo gallery (carries per-image labels incl. FLOOR_PLAN);
            // fall back to the HTML regex (label-less) when Apollo is unparseable.
            let entries = hemnetGalleryFromApollo(hp.apollo, { max: args.max });
            if (entries.length === 0) {
              entries = hemnetGalleryUrls(hp.html, { max: args.max }).map((u) => ({ url: u }));
              if (entries.length) photos.notes.push('hemnet-gallery-regex-fallback');
            }
            photos.hemnet_gallery = await dlGallery(entries, pairSub, 'hemnet', dir);
          }
        } else { photos.notes.push(`hemnet-${hp.reason}`); counters.hemnetMiss++; }
      } catch (e) { photos.notes.push(`hemnet-err:${e.message}`); counters.hemnetMiss++; }

      // Booli — prefer the current AD URL built from booli_id (the ad id) over the
      // stored canonical url, which for ~62% of pairs is a /bostad/<residenceId>
      // residence page that can show photos/data from a PRIOR sale. /annons/<booli_id>
      // is always the current listing. Fall back to the stored url if it 404s.
      try {
        const adUrl = `https://www.booli.se/annons/${p.booli_id}`;
        photos.booli_url_used = adUrl;
        let bp = await fetchPage(adUrl);
        if (bp.status !== 'active' && p.booli_url && p.booli_url !== adUrl) {
          photos.notes.push('booli-annons-miss-fallback-to-stored');
          photos.booli_url_used = p.booli_url;
          bp = await fetchPage(p.booli_url);
        }
        if (bp.status === 'active') {
          // Phase 14: unit-level identity fields (rent/floor/apartmentNumber) from
          // the Apollo state of the page we already fetched — zero extra cost.
          p.booli_unit = booliUnitFields(bp.apollo);
          photos.booli_hero_url = booliHeroUrl(bp.html, bp.apollo);
          if (photos.booli_hero_url) {
            const dest = path.join(pairSub, args.gallery ? 'booli_00_hero.jpg' : `pair${p.pair_id}_booli.jpg`);
            const dl = await downloadImage(photos.booli_hero_url, dest);
            if (dl.ok) { photos.booli_file = path.relative(dir, dest).split(path.sep).join('/'); counters.booliOk++; }
            else { photos.notes.push(`booli-dl-fail:${dl.status || dl.error}`); counters.booliMiss++; }
          } else { photos.notes.push('booli-no-hero'); counters.booliMiss++; }
          if (args.gallery) {
            const entries = booliGalleryUrls(bp.apollo, { max: args.max, interiorFirst: true });
            photos.booli_gallery = await dlGallery(entries, pairSub, 'booli', dir);
          }
        } else { photos.notes.push(`booli-${bp.reason}`); counters.booliMiss++; }
      } catch (e) { photos.notes.push(`booli-err:${e.message}`); counters.booliMiss++; }

      p.photos = photos;
      const galInfo = args.gallery ? ` gallery[h=${photos.hemnet_gallery.length} b=${photos.booli_gallery.length}]` : '';
      const feeInfo = ` fee[h=${(p.hemnet_unit && p.hemnet_unit.fee) ?? '—'} b=${(p.booli_unit && p.booli_unit.rent) ?? '—'}]`;
      log('INFO', `pair ${p.pair_id} [${p.provisional}] hemnet=${photos.hemnet_file ? 'ok' : 'miss'} booli=${photos.booli_file ? 'ok' : 'miss'}${galInfo}${feeInfo}${photos.notes.length ? ' (' + photos.notes.join(',') + ')' : ''}`);
    }
  }

  await Promise.all(Array.from({ length: args.conc }, () => worker()));

  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
  const mdPath = path.join(dir, `PHOTOS-${artifact.meta.cohort_id}.md`);
  fs.writeFileSync(mdPath, renderPhotoMd(artifact, targets));

  log('INFO', `Hemnet photos ${counters.hemnetOk} ok / ${counters.hemnetMiss} miss · Booli photos ${counters.booliOk} ok / ${counters.booliMiss} miss`);
  log('INFO', `Wrote ${mdPath} and ${targets.filter((t) => t.photos && (t.photos.hemnet_file || t.photos.booli_file)).length} pair(s) of images to ${photoDir}`);
  log('INFO', 'NEXT: open the photos/ images in a Claude Code session and confirm same-vs-different property per pair.');
}

function renderPhotoMd(artifact, targets) {
  const order = { suspect: 0, 'low-signal': 1, 'likely-match': 2 };
  const sorted = [...targets].sort((a, b) => (order[a.provisional] - order[b.provisional]) || a.pair_id - b.pair_id);
  const L = [];
  L.push(`# Photo comparison — ${artifact.meta.cohort_id}`);
  L.push('');
  L.push('**Confirmation rule:** a pair is a **CONFIRMED MATCH** only when price agrees AND ≥1 photo is clearly the same place (one shared room or exterior). ' +
    'A **CONFIRMED MISMATCH** needs field divergence (area and/or price) AND no shared photo. Anything else (no photos, or fields agree but no shared shot found) is **UNCERTAIN**. ' +
    'Price alone never confirms a match — two similar units can share an asking price. Booli photos are pulled from the current ad (`/annons/<booli_id>`).');
  L.push('');
  for (const p of sorted) {
    const ph = p.photos || {};
    L.push(`## [${p.provisional}] pair ${p.pair_id} — ${p.street_address}, ${p.municipality} (${p.county})`);
    const usedUrl = (p.photos && p.photos.booli_url_used) || p.booli_url;
    L.push(`Booli ${usedUrl} · Hemnet ${p.hemnet_url}`);
    const priceA = p.deltas.price_pct_diff;
    const priceAgrees = priceA != null ? (priceA <= 0.05 ? `YES (Δ ${(priceA * 100).toFixed(0)}%)` : `NO (Δ ${(priceA * 100).toFixed(0)}%)`) : 'unknown';
    L.push(`Fields: Booli ${p.booli.price ?? '?'} kr / ${p.booli.living_area ?? '?'} m² / ${p.booli.object_type || '?'} · Hemnet ${p.hemnet.asking_price ?? '?'} kr / ${p.hemnet.living_area ?? '?'} m² / ${p.hemnet.housing_form || '?'}`);
    L.push(`Deltas: price agrees **${priceAgrees}** · area Δ ${p.deltas.area_pct_diff == null ? '—' : (p.deltas.area_pct_diff * 100).toFixed(0) + '%'}`);
    L.push('');
    const bCell = ph.booli_file ? `![booli](${ph.booli_file})` : `_(no Booli photo${ph.notes && ph.notes.length ? ': ' + ph.notes.filter((n) => n.startsWith('booli')).join(',') : ''})_`;
    const hCell = ph.hemnet_file ? `![hemnet](${ph.hemnet_file})` : `_(no Hemnet photo${ph.notes && ph.notes.length ? ': ' + ph.notes.filter((n) => n.startsWith('hemnet')).join(',') : ''})_`;
    L.push('| Booli (hero) | Hemnet (hero) |');
    L.push('| --- | --- |');
    L.push(`| ${bCell} | ${hCell} |`);
    L.push('');
    if ((ph.booli_gallery && ph.booli_gallery.length) || (ph.hemnet_gallery && ph.hemnet_gallery.length)) {
      L.push(`Gallery (find ONE matching indoor shot to confirm same property): Booli ${ph.booli_gallery.length} · Hemnet ${ph.hemnet_gallery.length}`);
      L.push('');
      L.push('_Booli:_ ' + (ph.booli_gallery || []).map((g) => `![b](${g.file})`).join(' '));
      L.push('');
      L.push('_Hemnet:_ ' + (ph.hemnet_gallery || []).map((g) => `![h](${g.file})`).join(' '));
      L.push('');
    }
    L.push('**Shared photo found?** ____ (which Booli # ↔ Hemnet #)  →  **VERDICT:** CONFIRMED MATCH / CONFIRMED MISMATCH / UNCERTAIN — ____');
    L.push('');
  }
  return L.join('\n');
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
