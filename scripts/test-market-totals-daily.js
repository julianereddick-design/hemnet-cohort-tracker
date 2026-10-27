// scripts/test-market-totals-daily.js
// Offline test for market-totals-daily.js main()/validate() and
// lib/hemnet-fetch.js parseSearchTotals. No network, no DB.
//
// Hemnet pages are built from REAL ROOT_QUERYs captured 2026-10-26
// (test-fixtures/hemnet-till-salu-rootquery-2026-10-26.json) and wrapped in
// __NEXT_DATA__, so the live extractApolloState path is exercised. Booli pages
// are synthetic App Router flight payloads (Booli parsing is unchanged).
//
// Run: node scripts/test-market-totals-daily.js   (exit 0 = all pass)

'use strict';

const assert = require('assert');
const path = require('path');

// Requiring the job must NOT run it (require.main guard). If it did, runJob
// would try the DB and process.exit before a single test ran.
const job = require('../market-totals-daily');
const { parseSearchTotals, parseSearchIncludes } = require('../lib/hemnet-fetch');

const FIX = require(path.join(__dirname, '..', 'test-fixtures', 'hemnet-till-salu-rootquery-2026-10-26.json'));
const ROOT_ALL_1026  = FIX.pages['https://www.hemnet.se/till-salu'].ROOT_QUERY;
const ROOT_EXCL_1026 = FIX.pages['https://www.hemnet.se/till-salu?upcoming=EXCLUDE'].ROOT_QUERY;

const clone = (o) => JSON.parse(JSON.stringify(o));
// Hemnet added "aggregated":"INCLUDE" to every listings key on ~2026-10-27
// (seen live 2026-10-27 22:20 UTC). Same captured pages, re-keyed to today's shape.
function withAggregated(root) {
  const out = clone(root);
  const search = {};
  for (const [k, v] of Object.entries(out.search)) {
    if (!k.startsWith('listings(')) { search[k] = v; continue; }
    const args = JSON.parse(k.slice('listings('.length, -1));
    args.search = Object.assign({ aggregated: 'INCLUDE' }, args.search);
    search[`listings(${JSON.stringify(args)})`] = v;
  }
  out.search = search;
  return out;
}
const ROOT_ALL  = withAggregated(ROOT_ALL_1026);
const ROOT_EXCL = withAggregated(ROOT_EXCL_1026);
const hemnetHtml = (rootQuery) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    { props: { pageProps: { __APOLLO_STATE__: { ROOT_QUERY: rootQuery } } } })}</script></html>`;
const booliHtml = (totalCount) => {
  const inner = '1:' + JSON.stringify(['$', '$L1e', null, { initialApolloState: { ROOT_QUERY: {
    __typename: 'Query', 'searchForSale({"input":{}})': { totalCount } } } }]);
  return `<html><script>self.__next_f.push([1,${JSON.stringify(inner)}])</script></html>`;
};

// Page map: URL -> html string, or an Error to reject with.
function fakeFetch(pages) {
  return async (url) => {
    const p = pages[url];
    if (p instanceof Error) throw p;
    if (p === undefined) throw new Error(`test: unexpected URL ${url}`);
    return { status: 200, html: p };
  };
}
function livePages(overrides = {}) {
  return Object.assign({
    [job.HEMNET_TILL_SALU_URL]: hemnetHtml(ROOT_EXCL),
    [job.HEMNET_ALL_URL]:       hemnetHtml(ROOT_ALL),
    [job.BOOLI_TILL_SALU_URL]:  booliHtml(59181),
    [job.BOOLI_KOMMANDE_URL]:   booliHtml(29185),
  }, overrides);
}
function fakeClient() {
  const upserts = [];
  return {
    upserts,
    async query(sql, params) {
      if (/INSERT INTO market_totals/.test(sql)) upserts.push(params);
      return { rows: [] };
    },
  };
}
async function run(pages) {
  const client = fakeClient();
  const summary = await job.main(client, () => {}, { getWithRetry: fakeFetch(pages) });
  return { client, summary, validation: job.validate(summary) };
}
const bySeg = (summary) => Object.fromEntries(summary.perRow.map(r => [`${r.site}.${r.segment}`, r.total]));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- parseSearchTotals on the real captured pages ---
test('default /till-salu: kommande 7488 + combined 54885, no forSale', () => {
  assert.deepStrictEqual(parseSearchTotals({ ROOT_QUERY: ROOT_ALL }), { upcoming: 7488, combined: 54885 });
});
test('/till-salu?upcoming=EXCLUDE: forSale 47397 only', () => {
  assert.deepStrictEqual(parseSearchTotals({ ROOT_QUERY: ROOT_EXCL }), { forSale: 47397 });
});
test('captured partition is exact: 47397 + 7488 = 54885', () => {
  assert.strictEqual(47397 + 7488, 54885);
});
test('old pre-2026-10-06 shape yields nothing (no false positive)', () => {
  assert.deepStrictEqual(parseSearchTotals({ ROOT_QUERY: {
    'searchForSaleListings({"input":{}})': { total: 50769 },
    'searchUpcomingListings({"input":{}})': { total: 6676 },
  } }), {});
});
test('regional key (locationSlugs set) is ignored', () => {
  assert.deepStrictEqual(parseSearchTotals({ ROOT_QUERY: { search: {
    'listings({"limit":0,"search":{"locationSlugs":["stockholms-kommun"],"upcoming":"EXCLUDE"}})': { total: 9000 },
  } } }), {});
});
test('unknown narrowing filter is ignored, null-valued extra arg is not', () => {
  assert.deepStrictEqual(parseSearchTotals({ ROOT_QUERY: { search: {
    'listings({"limit":0,"search":{"locationSlugs":null,"priceMax":2000000,"upcoming":"EXCLUDE"}})': { total: 1 },
    'listings({"limit":0,"search":{"locationSlugs":null,"newField":null,"upcoming":"ONLY"}})': { total: 7488 },
  } } }), { upcoming: 7488 });
});
test('search behind an Apollo __ref is resolved', () => {
  assert.deepStrictEqual(parseSearchTotals({
    ROOT_QUERY: { search: { __ref: 'Search:1' } },
    'Search:1': ROOT_EXCL.search,
  }), { forSale: 47397 });
});
test('conflicting totals for one population throw', () => {
  assert.throws(() => parseSearchTotals({ ROOT_QUERY: { search: {
    'listings({"limit":0,"search":{"locationSlugs":null,"upcoming":"ONLY"}})': { total: 7488 },
    'listings({"limit":50,"search":{"locationSlugs":null,"upcoming":"ONLY"}})': { total: 7000 },
  } } }), /conflicting upcoming/);
});
test('INCLUDE args never disqualify a key (2026-10-27 aggregated break)', () => {
  // Before this fix a new "aggregated":"INCLUDE" arg made every key look narrowed,
  // so the job found no totals and failed — the same way it failed on 2026-10-06.
  assert.deepStrictEqual(parseSearchTotals({ ROOT_QUERY: { search: {
    'listings({"limit":0,"search":{"aggregated":"INCLUDE","locationSlugs":null,"minimal":"INCLUDE","someNewKind":"INCLUDE","teaser":"INCLUDE","upcoming":"ONLY"}})': { total: 27434 },
  } } }), { upcoming: 27434 });
});
test('parseSearchIncludes lists the INCLUDE args, sorted', () => {
  assert.deepStrictEqual(parseSearchIncludes({ ROOT_QUERY: ROOT_ALL }), ['aggregated', 'minimal', 'teaser']);
  assert.deepStrictEqual(parseSearchIncludes({ ROOT_QUERY: ROOT_ALL_1026 }), ['minimal', 'teaser']);
  assert.deepStrictEqual(parseSearchIncludes(null), []);
});
// --- scoped totals (used by the age censuses) — real keys seen live 2026-10-27 ---
const SCOPED = { ROOT_QUERY: { search: {
  'listings({"limit":0,"search":{"aggregated":"INCLUDE","locationIds":["18031"],"locationSlugs":null,"minimal":"INCLUDE","teaser":"INCLUDE","upcoming":"EXCLUDE"}})': { total: 3493 },
  'listings({"limit":0,"search":{"aggregated":"INCLUDE","housingFormGroups":["APARTMENTS"],"locationIds":["18031"],"locationSlugs":null,"minimal":"INCLUDE","priceMax":4000000,"priceMin":3000000,"teaser":"INCLUDE","upcoming":"EXCLUDE"}})': { total: 399 },
  'listings({"limit":0,"search":{"aggregated":"INCLUDE","locationSlugs":null,"minimal":"INCLUDE","teaser":"INCLUDE","upcoming":"EXCLUDE"}})': { total: 62844 },
} } };
test('scope picks exactly the matching narrowed key', () => {
  assert.deepStrictEqual(parseSearchTotals(SCOPED), { forSale: 62844 }, 'default scope = nationwide only');
  assert.deepStrictEqual(parseSearchTotals(SCOPED, { locationIds: ['18031'] }), { forSale: 3493 });
  assert.deepStrictEqual(parseSearchTotals(SCOPED, {
    locationIds: ['18031'], housingFormGroups: ['APARTMENTS'], priceMin: 3000000, priceMax: 4000000,
  }), { forSale: 399 });
});
test('scope must match exactly: a subset or a different value matches nothing', () => {
  assert.deepStrictEqual(parseSearchTotals(SCOPED, { locationIds: ['18031'], priceMin: 3000000 }), {});
  assert.deepStrictEqual(parseSearchTotals(SCOPED, { locationIds: ['17866'] }), {});
  assert.deepStrictEqual(parseSearchTotals(SCOPED, { locationIds: '18031' }), {}, 'string is not the array Hemnet uses');
});
test('missing / malformed state returns {}', () => {
  assert.deepStrictEqual(parseSearchTotals(null), {});
  assert.deepStrictEqual(parseSearchTotals({ ROOT_QUERY: { search: 'x' } }), {});
});

// --- main() + validate() ---
test('happy path: 4 rows, correct values + source URLs, no alert', async () => {
  const { client, summary, validation } = await run(livePages());
  assert.strictEqual(summary.rowsWritten, 4);
  assert.strictEqual(client.upserts.length, 4);
  assert.deepStrictEqual(bySeg(summary), {
    'hemnet.till_salu': 47397, 'hemnet.kommande': 7488,
    'booli.till_salu': 59181, 'booli.kommande': 29185,
  });
  const urls = Object.fromEntries(summary.perRow.map(r => [`${r.site}.${r.segment}`, r.source_url]));
  assert.strictEqual(urls['hemnet.till_salu'], 'https://www.hemnet.se/till-salu?upcoming=EXCLUDE');
  assert.strictEqual(urls['hemnet.kommande'], 'https://www.hemnet.se/till-salu');
  assert.deepStrictEqual(summary.siteErrors, []);
  assert.strictEqual(summary.hemnetPartition.diff, 0);
  assert.deepStrictEqual(summary.hemnetIncludes, ['aggregated', 'minimal', 'teaser']);
  assert.strictEqual(validation, null);
});
test('Hemnet changes the kinds of listing counted: rows written, plain warning', async () => {
  // The 26 Oct pages lack "aggregated": exactly what the day before the break looked like.
  const { summary, validation } = await run(livePages({
    [job.HEMNET_TILL_SALU_URL]: hemnetHtml(ROOT_EXCL_1026), [job.HEMNET_ALL_URL]: hemnetHtml(ROOT_ALL_1026) }));
  assert.strictEqual(summary.rowsWritten, 4, 'a definition change must not cost the day');
  assert.strictEqual(validation.key, 'hemnet-listing-types-changed');
  assert.strictEqual(validation.severity, 'warning');
  assert.ok(/no longer including: aggregated/.test(validation.message), validation.message);
  // and a brand-new kind is named
  const added = (root) => { const r = clone(root); for (const k of Object.keys(r.search)) {
    if (!k.startsWith('listings(')) continue; const v = r.search[k]; delete r.search[k];
    r.search[k.replace('"aggregated":"INCLUDE"', '"aggregated":"INCLUDE","projects":"INCLUDE"')] = v; } return r; };
  const v2 = (await run(livePages({
    [job.HEMNET_TILL_SALU_URL]: hemnetHtml(added(ROOT_EXCL)), [job.HEMNET_ALL_URL]: hemnetHtml(added(ROOT_ALL)) }))).validation;
  assert.ok(/now also including: projects/.test(v2.message), v2.message);
});
test('Hemnet on the OLD shape: Booli rows still written, run is a failure', async () => {
  const old = hemnetHtml({ 'searchForSaleListings({})': { total: 1 } });
  const { client, summary, validation } = await run(livePages({
    [job.HEMNET_TILL_SALU_URL]: old, [job.HEMNET_ALL_URL]: old }));
  assert.strictEqual(summary.rowsWritten, 2);
  assert.deepStrictEqual(client.upserts.map(p => p[0]), ['booli', 'booli']);
  assert.strictEqual(validation.severity, 'failure');
  assert.strictEqual(validation.key, 'site-failed:hemnet');
  assert.match(validation.message, /hemnet\.till_salu/);
});
test('Hemnet fetch rejects: Booli still written, failure', async () => {
  const { summary, validation } = await run(livePages({ [job.HEMNET_ALL_URL]: new Error('timeout') }));
  assert.strictEqual(summary.rowsWritten, 2);
  assert.strictEqual(validation.key, 'site-failed:hemnet');
  assert.match(validation.message, /hemnet \(all\): fetch failed — timeout/);
});
test('Booli breaks: Hemnet still written, failure keyed to booli', async () => {
  const { client, summary, validation } = await run(livePages({ [job.BOOLI_KOMMANDE_URL]: booliHtml(0) }));
  assert.strictEqual(summary.rowsWritten, 2);
  assert.deepStrictEqual(client.upserts.map(p => p[0]), ['hemnet', 'hemnet']);
  assert.strictEqual(validation.key, 'site-failed:booli');
});
test('both sites break: 0 rows, one combined failure key', async () => {
  const { summary, validation } = await run(livePages({
    [job.HEMNET_TILL_SALU_URL]: new Error('x'), [job.BOOLI_TILL_SALU_URL]: new Error('y') }));
  assert.strictEqual(summary.rowsWritten, 0);
  assert.strictEqual(validation.key, 'site-failed:booli+hemnet');
  assert.strictEqual(validation.severity, 'failure');
});
test('partition mismatch: rows still written, warning', async () => {
  const bad = clone(ROOT_EXCL);
  for (const k of Object.keys(bad.search)) if (bad.search[k].total) bad.search[k].total = 40000;
  const { summary, validation } = await run(livePages({ [job.HEMNET_TILL_SALU_URL]: hemnetHtml(bad) }));
  assert.strictEqual(summary.rowsWritten, 4);
  assert.strictEqual(summary.hemnetPartition.diff, 54885 - (40000 + 7488));
  assert.strictEqual(validation.key, 'hemnet-partition-mismatch');
  assert.strictEqual(validation.severity, 'warning');
});
test('small drift between the two pages is tolerated', async () => {
  const drift = clone(ROOT_EXCL);
  for (const k of Object.keys(drift.search)) if (drift.search[k].total) drift.search[k].total = 47397 + 40;
  const { summary, validation } = await run(livePages({ [job.HEMNET_TILL_SALU_URL]: hemnetHtml(drift) }));
  assert.strictEqual(summary.hemnetPartition.ok, true);
  assert.strictEqual(validation, null);
});
test('swapping the URLs is caught (default page has no forSale)', async () => {
  const { validation } = await run(livePages({ [job.HEMNET_TILL_SALU_URL]: hemnetHtml(ROOT_ALL) }));
  assert.strictEqual(validation.key, 'site-failed:hemnet');
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log(`  ok: ${t.name}`); }
    catch (e) { fail++; console.error(`  FAIL: ${t.name} — ${e.message}`); }
  }
  console.log(fail === 0 ? `PASS: ${pass}/${pass}` : `FAIL: ${fail} of ${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
