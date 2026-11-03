'use strict';

// lib/views-like-for-like.js
//
// The weekly like-for-like Hemnet share of views (H%), for the weekly view pack: written
// to view-data/<date>/views-like-for-like.csv AND posted as the "Views, like-for-like"
// block of the weekly view report. Always both: the scorecard bot reads either.
//
// Why not the cross-cohort chart: it plots every cohort by calendar date, so young
// cohorts (which always sit lower) mix listing age into the trend; it floors Hemnet
// re-publishes to zero; aging-out cohorts throw false tail points; and from W43 it mixes
// in free-tier listings. This measure removes each of those:
//
//   - same homes on both sites: an interval counts only when both counters were read
//     at both ends (readings are every other day)
//   - listing age fixed: interval midpoint 8–28 days after the Booli listing date
//   - Hemnet re-publishes left out: an interval where the Hemnet counter fell
//   - outages left out: an interval spanning a lib/view-outages.js window, or longer
//     than MAX_GAP_DAYS, is skipped rather than smeared over the week
//   - split paid / free (lib/listing-segment.js) and Booli pre-market carryover / fresh
//     (booli_views_day0 >= 100: the home already had Booli views before Hemnet listing)
//
// H% = Σ Hemnet increments / Σ (Hemnet + Booli increments), pooled across homes.
// Weeks are Mon–Sun; an interval belongs to the week of its later reading. The pack
// reports the Mon–Sun week before the pack date.
//
//   node lib/views-like-for-like.js --smoke

const { segmentOf } = require('./listing-segment');
const { VIEW_OUTAGES } = require('./view-outages');

const AGE_MIN = 8;
const AGE_MAX = 28;
const MAX_GAP_DAYS = 4;
const CARRYOVER_MIN = 100;
const HISTORY_FROM = '2026-06-01';   // readings were daily (Booli every other day) before ~25 May
const SMALL_SAMPLE = 200;            // homes; below this a split is shown but not read
const FROZEN_SHARE = 0.25;           // share of intervals with no growth on one site

const DAY = 86400000;
const ms = (d) => Date.parse(`${d}T00:00:00Z`);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

function weekStart(date) {
  const t = ms(date);
  const wd = (new Date(t).getUTCDay() + 6) % 7;   // Mon = 0
  return iso(t - wd * DAY);
}
const weekEnd = (start) => iso(ms(start) + 6 * DAY);
// The Mon–Sun week before the pack date (a Monday pack reports the week just ended).
const reportWeek = (packDate) => iso(ms(weekStart(packDate)) - 7 * DAY);

const dayMonth = (d) => new Date(ms(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekday = (d) => new Date(ms(d)).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

function newAcc() { return { h: 0, b: 0, days: 0, homes: new Set() }; }
const pct = (a) => (a && a.h + a.b > 0 ? Math.round((1000 * a.h) / (a.h + a.b)) / 10 : null);

// pairs: [{ id, booli_listed, hemnet_listed, booli_views_day0, active_package }]
// readings: [{ pair_id, date, hemnet_views, booli_views }] (any order; nulls allowed)
// `before` (a pack date): drop the week that date falls in and later, which are unfinished.
function computeWeekly(pairs, readings, { outages = VIEW_OUTAGES, from = HISTORY_FROM, before = null } = {}) {
  const byId = new Map(pairs.map(p => [p.id, p]));
  const rows = readings
    .filter(r => r.date >= from && r.hemnet_views > 0 && r.booli_views > 0 && byId.has(r.pair_id))
    .sort((a, b) => a.pair_id - b.pair_id || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const weeks = new Map();
  const wk = (w) => {
    if (!weeks.has(w)) {
      weeks.set(w, { groups: {}, readingDates: new Set(), outageSkipped: 0, gapSkipped: 0, resets: 0, kept: 0, flatH: 0, flatB: 0 });
    }
    return weeks.get(w);
  };
  const add = (W, key, pairId, dh, db, days) => {
    const a = (W.groups[key] ??= newAcc());
    a.h += dh; a.b += db; a.days += days; a.homes.add(pairId);
  };

  // Dates where both sites were read (blanked outage readings don't count).
  for (const r of rows) wk(weekStart(r.date)).readingDates.add(r.date);

  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const z = rows[i];
    if (a.pair_id !== z.pair_id) continue;
    const p = byId.get(z.pair_id);
    const W = wk(weekStart(z.date));
    const days = (ms(z.date) - ms(a.date)) / DAY;
    if (outages.some(o => a.date <= o.to && z.date >= o.from)) { W.outageSkipped++; continue; }
    if (days > MAX_GAP_DAYS) { W.gapSkipped++; continue; }
    if (!p.booli_listed) continue;
    const age = ((ms(a.date) + ms(z.date)) / 2 - ms(p.booli_listed)) / DAY;
    if (age < AGE_MIN || age > AGE_MAX) continue;
    const dh = z.hemnet_views - a.hemnet_views;
    const db = z.booli_views - a.booli_views;
    if (dh < 0) { W.resets++; continue; }        // Hemnet re-publish: counter restarted
    if (db < 0) continue;
    W.kept++;
    if (dh === 0) W.flatH++;
    if (db === 0) W.flatB++;
    const seg = segmentOf(p.active_package, p.hemnet_listed);
    const carry = (p.booli_views_day0 || 0) >= CARRYOVER_MIN ? 'carryover' : 'fresh';
    for (const key of ['all', seg, carry]) add(W, key, z.pair_id, dh, db, days);
  }

  const cutoff = before ? weekStart(before) : null;
  return [...weeks.keys()].sort().filter(w => !cutoff || w < cutoff).map((w) => {
    const W = weeks.get(w);
    const g = W.groups;
    const n = (k) => (g[k] ? g[k].homes.size : 0);
    const flags = [];
    for (const o of outages) {
      if (o.from <= weekEnd(w) && o.to >= w) flags.push(`partial week: ${o.label} ${dayMonth(o.from)}–${dayMonth(o.to)}, readings across it left out`);
    }
    if (W.kept && W.flatB / W.kept > FROZEN_SHARE) flags.push('Booli view counts look frozen');
    if (W.kept && W.flatH / W.kept > FROZEN_SHARE) flags.push('Hemnet view counts look frozen');
    if (n('all') && n('unknown') / n('all') > 0.2) flags.push(`package unknown for ${Math.round((100 * n('unknown')) / n('all'))}% of homes`);
    if (n('paid') < SMALL_SAMPLE) flags.push(`small sample (${n('paid')} paid homes)`);
    const all = g.all;
    return {
      week_start: w,
      week_end: weekEnd(w),
      hpct_paid: pct(g.paid),
      hpct_all: pct(all),
      hpct_free: pct(g.free),
      hpct_carryover: pct(g.carryover),
      hpct_fresh: pct(g.fresh),
      hemnet_views_per_listing_day: all ? Math.round((10 * all.h) / all.days) / 10 : null,
      booli_views_per_listing_day: all ? Math.round((10 * all.b) / all.days) / 10 : null,
      homes_all: n('all'),
      homes_paid: n('paid'),
      homes_free: n('free'),
      homes_unknown_package: n('unknown'),
      homes_carryover: n('carryover'),
      homes_fresh: n('fresh'),
      readings: [...W.readingDates].sort().join(' '),
      intervals_kept: W.kept,
      republish_intervals_left_out: W.resets,
      outage_intervals_left_out: W.outageSkipped,
      flag: flags.join('; '),
      _paid: g.paid || null,
    };
  });
}

const CSV_COLUMNS = [
  'week_start', 'week_end', 'hpct_paid', 'hpct_all', 'hpct_free', 'hpct_carryover', 'hpct_fresh',
  'hemnet_views_per_listing_day', 'booli_views_per_listing_day',
  'homes_all', 'homes_paid', 'homes_free', 'homes_unknown_package', 'homes_carryover', 'homes_fresh',
  'readings', 'intervals_kept', 'republish_intervals_left_out', 'outage_intervals_left_out', 'flag',
];

function toCsv(weekly) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...weekly.map(r => CSV_COLUMNS.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

// Pooled paid H% over the 4 weeks before `week`, skipping weeks with frozen counters.
function priorAverage(weekly, week) {
  const prior = weekly.filter(r => r.week_start < week && !/frozen/.test(r.flag)).slice(-4);
  let h = 0, b = 0;
  for (const r of prior) if (r._paid) { h += r._paid.h; b += r._paid.b; }
  return h + b > 0 ? Math.round((1000 * h) / (h + b)) / 10 : null;
}

// The Slack block for the pack's week, in plain English (one figure per line).
function slackBlock(weekly, packDate, csvLink) {
  const week = reportWeek(packDate);
  const r = weekly.find(x => x.week_start === week);
  const title = `*Views, like-for-like* · week of ${dayMonth(week)} (${weekday(week)} ${dayMonth(week)} – ${weekday(weekEnd(week))} ${dayMonth(weekEnd(week))})`;
  if (!r || r.hpct_paid === null) return `${title}\nNo usable view readings for this week.`;
  const prev = weekly.filter(x => x.week_start < week).slice(-1)[0];
  const avg = priorAverage(weekly, week);
  const vs = [prev && prev.hpct_paid !== null ? `prior week ${prev.hpct_paid}%` : null, avg !== null ? `4-week average ${avg}%` : null].filter(Boolean).join(', ');
  const split = (label, v, homes) => (v === null ? null : homes < SMALL_SAMPLE ? `${label} ${v}% (${homes} homes, too few to read)` : `${label} ${v}%`);
  const lines = [
    title,
    `Hemnet share of views, paid listings: *${r.hpct_paid}%*${vs ? ` (${vs})` : ''}`,
    `Views per listing per day: Hemnet ${Math.round(r.hemnet_views_per_listing_day)}, Booli ${Math.round(r.booli_views_per_listing_day)}`,
    [split('Pre-market carryover', r.hpct_carryover, r.homes_carryover), split('fresh', r.hpct_fresh, r.homes_fresh), split('free listings', r.hpct_free, r.homes_free)].filter(Boolean).join(' · '),
  ];
  for (const f of r.flag ? r.flag.split('; ') : []) lines.push(`⚠ ${f.charAt(0).toUpperCase()}${f.slice(1)}`);
  lines.push(`_Same homes on both sites, days ${AGE_MIN}–${AGE_MAX} of listing, Hemnet re-publishes left out. Weekly history: ${csvLink || 'views-like-for-like.csv'}_`);
  return lines.join('\n');
}

// DB loader: every live pair with readings since `from`, and its latest known package.
async function loadInputs(client, { from = HISTORY_FROM } = {}) {
  const pairs = (await client.query(`
    SELECT p.id, p.booli_listed::text AS booli_listed, p.hemnet_listed::text AS hemnet_listed,
           p.booli_views_day0, f.active_package
      FROM cohort_pairs p
      LEFT JOIN (SELECT DISTINCT ON (hemnet_id) hemnet_id, active_package
                   FROM hemnet_listingv2
                  ORDER BY hemnet_id, (active_package IS NULL), format_seen_at DESC NULLS LAST, crawled DESC) f
             ON f.hemnet_id = p.hemnet_id
     WHERE p.removed_at IS NULL
       AND EXISTS (SELECT 1 FROM cohort_daily_views v WHERE v.pair_id = p.id AND v.date >= $1::date)`, [from])).rows;
  const readings = (await client.query(`
    SELECT v.pair_id, v.date::text AS date, v.hemnet_views, v.booli_views
      FROM cohort_daily_views v
      JOIN cohort_pairs p ON p.id = v.pair_id AND p.removed_at IS NULL
     WHERE v.date >= $1::date`, [from])).rows;
  return { pairs, readings };
}

module.exports = {
  computeWeekly, toCsv, slackBlock, loadInputs, reportWeek, weekStart, priorAverage,
  CSV_COLUMNS, AGE_MIN, AGE_MAX, MAX_GAP_DAYS, HISTORY_FROM,
};

// ---------------------------------------------------------------
//   node lib/views-like-for-like.js --smoke        (offline)
//   node lib/views-like-for-like.js --live [date]  (read-only: prints the block + CSV head)
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--live')) {
  require('dotenv').config({ quiet: true });
  const { createClient } = require('../db');
  const packDate = process.argv[process.argv.indexOf('--live') + 1] || iso(Date.now());
  (async () => {
    const c = createClient();
    await c.connect();
    try {
      const { pairs, readings } = await loadInputs(c);
      const weekly = computeWeekly(pairs, readings, { before: packDate });
      console.log(slackBlock(weekly, packDate));
      console.log('\n' + toCsv(weekly.slice(-8)));
    } finally { await c.end(); }
  })().catch((e) => { console.error(e); process.exit(1); });
}

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  // Two homes listed on Booli 15 Oct (paid, fresh) and one free carryover home, read
  // every other day; the 31 Oct / 1 Nov Hemnet readings are blank (outage).
  const pairs = [
    { id: 1, booli_listed: '2026-10-15', hemnet_listed: '2026-10-15', booli_views_day0: 10, active_package: 'PREMIUM' },
    { id: 2, booli_listed: '2026-10-15', hemnet_listed: '2026-10-01', booli_views_day0: 0, active_package: null },
    { id: 3, booli_listed: '2026-10-15', hemnet_listed: '2026-10-21', booli_views_day0: 300, active_package: 'MINIMAL' },
  ];
  const series = (id, dates, h, b) => dates.map((d, i) => ({ pair_id: id, date: d, hemnet_views: h[i], booli_views: b[i] }));
  const D = ['2026-10-21', '2026-10-23', '2026-10-25', '2026-10-27', '2026-10-29', '2026-10-31', '2026-11-01', '2026-11-03', '2026-11-05'];
  const readings = [
    ...series(1, D, [100, 300, 500, 700, 900, null, null, 1900, 2100], [50, 150, 250, 350, 450, 550, 600, 800, 900]),
    ...series(2, D, [100, 300, 500, 700, 900, null, null, 1900, 2100], [50, 150, 250, 350, 450, 550, 600, 800, 900]),
    ...series(3, D, [10, 20, 30, 40, 50, null, null, 100, 110], [100, 200, 300, 400, 500, 600, 650, 800, 900]),
  ];
  const weekly = computeWeekly(pairs, readings);
  const w = (s) => weekly.find(r => r.week_start === s);

  check('weeks are Mon–Sun and the pack reports the week before its date', () => {
    assert.strictEqual(weekStart('2026-11-01'), '2026-10-26', 'Sunday belongs to the week starting Monday 26 Oct');
    assert.strictEqual(weekStart('2026-11-02'), '2026-11-02');
    assert.strictEqual(reportWeek('2026-11-09'), '2026-11-02', 'Monday 9 Nov pack = Mon 2 – Sun 8 Nov');
    assert.strictEqual(reportWeek('2026-11-11'), '2026-11-02', 'a mid-week re-run still reports the last complete week');
  });

  check('age window: 21 and 23 Oct readings are days 6–8, so only intervals with midpoint >= day 8 count', () => {
    // 21->23 Oct midpoint = day 7 (excluded); 23->25 midpoint day 9 (included) — both in week 19 Oct.
    assert.strictEqual(w('2026-10-19').intervals_kept, 3, 'one interval (23->25) per home');
  });

  check('paid H% pools increments: 200 Hemnet vs 100 Booli per interval = 66.7%', () => {
    assert.strictEqual(w('2026-10-26').hpct_paid, 66.7);
    assert.strictEqual(w('2026-10-26').homes_paid, 2, 'a null package listed before the free tier is paid');
  });

  check('free and carryover are split out, and the free home is not in the paid headline', () => {
    assert.strictEqual(w('2026-10-26').hpct_free, 9.1, '10 vs 100');
    assert.strictEqual(w('2026-10-26').homes_carryover, 1);
    assert.strictEqual(w('2026-10-26').hpct_fresh, 66.7);
  });

  check('the interval across the outage (29 Oct -> 3 Nov) is left out, not smeared into 2 Nov week', () => {
    const r = w('2026-11-02');
    assert.strictEqual(r.outage_intervals_left_out, 3);
    assert.strictEqual(r.intervals_kept, 3, 'only 3 -> 5 Nov counts');
    assert.match(r.flag, /partial week: Hemnet data outage/);
    assert.match(w('2026-10-26').flag, /partial week/, 'the outage week itself is flagged');
  });

  check('a Hemnet re-publish (counter falls) is left out and counted', () => {
    const rs = [...series(9, ['2026-10-25', '2026-10-27', '2026-10-29'], [500, 20, 60], [100, 120, 140])];
    const out = computeWeekly([{ id: 9, booli_listed: '2026-10-15', hemnet_listed: '2026-10-15', booli_views_day0: 0, active_package: 'BASIC' }], rs);
    const r = out.find(x => x.week_start === '2026-10-26');
    assert.strictEqual(r.republish_intervals_left_out, 1);
    assert.strictEqual(r.hpct_paid, 66.7, 'only 27 -> 29 Oct: 40 vs 20');
  });

  check('frozen Booli counters are flagged', () => {
    const rs = series(8, ['2026-10-25', '2026-10-27', '2026-10-29'], [100, 200, 300], [50, 50, 50]);
    const out = computeWeekly([{ id: 8, booli_listed: '2026-10-15', hemnet_listed: '2026-10-15', booli_views_day0: 0, active_package: 'BASIC' }], rs);
    assert.match(out.find(x => x.week_start === '2026-10-26').flag, /Booli view counts look frozen/);
  });

  check('CSV has the documented header and one row per week', () => {
    const csv = toCsv(weekly).trim().split('\n');
    assert.strictEqual(csv[0], CSV_COLUMNS.join(','));
    assert.strictEqual(csv.length, weekly.length + 1);
    assert.ok(!csv[0].split(',').includes('_paid'), 'internal accumulators stay out of the file');
  });

  check('Slack block: headline, comparison, splits, flags and the CSV pointer', () => {
    const s = slackBlock(weekly, '2026-11-02', 'LINK');
    assert.match(s, /week of 26 Oct \(Mon 26 Oct – Sun 1 Nov\)/);
    assert.match(s, /paid listings: \*66\.7%\* \(prior week 66\.7%/);
    assert.match(s, /free listings 9\.1% \(1 homes, too few to read\)/);
    assert.match(s, /⚠ Partial week: Hemnet data outage/);
    assert.match(s, /Weekly history: LINK/);
  });

  check('the unfinished week is left out of the pack, and blanked readings are not listed', () => {
    const cut = computeWeekly(pairs, readings, { before: '2026-11-02' });
    assert.strictEqual(cut[cut.length - 1].week_start, '2026-10-26', 'a 2 Nov pack ends with the week of 26 Oct');
    assert.strictEqual(w('2026-10-26').readings, '2026-10-27 2026-10-29', '31 Oct and 1 Nov had no Hemnet reading');
  });

  check('Slack block says so plainly when the week has no usable readings', () => {
    assert.match(slackBlock(weekly, '2026-12-07'), /No usable view readings for this week/);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
