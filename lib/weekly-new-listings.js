'use strict';
// lib/weekly-new-listings.js — weekly NEW pre-owned listings on Hemnet, for Glenn's MASTER
// workbook (DATA MASTER\WEEKLY PROPERTIES). Table: migrate-weekly-new-listings.js.
// Job: weekly-new-listings.js (Mondays).
//
// The workbook was built from hemnet.se/statistik/nytillkomna (pre-owned, weekly; total =
// all market states, for sale = FOR_SALE, pre-market = total − for sale) for Sweden,
// Stockholms län and Västra Götalands län. Until Hemnet's free tier (20 Oct 2026) every ad
// was paid. From wk 19 Oct that page also counts free (MINIMAL) and copied (AGGREGATED) ads,
// so from then on the workbook series is PAID new listings, counted from our own ad registry
// (lib/ad-registry.js; see registryCounts below):
//
//   new paid listing  = an ad first seen with a paid package (BASIC/PREMIUM/MAX): a new ad,
//                       or a free / copied ad switching to paid. Re-publishing, renewing or
//                       upgrading an ad that was already paid does not count.
//   week              = by its publish time (buying a package resets it).
//   pre-owned         = not new construction, not an NC_* project, no project id.
//   total / for sale  = by the tier at that sighting (for sale vs coming soon).
//
// Wk 19 + 26 Oct (before the registry) are estimates from Hemnet's monthly paid figure
// (estimateWeeks, scripts/seed-weekly-master.js). Wk 2 Nov is partly reconstructed (the
// registry's full sweep ran on 3 Nov). Every month from November our monthly count is
// checked against Hemnet's own paid figure (monthlyCheck): that is the check the method works.
//
//   node lib/weekly-new-listings.js --smoke

const { muniMatches } = require('./ad-registry');
const { PAID_PACKAGES } = require('./listing-segment');

// First week counted from the registry (its first daily walk read back to Mon 2 Nov).
const COVERAGE_START = '2026-11-02';
// First week Hemnet's nytillkomna counts free / aggregated ads; the last clean one is 12 Oct.
const SERIES_BREAK = '2026-10-19';
// Hemnet's monthly paid ÷ our month vs the usual ratio: beyond this the post flags it.
const MONTHLY_TOLERANCE = 0.12;

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

// ---- Hemnet's monthly paid figure (statistik/finansiell-rapportering) ----
// "Antal publicerade och betalda objekt": per month, all of Sweden, the figure Hemnet reports
// quarterly. type 'published' (everything) and, from Feb 2026, 'paid'. Returns
// Map('YYYY-MM' -> { published, paid }).
const FINANCIAL_URL = 'https://www.hemnet.se/statistik/finansiell-rapportering';
function parseFinancialPage(html) {
  const raw = String(html).split(String.fromCharCode(92)).join('');
  const out = new Map();
  for (const m of raw.matchAll(/"recordedAt":"(\d+)(?:\.\d+)?","value":(\d+),"type":"(\w+)"/g)) {
    const month = new Date(Number(m[1]) * 1000 + DAY_MS / 2).toISOString().slice(0, 7);
    if (!out.has(month)) out.set(month, {});
    out.get(month)[m[3]] = Number(m[2]);
  }
  const paid = [...out.values()].filter(v => v.paid != null).length;
  if (paid < 6) throw new Error(`financial page: only ${paid} months with a paid figure`);
  return out;
}

// Spread each week of a series evenly over its 7 days and total by calendar month.
// Returns Map('YYYY-MM' -> { value, days }) for one area/market.
function monthlyFromWeeks(series, area, market) {
  const out = new Map();
  const m = series.get(`${area}|${market}`) || new Map();
  for (const [week, v] of m) for (let i = 0; i < 7; i++) {
    const month = addDays(week, i).slice(0, 7);
    const o = out.get(month) || { value: 0, days: 0 };
    o.value += v / 7; o.days += 1;
    out.set(month, o);
  }
  return out;
}
const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

// Hemnet's monthly paid figure ÷ the workbook total for the same month, averaged over
// complete months before the free tier (Feb–Sep 2026 = 0.76: Hemnet's "paid" leaves out some
// ads the weekly page always counted). PURE.
const PAID_RATIO_MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
function paidRatio(series, financial, months = PAID_RATIO_MONTHS) {
  const mm = monthlyFromWeeks(series, 'sweden', 'tot');
  const rs = months.map(mo => {
    const f = financial.get(mo), w = mm.get(mo);
    if (!f || f.paid == null || !w || w.days !== daysInMonth(mo)) throw new Error(`paid ratio: ${mo} not complete in both series`);
    return f.paid / w.value;
  });
  return rs.reduce((a, b) => a + b, 0) / rs.length;
}

// Estimates for weeks with no count of our own (wk 19 + 26 Oct 2026). PURE.
//   Sweden total: Hemnet's paid figure for the month ÷ the ratio above gives the month on the
//   workbook's scale; less the days the workbook already has, spread evenly over the
//   remaining days (so every estimated week gets the same daily rate).
//   Stockholm, VG and for sale: their shares over the 8 weeks before the first estimated week.
function estimateWeeks({ series, financial, month, weeks }) {
  const ratio = paidRatio(series, financial);
  const f = financial.get(month);
  if (!f || f.paid == null) throw new Error(`no Hemnet paid figure for ${month} yet`);
  const target = f.paid / ratio;
  const known = monthlyFromWeeks(series, 'sweden', 'tot').get(month) || { value: 0, days: 0 };
  const est = new Set(weeks);
  const missing = Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
    .filter(d => est.has(mondayOf(d))).length;
  if (known.days + missing !== daysInMonth(month)) throw new Error(`${month}: ${known.days} days known + ${missing} estimated is not the whole month`);
  const perDay = (target - known.value) / missing;
  const before = Array.from({ length: 8 }, (_, i) => addDays(weeks[0], -7 * (8 - i)));
  const sum = (area, market) => before.reduce((s, w) => {
    const v = valueOf(series, area, market, w);
    if (v == null) throw new Error(`share weeks: no ${area} ${market} for ${w}`);
    return s + v;
  }, 0);
  const shares = {};
  for (const a of AREAS) shares[a] = { area: sum(a, 'tot') / sum('sweden', 'tot'), fs: sum(a, 'fs') / sum(a, 'tot') };
  const rows = [];
  for (const week of weeks) {
    const sweTot = perDay * 7;
    for (const a of AREAS) {
      rows.push({ week_start: week, area: a, market: 'tot', value: Math.round(sweTot * shares[a].area) });
      rows.push({ week_start: week, area: a, market: 'fs', value: Math.round(sweTot * shares[a].area * shares[a].fs) });
    }
  }
  return { rows, ratio, target, known: known.value, knownDays: known.days, missingDays: missing, perDay, shares };
}

// Our month (Sweden, paid, total) vs Hemnet's monthly paid figure. Ours is scaled up for any
// days of the month before our counting started; on the workbook's scale Hemnet's figure
// should be about `ratio` of ours. PURE.
function monthlyCheck({ month, ours, hemnetPaid, ratio, from = COVERAGE_START }) {
  const days = daysInMonth(month);
  const coveredDays = from.slice(0, 7) === month ? days - Number(from.slice(8, 10)) + 1 : days;
  const scaled = ours * days / coveredDays;
  const expected = scaled * ratio;
  const diff = hemnetPaid / expected - 1;
  return { month, ours, coveredDays, days, scaled, expected, hemnetPaid, diff, ok: Math.abs(diff) <= MONTHLY_TOLERANCE };
}

// ---- our count from the ad registry ----
// The full sweep of 3 Nov 2026 put every live ad in the registry, so any ad id first seen
// after it is a new ad, and any ad first seen with a paid package after it has just been
// paid for (new, or switched to paid from free / copied). Re-publishing, renewing or
// upgrading an ad that was already paid is not a new listing, as on Hemnet's weekly page.
// (Hemnet ids are NOT a usable clock: the ads copied from agency sites since October got
// fresh ids but keep the agency's old publish date.)
const BASELINE_DAY = '2026-11-03';
// Ads already live at the sweep: only Mon 2 + Tue 3 Nov fall in a week we count, and there
// we cannot tell an old ad re-published from a new one except by its id. Ids from 22.0M
// were created from mid October; older ids published 2–3 Nov are re-published old ads.
const BASELINE_NEW_ID_MIN = 22000000;
// First week entirely after the sweep; earlier counted weeks are partly reconstructed.
const FULL_COVERAGE = '2026-11-09';

const SWEDISH_MIDNIGHT = (p) => `((${p}::date)::timestamp AT TIME ZONE 'Europe/Stockholm')`;
// When a sighting happened: its publish time (buying a package resets it), or the day before
// it was seen when that is missing or stale (the daily walk reads yesterday's ads).
const EVENT_AT = (h) => `(CASE WHEN ${h}.published_at IS NOT NULL AND ${h}.published_at >= ${h}.seen_on::timestamp - interval '3 days'
  THEN ${h}.published_at ELSE ${SWEDISH_MIDNIGHT(`(${h}.seen_on - 1)`)} END)`;
const PRE_OWNED = `NOT COALESCE(r.new_construction, false) AND r.ad_class <> 'newbuild' AND r.project_id IS NULL`;
// A sighting that counts: after the sweep, or (2–3 Nov only) a recent id published from 2 Nov.
const COUNTS = (h) => `(${h}.seen_on > '${BASELINE_DAY}'::date OR (${h}.hemnet_id >= ${BASELINE_NEW_ID_MIN}
  AND ${h}.published_at >= ${SWEDISH_MIDNIGHT(`'${COVERAGE_START}'`)}))`;

const emptyCounts = () => Object.fromEntries(AREAS.map(a => [a, { tot: 0, fs: 0 }]));
function bump(counts, kommun, tier) {
  const county = countyOf(kommun);
  for (const a of ['sweden', county].filter(Boolean)) {
    counts[a].tot++;
    if (tier === 'forsale') counts[a].fs++;
  }
}

// New pre-owned listings between two Swedish days (to exclusive):
//   paid      ads first seen with a paid package in the period (the workbook series), of
//             which `switched` had been seen free / copied / as a teaser before
//   newAds    ad ids first seen in the period, by their first package: paid, free, aggregated, other
// Counts per area as { tot, fs }; total vs for sale by the tier at that sighting.
async function registryCounts(client, from, to) {
  const paidList = [...PAID_PACKAGES];
  const out = { paid: emptyCounts(), switched: emptyCounts(), newAds: {} };
  const paid = await client.query(
    `WITH fp AS (
       SELECT DISTINCT ON (h.hemnet_id) h.hemnet_id, h.seen_on, h.tier, h.published_at, h.id
         FROM hemnet_ad_package_history h WHERE h.package = ANY($3::text[])
        ORDER BY h.hemnet_id, h.seen_on, h.id)
     SELECT r.kommun, fp.tier,
            EXISTS (SELECT 1 FROM hemnet_ad_package_history e WHERE e.hemnet_id = fp.hemnet_id AND e.id < fp.id) AS switched
       FROM fp JOIN hemnet_ad_registry r USING (hemnet_id)
      WHERE ${PRE_OWNED} AND ${COUNTS('fp')}
        AND ${EVENT_AT('fp')} >= ${SWEDISH_MIDNIGHT('$1')} AND ${EVENT_AT('fp')} < ${SWEDISH_MIDNIGHT('$2')}`,
    [from, to, paidList]);
  for (const a of paid.rows) {
    bump(out.paid, a.kommun, a.tier);
    if (a.switched) bump(out.switched, a.kommun, a.tier);
  }
  const fresh = await client.query(
    `WITH f AS (
       SELECT DISTINCT ON (h.hemnet_id) h.hemnet_id, h.seen_on, h.tier, h.published_at, h.package
         FROM hemnet_ad_package_history h ORDER BY h.hemnet_id, h.seen_on, h.id)
     SELECT r.kommun, f.tier, CASE WHEN f.package = ANY($3::text[]) THEN 'paid' WHEN f.package = 'MINIMAL' THEN 'free'
                                   WHEN f.package = 'AGGREGATED' THEN 'aggregated' ELSE 'other' END AS kind
       FROM f JOIN hemnet_ad_registry r USING (hemnet_id)
      WHERE ${PRE_OWNED} AND ${COUNTS('f')}
        AND ${EVENT_AT('f')} >= ${SWEDISH_MIDNIGHT('$1')} AND ${EVENT_AT('f')} < ${SWEDISH_MIDNIGHT('$2')}`,
    [from, to, paidList]);
  for (const a of fresh.rows) bump(out.newAds[a.kind] || (out.newAds[a.kind] = emptyCounts()), a.kommun, a.tier);
  return out;
}
const registryWeek = (client, weekStart) => registryCounts(client, weekStart, addDays(weekStart, 7));

// Did the daily new-ads walk run ok on the Monday after the week? Each walk reads back to the
// last good one (up to a week), so a good Monday walk means the whole week was read.
async function dailyWalkCovered(client, weekStart) {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM hemnet_ad_sweep_run WHERE kind = 'daily' AND status = 'ok' AND run_date = $1::date`,
    [addDays(weekStart, 7)]);
  return r.rows[0].n > 0;
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
  COVERAGE_START, SERIES_BREAK, MONTHLY_TOLERANCE, FULL_COVERAGE, BASELINE_DAY, AREAS, AREA_LABEL, STATS_LOCATION,
  countyOf, addDays, mondayOf, swedishToday, lastCompleteWeek, statsUrl, parseStatsPage, fetchHemnetPublic,
  FINANCIAL_URL, parseFinancialPage, monthlyFromWeeks, daysInMonth, paidRatio, estimateWeeks, monthlyCheck,
  registryCounts, registryWeek, dailyWalkCovered,
  valueOf, metricsFor, pmShare, dashboardLines, toSeries, toCsv, CSV_COLUMNS, pct,
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
  check('parseFinancialPage: months with published and paid; refuses a page without paid months', () => {
    const pt = (sec, v, t) => `{\\"recordedAt\\":\\"${sec}\\",\\"value\\":${v},\\"type\\":\\"${t}\\"}`;
    const months = Array.from({ length: 9 }, (_, i) => Date.UTC(2026, 1 + i, 1) / 1000);
    const page = months.map((s, i) => pt(s, 9000 + i, 'published') + pt(s, 7000 + i, 'paid')).join(',');
    const f = parseFinancialPage(page);
    assert.deepStrictEqual(f.get('2026-02'), { published: 9000, paid: 7000 });
    assert.deepStrictEqual(f.get('2026-10'), { published: 9008, paid: 7008 });
    assert.throws(() => parseFinancialPage(pt(months[0], 1, 'published')), /paid/);
  });
  check('estimateWeeks: month on the workbook scale less the known days, spread evenly; area shares', () => {
    // Every week 700 total (100/day), Stockholm 1/7, VG 1/14, for sale 70%; Hemnet paid = 0.75 × ours.
    const ws = Array.from({ length: 60 }, (_, i) => addDays('2025-09-01', 7 * i)).filter(w => w <= '2026-10-12');
    const r = [];
    for (const w of ws) {
      r.push({ week_start: w, area: 'sweden', market: 'tot', value: 700 }, { week_start: w, area: 'sweden', market: 'fs', value: 490 });
      r.push({ week_start: w, area: 'stockholm', market: 'tot', value: 100 }, { week_start: w, area: 'stockholm', market: 'fs', value: 70 });
      r.push({ week_start: w, area: 'vg', market: 'tot', value: 50 }, { week_start: w, area: 'vg', market: 'fs', value: 35 });
    }
    const fin = new Map(PAID_RATIO_MONTHS.map(m => [m, { paid: 0.75 * 100 * daysInMonth(m) }]));
    fin.set('2026-10', { paid: 0.75 * (18 * 100 + 13 * 60) }); // 19–31 Oct ran at 60 a day
    const e = estimateWeeks({ series: toSeries(r), financial: fin, month: '2026-10', weeks: ['2026-10-19', '2026-10-26'] });
    assert.ok(Math.abs(e.ratio - 0.75) < 1e-9);
    assert.strictEqual(e.knownDays, 18);
    assert.strictEqual(e.missingDays, 13);
    assert.ok(Math.abs(e.perDay - 60) < 1e-9);
    const v = (w, a, m) => e.rows.find(x => x.week_start === w && x.area === a && x.market === m).value;
    assert.strictEqual(v('2026-10-19', 'sweden', 'tot'), 420);
    assert.strictEqual(v('2026-10-26', 'sweden', 'fs'), 294);
    assert.strictEqual(v('2026-10-19', 'stockholm', 'tot'), 60);
    assert.strictEqual(v('2026-10-19', 'vg', 'fs'), 21);
    assert.throws(() => estimateWeeks({ series: toSeries(r), financial: fin, month: '2026-10', weeks: ['2026-10-26'] }), /whole month/);
  });
  check('monthlyCheck: scales a part month, flags a gap beyond tolerance', () => {
    const c = monthlyCheck({ month: '2026-11', ours: 2900, hemnetPaid: 2250, ratio: 0.75 });
    assert.strictEqual(c.coveredDays, 29, 'from Mon 2 Nov');
    assert.strictEqual(c.scaled, 3000);
    assert.ok(Math.abs(c.diff) < 1e-9 && c.ok);
    assert.strictEqual(monthlyCheck({ month: '2026-12', ours: 3000, hemnetPaid: 1800, ratio: 0.75 }).ok, false);
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
