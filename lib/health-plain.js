// lib/health-plain.js — the plain-English top of the daily health report (2026-10-27).
//
// The checks are unchanged (liveness, assertions, open conditions, tier-1 backstop,
// disk, view growth, newest-cohort canary — see cron-health-slack.js). This module
// only changes how their results READ: one line per problem, in words a non-engineer
// can act on, grouped as "needs attention" / "keep an eye on" / "all good". The
// existing technical sections still follow below a divider for whoever fixes things.
//
// Pure: no DB, no network, no Slack. Tested by `node lib/health-plain.js --smoke`.

'use strict';

// What each job is, in plain words, and what we lose if it doesn't work.
// A job missing from this list falls back to its script name.
const JOB_INFO = {
  'market-totals-daily':        { name: 'Daily listing totals', loss: 'A missed day can\'t be recovered later.' },
  'premarket-flow-measure':     { name: 'Weekly pre-market flow', loss: 'A missed week can\'t be recovered later.' },
  'premarket-quality-measure':  { name: 'Weekly pre-market quality', loss: 'A missed week can\'t be recovered later.' },
  'age-census-monthly':         { name: 'Monthly listing-age census', loss: 'This month\'s snapshot is incomplete until it is re-run.' },
  'cohort-create':              { name: 'New weekly views cohort', loss: 'No new listings join the views tracking this week.' },
  'cohort-track':               { name: 'Views tracking', loss: 'Gaps in the Hemnet vs Booli views data.' },
  'hemnet-targeted-refresh':    { name: 'Hemnet view counts', loss: 'Hemnet view counts go stale.' },
  'booli-targeted-refresh':     { name: 'Booli view counts', loss: 'Booli view counts go stale.' },
  'booli-targeted-discovery':   { name: 'Weekly scan for new Booli listings', loss: 'Next week\'s cohort will be short of listings.' },
  'hemnet-targeted-match':      { name: 'Weekly Hemnet–Booli matching', loss: 'Next week\'s cohort will be short of matched homes.' },
  'cohort-spotcheck-gate':      { name: 'Weekly match spot-check', loss: 'Match quality goes unchecked this week.' },
  'sold-match-batch':           { name: 'Sold-price matching', loss: 'The sold-match series misses a fortnight.' },
  'ad-cost-crawler':            { name: 'Monthly Hemnet price list (ad costs)', loss: 'This month\'s ad-cost figures are incomplete.' },
  'spotcheck-reaction-poller':  { name: 'Spot-check review sync', loss: 'Slack review votes aren\'t applied.' },
  'weekly-view-report':         { name: 'Weekly views pack', loss: 'The weekly views post is missing.' },
  'market-totals-weekly-report':{ name: 'Weekly supply post', loss: 'The weekly supply post is missing.' },
  'premarket-flow-weekly-report':{ name: 'Weekly pre-market post', loss: 'The weekly pre-market post is missing.' },
  'sold-match-report':          { name: 'Weekly sold-match post', loss: 'The weekly sold-match post is missing.' },
  'sold-match-trend-chart':     { name: 'Sold-match chart', loss: 'The chart isn\'t updated.' },
  'sold-match-xlsx':            { name: 'Sold-match spreadsheet', loss: 'The spreadsheet isn\'t updated.' },
  'age-census-report':          { name: 'Monthly age-census post', loss: 'The monthly post is missing.' },
  'adcost-report':              { name: 'Monthly ad-cost post', loss: 'The monthly post is missing.' },
  'cron-health-slack':          { name: 'This daily health check', loss: '' },
  'cron-health-sweep':          { name: 'Health sweep', loss: 'Problems are noticed later.' },
  'alerting-heartbeat':         { name: 'Weekly alert test', loss: 'We can\'t be sure alerts are getting through.' },
};
const jobName = (job) => (JOB_INFO[job] && JOB_INFO[job].name) || job;
const jobLoss = (job) => (JOB_INFO[job] && JOB_INFO[job].loss) || '';

// Raw error text -> a short plain reason. Unknown errors are shown trimmed and quoted.
const ERROR_RULES = [
  [/JSON path missing|ROOT_QUERY missing|apollo state missing|__APOLLO_STATE__ missing|__NEXT_DATA__/i, 'the website changed its page format, so the numbers couldn\'t be read'],
  [/HTTP 403|Cloudflare/i, 'the website blocked our requests'],
  [/Oxylabs failures/i, 'the scraping service (Oxylabs) returned errors'],
  [/time ?out|ETIMEDOUT/i, 'it timed out'],
  [/exited \d+|stderr tail|Traceback/i, 'the script crashed'],
  [/postcode-mismatch/i, null], // handled as its own sentence below
];
function plainReason(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const pm = text.match(/postcode-mismatch rate: (\d+)\/(\d+) \(([\d.]+)%\)/);
  if (pm) return `${pm[3]}% of attempted matches had different postcodes on the two sites (usually about 1%), so some pairs may be the wrong home`;
  for (const [re, plain] of ERROR_RULES) if (plain && re.test(text)) return plain;
  const clean = text.replace(/\/opt\/\S+/g, '').replace(/\s+—\s+/g, '. ');
  return `"${clean.length > 110 ? clean.slice(0, 107) + '…' : clean}"`;
}

// Assertion detail ("0/4 market_totals rows for that day") -> plain words.
const ASSERT_RULES = [
  [/^(\d+)\/(\d+) market_totals rows/, (m) => `${m[1]} of ${m[2]} counts were saved`],
  [/only (\d+)\/(\d+) platforms/, (m) => `only ${m[1]} of ${m[2]} sites were saved`],
  [/(\d+)\/(\d+) platform.pool/, (m) => `only ${m[1]} of ${m[2]} parts were completed`],
  [/INCOMPLETE.*?(\d+)\/(\d+) cells/, (m) => `the last run stopped early (${m[1]} of ${m[2]} price points)`],
  [/only (\d+)\/(\d+) active pairs tracked \((\d+)%\)/, (m) => `views were recorded for only ${m[1]} of ${m[2]} homes (${m[3]}%)`],
  [/(\d+) listings re-crawled/, (m) => `only ${m[1]} listings were refreshed`],
];
function plainAssertion(detail) {
  const d = String(detail || '');
  for (const [re, fn] of ASSERT_RULES) { const m = d.match(re); if (m) return fn(m); }
  return d;
}

const CONDITION_WORDS = {
  'null-views': 'some listings are missing view counts',
  'partial-upsert': 'not all rows were saved',
  'hemnet-new-listing-format': 'a new Hemnet listing format appeared',
  'hemnet-partition-mismatch': 'Hemnet\'s for-sale + pre-market don\'t add up to its total',
  'hemnet-listing-types-changed': 'Hemnet changed which kinds of listing its totals count',
};
function plainCondition(key) {
  if (!key) return 'a repeating warning';
  if (CONDITION_WORDS[key]) return CONDITION_WORDS[key];
  const site = key.match(/^site-failed:(.+)$/);
  if (site) return `${site[1].replace('+', ' and ')} failed`;
  return key.replace(/[-_:]/g, ' ');
}

const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// buildPlainSummary(input) -> string (Slack mrkdwn)
//
// input: {
//   now: Date,
//   liveness:   [{ job, state, detail, lastRow? }]           (lib/job-liveness results)
//   assertions: [{ job, ok, skipped, detail }]               (lib/job-assertions)
//   openConditions: [{ script_name, condition_key, first_seen_at, seen_count }]
//   tier1Bad:   [{ script_name, status, error_message }]      (last 24h)
//   crossCutting: [string]   problems that belong to no single job (disk, stale views, canary)
//   healthyCount: number     jobs that ran on schedule
//   keyFacts: [string]       short "all good" facts, already worded
// }
function buildPlainSummary(input) {
  const { now = new Date(), liveness = [], assertions = [], openConditions = [],
    tier1Bad = [], crossCutting = [], healthyCount = 0, keyFacts = [] } = input;

  // One entry per job, merging every section that complains about it.
  const problems = new Map();   // job -> { what: Set }
  const watch = new Map();
  const add = (map, job, what) => {
    if (!map.has(job)) map.set(job, new Set());
    if (what) map.get(job).add(what);
  };

  for (const r of liveness) {
    if (r.state === 'failed') add(problems, r.job, `last run failed: ${plainReason((r.lastRow && r.lastRow.error_message) || r.detail)}`);
    else if (r.state === 'missing') add(problems, r.job, 'didn\'t run when it should have');
    else if (r.state === 'orphan') add(problems, r.job, 'started but never finished');
    else if (r.state === 'pending') add(watch, r.job, `new, first run due ${String(r.detail).replace(/^deployed, first run due /, '')}`);
  }
  for (const a of assertions) {
    if (!a.skipped && !a.ok) add(problems, a.job, `data check failed: ${plainAssertion(a.detail)}`);
  }
  for (const r of tier1Bad) {
    if (r.status === 'warning') add(watch, r.script_name, plainReason(r.error_message));
    else if (!problems.has(r.script_name)) add(problems, r.script_name, `failed in the last 24h: ${plainReason(r.error_message)}`);
  }
  for (const c of openConditions) {
    if (problems.has(c.script_name)) continue;
    add(watch, c.script_name,
      `${plainCondition(c.condition_key)} (ongoing since ${fmtDate(c.first_seen_at)}, ${c.seen_count} run${c.seen_count === 1 ? '' : 's'})`);
  }
  for (const job of problems.keys()) watch.delete(job);

  const nProblems = problems.size + crossCutting.length;
  const head = nProblems === 0
    ? ':white_check_mark: *Everything is working*'
    : `:red_circle: *${nProblems} thing${nProblems === 1 ? ' needs' : 's need'} attention*`;
  const out = [`*Hemnet data — daily check, ${fmtDate(now)}*`,
    `${head}  ·  ${healthyCount} job${healthyCount === 1 ? '' : 's'} ran fine`];

  if (nProblems) {
    out.push('', '*Needs attention*');
    let i = 1;
    for (const [job, whats] of problems) {
      const loss = jobLoss(job);
      out.push(`${i++}. *${jobName(job)}*: ${[...whats].join('; ')}.${loss ? ` _${loss}_` : ''}`);
    }
    for (const c of crossCutting) out.push(`${i++}. ${c}`);
  }
  if (watch.size) {
    out.push('', '*Keep an eye on* (working, but worth knowing)');
    for (const [job, whats] of watch) out.push(`• *${jobName(job)}*: ${[...whats].filter(Boolean).join('; ')}.`);
  }
  if (keyFacts.length) {
    out.push('', '*All good*', keyFacts.map((f) => `• ${f}`).join('\n'));
  }
  return out.join('\n');
}

// The few numbers worth seeing on a good day, worded from the passing data checks.
const n = (x) => Number(x).toLocaleString('en-US');
const FACT_RULES = {
  'cohort-create': [/^(\S+) with (\d+) pairs/, (m) => `New cohort ${m[1]}: ${n(m[2])} matched homes`],
  'cohort-track': [/^(\d+)\/\d+ active pairs tracked/, (m) => `Views recorded for ${n(m[1])} homes`],
  'hemnet-targeted-refresh': [/^(\d+) listings re-crawled/, (m) => `Hemnet view counts refreshed for ${n(m[1])} listings`],
  'booli-targeted-refresh': [/^(\d+) listings re-crawled/, (m) => `Booli view counts refreshed for ${n(m[1])} listings`],
};
function keyFactsFrom(assertions = [], diskDetail = '') {
  const facts = [];
  for (const a of assertions) {
    const rule = a.ok && !a.skipped && FACT_RULES[a.job];
    const m = rule && String(a.detail).match(rule[0]);
    if (m) facts.push(rule[1](m));
  }
  const d = String(diskDetail).match(/\((\d+)%\)/);
  if (d) facts.push(`Server disk ${d[1]}% free`);
  return facts;
}

module.exports = { buildPlainSummary, keyFactsFrom, plainReason, plainAssertion, plainCondition, jobName, JOB_INFO };

// ---------------------------------------------------------------
// --smoke: renders the 27 Oct 2026 report's real inputs and checks the wording.
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`SMOKE FAIL [${name}]: ${e.message}`); } };

  const input = {
    now: new Date('2026-10-27T03:00:00Z'),
    liveness: [
      { job: 'ad-cost-crawler', state: 'failed', lastRow: { error_message: '/opt/hemnet-cohort-tracker/.venv-adcost/bin/python /opt/hemnet-cohort-tracker/scripts/adcost-crawl.py exited 1 — stderr tail: <module>\n sys.exit(main())' } },
      { job: 'market-totals-daily', state: 'failed', lastRow: { error_message: 'JSON path missing for hemnet.till_salu: expected positive number, got undefined' } },
      { job: 'cohort-track', state: 'ok' },
    ],
    assertions: [
      { job: 'cohort-create', ok: true, detail: '2026-W43 with 1030 pairs' },
      { job: 'market-totals-daily', ok: false, detail: '0/4 market_totals rows for that day' },
      { job: 'premarket-flow-measure', ok: false, detail: 'only 1/2 platforms (1 rows) since the last expected run' },
      { job: 'age-census-monthly', ok: false, detail: '3/4 platform×pool since the last expected run' },
      { job: 'ad-cost-crawler', ok: false, detail: 'newest run 2026-10-01 is INCOMPLETE — 10/10 municipalities, 392/420 cells. An older complete grid does not make this month good.' },
    ],
    openConditions: [{ script_name: 'cohort-track', condition_key: 'null-views', first_seen_at: '2026-10-23T22:00:00Z', seen_count: 2 }],
    tier1Bad: [
      { script_name: 'premarket-flow-measure', status: 'warning', error_message: 'hemnet failed — persisted partial (booli)' },
      { script_name: 'market-totals-daily', status: 'failure', error_message: 'JSON path missing for hemnet.till_salu' },
      { script_name: 'hemnet-targeted-match', status: 'warning', error_message: 'high postcode-mismatch rate: 247/2285 (10.8%) — likely indicates address normalization is matching wrong properties at the same street name' },
    ],
    crossCutting: [],
    healthyCount: 23,
    keyFacts: ['New cohort 2026-W43: 1,030 matched homes', 'Disk 88% free'],
  };
  const msg = buildPlainSummary(input);

  check('headline counts each broken job once', () => {
    assert.ok(msg.includes(':red_circle: *4 things need attention*  ·  23 jobs ran fine'), msg);
  });
  check('market totals: one item merging the failure and the data check, with plain reason', () => {
    const line = msg.split('\n').find((l) => l.includes('*Daily listing totals*'));
    assert.ok(line.includes('the website changed its page format'), line);
    assert.ok(line.includes('0 of 4 counts were saved'), line);
    assert.ok(line.includes('A missed day can\'t be recovered later.'), line);
    assert.strictEqual(msg.split('Daily listing totals').length, 2, 'listed once');
  });
  check('crash text and file paths are replaced by plain words', () => {
    assert.ok(!msg.includes('/opt/'), msg);
    assert.ok(!msg.includes('stderr'), msg);
    assert.ok(msg.includes('*Monthly Hemnet price list (ad costs)*: last run failed: the script crashed; data check failed: the last run stopped early (392 of 420 price points).'), msg);
  });
  check('a job that is broken is not repeated under "keep an eye on"', () => {
    const watchPart = msg.split('*Keep an eye on*')[1] || '';
    assert.ok(!watchPart.includes('pre-market flow'), watchPart);
  });
  check('postcode warning and the repeating views condition read plainly', () => {
    assert.ok(msg.includes('10.8% of attempted matches had different postcodes on the two sites (usually about 1%)'), msg);
    assert.ok(msg.includes('*Views tracking*: some listings are missing view counts (ongoing since Fri 23 Oct, 2 runs).'), msg);
  });
  check('no jargon in the summary', () => {
    for (const w of ['tier 1', 'tier-1', 'assertion', 'backstop', 'Liveness', 'orphan', 'JSON']) {
      assert.ok(!msg.includes(w), `contains "${w}"`);
    }
  });
  check('healthy day reads as one line plus facts', () => {
    const m = buildPlainSummary({ now: input.now, healthyCount: 25, keyFacts: ['Disk 88% free'] });
    assert.ok(m.includes(':white_check_mark: *Everything is working*  ·  25 jobs ran fine'), m);
    assert.ok(!m.includes('Needs attention'), m);
  });

  check('key facts are worded from passing checks and disk', () => {
    const f = keyFactsFrom([
      { job: 'cohort-create', ok: true, detail: '2026-W43 with 1030 pairs' },
      { job: 'cohort-track', ok: true, detail: '5992/4457 active pairs tracked (134%)' },
      { job: 'hemnet-targeted-refresh', ok: true, detail: '4346 listings re-crawled' },
      { job: 'market-totals-daily', ok: false, detail: '0/4 market_totals rows' },
    ], '41.8G free (88%), inodes 98% free — days to full: 826');
    assert.deepStrictEqual(f, ['New cohort 2026-W43: 1,030 matched homes', 'Views recorded for 5,992 homes',
      'Hemnet view counts refreshed for 4,346 listings', 'Server disk 88% free']);
  });

  if (process.argv.includes('--print')) console.log('\n' + msg + '\n');
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
