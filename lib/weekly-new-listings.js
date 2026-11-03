'use strict';
// lib/weekly-new-listings.js — weekly NEW pre-owned listings on Hemnet, for Glenn's MASTER
// workbook (DATA MASTER\WEEKLY PROPERTIES). Table: migrate-weekly-new-listings.js.
// Job: weekly-new-listings.js (Mondays).
//
// The workbook was built from hemnet.se/statistik/nytillkomna (pre-owned, weekly; total =
// all market states, for sale = FOR_SALE, pre-market = total − for sale) for Sweden,
// Stockholms län and Västra Götalands län. From wk 19 Oct 2026 that page also counts free
// (MINIMAL) and aggregated ads, so from then on the workbook series is PAID new listings
// counted from our own ad registry (lib/ad-registry.js):
//
//   NEW ad in week W  = an ad id created that week. Hemnet ids are sequential; renewing or
//                       upgrading an ad resets its publish date but keeps its id. So W's new
//                       ids lie between the highest id published before W and the highest
//                       id published before W+1 (aggregated ads excluded from the boundary:
//                       they carry the agency's old publish date).
//   pre-owned         = not new construction, not an NC_* project, no project id.
//   total / for sale  = by the tier the ad was first seen in (for sale vs coming soon).
//   PAID              = the ad was ever seen with a paid package (BASIC/PLUS/PREMIUM/MAX),
//                       plus "upgrades": older free/aggregated ads first seen paid that week.
//
// Every week our count of ALL new ads (paid + free + aggregated) is compared with Hemnet's
// own public figure, which still counts everything: that is the check that the method works.
//
//   node lib/weekly-new-listings.js --smoke

const { muniMatches } = require('./ad-registry');
const { PAID_PACKAGES } = require('./listing-segment');

// Paid-only counting starts with the first full week the daily new-ads walk covered (its
// first run, 2026-11-03 04:36 UTC, read back to Mon 2 Nov 00:00 Swedish time).
const COVERAGE_START = '2026-11-02';
// First week Hemnet's nytillkomna counts free / aggregated ads; the last clean one is 12 Oct.
const SERIES_BREAK = '2026-10-19';
// Our count of all new ads vs Hemnet's own: beyond this the post flags it.
const CHECK_TOLERANCE = 0.05;

const AREAS = ['sweden', 'stockholm', 'vg'];
const STATS_LOCATION = { sweden: 17691, stockholm: 17744, vg: 17755 };
const AREA_LABEL = { sweden: 'Sweden', stockholm: 'Stockholm', vg: 'VG', rest: 'Rest of Sweden' };

// Kommuner per län (26 + 49). Hemnet writes them in the genitive ("Stockholms kommun");
// muniMatches allows the trailing s.
const STOCKHOLM_KOMMUNER = ['Botkyrka', 'Danderyd', 'Ekerö', 'Haninge', 'Huddinge', 'Järfälla', 'Lidingö',
  'Nacka', 'Norrtälje', 'Nykvarn', 'Nynäshamn', 'Salem', 'Sigtuna', 'Sollentuna', 'Solna', 'Stockholm',
  'Sundbyberg', 'Södertälje', 'Tyresö', 'Täby', 'Upplands Väsby', 'Upplands-Bro', 'Vallentuna', 'Vaxholm',
  'Värmdö', 'Österåker'];
const VG_KOMMUNER = ['Ale', 'Alingsås', 'Bengtsfors', 'Bollebygd', 'Borås', 'Dals-Ed', 'Essunga', 'Falköping',
  'Färgelanda', 'Grästorp', 'Gullspång', 'Göteborg', 'Götene', 'Herrljunga', 'Hjo', 'Härryda', 'Karlsborg',
  'Kungälv', 'Lerum', 'Lidköping', 'Lilla Edet', 'Lysekil', 'Mariestad', 'Mark', 'Mellerud', 'Munkedal',
  'Mölndal', 'Orust', 'Partille', 'Skara', 'Skövde', 'Sotenäs', 'Stenungsund', 'Strömstad', 'Svenljunga',
  'Tanum', 'Tibro', 'Tidaholm', 'Tjörn', 'Tranemo', 'Trollhättan', 'Töreboda', 'Uddevalla', 'Ulricehamn',
  'Vara', 'Vårgårda', 'Vänersborg', 'Åmål', 'Öckerö'];

// 'stockholm' | 'vg' | null (null = rest of Sweden)
function countyOf(kommun) {
  if (!kommun) return null;
  if (STOCKHOLM_KOMMUNER.some(k => muniMatches(kommun, k))) return 'stockholm';
  if (VG_KOMMUNER.some(k => muniMatches(kommun, k))) return 'vg';
  return null;
}

// ---- dates (weeks are keyed by their Monday, 'YYYY-MM-DD') ----
const DAY_MS = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}
// Today's date in Sweden.
function swedishToday(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const lastCompleteWeek = (now = new Date()) => addDays(mondayOf(swedishToday(now)), -7);

// ---- Hemnet's public statistics ----
function statsUrl(area, market) {
  const p = new URLSearchParams({
    resolution: 'WEEK', marketState: market === 'fs' ? 'FOR_SALE' : 'ALL',
    successionType: 'PRE_OWNED', locationId: String(STATS_LOCATION[area]),
  });
  return `https://www.hemnet.se/statistik/nytillkomna?${p.toString()}`;
}

// The page embeds the chart's data and the filter it applied. Returns [{ week_start, value }],
// or throws when the filter Hemnet applied is not the one asked for (never a wrong series).
function parseStatsPage(html, area, market) {
  const raw = String(html).split(String.fromCharCode(92)).join('');
  const iv = raw.indexOf('"initialValues"');
  if (iv < 0) throw new Error('stats page: no initialValues');
  const init = raw.slice(iv, iv + 400);
  const want = {
    resolution: 'WEEK', marketState: market === 'fs' ? 'FOR_SALE' : 'ALL',
    successionType: 'PRE_OWNED', locationId: String(STATS_LOCATION[area]),
  };
  for (const [k, v] of Object.entries(want)) {
    if (!init.includes(`"${k}":"${v}"`)) throw new Error(`stats page: ${k} not applied as ${v} (${area}/${market})`);
  }
  const out = [];
  for (const m of raw.matchAll(/"recordedAt":"(\d+)(?:\.\d+)?","value":(\d+)/g)) {
    // recordedAt = Monday 00:00 Swedish time, as UTC (Sunday 22:00/23:00); +12h lands on Monday.
    out.push({ week_start: new Date(Number(m[1]) * 1000 + DAY_MS / 2).toISOString().slice(0, 10), value: Number(m[2]) });
  }
  if (out.length < 52) throw new Error(`stats page: only ${out.length} weekly points (${area}/${market})`);
  return out;
}

async function fetchHemnetPublic(fetchHtml) {
  const rows = [];
  for (const area of AREAS) for (const market of ['tot', 'fs']) {
    const res = await fetchHtml(statsUrl(area, market));
    if (res.status !== 200) throw new Error(`stats page ${area}/${market}: HTTP ${res.status}`);
    for (const p of parseStatsPage(res.html, area, market)) rows.push({ ...p, area, market });
  }
  return rows;
}

// ---- our count from the ad registry ----
const FIRST_SIGHT = `
  SELECT DISTINCT ON (h.hemnet_id) h.hemnet_id, h.tier, h.package, h.published_at
    FROM hemnet_ad_package_history h ORDER BY h.hemnet_id, h.seen_on, h.id`;
const SWEDISH_MIDNIGHT = (p) => `((${p}::date)::timestamp AT TIME ZONE 'Europe/Stockholm')`;

// Highest ad id published before the start of a week (Swedish midnight).
async function idBoundary(client, weekStart) {
  const r = await client.query(
    `WITH f AS (${FIRST_SIGHT})
     SELECT max(hemnet_id)::text AS id FROM f
      WHERE package IS DISTINCT FROM 'AGGREGATED' AND published_at < ${SWEDISH_MIDNIGHT('$1')}`, [weekStart]);
  return r.rows[0].id;
}

const emptyCounts = () => Object.fromEntries(AREAS.map(a => [a, { tot: 0, fs: 0 }]));
function bump(counts, kommun, tier) {
  const county = countyOf(kommun);
  for (const a of ['sweden', county].filter(Boolean)) {
    counts[a].tot++;
    if (tier === 'forsale') counts[a].fs++;
  }
}

const PRE_OWNED = `NOT COALESCE(r.new_construction, false) AND r.ad_class <> 'newbuild' AND r.project_id IS NULL`;

// { all, paid, upgrades, lo, hi } for the week starting weekStart. Counts are per area,
// { tot, fs }. Reads only; needs ads published up to the end of the week to be in the
// registry (run after Monday's daily walk).
async function registryWeek(client, weekStart) {
  const lo = await idBoundary(client, weekStart);
  const hi = await idBoundary(client, addDays(weekStart, 7));
  const out = { all: emptyCounts(), paid: emptyCounts(), upgrades: emptyCounts(), lo, hi };
  if (lo == null || hi == null) return out;
  const ads = await client.query(
    `WITH f AS (${FIRST_SIGHT})
     SELECT r.kommun, f.tier, r.packages_seen
       FROM hemnet_ad_registry r JOIN f USING (hemnet_id)
      WHERE r.hemnet_id > $1::bigint AND r.hemnet_id <= $2::bigint AND ${PRE_OWNED}`, [lo, hi]);
  for (const a of ads.rows) {
    bump(out.all, a.kommun, a.tier);
    if ((a.packages_seen || []).some(p => PAID_PACKAGES.has(p))) bump(out.paid, a.kommun, a.tier);
  }
  const paid = [...PAID_PACKAGES];
  const up = await client.query(
    `SELECT DISTINCT ON (h.hemnet_id) r.kommun, h.tier
       FROM hemnet_ad_package_history h JOIN hemnet_ad_registry r USING (hemnet_id)
      WHERE h.seen_on >= $1::date AND h.seen_on < $2::date
        AND h.prior_package IS NOT NULL AND h.package = ANY($3::text[]) AND NOT (h.prior_package = ANY($3::text[]))
        AND h.hemnet_id <= $4::bigint AND ${PRE_OWNED}
      ORDER BY h.hemnet_id, h.seen_on`, [weekStart, addDays(weekStart, 7), paid, lo]);
  for (const u of up.rows) bump(out.upgrades, u.kommun, u.tier);
  return out;
}

// ---- the workbook's own figures (Dashboard rows 9–29) from a series ----
// series: Map(`${area}|${market}`) -> Map(week_start -> value), market tot | fs.
function valueOf(series, area, market, week) {
  if (area === 'rest') {
    const s = valueOf(series, 'sweden', market, week), a = valueOf(series, 'stockholm', market, week), b = valueOf(series, 'vg', market, week);
    return s == null || a == null || b == null ? null : s - a - b;
  }
  if (market === 'pm') {
    const t = valueOf(series, area, 'tot', week), f = valueOf(series, area, 'fs', week);
    return t == null || f == null ? null : t - f;
  }
  const m = series.get(`${area}|${market}`);
  const v = m ? m.get(week) : undefined;
  return v == null ? null : v;
}
function sumWeeks(series, area, market, week, fromBack, toBack) {
  let s = 0;
  for (let k = fromBack; k >= toBack; k--) {
    const v = valueOf(series, area, market, addDays(week, -7 * k));
    if (v == null) return null;
    s += v;
  }
  return s;
}
const ratio = (a, b) => (a == null || b == null || b === 0 ? null : a / b - 1);

function metricsFor(series, area, market, week) {
  return {
    value: valueOf(series, area, market, week),
    yoy: ratio(valueOf(series, area, market, week), valueOf(series, area, market, addDays(week, -364))),
    yoy4: ratio(sumWeeks(series, area, market, week, 3, 0), sumWeeks(series, area, market, week, 55, 52)),
    stack2: ratio(valueOf(series, area, market, week), valueOf(series, area, market, addDays(week, -728))),
    stack2_4: ratio(sumWeeks(series, area, market, week, 3, 0), sumWeeks(series, area, market, week, 107, 104)),
  };
}
function pmShare(series, area, week) {
  const pm = valueOf(series, area, 'pm', week), t = valueOf(series, area, 'tot', week);
  return pm == null || !t ? null : pm / t;
}

const pct = (x) => (x == null ? 'n/a' : `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(1)}%`);
function fmtDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// The three "Slack draft" lines of the workbook's Dashboard, word for word.
function dashboardLines(series, week) {
  const block = (label, market) => {
    const m = Object.fromEntries(['sweden', 'stockholm', 'vg', 'rest'].map(a => [a, metricsFor(series, a, market, week)]));
    return `${label}, wk starting ${fmtDay(week)}: Sweden ${pct(m.sweden.yoy)} YoY (${pct(m.sweden.yoy4)} last 4wks)` +
      ` | Stockholm ${pct(m.stockholm.yoy)} (${pct(m.stockholm.yoy4)}) | VG ${pct(m.vg.yoy)} (${pct(m.vg.yoy4)})` +
      ` | Rest of Sweden ${pct(m.rest.yoy)} (${pct(m.rest.yoy4)}). 2yr stack Sweden ${pct(m.sweden.stack2)} (${pct(m.sweden.stack2_4)} last 4wks).`;
  };
  const share = pmShare(series, 'sweden', week);
  const sharePrior = pmShare(series, 'sweden', addDays(week, -364));
  const pts = share == null || sharePrior == null ? null : (share - sharePrior) * 100;
  return [
    block('Total', 'tot'),
    block('For sale', 'fs'),
    block('Pre-market', 'pm') + ` PM share of supply ${share == null ? 'n/a' : `${(share * 100).toFixed(1)}%`}` +
      ` (${pts == null ? 'n/a' : `${pts >= 0 ? '+' : '-'}${Math.abs(pts).toFixed(1)}`}pts YoY).`,
  ];
}

// rows: [{ week_start, area, market, value }] -> series Map for the functions above.
function toSeries(rows) {
  const s = new Map();
  for (const r of rows) {
    const k = `${r.area}|${r.market}`;
    if (!s.has(k)) s.set(k, new Map());
    s.get(k).set(typeof r.week_start === 'string' ? r.week_start : r.week_start.toISOString().slice(0, 10), Number(r.value));
  }
  return s;
}

// Wide CSV of the master series: one row per week, the workbook's six raw columns.
const CSV_COLUMNS = ['week_start', 'sweden_tot', 'stockholm_tot', 'vg_tot', 'sweden_fs', 'stockholm_fs', 'vg_fs', 'is_estimate', 'source'];
function toCsv(rows) {
  const byWeek = new Map();
  for (const r of rows) {
    const w = typeof r.week_start === 'string' ? r.week_start : r.week_start.toISOString().slice(0, 10);
    if (!byWeek.has(w)) byWeek.set(w, { week_start: w, is_estimate: false, source: '' });
    const o = byWeek.get(w);
    o[`${r.area}_${r.market}`] = r.value;
    if (r.is_estimate) o.is_estimate = true;
    if (r.note) o.source = r.note;
  }
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [CSV_COLUMNS.join(',')];
  for (const w of [...byWeek.keys()].sort()) {
    const o = byWeek.get(w);
    lines.push(CSV_COLUMNS.map(c => esc(o[c] == null ? '' : o[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  COVERAGE_START, SERIES_BREAK, CHECK_TOLERANCE, AREAS, AREA_LABEL, STATS_LOCATION,
  countyOf, addDays, mondayOf, swedishToday, lastCompleteWeek, statsUrl, parseStatsPage, fetchHemnetPublic,
  idBoundary, registryWeek, valueOf, metricsFor, pmShare, dashboardLines, toSeries, toCsv, CSV_COLUMNS, pct,
};

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  check('countyOf: genitive kommun names, both counties, rest is null', () => {
    assert.strictEqual(countyOf('Stockholms'), 'stockholm');
    assert.strictEqual(countyOf('Upplands Väsby'), 'stockholm');
    assert.strictEqual(countyOf('Göteborgs'), 'vg');
    assert.strictEqual(countyOf('Alingsås'), 'vg');
    assert.strictEqual(countyOf('Dals-Eds'), 'vg');
    assert.strictEqual(countyOf('Malmö'), null);
    assert.strictEqual(countyOf(null), null);
    assert.strictEqual(STOCKHOLM_KOMMUNER.length, 26);
    assert.strictEqual(VG_KOMMUNER.length, 49);
  });
  check('dates: Monday of a week, last complete week in Swedish time', () => {
    assert.strictEqual(mondayOf('2026-11-08'), '2026-11-02');
    assert.strictEqual(mondayOf('2026-11-09'), '2026-11-09');
    assert.strictEqual(lastCompleteWeek(new Date('2026-11-09T06:15:00Z')), '2026-11-02');
    assert.strictEqual(lastCompleteWeek(new Date('2026-11-08T23:30:00Z')), '2026-11-02', 'Mon 00:30 in Sweden already');
  });
  check('parseStatsPage: reads weeks onto Mondays and refuses an unapplied filter', () => {
    // Mon 14 Sep 2026 00:00 Swedish time = Sun 13 Sep 22:00 UTC, as Hemnet records it.
    const first = Date.UTC(2026, 8, 13, 22) / 1000;
    const pts = Array.from({ length: 60 }, (_, i) => `{"__typename":"TimedValue","recordedAt":"${first + i * 604800}.0","value":${100 + i}}`).join(',');
    const page = (ms) => `x "initialValues":{"metric":"PUBLISHED_LISTINGS","resolution":"WEEK","filter":{"marketState":"${ms}","type":"ALL","locationId":"17691","rooms":"ALL","successionType":"PRE_OWNED"}} ${pts}`;
    const r = parseStatsPage(page('ALL'), 'sweden', 'tot');
    assert.strictEqual(r.length, 60);
    assert.strictEqual(r[0].week_start, '2026-09-14');
    assert.strictEqual(r[0].value, 100);
    assert.throws(() => parseStatsPage(page('ALL'), 'sweden', 'fs'), /marketState/);
  });
  // A small series with two years of history, to check the Dashboard maths.
  const rows = [];
  const weeks = Array.from({ length: 120 }, (_, i) => addDays('2024-08-12', 7 * i));
  for (const [i, w] of weeks.entries()) {
    rows.push({ week_start: w, area: 'sweden', market: 'tot', value: 1000 + i });
    rows.push({ week_start: w, area: 'sweden', market: 'fs', value: 700 + i });
    rows.push({ week_start: w, area: 'stockholm', market: 'tot', value: 300 });
    rows.push({ week_start: w, area: 'stockholm', market: 'fs', value: 200 });
    rows.push({ week_start: w, area: 'vg', market: 'tot', value: 100 });
    rows.push({ week_start: w, area: 'vg', market: 'fs', value: 80 });
  }
  const series = toSeries(rows);
  const last = weeks[weeks.length - 1];
  check('metricsFor: week, last 4 weeks and 2-year comparisons like the Dashboard', () => {
    const m = metricsFor(series, 'sweden', 'tot', last);
    assert.strictEqual(m.value, 1119);
    assert.ok(Math.abs(m.yoy - (1119 / 1067 - 1)) < 1e-12);
    assert.ok(Math.abs(m.yoy4 - ((1116 + 1117 + 1118 + 1119) / (1064 + 1065 + 1066 + 1067) - 1)) < 1e-12);
    assert.ok(Math.abs(m.stack2 - (1119 / 1015 - 1)) < 1e-12);
    assert.strictEqual(valueOf(series, 'rest', 'tot', last), 1119 - 300 - 100);
    assert.strictEqual(valueOf(series, 'stockholm', 'pm', last), 100);
    assert.strictEqual(metricsFor(series, 'sweden', 'tot', weeks[10]).yoy, null, 'no prior year → n/a');
  });
  check('dashboardLines: the three Slack draft lines, Dashboard wording', () => {
    const [t, f, p] = dashboardLines(series, last);
    assert.match(t, /^Total, wk starting \d+ \w{3} 2026: Sweden [+-]\d+\.\d% YoY \([+-]\d+\.\d% last 4wks\) \| Stockholm \+0\.0% \(\+0\.0%\) \| VG \+0\.0%/);
    assert.match(f, /^For sale, wk starting/);
    assert.match(p, /PM share of supply 26\.8% \([+-]\d+\.\dpts YoY\)\.$/);
  });
  check('toCsv: one row per week, the workbook raw columns, estimates flagged', () => {
    const csv = toCsv([
      { week_start: '2026-10-19', area: 'sweden', market: 'tot', value: 2500, is_estimate: true, note: 'estimate' },
      { week_start: '2026-10-19', area: 'sweden', market: 'fs', value: 1700, is_estimate: true },
      { week_start: '2026-10-12', area: 'sweden', market: 'tot', value: 2134 },
    ]).trim().split('\n');
    assert.strictEqual(csv[0], CSV_COLUMNS.join(','));
    assert.strictEqual(csv[1], '2026-10-12,2134,,,,,,false,');
    assert.strictEqual(csv[2], '2026-10-19,2500,,,1700,,,true,estimate');
  });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}
