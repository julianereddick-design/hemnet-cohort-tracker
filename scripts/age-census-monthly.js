'use strict';
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/age-census-monthly.js — monthly age-penetration census across all four pools.
//
// Runs cheapest-first (Booli PM ~60 calls → Booli FS ~84 → Hemnet PM ~656 → Hemnet FS
// ~1,208) and PERSISTS EACH POOL THE MOMENT IT COMPLETES. That ordering plus per-pool
// persistence is deliberate: on 2026-07-20 a transient Oxylabs 613 on one platform cost the
// entire weekly flow datapoint. A Hemnet failure must never cost the banked Booli rows.
//
// Cron: 02:00 UTC on the 1st of each month. Runtime ~2.5-3h, so it lands ~05:00, well before
// the report job at 07:00 and clear of the Monday 08:50/09:00/10:30 jobs.
// Cost: ~2,000 Oxylabs calls ≈ $5/month.
//
// Self-test: node scripts/age-census-monthly.js --smoke   (offline, no DB, no network)
const { runJob } = require('../cron-wrapper');
const { createClient } = require('../db');
const { persistPool, getPriorTotal } = require('../age-census-store');

const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`);

// Cheapest-first. Each entry lazily requires its script so --smoke never loads a scraper.
const POOLS = [
  { platform: 'booli', pool: 'premarket', run: (o) => require('./booli-age-census').run(o) },
  { platform: 'booli', pool: 'forsale', run: (o) => require('./forsale-age-penetration').run(o) },
  { platform: 'hemnet', pool: 'premarket', run: (o) => require('./hemnet-age-census').run(o) },
  { platform: 'hemnet', pool: 'forsale', run: (o) => require('./hemnet-forsale-age-census').run(o) },
];

// Pure-ish orchestration: every side effect is injected so --smoke drives it offline.
async function orchestrate({ pools, runDate, persist, priorTotal, logger = log }) {
  const summary = { runDate, pools: [], persisted: 0, failed: [], gateFailed: [] };
  for (const p of pools) {
    const key = `${p.platform}:${p.pool}`;
    try {
      logger('INFO', `=== ${key} — starting ===`);
      const prior = await priorTotal(p);
      const result = await p.run({ priorTotal: prior, logger });
      await persist(result);
      summary.persisted++;
      summary.pools.push({ platform: p.platform, pool: p.pool, status: result.status, nTotal: result.nTotal });
      if (result.status !== 'ok') {
        summary.gateFailed.push(key);
        logger('WARN', `${key} persisted with status=${result.status}: ${result.notes || ''}`);
      } else {
        logger('INFO', `${key} ok — n=${result.nTotal}, ${result.oxCalls} calls, ${result.runtimeS}s`);
      }
    } catch (e) {
      summary.failed.push(key);
      summary.pools.push({ platform: p.platform, pool: p.pool, status: 'failed', error: e.message });
      logger('ERROR', `${key} FAILED: ${e.message} — continuing with the remaining pools`);
    }
  }
  return summary;
}

async function main() {
  const runDate = process.env.RUN_DATE || new Date().toISOString().slice(0, 10);
  const summary = await orchestrate({
    pools: POOLS,
    runDate,
    persist: (result) => persistPool(result, { runDate }),
    // Deliberate: one short-lived connection per pool (not one shared client for all four),
    // so an earlier pool's already-banked row can never be rolled back or blocked by a
    // later pool's connection trouble — same isolation rationale as persistPool() below.
    priorTotal: async (p) => {
      const client = createClient();
      await client.connect();
      try { return await getPriorTotal(client, { platform: p.platform, pool: p.pool, runDate }); }
      finally { await client.end(); }
    },
    logger: log,
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

// Entry gate: --smoke runs the offline self-test; otherwise the census runs for real —
// ~3h, ~2,000 paid Oxylabs fetches, ~$5. RUN_DATE is read from the environment, not argv,
// so --smoke is the only accepted flag; anything else — `--smoketest`, `--smoke=true`, a
// stray typo — must never fall through to the live paid run. Mirrors the same defect fixed
// on the sibling report job (premarket-flow-weekly-report.js, FIX6/ab1cc04).
const ACCEPTED_ARGV = new Set(['--smoke']);
const USAGE = 'Usage: node scripts/age-census-monthly.js [--smoke]';
function validateArgv(argv) {
  return argv.every(a => ACCEPTED_ARGV.has(a));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!validateArgv(argv)) {
    console.error(`Unrecognised argument(s): ${argv.filter(a => !ACCEPTED_ARGV.has(a)).join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  } else if (argv.includes('--smoke')) {
    smoke();
  } else {
    runJob({
      scriptName: 'age-census-monthly',
      main,
      validate: (summary) => {
        if (!summary) return 'no summary returned';
        if (summary.failed.length) return `pools failed: ${summary.failed.join(', ')}`;
        if (summary.gateFailed.length) return `pools failed validation gates: ${summary.gateFailed.join(', ')}`;
        if (summary.persisted !== 4) return `expected 4 pools persisted, got ${summary.persisted}`;
        return null;
      },
    });
  }
}

module.exports = { orchestrate, POOLS };

// --smoke self-test — fully offline (no DB, no network, no scraper module loaded).
async function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  const mkResult = (platform, pool) => ({
    platform, pool, method: 'binary-search', nTotal: 100, nUndated: 0, nNewbuild: 1,
    newbuildSampled: true, newbuildSampleN: 50,
    buckets: { le1m: 100, m1_3: 0, m3_6: 0, m6_12: 0, m12_18: 0, m18_24: 0, gt24: 0, undated: 0 },
    bucketsSecondhand: null, muni: [], oxCalls: 60, errorPages: 0, runtimeS: 10,
    gates: [], status: 'ok', notes: null,
  });

  await check('runs pools cheapest-first, sequentially — never overlapping', async () => {
    const order = [], persisted = [];
    // inFlight tracks concurrent runs, not completion order. A regression to
    // Promise.all(pools.map(...)) would invoke every run() before any of them resolves
    // (each callback runs synchronously up to its own first await, then yields), so
    // maxInFlight would climb to 4. The current sequential for-of loop keeps it at 1
    // because each pool's run() (and persist()) fully resolves before the next starts —
    // the scrapers share module-level mutable state, so overlap would corrupt them.
    let inFlight = 0, maxInFlight = 0;
    const mk = (platform, pool) => ({
      platform, pool,
      run: async () => {
        order.push(`${platform}:${pool}`);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));   // a real suspension point
        inFlight--;
        return mkResult(platform, pool);
      },
    });
    const pools = [
      mk('booli', 'premarket'),
      mk('booli', 'forsale'),
      mk('hemnet', 'premarket'),
      mk('hemnet', 'forsale'),
    ];
    const summary = await orchestrate({
      pools, runDate: '2026-09-01',
      persist: async (r) => { persisted.push(`${r.platform}:${r.pool}`); return { runId: 1, muniRows: 0 }; },
      priorTotal: async () => null,
      logger: () => {},
    });
    assert.deepStrictEqual(order, ['booli:premarket', 'booli:forsale', 'hemnet:premarket', 'hemnet:forsale'], 'must run cheapest-first, sequentially');
    assert.deepStrictEqual(persisted, ['booli:premarket', 'booli:forsale', 'hemnet:premarket', 'hemnet:forsale']);
    assert.strictEqual(summary.persisted, 4);
    assert.deepStrictEqual(summary.failed, []);
    assert.strictEqual(maxInFlight, 1, 'pools must never overlap — the scrapers share module-level state');
  });

  await check('validateArgv accepts --smoke and no args; rejects any typo or variant', async () => {
    assert.strictEqual(validateArgv(['--smoke']), true, '--smoke must be accepted');
    assert.strictEqual(validateArgv([]), true, 'no args must be accepted (routes to the live-run path, not rejected)');
    assert.strictEqual(validateArgv(['--smoketest']), false, '--smoketest must be rejected — it must not launch a live paid run');
    assert.strictEqual(validateArgv(['--smoke=true']), false, '--smoke=true must be rejected');
    assert.strictEqual(validateArgv(['--smok']), false, '--smok must be rejected');
    assert.strictEqual(validateArgv(['--smoke', '--foo']), false, 'an extra unrecognised flag must be rejected');
  });

  await check('one failing pool does not abort the others, and is named in the summary', async () => {
    const persisted = [];
    const pools = [
      { platform: 'booli', pool: 'premarket', run: async () => mkResult('booli', 'premarket') },
      { platform: 'hemnet', pool: 'forsale', run: async () => { throw new Error('Oxylabs 613'); } },
      { platform: 'hemnet', pool: 'premarket', run: async () => mkResult('hemnet', 'premarket') },
    ];
    const summary = await orchestrate({
      pools, runDate: '2026-09-01',
      persist: async (r) => { persisted.push(`${r.platform}:${r.pool}`); return { runId: 1, muniRows: 0 }; },
      priorTotal: async () => null,
      logger: () => {},
    });
    assert.strictEqual(summary.persisted, 2, 'the two healthy pools must still bank');
    assert.deepStrictEqual(summary.failed, ['hemnet:forsale']);
    assert.ok(persisted.includes('hemnet:premarket'), 'a later pool must still run after an earlier failure');
  });

  await check('a gate_failed pool is still persisted, with its status preserved', async () => {
    const rows = [];
    const pools = [{
      platform: 'booli', pool: 'premarket',
      run: async () => ({ ...mkResult('booli', 'premarket'), status: 'gate_failed', notes: 'gates failed: total_drift' }),
    }];
    const summary = await orchestrate({
      pools, runDate: '2026-09-01',
      persist: async (r) => { rows.push(r); return { runId: 1, muniRows: 0 }; },
      priorTotal: async () => null, logger: () => {},
    });
    assert.strictEqual(rows[0].status, 'gate_failed', 'a wrong number must land visibly, not be dropped');
    assert.strictEqual(summary.persisted, 1);
    assert.deepStrictEqual(summary.gateFailed, ['booli:premarket']);
  });

  await check('prior total is fetched per pool and passed into run()', async () => {
    let sawPrior = null;
    const pools = [{
      platform: 'booli', pool: 'premarket',
      run: async ({ priorTotal }) => { sawPrior = priorTotal; return mkResult('booli', 'premarket'); },
    }];
    await orchestrate({
      pools, runDate: '2026-09-01',
      persist: async () => ({ runId: 1, muniRows: 0 }),
      priorTotal: async () => 33742, logger: () => {},
    });
    assert.strictEqual(sawPrior, 33742);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
