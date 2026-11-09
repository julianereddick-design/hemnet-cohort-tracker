require('dotenv').config();

// weekly-new-listings.js — Mondays: the weekly NEW-listings figures for Glenn's MASTER workbook
// (DATA MASTER\WEEKLY PROPERTIES), replacing the GrokBot downloads. See lib/weekly-new-listings.js
// for the definitions.
//
//   1. Refetch Hemnet's public weekly nytillkomna (6 pages: Sweden / Stockholms län / Västra
//      Götalands län × total / for sale) into series hemnet_public, and Hemnet's monthly paid
//      figure (statistik/finansiell-rapportering) into hemnet_paid_monthly.
//   2. For every complete week after the last one in the master series, count new pre-owned
//      PAID ads from the ad registry (new, or switched to paid). That is the master series.
//      Weeks before COVERAGE_START are never computed here (estimates come from
//      scripts/seed-weekly-master.js); weeks before FULL_COVERAGE are flagged as estimates.
//      A week whose Monday daily walk did not run ok is held back until next Monday.
//   3. Monthly check: our paid count for each complete month vs Hemnet's own paid figure.
//   4. Write view-data/weekly-new-listings/master-series.csv (stable URL, read by the PC task
//      that updates the workbook: tools/update-master-workbook.ps1) + a dated copy, and post
//      the Dashboard's three Slack lines to the business channel.
//
//   node weekly-new-listings.js --smoke     # offline self-test
//   node weekly-new-listings.js --dry-run   # live reads + Hemnet fetch, writes nothing, posts nothing
//   node weekly-new-listings.js             # live

const fs = require('fs');
const path = require('path');
const W = require('./lib/weekly-new-listings');

const NOTE_PAID = 'paid ads (Decade ad registry)';
const NOTE_PARTIAL = 'paid ads (Decade ad registry); 2–3 Nov reconstructed, before our full sweep';

// Weeks to compute: after the last master week, up to the last complete week, from coverage start.
function weeksToCompute(lastMasterWeek, lastComplete) {
  const out = [];
  let w = lastMasterWeek ? W.addDays(lastMasterWeek, 7) : W.COVERAGE_START;
  for (; w <= lastComplete; w = W.addDays(w, 7)) if (w >= W.COVERAGE_START) out.push(w);
  return out;
}

// Complete months to check against Hemnet's paid figure: from the first counted month, ended
// before today (Swedish), with a Hemnet paid figure. PURE.
function monthsToCheck(financial, today) {
  return [...financial.keys()].filter(m => m >= W.COVERAGE_START.slice(0, 7) && financial.get(m).paid != null
    && W.addDays(`${m}-01`, W.daysInMonth(m)) <= today).sort();
}

const UPSERT = `
  INSERT INTO hemnet_weekly_new_listings (week_start, area, market, series, value, is_estimate, note, updated_at)
  SELECT x.week_start, x.area, x.market, x.series, x.value, COALESCE(x.is_estimate, false), x.note, NOW()
    FROM jsonb_to_recordset($1::jsonb) AS x(week_start DATE, area TEXT, market TEXT, series TEXT, value INTEGER, is_estimate BOOLEAN, note TEXT)
  ON CONFLICT (week_start, area, market, series) DO UPDATE
    SET value = EXCLUDED.value, is_estimate = EXCLUDED.is_estimate, note = EXCLUDED.note, updated_at = NOW()`;
async function upsert(client, rows) {
  for (let i = 0; i < rows.length; i += 2000) await client.query(UPSERT, [JSON.stringify(rows.slice(i, i + 2000))]);
}

const n = (x) => Number(x).toLocaleString('en-US');
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function renderMessage({ week, lines, numbers = [], latest, hemnetSweden, held, monthly, estimates, csvLink, computed }) {
  const out = [`:house: *Hemnet new listings — wk starting ${week}* (pre-owned, paid ads only)`];
  // Say which week is missing and why, never just leave it out.
  if (!computed.length) {
    out.push(held.length
      ? `_No new week added: wk ${held[0]} is held back (see below). The figures are for wk ${week}, the latest complete week in the series._`
      : `_No new week added: the series already runs to wk ${week}._`);
  }
  out.push(...lines.map(l => `• ${l}`));
  if (numbers.length) {
    out.push(`*Numbers*, wk starting ${week} vs the same week last year${estimates.includes(week) ? ' (this week is an estimate)' : ''}:`);
    out.push(...numbers.map(l => `• ${l}`));
  }
  if (latest) {
    const s = latest.reg, na = (k) => (s.newAds[k] ? s.newAds[k].sweden.tot : 0);
    out.push(`Counted by us: ${n(s.paid.sweden.tot)} new paid ads in Sweden (${n(s.switched.sweden.tot)} of them switched to paid from a free or copied ad).` +
      ` Also new this week: ${n(na('free'))} free ads and ${n(na('aggregated'))} copied from agency sites.` +
      (hemnetSweden != null ? ` Hemnet's own weekly figure, which counts all of these, is ${n(hemnetSweden)}.` : ''));
    if (latest.partial) out.push('_This week is partly reconstructed (our full count of Hemnet started on 3 Nov), so it is marked as an estimate._');
  }
  for (const w of held) out.push(`:warning: Wk ${w} is held back: the daily read of new Hemnet ads did not run on the Monday after it. It will be added next Monday.`);
  if (monthly) {
    const pctOff = `${Math.abs(monthly.diff * 100).toFixed(0)}%`;
    out.push(monthly.ok
      ? `Monthly check, ${monthName(monthly.month)}: Hemnet reports ${n(monthly.hemnetPaid)} paid ads; our count points to ${n(Math.round(monthly.expected))} (within ${pctOff}).`
      : `:warning: Monthly check, ${monthName(monthly.month)}: Hemnet reports ${n(monthly.hemnetPaid)} paid ads but our count points to ${n(Math.round(monthly.expected))} (${pctOff} apart). Treat that month's weeks with care.`);
  }
  if (estimates.length) out.push(`_Estimated weeks in the last year: ${estimates.join(', ')}._`);
  out.push(`_From wk ${W.SERIES_BREAK} Hemnet's public figure also counts free and copied ads; from then on these figures are paid ads only, counted by us._`);
  if (csvLink) out.push(csvLink);
  return out.join('\n');
}

async function main(client, logger = (l, m) => console.log(`  [${l}] ${m}`), { dryRun = false } = {}) {
  const { getWithRetry } = require('./lib/scrape-http');
  const fetchHtml = (url) => getWithRetry(url, { logger: () => {} });
  const publicRows = await W.fetchHemnetPublic(fetchHtml);
  const fin = await fetchHtml(W.FINANCIAL_URL);
  if (fin.status !== 200) throw new Error(`financial page: HTTP ${fin.status}`);
  const financial = W.parseFinancialPage(fin.html);
  logger('INFO', `Hemnet public: ${publicRows.length} weekly points; monthly paid figures to ${[...financial.keys()].filter(m => financial.get(m).paid != null).sort().pop()}`);

  const lm = await client.query(`SELECT to_char(max(week_start), 'YYYY-MM-DD') AS w FROM hemnet_weekly_new_listings WHERE series = 'master'`);
  const lastMaster = lm.rows[0].w;
  const weeks = weeksToCompute(lastMaster, W.lastCompleteWeek());
  logger('INFO', `master series ends ${lastMaster}; to compute: ${weeks.length ? weeks.join(', ') : 'nothing new'}`);

  const rows = publicRows.map(r => ({ ...r, series: 'hemnet_public', note: 'hemnet.se/statistik/nytillkomna, pre-owned' }));
  for (const [m, v] of financial) if (v.paid != null) {
    rows.push({ week_start: `${m}-01`, area: 'sweden', market: 'tot', series: 'hemnet_paid_monthly', value: v.paid, note: 'hemnet.se/statistik/finansiell-rapportering, paid' });
  }
  const computed = [], held = [];
  let latest = null;
  for (const week of weeks) {
    // Keep the series week after week: once a week is held, so are the ones after it.
    if (held.length || !(await W.dailyWalkCovered(client, week))) { held.push(week); continue; }
    const reg = await W.registryWeek(client, week);
    const partial = week < W.FULL_COVERAGE;
    for (const area of W.AREAS) for (const market of ['tot', 'fs']) {
      rows.push({ week_start: week, area, market, series: 'master', value: reg.paid[area][market], is_estimate: partial, note: partial ? NOTE_PARTIAL : NOTE_PAID });
      rows.push({ week_start: week, area, market, series: 'registry_switched', value: reg.switched[area][market] });
      for (const [kind, c] of Object.entries(reg.newAds)) rows.push({ week_start: week, area, market, series: `registry_new_${kind}`, value: c[area][market] });
    }
    computed.push(week);
    latest = { week, reg, partial };
    logger('INFO', `wk ${week}: Sweden ${reg.paid.sweden.tot} paid (${reg.switched.sweden.tot} switched); new ids ${Object.entries(reg.newAds).map(([k, c]) => `${k} ${c.sweden.tot}`).join(', ')}`);
  }
  if (held.length) logger('WARN', `held back (no ok daily walk on the Monday after): ${held.join(', ')}`);

  // The master series as it now stands (dry run: as it would stand).
  if (!dryRun) await upsert(client, rows);
  const ms = await client.query(
    `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, area, market, value, is_estimate, note
       FROM hemnet_weekly_new_listings WHERE series = 'master' ORDER BY week_start`);
  const master = [...ms.rows];
  if (dryRun) master.push(...rows.filter(r => r.series === 'master'));
  const series = W.toSeries(master);
  const last = master.map(r => r.week_start).sort().pop();
  const yearAgo = W.addDays(last, -364);
  const estimates = [...new Set(master.filter(r => r.is_estimate && r.week_start > yearAgo).map(r => r.week_start))].sort();

  // Monthly check against Hemnet's own paid figure.
  const checks = [];
  const months = monthsToCheck(financial, W.swedishToday());
  if (months.length) {
    const ratio = W.paidRatio(series, financial);
    for (const m of months) {
      const reg = await W.registryCounts(client, `${m}-01`, W.addDays(`${m}-01`, W.daysInMonth(m)));
      checks.push(W.monthlyCheck({ month: m, ours: reg.paid.sweden.tot, hemnetPaid: financial.get(m).paid, ratio }));
    }
  }
  const monthly = checks[checks.length - 1] || null;
  if (monthly) logger('INFO', `monthly check ${monthly.month}: Hemnet ${monthly.hemnetPaid} vs expected ${Math.round(monthly.expected)} (${(monthly.diff * 100).toFixed(1)}%)`);

  const today = new Date().toISOString().slice(0, 10);
  const csv = W.toCsv(master);
  const host = process.env.VIEW_SERVER_HOST, port = process.env.VIEW_SERVER_PORT || 3800;
  let csvLink = null;
  if (!dryRun) {
    for (const dir of [path.join(__dirname, 'view-data', 'weekly-new-listings'), path.join(__dirname, 'view-data', today)]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, dir.endsWith('weekly-new-listings') ? 'master-series.csv' : 'weekly-new-listings.csv'), csv, 'utf8');
    }
    if (host) csvLink = `<http://${host}:${port}/view-data/${today}/weekly-new-listings.csv|weekly-new-listings.csv> (full series; the MASTER workbook is updated from it)`;
  }
  const pub = latest && publicRows.find(r => r.week_start === latest.week && r.area === 'sweden' && r.market === 'tot');
  const message = renderMessage({
    week: last, lines: W.dashboardLines(series, last), numbers: W.numberLines(series, last), latest: latest && latest.week === last ? latest : null,
    hemnetSweden: pub ? pub.value : null, held, monthly, estimates, csvLink, computed,
  });
  console.log(message);
  let csvUploadError = null;
  if (!dryRun) {
    const { postMessage } = require('./lib/slack-post');
    const res = await postMessage('weekly-new-listings', message);
    if (!res.ok && !res.dryRun) throw new Error('Slack post failed on both the bot and the webhook fallback');
    // The CSV itself in the post's thread (GrokBot cannot open the :3800 link). The same file
    // goes into the evening views report's data pack (lib/weekly-pack.js). Never fails the run.
    const { uploadFiles } = require('./lib/slack-files');
    const up = await uploadFiles('weekly-new-listings', [{ path: path.join(__dirname, 'view-data', today, 'weekly-new-listings.csv'), title: 'weekly-new-listings.csv' }], {
      threadTs: res.ts,
      comment: 'Full weekly series: paid new listings of existing homes (no new-build), Sweden / Stockholm / Västra Götaland, total and for sale (pre-market = total − for sale).',
    });
    if (!up.ok && !up.dryRun) { csvUploadError = up.error; logger('WARN', `CSV upload failed: ${up.error}`); }
  }
  return { lastMaster, computed, held, latest: last, monthlyChecks: checks, monthlyFailed: checks.filter(c => !c.ok).length, csvUploadError, dryRun };
}

function validate(s) {
  if (!s) return 'no summary returned';
  if (s.held && s.held.length) return `week(s) ${s.held.join(', ')} held back: the daily new-ads walk did not run ok on the Monday after`;
  if (s.monthlyFailed) return `our monthly paid count is more than ${W.MONTHLY_TOLERANCE * 100}% off Hemnet's own for ${s.monthlyFailed} month(s)`;
  if (s.csvUploadError) return `posted, but the CSV could not be attached in Slack (${s.csvUploadError})`;
  return null;
}

module.exports = { weeksToCompute, monthsToCheck, renderMessage, validate, main };

const ACCEPTED_ARGV = new Set(['--smoke', '--dry-run']);
const USAGE = 'Usage: node weekly-new-listings.js [--smoke | --dry-run]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  } else if (argv.includes('--smoke')) {
    smoke();
  } else if (argv.includes('--dry-run')) {
    process.env.SCRAPE_FORCE_OXYLABS = '1';
    process.env.SLACK_DRY_RUN = '1';
    const { createClient } = require('./db');
    (async () => {
      const c = createClient(); await c.connect();
      try { console.log(JSON.stringify(await main(c, undefined, { dryRun: true }), null, 2)); } finally { await c.end(); }
    })().catch(e => { console.error(e); process.exit(1); });
  } else {
    process.env.SCRAPE_FORCE_OXYLABS = '1';
    const { runJob } = require('./cron-wrapper');
    runJob({ scriptName: 'weekly-new-listings', main: (client, log) => main(client, log), validate });
  }
}

function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  check('weeksToCompute: after the last master week, never before coverage, up to last complete', () => {
    assert.deepStrictEqual(weeksToCompute('2026-10-26', '2026-11-09'), ['2026-11-02', '2026-11-09']);
    assert.deepStrictEqual(weeksToCompute('2026-10-12', '2026-11-02'), ['2026-11-02'], 'gap weeks are estimates, not computed');
    assert.deepStrictEqual(weeksToCompute('2026-11-09', '2026-11-09'), []);
  });
  check('monthsToCheck: complete months from November with a paid figure', () => {
    const fin = new Map([['2026-10', { paid: 1 }], ['2026-11', { paid: 2 }], ['2026-12', { published: 3 }]]);
    assert.deepStrictEqual(monthsToCheck(fin, '2026-11-30'), []);
    assert.deepStrictEqual(monthsToCheck(fin, '2026-12-01'), ['2026-11']);
    assert.deepStrictEqual(monthsToCheck(fin, '2027-01-05'), ['2026-11'], 'December has no paid figure yet');
  });
  check('validate: held weeks and a failed monthly check make the run amber', () => {
    assert.match(validate({ held: ['2026-11-09'] }), /held back/);
    assert.match(validate({ held: [], monthlyFailed: 1 }), /monthly/);
    assert.strictEqual(validate({ held: [], monthlyFailed: 0 }), null);
  });
  const c3 = (s, a, b) => ({ sweden: { tot: s, fs: 0 }, stockholm: { tot: a, fs: 0 }, vg: { tot: b, fs: 0 } });
  const reg = { paid: c3(2345, 700, 300), switched: c3(310, 90, 40), newAds: { free: c3(1500, 0, 0), aggregated: c3(900, 0, 0) } };
  check('renderMessage: plain lines, our count, partial week, checks and the series-break note', () => {
    const msg = renderMessage({
      week: '2026-11-02', lines: ['Total, wk starting 2 Nov 2026: …'], latest: { week: '2026-11-02', reg, partial: true },
      hemnetSweden: 4100, held: [], monthly: { month: '2026-11', ok: true, diff: 0.04, hemnetPaid: 8000, expected: 7700 },
      estimates: ['2026-10-19', '2026-10-26', '2026-11-02'], csvLink: null, computed: ['2026-11-02'],
    });
    assert.match(msg, /paid ads only/);
    assert.match(msg, /Counted by us: 2,345 new paid ads in Sweden \(310 of them switched/);
    assert.match(msg, /1,500 free ads and 900 copied from agency sites\. Hemnet's own weekly figure, which counts all of these, is 4,100\./);
    assert.match(msg, /partly reconstructed/);
    assert.match(msg, /Monthly check, November 2026: Hemnet reports 8,000 paid ads; our count points to 7,700 \(within 4%\)/);
    assert.match(msg, /Estimated weeks in the last year: 2026-10-19, 2026-10-26, 2026-11-02/);
    assert.match(msg, /from wk 2026-10-19/i);
  });
  check('renderMessage: held week and a failed monthly check are flagged', () => {
    const msg = renderMessage({
      week: '2026-11-02', lines: [], latest: null, hemnetSweden: null, held: ['2026-11-09'],
      monthly: { month: '2026-11', ok: false, diff: -0.2, hemnetPaid: 6000, expected: 7500 }, estimates: [], csvLink: null, computed: [],
    });
    assert.match(msg, /No new week added: wk 2026-11-09 is held back \(see below\)\. The figures are for wk 2026-11-02/);
    assert.match(msg, /:warning: Wk 2026-11-09 is held back/);
    assert.match(msg, /:warning: Monthly check, November 2026: .* \(20% apart\)/);
  });
  check('renderMessage: numbers block, estimate marked; up-to-date series says so', () => {
    const msg = renderMessage({
      week: '2026-11-02', lines: [], numbers: ['For sale: Sweden 2,000 (last year 2,200, -9.1%)'], latest: null, hemnetSweden: null,
      held: [], monthly: null, estimates: ['2026-11-02'], csvLink: null, computed: [],
    });
    assert.match(msg, /\*Numbers\*, wk starting 2026-11-02 vs the same week last year \(this week is an estimate\):\n• For sale: Sweden 2,000/);
    assert.match(msg, /No new week added: the series already runs to wk 2026-11-02\./);
  });
  check('numberLines: this week, last year and change per area; pre-market = total − for sale', () => {
    const s = W.toSeries([
      ['2026-11-02', 'sweden', 'tot', 3000], ['2026-11-02', 'stockholm', 'tot', 800], ['2026-11-02', 'vg', 'tot', 500],
      ['2026-11-02', 'sweden', 'fs', 2000], ['2026-11-02', 'stockholm', 'fs', 600], ['2026-11-02', 'vg', 'fs', 300],
      ['2025-11-03', 'sweden', 'tot', 3300], ['2025-11-03', 'stockholm', 'tot', 900], ['2025-11-03', 'vg', 'tot', 500],
      ['2025-11-03', 'sweden', 'fs', 2200], ['2025-11-03', 'stockholm', 'fs', 700], ['2025-11-03', 'vg', 'fs', 300],
    ].map(([week_start, area, market, value]) => ({ week_start, area, market, value })));
    const [tot, fs, pm] = W.numberLines(s, '2026-11-02');
    assert.strictEqual(fs, 'For sale: Sweden 2,000 (last year 2,200, -9.1%) | Stockholm 600 (last year 700, -14.3%) | VG 300 (last year 300, +0.0%) | Rest of Sweden 1,100 (last year 1,200, -8.3%)');
    assert.match(tot, /^Total: Sweden 3,000 \(last year 3,300, -9\.1%\)/);
    assert.match(pm, /^Pre-market: Sweden 1,000 \(last year 1,100, -9\.1%\) \| Stockholm 200 \(last year 200, \+0\.0%\)/);
  });
  check('validate: a failed CSV upload is amber, not red', () => {
    assert.match(validate({ held: [], monthlyFailed: 0, csvUploadError: 'not_in_channel' }), /CSV could not be attached/);
  });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}
