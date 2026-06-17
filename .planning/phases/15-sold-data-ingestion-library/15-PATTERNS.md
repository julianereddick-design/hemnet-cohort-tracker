# Phase 15: Sold-data ingestion library - Pattern Map

**Mapped:** 2026-06-17
**Files analyzed:** 8 (6 spike sources to productionize + 2 existing lib analogues)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `lib/sold-parse.js` | utility/parser | transform | `scripts/spike-sold-parse.js` | lift-as-is (exact) |
| `lib/sold-fetch-booli.js` | service | CRUD/paginated | `scripts/spike-booli-sold.js` + `lib/booli-fetch.js` | role-match |
| `lib/sold-fetch-hemnet.js` | service | CRUD/paginated | `scripts/spike-hemnet-match.js` + `lib/hemnet-fetch.js` | role-match |
| `lib/sold-config.js` | config | transform | `scripts/spike-config.js` | lift-as-is (exact) |
| `lib/sold-transport.js` | utility | request-response | `scripts/spike-common.js` | lift-as-is (exact) |
| `lib/scrape-http.js` | utility | request-response | `lib/scrape-http.js` | extend-in-place |
| `scripts/booli-sold.js` (CLI wrapper) | utility/CLI | CRUD | `scripts/spike-booli-sold.js` | thin wrapper |
| `scripts/hemnet-sold.js` (CLI wrapper) | utility/CLI | CRUD | `scripts/spike-hemnet-match.js` | thin wrapper |
| `scripts/sold-recon.js` (CLI wrapper) | utility/CLI | request-response | `scripts/spike-sold-recon.js` | extend in place |

---

## Pattern Assignments

### `lib/sold-parse.js` (utility/parser, transform)

**Source to lift:** `scripts/spike-sold-parse.js` (lines 1–162) — lift nearly verbatim; only dependency change is `require('./sold-config')` instead of `require('./spike-config')`.

**Imports pattern** (`scripts/spike-sold-parse.js` lines 1–7):
```javascript
'use strict';
const { isTitleTransfer } = require('./spike-config');
```
Becomes:
```javascript
'use strict';
const { isTitleTransfer } = require('./sold-config');
```

**Apollo state key scanning pattern** (lines 39–43 — the `startsWith` key scan used by all three node extractors):
```javascript
function booliSoldNode(apollo) {
  const rq = (apollo && apollo.ROOT_QUERY) || {};
  const k = Object.keys(rq).find((k) => k.startsWith('searchSold(') && rq[k] && Array.isArray(rq[k].result));
  return k ? rq[k] : null;
}
```
This pattern mirrors `lib/booli-fetch.js` lines 210–218 (`searchForSale` key scan) and `lib/hemnet-fetch.js` (similar scan for `searchSales`). Use the same `startsWith` idiom — do not change to an exact-key lookup.

**displayAttributes key scan** (lines 25–29 — Booli's parameterised key):
```javascript
function booliDisplayDataPoints(card) {
  const key = Object.keys(card).find((k) => k.startsWith('displayAttributes('));
  const da = key ? card[key] : null;
  const pts = (da && Array.isArray(da.dataPoints)) ? da.dataPoints : [];
  return pts.map((p) => (p && p.value && p.value.plainText) || '').filter(Boolean);
}
```

**Card parser output shape** (lines 50–81 — snake_case, DB-friendly):
```javascript
out.push({
  booli_id: card.booliId || card.id,
  residence_url: card.url || null,        // "/bostad/<residenceId>"
  street_address: card.streetAddress || null,
  object_type: card.objectType || null,
  sold_price: card.soldPrice && card.soldPrice.raw != null ? card.soldPrice.raw : null,
  sold_date: card.soldDate || null,
  sold_price_type: card.soldPriceType || null,
  is_title_transfer: isTitleTransfer(card.soldPriceType),
  municipality: muni || null,
  descriptive_area: card.descriptiveAreaName || null,
  living_area: livingPt ? parseSweNum(livingPt) : null,
  rooms: roomsPt ? parseSweNum(roomsPt) : null,
  floor: floorPt ? parseSweNum(floorPt) : null,
  lat: card.latitude != null ? card.latitude : null,
  long: card.longitude != null ? card.longitude : null,
});
```
These snake_case field names are the **Phase 16 DB schema contract** — do not rename them during the lift.

**Detail parser** (lines 83–108 — fee/broker enrichment, apartment-only):
```javascript
function parseBooliSoldDetail(apollo) {
  const sp = Object.values(apollo || {}).find((v) => v && v.__typename === 'SoldProperty');
  if (!sp) return null;
  const raw = (x) => (x && x.raw != null ? x.raw : null);
  return {
    booli_id: sp.booliId || sp.id || null,
    residence_id: sp.residenceId || null,
    rent: raw(sp.rent),           // monthly fee (apartments)
    operating_cost: raw(sp.operatingCost),
    living_area: raw(sp.livingArea),
    additional_area: raw(sp.additionalArea),
    plot_area: raw(sp.plotArea),
    rooms: raw(sp.rooms),
    construction_year: sp.constructionYear != null ? sp.constructionYear : null,
    agent_id: sp.agentId || null,
    agency_id: sp.agencyId || null,
    object_type: sp.objectType || null,
    sold_price: raw(sp.soldPrice),
    sold_price_type: sp.soldPriceType || null,
    tenure_form: sp.tenureForm || null,
  };
}
```

**Hemnet SaleCard parser** (lines 122–153):
```javascript
function parseHemnetSaleCards(apollo) {
  const node = hemnetSalesNode(apollo);
  if (!node) return [];
  const out = [];
  for (const ref of node.cards) {
    const c = ref && ref.__ref ? apollo[ref.__ref] : null;
    if (!c || c.__typename !== 'SaleCard') continue;
    const soldAt = c.soldAt != null ? Math.floor(parseFloat(c.soldAt)) : null;
    out.push({
      card_id: c.id || null,
      listing_id: c.listingId || null,
      slug: c.slug || null,
      detail_url: c.slug ? `https://www.hemnet.se/salda/${c.slug}` : null,
      street_address: c.streetAddress || null,
      sold_at: Number.isFinite(soldAt) ? soldAt : null,
      sold_at_label: c.soldAtLabel || null,
      asking_price: parseSweNum(c.askingPrice),
      final_price: parseSweNum(c.finalPrice),
      living_area: parseSweNum(c.livingArea),
      rooms: parseSweNum(c.rooms),
      fee: parseSweNum(c.fee),
      housing_form: (c.housingForm && (c.housingForm.name || c.housingForm.symbol)) || null,
      location_description: c.locationDescription || null,
      broker_name: c.brokerName || null,
      broker_agency: c.brokerAgencyName || null,
      lat: c.coordinates && c.coordinates.lat != null ? c.coordinates.lat : null,
      long: c.coordinates && c.coordinates.long != null ? c.coordinates.long : null,
    });
  }
  return out;
}
```

**Module exports** (lines 155–162):
```javascript
module.exports = {
  parseSweNum,
  parseBooliSoldCards,
  parseBooliSoldDetail,
  booliSoldMeta,
  parseHemnetSaleCards,
  hemnetSalesMeta,
};
```

**Smoke test pattern:** Follow `lib/booli-fetch.js` lines 336–534 — inline `if (require.main === module && process.argv.includes('--smoke'))` block with `assert`-based checks covering: empty apollo returns `[]`, card fields extracted correctly including `is_title_transfer` flag, `parseSweNum` edge cases, `parseBooliSoldDetail` returns `null` on missing `SoldProperty`, `parseHemnetSaleCards` slug-to-URL construction.

---

### `lib/sold-config.js` (config, transform)

**Source to lift:** `scripts/spike-config.js` (lines 1–69) — lift verbatim; no dependency changes needed (no requires).

**Segments constant** (lines 10–23):
```javascript
const SEGMENTS = {
  'stockholm-apt': {
    label: 'Stockholm apartments',
    family: 'APARTMENT',
    booli: { areaIds: 1, objectType: 'Lägenhet' },
    hemnet: { locationId: 18031, itemType: 'bostadsratt' },
  },
  'taby-villa': {
    label: 'Täby houses',
    family: 'HOUSE',
    booli: { areaIds: 20, objectType: 'Hus' },
    hemnet: { locationId: 17793, itemType: null },
  },
};
```

**`isTitleTransfer` + `MARKET_SOLD_TYPES`** (lines 28–34):
```javascript
const MARKET_SOLD_TYPES = new Set(['Slutpris', 'Sista bud']);
function isTitleTransfer(soldPriceType) {
  if (soldPriceType == null) return false; // unknown → treat as market (conservative; keep)
  return !MARKET_SOLD_TYPES.has(soldPriceType);
}
```

**`daysAgoISO` helper** (lines 52–56):
```javascript
function daysAgoISO(n, fromISO) {
  const base = fromISO ? new Date(`${fromISO}T00:00:00Z`) : new Date();
  return new Date(base.getTime() - n * 86400000).toISOString().slice(0, 10);
}
```

**Module exports** (lines 58–69):
```javascript
module.exports = {
  SEGMENTS,
  MARKET_SOLD_TYPES,
  isTitleTransfer,
  PRICE_AGREE_PCT,
  AREA_AGREE_PCT,
  PRICE_BAND,
  SOLD_DATE_WINDOW_DAYS,
  READ_TIME_EXCLUDE_DAYS,
  DEFAULT_TARGET_PER_SEGMENT,
  daysAgoISO,
};
```

---

### `lib/sold-transport.js` (utility, request-response)

**Source to lift:** `scripts/spike-common.js` (lines 1–192) — lift with path and env-var adjustments.

**Env-guard pattern** (lines 22–26 — must come BEFORE `require('../lib/scrape-http')`):
```javascript
if (process.env.SCRAPE_FORCE_OXYLABS !== '1' && process.env.HEMNET_FORCE_OXYLABS !== '1') {
  throw new Error(
    'sold-transport: SCRAPE_FORCE_OXYLABS must be set to "1" BEFORE requiring this module',
  );
}
```
This is an invariant — sold pages (both Booli and Hemnet) are 100% Oxylabs only. Keep the guard.

**Shared transport import** (lines 28–33):
```javascript
const {
  getWithRetry,
  extractNextData,
  getOxylabsStats,
} = require('./scrape-http');  // was '../lib/scrape-http' in spike
```

**Configurable root path** (lines 38–43 — `SPIKE_DIR` env for manual override, default to `verf-soldspike`):
```javascript
const ROOT = path.join(__dirname, '..', process.env.SPIKE_DIR || 'verf-soldspike');
const CACHE_DIR = path.join(ROOT, 'cache');
const SPEND_FILE = path.join(CACHE_DIR, '_spend.json');
const MAX_OXY_CALLS = parseInt(process.env.MAX_OXY_CALLS || '4000', 10);
```
Phase 15 keeps the file-based spend tally (D-07). Phase 16 moves it to the DB.

**`CeilingError` class** (lines 50–52):
```javascript
class CeilingError extends Error {
  constructor(msg) { super(msg); this.code = 'OXY_CEILING'; }
}
```
Callers catch `CeilingError` to drain workers gracefully — see `spike-hemnet-match.js` lines 299–301.

**`cachedFetch` function** (lines 75–116 — the core ceiling-enforced fetch):
```javascript
async function cachedFetch(url, opts = {}) {
  const log = opts.logger || noop;
  const key = cacheKey(url);
  const htmlFile = path.join(CACHE_DIR, key + '.html');
  const metaFile = path.join(CACHE_DIR, key + '.json');

  if (fs.existsSync(metaFile)) {
    _proc.cacheHits++;
    // ... read from cache, return { status, html, fromCache: true, url }
  }

  const spend = loadSpend();
  if (spend.liveCalls >= MAX_OXY_CALLS) {
    throw new CeilingError(`Oxylabs ceiling reached: ${spend.liveCalls}/${MAX_OXY_CALLS} live calls`);
  }
  // Count BEFORE issuing (a forced attempt consumes credits whether it succeeds or not)
  spend.liveCalls += 1;
  saveSpend(spend);
  _proc.live++;

  let res;
  try {
    res = await getWithRetry(url, { logger: opts.scrapeLog || noop });
  } catch (e) {
    _proc.fails++;
    throw e;
  }
  // write html + meta to cache, return { status, html, fromCache: false, url }
}
```

**`extractApollo` wrapper** (lines 119–125 — wraps `extractNextData` to pull `__APOLLO_STATE__`):
```javascript
function extractApollo(html) {
  const nextData = extractNextData(html);
  const pp = nextData && nextData.props && nextData.props.pageProps;
  const apollo = (pp && pp.__APOLLO_STATE__) || null;
  return { nextData, apollo };
}
```

**`assertOxyUsed` guard** (lines 128–140):
```javascript
function assertOxyUsed() {
  if (_proc.live === 0) return { ok: true, skipped: true, ..._proc };
  const s = getOxylabsStats();
  if (s.directSuccessCount > 0) {
    throw new Error(`transport-assert: ${s.directSuccessCount} direct-curl successes — NOT forced through Oxylabs`);
  }
  if (s.oxylabsCallCount === 0) {
    throw new Error('transport-assert: live fetches happened but oxylabsCallCount===0');
  }
  return { ok: true, oxylabsCallCount: s.oxylabsCallCount, ..._proc };
}
```

**JSONL helpers** (lines 147–163):
```javascript
function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) { return []; }
}
```

**Module exports** (lines 172–192 — expose everything callers need):
```javascript
module.exports = {
  ROOT, CACHE_DIR, MAX_OXY_CALLS,
  CeilingError, cachedFetch, extractApollo, extractNextData,
  assertOxyUsed, procStats, spentCalls, remainingCalls, getOxylabsStats,
  ensureDir, tsSlug, writeJson, readJson, appendJsonl, readJsonl, stdoutLogger,
};
```

---

### `lib/sold-fetch-booli.js` (service, CRUD/paginated)

**Primary source:** `scripts/spike-booli-sold.js` (lines 45–137 — `scrapeSegment` function).
**Convention reference:** `lib/booli-fetch.js` lines 250–282 (`fetchBooliSearch` — same `getWithRetry` → `extractNextData` → parse pattern; same `opts.logger` convention).

**Imports pattern** (follows `lib/booli-fetch.js` line 19):
```javascript
'use strict';
const { cachedFetch, extractApollo, appendJsonl, readJsonl,
        writeJson, assertOxyUsed, procStats, CeilingError,
        stdoutLogger, ensureDir, ROOT } = require('./sold-transport');
const { SEGMENTS, DEFAULT_TARGET_PER_SEGMENT, READ_TIME_EXCLUDE_DAYS,
        daysAgoISO } = require('./sold-config');
const { parseBooliSoldCards, booliSoldMeta } = require('./sold-parse');
```

**Paginated fetch with sold-date early-stop and idempotent resume** (spike lines 45–117):
```javascript
async function fetchBooliSold(segKey, seg, opts = {}) {
  // opts: target, marketTarget, maxPages, maxSoldDate, minSoldDate, logger
  const seedFile = path.join(SEED_DIR, `${segKey}.jsonl`);
  const existing = readJsonl(seedFile);
  const seen = new Set(existing.map((r) => String(r.booli_id)));
  let collected = existing.length;
  let marketCollected = existing.filter((r) => !r.is_title_transfer).length;
  const reached = () => (marketTarget != null ? marketCollected >= marketTarget : collected >= target);

  const { areaIds, objectType } = seg.booli;
  let page = 1;
  while (!reached() && page <= maxPages) {
    const dateParams = `&maxSoldDate=${maxSoldDate}` + (minSoldDate ? `&minSoldDate=${minSoldDate}` : '');
    const url = `https://www.booli.se/slutpriser?areaIds=${areaIds}&objectType=${encodeURIComponent(objectType)}${dateParams}&page=${page}`;
    let res;
    try {
      res = await cachedFetch(url, { logger: log });
    } catch (e) {
      if (e instanceof CeilingError) { stop = 'ceiling'; break; }
      log('ERROR', `page ${page} fetch failed: ${e.message}`); page++; continue;
    }
    if (res.status !== 200) { stop = `status-${res.status}`; break; }
    let apollo;
    try { ({ apollo } = extractApollo(res.html)); }
    catch (e) { page++; continue; }
    const meta = booliSoldMeta(apollo);
    const cards = parseBooliSoldCards(apollo);
    if (cards.length === 0) { stop = 'empty-page'; break; }
    for (const c of cards) {
      const id = String(c.booli_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      appendJsonl(seedFile, { ...c, segment: segKey, family: seg.family, scraped_at: new Date().toISOString() });
      collected++;
      if (!c.is_title_transfer) marketCollected++;
      if (reached()) break;
    }
    page++;
  }
  // return summary object (see spike lines 99–116)
}
```

**Key points for the lib version:**
- Accept `opts` object instead of positional args (matches `lib/booli-fetch.js` convention).
- Default `maxSoldDate` = `daysAgoISO(READ_TIME_EXCLUDE_DAYS)` when not supplied.
- Export both `fetchBooliSold` (the paginated fetch that writes JSONL) and a lower-level `fetchBooliSoldPage` (single-page, returns `{ cards, meta }`) for Phase 16 to call without JSONL.
- Detail fetch (`/bostad/<residenceId>`) for enrichment stays in this module per D-01: only triggered for apartments within the fee window.

---

### `lib/sold-fetch-hemnet.js` (service, CRUD/paginated)

**Primary source:** `scripts/spike-hemnet-match.js` (lines 64–160 — `normAddr`, `buildHemnetSoldUrl`, `searchSoldPaged`, `addrCandidates`).
**Convention reference:** `lib/hemnet-fetch.js` lines 1–17 (same imports pattern) and the cohort search pattern in `hemnet-targeted-match.js` (narrowed per-property search → paginate → early-stop on address found or window exceeded).

**`normAddr` v2 — the MATCH-02 address normalizer** (spike lines 64–75):
```javascript
function normAddr(s) {
  if (s == null) return null;
  // Split on comma, slash, and " och " — handles Hemnet floor suffix ("Rindögatan 28, 3 tr"),
  // dual-corner addresses ("X 10 / Y 6"), and "58 och 58A"
  let t = String(s).split(',')[0].split('/')[0].split(/\s+och\s+/i)[0];
  t = normStreet(t);              // from lib/spotcheck-evidence: lowercase, trim, collapse whitespace
  if (t == null) return null;
  // Merge space between house number and trailing unit letter:
  // "norrskensvägen 1 c" -> "norrskensvägen 1c", "vasavägen 21 e" -> "21e"
  t = t.replace(/(\d+)\s+([a-zåäö])(?=\s|$)/g, '$1$2');
  return t;
}
```
This is MATCH-02 — move it verbatim into `lib/sold-fetch-hemnet.js` (or a shared `lib/sold-addr.js` if unit tests want to import it separately without pulling in the fetcher). Add `--smoke` unit tests for each recovered format: `"norrskensvägen 1 c"` → `"norrskensvägen 1c"`, `"Rindögatan 28, 3 tr"` → `"rindögatan 28"`, `"X 10 / Y 6"` → `"x 10"`, `"58 och 58A"` → `"58"`.

**URL builder** (spike lines 78–103):
```javascript
function buildHemnetSoldUrl(booli, seg, opts = {}) {
  const p = new URLSearchParams();
  p.append('location_ids[]', String(seg.hemnet.locationId));
  const band = opts.priceBand != null ? opts.priceBand : PRICE_BAND;
  if (booli.sold_price != null && Number.isFinite(Number(booli.sold_price))) {
    const v = Number(booli.sold_price);
    p.append('price_min', String(Math.floor(v * (1 - band))));
    p.append('price_max', String(Math.ceil(v * (1 + band))));
  }
  // rooms filter (tight for apartments; dropped for houses via opts.dropRooms)
  // living_area band (opts.areaBand, default 0.07)
  // item_types[] — APARTMENT: seg.hemnet.itemType; HOUSE: booliObjectTypeToHemnet(booli.object_type)
  return `https://www.hemnet.se/salda?${p.toString()}`;
}
```

**Paginated per-property search** (spike lines 132–150 — the `searchSoldPaged` function):
```javascript
async function searchSoldPaged(booli, seg, windowDays, maxPages, opts = {}) {
  const baseUrl = buildHemnetSoldUrl(booli, seg, opts);
  const bUnix = booliSoldUnix(booli.sold_date);
  const bAddr = normAddr(booli.street_address);
  const all = [];
  let complete = false;
  let page = 1;
  for (; page <= maxPages; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
    const cards = await searchSold(url);  // within-run deduplicated fetch
    if (cards.length === 0) { complete = true; break; }
    all.push(...cards);
    if (cards.some((c) => normAddr(c.street_address) === bAddr)) { complete = true; break; }
    if (cards.length < 50) { complete = true; break; }   // last page within filters
    const oldest = Math.min(...cards.map((c) => (c.sold_at != null ? c.sold_at : Infinity)));
    if (bUnix != null && oldest < bUnix - windowDays * DAY) { complete = true; break; }
  }
  return { cards: all, pages: page, complete };
}
```

**Within-run search cache** (spike lines 107–124 — deduplicates concurrent searches for the same URL):
```javascript
const searchCache = new Map();
const searchInFlight = new Map();
async function searchSold(url) {
  if (searchCache.has(url)) return searchCache.get(url);
  if (searchInFlight.has(url)) return searchInFlight.get(url);
  const promise = (async () => {
    try {
      const res = await cachedFetch(url, { logger: () => {} });
      if (res.status !== 200) { searchCache.set(url, []); return []; }
      const { apollo } = extractApollo(res.html);
      const cards = parseHemnetSaleCards(apollo);
      searchCache.set(url, cards);
      return cards;
    } finally { searchInFlight.delete(url); }
  })();
  searchInFlight.set(url, promise);
  return promise;
}
```

**House vs apartment search opts** (spike lines 191–194 — critical match-rate design):
```javascript
const searchOpts = seg.family === 'HOUSE'
  ? { priceBand: 0.10, areaBand: 0.15, dropRooms: true, dropItemType: true }
  : {};  // apartments: tight (rooms+area+item_type under the 50-cap)
```

**Export surface:**
```javascript
module.exports = {
  normAddr,
  buildHemnetSoldUrl,
  searchSoldPaged,
  addrCandidates,
};
```

---

### `lib/scrape-http.js` — 613 retry extension (extend in place)

**Current state:** `getWithRetry` (lines 290–387) retries 403/429/5xx from the direct curl path and falls back to Oxylabs. Oxylabs 613 (credit limit / temporary block) is a transient Oxylabs-API error that currently propagates as an unhandled `OXYLABS_TARGET_NON_200` or `OXYLABS_API_NON_200` error.

**Extension needed (CONFIG-03):** In `fallbackViaOxylabs` (lines 203–233), after the first Oxylabs attempt fails with code `OXYLABS_TARGET_NON_200` and the target status is 613 (or in a 6xx range Oxylabs uses for internal signals), the existing 1-retry already catches this. Verify by checking: does the 613 come back as `result.status_code === 613` (which becomes `OXYLABS_TARGET_NON_200`)? If so, the retry in `fallbackViaOxylabs` already covers it. If 613 surfaces differently (e.g., as an HTTP 429 from the Oxylabs API itself), extend the retry with a 2–5 second sleep before the second attempt.

**Pattern to extend** (lines 203–233 — add sleep before retry):
```javascript
async function fallbackViaOxylabs(targetUrl, opts, lastStatus) {
  // ... attempt 1 ...
  } catch (e1) {
    const reason1 = (e1 && e1.code) || 'unknown';
    // NEW: if this is a 613/transient, sleep before retry
    const isTransient613 = reason1 === 'OXYLABS_TARGET_NON_200' || reason1 === 'OXYLABS_API_NON_200';
    if (isTransient613) await sleep(3000);
    // ... attempt 2 (existing) ...
  }
}
```
Do NOT change the module's public API — `getWithRetry`, `extractNextData`, `getOxylabsStats`, `resetOxylabsStats` stay unchanged.

---

### CLI wrapper: `scripts/booli-sold.js`

**Source:** `scripts/spike-booli-sold.js` — the `main()` function (lines 119–137) becomes a thin CLI entry point that calls `lib/sold-fetch-booli.js`.

**Pattern** (from spike lines 119–137):
```javascript
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();
// require lib/sold-fetch-booli (not spike modules)
async function main() {
  const { segment, target, marketTarget, maxPages, minSoldDate } = parseArgs(process.argv.slice(2));
  const maxSoldDate = parseArgs(process.argv.slice(2)).maxSoldDate || daysAgoISO(READ_TIME_EXCLUDE_DAYS);
  const segKeys = segment ? [segment] : Object.keys(SEGMENTS);
  for (const k of segKeys) {
    const seg = SEGMENTS[k];
    if (!seg) { log('ERROR', `unknown segment ${k}`); continue; }
    await fetchBooliSold(k, seg, { target, marketTarget, maxPages, maxSoldDate, minSoldDate, logger: log });
  }
  try { log('INFO', `transport-assert: ${JSON.stringify(assertOxyUsed())}`); }
  catch (e) { log('ERROR', `transport-assert FAILED: ${e.message}`); process.exitCode = 2; }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
```

**Key convention:** `process.env.SCRAPE_FORCE_OXYLABS = '1'` MUST be the first statement, before any requires. This is enforced by the env-guard in `lib/sold-transport.js`.

---

### CLI wrapper: `scripts/hemnet-sold.js`

**Source:** `scripts/spike-hemnet-match.js` `main()` (lines 332–351) — thin wrapper calling `lib/sold-fetch-hemnet.js`. Stage 3 recall logic (`recallOne`) stays in the lib as an exported function.

**CLI convention** (spike line 349 — `require.main === module` guard for library dual-use):
```javascript
module.exports = { buildHemnetSoldUrl, addrCandidates, deltasFor, matchOne, recallOne };
if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}
```
Follow this exact pattern in all CLI wrappers to keep them both directly runnable AND importable.

---

### CLI wrapper / extended recon: `scripts/sold-recon.js`

**Source:** `scripts/spike-sold-recon.js` — lift the full file verbatim as the new `scripts/sold-recon.js`, then extend the keyword scan (D-04) to include "sold in advance" signals:

**`keywordScan` keywords to extend** (current list at spike lines 128–133):
```javascript
summary.transferScan = keywordScan(apollo, [
  'lagfart', 'gåva', 'gava', 'arv', 'byte', 'källa', 'kalla', 'source',
  'slutpris', 'soldprice', 'sold', 'mäklare', 'maklare', 'broker', 'agent',
  'transfer', 'priceType', 'saleType', 'såld', 'sald',
  // ADD for D-04 "sold in advance" recon:
  'förhand', 'forhand', 'advance', 'pre-market', 'premarket',
  'before viewing', 'innan visning', 'visning', 'kommande', 'upcoming',
  'presale', 'pre-sale', 'förköp', 'forköp',
]);
```

---

## Shared Patterns

### Transport guard: SCRAPE_FORCE_OXYLABS must precede all requires
**Source:** `scripts/spike-common.js` lines 22–26, echoed in all spike entry points (e.g. `spike-booli-sold.js` line 11).
**Apply to:** All CLI wrappers (`scripts/booli-sold.js`, `scripts/hemnet-sold.js`, `scripts/sold-recon.js`) and any future orchestrator scripts.
```javascript
process.env.SCRAPE_FORCE_OXYLABS = '1';  // MUST be first statement
require('dotenv').config();
// Now safe to require lib/sold-transport (which validates the flag at load time)
```

### `assertOxyUsed()` at end of every run
**Source:** `scripts/spike-booli-sold.js` lines 133–134, `spike-hemnet-match.js` lines 343–344.
**Apply to:** All CLI wrappers and the Phase 17 orchestrator.
```javascript
try { log('INFO', `transport-assert: ${JSON.stringify(assertOxyUsed())}`); }
catch (e) { log('ERROR', `transport-assert FAILED: ${e.message}`); process.exitCode = 2; }
```

### Apollo extraction: `extractNextData` → `pageProps.__APOLLO_STATE__`
**Source:** `scripts/spike-common.js` lines 119–125 (`extractApollo`), which wraps `lib/scrape-http.js` `extractNextData`.
**Apply to:** Both fetch modules (`lib/sold-fetch-booli.js`, `lib/sold-fetch-hemnet.js`).
```javascript
function extractApollo(html) {
  const nextData = extractNextData(html);  // from lib/scrape-http
  const pp = nextData && nextData.props && nextData.props.pageProps;
  const apollo = (pp && pp.__APOLLO_STATE__) || null;
  return { nextData, apollo };
}
```
This is the project-wide idiom (used since Phase 6). Do not re-implement; import from `lib/sold-transport`.

### `normStreet` dependency: import from `lib/spotcheck-evidence`
**Source:** `scripts/spike-hemnet-match.js` line 31.
```javascript
const { normStreet, computeDeltas, pctDiff } = require('../lib/spotcheck-evidence');
```
`normAddr` v2 in `lib/sold-fetch-hemnet.js` calls `normStreet` for the base normalization (lowercase, trim, collapse whitespace). Do not inline `normStreet` — keep the import to stay in sync with the cohort spot-check's normalization.

### CeilingError draining pattern (concurrent workers)
**Source:** `scripts/spike-hemnet-match.js` lines 298–314.
**Apply to:** `lib/sold-fetch-hemnet.js` when used with concurrency (the Phase 17 orchestrator).
```javascript
if (remainingCalls() <= 40) { stopped = 'ceiling-floor'; return; }  // drain before hard ceiling
// ...
} catch (e) {
  if (e instanceof CeilingError) { stopped = 'ceiling'; return; }  // propagate cleanly
  appendJsonl(resultsFile, { booli_id: booli.booli_id, verdict: 'ERROR', reason: String(e.message) });
}
```

### Snake_case output shape
**Source:** `scripts/spike-sold-parse.js` (all field names in `parseBooliSoldCards` and `parseHemnetSaleCards`).
**Apply to:** All parsers and any enrichment passes. These names are the Phase 16 DB column contract. Do not camelCase during the lift (unlike the for-sale modules in `lib/booli-fetch.js` which use camelCase for the cohort-tracker DB columns).

### `--smoke` self-test block
**Source:** `lib/booli-fetch.js` lines 336–535.
**Apply to:** `lib/sold-parse.js`, `lib/sold-config.js`, `lib/sold-fetch-hemnet.js` (for `normAddr` unit tests).
```javascript
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0; let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  // ... inline assertions ...
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
```

### `stdoutLogger` tag pattern
**Source:** `scripts/spike-common.js` lines 165–170.
**Apply to:** All lib modules that accept an `opts.logger` parameter and all CLI wrappers.
```javascript
function stdoutLogger(tag) {
  return (level, msg) => {
    if (msg === undefined) { msg = level; level = 'INFO'; }
    console.log(`[${tag}] ${level} ${msg}`);
  };
}
// Usage in CLI wrapper:
const log = stdoutLogger('booli-sold');
```

---

## No Analog Found

None. All Phase 15 files have direct source material in the spike scripts or established lib patterns.

---

## Metadata

**Analog search scope:** `scripts/spike-*.js`, `lib/scrape-http.js`, `lib/booli-fetch.js`, `lib/hemnet-fetch.js`, `lib/booli-to-hemnet-mapping.js`, `lib/spotcheck-evidence.js`
**Files scanned:** 9
**Pattern extraction date:** 2026-06-17

### Key cleanup notes for planner (D-06)

During the spike-to-lib move, the following should be reviewed and cleaned:

1. **`spike-selfcheck.js`** — pure offline self-verification script; review whether it belongs as `scripts/sold-selfcheck.js` or can be subsumed into the `--smoke` blocks.
2. **`spike-report.js`** — reporting/analysis script; not a Phase 15 deliverable (no lib logic). Retain as `scripts/sold-report.js` (thin wrapper over `lib/sold-config.js` + JSONL readers) OR defer to Phase 17 when match verdicts have a DB home.
3. **Dead scaffolding in spike scripts:** `spike-booli-sold.js` `parseArgs` function can be deleted (CLI arg parsing moves to the thin wrapper). `spike-hemnet-match.js` `parseArgs` similarly. These are spike-only entry-point concerns, not lib logic.
4. **`verf-soldspike/` directory:** Keep as-is — the `cache/` subdirectory serves as the shared fetch cache for Phase 15's CLI wrappers.
