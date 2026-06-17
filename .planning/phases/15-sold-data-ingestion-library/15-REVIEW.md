---
phase: 15-sold-data-ingestion-library
reviewed: 2026-06-17T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - lib/scrape-http.js
  - lib/sold-addr.js
  - lib/sold-config.js
  - lib/sold-fetch-booli.js
  - lib/sold-fetch-hemnet.js
  - lib/sold-parse.js
  - lib/sold-transport.js
  - scripts/booli-sold.js
  - scripts/hemnet-sold.js
  - scripts/sold-recon.js
findings:
  critical: 1
  warning: 7
  info: 4
  total: 12
status: issues_found
---

# Phase 15: Code Review Report

**Reviewed:** 2026-06-17
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Phase 15 lifts the validated Booli-sold → Hemnet-sold matching spike into reusable `lib/` modules behind thin CLI wrappers. Overall the refactor is clean: the spend-guard architecture (load-time throw in `sold-transport.js`, persisted global ceiling, `assertOxyUsed` transport check, recon-doc approval marker for `--detail-scope all`) is coherent and the inline smoke tests are thorough. The surgical ~8-line addition to the shared `lib/scrape-http.js` (CONFIG-03 sleep-before-retry on 613-class transient errors) is confirmed purely additive against `d159b01^` and does **not** regress existing for-sale callers — it only inserts a 3s delay before an already-existing retry on the Oxylabs fallback path.

However, the review surfaced one BLOCKER in the spend-ceiling accounting (a race window that lets concurrent fetches over-spend the Oxylabs budget the entire module is built to protect), plus several correctness/robustness warnings concentrated in the early-stop / resume / ceiling-drain logic that is the stated focus of this phase. No injection or credential-leak vulnerabilities were found; URL params are `encodeURIComponent`-wrapped or `URLSearchParams`-built, and Oxylabs credentials are read from env and never logged.

## Critical Issues

### CR-01: Spend-ceiling counter has a read-modify-write race that can overshoot the Oxylabs budget

**File:** `lib/sold-transport.js:90-101`
**Issue:** `cachedFetch` enforces the global spend ceiling with a non-atomic read-modify-write against `_spend.json`:

```js
const spend = loadSpend();                 // read
if (spend.liveCalls >= MAX_OXY_CALLS) { throw new CeilingError(...); }
spend.liveCalls += 1;                       // modify (in memory)
saveSpend(spend);                           // write
```

The whole pipeline is `async`. Two concurrent `cachedFetch` calls (e.g. the apartment fee-window flow can issue a list-page fetch and a detail fetch, and Phase 16/17 explicitly intend to drive `fetchBooliSoldPage`/`searchSold` concurrently) will both `loadSpend()` the same value, both pass the check, and both write `liveCalls = N+1` — losing one increment. Across many interleavings the persisted counter under-counts real spend, so the ceiling that the entire module exists to enforce can be silently overshot. Because `saveSpend` is also a full-file overwrite, a second process (rerun launched in parallel) reading the file mid-write can clobber it entirely. This defeats the core spend-safety guarantee in a phase whose stated concern is "correctness of the Oxylabs spend-ceiling accounting."

**Fix:** Serialize the increment, or make it crash-safe and append-only. Minimum: gate `cachedFetch`'s live-call section behind an in-process async mutex so only one read-modify-write of `_spend.json` is in flight at a time:

```js
let _spendLock = Promise.resolve();
function withSpendLock(fn) {
  const run = _spendLock.then(fn, fn);
  _spendLock = run.then(() => {}, () => {});
  return run;
}
// in cachedFetch, replace the load/check/increment/save block:
await withSpendLock(() => {
  const spend = loadSpend();
  if (spend.liveCalls >= MAX_OXY_CALLS) {
    throw new CeilingError(`Oxylabs ceiling reached: ${spend.liveCalls}/${MAX_OXY_CALLS} live calls`);
  }
  spend.liveCalls += 1;
  saveSpend(spend);
});
```

For cross-process safety (parallel reruns), additionally use an atomic write (`fs.writeFileSync(tmp); fs.renameSync(tmp, SPEND_FILE)`) or an exclusive lock file. At minimum, document that only one process may run at a time and enforce it with a lock file, since the current code is advertised as "shared across every stage/rerun."

## Warnings

### WR-01: `extractApollo` throws on a 200 page with no `__NEXT_DATA__`, aborting an entire Hemnet record search

**File:** `lib/sold-fetch-hemnet.js:98-120` (and `lib/sold-transport.js:120-125`)
**Issue:** `searchSold` calls `extractApollo(res.html)` with no try/catch. `extractApollo` → `extractNextData` **throws** (`scrape-http: __NEXT_DATA__ script tag not found` or a `JSON.parse` SyntaxError) when a 200 response lacks the tag (Cloudflare interstitial that still returns 200, an A/B HTML variant, a truncated body, etc.). That throw is not a `CeilingError`, so `searchSoldPaged` re-throws it (line 165), which bubbles to `hemnet-sold.js` and marks the **whole Booli record** as `error` — even though earlier pages may have already collected candidates (they are discarded). Compare with `fetchBooliSoldPage`/`fetchBooliSold`, which both wrap `extractApollo` in try/catch and degrade gracefully.

**Fix:** Wrap the parse in `searchSold` and treat a parse failure like a non-200 (cache `[]` and continue):

```js
const res = await cachedFetch(url, { logger: function () {} });
if (res.status !== 200) { searchCache.set(url, []); return []; }
let cards = [];
try {
  const { apollo } = extractApollo(res.html);
  cards = parseHemnetSaleCards(apollo);
} catch (_) { /* unparseable 200 → treat as no cards */ }
searchCache.set(url, cards);
return cards;
```

### WR-02: `searchSoldPaged` early-stop #4 only inspects the current page's oldest card and can stop one page too early — or never

**File:** `lib/sold-fetch-hemnet.js:188-193`
**Issue:** Two distinct correctness concerns in the sold-date window early-stop:

1. `Math.min(...cards.map((c) => c.sold_at != null ? c.sold_at : Infinity))` returns `Infinity` if **every** card on the page has a null `sold_at`, so the window check `oldest < bUnix - windowDays*DAY` is never true and pagination continues to `maxPages` regardless of how far past the window the feed has gone. The opposite failure (a single very-old card with a valid `sold_at` mixed into an otherwise in-window page) trips the stop and discards the rest of that page's still-relevant cards from being matched on a later page. Hemnet `/salda` is sorted by sold date, so the *first* card, not the page minimum, is the right signal.
2. The window is one-sided (`oldest < bUnix - window`). A Booli sale dated *after* the Hemnet results (Hemnet posting lag) is never windowed out on the upper side; harmless here but worth noting the asymmetry is intentional vs accidental.

**Fix:** Use the last card on the (date-sorted) page and guard the all-null case:

```js
const last = cards[cards.length - 1];
if (bUnix != null && last.sold_at != null && last.sold_at < bUnix - windowDays * DAY) {
  complete = true;
  break;
}
```

### WR-03: `pages` returned by `searchSoldPaged` is off-by-one / overcounts on early-stop

**File:** `lib/sold-fetch-hemnet.js:147-196`
**Issue:** The loop is `for (; page <= maxPages; page++)` and returns `pages: page`. When the loop completes all `maxPages` iterations, `page` ends at `maxPages + 1`, so the reported `pages` is one too high. When it `break`s on a ceiling-floor guard (line 151) *before* fetching, `page` reflects a page that was never fetched. The `hemnet-sold.js` output logs this `pages` value into the candidates JSONL (`pages,`), so downstream accounting of "how many pages were walked" is wrong. `fetchBooliSold` has the same class of issue with `pagesWalked: page - 1` when it stops via ceiling before incrementing `page`.

**Fix:** Track a separate `pagesFetched` counter incremented only after a successful fetch, and return that instead of the loop index.

### WR-04: `booli-sold.js` parses argv twice; a second parse of `--target`/`--market-target` etc. is silently discarded

**File:** `scripts/booli-sold.js:74-85`
**Issue:** `main()` calls `parseArgs(process.argv.slice(2))` to destructure most options, then on line 85 calls `parseArgs(process.argv.slice(2))` **again** solely to read `maxSoldDate`. Besides being wasteful, this is a latent bug magnet: the first destructure deliberately omits `maxSoldDate` (so it isn't shadowed), and any future edit that adds `maxSoldDate` to the first destructure will create a confusing dual source of truth. It also means the `target`/`maxPages` parsed in the first call and the `maxSoldDate` parsed in the second can diverge if `parseArgs` ever becomes non-deterministic.

**Fix:** Parse once and reuse:

```js
const opts = parseArgs(process.argv.slice(2));
const { segment, target, marketTarget, maxPages, minSoldDate, detailScope } = opts;
const maxSoldDate = opts.maxSoldDate || daysAgoISO(READ_TIME_EXCLUDE_DAYS);
```

### WR-05: Numeric CLI flags are not validated; `NaN` silently disables ceilings/targets

**File:** `scripts/booli-sold.js:58-63`, `scripts/hemnet-sold.js:27-29`
**Issue:** `parseInt(argv[++i], 10)` for `--target`, `--market-target`, `--max-pages`, `--window-days` is never checked for `NaN`. A typo like `--max-pages abc` yields `NaN`. In `fetchBooliSold`, `page <= maxPages` with `maxPages = NaN` is always `false`, so the loop never runs (silent no-op fetch). `--target NaN` makes `collected >= target` always `false`, so the run only stops on page/empty/ceiling conditions — potentially burning far more Oxylabs budget than the operator intended in a phase explicitly about spend safety.

**Fix:** Validate each numeric flag after parse and exit non-zero on `NaN`/negative, e.g.:

```js
if (!Number.isInteger(o.maxPages) || o.maxPages <= 0) { /* error + process.exit(1) */ }
```

### WR-06: `marketTarget || null` / `target` summary fields lose the value `0`

**File:** `lib/sold-fetch-booli.js:344` (and `:338` `minSoldDate || null`)
**Issue:** `marketTarget: marketTarget || null` coerces a legitimate `marketTarget = 0` to `null` in the summary. Same pattern means a `--market-target 0` (collect zero market rows — a valid "title-transfer accounting only" run) is mis-reported. The `reached()` guard at line 192 correctly uses `marketTarget != null`, so the *behavior* is right, but the *summary* misrepresents the config. Minor, but the summary JSON is the audit record for spend.

**Fix:** Use `marketTarget != null ? marketTarget : null` for the summary field (consistent with the guard logic).

### WR-07: Detail-fetch error inside the card loop can leave a record marked market-collected without its detail, and `detailErrors` accounting diverges from reality

**File:** `lib/sold-fetch-booli.js:271-316`
**Issue:** On a non-Ceiling detail error (line 289), `detailErrors++` is incremented and the loop falls through to append the **card-only** record (`detail` stays null, enrichment fields stay null). That is acceptable degradation, but note: `detailFetches++` (line 277) is incremented *after* the `await fetchBooliDetail` resolves, so a `fetchBooliDetail` that returns `null` for a non-200/parse-fail (it swallows those and returns null rather than throwing) counts as a successful `detailFetch` with no data and is **not** counted in `detailErrors`. The summary therefore overstates successful detail enrichment. For a spend/coverage audit this conflates "fetched and got data" with "fetched, got nothing."

**Fix:** Distinguish the three outcomes explicitly — increment `detailFetches` only when `detail` is non-null, and add a `detailEmpty` counter for the null-return case, or have `fetchBooliDetail` signal why it returned null.

## Info

### IN-01: `parseSweNum` strips `.` as a thousands separator, corrupting any period-decimal value

**File:** `lib/sold-parse.js:18-20`
**Issue:** The regex character class `[\d\s  .]*` consumes `.` as a thousands separator and the decimal branch only handles `,\d+`. A value like `"42.5 m²"` becomes `"425"`. This is intentional for Swedish formatting (comma decimals, space/dot thousands) and is asserted in smoke tests, but it is a silent data-corruption trap if any upstream field ever arrives period-decimal (e.g. a JSON-numeric coordinate accidentally routed through it). Worth a one-line comment hardening the assumption, or restricting the dot to only run between digit groups.

### IN-02: `extractResidenceId` returns a string id while card `booli_id` may be numeric — dedup keys are normalized but residence ids are not type-consistent

**File:** `lib/sold-fetch-booli.js:139-143`, `lib/sold-parse.js:68`
**Issue:** `booli_id` comes through as `card.booliId || card.id` (numeric in fixtures) and is `String()`-normalized for the `seen` Set (good). `extractResidenceId` returns the regex capture (always a string). These feed different consumers, but the inconsistency (`booli_id` numeric in the JSONL, residence id string) is a latent foot-gun for Phase 16 DB inserts expecting stable types. Consider normalizing `booli_id` to a string at parse time.

### IN-03: `sold-recon.js` runs `main()` unconditionally (no `require.main` guard)

**File:** `scripts/sold-recon.js:289`
**Issue:** Unlike `booli-sold.js` and `hemnet-sold.js`, this script calls `main()` at top level without an `if (require.main === module)` guard. Requiring this file for any reason (test harness, tooling) would trigger live recon fetches and `process.exit`. Low risk since it's a CLI, but inconsistent with its siblings.

**Fix:** Wrap in `if (require.main === module) { main().catch(...); }`.

### IN-04: `curlOnce` temp-file uses `process.pid` + random but never bounds concurrent file count; `getWithRetry` non-retryable detection is string-fragile

**File:** `lib/scrape-http.js:350`
**Issue (pre-existing, not introduced by Phase 15):** The non-retryable re-throw at line 350 matches on `err.message.includes('returned ')` and excludes `'returned 5'` / `'returned 429'` via string matching. A target URL containing the literal substring `returned 5` would be misclassified. This is pre-existing shared-transport code outside Phase 15's surgical change and is flagged only for awareness; no action required for this phase.

---

_Reviewed: 2026-06-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
