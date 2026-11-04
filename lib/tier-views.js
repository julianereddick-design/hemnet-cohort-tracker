'use strict';

// lib/tier-views.js — monthly: how many Hemnet views each ad tier gets (Free / Basic / Plus /
// Premium / Max) for comparable homes, and how many free ads upgrade to a paid package.
// Built 2026-11-04 (Glenn); first read was an ad-hoc script on W43.
//
// Views. Same cohort homes as the like-for-like measure (lib/views-like-for-like.js): only the
// counted steps between two readings at days 8–28 after the Booli listing date (outages,
// Hemnet re-publishes and long gaps left out). Per home: Hemnet and Booli views per day over
// those steps. A home belongs to the month in which its day 28 falls.
//   - Tier = the Hemnet package (latest known). Homes seen with both a free and a paid package
//     (upgraded) and homes with no package are left out.
//   - The comparison: Hemnet views PER BOOLI VIEW against a comparable Premium ad. Booli views
//     measure how much buyers want that home whatever its Hemnet tier, so the ratio takes the
//     "better homes buy better packages" effect out. Comparable = same cohort, municipality,
//     property type and price band; per stratum, mean log ratio of the tier minus Premium's,
//     averaged over strata weighted by the harmonic mean of the two counts; shown as exp().
//     The range is the 5th–95th percentile of a seeded bootstrap over homes.
//   - Selection check: the same comparison on Booli views alone (are free homes less wanted?).
//   - Same agency: strata = cohort × agency instead. Free ads show no agency on Hemnet, so
//     this covers the paid tiers only.
//
// Upgrades. From the ad registry (hemnet_ad_package_history, from 2026-11-03): ads whose first
// recorded package is MINIMAL; start = their publish date (Swedish time), or first sighting if
// none; upgraded = first later sighting with a paid package. Grouped by start month; only ads
// published from 3 Nov (UPGRADE_FROM), when the history starts.
//
//   node lib/tier-views.js --smoke     (offline)

const { classifyIntervals, STATUS, AGE_MAX } = require('./views-like-for-like');
const { adClassOf, latestPackageJoin } = require('./listing-segment');

const TIER_OF = { MINIMAL: 'Free', BASIC: 'Basic', PLUS: 'Plus', PREMIUM: 'Premium', MAX: 'Max' };
const TIERS = ['Free', 'Basic', 'Plus', 'Premium', 'Max'];
const MIN_COHORT = '2026-W41';      // first cohorts whose day 28 can fall after the free tier
const MIN_DAYS = 6;                 // counted days a home needs to be compared
const MIN_COMPARED = 30;            // homes compared below this: shown as "too few"
const BOOT = 300;
// Package history starts with the 3 Nov 2026 full sweep. A free ad published before then
// could have upgraded unseen (it would show as paid, never free), so it is left out.
const UPGRADE_FROM = '2026-11-03';

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const monthOf = (d) => d.slice(0, 7);
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const band = (p) => (p == null ? 'na' : p < 1.5e6 ? 'a' : p < 2.5e6 ? 'b' : p < 4e6 ? 'c' : p < 6e6 ? 'd' : 'e');
function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function rng(seed) {                 // mulberry32: same month, same bootstrap
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s) => [...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);

function tierOf(p) {
  const classes = new Set((p.packages_seen || []).map(adClassOf));
  if (classes.has('free') && classes.has('paid')) return null;     // upgraded or downgraded
  return TIER_OF[p.active_package] || null;
}

// pairs: [{ id, cohort_id, booli_listed, hemnet_listed, booli_views_day0, active_package,
//           packages_seen, muni, object_type, price, agency }]
// readings: [{ pair_id, date, hemnet_views, booli_views }]
// → one row per comparable home with its views per day and month.
function homeRates(pairs, readings, { before = null } = {}) {
  const byId = new Map(pairs.map(p => [p.id, p]));
  const { intervals } = classifyIntervals(pairs, readings, { before });
  const acc = new Map();
  for (const iv of intervals) {
    if (iv.status !== STATUS.counted) continue;
    const a = acc.get(iv.pair_id) || { h: 0, b: 0, days: 0 };
    a.h += iv.hemnet_gain; a.b += iv.booli_gain; a.days += iv.days;
    acc.set(iv.pair_id, a);
  }
  const homes = [];
  for (const [id, a] of acc) {
    const p = byId.get(id);
    const tier = tierOf(p);
    if (!tier || a.days < MIN_DAYS) continue;
    homes.push({
      pair_id: id, cohort_id: p.cohort_id, hemnet_id: p.hemnet_id, tier,
      month: monthOf(iso(Date.parse(`${p.booli_listed}T00:00:00Z`) + AGE_MAX * DAY)),
      muni: p.muni || '', object_type: p.object_type || '', price: p.price == null ? null : Number(p.price),
      agency: p.agency || null, days: a.days, hemnet_per_day: a.h / a.days, booli_per_day: a.b / a.days,
    });
  }
  return homes;
}

const metrics = {
  perBooliView: (h) => Math.log((h.hemnet_per_day + 0.5) / (h.booli_per_day + 0.5)),
  booli: (h) => Math.log(h.booli_per_day + 0.5),
};
const keys = {
  similar: (h) => `${h.cohort_id}|${h.muni}|${h.object_type}|${band(h.price)}`,
  agency: (h) => (h.agency ? `${h.cohort_id}|${h.agency}` : null),
};

// Each tier against Premium within groups: { tier: { x, homes } } (x = ratio, 1 = same).
function versusPremium(homes, keyFn, metric) {
  const groups = new Map();
  for (const h of homes) {
    const k = keyFn(h);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  const out = {};
  for (const t of TIERS) {
    if (t === 'Premium') continue;
    let num = 0, den = 0, n = 0;
    for (const g of groups.values()) {
      const a = g.filter(h => h.tier === t), p = g.filter(h => h.tier === 'Premium');
      if (!a.length || !p.length) continue;
      const w = (2 * a.length * p.length) / (a.length + p.length);
      const mean = (xs) => xs.reduce((s, h) => s + metric(h), 0) / xs.length;
      num += w * (mean(a) - mean(p)); den += w; n += a.length;
    }
    out[t] = den ? { x: Math.exp(num / den), homes: n } : { x: null, homes: 0 };
  }
  return out;
}

function withRange(homes, keyFn, metric, seed) {
  const point = versusPremium(homes, keyFn, metric);
  const rand = rng(seed);
  const draws = Object.fromEntries(Object.keys(point).map(t => [t, []]));
  for (let i = 0; i < BOOT && homes.length; i++) {
    const s = homes.map(() => homes[Math.floor(rand() * homes.length)]);
    const e = versusPremium(s, keyFn, metric);
    for (const t in e) if (e[t].x != null) draws[t].push(e[t].x);
  }
  const res = {};
  for (const [t, v] of Object.entries(point)) {
    const d = draws[t].sort((a, b) => a - b);
    res[t] = { ...v, lo: d.length ? d[Math.floor(d.length * 0.05)] : null, hi: d.length ? d[Math.floor(d.length * 0.95)] : null };
  }
  return res;
}

// One row per month × tier.
function summarise(homes) {
  const months = [...new Set(homes.map(h => h.month))].sort();
  const rows = [];
  for (const m of months) {
    const H = homes.filter(h => h.month === m);
    const seed = seedOf(m);
    const vs = withRange(H, keys.similar, metrics.perBooliView, seed);
    const sel = withRange(H, keys.similar, metrics.booli, seed + 1);
    const ag = withRange(H, keys.agency, metrics.perBooliView, seed + 2);
    const cohorts = [...new Set(H.map(h => h.cohort_id))].sort();
    for (const t of TIERS) {
      const T = H.filter(h => h.tier === t);
      if (!T.length) continue;
      const sh = T.reduce((a, h) => a + h.hemnet_per_day * h.days, 0);
      const sb = T.reduce((a, h) => a + h.booli_per_day * h.days, 0);
      const pctOf = (o) => (o && o.x != null ? r1(o.x * 100) : null);
      rows.push({
        month: m,
        cohorts: cohorts.length > 1 ? `${cohorts[0].slice(5)}–${cohorts[cohorts.length - 1].slice(5)}` : (cohorts[0] || '').slice(5),
        tier: t,
        homes: T.length,
        hemnet_views_per_day: r1(med(T.map(h => h.hemnet_per_day))),
        booli_views_per_day: r1(med(T.map(h => h.booli_per_day))),
        hemnet_share_pct: r1(sh + sb > 0 ? (100 * sh) / (sh + sb) : null),
        vs_premium_pct: t === 'Premium' ? 100 : pctOf(vs[t]),
        vs_premium_low: t === 'Premium' ? null : r1(vs[t].lo * 100),
        vs_premium_high: t === 'Premium' ? null : r1(vs[t].hi * 100),
        homes_compared: t === 'Premium' ? null : vs[t].homes,
        booli_vs_premium_pct: t === 'Premium' ? 100 : pctOf(sel[t]),
        same_agency_vs_premium_pct: t === 'Premium' ? 100 : pctOf(ag[t]),
        same_agency_low: t === 'Premium' ? null : r1(ag[t].lo * 100),
        same_agency_high: t === 'Premium' ? null : r1(ag[t].hi * 100),
        same_agency_homes: t === 'Premium' ? null : ag[t].homes,
      });
    }
  }
  return rows;
}

// ads: [{ hemnet_id, start, upgraded_on, gone_on }] (dates 'YYYY-MM-DD'); asOf: today.
function upgradeRates(ads, asOf) {
  const months = [...new Set(ads.filter(a => a.start >= UPGRADE_FROM).map(a => monthOf(a.start)))].sort();
  return months.map((m) => {
    const A = ads.filter(a => a.start >= UPGRADE_FROM && monthOf(a.start) === m);
    const within = (n) => {
      const eligible = A.filter(a => Date.parse(a.start) + n * DAY <= Date.parse(asOf));
      const up = eligible.filter(a => a.upgraded_on && Date.parse(a.upgraded_on) - Date.parse(a.start) <= n * DAY);
      return { eligible: eligible.length, pct: eligible.length ? r1((100 * up.length) / eligible.length) : null };
    };
    const up = A.filter(a => a.upgraded_on);
    const d14 = within(14), d28 = within(28);
    return {
      start_month: m,
      free_ads: A.length,
      upgraded_so_far: up.length,
      upgraded_so_far_pct: r1((100 * up.length) / A.length),
      upgraded_14d_pct: d14.pct, eligible_14d: d14.eligible,
      upgraded_28d_pct: d28.pct, eligible_28d: d28.eligible,
      median_days_to_upgrade: r1(med(up.map(a => (Date.parse(a.upgraded_on) - Date.parse(a.start)) / DAY))),
      gone_without_upgrade: A.filter(a => !a.upgraded_on && a.gone_on).length,
    };
  });
}

const fmtRange = (lo, hi) => (lo == null || hi == null ? '' : ` (likely ${lo}–${hi}%`);
function tierLine(r, field, lo, hi, n) {
  if (r[n] == null || r[n] < MIN_COMPARED || r[field] == null) return `• ${r.tier}: too few homes to read (${r[n] || 0})`;
  return `• ${r.tier}: *${r[field]}%*${fmtRange(r[lo], r[hi])}, ${r[n]} homes)`;
}

function slackMessage({ month, rows, upgrades, links }) {
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const R = rows.filter(r => r.month === month);
  const lines = [`:bar_chart: *Hemnet ad tiers: views and upgrades — ${label}*`];
  if (!R.length) {
    lines.push('No homes finished days 8–28 of their listing this month with a known package.');
  } else {
    const prem = R.find(r => r.tier === 'Premium');
    lines.push(`Homes whose days 8–28 of listing ended in ${label} (cohorts ${R[0].cohorts}), the same home on Booli and Hemnet. ` +
      `Premium: ${prem ? prem.homes : 0} homes.`);
    lines.push('', '*Hemnet views per Booli view, vs a comparable Premium ad* (same municipality, property type, price band):');
    for (const r of R) if (r.tier !== 'Premium') lines.push(tierLine(r, 'vs_premium_pct', 'vs_premium_low', 'vs_premium_high', 'homes_compared'));
    const free = R.find(r => r.tier === 'Free');
    if (free && free.homes_compared >= MIN_COMPARED && free.booli_vs_premium_pct != null) {
      lines.push(`Check: free homes get ${free.booli_vs_premium_pct}% of a comparable Premium home's Booli views` +
        (free.booli_vs_premium_pct >= 90 ? ', so the gap is not explained by free homes being less wanted.' : ', so part of the gap may be less-wanted homes.'));
    }
    const ag = R.filter(r => r.tier !== 'Premium' && r.tier !== 'Free');
    if (ag.length) {
      lines.push('', '*Same agency, paid tiers only* (free ads show no agency):');
      for (const r of ag) lines.push(tierLine(r, 'same_agency_vs_premium_pct', 'same_agency_low', 'same_agency_high', 'same_agency_homes'));
    }
    const prev = rows.filter(r => r.month < month && r.tier === 'Free' && r.homes_compared >= MIN_COMPARED).pop();
    if (prev && free && free.vs_premium_pct != null) lines.push(`Free vs Premium last time (${prev.month}): ${prev.vs_premium_pct}%.`);
  }
  lines.push('', '*Free ads upgrading to paid*');
  const recent = upgrades.filter(u => u.start_month <= month).slice(-2);
  if (!recent.length) lines.push('No free ads recorded yet.');
  for (const u of recent) {
    const parts = [`${u.upgraded_so_far_pct}% upgraded so far (${u.upgraded_so_far} of ${u.free_ads} free ads published ${u.start_month})`];
    if (u.upgraded_14d_pct != null) parts.push(`${u.upgraded_14d_pct}% within 14 days`);
    if (u.upgraded_28d_pct != null) parts.push(`${u.upgraded_28d_pct}% within 28 days`);
    if (u.median_days_to_upgrade != null) parts.push(`median ${u.median_days_to_upgrade} days to upgrade`);
    lines.push(`• ${parts.join(', ')}`);
  }
  if (links) lines.push('', `_Ratios: 100% = same as Premium. Files: ${links}_`);
  return lines.join('\n');
}

const CSV_COLUMNS = ['month', 'cohorts', 'tier', 'homes', 'hemnet_views_per_day', 'booli_views_per_day', 'hemnet_share_pct',
  'vs_premium_pct', 'vs_premium_low', 'vs_premium_high', 'homes_compared', 'booli_vs_premium_pct',
  'same_agency_vs_premium_pct', 'same_agency_low', 'same_agency_high', 'same_agency_homes'];
const UPGRADE_COLUMNS = ['start_month', 'free_ads', 'upgraded_so_far', 'upgraded_so_far_pct', 'upgraded_14d_pct', 'eligible_14d',
  'upgraded_28d_pct', 'eligible_28d', 'median_days_to_upgrade', 'gone_without_upgrade'];
const HOME_COLUMNS = ['month', 'cohort_id', 'pair_id', 'hemnet_id', 'tier', 'muni', 'object_type', 'price', 'agency', 'days',
  'hemnet_per_day', 'booli_per_day'];

function toCsv(rows, cols) {
  const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

async function writeWorkbook(file, rows, upgrades, homes) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = (name, cols, data) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(c => ({ header: c, key: c, width: Math.max(10, c.length + 2) }));
    ws.getRow(1).font = { bold: true };
    for (const r of data) ws.addRow(r);
  };
  sheet('By tier', CSV_COLUMNS, rows);
  sheet('Upgrades', UPGRADE_COLUMNS, upgrades);
  sheet('Homes', HOME_COLUMNS, homes.map(h => ({ ...h, hemnet_per_day: r1(h.hemnet_per_day), booli_per_day: r1(h.booli_per_day) })));
  const notes = wb.addWorksheet('Method');
  notes.getColumn(1).width = 120;
  for (const line of [
    'Views: cohort homes (same home on Booli and Hemnet), counted steps between readings at days 8–28 after the Booli listing date;',
    'outages, Hemnet re-publishes and gaps over 4 days left out (as views-like-for-like). A home belongs to the month its day 28 falls in.',
    'Tier = Hemnet package; homes seen with both a free and a paid package, or with none, are left out.',
    'vs_premium_pct: Hemnet views per Booli view against a comparable Premium ad (same cohort, municipality, property type, price band);',
    '  geometric mean ratio within groups, weighted by the harmonic mean of group sizes. 100 = same as Premium. Low/high: 5th–95th bootstrap percentile.',
    'booli_vs_premium_pct: the same on Booli views alone — below 100 means the tier\'s homes are less wanted to begin with.',
    'same_agency_*: groups = cohort × agency. Free ads show no agency on Hemnet, so paid tiers only.',
    'Upgrades: ads whose first recorded package was free and published from 3 Nov 2026 (when the registry history starts), by publish month;',
    '  upgraded = later seen with a paid package. 14/28-day rates count only ads published at least 14/28 days before the run.',
  ]) notes.addRow([line]);
  await wb.xlsx.writeFile(file);
}

async function loadInputs(client) {
  const pairs = (await client.query(`
    SELECT cp.id, cp.cohort_id, cp.hemnet_id, cp.booli_listed::text AS booli_listed, cp.hemnet_listed::text AS hemnet_listed,
           cp.booli_views_day0, pkg.active_package, coalesce(r.packages_seen, '{}') AS packages_seen,
           cp.municipality AS muni, b.object_type, b.price, r.broker_agency AS agency
      FROM cohort_pairs cp ${latestPackageJoin('cp')}
      LEFT JOIN hemnet_ad_registry r ON r.hemnet_id = cp.hemnet_id
      LEFT JOIN (SELECT DISTINCT ON (booli_id) booli_id, object_type, price
                   FROM booli_listing ORDER BY booli_id, crawled DESC) b ON b.booli_id = cp.booli_id
     WHERE cp.cohort_id >= $1 AND cp.removed_at IS NULL`, [MIN_COHORT])).rows;
  const readings = (await client.query(`
    SELECT v.pair_id, v.date::text AS date, v.hemnet_views, v.booli_views
      FROM cohort_daily_views v
      JOIN cohort_pairs p ON p.id = v.pair_id AND p.removed_at IS NULL
     WHERE p.cohort_id >= $1`, [MIN_COHORT])).rows;
  const paid = [...require('./listing-segment').PAID_PACKAGES];
  const ads = (await client.query(`
    WITH first AS (
      SELECT DISTINCT ON (hemnet_id) hemnet_id, seen_on, package, published_at
        FROM hemnet_ad_package_history ORDER BY hemnet_id, seen_on, id)
    SELECT f.hemnet_id,
           coalesce((f.published_at AT TIME ZONE 'Europe/Stockholm')::date, f.seen_on)::text AS start,
           (SELECT min(x.seen_on) FROM hemnet_ad_package_history x
             WHERE x.hemnet_id = f.hemnet_id AND x.package = ANY($1) AND x.seen_on >= f.seen_on)::text AS upgraded_on,
           r.gone_on::text AS gone_on
      FROM first f LEFT JOIN hemnet_ad_registry r ON r.hemnet_id = f.hemnet_id
     WHERE f.package = 'MINIMAL'`, [paid])).rows;
  return { pairs, readings, ads };
}

module.exports = {
  homeRates, versusPremium, summarise, upgradeRates, slackMessage, toCsv, writeWorkbook, loadInputs,
  CSV_COLUMNS, UPGRADE_COLUMNS, HOME_COLUMNS, MIN_COMPARED, TIERS,
};

// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.error(`  FAIL ${name}: ${e.message}`); }
  };
  // 40 homes per tier in one group, listed 20 Oct 2026; per 2-day step Booli +20 for all,
  // Hemnet +40 Premium, +28 Free (70% of Premium per Booli view), +36 Basic.
  const pairs = [], readings = [];
  const gain = { PREMIUM: 40, MINIMAL: 28, BASIC: 36, MAX: 80 };
  let id = 0;
  for (const [pkg, n] of [['PREMIUM', 40], ['MINIMAL', 40], ['BASIC', 40], ['MAX', 3]]) {
    for (let i = 0; i < n; i++) {
      id++;
      pairs.push({ id, cohort_id: '2026-W43', hemnet_id: 1000 + id, booli_listed: '2026-10-20', hemnet_listed: '2026-10-20',
        booli_views_day0: 0, active_package: pkg, packages_seen: [pkg], muni: 'Solna', object_type: 'Lägenhet',
        price: 3e6, agency: pkg === 'MINIMAL' ? null : (i % 2 ? 'A' : 'B') });
      for (let d = 0; d <= 30; d += 2) {
        const date = iso(Date.parse('2026-10-20T00:00:00Z') + d * DAY);
        readings.push({ pair_id: id, date, hemnet_views: 100 + (gain[pkg] + (i % 3)) * d / 2, booli_views: 100 + 20 * d / 2 });
      }
    }
  }
  // an upgraded home and a home with no package are left out
  pairs.push({ ...pairs[0], id: 999, active_package: 'PREMIUM', packages_seen: ['MINIMAL', 'PREMIUM'] });
  pairs.push({ ...pairs[0], id: 998, active_package: null, packages_seen: [] });
  for (const r of readings.filter(r => r.pair_id === 1)) { readings.push({ ...r, pair_id: 999 }); readings.push({ ...r, pair_id: 998 }); }
  const outages = [];
  const homes = homeRates(pairs, readings, { before: '2026-12-01' }).filter(Boolean);
  check('upgraded and package-less homes are left out; month = month of day 28', () => {
    assert.strictEqual(homes.length, 123);
    assert.ok(!homes.some(h => h.pair_id === 999 || h.pair_id === 998));
    assert.ok(homes.every(h => h.month === '2026-11'));
  });
  const rows = summarise(homes);
  const t = (n) => rows.find(r => r.tier === n);
  check('Free ≈ 70% and Basic ≈ 90% of Premium per Booli view', () => {
    assert.ok(Math.abs(t('Free').vs_premium_pct - 70.7) < 1.5, `free ${t('Free').vs_premium_pct}`);
    assert.ok(Math.abs(t('Basic').vs_premium_pct - 90.2) < 1.5, `basic ${t('Basic').vs_premium_pct}`);
    assert.strictEqual(t('Premium').vs_premium_pct, 100);
    assert.ok(t('Free').vs_premium_low <= t('Free').vs_premium_pct && t('Free').vs_premium_high >= t('Free').vs_premium_pct);
  });
  check('selection check: equal Booli views → 100%', () => assert.ok(Math.abs(t('Free').booli_vs_premium_pct - 100) < 1));
  check('same-agency comparison: none for Free (no agency), present for Basic', () => {
    assert.strictEqual(t('Free').same_agency_homes, 0);
    assert.strictEqual(t('Basic').same_agency_homes, 40);
  });
  check('bootstrap is reproducible', () => assert.deepStrictEqual(summarise(homes), rows));
  const ups = upgradeRates([
    { hemnet_id: 1, start: '2026-11-03', upgraded_on: '2026-11-09', gone_on: null },
    { hemnet_id: 2, start: '2026-11-03', upgraded_on: null, gone_on: '2026-11-20' },
    { hemnet_id: 3, start: '2026-11-25', upgraded_on: null, gone_on: null },
    { hemnet_id: 4, start: '2026-11-05', upgraded_on: '2026-11-30', gone_on: null },
    { hemnet_id: 5, start: '2026-11-02', upgraded_on: null, gone_on: null },   // before the history
  ], '2026-12-01');
  check('upgrade rates: by start month, eligibility windows, ads before the history ignored', () => {
    assert.strictEqual(ups.length, 1);
    const u = ups[0];
    assert.deepStrictEqual([u.free_ads, u.upgraded_so_far, u.eligible_14d, u.upgraded_14d_pct, u.eligible_28d], [4, 2, 3, 33.3, 2]);
    assert.strictEqual(u.upgraded_28d_pct, 50, 'only ads started 3 Nov have 28 days by 1 Dec');
    assert.strictEqual(u.median_days_to_upgrade, 15.5);
    assert.strictEqual(u.gone_without_upgrade, 1);
  });
  check('Slack message: tiers, too-few, agency, upgrades', () => {
    const s = slackMessage({ month: '2026-11', rows, upgrades: ups, links: 'L' });
    assert.match(s, /November 2026/);
    assert.match(s, /• Free: \*7\d\.\d%\*/);
    assert.match(s, /• Max: too few homes to read \(3\)/);
    assert.match(s, /Same agency, paid tiers only/);
    assert.match(s, /not explained by free homes being less wanted/);
    assert.match(s, /50% upgraded so far \(2 of 4 free ads published 2026-11\), 33\.3% within 14 days/);
    assert.match(s, /Files: L/);
    assert.match(slackMessage({ month: '2027-01', rows, upgrades: [], links: null }), /No homes finished/);
  });
  check('CSV quotes commas', () => {
    assert.match(toCsv([{ month: 'a,b' }], ['month']), /"a,b"/);
  });
  void outages;
  console.log(`smoke: tier-views ${pass} pass, ${fail} fail`);
  if (fail) process.exitCode = 1;
}
