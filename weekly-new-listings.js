require('dotenv').config();

// weekly-new-listings.js — Mondays: the weekly NEW-listings figures for Glenn's MASTER workbook
// (DATA MASTER\WEEKLY PROPERTIES), replacing the GrokBot downloads. See lib/weekly-new-listings.js
// for the definitions.
//
//   1. Refetch Hemnet's public weekly nytillkomna (6 pages: Sweden / Stockholms län / Västra
//      Götalands län × total / for sale) into series hemnet_public.
//   2. For every complete week after the last one in the master series, count new pre-owned
//      ads from the ad registry: all, paid, and upgrades to paid. The master series gets
//      paid + upgrades. Weeks before COVERAGE_START are never computed here (estimates come
//      from scripts/seed-weekly-master.js).
//   3. Check our count of ALL new ads against Hemnet's own for the same week.
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

const NOTE_PAID = 'paid-only (Decade ad registry)';

// Weeks to compute: after the last master week, up to the last complete week, from coverage start.
function weeksToCompute(lastMasterWeek, lastComplete) {
  const out = [];
  let w = lastMasterWeek ? W.addDays(lastMasterWeek, 7) : W.COVERAGE_START;
  for (; w <= lastComplete; w = W.addDays(w, 7)) if (w >= W.COVERAGE_START) out.push(w);
  return out;
}

// Our all-ads count vs Hemnet's, per area/market. PURE.
function checkWeek(all, publicRows, week) {
  const out = [];
  for (const area of W.AREAS) for (const market of ['tot', 'fs']) {
    const pub = publicRows.find(r => r.week_start === week && r.area === area && r.market === market);
    const ours = all[area][market];
    const diff = pub && pub.value ? ours / pub.value - 1 : null;
    out.push({ week, area, market, ours, hemnet: pub ? pub.value : null, diff, ok: diff != null && Math.abs(diff) <= W.CHECK_TOLERANCE });
  }
  return out;
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

function renderMessage({ week, lines, checks, estimates, csvLink, computed }) {
  const out = [`:house: *Hemnet new listings — wk starting ${week}* (pre-owned, paid only)`];
  if (!computed.length) out.push('_No new week added: the last complete week is already in the series._');
  out.push(...lines.map(l => `• ${l}`));
  const bad = checks.filter(c => !c.ok);
  const sw = checks.find(c => c.area === 'sweden' && c.market === 'tot');
  if (sw) {
    out.push(bad.length
      ? `:warning: Check against Hemnet's own figures is off this week: ${bad.map(c => `${W.AREA_LABEL[c.area]} ${c.market === 'fs' ? 'for sale' : 'total'} ours ${c.ours} vs Hemnet ${c.hemnet == null ? 'n/a' : c.hemnet}`).join('; ')}. Treat the week as provisional.`
      : `Check: our count of all new ads matches Hemnet's own (Sweden ${sw.ours} vs ${sw.hemnet}, all within ${W.CHECK_TOLERANCE * 100}%).`);
  }
  if (estimates.length) out.push(`_Estimated weeks in the last year of the series (no paid-only count exists): ${estimates.join(', ')}._`);
  out.push(`_Hemnet's public figures count free and copied (aggregated) ads from wk ${W.SERIES_BREAK}; from then on these figures are paid ads only, counted by us._`);
  if (csvLink) out.push(csvLink);
  return out.join('\n');
}

async function main(client, logger = (l, m) => console.log(`  [${l}] ${m}`), { dryRun = false } = {}) {
  const { getWithRetry } = require('./lib/scrape-http');
  const publicRows = await W.fetchHemnetPublic((url) => getWithRetry(url, { logger: () => {} }));
  logger('INFO', `Hemnet public: ${publicRows.length} weekly points`);

  const lm = await client.query(`SELECT to_char(max(week_start), 'YYYY-MM-DD') AS w FROM hemnet_weekly_new_listings WHERE series = 'master'`);
  const lastMaster = lm.rows[0].w;
  const lastComplete = W.lastCompleteWeek();
  const weeks = weeksToCompute(lastMaster, lastComplete);
  logger('INFO', `master series ends ${lastMaster}; computing ${weeks.length ? weeks.join(', ') : 'nothing new'}`);

  const rows = publicRows.map(r => ({ ...r, series: 'hemnet_public', note: 'hemnet.se/statistik/nytillkomna, pre-owned' }));
  const checks = [];
  for (const week of weeks) {
    const reg = await W.registryWeek(client, week);
    if (reg.lo == null || reg.hi == null) throw new Error(`no ad-id boundary for wk ${week} — ad registry empty?`);
    for (const area of W.AREAS) for (const market of ['tot', 'fs']) {
      rows.push({ week_start: week, area, market, series: 'registry_all', value: reg.all[area][market] });
      rows.push({ week_start: week, area, market, series: 'registry_paid', value: reg.paid[area][market] });
      rows.push({ week_start: week, area, market, series: 'registry_upgrades', value: reg.upgrades[area][market] });
      rows.push({ week_start: week, area, market, series: 'master', value: reg.paid[area][market] + reg.upgrades[area][market], note: NOTE_PAID });
    }
    checks.push(...checkWeek(reg.all, publicRows, week));
    logger('INFO', `wk ${week}: Sweden all ${reg.all.sweden.tot}, paid ${reg.paid.sweden.tot} + ${reg.upgrades.sweden.tot} upgrades (ids ${reg.lo}..${reg.hi})`);
  }
  if (!dryRun) await upsert(client, rows);

  // The master series as it now stands (dry run: as it would stand).
  const ms = await client.query(
    `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, area, market, value, is_estimate, note
       FROM hemnet_weekly_new_listings WHERE series = 'master' ORDER BY week_start`);
  const master = [...ms.rows];
  if (dryRun) master.push(...rows.filter(r => r.series === 'master'));
  const series = W.toSeries(master);
  const latest = master.map(r => r.week_start).sort().pop();
  const yearAgo = W.addDays(latest, -364);
  const estimates = [...new Set(master.filter(r => r.is_estimate && r.week_start > yearAgo).map(r => r.week_start))].sort();

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
  const message = renderMessage({ week: latest, lines: W.dashboardLines(series, latest), checks, estimates, csvLink, computed: weeks });
  console.log(message);
  if (!dryRun) {
    const { postMessage } = require('./lib/slack-post');
    const res = await postMessage('weekly-new-listings', message);
    if (!res.ok && !res.dryRun) throw new Error('Slack post failed on both the bot and the webhook fallback');
  }
  return { lastMaster, computed: weeks, latest, checks, checksFailed: checks.filter(c => !c.ok).length, dryRun };
}

function validate(s) {
  if (!s) return 'no summary returned';
  if (s.checksFailed) return `our new-ads count is more than ${W.CHECK_TOLERANCE * 100}% off Hemnet's own for ${s.checksFailed} area/market(s) — week provisional`;
  return null;
}

module.exports = { weeksToCompute, checkWeek, renderMessage, validate, main };

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
  check('checkWeek: within tolerance is ok, a big gap or a missing Hemnet figure is not', () => {
    const all = { sweden: { tot: 3000, fs: 2000 }, stockholm: { tot: 1000, fs: 700 }, vg: { tot: 400, fs: 300 } };
    const pub = [
      { week_start: 'w', area: 'sweden', market: 'tot', value: 3050 }, { week_start: 'w', area: 'sweden', market: 'fs', value: 2500 },
      { week_start: 'w', area: 'stockholm', market: 'tot', value: 1000 }, { week_start: 'w', area: 'stockholm', market: 'fs', value: 700 },
      { week_start: 'w', area: 'vg', market: 'tot', value: 400 },
    ];
    const c = checkWeek(all, pub, 'w');
    assert.strictEqual(c.find(x => x.area === 'sweden' && x.market === 'tot').ok, true);
    assert.strictEqual(c.find(x => x.area === 'sweden' && x.market === 'fs').ok, false);
    assert.strictEqual(c.find(x => x.area === 'vg' && x.market === 'fs').ok, false, 'no Hemnet figure');
    assert.match(validate({ checksFailed: 2 }), /provisional/);
    assert.strictEqual(validate({ checksFailed: 0 }), null);
  });
  check('renderMessage: plain lines, check result, estimates and the series-break note', () => {
    const msg = renderMessage({
      week: '2026-11-02', lines: ['Total, wk starting 2 Nov 2026: …'],
      checks: [{ area: 'sweden', market: 'tot', ours: 3010, hemnet: 3000, ok: true }],
      estimates: ['2026-10-19', '2026-10-26'], csvLink: null, computed: ['2026-11-02'],
    });
    assert.match(msg, /paid only/);
    assert.match(msg, /matches Hemnet's own \(Sweden 3010 vs 3000/);
    assert.match(msg, /Estimated weeks .*2026-10-19, 2026-10-26/);
    assert.match(msg, /from wk 2026-10-19/);
  });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}
